import { parseRecordRef, type Claim, type Dependency, type FacetValue, type ReasonCode, type ReceiptEntry, type ReconciliationEvent, type RecordSnapshot, type Resolution, type WorkItemState } from "contracts";
import { analyze, authorityFor, classifyExceptions, diffFacets, facetValuesEqual, findStale, type Analysis } from "delta-core";
import { DEMO_IDENTITY } from "@/config";
import { describeCheck } from "@/lib/evidence";
import { toCellState, type Evaluation, type ViewState } from "./store";

/**
 * Read-only derivations over the view state. They run delta-core's pure analyses over what the
 * stream delivered, so the console explains itself with the same rules the server applies. The
 * promotion gate is the exception: it always comes from the server (`GET /work-items/:id/gate`).
 */

export function currentRecord(view: ViewState, recordId: string): RecordSnapshot | null {
	const history = view.records[recordId];
	if (!history || history.current === null) return null;
	return history.versions[String(history.current)] ?? null;
}

export function recordIds(view: ViewState): string[] {
	return Object.keys(view.records).sort();
}

export function workItemsSorted(view: ViewState): WorkItemState[] {
	return Object.values(view.workItems).sort((a, b) => a.item.id.localeCompare(b.item.id, undefined, { numeric: true }));
}

// ---------- the work graph's dependency edges ----------

export type EdgeKind = "ok" | "stale" | "excepted" | "proposed";

export type DepEdge = {
	id: string;
	workItemId: string;
	recordId: string;
	kind: EdgeKind;
	/** Version in the work item's receipt. */
	heldVersion: number | null;
	currentVersion: number | null;
	/** Facets the item relies on that changed since its receipt. */
	changedFacets: string[];
};

export function dependencyEdges(view: ViewState): DepEdge[] {
	if (!view.policy) return [];
	const state = toCellState(view);
	const edges: DepEdge[] = [];
	const staleCache = new Map<string, ReturnType<typeof findStale>>();
	const exceptCache = new Map<string, Set<string>>();

	for (const dep of view.dependencies) {
		if (dep.status === "rejected") continue;
		const wi = view.workItems[dep.workItemId];
		if (!wi) continue;
		const current = currentRecord(view, dep.recordId);
		const held = wi.receipt.accepted.find((entry) => entry.recordId === dep.recordId)?.version ?? null;
		const base = { id: `${dep.workItemId}->${dep.recordId}`, workItemId: dep.workItemId, recordId: dep.recordId, heldVersion: held, currentVersion: current?.version ?? null };
		if (dep.status === "proposed") {
			edges.push({ ...base, kind: "proposed", changedFacets: [] });
			continue;
		}
		if (wi.item.status === "promoted") {
			edges.push({ ...base, kind: "ok", changedFacets: [] });
			continue;
		}
		let findings = staleCache.get(wi.item.id);
		if (!findings) {
			findings = findStale(state, wi, view.policy);
			staleCache.set(wi.item.id, findings);
		}
		let excepted = exceptCache.get(wi.item.id);
		if (!excepted) {
			excepted = new Set(classifyExceptions(state, wi, view.policy).valid.map((r) => r.binding.recordId));
			exceptCache.set(wi.item.id, excepted);
		}
		const finding = findings.find((f) => f.recordId === dep.recordId);
		if (!finding) edges.push({ ...base, kind: "ok", changedFacets: [] });
		else edges.push({ ...base, kind: excepted.has(dep.recordId) ? "excepted" : "stale", changedFacets: finding.facetKeys });
	}
	return edges;
}

// ---------- agents ----------

/** Work item ids whose latest ledger run event is a start. */
export function runningAgents(ledger: readonly ReconciliationEvent[]): Set<string> {
	const running = new Set<string>();
	for (const entry of ledger) {
		const event = entry.payload.event;
		if (event.type === "AgentRunStarted") running.add(event.workItemId);
		else if (event.type === "AgentRunFinished") running.delete(event.workItemId);
	}
	return running;
}

/**
 * What runs a work item: the model named on its latest `AgentRunStarted` (display only). Null when
 * the event names none or is outside the ledger window; callers then fall back to the actor's name.
 */
