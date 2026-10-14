import { ContextReceipt, DeltaEvent, Dependency, Policy, WorkItem, parseContextRecord, type CellState } from "contracts";
import { describe, expect, it } from "vitest";
import { summarizeEffects } from "./summary";
import { createCell, reasonsOf, resolutionEvent, type Cell } from "./testing/harness";
import { dogfoodBuild as s, stores } from "./testing/scenarios";

const CONTROL = s.expected.controlId;
const ZERO_SHA = "0000000000000000000000000000000000000000";

function staleFacets(state: CellState, id: string): string[] | undefined {
	return state.workItems[id]?.conditions.find((c) => c.type === "Stale")?.facetKeys;
}

function effectFor(effects: Array<{ type: string; workItemId?: string; reasonCodes: string[] }>, type: string, id: string) {
	return effects.find((e) => e.type === type && e.workItemId === id);
}

/** Replay the timeline in commit order up to, but not including, the step with this key. */
async function replayBefore(key: string, store?: Parameters<typeof createCell>[2]): Promise<Cell> {
	const cell = await createCell(s.seed, s.policy, store);
	for (const step of s.timeline) {
		if (step.key === key) return cell;
		await cell.send(step.event);
	}
	throw new Error(`no timeline step ${key}`);
}

describe("the build-history fixture is valid and carries its honest framing", () => {
	it("every event, item, receipt, dependency and policy parses", () => {
		for (const step of s.timeline) expect(() => DeltaEvent.parse(step.event), step.key).not.toThrow();
		for (const item of Object.values(s.workItems)) expect(() => WorkItem.parse(item)).not.toThrow();
		for (const receipt of Object.values(s.receipts)) expect(() => ContextReceipt.parse(receipt)).not.toThrow();
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
		expect(s.docs.productNamingV2.snapshot.facetHash).toBe(s.docs.productNamingV1.snapshot.facetHash);
		expect(s.docs.productNamingV2.snapshot.blobHash).not.toBe(s.docs.productNamingV1.snapshot.blobHash);
	});

	it("is in commit order, with the commits' own timestamps; the only invented event is the wording edit", () => {
		const keys = s.timeline.map((step) => step.key);
		const changes = keys.filter((key) => !key.startsWith("register-") && !key.startsWith("push-"));
		// The county rename was committed before the evidence policy changes, and the replay says so.
		expect(changes).toEqual(["namingV2", "evidenceV2", "evidenceV3", "productNamingProse"]);
		const ordered = s.timeline.map((step) => step.ts);
		expect([...ordered].sort()).toEqual(ordered);
		// Real author times (UTC) of the commits.
		expect(s.events.namingV2.ts).toBe("2026-10-13T03:11:59Z");
		expect(s.events.evidenceV2.ts).toBe("2026-10-13T04:04:23Z");
		expect(s.events.evidenceV3.ts).toBe("2026-10-13T04:18:34Z");
		expect(s.events.push["WI-1"]?.ts).toBe("2026-10-13T03:47:01Z");
		expect(s.events.push["WI-7"]?.ts).toBe("2026-10-13T03:27:43Z");
		// Everything that is not in git carries the all-zero sha, never something that looks like a commit.
		const notInGit = Object.entries(s.commits).filter(([, sha]) => sha === ZERO_SHA).map(([name]) => name);
		expect(notInGit.sort()).toEqual(["productNamingProse", "wi5Head"]);
		for (const [name, sha] of Object.entries(s.commits)) expect(sha, name).toMatch(/^[0-9a-f]{40}$/);
		expect(JSON.stringify(s.commits)).not.toMatch(/"[bf]0{30,}[0-9a-f]+"/);
		expect(s.timeline.find((step) => step.key === "productNamingProse")?.label).toContain("invented, not in git");
		expect(s.timeline.find((step) => step.key === "push-WI-5")?.label).toContain("not in git");
	});

	it("uses real full-length commit shas where a commit exists, and no private or ambiguous names", () => {
		expect(s.commits.wi1Head.startsWith("ce882f2")).toBe(true);
		expect(s.commits.wi2Head.startsWith("6689702")).toBe(true);
		expect(s.commits.evidenceV1.startsWith("7d7fa09")).toBe(true);
		expect(s.commits.evidenceV2.startsWith("8350830")).toBe(true);
		expect(s.commits.evidenceV3.startsWith("2f3d2c8")).toBe(true);
		expect(s.commits.namingV2.startsWith("59d48e4")).toBe(true);
		expect(s.commits.baselineV1.startsWith("61867a9")).toBe(true);
		expect(s.commits.wi3Head.startsWith("f29ac84")).toBe(true);
		expect(s.commits.wi6Head.startsWith("e0710e6")).toBe(true);
		expect(s.commits.wi7Head.startsWith("3036894")).toBe(true);
		const everything = JSON.stringify([s.workItems, s.actors, s.expected, s.timeline.map((t) => t.label)]) + Object.values(s.docs).map((d) => d.text).join("\n");
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
	});

	it("every push carries claims for facets the item declared, with the values it was built against", () => {
		for (const [id, list] of Object.entries(s.claims)) {
			const declared = new Set(s.dependencies[id as keyof typeof s.dependencies].flatMap((d) => d.facetKeys));
			expect(list.length, id).toBeGreaterThan(0);
			for (const claim of list) expect(declared.has(claim.subject), `${id} ${claim.subject}`).toBe(true);
		}
		expect(s.claims.wi2).toContainEqual({ subject: "evidence.counts-as-test", value: "claims-check", basedOn: "evidence-policy@1" });
		expect(s.claims.wi3).toContainEqual({ subject: "scenario.county", value: "Cedar County", basedOn: "scenario-naming@1" });
	});
});

