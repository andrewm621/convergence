import type { WorkItemState } from "contracts";
import { ArrowRight, Check, CircleHelp, Copy, FileDiff, Swords, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FileChange } from "@/client/types";
import { CommitSha, isNotInGit } from "@/components/commit-sha";
import { EpistemicChip } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatFacet, plural, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { analysisOf, currentRecord, semanticDiff, type ClaimVerdict } from "@/state/derive";
import { ReceiptFacetList } from "./receipt-facets";
import { SCENARIO_META } from "./scenario-meta";

// ---------- Receipt ----------

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={label}
			onClick={() => {
				void navigator.clipboard?.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1400);
				});
			}}
		>
			{copied ? <Check className="text-success" /> : <Copy />}
		</Button>
	);
}

/** What this work item was handed: records, versions, named facets. It proves delivery, not understanding. */
export function ReceiptTab({ wi }: { wi: WorkItemState }) {
	const { view } = useConsole();
	const { receipt } = wi;
	const analysis = useMemo(() => analysisOf(view, wi.item.id), [view, wi.item.id]);
	const staleIds = new Set(analysis?.stale.map((f) => f.recordId));
	const noteSha = receipt.noteRef?.split(":")[1];
	const noteCommand = noteSha ? `git notes --ref=delta show ${noteSha}` : null;

	return (
		<div className="space-y-4 p-4" data-testid="receipt-tab">
			<div className="flex items-center gap-2">
				<h3 className="text-base font-semibold">Context receipt</h3>
				<EpistemicChip kind="recorded" className="ml-auto text-sm" />
			</div>
			<p className="text-sm text-muted-foreground">What {wi.item.actor.displayName} was handed before it started. It proves what was delivered, not that it was understood.</p>

			<ul className="space-y-3" aria-label="Records delivered">
				{receipt.accepted.map((entry) => {
					const current = currentRecord(view, entry.recordId);
					const newer = current && current.version > entry.version;
					const behind = newer && staleIds.has(entry.recordId);
					return (
						<li key={entry.recordId} className="rounded-lg border bg-card p-3.5" data-receipt-record={entry.recordId}>
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-mono text-base font-semibold" data-testid={`receipt-ref-${entry.recordId}`}>
									{entry.recordId}@{entry.version}
								</span>
								{behind && (
									<Badge tone="danger" className="text-sm">
										<TriangleAlert aria-hidden /> behind: accepted is v{current.version}
									</Badge>
								)}
								{newer && !behind && (
									<Badge tone="outline" className="text-sm">
										v{current.version} exists, facets it relies on unchanged
									</Badge>
								)}
								{!newer && (
									<Badge tone="success" className="text-sm">
										current
									</Badge>
								)}
							</div>
							<p className="mt-2.5 mb-1.5 text-sm font-medium">Facets it was handed</p>
							<ReceiptFacetList wi={wi} entry={entry} />
							<dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-sm text-muted-foreground">
								<dt>all facets</dt>
								<dd className="truncate" title={entry.facetHash}>
									#{shortHash(entry.facetHash, 12)}
								</dd>
								<dt>record file</dt>
								<dd className="truncate" title={entry.blobHash}>
									#{shortHash(entry.blobHash, 12)}
								</dd>
							</dl>
						</li>
					);
				})}
				{receipt.accepted.length === 0 && <li className="text-sm text-muted-foreground">No accepted records were delivered.</li>}
			</ul>

			<dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 rounded-lg bg-muted/60 p-3 text-sm">
				<dt className="text-muted-foreground">Baseline commit</dt>
				<dd className="font-mono">
					<CommitSha sha={receipt.baselineCommit} length={12} />
				</dd>
				<dt className="text-muted-foreground">Packet hash</dt>
				<dd className="truncate font-mono" title={receipt.contextPacketHash}>
					{shortHash(receipt.contextPacketHash, 16)}
				</dd>
				<dt className="text-muted-foreground">Revalidations</dt>
				<dd>{wi.revalidations}</dd>
				<dt className="text-muted-foreground">Fork head</dt>
				<dd className="font-mono">
					<CommitSha sha={wi.headSha} length={12} />
				</dd>
			</dl>

			{noteCommand && (
				<div className="space-y-1.5">
					<p className="text-sm font-medium">Also a git note on the fork</p>
					<div className="flex items-center gap-1 rounded-md border bg-card pl-2.5">
						<code className="min-w-0 flex-1 truncate font-mono text-sm">{noteCommand}</code>
						<CopyButton text={noteCommand} label="Copy git notes command" />
					</div>
				</div>
			)}
		</div>
	);
}

