import type { Condition, Effect, ReasonCode } from "contracts";

export function noAction(reasonCodes: ReasonCode[], extra: { workItemId?: string; recordId?: string; message?: string } = {}): Effect {
	return { type: "NO_ACTION", reasonCodes, ...extra };
}

/**
 * Turn changed conditions into effects: every change is recorded, and the ones that need a
 * human or stop a merge also ask for it. Pure mapping, no judgement.
 */
export function effectsForChanges(changed: Condition[]): Effect[] {
	const effects: Effect[] = [];
	for (const condition of changed) {
		const { workItemId, reasonCodes } = condition;
		effects.push({ type: "RECORD_CONDITION", workItemId, condition, reasonCodes });
		switch (condition.type) {
			case "Stale":
			case "ClaimConflict":
				effects.push({ type: "REQUEST_REVIEW", workItemId, message: condition.message, reasonCodes });
				break;
			case "Uncertain":
				if (reasonCodes.includes("UNDECLARED_DEP") || reasonCodes.includes("CROSS_CLAIM_CONFLICT")) {
					effects.push({ type: "REQUEST_REVIEW", workItemId, message: condition.message, reasonCodes });
				}
				break;
			case "Blocked":
				effects.push({ type: "BLOCK_PROMOTION", workItemId, reasonCodes });
				break;
			default:
				break;
		}
	}
	return effects;
}
