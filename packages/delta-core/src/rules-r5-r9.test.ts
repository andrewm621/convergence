import { describe, expect, it } from "vitest";
import type { Actor } from "contracts";
import { evaluateGate } from "./gate";
import { reconcile } from "./reconcile";
import { conditionTypes, createCell, effectTypes, promotionEvent, reasonsOf, resolutionEvent, type Cell } from "./testing/harness";
import { baselinePush, forkPush, nextSha, notifications as n, registerItem, salesOps as s, variant } from "./testing/scenarios";

const andrew = n.actors.andrew;
const casey: Actor = { kind: "human", id: "casey", displayName: "Casey (not the authority)" };
const T = "2026-10-13T17:00:00Z";

async function nCell(policy = n.policy): Promise<Cell> {
	const c = await createCell(n.seed, policy);
	await c.send(n.events.registerWi1);
	await c.send(n.events.registerWi2);
	return c;
}

async function sCell(policy = s.policy): Promise<Cell> {
	const c = await createCell(s.seed, policy);
	for (const e of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5]) await c.send(e);
	return c;
}

async function promote(c: Cell, workItemId: string, requestId: string, overrides: { expectedBaselineCommit?: string; forkHeadSha?: string; actor?: Actor } = {}) {
	return c.send(promotionEvent(await c.state(), { workItemId, actor: overrides.actor ?? andrew, requestId, ts: T, ...overrides }));
}

/** WI-3 takes the board-deck exception: stale and conflicting on qualified-lead, but excepted. */
async function wi3WithException(c: Cell, requestId = "exc-1") {
	await c.send(s.events.v2);
	await c.send(s.events.wi3Pushed);
	return c.send(
		resolutionEvent(await c.state(), { kind: "accept-exception", workItemId: "WI-3", recordId: "qualified-lead", actor: andrew, requestId, ts: T, scope: "reports/q4-forecast.md", rationale: "Grandfathered on v1 for the board deck." }),
	);
}

