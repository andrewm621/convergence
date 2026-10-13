import { describe, expect, it } from "vitest";
import { evaluateGate } from "./gate";
import { conditionTypes, createCell, effectTypes, promotionEvent, reasonsOf, resolutionEvent, type Cell } from "./testing/harness";
import { baselinePush, forkPush, nextSha, notifications as n, registerItem, variant } from "./testing/scenarios";

const owner = n.actors.decisionOwner;
const T = "2026-10-13T17:00:00Z";
const STATUS_VALUES = n.claims.wi1[0]?.value;

async function nCell(policy = n.policy): Promise<Cell> {
	const c = await createCell(n.seed, policy);
	await c.send(n.events.registerWi1);
	await c.send(n.events.registerWi2);
	return c;
}

async function promote(c: Cell, workItemId: string, requestId: string) {
	return c.send(promotionEvent(await c.state(), { workItemId, actor: owner, requestId, ts: T }));
}

const statusModelV2 = (facets: Record<string, unknown>) => {
	const sm = n.docs.statusModelV1.snapshot;
	return variant(sm, { version: 2, facets: { ...sm.facets, ...facets } as typeof sm.facets });
};

/** A ready, approved item that depends on status.transitions but whose claims cite status.values. */
async function approvedWiX(c: Cell) {
	const item = { id: "WI-X", forkRepo: "test-wi-x" };
	await c.send(registerItem("WI-X", n.receipts.wi1, [{ recordId: "status-model", facetKeys: ["status.transitions"] }], { requires: ["contract-test"] }));
	const head = nextSha("f");
	await c.send(forkPush(item, [{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" }], { commitSha: head }));
	await c.send({ type: "EvidenceRecorded", ts: T, repo: item.forkRepo, commitSha: head, runId: "r1", evidence: { workItemId: "WI-X", headSha: head, check: "tests/contract/status-model.test.ts", pass: true, output: "ok" } });
	const allowed = await promote(c, "WI-X", "wix-approve");
	expect(effectTypes(allowed)).toContain("ALLOW_PROMOTION");
	return item;
}

describe("B1 a refused merge does not poison the key", () => {
	it("a merge refused for want of approval does not stop the approved merge of the same item", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const refused = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: nextSha("b") });
		expect(reasonsOf(refused)).toEqual(["PROMOTION_NOT_APPROVED"]);
		await promote(c, "WI-1", "b1-approve");
		const merged = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: nextSha("b") });
		expect(merged.outcome).toBe("applied");
		expect((await c.wi("WI-1")).item.status).toBe("promoted");
	});
});

describe("S1 an exception waives only the excepted record's own checks (security: authorization-scope)", () => {
	async function staleWi2(statusEvidence: "none" | "fail" | "pass") {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		if (statusEvidence === "fail") await c.send({ ...n.events.wi2StatusPass, evidence: { ...n.evidence.wi2StatusPass, pass: false, output: "broken" } } as never);
		if (statusEvidence === "pass") await c.send(n.events.wi2StatusPass);
		await c.send(resolutionEvent(await c.state(), { kind: "accept-exception", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId: "s1-exc", ts: T, scope: "src/notify.ts" }));
		return c;
	}

	it("a failing check of a different record still blocks", async () => {
		const c = await staleWi2("fail");
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("TEST_FAILED");
	});

	it("missing evidence for a different record's check still blocks", async () => {
		const c = await staleWi2("none");
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("MISSING_EVIDENCE");
	});

	it("the excepted record's own failing check is waived, and everything else passing promotes", async () => {
		const c = await staleWi2("pass");
		await c.send(n.events.wi2FailsV2); // notifications check fails: that is exactly what the exception accepts
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.reasonCodes).toEqual([]);
		expect(gate.promotable).toBe(true);
	});
});

