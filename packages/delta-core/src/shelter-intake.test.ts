import { loadDoc, ClaimsFile, ContextReceipt, DeltaEvent, Dependency, Evidence, Policy, WorkItem, parseContextRecord } from "contracts";
import { BRIEFING_V1, BRIEFING_V2, SCRIPT_V1, SCRIPT_V2, SHELTER_INTAKE_CHECK, runShelterIntakeCheck } from "scenario-shelter-intake";
import { describe, expect, it } from "vitest";
import { evaluateGate } from "./gate";
import { summarizeEffects } from "./summary";
import { conditionTypes, createCell, effectTypes, promotionEvent, reasonsOf, resolutionEvent, type Cell } from "./testing/harness";
import { baselinePush, shelterIntake as s, stores } from "./testing/scenarios";

const T = "2026-10-13T17:00:00Z";
const RECORD = "shelter-intake-policy";
const UNTOUCHED = ["WI-4", "WI-5"];
const AFFECTED = ["WI-1", "WI-2", "WI-3"];

async function startedCell(store?: Parameters<typeof createCell>[2]): Promise<Cell> {
	const cell = await createCell(s.seed, s.policy, store);
	for (const event of [s.events.registerWi1, s.events.registerWi2, s.events.registerWi3, s.events.registerWi4, s.events.registerWi5]) await cell.send(event);
	return cell;
}

/** Everyone hands in their first draft, after v2 has landed. Convergence runs its check on each. */
async function allPushed(cell: Cell): Promise<void> {
	for (const event of [s.events.wi1Pushed, s.events.wi1Evidence, s.events.wi2Pushed, s.events.wi3Pushed, s.events.wi3Evidence, s.events.wi4Pushed, s.events.wi4Evidence, s.events.wi5Pushed, s.events.wi5Evidence]) {
		await cell.send(event);
	}
}

const exception = s.expected.resolutions["WI-2"];
function signageException(cell: Cell, requestId = "exc-wi2") {
	return cell.state().then((state) =>
		cell.send(
			resolutionEvent(state, { kind: "accept-exception", workItemId: "WI-2", recordId: RECORD, actor: s.actors.coordinator, requestId, ts: T, scope: exception.scope, rationale: exception.rationale }),
		),
	);
}

describe("the shelter-intake fixture is synthetic and valid", () => {
	it("every event, item, receipt, dependency, evidence and claim parses", () => {
		for (const event of Object.values(s.events)) expect(() => DeltaEvent.parse(event)).not.toThrow();
		for (const item of Object.values(s.workItems)) expect(() => WorkItem.parse(item)).not.toThrow();
		for (const receipt of Object.values(s.receipts)) expect(() => ContextReceipt.parse(receipt)).not.toThrow();
		for (const deps of Object.values(s.dependencies)) for (const dep of deps) expect(() => Dependency.parse(dep)).not.toThrow();
		for (const e of Object.values(s.evidence)) expect(() => Evidence.parse(e)).not.toThrow();
		for (const list of Object.values(s.claims)) expect(() => ClaimsFile.parse(list)).not.toThrow();
		expect(() => Policy.parse(s.policy)).not.toThrow();
	});

	it("the records are real Markdown run through the real parser", () => {
		for (const doc of Object.values(s.docs)) {
			const parsed = parseContextRecord(doc.text);
			expect(parsed.ok, doc.path).toBe(true);
		}
		expect(Object.keys(s.docs.policyV1.snapshot.facets)).toEqual(["pets", "id_required", "capacity_note", "hours"]);
		expect(s.docs.policyV1.snapshot.facets["pets"]).toBe("service animals only");
		expect(s.docs.policyV2.snapshot.facets["pets"]).toBe("crated pets admitted, pet area in Hall B");
		expect(s.docs.policyV1.snapshot.facets["id_required"]).toBe("ID required");
		expect(s.docs.policyV2.snapshot.facets["id_required"]).toBe("ID not listed as a requirement");
		expect(Object.keys(s.docs.rolesV1.snapshot.facets)).toEqual(["greeter", "intake_desk"]);
		expect(s.seed.records.every((r) => r.version === 1)).toBe(true);
	});

	it("carries the synthetic note and nothing that points at a real place, event or organisation", () => {
		const everything = JSON.stringify([s.docs, s.expected, s.workItems, s.actors]) + Object.values(s.docs).map((d) => d.text).join("\n");
		expect(everything).toContain("Synthetic scenario. Not operational guidance.");
		for (const doc of Object.values(s.docs)) expect(doc.text, doc.path).toContain("Synthetic scenario. Not operational guidance.");
		for (const text of [SCRIPT_V1, SCRIPT_V2, BRIEFING_V1, BRIEFING_V2]) expect(text).toContain("Synthetic scenario. Not operational guidance.");
		expect(everything).toContain("Larkhaven Mutual Aid Network");
		for (const text of [s.docs.policyV2.text, s.docs.policyV3.text, SCRIPT_V2, BRIEFING_V2]) expect(text).not.toMatch(/photo id/i);
		expect(everything).not.toMatch(/hurricane|storm|victim|casualt|donat|fundrais|\.gov\b|evacuat|warning|emergency/i);
	});
});

