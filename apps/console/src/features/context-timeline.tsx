import type { ReactNode } from "react";
import type { FacetValue, RecordHistory, RecordSnapshot } from "contracts";
import { diffFacets } from "delta-core";
import { ArrowRight, BookMarked, Check, ChevronRight, FilePenLine, FilePlus2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { newIdempotencyKey } from "@/client/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatDateTime, formatFacet, parseFacetInput, plural, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { UnavailableHint } from "@/components/unavailable-hint";
import { useConsole } from "@/state/console-context";
import { scenarioMeta } from "./scenario-meta";
import { actorLabel, impactSentence, impactSummary, previewImpact, proseEdits, recordIds } from "@/state/derive";

export function ContextTimeline() {
	const { view, editorRequest, requestEditor } = useConsole();
	const ids = recordIds(view);
	const [editing, setEditing] = useState<string | null>(null);

	// A beat (or a deep link) can open the editor with a draft already filled in.
	useEffect(() => {
		if (editorRequest) setEditing(editorRequest.recordId);
	}, [editorRequest]);

	return (
		<section aria-label="Decisions" className="flex min-h-0 flex-1 flex-col">
			<PaneHeader title="Decisions" subtitle="What work is judged against" meta={view.baselineCommit ? `baseline ${shortHash(view.baselineCommit)}` : undefined} />
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

/** `truncateTitle`: the title is a work item's own, so it may be long; it shortens with an ellipsis instead of pushing the header wider. */
export function PaneHeader({ title, subtitle, meta, children, truncateTitle = false }: { title: string; subtitle?: string; meta?: string; children?: ReactNode; truncateTitle?: boolean }) {
	return (
		<div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-1.5">
			<h2 className={cn("text-[13px] font-semibold tracking-tight", truncateTitle ? "min-w-0 truncate" : "shrink-0 whitespace-nowrap")} title={truncateTitle ? title : undefined}>
				{title}
			</h2>
			{subtitle && <span className="min-w-0 truncate text-xs text-muted-foreground">{subtitle}</span>}
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
			<p className="text-sm font-semibold">No decisions yet. Declare the first one.</p>
			<p className="mt-1.5 text-xs text-muted-foreground">
				Work is only ever judged against accepted decisions. Seed the {scenarioMeta(client.scenario, client.kind === "live").label} scenario to start from its first ones.
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
	const { view, editorRequest, client } = useConsole();
	const readOnly = scenarioMeta(client.scenario, client.kind === "live").readOnlyReason;
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
			<p className="text-xs text-muted-foreground">{dependents === 0 ? "No work relies on it yet" : dependents === 1 ? "1 work item relies on it" : `${dependents} work items rely on it`}</p>

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
									{row.changes.length > 0 ? `${plural(row.changes.length, "setting")} changed: ${row.changes.map((c) => c.key.split(".").pop()).join(", ")}` : row.snapshot.version === 1 ? "First accepted version" : "Wording only"}
								</p>
							</li>
						))}
					</ol>
					{edits.length > 0 && (
						<p className="mt-2 flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" data-testid="prose-edit-note">
							<FilePenLine className="size-3.5 shrink-0" aria-hidden />
							Wording edited {edits.length > 1 ? `${edits.length} times` : `at ${formatDateTime(edits[edits.length - 1]?.ts ?? "")}`}. No setting changed, so no work was re-checked.
						</p>
					)}
					<UnavailableHint available={!readOnly} reason={readOnly ?? ""}>
						<Button variant="outline" size="sm" className="mt-3 w-full" disabled={Boolean(readOnly)} onClick={onEdit}>
							<ChevronRight aria-hidden /> Change this decision
						</Button>
					</UnavailableHint>
				</>
			)}
		</article>
	);
}

/** The reason recorded, and shown as the placeholder, for a change to the wording alone. */
const WORDING_REASON = "Wording";

type FacetRow = { id: number; key: string; value: string; original: boolean };

function toRows(facets: Record<string, FacetValue>): FacetRow[] {
	return Object.entries(facets).map(([key, value], index) => ({ id: index, key, value: formatFacet(value), original: true }));
}

/** A one-line field that wraps and grows with its text, so a long key or value is never cut off. Enter does not add a line. */
function GrowField({ value, className, onChange, ...props }: Omit<ComponentProps<typeof Textarea>, "rows" | "onChange"> & { value: string; onChange(value: string): void }) {
	const ref = useRef<HTMLTextAreaElement>(null);
	const measure = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
	}, []);
	useLayoutEffect(measure, [measure, value]);
	// A narrower or wider card re-wraps the text, so the height has to follow the width as well as the text.
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let width = el.clientWidth;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			measure();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [measure]);
	return (
		<Textarea
			{...props}
			ref={ref}
			rows={1}
			value={value}
			onChange={(e) => onChange(e.target.value.replace(/\r?\n/g, " "))}
			onKeyDown={(e) => {
				// Enter that confirms an input-method composition is not a new line; leave it alone.
				if (e.key === "Enter" && !e.nativeEvent.isComposing) e.preventDefault();
				props.onKeyDown?.(e);
			}}
			className={cn("min-h-8 resize-none overflow-hidden py-1 leading-snug break-words", className)}
		/>
	);
}

