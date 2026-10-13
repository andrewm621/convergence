import { describe, expect, it } from "vitest";
import { SEED_SCENARIOS, SMOKE_LABEL_RE, SmokeDeleteRequest, deleteSmokeRepos, purgeSmokeRepos, seedLabelAllowed, seedScenarioAllowed } from "./smoke";

// A recorded demo's repos live beside every test run's `smoke-` repos. A run must delete its own by name and nothing else.

function fakeEnv(existing: string[]) {
	const repos = new Set(existing);
	const deleteCalls: string[] = [];
	const env = {
		ARTIFACTS: {
			delete: async (name: string) => {
				deleteCalls.push(name);
				return repos.delete(name);
			},
			list: async () => ({ repos: [...repos].map((name) => ({ name })), cursor: undefined }),
		},
	} as unknown as Env;
	return { env, repos, deleteCalls };
}

describe("DELETE /api/smoke: deleting by name", () => {
	const demo = ["smoke-notifications-demo-1-baseline", "smoke-notifications-demo-1-wi-1", "smoke-notifications-demo-1-wi-2"];
	const mine = ["smoke-m1-9-baseline", "smoke-m1-9-wi-1"];

	it("deletes exactly the named repos and leaves the demo's alone", async () => {
		const { env, repos, deleteCalls } = fakeEnv([...demo, ...mine, "other-repo"]);
		const result = await deleteSmokeRepos(env, mine);
		expect(result).toEqual({ deleted: mine, failed: [] });
		expect(deleteCalls).toEqual(mine);
		expect([...repos].sort()).toEqual([...demo, "other-repo"].sort());
	});

	it("reports a name that does not exist as failed, and deletes it once even if listed twice", async () => {
		const { env, deleteCalls } = fakeEnv(mine);
		const result = await deleteSmokeRepos(env, [mine[0] as string, mine[0] as string, "smoke-m1-gone"]);
		expect(result).toEqual({ deleted: [mine[0]], failed: ["smoke-m1-gone"] });
		expect(deleteCalls).toEqual([mine[0], "smoke-m1-gone"]);
	});

	it("refuses a name outside the smoke- prefix before deleting anything", async () => {
		const { env, repos, deleteCalls } = fakeEnv([...mine, "production-baseline"]);
		await expect(deleteSmokeRepos(env, [mine[0] as string, "production-baseline"])).rejects.toThrow(/not a smoke- repo/);
		expect(deleteCalls).toEqual([mine[0]]); // the guard is per name; the request schema rejects the whole list first
		expect(repos.has("production-baseline")).toBe(true);
	});

	it("the request body must be a non-empty list of smoke- repo names", () => {
		expect(SmokeDeleteRequest.safeParse({ repos: mine }).success).toBe(true);
		for (const bad of [null, {}, { repos: [] }, { repos: ["production-baseline"] }, { repos: ["smoke-ok", "other"] }, { repos: ["smoke-../x"] }, { repos: mine, all: true }, { prefix: "smoke-" }, { repos: "smoke-m1-9-baseline" }]) {
			expect(SmokeDeleteRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
	});

	it("only ?all=1 wipes by prefix, demo included", async () => {
		const { env, repos } = fakeEnv([...demo, ...mine, "other-repo"]);
		const result = await purgeSmokeRepos(env);
		expect(result.deleted.sort()).toEqual([...demo, ...mine].sort());
		expect([...repos]).toEqual(["other-repo"]);
	});
});

describe("seed label", () => {
	it("is a short lowercase name", () => {
		expect(SMOKE_LABEL_RE.test("notifications-demo")).toBe(true);
		for (const bad of ["", "-x", "x-", "Notifications", "a_b", "a/b", "a".repeat(41)]) expect(SMOKE_LABEL_RE.test(bad), bad).toBe(false);
	});

	it("only the build seed may take a label the pointer routes can reach", () => {
		expect(seedLabelAllowed("notifications", "delta-convergence-build-x")).toBe(false);
		expect(seedLabelAllowed(undefined, "delta-convergence-build")).toBe(false);
		expect(seedLabelAllowed("delta-convergence-build", "delta-convergence-build-live")).toBe(true);
		expect(seedLabelAllowed("notifications", "notifications-demo")).toBe(true);
		expect(seedLabelAllowed("notifications", undefined)).toBe(true);
	});

	it("lets the shelter seed take a shelter label, and refuses the build's labels there as for any other scenario", () => {
		expect(seedLabelAllowed("shelter-intake", "shelter-intake-demo")).toBe(true);
		expect(SMOKE_LABEL_RE.test("shelter-intake-demo")).toBe(true);
		expect(seedLabelAllowed("shelter-intake", "delta-convergence-build-x")).toBe(false);
	});
});

describe("seed scenario", () => {
	it("accepts the three seeds and the plain default, and nothing else", () => {
		expect([...SEED_SCENARIOS]).toEqual(["notifications", "shelter-intake", "delta-convergence-build"]);
		for (const ok of [undefined, "notifications", "shelter-intake", "delta-convergence-build"]) expect(seedScenarioAllowed(ok), String(ok)).toBe(true);
		for (const bad of ["", "sales-ops", "Shelter-Intake", "shelter", "toString", "__proto__", "notifications "]) expect(seedScenarioAllowed(bad), bad).toBe(false);
	});
});