describe("R5 promotion gate", () => {
	it("[positive] Fresh with every required check passing at the head is Ready, and a human may promote", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		expect((await c.wi("WI-1")).item.status).toBe("ready");
		expect(conditionTypes(await c.wi("WI-1"))).toEqual(["Fresh", "TestsPassed", "Ready"]);
		const result = await promote(c, "WI-1", "p-1");
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "ALLOW_PROMOTION", workItemId: "WI-1", forkHeadSha: n.commits.wi1Head }));
		expect((await c.wi("WI-1")).promotionApproval).toMatchObject({ forkHeadSha: n.commits.wi1Head, requestId: "p-1" });
	});

	it("[negative] Stale work is blocked, and the gate says why", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi2StatusPass);
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "FACET_CHANGED", "CLAIM_CONFLICT"]));
		expect(gate.blockers.join(" ")).toContain("notifications@1");
	});

	it("[negative] a failing check at the head blocks, even for work that is otherwise fresh", async () => {
		const c = await nCell();
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi2FailsV2);
		await c.send(n.events.wi2StatusPass);
		expect((await c.wi("WI-2")).item.status).toBe("conflict");
		const result = await promote(c, "WI-2", "p-2");
		expect(effectTypes(result)).toContain("BLOCK_PROMOTION");
		expect(reasonsOf(result)).toContain("TEST_FAILED");
		expect(effectTypes(result)).not.toContain("ALLOW_PROMOTION");
	});

	it("[negative] anything unknown blocks: no evidence, no claims, nothing pushed", async () => {
		const c = await nCell();
		expect(evaluateGate(await c.state(), "WI-1", n.policy).reasonCodes).toEqual(["MISSING_EVIDENCE"]);
		await c.send(n.events.wi1Pushed);
		const noEvidence = evaluateGate(await c.state(), "WI-1", n.policy);
		expect(noEvidence.promotable).toBe(false);
		expect(noEvidence.reasonCodes).toEqual(["MISSING_EVIDENCE"]);
		// Incomplete is not the same as blocked: no Blocked condition yet.
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("Blocked");
		await c.send(forkPush(n.workItems.wi1, null));
		expect(evaluateGate(await c.state(), "WI-1", n.policy).reasonCodes).toContain("NO_CLAIMS");
	});

	it("[negative] an unknown work item blocks", async () => {
		const c = await nCell();
		expect(evaluateGate(await c.state(), "WI-404", n.policy)).toMatchObject({ promotable: false, reasonCodes: ["UNKNOWN_WORK_ITEM"] });
		const result = await c.send({ type: "PromotionRequested", ts: T, requestId: "p-404", workItemId: "WI-404", actor: andrew, expectedBaselineCommit: n.commits.baselineV1, forkHeadSha: n.commits.wi1Head });
		expect(reasonsOf(result)).toEqual(["UNKNOWN_WORK_ITEM"]);
	});

	it("[positive] a bound accept-exception from the record's authority permits stale work", async () => {
		const c = await sCell();
		const result = await wi3WithException(c);
		expect(reasonsOf(result)).toContain("EXCEPTION_APPLIED");
		expect(conditionTypes(await c.wi("WI-3"))).toContain("Ready");
		const gate = evaluateGate(await c.state(), "WI-3", s.policy);
		expect(gate.promotable).toBe(true);
		expect(gate.waivedBy).toHaveLength(1);
		const allowed = await promote(c, "WI-3", "p-3");
		expect(allowed.effects).toContainEqual(expect.objectContaining({ type: "ALLOW_PROMOTION", reasonCodes: ["EXCEPTION_APPLIED"] }));
	});

	it("[negative] an exception from a human who is not the record's authority is refused", async () => {
		const c = await sCell();
		await c.send(s.events.v2);
		await c.send(s.events.wi3Pushed);
		const result = await c.send(resolutionEvent(await c.state(), { kind: "accept-exception", workItemId: "WI-3", recordId: "qualified-lead", actor: casey, requestId: "exc-casey", ts: T, scope: "reports/q4-forecast.md" }));
		expect(reasonsOf(result)).toEqual(["FORBIDDEN_ACTOR"]);
		expect((await c.wi("WI-3")).resolutions).toEqual([]);
		expect(evaluateGate(await c.state(), "WI-3", s.policy).promotable).toBe(false);
	});

	it("[negative] an exception cannot waive what is unknown", async () => {
		const c = await sCell();
		await c.send(s.events.v2);
		await c.send(forkPush(s.workItems.wi3, null)); // no claims file
		await c.send(resolutionEvent(await c.state(), { kind: "accept-exception", workItemId: "WI-3", recordId: "qualified-lead", actor: andrew, requestId: "exc-noclaims", ts: T, scope: "reports/q4-forecast.md" }));
		const gate = evaluateGate(await c.state(), "WI-3", s.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("NO_CLAIMS");
	});

	it("[negative] an exception for a record with nothing stale or conflicting has nothing to except", async () => {
		const c = await sCell();
		await c.send(s.events.wi5Pushed);
		const result = await c.send(resolutionEvent(await c.state(), { kind: "accept-exception", workItemId: "WI-5", recordId: "sales-activity", actor: andrew, requestId: "exc-nothing", ts: T, scope: "docs/glossary.md" }));
		expect(reasonsOf(result)).toEqual(["ALREADY_RESOLVED"]);
	});

	it("[positive] a human-resolution requirement blocks until a human has resolved", async () => {
		const c = await nCell();
		await c.send(registerItem("WI-H", n.receipts.wi1, [{ recordId: "status-model", facetKeys: ["status.values"] }], { requires: ["human-resolution"] }));
		await c.send(forkPush({ id: "WI-H", forkRepo: "test-wi-h" }, n.claims.wi1));
		const gate = evaluateGate(await c.state(), "WI-H", n.policy);
		expect(gate.reasonCodes).toEqual(["HUMAN_RESOLUTION_MISSING"]);
	});

	it("[positive] policy-level requirements apply to every item", async () => {
		const c = await nCell({ ...n.policy, requires: ["contract-test"] });
		await c.send(registerItem("WI-P", n.receipts.wi1, [{ recordId: "status-model", facetKeys: ["status.values"] }]));
		await c.send(forkPush({ id: "WI-P", forkRepo: "test-wi-p" }, n.claims.wi1));
		expect(evaluateGate(await c.state(), "WI-P", { ...n.policy, requires: ["contract-test"] }).reasonCodes).toEqual(["MISSING_EVIDENCE"]);
		expect(evaluateGate(await c.state(), "WI-P", n.policy).promotable).toBe(true);
	});

	it("[negative] checking the gate is a dry run that changes nothing", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		const before = await c.state();
		evaluateGate(before, "WI-1", n.policy);
		expect(await c.state()).toEqual(before);
	});

	it("[positive] work that needs both checks is not ready until both pass at the head", async () => {
		const c = await nCell();
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi2StatusPass);
		expect(evaluateGate(await c.state(), "WI-2", n.policy).reasonCodes).toEqual(["MISSING_EVIDENCE"]);
		await c.send({ ...n.events.wi2FailsV2, evidence: { ...n.evidence.wi2FailsV2, pass: true } } as never);
		expect(evaluateGate(await c.state(), "WI-2", n.policy).promotable).toBe(true);
	});
});