/** The "Change this decision" editor: edit settings and wording, see what it will do, save with an Idempotency-Key. */
export function ChangeEditor({ recordId, snapshot, onClose }: { recordId: string; snapshot: RecordSnapshot; onClose(): void }) {
	const { client, view, editorRequest, notify, markChangeSent, clearChangeSent } = useConsole();
	// The baseline the editor opened on: a change made from a version that has since moved is refused, not merged over.
	const [openedAt] = useState(view.baselineCommit);
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
	// What this change would block and leave alone, worked out from the view as the owner types.
	const impact = useMemo(() => previewImpact(view, recordId, facets, { proseChanged }), [view, recordId, facets, proseChanged]);
	const keyProblem = rows.some((row) => row.key.trim() === "" && row.value.trim() !== "") || new Set(rows.map((r) => r.key.trim()).filter(Boolean)).size !== rows.filter((r) => r.key.trim()).length;
	const rationaleMissing = rationale.trim() === "";
	const nextVersion = snapshot.version + (changes.length > 0 ? 1 : 0);
	// The decision moved on since this editor opened (the view is ahead of the version being edited): the preview and the save button would name different versions.
	const moved = impact !== null && impact.fromVersion !== snapshot.version;

	// Screen readers hear a short count, settled after typing pauses, rather than the whole line on every keystroke.
	const summary = impact && !moved ? impactSummary(impact) : "";
	const [announced, setAnnounced] = useState(summary);
	useEffect(() => {
		const timer = setTimeout(() => setAnnounced(summary), 700);
		return () => clearTimeout(timer);
	}, [summary]);

	// Prose edits get an automatic reason; a decision change must say why.
	const effectiveRationale = rationale.trim() === "" && changes.length === 0 && proseChanged ? WORDING_REASON : rationale.trim();

	async function submit() {
		setSubmitted(true);
		if (nothingToCommit || moved || keyProblem || effectiveRationale === "") return;
		setSubmitting(true);
		markChangeSent();
		const result = await client.api.proposeContextChange({ recordId, facets, prose, rationale: effectiveRationale, ...(openedAt ? { expectedBaselineCommit: openedAt } : {}) }, newIdempotencyKey());
		setSubmitting(false);
		if (!result.ok) clearChangeSent();
		if (result.ok) {
			notify("success", result.message ?? "Saved.");
			onClose();
		} else {
			notify("danger", result.code === "BASELINE_MOVED" ? `The decisions changed after you opened this editor, so nothing was saved. Close it and reopen to start from the latest version. (${result.message})` : result.message);
		}
	}

	return (
		<form
			className="mt-3 space-y-3"
			aria-label={`Change ${recordId}`}
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<fieldset className="space-y-1.5">
				<legend className="mb-1 text-xs font-semibold">Settings</legend>
				{rows.map((row) => (
					// Key above value, each as wide as the card and growing with its text: nothing is cut off, and keys that share a prefix still show how they differ.
					<div key={row.id} className="space-y-1">
						<div className="flex items-start gap-1.5">
							<GrowField
								aria-label="Setting"
								value={row.key}
								readOnly={row.original}
								onChange={(key) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, key } : r)))}
								className={cn("flex-1 font-mono text-xs", row.original && "bg-muted text-muted-foreground")}
								placeholder="setting.name"
							/>
							{!row.original && (
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Remove setting" onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}>
									<X />
								</Button>
							)}
						</div>
						<GrowField
							aria-label={`Value for ${row.key || "new setting"}`}
							value={row.value}
							onChange={(value) => setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, value } : r)))}
							className="text-[13px]"
							placeholder="value"
						/>
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
					<Plus aria-hidden /> Add setting
				</Button>
			</fieldset>

			<div className="space-y-1">
				<Label htmlFor={`prose-${recordId}`}>Full wording</Label>
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
					placeholder={changes.length === 0 && proseChanged ? WORDING_REASON : "Required for a decision change"}
				/>
			</div>

			{/* Sticky: the effect line and the save button stay in view however far the settings and wording push them down. */}
			<div className="sticky bottom-0 z-10 -mx-3.5 -mb-3.5 space-y-2 border-t bg-card px-3.5 pt-2.5 pb-3.5" data-testid="editor-footer">
				<p
					className={cn("rounded-md px-2.5 py-1.5 text-xs", changes.length > 0 ? "bg-warning-soft text-warning" : "bg-muted text-muted-foreground")}
					data-testid="editor-effect"
					data-blocked={impact?.blocked.map((b) => b.id).join(",")}
					data-left-alone={impact?.leftAlone.map((b) => b.id).join(",")}
					>
					{moved ? "The decision changed while you were editing. Close this and reopen it to see the effect." : impact ? impactSentence(impact) : `This makes v${nextVersion} the decision.`}
				</p>
				<span role="status" aria-live="polite" className="sr-only" data-testid="editor-effect-summary">
					{announced}
				</span>
				{submitted && keyProblem && <p className="text-xs text-danger">Every setting needs a unique name.</p>}
				{submitted && !keyProblem && changes.length > 0 && rationaleMissing && <p className="text-xs text-danger">Say why the decision changed.</p>}

				<div className="flex items-center gap-2">
					<Button type="submit" size="sm" disabled={submitting || nothingToCommit || moved}>
						{submitting ? "Saving" : moved ? "Make it the decision" : changes.length > 0 ? `Make v${nextVersion} the decision` : "Save wording change"}
					</Button>
					<Button type="button" variant="ghost" size="sm" onClick={onClose}>
						Cancel
					</Button>
				</div>
			</div>
		</form>
	);
}
