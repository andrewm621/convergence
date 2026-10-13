import { describe, expect, it } from "vitest";
import { dispatchFailedRunId, type DeltaEvent } from "contracts";
import { evaluateGate } from "./gate";
import { conditionTypes, createCell, effectTypes, promotionEvent, reasonsOf, resolutionEvent, type Cell } from "./testing/harness";
import { baselinePush, forkPush, notifications as n, variant } from "./testing/scenarios";

// R7 around a revalidation (M4): freshness at promote is decided by the receipt the cell holds, and only
// a ReceiptIssued, which the Worker writes at dispatch while a revalidation is under way, replaces it.
// A push, however good its claims and checks look, does not. These are the invariants the Worker's
// dispatch order depends on.

const owner = n.actors.decisionOwner;
const T = "2026-10-13T17:00:00Z";

/** WI-2 stale after v2, pushed with its v1 claims, and a human has asked to revalidate it. */
async function revalidating(): Promise<Cell> {
	const c = await createCell(n.seed, n.policy);
	await c.send(n.events.registerWi1);
	await c.send(n.events.registerWi2);
	await c.send(n.events.v2);
	await c.send(n.events.wi2PushedV1);
	await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId: "rv-1", ts: T }));
	return c;
}

const request = async (c: Cell, requestId: string) => c.send(promotionEvent(await c.state(), { workItemId: "WI-2", actor: owner, requestId, ts: T }));

describe("R7: freshness at promote follows the receipt, and only the Worker's ReceiptIssued replaces it", () => {
	it("[negative] a fork still at the old receipt stays blocked even with v2 claims and every check passing", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2PushedRevalidated); // the agent's new push, v2 claims, but no receipt was issued
		await c.send(n.events.wi2RevalidatedNotifications);
		await c.send(n.events.wi2RevalidatedStatus);
		expect(conditionTypes(await c.wi("WI-2"))).toContain("Stale");
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("STALE_RECEIPT");
		const refused = await request(c, "promote-old-receipt");
		expect(effectTypes(refused)).toContain("BLOCK_PROMOTION");
		expect(effectTypes(refused)).not.toContain("ALLOW_PROMOTION");
		expect((await c.wi("WI-2")).promotionApproval).toBeNull();
	});

	it("[positive] the same push after the Worker's receipt is fresh, promotable and approved at that head", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(n.events.wi2PushedRevalidated);
		await c.send(n.events.wi2RevalidatedNotifications);
		await c.send(n.events.wi2RevalidatedStatus);
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("Stale");
		expect(evaluateGate(await c.state(), "WI-2", n.policy)).toMatchObject({ promotable: true, reasonCodes: [] });
		const allowed = await request(c, "promote-fresh");
		expect(effectTypes(allowed)).toContain("ALLOW_PROMOTION");
		expect((await c.wi("WI-2")).promotionApproval).toMatchObject({ forkHeadSha: n.commits.wi2HeadRevalidated });
	});

	it("[ordering] a receipt that arrives after the agent's push is refused, which is why the Worker issues it before dispatching", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2PushedRevalidated); // clears `revalidating`
		const late = await c.send(n.events.wi2ReceiptIssued);
		expect(reasonsOf(late)).toEqual(["REVALIDATION_NOT_REQUESTED"]);
		expect(conditionTypes(await c.wi("WI-2"))).toContain("Stale");
	});

	it("[positive] the receipt alone does not make the work promotable: until the agent pushes, the gate says a revalidation is pending", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("REVALIDATION_PENDING");
		expect(gate.reasonCodes).not.toContain("STALE_RECEIPT");
	});

	it("[positive] and the receipt does not hide old claims: a push that left the v1 claims stays in conflict", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(forkPush(n.workItems.wi2, n.claims.wi2V1, { commitSha: n.commits.wi2HeadRevalidated }));
		await c.send(n.events.wi2RevalidatedNotifications);
		await c.send(n.events.wi2RevalidatedStatus);
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("CLAIM_CONFLICT");
		expect(gate.reasonCodes).not.toContain("STALE_RECEIPT");
	});

	it("[negative] a fresh, approved item goes stale again if the decision moves before the merge: the merge is not recorded as a promotion", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(n.events.wi2PushedRevalidated);
		await c.send(n.events.wi2RevalidatedNotifications);
		await c.send(n.events.wi2RevalidatedStatus);
		expect(effectTypes(await request(c, "promote-then-move"))).toContain("ALLOW_PROMOTION");

		const v2 = n.docs.notificationsV2.snapshot;
		await c.send(baselinePush(n.repo, [variant(v2, { version: 3, facets: { ...v2.facets, "notifications.cadence": "daily" } })]));
		expect(conditionTypes(await c.wi("WI-2"))).toContain("Stale");
		const merged = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-2", repo: n.repo, mergeCommitSha: "b00000000000000000000000000000000000000f" });
		expect(reasonsOf(merged)).toContain("PROMOTION_NOT_APPROVED");
		expect((await c.wi("WI-2")).item.status).not.toBe("promoted");
	});
});