describe("S2 approval cannot survive a context change (security: integrity-bypass)", () => {
	it("a change that makes the item's claims conflict clears the live approval, even if the item does not depend on that facet", async () => {
		const c = await nCell();
		await approvedWiX(c);
		expect((await c.wi("WI-X")).promotionApproval).not.toBeNull();
		await c.send(baselinePush(n.repo, [statusModelV2({ "status.values": ["draft", "done"] })]));
		const wi = await c.wi("WI-X");
		expect(wi.promotionApproval).toBeNull();
		expect(conditionTypes(wi)).toContain("ClaimConflict");
		const merged = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-X", repo: n.repo, mergeCommitSha: nextSha("b") });
		expect(reasonsOf(merged)).toContain("PROMOTION_NOT_APPROVED");
		expect((await c.wi("WI-X")).item.status).not.toBe("promoted");
	});

	it("the merge re-runs the gate at the current state: a policy that tightened after approval refuses it", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		await promote(c, "WI-1", "s2-approve");
		c.setPolicy({ ...n.policy, requires: ["human-resolution"] });
		const merged = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: nextSha("b") });
		expect(effectTypes(merged)).toContain("BLOCK_PROMOTION");
		expect(reasonsOf(merged)).toEqual(expect.arrayContaining(["PROMOTION_NOT_APPROVED", "HUMAN_RESOLUTION_MISSING"]));
		expect((await c.wi("WI-1")).item.status).not.toBe("promoted");
	});

	it("an unrelated change leaves an approved item approved", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		await promote(c, "WI-1", "s2-keep");
		await c.send(n.events.v2); // notifications: WI-1 neither depends on it nor cites it
		expect((await c.wi("WI-1")).promotionApproval).not.toBeNull();
	});
});

describe("S3 a fork cannot smuggle context/** through a merge (security: integrity-bypass)", () => {
	it("a fork that edits context files is not promotable, whatever else is green", async () => {
		const c = await nCell();
		const head = nextSha("f");
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1, { commitSha: head, contextPaths: ["context/notifications.md"] }));
		await c.send({ type: "EvidenceRecorded", ts: T, repo: n.workItems.wi1.forkRepo, commitSha: head, runId: "r", evidence: { ...n.evidence.wi1Pass, headSha: head } });
		expect((await c.wi("WI-1")).contextPaths).toEqual(["context/notifications.md"]);
		const gate = evaluateGate(await c.state(), "WI-1", n.policy);
		expect(gate.reasonCodes).toEqual(["FORK_EDITS_CONTEXT"]);
		const result = await promote(c, "WI-1", "s3-promote");
		expect(effectTypes(result)).toContain("BLOCK_PROMOTION");
		expect(effectTypes(result)).not.toContain("ALLOW_PROMOTION");
		// The accepted record is untouched.
		expect((await c.state()).records.notifications?.current).toBe(1);
	});

	it("the block lifts when a later push no longer touches context", async () => {
		const c = await nCell();
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1, { contextPaths: ["context/notifications.md"] }));
		const clean = nextSha("f");
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1, { commitSha: clean }));
		await c.send({ type: "EvidenceRecorded", ts: T, repo: n.workItems.wi1.forkRepo, commitSha: clean, runId: "r", evidence: { ...n.evidence.wi1Pass, headSha: clean } });
		expect((await c.wi("WI-1")).contextPaths).toEqual([]);
		expect(evaluateGate(await c.state(), "WI-1", n.policy).promotable).toBe(true);
	});

	it("an exception does not waive it", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(forkPush(n.workItems.wi2, n.claims.wi2V1, { contextPaths: ["context/notifications.md"] }));
		await c.send(resolutionEvent(await c.state(), { kind: "accept-exception", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId: "s3-exc", ts: T, scope: "x" }));
		expect(evaluateGate(await c.state(), "WI-2", n.policy).reasonCodes).toContain("FORK_EDITS_CONTEXT");
	});
});

describe("S4 a claim is checked against the record that governs its subject", () => {
	it("citing the wrong record with a wrong value is a conflict with the governing record", async () => {
		const c = await nCell();
		await c.send(forkPush(n.workItems.wi2, [{ subject: "notifications.default", value: "opt-in", basedOn: "status-model@1" }]));
		const conflict = (await c.wi("WI-2")).conditions.find((x) => x.type === "ClaimConflict");
		expect(conflict?.reasonCodes).toContain("CLAIM_CONFLICT");
		expect(conflict?.facetKeys).toEqual(["notifications.default"]);
	});

	it("citing the wrong record with the right value is Uncertain, never a pass", async () => {
		const c = await nCell();
		await c.send(forkPush(n.workItems.wi2, [{ subject: "notifications.default", value: "on", basedOn: "status-model@1" }]));
		const u = (await c.wi("WI-2")).conditions.find((x) => x.type === "Uncertain");
		expect(u?.reasonCodes).toEqual(["WRONG_RECORD"]);
		expect(evaluateGate(await c.state(), "WI-2", n.policy).reasonCodes).toContain("WRONG_RECORD");
	});

	it("citing the governing record is unchanged", async () => {
		const c = await nCell();
		await c.send(n.events.wi2PushedV1);
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(["Fresh"]);
	});
});

