import type { Condition, ConditionType, WorkItemState } from "contracts";
import { diffFacets } from "delta-core";
import { ArrowRight, BookMarked, Check, ChevronDown, ChevronRight, CircleAlert, FlaskConical, GitCommitHorizontal, Hourglass, Receipt, ShieldAlert, Sparkles, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { EpistemicChip, ReasonChip, useDegraded } from "@/components/status";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatFacet, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { actorLabel, analysisOf, currentRecord, leftAlone, reliedFacets, semanticDiff } from "@/state/derive";
import { useGate } from "@/state/use-gate";
import { ReceiptFacetList } from "./receipt-facets";

const CONDITION_TONE: Record<ConditionType, "danger" | "warning" | "success" | "primary" | "merged"> = {
	Fresh: "success",
	Stale: "danger",
	Uncertain: "warning",
	ClaimConflict: "danger",
	TestFailed: "danger",
	TestsPassed: "success",
	Blocked: "danger",
	Ready: "primary",
	Promoted: "merged",
};

/**
 * "Why is this blocked?": decision vN, then the receipt (what this agent was given), then the
 * claim, the test, and the condition. Each link says how far to trust it: `recorded`,
 * `agent-asserted, unverified`, `test-verified`. Anything nobody has decided reads
 * "Awaiting human" and never wears a success badge.
 */
export function WhyTab({ wi }: { wi: WorkItemState }) {
	const { view, setTab } = useConsole();
	const { gate } = useGate(wi.item.id);
	const analysis = useMemo(() => analysisOf(view, wi.item.id), [view, wi.item.id]);
	const diff = useMemo(() => (analysis ? semanticDiff(view, wi, analysis) : null), [view, wi, analysis]);
	if (!analysis) return null;

	const promoted = wi.item.status === "promoted";
	const blocked = !promoted && (gate ? !gate.pass : analysis.stale.length > 0 || analysis.conflicts.length > 0 || analysis.failedChecks.length > 0);
	const mergeEntry = promoted ? [...view.ledger].reverse().find((e) => e.payload.event.type === "PromotionMerged" && e.payload.event.workItemId === wi.item.id) : undefined;

	// The decisions that matter here: the ones this item is stale against, else everything it relies on.
	const relevantIds = [...new Set([...analysis.stale.map((f) => f.recordId), ...analysis.conflicts.map((f) => f.recordId)])];
	const decisionIds = relevantIds.length > 0 ? relevantIds : [...new Set(view.dependencies.filter((d) => d.workItemId === wi.item.id && d.status === "accepted").map((d) => d.recordId))];

	const rerunning = wi.revalidating;
	const staleIds = new Set(analysis.stale.map((f) => f.recordId));
	const problem = analysis.stale.length > 0 || analysis.conflicts.length > 0 || analysis.failedChecks.length > 0 || analysis.uncertain.length > 0;
	const alone = leftAlone(view, wi.item.id);
	const summary = promoted
		? "It cleared the gate at the current heads and was merged into the baseline."
		: rerunning
			? `Revalidating: ${wi.item.actor.displayName} is re-running on the current decisions (${wi.receipt.accepted.map((e) => `${e.recordId}@${e.version}`).join(", ")}). Promote stays closed until its next push.`
			: blocked
			? [
					...analysis.stale.map((f) => `Built on ${f.recordId}@${f.fromVersion}, but ${f.recordId} is now v${f.toVersion}${f.facetKeys.length ? ` (${f.facetKeys.join(", ")} changed)` : ""}.`),
					...analysis.conflicts.slice(0, 2).map((c) => c.message),
					...(analysis.failedChecks.length ? [`Delta Convergence's own check failed: ${analysis.failedChecks.join(", ")}.`] : []),
				]
					.slice(0, 4)
					.join(" ") || (gate?.blockers.join(" ") ?? "The gate is closed.")
			: "Nothing stands in the way. It still needs a human to promote it.";

	return (
		<div className="space-y-4 p-4" data-testid="why-tab">
			<div className={cn("rounded-xl border p-3.5", blocked && problem ? "border-danger/35 bg-danger-soft" : blocked ? "border-warning/35 bg-warning-soft" : promoted ? "border-merged/30 bg-merged-soft" : "bg-card")}>
				<h3 className="flex items-center gap-2 text-sm font-semibold">
					{blocked ? <ShieldAlert className={cn("size-4", problem ? "text-danger" : "text-warning")} aria-hidden /> : <Sparkles className="size-4 text-muted-foreground" aria-hidden />}
					{blocked ? "Why is this blocked?" : promoted ? "Why is this promoted?" : "Why is this not blocked?"}
				</h3>
				<p className="mt-1.5 text-[13px] leading-relaxed">{summary}</p>
				{blocked && gate && gate.reasonCodes.length > 0 && (
					<ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Reason codes">
						{gate.reasonCodes.map((code) => (
							<li key={code}>
								<ReasonChip code={code} className="bg-card" />
							</li>
						))}
					</ul>
				)}
			</div>

			{alone && !analysis.stale.length && (
				<div className="rounded-xl border border-dashed bg-card p-3.5" data-testid="left-alone">
					<p className="flex items-center gap-2 text-[13px] font-semibold">
						<Sparkles className="size-4 text-muted-foreground" aria-hidden />
						Left alone{alone.recordRef ? ` by ${alone.recordRef}` : ""}
					</p>
					<p className="mt-1 text-xs text-muted-foreground">{alone.message}</p>
					<ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Reason codes for leaving it alone">
						{alone.reasonCodes.map((code) => (
							<li key={code}>
								<ReasonChip code={code} />
							</li>
						))}
					</ul>
				</div>
			)}

			<ol className="space-y-0" aria-label="Why chain">
				<ChainLink icon={BookMarked} step="1" title="Decision" chip={<EpistemicChip kind="recorded" />} tone="neutral">
					{decisionIds.length === 0 && <p className="text-[13px] text-muted-foreground">This work does not rely on any accepted decision.</p>}
					{decisionIds.map((recordId) => {
						const head = currentRecord(view, recordId);
						if (!head) return null;
						const held = wi.receipt.accepted.find((e) => e.recordId === recordId);
						const before = held ? view.records[recordId]?.versions[String(held.version)] ?? null : null;
						const relied = reliedFacets(view, wi.item.id, recordId);
						const allChanges = before && before.version !== head.version ? diffFacets(before, head) : [];
						// Only the facets this work relies on matter; a change to another facet of the same record does not.
						const changes = relied && relied.length > 0 ? allChanges.filter((c) => relied.includes(c.key)) : allChanges;
						const unaffected = before !== null && before.version !== head.version && changes.length === 0;
						return (
							<div key={recordId} className="space-y-1.5" data-decision={recordId}>
								<p className="text-[13px]">
									<span className="font-semibold">
										{recordId} v{head.version}
									</span>{" "}
									<span className="text-muted-foreground">
										accepted by {actorLabel(view, head.acceptedBy)}
										{head.acceptedAt ? ` · ${formatDateTime(head.acceptedAt)}` : ""}
									</span>
								</p>
								{unaffected && (
									<p className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
										Moved from v{before?.version} to v{head.version}, but none of the facets this work relies on ({(relied ?? []).join(", ") || "any"}) changed.
									</p>
								)}
								{changes.map((change) => (
									<p key={change.key} className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs">
										<span className="font-mono text-muted-foreground">{change.key}</span>
										<span className="text-muted-foreground line-through">{formatFacet(change.from)}</span>
										<ArrowRight className="size-3 text-muted-foreground" aria-hidden />
										<span className="font-semibold">{formatFacet(change.to)}</span>
									</p>
								))}
							</div>
						);
					})}
				</ChainLink>

				<ChainLink icon={Receipt} step="2" title="Receipt" subtitle="what this agent was given" chip={<EpistemicChip kind="recorded" />} tone={analysis.stale.length > 0 ? "danger" : "neutral"}>
					<ReceiptChips wi={wi} staleIds={staleIds} />
					{analysis.stale.length > 0 && (
						<p className="mt-1.5 text-sm text-danger">
							Behind on {plural(analysis.stale.length, "record")}: the facets it relies on have changed since this receipt.
						</p>
					)}
				</ChainLink>

				<ChainLink
					icon={GitCommitHorizontal}
					step="3"
					title="Claim"
					subtitle="what the agent says it built"
					chip={diff && diff.rows.length > 0 ? <EpistemicChip kind="asserted" /> : undefined}
					tone={analysis.conflicts.length > 0 ? "danger" : "neutral"}
				>
					{!diff || diff.claimsStatus === "none" ? (
						<p className="text-[13px] text-muted-foreground">No claims at the current head yet.</p>
					) : diff.claimsStatus !== "ok" ? (
						<p className="text-[13px]">
							<ReasonChip code={diff.claimsStatus === "missing" ? "NO_CLAIMS" : "MALFORMED_CLAIMS"} /> Delta Convergence fails closed on claims it cannot read.
						</p>
					) : (
						<ul className="space-y-1" aria-label="Claims">
							{diff.rows.map((row) => (
								<li key={`${row.claim.subject}:${row.claim.basedOn}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
									{row.verdict === "match" ? <Check className="size-3.5 text-success" aria-hidden /> : <X className="size-3.5 text-danger" aria-hidden />}
									<span className="font-mono text-xs">{row.claim.subject}</span>
									<span>=</span>
									<span className="font-semibold">{formatFacet(row.claim.value)}</span>
									<span className="font-mono text-[11px] text-muted-foreground">({row.claim.basedOn})</span>
									{row.verdict !== "match" && <Badge tone={row.verdict === "conflict" ? "danger" : "warning"}>{row.verdict === "ungoverned" ? "not governed" : row.verdict}</Badge>}
								</li>
							))}
						</ul>
					)}
				</ChainLink>

				<ChainLink
					icon={FlaskConical}
					step="4"
					title="Test"
					subtitle="a check Delta Convergence ran itself"
					chip={analysis.headEvidence.length > 0 ? <EpistemicChip kind="verified" /> : undefined}
					tone={analysis.failedChecks.length > 0 ? "danger" : "neutral"}
				>
					{analysis.headEvidence.length === 0 ? (
						<p className="text-[13px] text-muted-foreground">{wi.headSha ? "No check has run at the current head." : "Nothing pushed yet, so nothing to check."}</p>
					) : (
						<ul className="space-y-1.5" aria-label="Checks">
							{analysis.headEvidence.map((e) => (
								<li key={e.check} className="text-[13px]" data-check={e.check}>
									<div className="flex items-center gap-2">
										<Badge tone={e.pass ? "success" : "danger"}>
											{e.pass ? <Check aria-hidden /> : <X aria-hidden />}
											{e.pass ? "passed" : "failed"}
										</Badge>
										<span className="font-mono text-xs">{e.check.split("/").pop()}</span>
									</div>
									<p className="mt-0.5 pl-0.5 text-xs text-muted-foreground">{e.output}</p>
								</li>
							))}
						</ul>
					)}
				</ChainLink>

				<ChainLink
					icon={Hourglass}
					step="5"
					title="Condition"
					subtitle="where it stands"
					chip={promoted ? <EpistemicChip kind="recorded" /> : <EpistemicChip kind="awaiting" />}
					tone={blocked ? "danger" : "neutral"}
					last
				>
					<ConditionList conditions={wi.conditions} />
					{promoted ? (
						<p className="mt-2 text-[13px]" data-testid="decided">
							Promoted into the baseline{mergeEntry ? ` at ${formatDateTime(mergeEntry.ts)}` : ""}. This is on the ledger.
						</p>
					) : (
						<div className="mt-2.5 rounded-lg border border-dashed p-2.5" data-testid="awaiting-human">
							<p className="flex items-center gap-2 text-[13px] font-semibold">
								<Hourglass className="size-3.5" aria-hidden />
								Awaiting human
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								{problem ? "Nobody has decided what to do about this. Revalidate it, accept a scoped exception, or reject it." : blocked ? "Nothing is wrong with it so far, but it is not ready: it still needs to push its work." : "Nothing is wrong, but nothing is merged until a person promotes it."}
							</p>
							<Button variant="outline" size="xs" className="mt-2" onClick={() => setTab("actions")}>
								<CircleAlert aria-hidden /> Open actions
							</Button>
						</div>
					)}
				</ChainLink>
			</ol>
		</div>
	);
}

/** The records in the receipt as chips. Each opens to the named facets that were handed over, marked against the current version. */
function ReceiptChips({ wi, staleIds }: { wi: WorkItemState; staleIds: ReadonlySet<string> }) {
	const { view } = useConsole();
	const [openId, setOpenId] = useState<string | null>(null);
	const open = wi.receipt.accepted.find((entry) => entry.recordId === openId);
	return (
		<>
			<ul className="flex flex-wrap gap-2" aria-label="Records in the receipt">
				{wi.receipt.accepted.map((entry) => {
					const head = currentRecord(view, entry.recordId);
					const newer = head && head.version > entry.version;
					const behind = newer && staleIds.has(entry.recordId);
					const expanded = openId === entry.recordId;
					const Chevron = expanded ? ChevronDown : ChevronRight;
					return (
						<li key={entry.recordId}>
							<button
								type="button"
								aria-expanded={expanded}
								aria-controls={`receipt-facets-${entry.recordId}`}
								data-receipt-chip={entry.recordId}
								title="Show the facets this work item was handed"
								onClick={() => setOpenId(expanded ? null : entry.recordId)}
								className={cn(badgeVariants({ tone: behind ? "danger" : "outline" }), "cursor-pointer gap-1.5 px-2.5 py-1 font-mono text-sm outline-none hover:brightness-95 focus-visible:ring-[3px] focus-visible:ring-ring/50")}
							>
								<Chevron aria-hidden />
								{entry.recordId}@{entry.version}
								{behind ? ` (now v${head.version})` : newer ? ` (v${head.version} exists, unaffected)` : ""}
							</button>
						</li>
					);
				})}
			</ul>
			{open && (
				<div id={`receipt-facets-${open.recordId}`} className="mt-2">
					<p className="mb-1.5 text-sm font-medium">
						Facets handed over with {open.recordId}@{open.version}
					</p>
					<ReceiptFacetList wi={wi} entry={open} />
				</div>
			)}
		</>
	);
}

function ConditionList({ conditions }: { conditions: Condition[] }) {
	const degraded = useDegraded();
	if (conditions.length === 0) return <p className="text-[13px] text-muted-foreground">No conditions evaluated yet.</p>;
	return (
		<ul className="space-y-1.5" aria-label="Conditions">
			{conditions.map((c) => (
				<li key={c.type} data-condition={c.type} className="text-[13px]">
					<div className="flex flex-wrap items-center gap-1.5">
						{degraded && c.type === "Fresh" ? (
							<Badge tone="warning" dashed className="font-semibold" title="The poller is degraded, so freshness cannot be confirmed.">
								Freshness unconfirmed
							</Badge>
						) : (
							<Badge tone={CONDITION_TONE[c.type]} className="font-semibold">
								{c.type}
							</Badge>
						)}
						{c.reasonCodes.map((code) => (
							<ReasonChip key={code} code={code} />
						))}
					</div>
					{c.message && <p className="mt-0.5 text-xs text-muted-foreground">{c.message}</p>}
				</li>
			))}
		</ul>
	);
}

function ChainLink({
	icon: Icon,
	step,
	title,
	subtitle,
	chip,
	tone,
	last = false,
	children,
}: {
	icon: typeof BookMarked;
	step: string;
	title: string;
	subtitle?: string;
	chip?: ReactNode;
	tone: "neutral" | "danger";
	last?: boolean;
	children: ReactNode;
}) {
	return (
		<li className="relative flex gap-3 pb-4 last:pb-0" data-chain-step={step}>
			{!last && <span className="absolute top-8 bottom-0 left-[15px] w-px bg-border" aria-hidden />}
			<span
				className={cn("relative grid size-8 shrink-0 place-items-center rounded-full border bg-card", tone === "danger" ? "border-danger/50 text-danger" : "text-muted-foreground")}
				aria-hidden
			>
				<Icon className="size-4" />
			</span>
			<div className="min-w-0 flex-1 pt-0.5">
				<div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
					<h4 className="text-[13px] font-semibold">{title}</h4>
					{subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
					{chip && <span className="ml-auto">{chip}</span>}
				</div>
				{children}
			</div>
		</li>
	);
}
