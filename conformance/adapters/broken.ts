/**
 * Deliberately broken implementations, to prove the vectors tell a conforming engine from a non-conforming one.
 * Each mode wraps the reference engine and reproduces one class of bug. Never use this for anything else.
 *
 *   node --import ./ts-hooks.mjs adapters/broken.ts <mode>
 *
 *   ignore-staleness    never tracks staleness: no Stale condition, no STALE_RECEIPT or FACET_CHANGED anywhere (R1).
 *   promote-superseded  the gate forgets receipts: a promotion blocked by staleness alone is allowed (R5, R7).
 *   skip-dedupe         no idempotency table: every event is applied as if new (R9).
 */
import type { CellState, DeltaEvent, Effect, Policy, ReasonCode } from "contracts";
import { reconcile } from "delta-core";
import { serve, type Reconciler } from "./reference.ts";

const STALENESS: ReasonCode[] = ["STALE_RECEIPT", "FACET_CHANGED"];

function ignoreStaleness(state: CellState, event: DeltaEvent, policy: Policy): { state: CellState; effects: Effect[] } {
	const result = reconcile(state, event, policy);
	const next = structuredClone(result.state);
	for (const wi of Object.values(next.workItems)) {
		wi.conditions = wi.conditions.filter((c) => c.type !== "Stale").map((c) => ({ ...c, reasonCodes: c.reasonCodes.filter((r) => !STALENESS.includes(r)) }));
	}
	const effects = result.effects
		.filter((e) => !(e.type === "RECORD_CONDITION" && e.condition.type === "Stale"))
		.filter((e) => !(e.type === "REQUEST_REVIEW" && e.reasonCodes.every((r) => STALENESS.includes(r))))
		.map((e) => ({ ...e, reasonCodes: e.reasonCodes.filter((r) => !STALENESS.includes(r)) }));
	return { state: next, effects };
}

function promoteSuperseded(state: CellState, event: DeltaEvent, policy: Policy): { state: CellState; effects: Effect[] } {
	const result = reconcile(state, event, policy);
	if (event.type !== "PromotionRequested") return result;
	const blocked = result.effects.find((e) => e.type === "BLOCK_PROMOTION");
	if (!blocked || !blocked.reasonCodes.every((r) => STALENESS.includes(r))) return result;
	const next = structuredClone(result.state);
	const wi = next.workItems[event.workItemId];
	if (!wi || wi.headSha === null) return result;
	wi.promotionApproval = { forkHeadSha: wi.headSha, baselineCommit: next.baselineCommit, requestId: event.requestId };
	return {
		state: next,
		effects: [...result.effects.filter((e) => e !== blocked), { type: "ALLOW_PROMOTION", workItemId: event.workItemId, forkHeadSha: wi.headSha, baselineCommit: next.baselineCommit, reasonCodes: [] }],
	};
}

function skipDedupe(state: CellState, event: DeltaEvent, policy: Policy): { state: CellState; effects: Effect[] } {
	const result = reconcile({ ...state, processed: {} }, event, policy);
	return { state: { ...result.state, processed: { ...state.processed, ...result.state.processed } }, effects: result.effects };
}

const MODES: Record<string, Reconciler> = { "ignore-staleness": ignoreStaleness, "promote-superseded": promoteSuperseded, "skip-dedupe": skipDedupe };

if (import.meta.main) {
	const mode = process.argv[2] ?? "";
	const reconciler = MODES[mode];
	if (!reconciler) {
		process.stderr.write(`unknown mode "${mode}"; expected one of ${Object.keys(MODES).join(", ")}\n`);
		process.exit(2);
	}
	await serve(reconciler);
}
