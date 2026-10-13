import type { ReactNode } from "react";
import type { FacetValue, RecordHistory, RecordSnapshot } from "contracts";
import { diffFacets } from "delta-core";
import { ArrowRight, BookMarked, Check, ChevronRight, FilePenLine, FilePlus2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { newIdempotencyKey } from "@/client/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatDateTime, formatFacet, parseFacetInput, plural, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { UnavailableHint } from "@/components/unavailable-hint";
import { useConsole } from "@/state/console-context";
import { SCENARIO_META } from "./scenario-meta";
import { actorLabel, proseEdits, recordIds } from "@/state/derive";

export function ContextTimeline() {
	const { view, editorRequest, requestEditor } = useConsole();
	const ids = recordIds(view);
	const [editing, setEditing] = useState<string | null>(null);

	// A beat (or a deep link) can open the editor with a draft already filled in.
	useEffect(() => {
		if (editorRequest) setEditing(editorRequest.recordId);
	}, [editorRequest]);

	return (
		<section aria-label="Context timeline" className="flex min-h-0 flex-1 flex-col">
			<PaneHeader title="Context" subtitle="Decisions" meta={view.baselineCommit ? `baseline ${shortHash(view.baselineCommit)}` : undefined} />
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
				{!view.ready ? (
					<p className="px-1 text-sm text-muted-foreground">Connecting to the workspace.</p>
				) : ids.length === 0 ? (
					<EmptyContext />
				) : (
					ids.map((id) => {
						const history = view.records[id];
						if (!history) return null;
						return (
							<RecordCard
								key={id}
								recordId={id}
								history={history}
								editing={editing === id}
								onEdit={() => setEditing(id)}
								onClose={() => {
									setEditing(null);
									requestEditor(null);
								}}
							/>
						);
					})
				)}
			</div>
		</section>
	);
}

export function PaneHeader({ title, subtitle, meta, children }: { title: string; subtitle?: string; meta?: string; children?: ReactNode }) {
	return (
		<div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
			<h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
			{subtitle && <span className="truncate text-xs text-muted-foreground">{subtitle}</span>}
			{meta && <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{meta}</span>}
			{children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
		</div>
	);
}

export function EmptyContext() {
	const { client, view, notify } = useConsole();
	const [busy, setBusy] = useState(false);
	return (
		<div data-testid="empty-state" className="rounded-xl border border-dashed bg-card/60 p-5 text-center">
			<div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-accent text-accent-foreground">
				<BookMarked className="size-5" aria-hidden />
			</div>
			<p className="text-sm font-semibold">No accepted context yet. Declare the first decision.</p>
			<p className="mt-1.5 text-xs text-muted-foreground">
				Work is only ever judged against accepted decisions. Seed the {SCENARIO_META[client.scenario].label} scenario to start from its first ones.
			</p>
			<UnavailableHint available={client.capabilities.seed} reason="Seeding is not available against the live Worker yet. Create it with POST /api/scenarios/:s/init and /work-items, then reload.">
				<Button
					className="mt-4"
					size="sm"
					disabled={busy || !view.ready || !client.capabilities.seed}
					onClick={async () => {
						setBusy(true);
						const result = await client.api.seedScenario(newIdempotencyKey());
						setBusy(false);
						notify(result.ok ? "success" : "danger", result.ok ? (result.message ?? "Seeded.") : result.message);
					}}
				>
					<FilePlus2 aria-hidden /> Seed the scenario
				</Button>
			</UnavailableHint>
		</div>
	);
}

type VersionRow = { snapshot: RecordSnapshot; changes: ReturnType<typeof diffFacets>; current: boolean };

function versionRows(history: RecordHistory): VersionRow[] {
	const versions = Object.values(history.versions).sort((a, b) => a.version - b.version);
	return versions
		.map((snapshot, index) => ({ snapshot, changes: index === 0 ? [] : diffFacets(versions[index - 1] ?? null, snapshot), current: snapshot.version === history.current }))
		.reverse();
}

function RecordCard({ recordId, history, editing, onEdit, onClose }: { recordId: string; history: RecordHistory; editing: boolean; onEdit(): void; onClose(): void }) {
	const { view, editorRequest } = useConsole();
	const rows = useMemo(() => versionRows(history), [history]);
	const head = rows.find((row) => row.current);
	const edits = useMemo(() => proseEdits(view, recordId), [view, recordId]);
	const dependents = view.dependencies.filter((d) => d.recordId === recordId && d.status === "accepted").length;

	// If a new version of this record lands while the editor is open, the draft is out of date: close it.
	const headHash = head?.snapshot.blobHash ?? null;
	const openedAt = useRef<string | null>(null);
	useEffect(() => {
		if (!editing) {
			openedAt.current = null;
		} else if (openedAt.current === null) {
			openedAt.current = headHash;
		} else if (openedAt.current !== headHash) {
			openedAt.current = null;
			onClose();
		}
	}, [editing, headHash, onClose]);
	if (!head) return null;
	const { snapshot } = head;
	const changedKeys = new Map(head.changes.map((change) => [change.key, change]));

	return (
		<article data-slot="record-card" data-record={recordId} className="rounded-xl border bg-card p-3.5 shadow-xs">
			<div className="flex items-center gap-2">
				<h3 className="min-w-0 truncate text-sm font-semibold" title={recordId}>
					{recordId}
				</h3>
				<Badge tone="primary" emphasis="solid" className="ml-auto bg-primary text-primary-foreground" title="Accepted version">
					<Check aria-hidden /> v{snapshot.version}
				</Badge>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				Accepted by {actorLabel(view, snapshot.acceptedBy)}
				{snapshot.acceptedAt ? ` · ${formatDateTime(snapshot.acceptedAt)}` : ""}
			</p>
			<p className="text-xs text-muted-foreground">{dependents === 0 ? "No work relies on it yet" : `${plural(dependents, "work item")} rely on it`}</p>

			{!editing && (
				<dl className="mt-3 space-y-1.5">
					{Object.entries(snapshot.facets).map(([key, value]) => {
						const change = changedKeys.get(key);
						return (
							<div key={key} className={cn("rounded-md px-2 py-1", change ? "bg-warning-soft" : "bg-muted/60")} data-facet={key} data-changed={change ? "true" : undefined}>
								<dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
								<dd className="text-[13px] font-medium break-words">
									{change?.kind === "changed" && (
										<>
											<span className="text-muted-foreground line-through decoration-muted-foreground/60">{formatFacet(change.from)}</span>
											<ArrowRight className="mx-1 inline size-3 text-muted-foreground" aria-hidden />
										</>
									)}
									{formatFacet(value)}
									{change && <span className="ml-2 text-[11px] font-semibold text-warning">{change.kind === "added" ? "added in this version" : "changed in this version"}</span>}
								</dd>
							</div>
						);
					})}
				</dl>
			)}

			{history.proposed && !editing && (
				<div className="mt-3 rounded-md border border-dashed p-2 text-xs text-muted-foreground" data-testid="proposed-version">
					<Badge tone="outline" dashed>
						proposed v{history.proposed.version}
					</Badge>{" "}
					Not accepted yet, so it governs nothing.
				</div>
			)}

			{editing ? (
				<ChangeEditor key={editorRequest?.recordId === recordId ? editorRequest.nonce : 0} recordId={recordId} snapshot={snapshot} onClose={onClose} />
			) : (
				<>
					<ol className="mt-3 space-y-0 border-l pl-3" aria-label={`${recordId} version history`}>
						{rows.map((row) => (
							<li key={row.snapshot.version} className="relative pb-2 last:pb-0" data-version={row.snapshot.version}>
								<span className={cn("absolute top-1.5 -left-[17px] size-2.5 rounded-full border-2 bg-card", row.current ? "border-primary bg-primary" : "border-muted-foreground/50")} aria-hidden />
								<div className="flex items-center gap-2 text-xs">
									<span className="font-semibold">v{row.snapshot.version}</span>
									<span className="text-muted-foreground">{row.current ? "current" : "superseded"}</span>
									<span className="ml-auto font-mono text-[11px] text-muted-foreground">{shortHash(row.snapshot.blobHash)}</span>
								</div>
								<p className="text-xs text-muted-foreground">
									{row.changes.length > 0 ? `${plural(row.changes.length, "facet")} changed: ${row.changes.map((c) => c.key.split(".").pop()).join(", ")}` : row.snapshot.version === 1 ? "First accepted version" : "Prose only"}
								</p>
							</li>
						))}
					</ol>
					{edits.length > 0 && (
						<p className="mt-2 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" data-testid="prose-edit-note">
							<FilePenLine className="size-3.5 shrink-0" aria-hidden />
							Prose edited {edits.length > 1 ? `${edits.length} times` : `at ${formatDateTime(edits[edits.length - 1]?.ts ?? "")}`}. No facet changed, so no work was re-evaluated.
						</p>
					)}
					<Button variant="outline" size="sm" className="mt-3 w-full" onClick={onEdit}>
						<ChevronRight aria-hidden /> Propose change
					</Button>
				</>
			)}
		</article>
	);
}

type FacetRow = { id: number; key: string; value: string; original: boolean };

function toRows(facets: Record<string, FacetValue>): FacetRow[] {
	return Object.entries(facets).map(([key, value], index) => ({ id: index, key, value: formatFacet(value), original: true }));
}

/** The "Propose change" editor: edit facets and prose, see what it will do, commit with an Idempotency-Key. */
export function ChangeEditor({ recordId, snapshot, onClose }: { recordId: string; snapshot: RecordSnapshot; onClose(): void }) {
	const { client, editorRequest, notify, markChangeSent, clearChangeSent } = useConsole();
	const draft = editorRequest && editorRequest.recordId === recordId ? editorRequest : null;
	const [rows, setRows] = useState<FacetRow[]>(() => toRows(draft?.facets ?? snapshot.facets));
	const [prose, setProse] = useState(draft?.prose ?? "");
	const [originalProse, setOriginalProse] = useState("");
	const [rationale, setRationale] = useState(draft?.rationale ?? "");
	const [touchedRationale, setTouchedRationale] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [nextRow, setNextRow] = useState(1000);

	useEffect(() => {
		let cancelled = false;
		client.api.readRecordText(recordId).then((text) => {
			if (cancelled) return;
			setOriginalProse(text);
			setProse((current) => (current === "" ? text : current));
		});
		return () => {
			cancelled = true;
		};
	}, [client, recordId]);

	const facets = useMemo(() => {
		const out: Record<string, FacetValue> = {};
		for (const row of rows) if (row.key.trim() !== "") out[row.key.trim()] = parseFacetInput(row.value);
		return out;
	}, [rows]);
	const changes = useMemo(() => diffFacets(snapshot, { facets }), [snapshot, facets]);
	const proseChanged = prose.trim() !== originalProse.trim();
	const nothingToCommit = changes.length === 0 && !proseChanged;
	const keyProblem = rows.some((row) => row.key.trim() === "" && row.value.trim() !== "") || new Set(rows.map((r) => r.key.trim()).filter(Boolean)).size !== rows.filter((r) => r.key.trim()).length;
	const rationaleMissing = rationale.trim() === "";
	const nextVersion = snapshot.version + (changes.length > 0 ? 1 : 0);

	// Prose edits get an automatic reason; a decision change must say why.
	const effectiveRationale = rationale.trim() === "" && changes.length === 0 && proseChanged ? "Prose edit" : rationale.trim();

	async function submit() {
		setSubmitted(true);
		if (nothingToCommit || keyProblem || effectiveRationale === "") return;
		setSubmitting(true);
		markChangeSent();
		const result = await client.api.proposeContextChange({ recordId, facets, prose, rationale: effectiveRationale }, newIdempotencyKey());
		setSubmitting(false);
		if (!result.ok) clearChangeSent();
		if (result.ok) {
			notify("success", result.message ?? "Committed.");
			onClose();
		} else {
			notify("danger", result.message);
		}
	}

	return (
		<form
			className="mt-3 space-y-3"
			aria-label={`Propose a change to ${recordId}`}
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<fieldset className="space-y-1.5">
				<legend className="mb-1 text-xs font-semibold">Facets</legend>
				{rows.map((row) => (
					<div key={row.id} className="flex items-center gap-1.5">
						<Input
							aria-label="Facet key"
							value={row.key}
							readOnly={row.original}
							onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
							className={cn("h-8 w-[46%] font-mono text-xs", row.original && "bg-muted text-muted-foreground")}
							placeholder="facet.key"
						/>
						<Input
							aria-label={`Value for ${row.key || "new facet"}`}
							value={row.value}
							onChange={(e) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
							className="h-8 flex-1 text-[13px]"
							placeholder="value"
						/>
						{!row.original && (
							<Button type="button" variant="ghost" size="icon-sm" aria-label="Remove facet" onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}>
								<X />
							</Button>
						)}
					</div>
				))}
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={() => {
						setRows((rs) => [...rs, { id: nextRow, key: "", value: "", original: false }]);
						setNextRow((n) => n + 1);
					}}
				>
					<Plus aria-hidden /> Add facet
				</Button>
			</fieldset>

			<div className="space-y-1">
				<Label htmlFor={`prose-${recordId}`}>Prose</Label>
				<Textarea id={`prose-${recordId}`} value={prose} onChange={(e) => setProse(e.target.value)} rows={4} className="text-[13px]" />
			</div>

			<div className="space-y-1">
				<Label htmlFor={`why-${recordId}`}>Why this change</Label>
				<Input
					id={`why-${recordId}`}
					value={rationale}
					onChange={(e) => {
						setRationale(e.target.value);
						setTouchedRationale(true);
					}}
					aria-invalid={(submitted || touchedRationale) && changes.length > 0 && rationaleMissing ? true : undefined}
					placeholder={changes.length === 0 && proseChanged ? "Prose edit" : "Required for a decision change"}
				/>
			</div>

			<p className={cn("rounded-md px-2.5 py-1.5 text-xs", changes.length > 0 ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground")} data-testid="editor-effect" aria-live="polite">
				{nothingToCommit
					? "Nothing changed yet."
					: changes.length > 0
						? `${plural(changes.length, "facet")} changed: this commits v${nextVersion} and re-evaluates every work item that relies on ${changes.length === 1 ? "it" : "them"}.`
						: `Facets unchanged: this saves as a prose edit of v${snapshot.version}. Nothing is re-evaluated and nobody is paged.`}
			</p>
			{submitted && keyProblem && <p className="text-xs text-danger">Every facet needs a unique key.</p>}
			{submitted && !keyProblem && changes.length > 0 && rationaleMissing && <p className="text-xs text-danger">Say why the decision changed.</p>}

			<div className="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={submitting || nothingToCommit}>
					{submitting ? "Committing" : changes.length > 0 ? `Commit v${nextVersion}` : "Save prose edit"}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onClose}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
