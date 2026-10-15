import { ClaimsFile, ContextReceipt, DeltaEvent, Dependency, Evidence, Policy, WorkItem, parseReceiptNote, serializeReceiptNote } from "contracts";
import { describe, expect, it } from "vitest";
import { summarizeEffects } from "./summary";
import { evaluateGate } from "./gate";
import { conditionTypes, createCell, effectTypes, promotionEvent, reasonsOf, resolutionEvent } from "./testing/harness";
import { notifications as n, salesOps as s, stores } from "./testing/scenarios";

describe("fixtures are valid contracts", () => {
	for (const sc of [n, s]) {
		it(`${sc.name}: every event, item, receipt, dependency, evidence and claim parses`, () => {
			for (const event of Object.values(sc.events)) expect(() => DeltaEvent.parse(event)).not.toThrow();
			for (const item of Object.values(sc.workItems)) expect(() => WorkItem.parse(item)).not.toThrow();
			for (const receipt of Object.values(sc.receipts)) expect(() => ContextReceipt.parse(receipt)).not.toThrow();
			for (const deps of Object.values(sc.dependencies)) for (const dep of deps) expect(() => Dependency.parse(dep)).not.toThrow();
			for (const e of Object.values(sc.evidence)) expect(() => Evidence.parse(e)).not.toThrow();
			for (const list of Object.values(sc.claims)) expect(() => ClaimsFile.parse(list)).not.toThrow();
			expect(() => Policy.parse(sc.policy)).not.toThrow();
		});

		it(`${sc.name}: receipts round-trip through the git-note serializer deterministically`, () => {
			for (const receipt of Object.values(sc.receipts)) {
				const text = serializeReceiptNote(receipt);
				const parsed = parseReceiptNote(text);
				expect(parsed.ok).toBe(true);
				if (parsed.ok) expect(serializeReceiptNote(parsed.receipt)).toBe(text);
				expect(serializeReceiptNote(structuredClone(receipt))).toBe(text);
			}
		});

		it(`${sc.name}: every receipt points at a git note on a commit`, () => {
			for (const receipt of Object.values(sc.receipts)) expect(receipt.noteRef).toMatch(/^refs\/notes\/delta:[0-9a-f]{7,40}$/);
		});

		it(`${sc.name}: the seeded baseline contains no work and v1 records only`, () => {
			expect(sc.seed.records.every((r) => r.version === 1)).toBe(true);
		});
	}

	it("the sales-ops fixture is the synthetic company", () => {
		expect(JSON.stringify(s.docs)).toContain("Sablewood");
	});
});