export function agentModelOf(ledger: readonly ReconciliationEvent[], workItemId: string): string | null {
	for (let i = ledger.length - 1; i >= 0; i--) {
		const event = ledger[i]?.payload.event;
		if (event?.type === "AgentRunStarted" && event.workItemId === workItemId) return event.model ?? null;
	}
	return null;
}

// ---------- claims vs facets (the semantic diff) ----------

export type ClaimVerdict = "match" | "conflict" | "undeclared" | "ungoverned";

export type ClaimRow = {
	claim: Claim;
	verdict: ClaimVerdict;
	/** The accepted facet value the claim is judged against (null when nothing governs it). */
	accepted: FacetValue | null;
	acceptedRef: string | null;
	/** The claim cites a version that is no longer current. */
	superseded: boolean;
	note: string | null;
};

export type SemanticDiff = {
	rows: ClaimRow[];
	/** Facets the item depends on that no claim covers. */
	unclaimed: { recordId: string; facetKey: string; accepted: FacetValue | null }[];
	claimsStatus: "ok" | "missing" | "malformed" | "none";
	error: string | null;
};

export function semanticDiff(view: ViewState, wi: WorkItemState, analysis: Analysis): SemanticDiff {
	const state = wi.claims;
	if (!state || state.headSha !== wi.headSha) return { rows: [], unclaimed: [], claimsStatus: "none", error: null };
	if (state.status !== "ok") return { rows: [], unclaimed: [], claimsStatus: state.status, error: state.error };

	const rows: ClaimRow[] = state.claims.map((claim) => {
		const ref = parseRecordRef(claim.basedOn);
		const current = ref ? currentRecord(view, ref.recordId) : null;
		const governed = current?.facets[claim.subject];
		const superseded = Boolean(ref && current && ref.version !== current.version);
		const accepted = governed === undefined ? null : governed;
		const acceptedRef = current ? `${current.recordId}@${current.version}` : null;
		const undeclared = ref ? analysis.outsideReceipt.some((o) => o.recordId === ref.recordId && o.subjects.includes(claim.subject)) : false;
		const conflict = analysis.conflicts.find((c) => c.subject === claim.subject && c.basedOn === claim.basedOn);
		if (undeclared) return { claim, verdict: "undeclared" as const, accepted, acceptedRef, superseded, note: `${ref?.recordId ?? "This record"} was not in the receipt and has no accepted dependency.` };
		if (conflict) return { claim, verdict: "conflict" as const, accepted, acceptedRef, superseded, note: conflict.reasonCodes.includes("SUPERSEDED_BASIS") && accepted !== null && facetValuesEqual(claim.value, accepted) ? "Right value, but built on a superseded version of a facet that changed." : null };
		if (accepted === null) return { claim, verdict: "ungoverned" as const, accepted, acceptedRef, superseded, note: "No accepted facet governs this subject." };
		return { claim, verdict: "match" as const, accepted, acceptedRef, superseded, note: superseded ? "Based on an older version, but this facet did not change." : null };
	});

	const covered = new Set(state.claims.map((c) => c.subject));
	const unclaimed: SemanticDiff["unclaimed"] = [];
	for (const dep of view.dependencies as Dependency[]) {
		if (dep.workItemId !== wi.item.id || dep.status !== "accepted") continue;
		const current = currentRecord(view, dep.recordId);
		const keys = dep.facetKeys.length > 0 ? dep.facetKeys : Object.keys(current?.facets ?? {});
		for (const facetKey of keys) {
			if (!covered.has(facetKey)) unclaimed.push({ recordId: dep.recordId, facetKey, accepted: current?.facets[facetKey] ?? null });
		}
	}
	return { rows, unclaimed, claimsStatus: "ok", error: null };
}

export function analysisOf(view: ViewState, workItemId: string): Analysis | null {
	if (!view.policy || !view.workItems[workItemId]) return null;
	return analyze(toCellState(view), workItemId, view.policy);
}

// ---------- ledger lines ----------

export type LedgerSummary = {
	label: string;
	detail: string;
	workItemId: string | null;
	reasonCodes: ReasonCode[];
	/** Every effect was NO_ACTION and there is a reason worth reading (the typo beat: NO_ACTION, PROSE_ONLY). */
	noAction: boolean;
	/** All distinct effect types, for a tooltip. */
	effectTypes: string[];
	/** Tooltip for the label, where the label needs an honest qualifier. */
	hint?: string;
};

