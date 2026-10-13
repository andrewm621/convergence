import { ContextReceipt, DeltaEvent, Dependency, Policy, WorkItem, parseContextRecord, type CellState } from "contracts";
import { describe, expect, it } from "vitest";
import { summarizeEffects } from "./summary";
import { createCell, reasonsOf, resolutionEvent, type Cell } from "./testing/harness";
import { dogfoodBuild as s, stores } from "./testing/scenarios";

const ALL = ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"];
const CONTROL = s.expected.controlId;
/** The record each stale item's revalidation is bound to (the first record it was found stale on). */
const RESOLVED_AGAINST: Record<string, string> = { "WI-1": "evidence-policy", "WI-2": "evidence-policy", "WI-3": "evidence-policy", "WI-4": "scenario-naming", "WI-5": "scenario-naming" };

function staleFacets(state: CellState, id: string): string[] | undefined {
	return state.workItems[id]?.conditions.find((c) => c.type === "Stale")?.facetKeys;
}

function effectFor(effects: Array<{ type: string; workItemId?: string; reasonCodes: string[] }>, type: string, id: string) {
	return effects.find((e) => e.type === type && e.workItemId === id);
}

async function startedCell(store?: Parameters<typeof createCell>[2]): Promise<Cell> {
	const cell = await createCell(s.seed, s.policy, store);
	for (const id of ALL) await cell.send(s.events.register[id]!);
	for (const id of ALL) await cell.send(s.events.push[id]!);
	return cell;
}