for (const [storeLabel, makeStore] of stores) {
	describe(`Scenario A, the notifications story, end to end on the ${storeLabel}`, () => {
		it("walks the PRD demo: typo, mid-flight decision, claim conflict, failing check, gate, revalidate, promote", async () => {
			const cell = await createCell(n.seed, n.policy, makeStore());
			const T = "2026-10-13T17:00:00Z";

			// 1. Two agents start, overlapping in time; both hold receipts at v1.
			await cell.send(n.events.registerWi1);
			await cell.send(n.events.registerWi2);
			await cell.send({ type: "AgentRunStarted", ts: "2026-10-13T15:01:00Z", workItemId: "WI-1", runId: "run-a" });
			await cell.send({ type: "AgentRunStarted", ts: "2026-10-13T15:01:05Z", workItemId: "WI-2", runId: "run-b" });
			expect((await cell.wi("WI-2")).receipt.accepted.map((e) => `${e.recordId}@${e.version}`)).toEqual(["notifications@1", "status-model@1"]);

			// 2. Typo beat: nothing goes red.
			const typo = await cell.send(n.events.typoFix);
			expect(typo.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["PROSE_ONLY"] })]);
			expect((await cell.wi("WI-1")).item.status).toBe(n.expected.afterTypoFix.statuses["WI-1"]);
			expect((await cell.wi("WI-2")).item.status).toBe(n.expected.afterTypoFix.statuses["WI-2"]);

			// 3-4. Mid-flight: notifications v2. WI-2 goes stale, WI-1 stays fresh (R2).
			const v2 = await cell.send(n.events.v2);
			const wi2 = await cell.wi("WI-2");
			expect(wi2.item.status).toBe(n.expected.afterV2["WI-2"].status);
			expect(conditionTypes(wi2)).toEqual(n.expected.afterV2["WI-2"].conditions);
			expect(wi2.conditions.find((c) => c.type === "Stale")?.facetKeys).toEqual(n.expected.afterV2["WI-2"].staleFacets);
			expect(conditionTypes(await cell.wi("WI-1"))).toEqual(n.expected.afterV2["WI-1"].conditions);
			expect(v2.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-1", reasonCodes: [n.expected.afterV2["WI-1"].noAction] }));
			expect(summarizeEffects(v2.effects)).toEqual({ evaluated: 2, stale: 1, untouched: 1 });

			// 5. WI-2 finishes and pushes v1 claims: ClaimConflict. The runner's check at WI-2's head fails.
			await cell.send(n.events.wi2PushedV1);
			expect(conditionTypes(await cell.wi("WI-2"))).toEqual(n.expected.afterWi2Push["WI-2"].conditions);
			expect((await cell.wi("WI-2")).conditions.find((c) => c.type === "ClaimConflict")?.facetKeys).toEqual(n.expected.afterWi2Push["WI-2"].conflictSubjects);
			await cell.send(n.events.wi2FailsV2);
			await cell.send(n.events.wi2StatusPass);
			expect(conditionTypes(await cell.wi("WI-2"))).toEqual(n.expected.afterWi2Tests["WI-2"].conditions);
			expect((await cell.wi("WI-2")).item.status).toBe(n.expected.afterWi2Tests["WI-2"].status);

			// 6. The gate: WI-2 cannot promote, with reasons; WI-1 promotes straight away.
			const gate = evaluateGate(await cell.state(), "WI-2", n.policy);
			expect(gate.promotable).toBe(false);
			expect(gate.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT", "TEST_FAILED"]));
			const blocked = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-2", actor: n.actors.decisionOwner, requestId: "promote-wi2-early", ts: T }));
			expect(effectTypes(blocked)).toContain("BLOCK_PROMOTION");
			await cell.send(n.events.wi1Pushed);
			await cell.send(n.events.wi1Evidence);
			const wi1Allowed = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-1", actor: n.actors.decisionOwner, requestId: "promote-wi1", ts: T }));
			expect(effectTypes(wi1Allowed)).toContain("ALLOW_PROMOTION");
			await cell.send({ type: "PromotionMerged", ts: T, workItemId: "WI-1", repo: n.repo, mergeCommitSha: n.commits.wi1MergeV2 });
			expect((await cell.wi("WI-1")).item.status).toBe("promoted");
			await cell.send({ type: "AgentRunFinished", ts: "2026-10-13T16:15:00Z", workItemId: "WI-1", runId: "run-a", outcome: "success" });

			// 7. Revalidate WI-2: re-dispatch with the v1 -> v2 diff, a fresh receipt, new claims and passing checks.
			const rv = await cell.send(resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: n.actors.decisionOwner, requestId: "rv-wi2", ts: T, rationale: "Decision changed under this work." }));
			expect(effectTypes(rv)).toEqual(expect.arrayContaining(["REQUEST_REVALIDATION", "DISPATCH_WORK"]));
			await cell.send(n.events.wi2ReceiptIssued);
			await cell.send(n.events.wi2PushedRevalidated);
			await cell.send(n.events.wi2RevalidatedNotifications);
			await cell.send(n.events.wi2RevalidatedStatus);
			expect(conditionTypes(await cell.wi("WI-2"))).toEqual(n.expected.afterRevalidation["WI-2"].conditions);
			expect((await cell.wi("WI-2")).item.status).toBe(n.expected.afterRevalidation["WI-2"].status);

			// Promotion re-checks at current heads (R7), then WI-2 is promoted.
			const wi2Allowed = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-2", actor: n.actors.decisionOwner, requestId: "promote-wi2", ts: T }));
			expect(effectTypes(wi2Allowed)).toContain("ALLOW_PROMOTION");
			await cell.send({ type: "PromotionMerged", ts: T, workItemId: "WI-2", repo: n.repo, mergeCommitSha: "b00000000000000000000000000000000000000f" });
			await cell.send({ type: "AgentRunFinished", ts: "2026-10-13T16:45:00Z", workItemId: "WI-2", runId: "run-b", outcome: "success" });
			expect((await cell.wi("WI-2")).item.status).toBe("promoted");

			// 8. The chain verifies, and the two agent runs overlapped.
			const ledger = await cell.ledger();
			expect(ledger.length).toBeGreaterThan(15);
			const runs = ledger.filter((e) => e.type === "AgentRunStarted" || e.type === "AgentRunFinished").map((e) => `${e.type}:${(e.payload.event as { workItemId: string }).workItemId}`);
			expect(runs).toEqual(["AgentRunStarted:WI-1", "AgentRunStarted:WI-2", "AgentRunFinished:WI-1", "AgentRunFinished:WI-2"]);
			expect(reasonsOf({ outcome: "applied", effects: ledger.flatMap((e) => e.payload.effects), entry: ledger[0] as never })).toEqual(expect.arrayContaining(["PROSE_ONLY", "NO_DEPENDENCY_ON_CHANGED_FACETS", "STALE_RECEIPT", "CLAIM_CONFLICT", "TEST_FAILED"]));
		});
	});

	describe(`Scenario B, qualified lead, end to end on the ${storeLabel}`, () => {
		it("runs the same engine on knowledge work: one revalidated, one excepted, one untouched", async () => {
			const cell = await createCell(s.seed, s.policy, makeStore());
			const T = "2026-10-13T17:00:00Z";
			for (const e of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5]) await cell.send(e);
			await cell.send(s.events.wi3Pushed);
			await cell.send(s.events.wi4Pushed);
			await cell.send(s.events.wi5Pushed);
			await cell.send(s.events.wi5Evidence);

			const v2 = await cell.send(s.events.v2);
			for (const id of ["WI-3", "WI-4"]) expect(conditionTypes(await cell.wi(id))).toContain("Stale");
			expect(conditionTypes(await cell.wi("WI-5"))).toEqual(["Fresh", "TestsPassed", "Ready"]);
			expect(v2.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-5", reasonCodes: [s.expected.afterV2["WI-5"].noAction] }));
			expect(summarizeEffects(v2.effects)).toEqual({ evaluated: 3, stale: 2, untouched: 1 });

			// WI-3: grandfathered on v1 for the board deck, scoped to its output.
			const exception = s.expected.resolutions["WI-3"];
			await cell.send(resolutionEvent(await cell.state(), { kind: "accept-exception", workItemId: "WI-3", recordId: "qualified-lead", actor: s.actors.decisionOwner, requestId: "exc", ts: T, scope: exception.scope, rationale: "Q4 forecast is grandfathered on v1 for the board deck." }));
			expect((await cell.wi("WI-3")).item.status).toBe("ready");

			// WI-4: revalidated.
			await cell.send(resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-4", recordId: "qualified-lead", actor: s.actors.decisionOwner, requestId: "rv", ts: T }));
			for (const e of [s.events.wi4ReceiptIssued, s.events.wi4PushedRevalidated, s.events.wi4RevalidatedCriteria, s.events.wi4RevalidatedActivity]) await cell.send(e);
			expect((await cell.wi("WI-4")).item.status).toBe("ready");

			// All three promote through the same gate.
			for (const [i, id] of ["WI-5", "WI-3", "WI-4"].entries()) {
				const allowed = await cell.send(promotionEvent(await cell.state(), { workItemId: id, actor: s.actors.decisionOwner, requestId: `promote-${id}`, ts: T }));
				expect(effectTypes(allowed), id).toContain("ALLOW_PROMOTION");
				await cell.send({ type: "PromotionMerged", ts: T, workItemId: id, repo: s.repo, mergeCommitSha: `b${(900 + i).toString(16).padStart(39, "0")}` });
			}
			expect(Object.values((await cell.state()).workItems).map((w) => w.item.status)).toEqual(["promoted", "promoted", "promoted"]);
			await cell.ledger();
		});
	});
}