describe("R1 and R2: the policy change reaches exactly the drafts that depend on it", () => {
	it("stales items 1 to 3 and leaves items 4 and 5 untouched, each with a reason", async () => {
		const cell = await startedCell();
		const result = await cell.send(s.events.v2);

		for (const id of AFFECTED) {
			const wi = await cell.wi(id);
			expect(wi.item.status, id).toBe("stale");
			expect(conditionTypes(wi), id).toContain("Stale");
			expect(wi.conditions.find((c) => c.type === "Stale")?.facetKeys, id).toEqual(s.expected.afterV2[id as "WI-1"].staleFacets);
			expect(result.effects).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: id }));
		}
		for (const id of UNTOUCHED) {
			const wi = await cell.wi(id);
			expect(wi.item.status, id).toBe("running");
			expect(conditionTypes(wi), id).not.toContain("Stale");
			expect(result.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: id, reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] }));
		}
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 5, stale: 3, untouched: 2 });
		expect((await cell.state()).records[RECORD]?.current).toBe(2);
	});

	it("an item that only relies on hours (item 5) is not disturbed even though it shares the record", async () => {
		const cell = await startedCell();
		await cell.send(s.events.wi5Pushed);
		await cell.send(s.events.wi5Evidence);
		const before = structuredClone(await cell.wi("WI-5"));
		await cell.send(s.events.v2);
		expect(await cell.wi("WI-5")).toEqual(before);
		expect((await cell.wi("WI-5")).item.status).toBe("ready");
	});

	it("a typo fix in the welcome text stales nothing", async () => {
		const cell = await startedCell();
		await allPushed(cell);
		const before = (await cell.state()).workItems;

		const result = await cell.send(s.events.proseOnly);

		expect(result.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["PROSE_ONLY"] })]);
		expect(effectTypes(result)).not.toContain("BLOCK_PROMOTION");
		expect(effectTypes(result)).not.toContain("REQUEST_REVIEW");
		const after = await cell.state();
		expect(after.workItems).toEqual(before);
		expect(after.records[RECORD]?.current).toBe(1);
		expect(after.baselineCommit).toBe(s.commits.baselineTypoFixed);
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(conditionTypes(after.workItems[id]!), id).not.toContain("Stale");
	});
});