describe("the build-history fixture is valid and carries its honest framing", () => {
	it("every event, item, receipt, dependency and policy parses", () => {
		for (const group of [s.events.register, s.events.push, s.events.reissue]) for (const event of Object.values(group)) expect(() => DeltaEvent.parse(event)).not.toThrow();
		for (const event of [s.events.evidenceV2, s.events.namingV2, s.events.productNamingProse, s.events.evidenceV3]) expect(() => DeltaEvent.parse(event)).not.toThrow();
		for (const item of Object.values(s.workItems)) expect(() => WorkItem.parse(item)).not.toThrow();
		for (const receipt of [...Object.values(s.receipts), ...Object.values(s.reissuedReceipts)]) expect(() => ContextReceipt.parse(receipt)).not.toThrow();
		for (const deps of Object.values(s.dependencies)) for (const dep of deps) expect(() => Dependency.parse(dep)).not.toThrow();
		expect(() => Policy.parse(s.policy)).not.toThrow();
	});

	it("the records are real Markdown run through the real parser, with flat scalar facets and no validation path", () => {
		expect(Object.keys(s.docs)).toHaveLength(10);
		for (const doc of Object.values(s.docs)) {
			expect(parseContextRecord(doc.text).ok, doc.path).toBe(true);
			expect(doc.text, doc.path).not.toMatch(/^validation:/m);
			expect(doc.snapshot.acceptedBy, doc.path).toBe("decision-owner");
			expect(doc.snapshot.status, doc.path).toBe("accepted");
			for (const value of Object.values(doc.snapshot.facets)) expect(Array.isArray(value), doc.path).toBe(false);
			expect(doc.text, doc.path).toContain("Retrofitted from this repo's git history");
		}
		expect(s.seed.records.map((r) => r.recordId)).toEqual(["evidence-policy", "scenario-naming", "scenario-plan", "product-naming", "positioning", "demo-identity"]);
		expect(s.docs.evidenceV1.snapshot.facets).toEqual({ "evidence.counts-as-test": "claims-check", "evidence.claims-check-role": "test", "evidence.required-facets": "none" });
		expect(s.docs.evidenceV2.snapshot.facets).toMatchObject({ "evidence.counts-as-test": "delta-run-check", "evidence.claims-check-role": "informational", "evidence.required-facets": "none" });
		expect(s.docs.evidenceV3.snapshot.facets["evidence.required-facets"]).toBe("from-receipt");
		expect(s.docs.namingV1.snapshot.facets["scenario.county"]).toBe("Cedar County");
		expect(s.docs.namingV2.snapshot.facets["scenario.county"]).toBe("Larkhaven County");
		expect(s.docs.namingV2.snapshot.facets["scenario.network"]).toBe(s.docs.namingV1.snapshot.facets["scenario.network"]);
		expect(s.docs.productNamingV2.snapshot.facets).toEqual(s.docs.productNamingV1.snapshot.facets);
		expect(s.docs.productNamingV2.snapshot.facetHash).toBe(s.docs.productNamingV1.snapshot.facetHash);
		expect(s.docs.productNamingV2.snapshot.blobHash).not.toBe(s.docs.productNamingV1.snapshot.blobHash);
	});

	it("uses real full-length commit shas where a commit exists, and no private or ambiguous names", () => {
		for (const [name, sha] of Object.entries(s.commits)) expect(sha, name).toMatch(/^[0-9a-f]{40}$/);
		expect(s.commits.evidenceV1.startsWith("2cf1f2e")).toBe(true);
		expect(s.commits.evidenceV2.startsWith("163cb45")).toBe(true);
		expect(s.commits.evidenceV3.startsWith("cd31c39")).toBe(true);
		expect(s.commits.namingV2.startsWith("59d48e4")).toBe(true);
		expect(s.commits.baselineV1.startsWith("61867a9")).toBe(true);
		expect(s.commits.wi3Head.startsWith("faf83a8")).toBe(true);
		const everything = JSON.stringify([s.workItems, s.actors, s.expected]) + Object.values(s.docs).map((d) => d.text).join("\n");
		// The product name is always written in full; the bare shorthand never appears in this fixture's prose or labels.
		expect(everything).not.toMatch(/\bDelta\b(?! Convergence)/);
		expect(everything).not.toMatch(/\/Users\/|~\/|\.local\b/);
		expect(s.actors.decisionOwner).toMatchObject({ kind: "human", id: "decision-owner" });
	});

	it("declares dependencies on specific facet keys only, and WI-7 relies on one label that never moves", () => {
		const keys = (id: keyof typeof s.dependencies) => s.dependencies[id].flatMap((d) => d.facetKeys.map((f) => `${d.recordId}/${f}`)).sort();
		expect(keys("wi1")).toEqual(["evidence-policy/evidence.claims-check-role", "evidence-policy/evidence.counts-as-test", "evidence-policy/evidence.required-facets"]);
		expect(keys("wi2")).toEqual(["evidence-policy/evidence.claims-check-role", "evidence-policy/evidence.counts-as-test", "product-naming/naming.public-name"]);
		expect(keys("wi3")).toEqual(["evidence-policy/evidence.counts-as-test", "scenario-naming/scenario.county", "scenario-plan/scenario.second-act-mode"]);
		expect(keys("wi4")).toEqual(["scenario-naming/scenario.county"]);
		expect(keys("wi5")).toEqual(["scenario-naming/scenario.county", "scenario-plan/scenario.second-act-mode"]);
		expect(keys("wi6")).toEqual(["positioning/positioning.llm-claim", "positioning/positioning.tagline", "scenario-plan/scenario.second-act-mode"]);
		expect(keys("wi7")).toEqual(["demo-identity/identity.label"]);
		for (const item of Object.values(s.workItems)) {
			expect(item.requires).toEqual(["human-resolution"]);
			expect(item.status).toBe("running");
		}
		for (const deps of Object.values(s.dependencies)) for (const dep of deps) expect(dep.facetKeys.length).toBeGreaterThan(0);
	});
});

