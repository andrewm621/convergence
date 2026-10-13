import { canonicalJson, type CellState, type Condition, type ConditionType, type Policy, type ReasonCode, type WorkItemState, type WorkItemStatus } from "contracts";
import { analyze, type Analysis } from "./analysis";
import { isRejected } from "./cell-state";
import { gateFrom, isBlockingReason, type GateVerdict } from "./gate";

const ORDER: ConditionType[] = ["Fresh", "Stale", "Uncertain", "ClaimConflict", "TestFailed", "TestsPassed", "Blocked", "Ready", "Promoted"];

function uniq<T>(items: T[]): T[] {
	return [...new Set(items)];
}

/** Derive the full condition set for a work item from the facts. Pure and level-triggered. */
export function buildConditions(wi: WorkItemState, analysis: Analysis, gate: GateVerdict, ts: string): Condition[] {
	const id = wi.item.id;
	const make = (type: ConditionType, reasonCodes: ReasonCode[], message: string, recordRefs: string[] = [], facetKeys: string[] = []): Condition => ({
		type,
		workItemId: id,
		reasonCodes: uniq(reasonCodes),
		recordRefs: uniq(recordRefs).sort(),
		facetKeys: uniq(facetKeys).sort(),
		message,
		observedAt: ts,
	});

	if (wi.item.status === "promoted") return [make("Promoted", [], "Promoted into the baseline.")];

	const out: Condition[] = [];
	if (analysis.stale.length === 0) {
		out.push(make("Fresh", [], "The receipt matches the accepted facets this work depends on."));
	} else {
		out.push(
			make(
				"Stale",
				analysis.stale.flatMap((f) => f.reasonCodes),
				analysis.stale.map((f) => `Built on ${f.recordId}@${f.fromVersion}; accepted is v${f.toVersion}${f.facetKeys.length ? `. Changed: ${f.facetKeys.join(", ")}` : ""}.`).join(" "),
				analysis.stale.map((f) => `${f.recordId}@${f.fromVersion}`),
				analysis.stale.flatMap((f) => f.facetKeys),
			),
		);
	}
	if (analysis.uncertain.length > 0) {
		out.push(
			make(
				"Uncertain",
				analysis.uncertain.flatMap((f) => f.reasonCodes),
				analysis.uncertain.map((f) => f.message).join(" "),
				analysis.uncertain.flatMap((f) => (f.recordId ? [f.recordId] : [])),
				analysis.uncertain.flatMap((f) => f.subjects),
			),
		);
	}
	if (analysis.conflicts.length > 0) {
		out.push(
			make(
				"ClaimConflict",
				analysis.conflicts.flatMap((f) => f.reasonCodes),
				analysis.conflicts.map((f) => f.message).join(" "),
				analysis.conflicts.map((f) => f.basedOn),
				analysis.conflicts.map((f) => f.subject),
			),
		);
	}
	if (analysis.failedChecks.length > 0) out.push(make("TestFailed", ["TEST_FAILED"], `Failing at the current head: ${analysis.failedChecks.join(", ")}.`));
	if (analysis.testsPassed) out.push(make("TestsPassed", ["TESTS_PASSED"], `Passing at the current head: ${analysis.testEvidence.map((e) => e.check).join(", ")}.`));
	if (!gate.promotable && gate.reasonCodes.some(isBlockingReason)) out.push(make("Blocked", gate.reasonCodes, gate.blockers.join(" ")));
	if (gate.promotable) out.push(make("Ready", [], "Fresh and every requirement is met. A human may promote."));
	return out.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

/** The chip the console shows. Revalidating and rejected are explicit human states and win. */
export function deriveStatus(wi: WorkItemState, conditions: Condition[]): WorkItemStatus {
	const has = (type: ConditionType) => conditions.some((c) => c.type === type);
	if (has("Promoted")) return "promoted";
	if (wi.revalidating) return "revalidating";
	if (isRejected(wi)) return "rejected";
	// Ready means the gate passes, which already accounts for any exception that waives a conflict.
	if (has("Ready")) return "ready";
	if (has("ClaimConflict") || has("TestFailed")) return "conflict";
	if (has("Stale")) return "stale";
	if (has("Uncertain")) return "uncertain";
	if (wi.headSha === null) return "running";
	return "fresh";
}

function stable(condition: Condition): string {
	return canonicalJson({ ...condition, observedAt: undefined });
}

export type Refresh = {
	analysis: Analysis;
	gate: GateVerdict;
	/** Conditions that appeared or changed (candidates for RECORD_CONDITION). */
	changed: Condition[];
	statusBefore: WorkItemStatus;
};

/**
 * Recompute one work item's conditions and status in place (on a draft state). Unchanged
 * conditions keep their original `observedAt`, so a no-op refresh leaves the item byte-identical.
 */
export function refreshWorkItem(draft: CellState, workItemId: string, policy: Policy, ts: string): Refresh {
	const wi = draft.workItems[workItemId];
	if (!wi) throw new Error(`refreshWorkItem: unknown work item ${workItemId}`);
	const statusBefore = wi.item.status;
	const analysis = analyze(draft, workItemId, policy);
	const gate = gateFrom(draft, wi, policy, analysis);
	const next = buildConditions(wi, analysis, gate, ts);
	const before = new Map(wi.conditions.map((c) => [c.type, c]));
	const changed: Condition[] = [];
	wi.conditions = next.map((condition) => {
		const old = before.get(condition.type);
		if (old && stable(old) === stable(condition)) return old;
		changed.push(condition);
		return condition;
	});
	wi.item.status = deriveStatus(wi, wi.conditions);
	// An approval is only good while the gate still passes.
	if (wi.promotionApproval && !gate.promotable) wi.promotionApproval = null;
	return { analysis, gate, changed, statusBefore };
}
