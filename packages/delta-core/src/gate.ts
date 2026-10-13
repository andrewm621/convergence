import type { CellState, Policy, ReasonCode, Resolution, WorkItemState } from "contracts";
import { analyze, type Analysis } from "./analysis";
import { currentSnapshot, isPromoted, isRejected } from "./cell-state";

export type GateVerdict = {
	promotable: boolean;
	reasonCodes: ReasonCode[];
	/** Human-readable lines for the gate preview (`GET /work-items/:id/gate`). */
	blockers: string[];
	/** Exceptions that waived staleness or conflicts for this verdict. */
	waivedBy: Resolution[];
};

/** Reasons that mean "not finished yet" rather than "something is wrong". */
const INCOMPLETE: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["MISSING_EVIDENCE", "HUMAN_RESOLUTION_MISSING"]);

export function isBlockingReason(code: ReasonCode): boolean {
	return !INCOMPLETE.has(code);
}

/** Who may grant exceptions against a record: the policy's authority, else the record's own. */
export function authorityFor(state: CellState, policy: Policy, recordId: string): string | null {
	return policy.authority[recordId] ?? currentSnapshot(state, recordId)?.authority ?? null;
}

/**
 * R7: an exception is valid only while it is still bound to what it was granted against. It
 * lapses when its record gets a new accepted version, when the fork head moves, or when the
 * granting actor stops being the record's authority.
 */
export function classifyExceptions(state: CellState, wi: WorkItemState, policy: Policy): { valid: Resolution[]; lapsed: Resolution[] } {
	const valid: Resolution[] = [];
	const lapsed: Resolution[] = [];
	for (const resolution of wi.resolutions) {
		if (resolution.kind !== "accept-exception") continue;
		const { binding } = resolution;
		const current = state.records[binding.recordId]?.current ?? null;
		const stillBound = current === binding.version && binding.forkHeadSha === wi.headSha;
		const authorised = resolution.actor.kind === "human" && authorityFor(state, policy, binding.recordId) === resolution.actor.id;
		(stillBound && authorised ? valid : lapsed).push(resolution);
	}
	return { valid, lapsed };
}

function humanResolved(wi: WorkItemState, validExceptions: Resolution[]): boolean {
	if (validExceptions.length > 0) return true;
	// A recorded revalidation is a human decision about this item; it stays on record after the re-run.
	return wi.resolutions.some((r) => r.kind === "revalidate" && r.actor.kind === "human") && !isRejected(wi);
}

/**
 * R5: promotable only if Fresh and every required check passed at the current head, or a bound
 * accept-exception from the record's authority covers the stale or conflicted records.
 * Anything unknown blocks. This is a dry run: it changes nothing.
 */
export function gateFrom(state: CellState, wi: WorkItemState, policy: Policy, analysis: Analysis): GateVerdict {
	const reasons = new Set<ReasonCode>();
	const blockers: string[] = [];
	const block = (code: ReasonCode, message: string) => {
		reasons.add(code);
		blockers.push(message);
	};

	if (isPromoted(wi)) return { promotable: false, reasonCodes: ["ALREADY_PROMOTED"], blockers: ["Already promoted."], waivedBy: [] };
	if (isRejected(wi)) block("RESOLUTION_REJECTED", "A human rejected this work.");
	if (wi.revalidating) block("REVALIDATION_PENDING", "Revalidation is in progress; waiting for the agent's next push.");
	if (wi.headSha === null) block("MISSING_EVIDENCE", "Nothing has been pushed yet.");

	const { valid, lapsed } = classifyExceptions(state, wi, policy);
	const excepted = new Set(valid.map((r) => r.binding.recordId));
	const waivable = new Set([...analysis.stale.map((f) => f.recordId), ...analysis.conflicts.map((f) => f.recordId)]);
	const uncovered = [...waivable].filter((id) => !excepted.has(id));
	const waiverApplies = waivable.size > 0 && uncovered.length === 0;

	for (const finding of analysis.stale) {
		if (excepted.has(finding.recordId)) continue;
		block("STALE_RECEIPT", `Built on ${finding.recordId}@${finding.fromVersion}; current is v${finding.toVersion}${finding.facetKeys.length ? ` (${finding.facetKeys.join(", ")} changed)` : ""}.`);
		if (finding.reasonCodes.includes("FACET_CHANGED")) reasons.add("FACET_CHANGED");
	}
	for (const finding of analysis.conflicts) {
		if (excepted.has(finding.recordId)) continue;
		block("CLAIM_CONFLICT", finding.message);
		for (const code of finding.reasonCodes) reasons.add(code);
	}
	if (uncovered.some((id) => lapsed.some((r) => r.binding.recordId === id))) block("EXCEPTION_LAPSED", "An accept-exception no longer applies: its record or the fork head has moved on.");
	for (const finding of analysis.uncertain) {
		for (const code of finding.reasonCodes) reasons.add(code);
		blockers.push(finding.message);
	}

	// A fork that edits context/** is never promotable: agents propose context changes, they do not carry them in through a merge.
	// No exception waives this; the change has to go through the baseline and its authority.
	const editsContext = wi.contextPaths ?? [];
	if (editsContext.length > 0) block("FORK_EDITS_CONTEXT", `This fork changes accepted context (${editsContext.join(", ")}). Propose that change on the baseline instead.`);

	// An exception waives the excepted record's own validation check and nothing else: other records' checks still have to pass.
	const waivedChecks = new Set<string>();
	for (const resolution of valid) {
		if (!waivable.has(resolution.binding.recordId)) continue;
		const validation = currentSnapshot(state, resolution.binding.recordId)?.validation;
		if (validation) waivedChecks.add(validation);
	}
	const failed = analysis.failedChecks.filter((check) => !waivedChecks.has(check));
	if (failed.length > 0) block("TEST_FAILED", `Failing at the current head: ${failed.join(", ")}.`);
	const required = new Set([...policy.requires, ...wi.item.requires]);
	if (required.has("contract-test")) {
		const passing = (check: string) => analysis.testEvidence.some((e) => e.check === check && e.pass);
		const needed = analysis.requiredChecks.filter((check) => !waivedChecks.has(check));
		const missing = needed.filter((check) => !passing(check) && !failed.includes(check));
		if (missing.length > 0) block("MISSING_EVIDENCE", `No passing evidence at the current head for: ${missing.join(", ")}.`);
		else if (analysis.requiredChecks.length === 0 && waivedChecks.size === 0 && analysis.testEvidence.length === 0) block("MISSING_EVIDENCE", "No contract-test evidence at the current head.");
	}
	if (required.has("human-resolution") && !humanResolved(wi, valid)) block("HUMAN_RESOLUTION_MISSING", "A human resolution is required.");

	return {
		promotable: reasons.size === 0,
		reasonCodes: [...reasons],
		blockers,
		waivedBy: waiverApplies ? valid.filter((r) => waivable.has(r.binding.recordId)) : [],
	};
}

/** Dry-run the promotion gate for one work item at the state's current heads. */
export function evaluateGate(state: CellState, workItemId: string, policy: Policy): GateVerdict {
	const wi = state.workItems[workItemId];
	if (!wi) return { promotable: false, reasonCodes: ["UNKNOWN_WORK_ITEM"], blockers: ["Unknown work item."], waivedBy: [] };
	return gateFrom(state, wi, policy, analyze(state, workItemId, policy));
}