describe("R3 and R8: a draft built on v1 conflicts, and Convergence's own check fails it", () => {
	it("the three drafts claim the v1 pets rule, and the claims conflict with v2", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);

		const script = await cell.wi("WI-1");
		const conflict = script.conditions.find((c) => c.type === "ClaimConflict");
		expect(conflict?.facetKeys).toEqual(["id_required", "pets"]);
		expect(conflict?.reasonCodes).toEqual(expect.arrayContaining(["CLAIM_CONFLICT", "SUPERSEDED_BASIS"]));
		expect(conflict?.message).toContain("pets");
		expect(script.item.status).toBe("conflict");

		expect((await cell.wi("WI-2")).conditions.find((c) => c.type === "ClaimConflict")?.facetKeys).toEqual(["pets"]);
		expect((await cell.wi("WI-3")).conditions.find((c) => c.type === "ClaimConflict")?.facetKeys).toEqual(["id_required", "pets"]);
		// The unchanged facets that the briefing also cites (hours) are not in conflict.
		expect((await cell.wi("WI-3")).conditions.find((c) => c.type === "ClaimConflict")?.facetKeys).not.toContain("hours");

		// The untouched pair pushed claims on facets that did not move: no conflict, and the check passes.
		for (const id of UNTOUCHED) {
			const wi = await cell.wi(id);
			expect(conditionTypes(wi), id).toEqual(["Fresh", "TestsPassed", "Ready"]);
			expect(wi.item.status, id).toBe("ready");
		}
	});

	it("the check is a real assertion on the script text: it mentions the pet area when pets are admitted, or it fails", async () => {
		const v1 = s.docs.policyV1.snapshot.facets;
		const v2 = s.docs.policyV2.snapshot.facets;

		const staleScript = runShelterIntakeCheck("scripts/front-desk.md", SCRIPT_V1, v2);
		expect(staleScript.pass).toBe(false);
		expect(staleScript.failures.join(" ")).toMatch(/pet-area-mentioned.*Hall B/);
		expect(staleScript.failures.join(" ")).toMatch(/no-outdated-pet-line/);
		expect(staleScript.failures.join(" ")).toMatch(/no-outdated-id-line/);

		// The same text was correct under the policy it was built on.
		expect(runShelterIntakeCheck("scripts/front-desk.md", SCRIPT_V1, v1).pass).toBe(true);
		expect(runShelterIntakeCheck("scripts/front-desk.md", SCRIPT_V2, v2).pass).toBe(true);
		expect(runShelterIntakeCheck("briefing/one-pager.md", BRIEFING_V1, v2).pass).toBe(false);
		expect(runShelterIntakeCheck("briefing/one-pager.md", BRIEFING_V2, v2).pass).toBe(true);
		// A script that says crated pets are welcome but forgets where to send them still fails.
		expect(runShelterIntakeCheck("scripts/front-desk.md", SCRIPT_V2.replace("Hall B", "the back"), v2).failures).toEqual([expect.stringContaining("pet-area-mentioned")]);
	});

	it("the failing result is stored as Evidence, blocks the script, and the gate says why", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);

		const script = await cell.wi("WI-1");
		expect(script.evidence).toContainEqual(expect.objectContaining({ check: SHELTER_INTAKE_CHECK, pass: false, headSha: s.commits.wi1Head }));
		expect(conditionTypes(script)).toEqual(expect.arrayContaining(["Stale", "ClaimConflict", "TestFailed", "Blocked"]));

		const gate = evaluateGate(await cell.state(), "WI-1", s.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT", "TEST_FAILED"]));
		const blocked = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-1", actor: s.actors.coordinator, requestId: "promote-early", ts: T }));
		expect(effectTypes(blocked)).toContain("BLOCK_PROMOTION");
		expect((await cell.wi("WI-1")).item.status).not.toBe("promoted");
	});
});