describe("S5 R3b ignores rejected items", () => {
	it("rejecting one side clears the other side's cross-claim uncertainty", async () => {
		const c = await nCell();
		await c.send(forkPush(n.workItems.wi2, n.claims.wi2PhoneRequired));
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1PhoneOptional));
		expect(conditionTypes(await c.wi("WI-1"))).toContain("Uncertain");
		await c.send(resolutionEvent(await c.state(), { kind: "reject", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId: "s5-reject", ts: T }));
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("Uncertain");
		expect((await c.wi("WI-2")).item.status).toBe("rejected");
	});

	it("a later push by the other item does not resurrect the conflict with the rejected one", async () => {
		const c = await nCell();
		await c.send(forkPush(n.workItems.wi2, n.claims.wi2PhoneRequired));
		await c.send(resolutionEvent(await c.state(), { kind: "reject", workItemId: "WI-2", recordId: "notifications", actor: owner, requestId: "s5-reject-2", ts: T }));
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1PhoneOptional));
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("Uncertain");
	});
});

describe("S6 authority comes from policy or the previous accepted version, not the incoming file (security: authorization)", () => {
	const noPolicyEntry = { ...n.policy, authority: {} };

	it("a new version that names itself as its own authority is not accepted", async () => {
		const c = await nCell(noPolicyEntry);
		const v2 = n.docs.notificationsV2.snapshot;
		const result = await c.send(baselinePush(n.repo, [variant(v2, { authority: "agent-b", acceptedBy: "agent-b" })]));
		expect(reasonsOf(result)).toEqual(expect.arrayContaining(["FORBIDDEN_ACTOR", "RECORD_NOT_ACCEPTED"]));
		expect((await c.state()).records.notifications?.current).toBe(1);
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(["Fresh"]);
	});

	it("a new version accepted by the previous version's authority is accepted, and may hand authority over", async () => {
		const c = await nCell(noPolicyEntry);
		const v2 = n.docs.notificationsV2.snapshot;
		await c.send(baselinePush(n.repo, [variant(v2, { authority: "next-owner" })]));
		expect((await c.state()).records.notifications?.current).toBe(2);
	});

	it("only a record's first version is trusted to name its own authority", async () => {
		const c = await nCell(noPolicyEntry);
		const first = await c.send(baselinePush(n.repo, [variant(n.docs.notificationsV1.snapshot, { recordId: "brand-new", authority: "someone", acceptedBy: "someone" })]));
		expect((await c.state()).records["brand-new"]?.current).toBe(1);
		expect(reasonsOf(first)).not.toContain("FORBIDDEN_ACTOR");
	});

	it("a refused acceptance at or below the current version is not recorded as a proposal", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(baselinePush(n.repo, [variant(n.docs.notificationsV2.snapshot, { version: 1, acceptedBy: "agent-b" })]));
		expect((await c.state()).records.notifications?.proposed).toBeNull();
	});
});

describe("S7 and N7 revalidation preconditions", () => {
	it("a receipt is only taken while a revalidation is under way", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		const result = await c.send(n.events.wi2ReceiptIssued);
		expect(reasonsOf(result)).toEqual(["REVALIDATION_NOT_REQUESTED"]);
		expect((await c.wi("WI-2")).receipt).toEqual(n.receipts.wi2);
		expect(conditionTypes(await c.wi("WI-2"))).toContain("Stale");
	});

	it("revalidating a fresh item is refused: there is nothing to revalidate", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		const result = await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-1", recordId: "status-model", actor: owner, requestId: "n7", ts: T }));
		expect(reasonsOf(result)).toEqual(["NOTHING_TO_REVALIDATE"]);
		const wi = await c.wi("WI-1");
		expect(wi.revalidations).toBe(0);
		expect(wi.revalidating).toBe(false);
		expect(effectTypes(result)).not.toContain("DISPATCH_WORK");
	});
});