describe("R6 revalidation", () => {
	it("[positive] revalidate asks for a diff-aware re-run and marks the item revalidating", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		const result = await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "rv-1", ts: T }));

		const diff = [
			{
				recordId: "notifications",
				fromVersion: 1,
				toVersion: 2,
				changes: [
					{ key: "notifications.cadence", kind: "changed", from: "immediate", to: "weekly-digest" },
					{ key: "notifications.default", kind: "changed", from: "on", to: "opt-in" },
				],
			},
		];
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "REQUEST_REVALIDATION", workItemId: "WI-2", diff }));
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "DISPATCH_WORK", workItemId: "WI-2", mode: "revalidate", diff }));
		const wi = await c.wi("WI-2");
		expect(wi.item.status).toBe("revalidating");
		expect(wi.revalidations).toBe(1);
		expect(evaluateGate(await c.state(), "WI-2", n.policy).reasonCodes).toContain("REVALIDATION_PENDING");
	});

	it("[positive] a new receipt at the current versions clears Stale; the agent's next push and passing checks make it Ready", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "rv-2", ts: T }));
		await c.send(n.events.wi2ReceiptIssued);
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("Stale");
		expect((await c.wi("WI-2")).item.status).toBe("revalidating"); // still waiting for the re-run
		await c.send(n.events.wi2PushedRevalidated);
		await c.send(n.events.wi2RevalidatedNotifications);
		await c.send(n.events.wi2RevalidatedStatus);
		expect((await c.wi("WI-2")).item.status).toBe("ready");
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(n.expected.afterRevalidation["WI-2"].conditions);
	});

	it("[negative] a receipt that is not at the current versions is refused", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		const old = await c.send({ type: "ReceiptIssued", ts: T, workItemId: "WI-2", receipt: { ...n.receipts.wi2, contextPacketHash: "9".repeat(64) } });
		expect(reasonsOf(old)).toEqual(["RECEIPT_MISMATCH"]);
		const partial = await c.send({ type: "ReceiptIssued", ts: T, workItemId: "WI-2", receipt: { ...n.receipts.wi2Revalidated, accepted: n.receipts.wi2Revalidated.accepted.slice(0, 1), contextPacketHash: "8".repeat(64) } });
		expect(reasonsOf(partial)).toEqual(["RECEIPT_MISMATCH"]);
		expect(conditionTypes(await c.wi("WI-2"))).toContain("Stale");
	});

	it("[positive] loop guard: after maxRevalidations the answer is REQUEST_REVIEW, not another re-run", async () => {
		const c = await nCell({ ...n.policy, maxRevalidations: 1 });
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "rv-3a", ts: T }));
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(forkPush(n.workItems.wi2, n.claims.wi2V1)); // the agent got it wrong again
		const second = await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "rv-3b", ts: T }));
		expect(effectTypes(second)).toEqual(["REQUEST_REVIEW", "BLOCK_PROMOTION"]);
		expect(reasonsOf(second)).toEqual(["REVALIDATION_LIMIT"]);
		expect(effectTypes(second)).not.toContain("DISPATCH_WORK");
		expect((await c.wi("WI-2")).revalidations).toBe(1);
	});

	it("[negative] under the limit, revalidation keeps dispatching", async () => {
		const c = await nCell({ ...n.policy, maxRevalidations: 2 });
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		for (const id of ["a", "b"]) {
			const r = await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: `rv-4${id}`, ts: T }));
			expect(effectTypes(r)).toContain("DISPATCH_WORK");
			await c.send(forkPush(n.workItems.wi2, n.claims.wi2V1));
		}
		expect((await c.wi("WI-2")).revalidations).toBe(2);
	});

	it("[positive] sales-ops: WI-4 is revalidated end to end and WI-3 takes the exception: both resolution paths", async () => {
		const c = await sCell();
		await c.send(s.events.v2);
		await c.send(s.events.wi4Pushed);
		const rv = await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-4", recordId: "qualified-lead", actor: andrew, requestId: "rv-wi4", ts: T }));
		expect(rv.effects).toContainEqual(expect.objectContaining({ type: "DISPATCH_WORK", workItemId: "WI-4" }));
		await c.send(s.events.wi4ReceiptIssued);
		await c.send(s.events.wi4PushedRevalidated);
		await c.send(s.events.wi4RevalidatedCriteria);
		await c.send(s.events.wi4RevalidatedActivity);
		expect((await c.wi("WI-4")).item.status).toBe("ready");
		await wi3WithException(c, "exc-wi3");
		expect((await c.wi("WI-3")).item.status).toBe("ready");
	});
});

