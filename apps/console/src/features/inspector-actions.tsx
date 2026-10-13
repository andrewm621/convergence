import type { ResolutionBinding, WorkItemState } from "contracts";
import { CircleAlert, CircleCheck, Gavel, Loader, RefreshCw, ShieldAlert, ShieldCheck, ThumbsDown, TriangleAlert } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { newIdempotencyKey, type ResolveInput } from "@/client/types";
import { CommitSha } from "@/components/commit-sha";
import { UnavailableHint } from "@/components/unavailable-hint";
import { ActorChip, ReasonChip } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDateTime, formatTime, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { analysisOf, currentRecord, exceptionStatus, exceptionWaiver, recordName, type ExceptionWaiver } from "@/state/derive";
import { useGate } from "@/state/use-gate";
import { PromoteButton } from "./promote-button";
import { scenarioMeta } from "./scenario-meta";

export function ActionsTab({ wi }: { wi: WorkItemState }) {
	const id = wi.item.id;
	return (
		<div className="space-y-5 p-4" data-testid="actions-tab">
			<GatePreview workItemId={id} />
			<section aria-label="Merge" className="space-y-2">
				<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Merge</h3>
				<PromoteButton workItemId={id} showReasons />
			</section>
			<Resolutions wi={wi} />
			<ResolutionHistory wi={wi} />
		</div>
	);
}

/** The dry run: what Merge would do right now, and why. It re-runs whenever anything it depends on changes. */
export function GatePreview({ workItemId }: { workItemId: string }) {
	const { view } = useConsole();
	const { gate, loading, error } = useGate(workItemId);
	const wi = view.workItems[workItemId];
	const promoted = wi?.item.status === "promoted";

	return (
		<section aria-label="Gate preview" aria-live="polite" data-testid="gate-preview" className="rounded-xl border bg-card p-3.5">
			<div className="flex items-center gap-2">
				<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Gate preview</h3>
				<span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
					{loading && <Loader className="size-3 animate-spin" aria-hidden />}
					dry run · baseline <CommitSha sha={view.baselineCommit} /> · head <CommitSha sha={wi?.headSha} />
				</span>
			</div>
			{promoted ? (
				<p className="mt-2 flex items-center gap-2 text-sm">
					<ShieldCheck className="size-4 text-merged" aria-hidden /> Already merged into the baseline.
				</p>
			) : error ? (
				<p className="mt-2 text-sm text-danger">The gate could not be read: {error}</p>
			) : !gate ? (
				<p className="mt-2 text-sm text-muted-foreground">Checking the gate at the current heads.</p>
			) : (
				<div className="mt-2 space-y-2.5">
					<p className={cn("flex items-center gap-2 text-sm font-semibold", gate.pass ? "text-foreground" : "text-danger")}>
						{gate.pass ? <CircleCheck className="size-4" aria-hidden /> : <ShieldAlert className="size-4" aria-hidden />}
						{gate.pass ? "Merge would pass the gate" : "Merge would be blocked"}
					</p>
					{!gate.pass && (
						<ul className="flex flex-wrap gap-1.5" aria-label="Reason codes">
							{gate.reasonCodes.map((code) => (
								<li key={code}>
									<ReasonChip code={code} />
								</li>
							))}
						</ul>
					)}
					{gate.blockers.length > 0 && (
						<ul className="space-y-1 text-[13px] text-muted-foreground">
							{gate.blockers.map((line) => (
								<li key={line} className="flex gap-2">
									<CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
									{line}
								</li>
							))}
						</ul>
					)}
					{gate.pass && gate.waivedBy.length > 0 && (
						<p className="text-[13px] text-muted-foreground" data-testid="gate-waived">
							Passes with {gate.waivedBy.length === 1 ? "an accepted exception" : `${gate.waivedBy.length} accepted exceptions`}
							{gate.waivedBy.some((w) => w.scope) ? `: ${gate.waivedBy.map((w) => w.scope).filter(Boolean).join("; ")}` : ""}.
						</p>
					)}
					{gate.pass && <p className="text-[13px] text-muted-foreground">A human still decides. Merge re-checks every rule at the current heads before it merges.</p>}
				</div>
			)}
		</section>
	);
}

