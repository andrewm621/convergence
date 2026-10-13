import { describe, expect, it } from "vitest";
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