describe("R6: revalidation makes the script and the briefing fresh", () => {
	it("re-dispatches the agent with a fresh receipt; new claims and a passing check make it ready", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);

		const rv = await cell.send(resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-1", recordId: RECORD, actor: s.actors.coordinator, requestId: "rv-wi1", ts: T }));
		expect(rv.effects).toContainEqual(expect.objectContaining({ type: "DISPATCH_WORK", workItemId: "WI-1" }));
		expect((await cell.wi("WI-1")).item.status).toBe("revalidating");

		await cell.send(s.events.wi1ReceiptIssued);
		expect((await cell.wi("WI-1")).receipt.accepted.find((e) => e.recordId === RECORD)?.version).toBe(2);
		await cell.send(s.events.wi1PushedRevalidated);
		await cell.send(s.events.wi1RevalidatedEvidence);

		const script = await cell.wi("WI-1");
		expect(conditionTypes(script)).toEqual(["Fresh", "TestsPassed", "Ready"]);
		expect(script.item.status).toBe("ready");
		expect(s.evidence.wi1Revalidated.pass).toBe(true);
		expect(s.evidence.wi1Revalidated.output).toContain("passed");

		// The briefing takes the same path, independently.
		await cell.send(resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-3", recordId: RECORD, actor: s.actors.coordinator, requestId: "rv-wi3", ts: T }));
		for (const event of [s.events.wi3ReceiptIssued, s.events.wi3PushedRevalidated, s.events.wi3RevalidatedEvidence]) await cell.send(event);
		expect((await cell.wi("WI-3")).item.status).toBe("ready");
		// The signage was not touched by either revalidation.
		expect((await cell.wi("WI-2")).item.status).toBe("conflict");
	});

	it("a human is required: the script's own agent cannot revalidate it", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);
		const result = await cell.send(resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-1", recordId: RECORD, actor: s.actors.scriptAgent, requestId: "rv-agent", ts: T }));
		expect(reasonsOf(result)).toEqual(["FORBIDDEN_ACTOR"]);
		expect((await cell.wi("WI-1")).revalidations).toBe(0);
	});
});

describe("R5 and R7: the scoped exception for the door signage", () => {
	it("allows the signage to promote while the printed signs stay as they are, and records the scope", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);
		expect((await cell.wi("WI-2")).item.status).toBe("conflict");
		expect(evaluateGate(await cell.state(), "WI-2", s.policy).promotable).toBe(false);

		const result = await signageException(cell);
		expect(reasonsOf(result)).not.toContain("FORBIDDEN_ACTOR");
		const signage = await cell.wi("WI-2");
		expect(signage.item.status).toBe("ready");
		expect(signage.resolutions).toEqual([expect.objectContaining({ kind: "accept-exception", scope: "signs/door.md", rationale: expect.stringContaining("Existing printed signs stay posted until replacements arrive") })]);
		expect(exception.rationale).toContain("the exception expires on the next policy version");

		const gate = evaluateGate(await cell.state(), "WI-2", s.policy);
		expect(gate.promotable).toBe(true);
		expect(gate.waivedBy).toHaveLength(1);
		const allowed = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-2", actor: s.actors.coordinator, requestId: "promote-wi2", ts: T }));
		expect(effectTypes(allowed)).toContain("ALLOW_PROMOTION");

		// The exception does not spill onto the other two stale drafts.
		for (const id of ["WI-1", "WI-3"]) expect(evaluateGate(await cell.state(), id, s.policy).promotable, id).toBe(false);
	});

	it("only the policy's authority can grant it", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);
		const result = await cell.send(
			resolutionEvent(await cell.state(), { kind: "accept-exception", workItemId: "WI-2", recordId: RECORD, actor: s.actors.signageAgent, requestId: "exc-agent", ts: T, scope: exception.scope }),
		);
		expect(reasonsOf(result)).toEqual(["FORBIDDEN_ACTOR"]);
		expect((await cell.wi("WI-2")).item.status).toBe("conflict");
	});

	it("survives a prose-only edit, and lapses the moment the policy gets a new version", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);
		await signageException(cell);
		expect(evaluateGate(await cell.state(), "WI-2", s.policy).promotable).toBe(true);

		// v3 changes capacity only, but it is a new accepted version of the record the exception was bound to.
		await cell.send(s.events.v3);
		const signage = await cell.wi("WI-2");
		expect(signage.item.status).toBe("conflict");
		const gate = evaluateGate(await cell.state(), "WI-2", s.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("EXCEPTION_LAPSED");
		const blocked = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-2", actor: s.actors.coordinator, requestId: "promote-wi2-late", ts: T }));
		expect(effectTypes(blocked)).toContain("BLOCK_PROMOTION");
	});

	it("a prose-only edit to v2 does not end the exception: the version the exception is bound to has not moved", async () => {
		const cell = await startedCell();
		await cell.send(s.events.v2);
		await allPushed(cell);
		await signageException(cell);

		const reworded = await loadDoc(s.docs.policyV2.path, s.docs.policyV2.text.replace("The pet area is in Hall B.", "The pet area is in Hall B, by the side door."));
		expect(reworded.snapshot.version).toBe(2);
		expect(reworded.snapshot.blobHash).not.toBe(s.docs.policyV2.snapshot.blobHash);
		const before = await cell.wi("WI-2");
		const result = await cell.send(baselinePush(s.repo, [reworded.snapshot]));
		expect(reasonsOf(result)).toEqual(["PROSE_ONLY"]);
		expect(await cell.wi("WI-2")).toEqual(before);
		expect(evaluateGate(await cell.state(), "WI-2", s.policy).promotable).toBe(true);
	});
});

