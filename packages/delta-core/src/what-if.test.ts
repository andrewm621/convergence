import type { CellState, DeltaEvent, Policy, ReasonCode } from "contracts";
import { describe, expect, it } from "vitest";
import { createCellState } from "./cell-state";
import { reconcile } from "./reconcile";
import { deepFreeze } from "./testing/deep-freeze";
import { createCell } from "./testing/harness";
import { baselinePush, notifications as n, variant } from "./testing/scenarios";
import { whatIf, type BaselineChange, type WhatIfCandidate } from "./what-if";

function asChange(event: DeltaEvent): BaselineChange {
	if (event.type !== "BaselinePushed") throw new Error(`expected BaselinePushed, got ${event.type}`);
	return event;
}

/** The notifications scenario with both work items registered and pushed: WI-1 relies on status-model, WI-2 on notifications and status.values. */
const setup = [n.events.registerWi1, n.events.registerWi2, n.events.wi1Pushed, n.events.wi2PushedV1];

function buildState(): CellState {
	return setup.reduce((state, event) => reconcile(state, event, n.policy).state, createCellState(n.seed));
}

const statusModel = n.docs.statusModelV1.snapshot;
/** status-model v2 with `status.transitions` changed: WI-1 relies on it, WI-2 does not. */
const transitionsChange = asChange(baselinePush("notifications-baseline", [variant(statusModel, { version: 2, facets: { ...statusModel.facets, "status.transitions": "any-order" } })]));
/** status-model v2 with `status.values` changed: both items rely on it. */
const valuesChange = asChange(baselinePush("notifications-baseline", [variant(statusModel, { version: 2, facets: { ...statusModel.facets, "status.values": ["draft", "done"] } })]));
const notificationsChange = asChange(n.events.v2);

const candidates: WhatIfCandidate[] = [
	{ id: "notifications-v2", change: notificationsChange },
	{ id: "transitions", change: transitionsChange },
	{ id: "values", change: valuesChange },
];

describe("what-if: dry-run of candidate decisions through the real engine", () => {
	it("what-if equals the real commit result", async () => {
		const reported = whatIf(buildState(), n.policy, candidates);
		expect(reported.map((o) => o.candidateId)).toEqual(candidates.map((c) => c.id));

		for (const candidate of candidates) {
			// A real cell: the same history through the engine, then the same change committed for real.
			const cell = await createCell(n.seed, n.policy);
			for (const event of setup) await cell.send(event);
			await cell.send(candidate.change);
			const real = await cell.state();

			const outcome = reported.find((o) => o.candidateId === candidate.id)!;
			expect(outcome.items.map((i) => i.workItemId)).toEqual(Object.keys(real.workItems).sort());
			for (const item of outcome.items) {
				const wi = real.workItems[item.workItemId]!;
				expect(item.status).toBe(wi.item.status);
				const blocked = ["stale", "conflict", "uncertain", "revalidating"].includes(wi.item.status);
				expect(item.blocked).toBe(blocked);
				const reasons = new Set<ReasonCode>();
				if (blocked) {
					for (const c of wi.conditions) if (["Stale", "Uncertain", "ClaimConflict", "TestFailed", "Blocked"].includes(c.type)) for (const code of c.reasonCodes) reasons.add(code);
				}
				expect(item.reasonCodes).toEqual([...reasons].sort());
			}
			expect(outcome.blockedIds).toEqual(outcome.items.filter((i) => i.blocked).map((i) => i.workItemId));
			expect(outcome.blockedCount).toBe(outcome.blockedIds.length);
		}
	});

	it("what-if leaves the input state deep-equal, and a frozen input does not throw", () => {
		const state = buildState();
		const snapshot = structuredClone(state);
		const policy: Policy = structuredClone(n.policy);
		const frozenCandidates = deepFreeze(structuredClone(candidates));

		expect(() => whatIf(deepFreeze(state), deepFreeze(policy), frozenCandidates)).not.toThrow();
		expect(state).toEqual(snapshot);
		// The candidates are independent: the answer does not depend on the order or on what else was asked.
		const alone = whatIf(buildState(), n.policy, [candidates[1]!]);
		const together = whatIf(buildState(), n.policy, candidates);
		expect(together.find((o) => o.candidateId === "transitions")).toEqual(alone[0]);
		expect(whatIf(buildState(), n.policy, [...candidates].reverse()).map((o) => o.candidateId)).toEqual(["values", "transitions", "notifications-v2"]);
	});

	it("two candidates on a fixture with different dependency sets return different blocked sets", () => {
		const [notificationsOutcome, transitionsOutcome, valuesOutcome] = whatIf(buildState(), n.policy, candidates);
		// WI-2 alone relies on notifications; WI-1 alone relies on status.transitions; both rely on status.values.
		expect(notificationsOutcome?.blockedIds).toEqual(["WI-2"]);
		expect(transitionsOutcome?.blockedIds).toEqual(["WI-1"]);
		expect(valuesOutcome?.blockedIds).toEqual(["WI-1", "WI-2"]);
		expect(valuesOutcome?.blockedCount).toBe(2);
		expect(notificationsOutcome?.items.find((i) => i.workItemId === "WI-2")?.reasonCodes).toContain("STALE_RECEIPT");
		expect(notificationsOutcome?.items.find((i) => i.workItemId === "WI-1")).toMatchObject({ blocked: false, reasonCodes: [] });
	});

	it("a change that does not govern anything blocks nothing and says why", () => {
		const outcomes = whatIf(buildState(), n.policy, [
			{ id: "typo", change: asChange(n.events.typoFix) },
			{ id: "forged", change: asChange(n.events.v2Forged) },
		]);
		expect(outcomes[0]).toMatchObject({ blockedCount: 0, changeReasonCodes: ["PROSE_ONLY"] });
		expect(outcomes[1]?.blockedCount).toBe(0);
		expect(outcomes[1]?.changeReasonCodes).toContain("FORBIDDEN_ACTOR");
	});
});