// ---------- Semantic diff ----------

const VERDICT_META: Record<ClaimVerdict, { label: string; tone: "success" | "danger" | "warning" | "neutral"; icon: typeof Check }> = {
	match: { label: "match", tone: "success", icon: Check },
	conflict: { label: "conflict", tone: "danger", icon: Swords },
	undeclared: { label: "undeclared", tone: "warning", icon: CircleHelp },
	ungoverned: { label: "not governed", tone: "neutral", icon: CircleHelp },
};

const VERDICT_BORDER: Record<ClaimVerdict, string> = {
	match: "border-success/30",
	conflict: "border-danger/40",
	undeclared: "border-warning/40 border-dashed",
	ungoverned: "border-border",
};

/** The agent's claims beside the accepted facets, coloured (and labelled) match, conflict or undeclared. */
export function SemanticTab({ wi }: { wi: WorkItemState }) {
	const { view } = useConsole();
	const analysis = useMemo(() => analysisOf(view, wi.item.id), [view, wi.item.id]);
	const diff = useMemo(() => (analysis ? semanticDiff(view, wi, analysis) : null), [view, wi, analysis]);
	if (!diff) return null;

	return (
		<div className="space-y-4 p-4" data-testid="semantic-tab">
			<div className="flex items-center gap-2">
				<h3 className="text-sm font-semibold">Claims vs accepted facets</h3>
				<EpistemicChip kind="asserted" className="ml-auto" />
			</div>

			{diff.claimsStatus === "none" && <p className="text-[13px] text-muted-foreground">No claims have been pushed at the current head yet, so there is nothing to compare.</p>}
			{diff.claimsStatus === "missing" && (
				<p className="rounded-md border border-dashed p-3 text-[13px]">
					<Badge tone="warning" className="mr-2 font-mono">
						NO_CLAIMS
					</Badge>
					The agent pushed no claims. Delta Convergence fails closed: it cannot tell what was built.
				</p>
			)}
			{diff.claimsStatus === "malformed" && (
				<p className="rounded-md border border-dashed p-3 text-[13px]">
					<Badge tone="warning" className="mr-2 font-mono">
						MALFORMED_CLAIMS
					</Badge>
					{diff.error ?? "The claims could not be read."}
				</p>
			)}

			<ul className="space-y-2.5" aria-label="Claims">
				{diff.rows.map((row) => {
					const meta = VERDICT_META[row.verdict];
					const Icon = meta.icon;
					return (
						<li key={`${row.claim.subject}:${row.claim.basedOn}`} data-claim={row.claim.subject} data-verdict={row.verdict} className={cn("rounded-lg border bg-card p-3", VERDICT_BORDER[row.verdict])}>
							<div className="flex items-center gap-2">
								<span className="min-w-0 truncate font-mono text-xs font-semibold">{row.claim.subject}</span>
								<Badge tone={meta.tone} className="ml-auto font-semibold" dashed={row.verdict === "undeclared"}>
									<Icon aria-hidden /> {meta.label}
								</Badge>
							</div>
							<div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 text-[13px]">
								<div className="rounded-md bg-muted/60 p-2">
									<p className="text-[11px] text-muted-foreground">Agent claims</p>
									<p className="font-medium break-words">{formatFacet(row.claim.value)}</p>
									<p className="mt-0.5 font-mono text-[11px] text-muted-foreground">based on {row.claim.basedOn}</p>
								</div>
								<ArrowRight className="self-center text-muted-foreground" aria-hidden />
								<div className={cn("rounded-md p-2", row.verdict === "conflict" ? "bg-danger-soft" : row.verdict === "match" ? "bg-success-soft" : "bg-muted/60")}>
									<p className="text-[11px] text-muted-foreground">Accepted</p>
									<p className="font-medium break-words">{row.accepted === null ? "(no accepted facet)" : formatFacet(row.accepted)}</p>
									{row.acceptedRef && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.acceptedRef}</p>}
								</div>
							</div>
							{row.note && <p className="mt-2 text-xs text-muted-foreground">{row.note}</p>}
						</li>
					);
				})}
			</ul>

			{diff.unclaimed.length > 0 && (
				<div className="space-y-1.5">
					<h4 className="text-xs font-semibold">Relied on, but not claimed</h4>
					<ul className="space-y-1">
						{diff.unclaimed.map((u) => (
							<li key={`${u.recordId}:${u.facetKey}`} className="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-xs">
								<span className="font-mono">{u.facetKey}</span>
								<span className="ml-auto text-muted-foreground">accepted: {formatFacet(u.accepted)}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

// ---------- Changes ----------

export function ChangesTab({ wi }: { wi: WorkItemState }) {
	const { client } = useConsole();
	const [files, setFiles] = useState<FileChange[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<string | null>(null);
	const key = `${wi.item.id}:${wi.headSha}:${wi.revalidations}`;

	const available = client.capabilities.changes;
	useEffect(() => {
		if (!available) return;
		let cancelled = false;
		setFiles(null);
		setError(null);
		client.api
			.changes(wi.item.id)
			.then((result) => {
				if (cancelled) return;
				setFiles(result);
				setOpen(result[0]?.path ?? null);
			})
			.catch(() => !cancelled && setError("The changes could not be read."));
		return () => {
			cancelled = true;
		};
		// `key` captures the item, its head and its revalidation count.
	}, [client, key, wi.item.id, available]);

	// A replay of recorded history has no file contents to diff; what it has is the commit the work lives in.
	if (SCENARIO_META[client.scenario].realHistory) {
		return (
			<div className="space-y-2 p-4 text-[13px]" data-testid="changes-recorded">
				<p className="text-muted-foreground">File diffs are not rebuilt for this replay. The work is in this commit:</p>
				<p className="font-mono text-sm">
					<CommitSha sha={wi.headSha} length={12} />
				</p>
				{isNotInGit(wi.headSha) && <p className="text-muted-foreground">It lives outside git, so there is nothing to open.</p>}
			</div>
		);
	}
	if (!available) {
		return (
			<p className="p-4 text-[13px] text-muted-foreground" data-testid="changes-unavailable">
				File diffs are not served by the live Worker yet, so this tab has nothing to show. The claims, receipt and gate for this work item are on the other tabs.
			</p>
		);
	}
	if (error) return <p className="p-4 text-sm text-danger">{error}</p>;
	if (!files) return <p className="p-4 text-sm text-muted-foreground">Reading the fork.</p>;
	if (files.length === 0) {
		return (
			<p className="p-4 text-[13px] text-muted-foreground" data-testid="changes-empty">
				{wi.item.source === "seeded" ? "This is a synthetic work item: it has no fork contents." : wi.headSha === null ? "Nothing has been pushed yet." : "No file changes against the baseline."}
			</p>
		);
	}
	const totals = files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });

	return (
		<div className="space-y-3 p-4" data-testid="changes-tab">
			<p className="flex items-center gap-2 text-[13px] text-muted-foreground">
				<FileDiff className="size-4" aria-hidden />
				{plural(files.length, "file")} changed against the baseline
				<span className="ml-auto font-mono text-xs">
					<span className="text-success">+{totals.add}</span> <span className="text-danger">-{totals.del}</span>
				</span>
			</p>
			<ul className="space-y-2">
				{files.map((file) => (
					<li key={file.path} className="overflow-hidden rounded-lg border bg-card">
						<button
							type="button"
							className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
							aria-expanded={open === file.path}
							onClick={() => setOpen(open === file.path ? null : file.path)}
						>
							<Badge tone={file.status === "added" ? "success" : file.status === "deleted" ? "danger" : "neutral"}>{file.status}</Badge>
							<span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
							<span className="font-mono text-[11px]">
								<span className="text-success">+{file.additions}</span> <span className="text-danger">-{file.deletions}</span>
							</span>
						</button>
						{open === file.path && <Patch text={file.patch} />}
					</li>
				))}
			</ul>
		</div>
	);
}

function Patch({ text }: { text: string }) {
	return (
		<pre className="overflow-x-auto border-t bg-muted/40 py-1.5 font-mono text-[11.5px] leading-5">
			{text.split("\n").map((line, index) => (
				<div
					key={`${index}:${line}`}
					className={cn("px-3 whitespace-pre", line.startsWith("+") && "bg-success-soft text-success", line.startsWith("-") && "bg-danger-soft text-danger", line.startsWith("@@") && "text-muted-foreground")}
				>
					{line || " "}
				</div>
			))}
		</pre>
	);
}
