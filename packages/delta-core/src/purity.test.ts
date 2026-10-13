import { describe, expect, it } from "vitest";
import { deepFreeze } from "./testing/deep-freeze";
import { createCellState } from "./cell-state";
import { reconcile } from "./reconcile";
import { notifications as n, salesOps as s } from "./testing/scenarios";

// Raw source of every non-test, non-testing file in delta-core.
const modules = (import.meta as unknown as { glob: (pattern: string[], options: { query: string; import: string; eager: boolean }) => Record<string, string> }).glob(
	["./*.ts", "!./*.test.ts"],
	{ query: "?raw", import: "default", eager: true },
);

describe("delta-core is pure", () => {
	it("has the sources to scan", () => {
		expect(Object.keys(modules).length).toBeGreaterThan(8);
	});

	const forbidden: Array<[string, RegExp]> = [
		["a clock (Date.now / new Date / performance.now)", /Date\.now|new Date\b|performance\.now/],
		["randomness", /Math\.random|crypto\.randomUUID|getRandomValues/],
		["timers", /\bsetTimeout\b|\bsetInterval\b|queueMicrotask/],
		["network", /\bfetch\(|XMLHttpRequest|WebSocket/],
		["Node I/O or process", /from "node:|require\(|\bprocess\./],
		["Cloudflare types or bindings", /cloudflare:|DurableObject|@cloudflare|KVNamespace|R2Bucket|D1Database|ExecutionContext|\benv\./],
		["an LLM or model SDK", /anthropic|openai|\bclaude\b|\bllm\b/i],
	];

	for (const [what, pattern] of forbidden) {
		it(`uses no ${what}`, () => {
			const offenders = Object.entries(modules)
				.filter(([, source]) => pattern.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
				.map(([file]) => file);
			expect(offenders).toEqual([]);
		});
	}

	it("only imports contracts and itself", () => {
		const imports = Object.values(modules).flatMap((source) => [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string));
		const foreign = imports.filter((spec) => !spec.startsWith("./") && spec !== "contracts");
		expect(foreign).toEqual([]);
	});
});

describe("reconcile is a pure function", () => {
	const flows = [
		{ label: "notifications", seed: n.seed, policy: n.policy, events: [n.events.registerWi1, n.events.registerWi2, n.events.wi1Pushed, n.events.typoFix, n.events.v2, n.events.wi2PushedV1, n.events.wi2FailsV2] },
		{ label: "sales-ops", seed: s.seed, policy: s.policy, events: [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5, s.events.v2, s.events.wi3Pushed, s.events.wi5Pushed] },
	];

	for (const flow of flows) {
		it(`never mutates its inputs (${flow.label})`, () => {
			let state = deepFreeze(createCellState(flow.seed));
			const policy = deepFreeze(structuredClone(flow.policy));
			for (const event of flow.events) {
				// Frozen inputs: any write inside reconcile throws in strict mode.
				const result = reconcile(state, deepFreeze(structuredClone(event)), policy);
				state = deepFreeze(result.state);
			}
			expect(Object.keys(state.workItems).length).toBeGreaterThan(0);
		});

		it(`is deterministic: the same inputs give the same state and effects (${flow.label})`, () => {
			const run = () => {
				let state = createCellState(flow.seed);
				const all: unknown[] = [];
				for (const event of flow.events) {
					const result = reconcile(state, event, flow.policy);
					state = result.state;
					all.push(result.effects);
				}
				return { state, all };
			};
			expect(run()).toEqual(run());
		});

		it(`keeps its state plain JSON (${flow.label})`, () => {
			let state = createCellState(flow.seed);
			for (const event of flow.events) state = reconcile(state, event, flow.policy).state;
			expect(JSON.parse(JSON.stringify(state))).toEqual(state);
		});
	}

	it("takes time from the event: shifting every timestamp shifts only timestamps", () => {
		const run = (shift: string) => {
			let state = createCellState(n.seed);
			for (const event of [n.events.registerWi1, n.events.registerWi2, n.events.v2]) state = reconcile(state, { ...event, ts: shift }, n.policy).state;
			return JSON.stringify(state).replaceAll(shift, "T");
		};
		expect(run("2040-01-01T00:00:00Z") === run("2041-02-02T00:00:00Z")).toBe(true);
	});
});