export function summarizeLedgerLine(entry: ReconciliationEvent): LedgerSummary {
	const base = describeLine(entry);
	const effects = entry.payload.effects;
	const noAction = effects.length > 0 && effects.every((effect) => effect.type === "NO_ACTION") && base.reasonCodes.length > 0;
	return { ...base, noAction, effectTypes: [...new Set(effects.map((effect) => effect.type))] };
}

function describeLine(entry: ReconciliationEvent): Omit<LedgerSummary, "noAction" | "effectTypes"> {
	const event = entry.payload.event;
	// OBSERVATION_ONLY means "nothing to report": not worth a chip.
	const reasons = [...new Set(entry.payload.effects.flatMap((effect) => effect.reasonCodes))].filter((code) => code !== "OBSERVATION_ONLY");
	switch (event.type) {
		case "BaselinePushed": {
			const rec = event.records[0];
			return { label: "Baseline push", detail: rec ? `${rec.recordId} v${rec.version}` : "no context change", workItemId: null, reasonCodes: reasons };
		}
		case "WorkItemRegistered":
			return { label: "Work registered", detail: event.item.title, workItemId: event.item.id, reasonCodes: [] };
		case "ForkPushed":
			return { label: "Fork push", detail: event.commitSha.slice(0, 7), workItemId: event.workItemId, reasonCodes: reasons };
		case "EvidenceRecorded":
			const notTest = describeCheck(event.evidence);
			if (notTest) {
				const check = event.evidence.check.split("/").pop() ?? event.evidence.check;
				return { label: notTest.label, hint: notTest.hint, detail: event.evidence.pass ? check : `failed: ${check}`, workItemId: event.evidence.workItemId, reasonCodes: reasons };
			}
			return { label: event.evidence.pass ? "Check passed" : "Check failed", detail: event.evidence.check.split("/").pop() ?? event.evidence.check, workItemId: event.evidence.workItemId, reasonCodes: reasons };
		case "DependencyDecided":
			return { label: `Dependency ${event.decision}`, detail: event.recordId, workItemId: event.workItemId, reasonCodes: reasons };
		case "ReceiptIssued":
			return { label: "Receipt issued", detail: `${event.receipt.accepted.length} records`, workItemId: event.workItemId, reasonCodes: reasons };
		case "ResolutionRecorded":
			return { label: `Resolution: ${event.resolution.kind}`, detail: event.resolution.rationale, workItemId: event.resolution.workItemId, reasonCodes: reasons };
		case "PromotionRequested":
			return { label: "Promotion requested", detail: event.forkHeadSha.slice(0, 7), workItemId: event.workItemId, reasonCodes: reasons };
		case "PromotionMerged":
			return { label: "Promotion merged", detail: event.mergeCommitSha.slice(0, 7), workItemId: event.workItemId, reasonCodes: reasons };
		case "AgentRunStarted":
			return { label: "Agent run started", detail: event.runId, workItemId: event.workItemId, reasonCodes: [] };
		case "AgentRunFinished":
			// The Worker writes this when a dispatch failed before any run existed. No agent ran, so it must not read as a run.
			if (event.runId.startsWith("dispatch-failed:")) {
				return {
					label: "Agent dispatch failed before the run started",
					hint: "No agent run was started. The Worker released the revalidation so it can be requested again.",
					detail: "revalidation released",
					workItemId: event.workItemId,
					reasonCodes: [],
				};
			}
			return { label: `Agent run ${event.outcome}`, detail: event.runId, workItemId: event.workItemId, reasonCodes: [] };
	}
}

// ---------- people ----------

/** A display name for an actor id: the demo human, a known work-item actor, else the id itself. */
export function actorLabel(view: ViewState, actorId: string | null | undefined): string {
	if (!actorId) return "nobody";
	if (view.policy && Object.values(view.policy.authority).includes(actorId)) return DEMO_IDENTITY.label;
	for (const wi of Object.values(view.workItems)) {
		if (wi.item.actor.id === actorId) return wi.item.actor.displayName;
	}
	return actorId;
}

// ---------- context history ----------

export type ProseEdit = { seq: number; ts: string; version: number };