describe("R6: one revalidation at a time", () => {
	it("[negative] a second revalidate while one is under way is refused with REVALIDATION_IN_PROGRESS and dispatches nothing, before and after the receipt", async () => {
		const c = await revalidating();
		const again = async (requestId: string) => c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId, ts: T }));
		for (const label of ["before-receipt", "after-receipt"]) {
			const refused = await again(`rv-${label}`);
			expect(reasonsOf(refused)).toContain("REVALIDATION_IN_PROGRESS");
			expect(effectTypes(refused)).not.toContain("DISPATCH_WORK");
			expect(effectTypes(refused)).not.toContain("REQUEST_REVALIDATION");
			expect((await c.wi("WI-2")).revalidations).toBe(1);
			expect((await c.wi("WI-2")).resolutions).toHaveLength(1);
			await c.send(n.events.wi2ReceiptIssued);
		}
	});

	const started = (runId: string): DeltaEvent => ({ type: "AgentRunStarted", ts: T, workItemId: "WI-2", runId });
	const finished = (runId: string, outcome: "success" | "failure" | "cancelled"): DeltaEvent => ({ type: "AgentRunFinished", ts: T, workItemId: "WI-2", runId, outcome });
	const again = async (c: Cell, requestId: string) => c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId, ts: T }));

	it("a failed revalidation run releases the item for another revalidate", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(started("run-1"));
		expect((await c.wi("WI-2")).revalidating).toBe(true);
		await c.send(finished("run-1", "failure"));
		const wi = await c.wi("WI-2");
		expect(wi.revalidating).toBe(false);
		expect(wi.revalidationRun).toBeUndefined();
		// Still blocked: the old claims conflict, nothing was pushed, promotion stays closed.
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("CLAIM_CONFLICT");
		expect(gate.reasonCodes).not.toContain("REVALIDATION_PENDING");
		expect(effectTypes(await request(c, "promote-after-failed-run"))).not.toContain("ALLOW_PROMOTION");
		// And it can be revalidated again, which dispatches again and counts against the limit.
		const second = await again(c, "rv-2");
		expect(effectTypes(second)).toContain("DISPATCH_WORK");
		expect((await c.wi("WI-2")).revalidations).toBe(2);
		expect((await c.wi("WI-2")).revalidating).toBe(true);
	});

	it("a cancelled run releases it too; a successful finish does not (only the push ends the revalidation)", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(started("run-1"));
		await c.send(finished("run-1", "success"));
		expect((await c.wi("WI-2")).revalidating).toBe(true);
		const d = await revalidating();
		await d.send(started("run-1"));
		await d.send(finished("run-1", "cancelled"));
		expect((await d.wi("WI-2")).revalidating).toBe(false);
	});

	it("[negative] a failure of some other run does not end the revalidation", async () => {
		const c = await revalidating();
		await c.send(started("run-1"));
		await c.send(finished("run-0-earlier", "failure"));
		await c.send(finished(dispatchFailedRunId("some-other-request"), "failure"));
		expect((await c.wi("WI-2")).revalidating).toBe(true);
		expect(reasonsOf(await again(c, "rv-x"))).toContain("REVALIDATION_IN_PROGRESS");
	});

	it("a dispatch that failed before any run started releases the item through the resolution's request key", async () => {
		const c = await revalidating(); // resolution request key "rv-1"; no run ever started
		await c.send(finished(dispatchFailedRunId("rv-1"), "failure"));
		expect((await c.wi("WI-2")).revalidating).toBe(false);
		// The receipt was never replaced, so the item is stale as well as conflicting.
		expect(evaluateGate(await c.state(), "WI-2", n.policy).reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT"]));
		expect(effectTypes(await again(c, "rv-2"))).toContain("DISPATCH_WORK");
	});

	it("maxRevalidations still applies across failed runs", async () => {
		const c = await revalidating();
		await c.send(started("run-1"));
		await c.send(finished("run-1", "failure"));
		await again(c, "rv-2");
		await c.send(started("run-2"));
		await c.send(finished("run-2", "failure"));
		const third = await again(c, "rv-3");
		expect(effectTypes(third)).not.toContain("DISPATCH_WORK");
		expect(reasonsOf(third)).toContain("REVALIDATION_LIMIT");
		expect((await c.wi("WI-2")).revalidations).toBe(n.policy.maxRevalidations);
	});

	it("R9: a second finish for the same run, with another outcome, is a duplicate and changes nothing", async () => {
		const c = await revalidating();
		await c.send(started("run-1"));
		await c.send(finished("run-1", "success"));
		const second = await c.send(finished("run-1", "failure"));
		expect(second.outcome).toBe("duplicate");
		expect((await c.wi("WI-2")).revalidating).toBe(true);
	});

	it("[positive] the agent's push ends the revalidation, so the item is no longer pending", async () => {
		const c = await revalidating();
		await c.send(n.events.wi2ReceiptIssued);
		expect((await c.wi("WI-2")).revalidating).toBe(true);
		await c.send(n.events.wi2PushedRevalidated);
		expect((await c.wi("WI-2")).revalidating).toBe(false);
	});
});
