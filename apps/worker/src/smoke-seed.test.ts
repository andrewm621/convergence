import { describe, expect, it, vi } from "vitest";

// seedForks against a fake Artifacts: forks one at a time, and a failure part-way deletes everything it created.

const state = vi.hoisted(() => ({ repos: new Set<string>(), inFlight: 0, maxInFlight: 0, failFork: "" }));

vi.mock("./artifacts/git-write", () => ({
	commitFiles: async () => undefined,
	errorCode: () => undefined,
	sleep: async () => undefined,
	getRepo: async () => ({
		fork: async (name: string) => {
			state.inFlight++;
			state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
			await new Promise((r) => setTimeout(r, 5));
			state.inFlight--;
			if (name === state.failFork) throw new Error("An internal error occurred.");
			state.repos.add(name);
			return { token: "t", remote: `https://example.invalid/${name}.git` };
		},
		revokeToken: async () => true,
		[Symbol.dispose]: () => undefined,
	}),
}));

const { seedForks } = await import("./smoke");

function fakeEnv() {
	return {
		ARTIFACTS: {
			create: async (name: string) => {
				state.repos.add(name);
				return { token: "t", remote: `https://example.invalid/${name}.git` };
			},
			get: async () => ({ info: async () => ({}), [Symbol.dispose]: () => undefined }),
			delete: async (name: string) => state.repos.delete(name),
		},
	} as unknown as Env;
}

function reset(failFork = "") {
	state.repos.clear();
	state.inFlight = 0;
	state.maxInFlight = 0;
	state.failFork = failFork;
}

describe("seedForks", () => {
	it("creates the baseline and every fork, one fork at a time", async () => {
		reset();
		const seeded = await seedForks(fakeEnv(), 7, { "a.md": "x" }, "lbl");
		expect(seeded.forks).toHaveLength(7);
		expect(state.repos.size).toBe(8);
		expect(state.maxInFlight).toBe(1);
	});

	it("deletes the baseline and the forks it made when a fork fails, then rethrows", async () => {
		reset();
		const env = fakeEnv();
		const create = (env as unknown as { ARTIFACTS: { create: (n: string) => Promise<unknown> } }).ARTIFACTS.create;
		// The names embed Date.now(), so pick the failing fork once the baseline name is known.
		(env as unknown as { ARTIFACTS: { create: (n: string) => Promise<unknown> } }).ARTIFACTS.create = async (name: string) => {
			state.failFork = name.replace(/-baseline$/, "-wi-4");
			return create(name);
		};
		await expect(seedForks(env, 7, { "a.md": "x" }, "lbl")).rejects.toThrow("An internal error occurred.");
		expect([...state.repos]).toEqual([]);
	});
});