/** Prose-only edits to a record: pushes the reconciler answered with PROSE_ONLY. */
export function proseEdits(view: ViewState, recordId: string): ProseEdit[] {
	const edits: ProseEdit[] = [];
	for (const entry of view.ledger) {
		const event = entry.payload.event;
		if (event.type !== "BaselinePushed") continue;
		const rec = event.records.find((r) => r.recordId === recordId);
		if (rec && entry.payload.effects.some((effect) => effect.reasonCodes.includes("PROSE_ONLY") && (!("recordId" in effect) || effect.recordId === recordId))) {
			edits.push({ seq: entry.seq, ts: entry.ts, version: rec.version });
		}
	}
	return edits;
}

// ---------- items that were left alone ----------

export type LeftAlone = { seq: number; ts: string; recordRef: string | null; reasonCodes: ReasonCode[]; message: string };

/**
 * The most recent context change that was evaluated against this item and deliberately left it
 * alone (rule R2), unless something later touched it again.
 */
export function leftAlone(view: ViewState, workItemId: string, options: { sticky?: boolean } = {}): LeftAlone | null {
	for (const entry of [...view.ledger].reverse()) {
		const event = entry.payload.event;
		const about = entry.payload.effects.filter((effect) => "workItemId" in effect && effect.workItemId === workItemId);
		if (about.length === 0) continue;
		const quiet = about.find((effect) => effect.type === "NO_ACTION" && effect.reasonCodes.includes("NO_DEPENDENCY_ON_CHANGED_FACETS"));
		if (event.type === "BaselinePushed" && quiet && quiet.type === "NO_ACTION") {
			const rec = event.records[0];
			return { seq: entry.seq, ts: entry.ts, recordRef: rec ? `${rec.recordId}@${rec.version}` : null, reasonCodes: quiet.reasonCodes, message: quiet.message ?? "Left alone." };
		}
		// A later effect on this item (a push, a check, a resolution) supersedes the old note.
		if (!options.sticky && about.some((effect) => effect.type !== "NO_ACTION" || !effect.reasonCodes.includes("OBSERVATION_ONLY"))) return null;
	}
	return null;
}

/** Facet keys a work item relies on for one record (empty means "the whole record"). */
export function reliedFacets(view: ViewState, workItemId: string, recordId: string): string[] | null {
	const dep = view.dependencies.find((d) => d.workItemId === workItemId && d.recordId === recordId && d.status === "accepted");
	return dep ? dep.facetKeys : null;
}

// ---------- the receipt, facet by facet ----------

export type ReceiptFacetStatus = "unchanged" | "changed" | "removed";

export type ReceiptFacetRow = {
	key: string;
	/** The value the work item was handed. */
	handed: FacetValue;
	status: ReceiptFacetStatus;
	/** The accepted value now, when it differs from what was handed (null when the facet was removed). */
	now: FacetValue | null;
	/** The work item relies on this facet (an accepted dependency names it, or names the whole record). */
	relied: boolean;
};

export type ReceiptFacets = {
	/** The version the receipt names, as the cell recorded it. Null when the snapshot does not carry that version. */
	held: RecordSnapshot | null;
	current: RecordSnapshot | null;
	rows: ReceiptFacetRow[];
	/** Facets that exist now but did not when the receipt was issued. */
	added: { key: string; now: FacetValue }[];
};

/**
 * The named facets a receipt entry handed to the work item, each marked against the current
 * accepted version. Uses only the record histories already in the snapshot.
 */
export function receiptFacets(view: ViewState, wi: WorkItemState, entry: ReceiptEntry): ReceiptFacets {
	const held = view.records[entry.recordId]?.versions[String(entry.version)] ?? null;
	const current = currentRecord(view, entry.recordId);
	if (!held) return { held, current, rows: [], added: [] };
	const relied = reliedFacets(view, wi.item.id, entry.recordId);
	const changes = current && current.version !== held.version ? diffFacets(held, current) : [];
	const byKey = new Map(changes.map((change) => [change.key, change]));
	const rows = Object.keys(held.facets)
		.sort()
		.map((key): ReceiptFacetRow => {
			const change = byKey.get(key);
			const isRelied = relied === null ? false : relied.length === 0 || relied.includes(key);
			const handed = held.facets[key] as FacetValue;
			if (!change) return { key, handed, status: "unchanged", now: null, relied: isRelied };
			if (change.kind === "removed") return { key, handed, status: "removed", now: null, relied: isRelied };
			return { key, handed, status: "changed", now: (change.to ?? null) as FacetValue | null, relied: isRelied };
		});
	const added = changes.filter((change) => change.kind === "added").map((change) => ({ key: change.key, now: change.to as FacetValue }));
	return { held, current, rows, added };
}