function bindingFor(view: ReturnType<typeof useConsole>["view"], wi: WorkItemState, recordId: string): ResolutionBinding | null {
	const record = currentRecord(view, recordId);
	if (!record || !wi.headSha) return null;
	return {
		recordId,
		version: record.version,
		blobHash: record.blobHash,
		baseSha: view.baselineCommit,
		forkHeadSha: wi.headSha,
		contextSnapshotHash: view.snapshotHash,
	};
}

type Open = "exception" | "reject" | null;

/** The three human choices, each with what it does. Shown under the reason on the Why tab, and again on the Actions tab. */
export function Resolutions({ wi }: { wi: WorkItemState }) {
	const { view, client, notify } = useConsole();
	const [open, setOpen] = useState<Open>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [confirmRerun, setConfirmRerun] = useState(false);
	const rerunCancelRef = useRef<HTMLButtonElement>(null);
	const rerunTitleId = useId();
	const analysis = useMemo(() => analysisOf(view, wi.item.id), [view, wi.item.id]);

	// The records worth deciding about: stale or in conflict first, else everything it relies on.
	const candidates = useMemo(() => {
		const ids = new Set<string>();
		for (const f of analysis?.stale ?? []) ids.add(f.recordId);
		for (const f of analysis?.conflicts ?? []) ids.add(f.recordId);
		if (ids.size === 0) for (const d of view.dependencies) if (d.workItemId === wi.item.id && d.status === "accepted") ids.add(d.recordId);
		return [...ids].sort();
	}, [analysis, view.dependencies, wi.item.id]);
	// What an exception on each candidate would waive, named from the same facts the gate uses.
	const waivers = useMemo(() => {
		const out: Record<string, ExceptionWaiver> = {};
		if (analysis) for (const id of candidates) out[id] = exceptionWaiver(view, wi, analysis, id);
		return out;
	}, [analysis, candidates, view, wi]);

	const promoted = wi.item.status === "promoted";
	const noPush = wi.headSha === null;
	const defaultRecord = candidates[0] ?? null;
	const readOnly = scenarioMeta(client.scenario, client.kind === "live").readOnlyReason;
	const reason = readOnly ?? (promoted ? "Already merged." : noPush ? "Waiting for the agent's first push: a resolution binds to a specific head." : null);

	async function submit(input: Omit<ResolveInput, "binding" | "workItemId">, recordId: string | null, label: string): Promise<boolean> {
		const binding = recordId ? bindingFor(view, wi, recordId) : null;
		if (!binding) {
			notify("danger", "Nothing to bind this resolution to yet.");
			return false;
		}
		setBusy(label);
		const result = await client.api.resolve({ ...input, workItemId: wi.item.id, binding }, newIdempotencyKey());
		setBusy(null);
		notify(result.ok ? "success" : "danger", result.ok ? (result.message ?? `${label} recorded.`) : `${result.message}${result.reasonCodes?.length ? ` (${result.reasonCodes.join(", ")})` : ""}`);
		return result.ok;
	}

	const staleNote = analysis?.stale.map((f) => `${f.recordId} v${f.fromVersion} to v${f.toVersion}`).join(", ");
	const maxRuns = view.policy?.maxRevalidations;
	const runsUsedUp = maxRuns !== undefined && wi.revalidations >= maxRuns;
	// What a re-run would be on: the version of the decision the agent would be sent back to.
	const rerunVersion = defaultRecord ? currentRecord(view, defaultRecord)?.version : undefined;
	const rerunTarget = defaultRecord && rerunVersion !== undefined ? `${recordName(defaultRecord)} v${rerunVersion}` : "the current decisions";
	const revalidateNote = runsUsedUp
		? `All ${maxRuns} re-runs are used. A reviewer has to decide what happens to this work (REVALIDATION_LIMIT).`
		: `Sends the agent back to redo this on the current decisions.${maxRuns === undefined ? "" : ` Uses ${wi.revalidations + 1} of ${maxRuns} re-runs.`}`;

	// Work that is ready to merge has nothing to lift or redo, whether it is clean or passes under an exception. Rejecting it stays possible.
	const ready = wi.item.status === "ready";

	// If the agent is already re-running (or the choice has gone away) while the confirm is open, there is nothing left to confirm.
	const rerunClosed = wi.revalidating || runsUsedUp || ready || Boolean(reason);
	useEffect(() => {
		if (rerunClosed) setConfirmRerun(false);
	}, [rerunClosed]);

	return (
		<section aria-label="Resolve" className="space-y-3" data-testid="resolve-actions">
			<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Resolve</h3>
			<div className="space-y-2.5">
				{!ready && (
					<ResolveRow
						note={revalidateNote}
						button={
							<UnavailableHint available={!readOnly} reason={readOnly ?? ""}>
								<Popover open={confirmRerun} onOpenChange={setConfirmRerun}>
									<PopoverTrigger asChild>
										<Button size="sm" variant="outline" className="w-full justify-start" data-testid="revalidate-button" disabled={Boolean(reason) || wi.revalidating || busy !== null || runsUsedUp}>
											{busy === "Revalidate" ? <Loader className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
											Revalidate
										</Button>
									</PopoverTrigger>
									<PopoverContent
										role="dialog"
										aria-labelledby={rerunTitleId}
										data-testid="revalidate-sheet"
										onOpenAutoFocus={(event) => {
											event.preventDefault();
											rerunCancelRef.current?.focus();
										}}
									>
										<p id={rerunTitleId} className="text-[13px] leading-relaxed">
											<span className="font-semibold">Re-run the agent on {rerunTarget}?</span>
											{maxRuns !== undefined && ` Uses ${wi.revalidations + 1} of ${maxRuns} re-runs.`}
										</p>
										<div className="mt-3 flex gap-2">
											<Button
												size="sm"
												data-testid="revalidate-confirm"
												onClick={() => {
													setConfirmRerun(false);
													void submit({ kind: "revalidate", rationale: staleNote ? `Decision changed under this work: ${staleNote}.` : "Re-run on the current decisions." }, defaultRecord, "Revalidate");
												}}
											>
												<RefreshCw aria-hidden /> Re-run
											</Button>
											<Button ref={rerunCancelRef} size="sm" variant="ghost" data-testid="revalidate-cancel" onClick={() => setConfirmRerun(false)}>
												Cancel
											</Button>
										</div>
									</PopoverContent>
								</Popover>
							</UnavailableHint>
						}
					/>
				)}
				{!ready && (
					<ResolveRow
						note="Lifts the block from this decision, for a scope you name. Other blocks stay. Ends at its next version or the agent's next push."
						button={
							<UnavailableHint available={!readOnly} reason={readOnly ?? ""}>
								<Button size="sm" variant="outline" className="w-full justify-start" disabled={Boolean(reason) || busy !== null} aria-expanded={open === "exception"} onClick={() => setOpen(open === "exception" ? null : "exception")}>
									<Gavel aria-hidden /> Accept exception
								</Button>
							</UnavailableHint>
						}
					/>
				)}
				<ResolveRow
					note="Ends this work. The reason goes in the audit log."
					button={
						<UnavailableHint available={!readOnly} reason={readOnly ?? ""}>
							<Button size="sm" variant="outline" className="w-full justify-start" disabled={Boolean(reason) || busy !== null} aria-expanded={open === "reject"} onClick={() => setOpen(open === "reject" ? null : "reject")}>
								<ThumbsDown aria-hidden /> Reject
							</Button>
						</UnavailableHint>
					}
				/>
			</div>
			{reason && <p className="text-xs text-muted-foreground">{reason}</p>}
			{!reason && wi.revalidating && <p className="text-xs text-muted-foreground">Revalidation is running. The agent will push again on the current decisions.</p>}

			{open === "exception" && !ready && (
				<ExceptionForm
					candidates={candidates}
					waivers={waivers}
					busy={busy === "Exception"}
					onCancel={() => setOpen(null)}
					onSubmit={async (recordId, scope, rationale) => {
						if (await submit({ kind: "accept-exception", scope, rationale }, recordId, "Exception")) setOpen(null);
					}}
				/>
			)}
			{open === "reject" && (
				<RejectForm
					busy={busy === "Reject"}
					onCancel={() => setOpen(null)}
					onSubmit={async (rationale) => {
						if (await submit({ kind: "reject", rationale }, defaultRecord, "Reject")) setOpen(null);
					}}
				/>
			)}
		</section>
	);
}

/** One choice: the button, and one line on what it does. */
function ResolveRow({ button, note }: { button: ReactNode; note: string }) {
	return (
		<div className="grid grid-cols-[9.5rem_minmax(0,1fr)] items-start gap-x-3">
			{button}
			<p className="pt-1 text-xs leading-snug text-muted-foreground">{note}</p>
		</div>
	);
}

/** Scope and rationale are both required, and validated here before anything is sent. */
export function ExceptionForm({
	candidates,
	waivers = {},
	busy,
	onCancel,
	onSubmit,
}: {
	candidates: string[];
	/** What an exception on each candidate waives. Without it the form still says what R5 says, just without naming the check. */
	waivers?: Record<string, ExceptionWaiver>;
	busy: boolean;
	onCancel(): void;
	onSubmit(recordId: string | null, scope: string, rationale: string): void | Promise<void>;
}) {
	const [recordId, setRecordId] = useState(candidates[0] ?? "");
	const [scope, setScope] = useState("");
	const [rationale, setRationale] = useState("");
	const [attempted, setAttempted] = useState(false);
	const scopeMissing = scope.trim() === "";
	const rationaleMissing = rationale.trim() === "";

	function handle(event: FormEvent) {
		event.preventDefault();
		setAttempted(true);
		if (scopeMissing || rationaleMissing) return;
		void onSubmit(recordId || null, scope.trim(), rationale.trim());
	}

	return (
		<form onSubmit={handle} noValidate aria-label="Accept exception" className="space-y-3 rounded-xl border border-dashed bg-card p-3.5">
			<ExceptionTerms recordId={recordId || null} waiver={waivers[recordId]} />
			{candidates.length > 1 && (
				<div className="space-y-1">
					<Label htmlFor="exception-record">Record</Label>
					<NativeSelect id="exception-record" value={recordId} onChange={(e) => setRecordId(e.target.value)}>
						{candidates.map((id) => (
							<option key={id} value={id}>
								{id}
							</option>
						))}
					</NativeSelect>
				</div>
			)}
			<div className="space-y-1">
				<Label htmlFor="exception-scope">Scope</Label>
				<Input
					id="exception-scope"
					value={scope}
					onChange={(e) => setScope(e.target.value)}
					placeholder="e.g. reports/q4-forecast.md"
					aria-invalid={attempted && scopeMissing ? true : undefined}
					aria-describedby={attempted && scopeMissing ? "exception-scope-error" : undefined}
				/>
				{attempted && scopeMissing && (
					<p id="exception-scope-error" role="alert" className="text-xs text-danger">
						Scope is required: say what this exception covers.
					</p>
				)}
			</div>
			<div className="space-y-1">
				<Label htmlFor="exception-rationale">Rationale</Label>
				<Textarea
					id="exception-rationale"
					value={rationale}
					onChange={(e) => setRationale(e.target.value)}
					rows={3}
					placeholder="Why is it safe to let this through?"
					aria-invalid={attempted && rationaleMissing ? true : undefined}
					aria-describedby={attempted && rationaleMissing ? "exception-rationale-error" : undefined}
				/>
				{attempted && rationaleMissing && (
					<p id="exception-rationale-error" role="alert" className="text-xs text-danger">
						Rationale is required: it goes on the record.
					</p>
				)}
			</div>
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy}>
					{busy ? "Recording" : "Record exception"}
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

/**
 * What an exception does, in full (rule R5): it lifts the block from one record, waiving staleness, claim conflicts and that
 * record's own failing check, and nothing else. Every other block stays, and the form says which. Says when it ends and
 * where it is recorded.
 */
function ExceptionTerms({ recordId, waiver }: { recordId: string | null; waiver: ExceptionWaiver | undefined }) {
	const name = recordId ?? "the decision";
	const checkName = waiver?.check?.split("/").pop();
	return (
		<div className="space-y-2 text-[13px]" data-testid="exception-terms">
			<p>
				Lifts the block from <span className="font-semibold">{name}</span> only.
				{waiver && !waiver.lifts ? ` This work is not stale or in conflict against ${name}, so an exception on it lifts nothing.` : " It waives:"}
			</p>
			{(!waiver || waiver.lifts) && (
				<ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
					<li>staleness: being built on the old version</li>
					<li>claim conflicts with the new version</li>
					{!waiver ? (
						<li>this decision&apos;s own check, if it names one and that check is failing</li>
					) : (
						waiver.check &&
						waiver.checkState && (
							<li data-testid="exception-waived-check" data-check-state={waiver.checkState} className={cn(waiver.checkState === "failing" && "font-semibold text-danger")}>
								this decision&apos;s own check: {checkName},{" "}
								{waiver.checkState === "failing" ? "currently failing" : waiver.checkState === "passing" ? "passing now" : "not run at this head yet"}
							</li>
						)
					)}
				</ul>
			)}
			{waiver && waiver.otherBlocks.length > 0 && (
				<div data-testid="exception-other-blocks">
					<p className="font-semibold">Other blocks stay:</p>
					<ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
						{waiver.otherBlocks.map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</div>
			)}
			{waiver && waiver.wouldPass !== null && (
				<p data-testid="exception-dry-run" className={cn("font-medium", !waiver.wouldPass && "text-danger")}>
					{waiver.wouldPass ? "With this exception the gate would pass. A human still decides whether to merge." : "With this exception the gate would still be closed."}
				</p>
			)}
			<p className="text-muted-foreground">It never waives unknowns (missing or malformed claims, undeclared dependencies), other records&apos; checks, or edits to accepted context.</p>
			<p>
				<span className="font-semibold">Ends when</span> {name} gets a new version or the agent pushes again. <span className="font-semibold">Recorded in the audit log</span>
				{waiver?.signer ? `, and only ${waiver.signer} can grant it` : ""}.
			</p>
		</div>
	);
}

export function RejectForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel(): void; onSubmit(rationale: string): void | Promise<void> }) {
	const [rationale, setRationale] = useState("");
	const [attempted, setAttempted] = useState(false);
	const missing = rationale.trim() === "";
	return (
		<form
			noValidate
			aria-label="Reject"
			className="space-y-3 rounded-xl border border-dashed bg-card p-3.5"
			onSubmit={(event) => {
				event.preventDefault();
				setAttempted(true);
				if (!missing) void onSubmit(rationale.trim());
			}}
		>
			<div className="space-y-1">
				<Label htmlFor="reject-rationale">Rationale</Label>
				<Textarea id="reject-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} placeholder="Why is this work being rejected?" aria-invalid={attempted && missing ? true : undefined} />
				{attempted && missing && (
					<p role="alert" className="text-xs text-danger">
						Rationale is required: it goes on the record.
					</p>
				)}
			</div>
			<div className="flex gap-2">
				<Button type="submit" size="sm" variant="destructive" disabled={busy}>
					{busy ? "Recording" : "Reject work"}
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

function ResolutionHistory({ wi }: { wi: WorkItemState }) {
	const { view } = useConsole();
	if (wi.resolutions.length === 0) return null;
	return (
		<section aria-label="Resolutions on record" className="space-y-2">
			<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">On record</h3>
			<ol className="space-y-2">
				{wi.resolutions.map((r, index) => {
					const exception = exceptionStatus(view, wi, r);
					return (
						<li
							key={`${r.requestId ?? index}`}
							className={cn("rounded-lg border bg-card p-3 text-sm", exception?.lapsed && "border-danger/40 bg-danger-soft")}
							data-resolution={r.kind}
							data-exception={exception ? (exception.lapsed ? "lapsed" : "valid") : undefined}
						>
							<div className="flex items-center gap-2">
								<Badge tone="primary" className="text-sm">
									{r.kind}
								</Badge>
								{exception?.lapsed && (
									<Badge tone="danger" className="text-sm font-semibold">
										<TriangleAlert aria-hidden /> Lapsed
									</Badge>
								)}
								<ActorChip actor={r.actor} />
								<span className="ml-auto text-xs text-muted-foreground">{formatDateTime(r.ts)}</span>
							</div>
							<p className="mt-1.5">{r.rationale}</p>
							{r.scope && <p className="mt-1 text-sm text-muted-foreground">Scope: {r.scope}</p>}
							{exception && (
								<div className="mt-2 space-y-1.5 rounded-md border border-dashed bg-background/60 p-2.5" data-testid="exception-rule">
									{exception.lapsed ? (
										<>
											<p className="flex flex-wrap items-center gap-2 font-semibold text-danger">
												Lapsed
												<ReasonChip code={exception.reasonCode} className="text-xs" />
											</p>
											<p>
												It was valid while {r.binding.recordId} was at v{exception.version}. {exception.reason} The gate no longer treats this exception as covering the work.
											</p>
										</>
									) : (
										<p className="font-medium">
											Valid while {r.binding.recordId} is at v{exception.version} <span aria-hidden>·</span> lapses at the next version or when the fork pushes again
										</p>
									)}
								</div>
							)}
							<p className="mt-1.5 font-mono text-xs text-muted-foreground">
								bound to {r.binding.recordId}@{r.binding.version} · head {shortHash(r.binding.forkHeadSha)} · {formatTime(r.ts)}
							</p>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