for (const [storeLabel, makeStore] of stores) {
	describe(`Shelter intake, end to end on the ${storeLabel}`, () => {
		it("typo, v2, claim conflicts, one exception, two revalidations, one untouched pair, five promotions", async () => {
			const cell = await startedCell(makeStore());
			await cell.send({ type: "AgentRunStarted", ts: s.events.v2.ts, workItemId: "WI-1", runId: "run-wi-1" });

			// 1. Typo: nothing moves.
			const typo = await cell.send(s.events.proseOnly);
			expect(reasonsOf(typo)).toEqual(["PROSE_ONLY"]);

			// 2. v2 lands: 1 to 3 stale, 4 and 5 untouched.
			const v2 = await cell.send(s.events.v2);
			expect(summarizeEffects(v2.effects)).toEqual({ evaluated: 5, stale: 3, untouched: 2 });

			// 3. Drafts arrive. The script and the briefing fail the check; all three conflict.
			await allPushed(cell);
			expect((await cell.state()).workItems["WI-1"]?.item.status).toBe("conflict");
			expect((await cell.wi("WI-1")).conditions.some((c) => c.type === "TestFailed")).toBe(true);

			// 4. Resolutions.
			await signageException(cell);
			for (const [i, id] of ["WI-1", "WI-3"].entries()) {
				await cell.send(resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: id, recordId: RECORD, actor: s.actors.coordinator, requestId: `rv-${id}`, ts: T }));
				const events = id === "WI-1" ? [s.events.wi1ReceiptIssued, s.events.wi1PushedRevalidated, s.events.wi1RevalidatedEvidence] : [s.events.wi3ReceiptIssued, s.events.wi3PushedRevalidated, s.events.wi3RevalidatedEvidence];
				for (const event of events) await cell.send(event);
				expect((await cell.wi(id)).item.status, `${id} after revalidation (${i})`).toBe("ready");
			}

			// 5. Everyone promotes through the same gate.
			for (const [i, id] of ["WI-4", "WI-5", "WI-2", "WI-1", "WI-3"].entries()) {
				const allowed = await cell.send(promotionEvent(await cell.state(), { workItemId: id, actor: s.actors.coordinator, requestId: `promote-${id}`, ts: T }));
				expect(effectTypes(allowed), id).toContain("ALLOW_PROMOTION");
				await cell.send({ type: "PromotionMerged", ts: T, workItemId: id, repo: s.repo, mergeCommitSha: `b${(950 + i).toString(16).padStart(39, "0")}` });
			}
			expect(Object.values((await cell.state()).workItems).map((w) => w.item.status)).toEqual(Array(5).fill("promoted"));
			await cell.ledger();
		});
	});
}