// ---------- accepted exceptions ----------

export type ExceptionStatus =
	| { lapsed: false; version: number }
	| { lapsed: true; version: number; reason: string; reasonCode: "EXCEPTION_LAPSED" };

/**
 * An accept-exception is bound to the record version it was granted against (rule R7). It is valid
 * while that record is still at that version and the fork head has not moved; the next accepted
 * version lapses it, and the gate then blocks with EXCEPTION_LAPSED. Same classification the gate uses.
 */
export function exceptionStatus(view: ViewState, wi: WorkItemState, resolution: Resolution): ExceptionStatus | null {
	if (resolution.kind !== "accept-exception" || !view.policy) return null;
	const { binding } = resolution;
	const state = toCellState(view);
	const { lapsed } = classifyExceptions(state, wi, view.policy);
	if (!lapsed.includes(resolution)) return { lapsed: false, version: binding.version };
	const now = view.records[binding.recordId]?.current ?? null;
	const reason =
		now !== null && now !== binding.version
			? `${binding.recordId} moved from v${binding.version} to v${now}.`
			: binding.forkHeadSha !== wi.headSha
				? "The fork head moved after the exception was granted."
				: resolution.actor.kind !== "human" || authorityFor(state, view.policy, binding.recordId) !== resolution.actor.id
					? `The granting actor is no longer the authority for ${binding.recordId}.`
					: "It no longer applies.";
	return { lapsed: true, version: binding.version, reason, reasonCode: "EXCEPTION_LAPSED" };
}

// ---------- the one-reason card ----------

/** Who signs off on a record: the display label of its authority (the policy's, else the record's own). Null when nobody is named. */
export function signerFor(view: ViewState, recordId: string): string | null {
	if (!view.policy) return null;
	const id = authorityFor(toCellState(view), view.policy, recordId);
	return id ? actorLabel(view, id) : null;
}

export type ChangedSetting = {
	recordId: string;
	key: string;
	/** The last part of the key, read as words: `id_required` is "id required". */
	label: string;
	kind: "changed" | "added" | "removed";
	from: FacetValue | null;
	to: FacetValue | null;
	fromVersion: number;
	toVersion: number;
};

/** A facet key as a person reads it: `notifications.default` is "default", `id_required` is "id required". */
export function settingLabel(key: string): string {
	return (key.split(".").pop() ?? key).replace(/[_-]+/g, " ");
}

/**
 * The settings this work was built on that have since changed: for each stale finding, the facets
 * of the version in its receipt that differ from the version now accepted. Only the settings the
 * work relies on count (the finding already lists them), the same rule the engine applied.
 */
export function changedSettings(view: ViewState, analysis: Analysis): ChangedSetting[] {
	const out: ChangedSetting[] = [];
	for (const finding of analysis.stale) {
		const held = view.records[finding.recordId]?.versions[String(finding.fromVersion)] ?? null;
		const head = currentRecord(view, finding.recordId);
		if (!held || !head) continue;
		for (const change of diffFacets(held, head)) {
			if (finding.facetKeys.length > 0 && !finding.facetKeys.includes(change.key)) continue;
			out.push({
				recordId: finding.recordId,
				key: change.key,
				label: settingLabel(change.key),
				kind: change.kind,
				from: change.from ?? null,
				to: change.to ?? null,
				fromVersion: finding.fromVersion,
				toVersion: finding.toVersion,
			});
		}
	}
	return out;
}

const VALUE_CHARS = 60;

