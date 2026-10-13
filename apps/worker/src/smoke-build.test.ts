import { ClaimsFile, parseContextRecord } from "contracts";
import { describe, expect, it } from "vitest";
import { PointerForkRequest, PointerPushRequest } from "./smoke";
import { CLAIMS_FILE, POINTER_FILE, buildPointerSeed, claimsAtLatest, latestFacets } from "./smoke-build";

describe("the seed for our own build (end state, not a replay)", () => {
	const seed = buildPointerSeed();

	it("holds the six records at their latest versions, accepted by the decision owner", () => {
		const records = Object.entries(seed.baselineFiles).filter(([path]) => path.startsWith("context/"));
		expect(records).toHaveLength(6);
		const versions = Object.fromEntries(
			records.map(([path, text]) => {
				const parsed = parseContextRecord(text);
				if (!parsed.ok) throw new Error(`${path}: ${parsed.error}`);
				expect(parsed.record.frontMatter.accepted_by, path).toBe("decision-owner");
				expect(seed.policy.authority[parsed.record.frontMatter.id], path).toBe("decision-owner");
				return [parsed.record.frontMatter.id, parsed.record.frontMatter.version];
			}),
		);
		expect(versions).toEqual({ "evidence-policy": 3, "scenario-naming": 2, "scenario-plan": 1, "product-naming": 2, positioning: 1, "demo-identity": 1 });
	});

	it("registers WI-1 to WI-7 with their declared dependencies and a human resolution", () => {
		expect(seed.workItems.map((w) => w.id)).toEqual(["WI-1", "WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"]);
		for (const item of seed.workItems) {
			expect(item.requires).toEqual(["human-resolution"]);
			expect(item.dependencies.length).toBeGreaterThan(0);
		}
		expect(seed.workItems[6]?.dependencies).toEqual([{ recordId: "demo-identity", facetKeys: ["identity.label"] }]);
	});

	it("gives each fork valid claims at the latest versions for exactly the facets it declared, and a pointer", () => {
		const latest = latestFacets();
		for (const item of seed.workItems) {
			expect(Object.keys(item.forkFiles).sort()).toEqual([CLAIMS_FILE, POINTER_FILE]);
			const claims = ClaimsFile.parse(JSON.parse(item.forkFiles[CLAIMS_FILE] as string));
			expect(claims.map((c) => c.subject).sort(), item.id).toEqual(item.dependencies.flatMap((d) => d.facetKeys).sort());
			for (const claim of claims) {
				const [recordId, version] = claim.basedOn.split("@");
				expect(Number(version), `${item.id} ${claim.subject}`).toBe(latest[recordId as string]?.version);
				expect(claim.value).toEqual(latest[recordId as string]?.facets[claim.subject]);
			}
			const pointer = JSON.parse(item.forkFiles[POINTER_FILE] as string);
			expect(pointer.workItem).toBe(item.id);
			expect(pointer.head === null || /^[0-9a-f]{40}$/.test(pointer.head)).toBe(true);
		}
	});

	it("points the shared brief at nothing, because it is not in git", () => {
		expect(JSON.parse(seed.workItems[4]?.forkFiles[POINTER_FILE] as string).head).toBeNull();
		expect(JSON.parse(seed.workItems[0]?.forkFiles[POINTER_FILE] as string).head).toBe("b3f0394243f67b6d671dcbdec979db49d82e2b0b");
	});

	it("says what a claim needs when the facet is not there", () => {
		expect(() => claimsAtLatest([{ recordId: "demo-identity", facetKeys: ["identity.nope"] }])).toThrow(/no facet identity.nope/);
	});

	it("names no person: the decision owner is the only human in the seed, and there are no addresses", () => {
		const text = JSON.stringify(seed);
		expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
		const humans = new Set([...text.matchAll(/(?:accepted_by|proposed_by|authority): \\?"?([a-z-]+)/g)].map((m) => m[1]));
		expect([...humans]).toEqual(["decision-owner"]);
	});

	it("the pointer routes take only a build cell's repos, and never write to a baseline", () => {
		const pointer = { workItem: "WI-8", head: null, note: "A new piece of work." };
		const base = "smoke-delta-convergence-build-live-1-baseline";
		const fork = "smoke-delta-convergence-build-live-1-wi-8";
		expect(PointerForkRequest.safeParse({ baseline: base, name: fork, claims: [], pointer }).success).toBe(true);
		expect(PointerPushRequest.safeParse({ repo: fork, claims: [], pointer }).success).toBe(true);
		const notBuild = "smoke-notifications-demo-1-wi-1";
		for (const bad of [
			{ repo: "production-wi-8", claims: [], pointer },
			{ repo: notBuild, claims: [], pointer }, // the recorded notifications demo
			{ repo: "smoke-m1-1-wi-1", claims: [], pointer },
			{ repo: base, claims: [], pointer }, // a baseline
			{ repo: fork, claims: [], pointer, files: { "src/x.ts": "x" } },
			{ repo: fork, claims: [], pointer: { ...pointer, head: "abc" } },
			{ repo: fork, claims: [{ subject: "x" }], pointer },
		]) {
			expect(PointerPushRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
		expect(PointerForkRequest.safeParse({ baseline: notBuild, name: fork, claims: [], pointer }).success).toBe(false);
		expect(PointerForkRequest.safeParse({ baseline: base, name: notBuild, claims: [], pointer }).success).toBe(false);
		expect(PointerForkRequest.safeParse({ baseline: base, name: base, claims: [], pointer }).success).toBe(false);
	});
});
