import { compareStrings, type CellState, type ConditionType, type DeltaEvent, type Policy, type ReasonCode, type WorkItemStatus } from "contracts";
import { workItemIds } from "./cell-state";
import { reconcile } from "./reconcile";

/**
 * whatIf: dry-run hypothetical accepted-context changes through the real `reconcile`.
 *
 *   whatIf(state: CellState, policy: Policy, candidates: readonly WhatIfCandidate[]): WhatIfOutcome[]
 *
 * A candidate is a `BaselinePushed` event (a new accepted record version) that has not happened. Each one is
 * reconciled on its own against the same `state`, so candidates never see each other. Nothing is committed, the
 * input is never mutated, and the result is plain data: the same arguments always give the same answer.
 * The `change` must carry a `commitSha` the cell has not processed yet, or reconcile answers DUPLICATE_EVENT.
 *
 * Per candidate you get every work item's resulting `status`, whether it is `blocked` (stale, conflict,
 * uncertain or revalidating, the console's `stillBlocked`), and the reason codes behind the block. Commit the
 * same `change` for real and `reconcile` yields these same statuses and reasons.
 *
 *   const outcomes = whatIf(toCellState(view), policy, [{ id: "opt-in", change: baselinePushedEvent }]);
 *   outcomes[0]?.blockedIds; // ["WI-2"]
 *   outcomes[0]?.items.find((i) => i.workItemId === "WI-2"); // { status: "stale", blocked: true, reasonCodes: ["STALE_RECEIPT", ...], ... }
 */

export type BaselineChange = Extract<DeltaEvent, { type: "BaselinePushed" }>;

export type WhatIfCandidate = {
	/** Caller's key for this candidate; echoed back as `candidateId`. */
	id: string;
	change: BaselineChange;
};

export type WhatIfItem = {
	workItemId: string;
	/** Status before the change. */
	statusBefore: WorkItemStatus;
	/** Status after the change. */
	status: WorkItemStatus;
	blocked: boolean;
	/** Why it is blocked, sorted. Empty when it is not. */
	reasonCodes: ReasonCode[];
};

export type WhatIfOutcome = {
	candidateId: string;
	/** Every work item in the cell, sorted by id. */
	items: WhatIfItem[];
	blockedIds: string[];
	blockedCount: number;
	/** Reasons the change itself was handled a certain way (FORBIDDEN_ACTOR, VERSION_NOT_NEWER, PROSE_ONLY, DUPLICATE_EVENT...). Sorted. */
	changeReasonCodes: ReasonCode[];
};

const BLOCKED_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(["stale", "conflict", "uncertain", "revalidating"]);
const BLOCKING_CONDITIONS: ReadonlySet<ConditionType> = new Set<ConditionType>(["Stale", "Uncertain", "ClaimConflict", "TestFailed", "Blocked"]);

function sortedUnique(codes: Iterable<ReasonCode>): ReasonCode[] {
	return [...new Set(codes)].sort(compareStrings);
}

export function whatIf(state: CellState, policy: Policy, candidates: readonly WhatIfCandidate[]): WhatIfOutcome[] {
	return candidates.map((candidate) => {
		const { state: next, effects } = reconcile(state, candidate.change, policy);
		const items = workItemIds(next).map((workItemId): WhatIfItem => {
			const wi = next.workItems[workItemId]!;
			const blocked = BLOCKED_STATUSES.has(wi.item.status);
			return {
				workItemId,
				statusBefore: state.workItems[workItemId]?.item.status ?? wi.item.status,
				status: wi.item.status,
				blocked,
				reasonCodes: blocked ? sortedUnique(wi.conditions.filter((c) => BLOCKING_CONDITIONS.has(c.type)).flatMap((c) => c.reasonCodes)) : [],
			};
		});
		const blockedIds = items.filter((item) => item.blocked).map((item) => item.workItemId);
		const changeReasonCodes = sortedUnique(effects.filter((e) => !("workItemId" in e) || e.workItemId === undefined).flatMap((e) => e.reasonCodes));
		return { candidateId: candidate.id, items, blockedIds, blockedCount: blockedIds.length, changeReasonCodes };
	});
}