function say(value: FacetValue | null): string {
	const text = Array.isArray(value) ? `[${value.join(", ")}]` : value === null ? "nothing" : String(value);
	return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS - 1).trimEnd()}…` : text;
}

/**
 * One plain sentence per reason an item is blocked: each changed setting it was built on, then a failing
 * check or an unknown. The reason codes stay behind "Technical details"; this is what a person reads.
 */
export function reasonSentences(view: ViewState, analysis: Analysis): string[] {
	const sentences: string[] = [];
	const covered = new Set<string>();
	for (const s of changedSettings(view, analysis)) {
		covered.add(s.recordId);
		if (s.kind === "changed") sentences.push(`Built on the old ${s.label} (${say(s.from)}). The decision now says ${say(s.to)}.`);
		else if (s.kind === "added") sentences.push(`The decision added a ${s.label} setting (${say(s.to)}) after this work was built.`);
		else sentences.push(`The decision dropped the ${s.label} setting (it was ${say(s.from)}).`);
	}
	// A stale finding with no setting to name (whole-record staleness, or a version the console never held).
	for (const finding of analysis.stale) {
		if (!covered.has(finding.recordId)) sentences.push(`Built on ${finding.recordId} v${finding.fromVersion}. ${finding.recordId} is now v${finding.toVersion}.`);
	}
	if (analysis.failedChecks.length > 0) sentences.push(`A check on this work is failing: ${analysis.failedChecks.map((c) => c.split("/").pop() ?? c).join(", ")}.`);
	for (const finding of analysis.uncertain.slice(0, 2)) sentences.push(finding.message);
	return sentences;
}

/** "Built on notifications v1 · now v2": one stamp per record this work is stale against. */
export function builtOnStamps(analysis: Analysis): string[] {
	return analysis.stale.map((f) => (f.fromVersion === 0 ? `Built without ${f.recordId} · now v${f.toVersion}` : `Built on ${f.recordId} v${f.fromVersion} · now v${f.toVersion}`));
}

/** The record to name the signer for: the first one this work is stale or in conflict against, else the first it relies on. */
export function signerRecordId(view: ViewState, workItemId: string, analysis: Analysis): string | null {
	const first = analysis.stale[0]?.recordId ?? analysis.conflicts[0]?.recordId ?? analysis.uncertain.find((u) => u.recordId)?.recordId ?? null;
	if (first) return first;
	return view.dependencies.find((d) => d.workItemId === workItemId && d.status === "accepted")?.recordId ?? null;
}

/** True when the rules found something actually wrong: stale, a conflict, a failing check or an unknown. Not merely "not finished". */
export function hasProblem(analysis: Analysis): boolean {
	return analysis.stale.length > 0 || analysis.conflicts.length > 0 || analysis.failedChecks.length > 0 || analysis.uncertain.length > 0;
}

// ---------- what an exception waives ----------

export type ExceptionWaiver = {
	recordId: string;
	/** The record's own validation check, which an exception on it waives (R5). Null when the record names none. */
	check: string | null;
	/** That check is failing at the work's current head, so the waiver actually lets a failure through. */
	failing: boolean;
	signer: string | null;
};

/** What `accept-exception` on one record would waive for this work item, from the same facts the gate uses. */
export function exceptionWaiver(view: ViewState, analysis: Analysis, recordId: string): ExceptionWaiver {
	const check = currentRecord(view, recordId)?.validation ?? null;
	return { recordId, check, failing: check !== null && analysis.failedChecks.includes(check), signer: signerFor(view, recordId) };
}

// ---------- the results strip, kept current ----------

/** Work that is still blocked on a change: stale, in conflict, unknown, or being re-run. Merged, ready, up to date and rejected work is not. */
export function stillBlocked(wi: WorkItemState | undefined): boolean {
	return wi !== undefined && ["stale", "conflict", "uncertain", "revalidating"].includes(wi.item.status);
}

/**
 * The last evaluation's counts, brought up to date with what has happened since: of the work the change
 * made stale, how many still are, and how many have been merged, revalidated or ruled on in the meantime.
 */
export function currentEvaluation(view: ViewState): (Evaluation & { resolved: number }) | null {
	const evaluation = view.evaluation;
	if (!evaluation) return null;
	const still = (ids: readonly string[]) => ids.filter((id) => stillBlocked(view.workItems[id])).length;
	const stale = still(evaluation.staleIds);
	const alreadyStale = still(evaluation.alreadyStaleIds);
	return {
		...evaluation,
		stale,
		alreadyStale,
		resolved: evaluation.stale - stale + (evaluation.alreadyStale - alreadyStale),
	};
}