describe("R7 approval binding and promotion", () => {
	it("[negative] a resolution bound to context that has since moved is refused", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		const prepared = resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "bind-1", ts: T });
		// A context push lands after the human looked, before they clicked.
		await c.send(n.events.v3ProseBump);
		const result = await c.send(prepared);
		expect(reasonsOf(result)).toEqual(["STALE_BINDING"]);
		expect((await c.wi("WI-2")).revalidations).toBe(0);
	});

	it.each([
		["baseSha", { baseSha: "1234567" }],
		["forkHeadSha", { forkHeadSha: "1234567" }],
		["contextSnapshotHash", { contextSnapshotHash: "7".repeat(64) }],
		["blobHash", { blobHash: "6".repeat(64) }],
		["version", { version: 1 }],
	])("[negative] a wrong %s in the binding is refused", async (_field, patch) => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		const result = await c.send(resolutionEvent(await c.state(), { kind: "reject", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: `bind-${_field}`, ts: T, binding: patch }));
		expect(reasonsOf(result)).toEqual(["STALE_BINDING"]);
		expect((await c.wi("WI-2")).resolutions).toEqual([]);
	});

	it("[negative] a resolution cannot bind to a fork head before the fork has pushed anything", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		const result = await c.send({
			type: "ResolutionRecorded",
			ts: T,
			requestId: "bind-nohead",
			resolution: {
				kind: "reject",
				workItemId: "WI-2",
				actor: andrew,
				rationale: "r",
				binding: {
					recordId: "notifications",
					version: 2,
					blobHash: n.docs.notificationsV2.snapshot.blobHash,
					baseSha: n.commits.baselineV2,
					forkHeadSha: n.commits.wi2HeadV1,
					contextSnapshotHash: n.snapshotHashes.v2,
				},
				ts: T,
			},
		});
		expect(reasonsOf(result)).toEqual(["STALE_BINDING"]);
	});

	it("[negative] promotion is compare-and-swap on the baseline commit", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const result = await promote(c, "WI-1", "cas-1", { expectedBaselineCommit: n.commits.baselineTypo });
		expect(reasonsOf(result)).toEqual(["BASELINE_MOVED"]);
		expect(effectTypes(result)).toContain("BLOCK_PROMOTION");
		expect((await c.wi("WI-1")).promotionApproval).toBeNull();
	});

	it("[negative] promotion is bound to the fork head the human looked at", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const result = await promote(c, "WI-1", "cas-2", { forkHeadSha: nextSha("f") });
		expect(reasonsOf(result)).toEqual(["HEAD_MOVED"]);
	});

	it("[negative] a context push that lands between approve and promote cannot slip through", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const approved = await promote(c, "WI-1", "slip-1");
		expect(effectTypes(approved)).toContain("ALLOW_PROMOTION");
		const baselineAtApproval = (await c.state()).baselineCommit;

		// status-model changes a facet WI-1 relies on, after approval and before the merge is recorded.
		const sm = n.docs.statusModelV1.snapshot;
		await c.send(baselinePush(n.repo, [variant(sm, { version: 2, facets: { ...sm.facets, "status.values": ["draft", "active", "done"] } })]));

		expect((await c.wi("WI-1")).promotionApproval).toBeNull();
		expect((await c.wi("WI-1")).item.status).not.toBe("ready");
		const merged = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: nextSha("b") });
		expect(reasonsOf(merged)).toEqual(["PROMOTION_NOT_APPROVED"]);
		expect((await c.wi("WI-1")).item.status).not.toBe("promoted");

		// Asking again with the baseline the human saw is a stale request; with the new one it is plainly blocked.
		expect(reasonsOf(await promote(c, "WI-1", "slip-2", { expectedBaselineCommit: baselineAtApproval }))).toEqual(["BASELINE_MOVED"]);
		expect(reasonsOf(await promote(c, "WI-1", "slip-3"))).toEqual(expect.arrayContaining(["STALE_RECEIPT"]));
	});

	it("[positive] an exception lapses when its record gets a new accepted version", async () => {
		const c = await sCell();
		await wi3WithException(c);
		expect(evaluateGate(await c.state(), "WI-3", s.policy).promotable).toBe(true);
		const ql = s.docs.qualifiedLeadV2.snapshot;
		const result = await c.send(baselinePush(s.repo, [variant(ql, { version: 3 })]));
		const gate = evaluateGate(await c.state(), "WI-3", s.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("EXCEPTION_LAPSED");
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: "WI-3", reasonCodes: expect.arrayContaining(["EXCEPTION_LAPSED"]) }));
		expect((await c.wi("WI-3")).promotionApproval).toBeNull();
	});

	it("[positive] an exception also lapses when the fork head moves (new work needs a new decision)", async () => {
		const c = await sCell();
		await wi3WithException(c);
		await c.send(forkPush(s.workItems.wi3, s.claims.wi3V1));
		const gate = evaluateGate(await c.state(), "WI-3", s.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("EXCEPTION_LAPSED");
	});

	it("[negative] an exception does not lapse because of a prose-only edit that keeps its version", async () => {
		const c = await sCell();
		await wi3WithException(c);
		// A reworded v2 (same version, same facets) is a prose edit.
		const ql = s.docs.qualifiedLeadV2.snapshot;
		const result = await c.send(baselinePush(s.repo, [variant(ql, {})]));
		expect(reasonsOf(result)).toEqual(["PROSE_ONLY"]);
		expect(evaluateGate(await c.state(), "WI-3", s.policy).promotable).toBe(true);
	});

	it("[negative] an agent cannot promote", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const result = await promote(c, "WI-1", "agent-promote", { actor: n.actors.agentA });
		expect(reasonsOf(result)).toEqual(["FORBIDDEN_ACTOR"]);
		expect(effectTypes(result)).not.toContain("ALLOW_PROMOTION");
		expect((await c.wi("WI-1")).promotionApproval).toBeNull();
	});

	it("[positive] a merge after approval promotes the item and moves the baseline", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		await promote(c, "WI-1", "merge-1");
		const mergeSha = n.commits.wi1MergeV2;
		const result = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: mergeSha });
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "RECORD_CONDITION", workItemId: "WI-1" }));
		const wi = await c.wi("WI-1");
		expect(wi.item.status).toBe("promoted");
		expect(conditionTypes(wi)).toEqual(["Promoted"]);
		expect((await c.state()).baselineCommit).toBe(mergeSha);
		// Promoted work ignores later pushes.
		expect(reasonsOf(await c.send(forkPush(n.workItems.wi1, n.claims.wi1)))).toEqual(["ALREADY_PROMOTED"]);
	});

	it("[negative] a merge nobody approved is not recorded as a promotion", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const result = await c.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: nextSha("b") });
		expect(reasonsOf(result)).toEqual(["PROMOTION_NOT_APPROVED"]);
		expect((await c.wi("WI-1")).item.status).toBe("ready");
	});

	it("[positive] a human rejecting the work blocks it until a later revalidation", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		const result = await c.send(resolutionEvent(await c.state(), { kind: "reject", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "rej-1", ts: T, rationale: "Wrong approach entirely." }));
		expect(effectTypes(result)).toContain("BLOCK_PROMOTION");
		expect((await c.wi("WI-2")).item.status).toBe("rejected");
		expect(evaluateGate(await c.state(), "WI-2", n.policy).reasonCodes).toContain("RESOLUTION_REJECTED");
	});

	it("[negative] resolving promoted or unknown work is refused", async () => {
		const c = await nCell();
		const unknown = await c.send({
			type: "ResolutionRecorded",
			ts: T,
			requestId: "ghost",
			resolution: { kind: "reject", workItemId: "WI-404", actor: andrew, rationale: "r", binding: { recordId: "notifications", version: 1, blobHash: "a".repeat(64), baseSha: n.commits.baselineV1, forkHeadSha: n.commits.wi1Head, contextSnapshotHash: n.snapshotHashes.v1 }, ts: T },
		});
		expect(reasonsOf(unknown)).toEqual(["UNKNOWN_WORK_ITEM"]);
	});
});