describe.each(stores)("the replay on the %s", (_label, makeStore) => {
	it("step 1, evidence policy v1 to v2: WI-1, WI-2 and WI-3 go stale; the rest are untouched with a reason", async () => {
		const cell = await startedCell(makeStore());
		const before = structuredClone(await cell.state());
		const result = await cell.send(s.events.evidenceV2);
		const state = await cell.state();

		for (const id of ["WI-1", "WI-2", "WI-3"]) {
			expect(state.workItems[id]?.item.status, id).toBe("stale");
			expect(staleFacets(state, id), id).toEqual(s.expected.afterEvidenceV2.stale[id as "WI-1"]);
			expect(result.effects, id).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: id }));
			expect(effectFor(result.effects, "NO_ACTION", id), id).toBeUndefined();
		}
		for (const id of s.expected.afterEvidenceV2.untouched) {
			expect(effectFor(result.effects, "NO_ACTION", id)?.reasonCodes, id).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
			expect(state.workItems[id], id).toEqual(before.workItems[id]);
			expect(staleFacets(state, id), id).toBeUndefined();
		}
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 7, stale: 3, untouched: 4 });
		expect(state.records["evidence-policy"]?.current).toBe(2);
	});

	it("step 2, scenario naming v1 to v2 (Cedar County to Larkhaven County): WI-3, WI-4 and WI-5 go stale; WI-6 and WI-7 are untouched", async () => {
		const cell = await startedCell(makeStore());
		await cell.send(s.events.evidenceV2);
		const before = structuredClone(await cell.state());
		const result = await cell.send(s.events.namingV2);
		const state = await cell.state();

		for (const id of ["WI-3", "WI-4", "WI-5"]) {
			expect(state.workItems[id]?.item.status, id).toBe("stale");
			expect(staleFacets(state, id), id).toContain("scenario.county");
			expect(staleFacets(state, id), id).not.toContain("scenario.network");
			expect(result.effects, id).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: id }));
		}
		// The video script is stale on both the evidence policy and the county now.
		expect(staleFacets(state, "WI-3")).toEqual(["evidence.counts-as-test", "scenario.county"]);
		expect(staleFacets(state, "WI-4")).toEqual(s.expected.afterNamingV2.stale["WI-4"]);
		// WI-1 and WI-2 do not depend on the naming record: left as they were.
		for (const id of ["WI-1", "WI-2", ...s.expected.afterNamingV2.untouched]) {
			expect(effectFor(result.effects, "NO_ACTION", id)?.reasonCodes, id).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
			expect(state.workItems[id], id).toEqual(before.workItems[id]);
		}
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 7, stale: 3, untouched: 4 });
		expect(state.records["scenario-naming"]?.current).toBe(2);
	});

	it("step 3, a prose-only edit to product naming (negative control): NO_ACTION with PROSE_ONLY and nothing is re-evaluated", async () => {
		const cell = await startedCell(makeStore());
		await cell.send(s.events.evidenceV2);
		await cell.send(s.events.namingV2);
		const before = structuredClone(await cell.state());

		const result = await cell.send(s.events.productNamingProse);
		const after = await cell.state();

		expect(result.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["PROSE_ONLY"] })]);
		expect(reasonsOf(result)).toEqual(["PROSE_ONLY"]);
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 0, stale: 0, untouched: 0 });
		// Every work item is exactly as it was. WI-2 depends on the public name, and still does not move.
		expect(after.workItems).toEqual(before.workItems);
		expect(staleFacets(after, "WI-2")).toEqual(s.expected.afterEvidenceV2.stale["WI-2"]);
		expect(after.baselineCommit).toBe(s.commits.productNamingProse);
		expect(after.records["product-naming"]?.current).toBe(2);
		expect(after.records["product-naming"]?.versions["2"]?.facetHash).toBe(after.records["product-naming"]?.versions["1"]?.facetHash);
	});

	it("step 4, evidence policy v2 to v3 (required facets): after humans revalidate, only WI-1 goes stale again", async () => {
		const cell = await startedCell(makeStore());
		await cell.send(s.events.evidenceV2);
		await cell.send(s.events.namingV2);
		await cell.send(s.events.productNamingProse);

		// No automated evidence: a human resolves each stale item, then it gets a receipt at what is accepted now.
		for (const id of ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]) {
			await cell.send(
				resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: id, recordId: RESOLVED_AGAINST[id]!, actor: s.actors.decisionOwner, requestId: `revalidate-${id}`, ts: "2026-10-13T17:00:00Z" }),
			);
			await cell.send(s.events.reissue[id]!);
		}
		const resolved = structuredClone(await cell.state());
		for (const id of ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]) {
			expect(staleFacets(resolved, id), id).toBeUndefined();
			expect(resolved.workItems[id]?.item.status, id).toBe("revalidating");
		}

		const result = await cell.send(s.events.evidenceV3);
		const state = await cell.state();

		expect(staleFacets(state, "WI-1")).toEqual(s.expected.afterEvidenceV3.stale["WI-1"]);
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: "WI-1" }));
		// Facet precision: WI-2 and WI-3 still rely on counts-as-test, but that facet did not move in v3.
		for (const id of s.expected.afterEvidenceV3.untouched) {
			expect(effectFor(result.effects, "NO_ACTION", id)?.reasonCodes, id).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
			expect(staleFacets(state, id), id).toBeUndefined();
			expect(state.workItems[id], id).toEqual(resolved.workItems[id]);
		}
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 7, stale: 1, untouched: 6 });
		expect(state.records["evidence-policy"]?.current).toBe(3);
	});

	it("step 5, WI-7 (console identity header) never goes stale and is never touched, through every step", async () => {
		const cell = await startedCell(makeStore());
		const initial = structuredClone(await cell.wi(CONTROL));
		expect(initial.item.status).not.toBe("stale");

		const steps: Array<[string, DeltaEvent]> = [
			["evidence v2", s.events.evidenceV2],
			["naming v2", s.events.namingV2],
			["product naming prose edit", s.events.productNamingProse],
		];
		for (const [label, event] of steps) {
			const result = await cell.send(event);
			expect(await cell.wi(CONTROL), label).toEqual(initial);
			expect(result.effects.filter((e) => "workItemId" in e && e.workItemId === CONTROL).every((e) => e.type === "NO_ACTION"), label).toBe(true);
		}
		for (const id of ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]) {
			await cell.send(
				resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: id, recordId: RESOLVED_AGAINST[id]!, actor: s.actors.decisionOwner, requestId: `revalidate-${id}`, ts: "2026-10-13T17:00:00Z" }),
			);
			await cell.send(s.events.reissue[id]!);
		}
		const last = await cell.send(s.events.evidenceV3);
		expect(await cell.wi(CONTROL)).toEqual(initial);
		expect(effectFor(last.effects, "NO_ACTION", CONTROL)?.reasonCodes).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);

		// The ledger records every one of those decisions, and nothing was edited after the fact.
		const ledger = await cell.ledger();
		expect(ledger.length).toBeGreaterThan(20);
		const staleOnControl = ledger.flatMap((entry) => entry.payload.effects.filter((e) => e.type === "RECORD_CONDITION" && e.workItemId === CONTROL && e.condition.type === "Stale"));
		expect(staleOnControl).toEqual([]);
		expect(ledger.some((entry) => entry.payload.effects.some((e) => e.type === "RECORD_CONDITION" && e.workItemId === "WI-1" && e.condition.type === "Stale"))).toBe(true);
	});

	it("a human is required: the agent that built WI-1 cannot revalidate it", async () => {
		const cell = await startedCell(makeStore());
		await cell.send(s.events.evidenceV2);
		const before = structuredClone(await cell.wi("WI-1"));
		const result = await cell.send(
			resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-1", recordId: "evidence-policy", actor: s.actors.buildAgent, requestId: "agent-revalidate", ts: "2026-10-13T17:00:00Z" }),
		);
		expect(result.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["FORBIDDEN_ACTOR"] })]);
		expect(await cell.wi("WI-1")).toEqual(before);
	});
});