describe("before any change, every item sits in a clean state", () => {
	it("each item is fresh with its claims matching the accepted facets, none uncertain for lack of claims", async () => {
		const cell = await replayBefore("namingV2");
		for (const step of s.timeline) if (step.key.startsWith("push-WI-7") || step.key.startsWith("push-WI-1") || step.key.startsWith("push-WI-2")) await cell.send(step.event);
		const state = await cell.state();
		for (const id of ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"]) {
			const types = state.workItems[id]?.conditions.map((c) => c.type) ?? [];
			expect(types, id).toContain("Fresh");
			expect(types, id).not.toContain("Stale");
			expect(types, id).not.toContain("ClaimConflict");
			expect(state.workItems[id]?.conditions.flatMap((c) => c.reasonCodes), id).not.toContain("NO_CLAIMS");
			expect(state.workItems[id]?.headSha, id).toBe(s.forkHeads[id as "WI-1"]);
		}
	});
});

describe.each(stores)("the replay on the %s", (_label, makeStore) => {
	it("step 1, scenario naming v1 to v2 (Cedar County to Larkhaven County, 59d48e4): WI-3, WI-4, WI-5 go stale; WI-1, WI-2, WI-6, WI-7 are untouched", async () => {
		const cell = await replayBefore("namingV2", makeStore());
		const before = structuredClone(await cell.state());
		const result = await cell.send(s.events.namingV2);
		const state = await cell.state();

		for (const id of ["WI-3", "WI-4", "WI-5"]) {
			expect(state.workItems[id]?.item.status, id).not.toBe("running");
			expect(staleFacets(state, id), id).toEqual(s.expected.afterNamingV2.stale[id as "WI-3"]);
			expect(result.effects, id).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: id }));
			// The claim "Cedar County" now contradicts the accepted facet: this is the reason it is blocked.
			expect(state.workItems[id]?.conditions.find((c) => c.type === "ClaimConflict")?.facetKeys, id).toEqual(["scenario.county"]);
		}
		for (const id of s.expected.afterNamingV2.untouched) {
			expect(effectFor(result.effects, "NO_ACTION", id)?.reasonCodes, id).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
			expect(staleFacets(state, id), id).toBeUndefined();
		}
		// WI-1 and WI-2 have not been pushed yet, so only WI-6 and WI-4 are comparable byte for byte; WI-6 is.
		expect(state.workItems["WI-6"]).toEqual(before.workItems["WI-6"]);
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 7, stale: 3, untouched: 4 });
		expect(state.records["scenario-naming"]?.current).toBe(2);
		expect(state.baselineCommit).toBe(s.commits.namingV2);
	});

	it("step 2, evidence policy v1 to v2 (8350830): WI-1, WI-2, WI-3 go stale; WI-4 to WI-7 are untouched", async () => {
		const cell = await replayBefore("evidenceV2", makeStore());
		const before = structuredClone(await cell.state());
		const result = await cell.send(s.events.evidenceV2);
		const state = await cell.state();

		for (const id of ["WI-1", "WI-2", "WI-3"]) {
			expect(staleFacets(state, id), id).toEqual(s.expected.afterEvidenceV2.stale[id as "WI-1"]);
			expect(result.effects, id).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: id }));
		}
		// WI-1 and WI-2 were built on the claims check counting as a test; that claim now conflicts.
		for (const id of ["WI-1", "WI-2"]) expect(state.workItems[id]?.conditions.find((c) => c.type === "ClaimConflict")?.facetKeys, id).toEqual(["evidence.claims-check-role", "evidence.counts-as-test"]);
		// WI-3 made no claim about the evidence rule; it is stale on it through its declared dependency only.
		expect(state.workItems["WI-3"]?.conditions.find((c) => c.type === "ClaimConflict")?.facetKeys).toEqual(["scenario.county"]);
		for (const id of s.expected.afterEvidenceV2.untouched) {
			expect(effectFor(result.effects, "NO_ACTION", id)?.reasonCodes, id).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
			expect(state.workItems[id], id).toEqual(before.workItems[id]);
		}
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 7, stale: 3, untouched: 4 });
		expect(state.records["evidence-policy"]?.current).toBe(2);
	});

	it("step 3, evidence policy v2 to v3 (2f3d2c8): only WI-1, which relies on required-facets, gains a stale facet; WI-4 to WI-7 are untouched", async () => {
		const cell = await replayBefore("evidenceV3", makeStore());
		const before = structuredClone(await cell.state());
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(staleFacets(before, id), id).toEqual(s.expected.afterEvidenceV2.stale[id as "WI-1"]);

		const result = await cell.send(s.events.evidenceV3);
		const state = await cell.state();

		// Facet precision. The engine looks again at items already stale on this record, but the facets they are stale on
		// do not change unless they rely on the facet that moved: only WI-1 relies on evidence.required-facets.
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(staleFacets(state, id), id).toEqual(s.expected.afterEvidenceV3.stale[id as "WI-1"]);
		for (const id of ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"]) {
			expect(staleFacets(state, id)?.includes("evidence.required-facets") ?? false, id).toBe(id === "WI-1");
		}
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: "WI-1" }));
		expect(state.workItems["WI-1"]?.conditions.find((c) => c.type === "ClaimConflict")?.facetKeys).toContain("evidence.required-facets");
		for (const id of ["WI-2", "WI-3"]) expect(state.workItems[id]?.conditions.find((c) => c.type === "ClaimConflict")?.facetKeys, id).not.toContain("evidence.required-facets");
		for (const id of s.expected.afterEvidenceV3.untouched) {
			expect(effectFor(result.effects, "NO_ACTION", id)?.reasonCodes, id).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
			expect(state.workItems[id], id).toEqual(before.workItems[id]);
		}
		expect(state.records["evidence-policy"]?.current).toBe(3);
	});

	it("step 4, a wording-only edit to product naming (invented negative control): NO_ACTION with PROSE_ONLY and nothing is re-evaluated", async () => {
		const cell = await replayBefore("productNamingProse", makeStore());
		const before = structuredClone(await cell.state());

		const result = await cell.send(s.events.productNamingProse);
		const after = await cell.state();

		expect(result.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["PROSE_ONLY"] })]);
		expect(reasonsOf(result)).toEqual(["PROSE_ONLY"]);
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 0, stale: 0, untouched: 0 });
		// Every work item is exactly as it was. WI-2 depends on the public name, and still does not move.
		expect(after.workItems).toEqual(before.workItems);
		expect(after.records["product-naming"]?.versions["2"]?.facetHash).toBe(after.records["product-naming"]?.versions["1"]?.facetHash);
		expect(after.baselineCommit).toBe(ZERO_SHA);
	});

	it("step 5, WI-7 (console identity header) never goes stale and is never touched, through the whole replay", async () => {
		const cell = await createCell(s.seed, s.policy, makeStore());
		let pushed = false;
		let initial: unknown;
		for (const step of s.timeline) {
			const result = await cell.send(step.event);
			if (step.key === "push-WI-7") {
				pushed = true;
				initial = structuredClone(await cell.wi(CONTROL));
				expect((initial as { item: { status: string } }).item.status).not.toBe("stale");
				continue;
			}
			if (!pushed) continue;
			expect(await cell.wi(CONTROL), step.key).toEqual(initial);
			if (step.key.startsWith("push-")) continue;
			expect(effectFor(result.effects, "NO_ACTION", CONTROL)?.reasonCodes, step.key).toEqual(step.key === "productNamingProse" ? undefined : ["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
		}
		expect(pushed).toBe(true);

		// The ledger records every decision and nothing was edited after the fact; WI-7 is never stale in it.
		const ledger = await cell.ledger();
		expect(ledger.length).toBe(s.timeline.length);
		const staleOnControl = ledger.flatMap((entry) => entry.payload.effects.filter((e) => e.type === "RECORD_CONDITION" && e.workItemId === CONTROL && e.condition.type === "Stale"));
		expect(staleOnControl).toEqual([]);
		expect(ledger.some((entry) => entry.payload.effects.some((e) => e.type === "RECORD_CONDITION" && e.workItemId === "WI-1" && e.condition.type === "Stale"))).toBe(true);
	});

	it("a human is required: the agent that built WI-1 cannot revalidate it", async () => {
		const cell = await replayBefore("evidenceV3", makeStore());
		const before = structuredClone(await cell.wi("WI-1"));
		const result = await cell.send(
			resolutionEvent(await cell.state(), { kind: "revalidate", workItemId: "WI-1", recordId: "evidence-policy", actor: s.actors.buildAgent, requestId: "agent-revalidate", ts: "2026-10-13T17:00:00Z" }),
		);
		expect(result.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["FORBIDDEN_ACTOR"] })]);
		expect(await cell.wi("WI-1")).toEqual(before);
	});
});