describe("R8 evidence only counts at the current head", () => {
	it("[positive] passing evidence at the head becomes TestsPassed", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		expect(conditionTypes(await c.wi("WI-1"))).toContain("TestsPassed");
	});

	it("[negative] evidence for any other head does not count", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		const old = { ...n.evidence.wi1Pass, headSha: nextSha("f") };
		const result = await c.send({ type: "EvidenceRecorded", ts: T, repo: n.workItems.wi1.forkRepo, commitSha: old.headSha, runId: "run-old", evidence: old });
		expect(reasonsOf(result)).toEqual(["STALE_EVIDENCE"]);
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("TestsPassed");
		expect(evaluateGate(await c.state(), "WI-1", n.policy).reasonCodes).toEqual(["MISSING_EVIDENCE"]);
	});

	it("[positive] a new push invalidates earlier evidence: passing at the old head proves nothing about the new one", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		expect((await c.wi("WI-1")).item.status).toBe("ready");
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1));
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("TestsPassed");
		expect((await c.wi("WI-1")).item.status).toBe("fresh");
	});

	it("[positive] failing evidence is TestFailed; a re-run that passes at the same head replaces it", async () => {
		const c = await nCell();
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi2FailsV2);
		expect(conditionTypes(await c.wi("WI-2"))).toContain("TestFailed");
		await c.send({ type: "EvidenceRecorded", ts: T, repo: n.workItems.wi2.forkRepo, commitSha: n.commits.wi2HeadV1, runId: "run-rerun", evidence: { ...n.evidence.wi2FailsV2, pass: true, output: "re-run: ok" } });
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("TestFailed");
	});

	it("[negative] one required check passing does not cover the other", async () => {
		const c = await nCell();
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi2StatusPass);
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("TestsPassed");
	});

	it("[negative] evidence from another repo or for another head claim is ignored", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		const other = await c.send({ type: "EvidenceRecorded", ts: T, repo: "not-this-fork", commitSha: n.evidence.wi1Pass.headSha, runId: "run-x", evidence: n.evidence.wi1Pass });
		expect(reasonsOf(other)).toEqual(["UNKNOWN_WORK_ITEM"]);
		const mismatch = await c.send({ type: "EvidenceRecorded", ts: T, repo: n.workItems.wi1.forkRepo, commitSha: nextSha("f"), runId: "run-y", evidence: n.evidence.wi1Pass });
		expect(reasonsOf(mismatch)).toEqual(["UNKNOWN_WORK_ITEM"]);
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("TestsPassed");
	});

	it("[positive] promote re-checks at the current head: evidence that went stale blocks the request", async () => {
		const c = await nCell();
		await c.send(n.events.wi1Pushed);
		await c.send(n.events.wi1Evidence);
		const newHead = nextSha("f");
		await c.send(forkPush(n.workItems.wi1, n.claims.wi1, { commitSha: newHead }));
		const result = await promote(c, "WI-1", "r8-promote", { forkHeadSha: newHead });
		expect(reasonsOf(result)).toEqual(["MISSING_EVIDENCE"]);
	});
});

describe("R9 idempotency", () => {
	it("[positive] a replayed push is a duplicate, whatever its timestamp", async () => {
		const c = await nCell();
		const first = await c.send(n.events.v2);
		const again = await c.send({ ...n.events.v2, ts: "2031-01-01T00:00:00Z" });
		expect([first.outcome, again.outcome]).toEqual(["applied", "duplicate"]);
	});

	it("[negative] the same commit in a different repo is a different event", async () => {
		const c = await nCell();
		const sha = nextSha("e");
		const a = await c.send(baselinePush(n.repo, [], { commitSha: sha }));
		const b = await c.send(baselinePush("another-baseline", [], { commitSha: sha }));
		expect([a.outcome, b.outcome]).toEqual(["applied", "applied"]);
	});

	it("[negative] evidence for different checks at one commit are different events", async () => {
		const c = await nCell();
		await c.send(n.events.wi2PushedV1);
		const a = await c.send(n.events.wi2FailsV2);
		const b = await c.send(n.events.wi2StatusPass);
		expect([a.outcome, b.outcome]).toEqual(["applied", "applied"]);
	});

	it("[positive] a command retried with the same Idempotency-Key is applied once", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		const event = resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "idem-1", ts: T });
		const first = await c.send(event);
		const retry = await c.send(event);
		expect([first.outcome, retry.outcome]).toEqual(["applied", "duplicate"]);
		expect((await c.wi("WI-2")).revalidations).toBe(1);
		expect((await c.store.ledger()).filter((e) => e.type === "ResolutionRecorded")).toHaveLength(1);
	});

	it("[positive] reusing an Idempotency-Key for a different request is a conflict that writes nothing", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		const first = resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: andrew, requestId: "idem-2", ts: T });
		await c.send(first);
		const ledgerBefore = await c.store.ledger();
		if (first.type !== "ResolutionRecorded") throw new Error("unreachable");
		const second = { ...first, resolution: { ...first.resolution, kind: "reject" as const } };
		const result = await c.send(second);
		expect(result.outcome).toBe("idempotency-conflict");
		expect(reasonsOf(result)).toEqual(["IDEMPOTENCY_CONFLICT"]);
		expect(await c.store.ledger()).toEqual(ledgerBefore);
	});

	it("[negative] a work item cannot be registered twice", async () => {
		const c = await nCell();
		const again = await c.send(n.events.registerWi1);
		expect(again.outcome).toBe("duplicate");
	});

	it("[positive] reconcile on a duplicate returns the very same state object (nothing recomputed)", async () => {
		const c = await nCell();
		await c.send(n.events.v2);
		const state = await c.state();
		const result = reconcile(state, n.events.v2, n.policy);
		expect(result.state).toBe(state);
	});
});
