import { CellState, DeltaEvent, Effect, Policy, ReasonCode } from "contracts";
import { describe, expect, it } from "vitest";
import { PROTOCOL, canonical, projectState, type Vector } from "../lib/project.ts";
import { loadVectors } from "../lib/runner.ts";

const vectors = loadVectors();
const RULES = ["R1", "R2", "R3", "R3b", "R4", "R5", "R6", "R7", "R8", "R9"];
const EFFECT_TYPES = new Set<string>(Effect.options.map((option) => option.shape.type.value));
const REASONS = new Set<string>(ReasonCode.options);

describe("vectors are well-formed", () => {
	it.each(vectors.map((v) => [v.id, v] as const))("%s: inputs satisfy the contracts, unchanged by parsing", (_id, v: Vector) => {
		expect(v.protocol).toBe(PROTOCOL);
		expect(v.rules.length).toBeGreaterThan(0);
		for (const rule of v.rules) expect(RULES).toContain(rule);
		expect(canonical(CellState.parse(v.given.state))).toBe(canonical(v.given.state));
		expect(canonical(Policy.parse(v.given.policy))).toBe(canonical(v.given.policy));
		expect(canonical(DeltaEvent.parse(v.when.event))).toBe(canonical(v.when.event));
		for (const effect of v.then.effects) {
			expect(EFFECT_TYPES.has(effect["type"] as string)).toBe(true);
			const code = effect["reasonCode"];
			if (code !== null) expect(REASONS.has(code as string)).toBe(true);
		}
	});

	it("every rule has at least one positive and one negative vector", () => {
		for (const rule of RULES) {
			const tagged = vectors.filter((v) => v.rules.includes(rule));
			expect(tagged.some((v) => v.polarity === "positive"), `${rule} positive`).toBe(true);
			expect(tagged.some((v) => v.polarity === "negative"), `${rule} negative`).toBe(true);
		}
	});

	it("ids are unique and match their file order", () => {
		const ids = vectors.map((v) => v.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(ids);
	});
});

describe("the worked example (PROTOCOL.md section 2) is one continuous sequence", () => {
	const steps = vectors.filter((v) => v.sequence?.name === "worked-example").sort((a, b) => (a.sequence?.step ?? 0) - (b.sequence?.step ?? 0));

	it("has numbered steps from 1 with no gaps", () => {
		expect(steps.length).toBeGreaterThan(5);
		expect(steps.map((v) => v.sequence?.step)).toEqual(steps.map((_, i) => i + 1));
	});

	it("each step starts where the previous one ended", () => {
		for (let i = 1; i < steps.length; i++) {
			const previous = steps[i - 1] as Vector;
			const current = steps[i] as Vector;
			expect(canonical(projectState(current.given.state)), current.id).toBe(canonical(previous.then.state));
		}
	});

	it("tells the story: WI-2 goes stale, is blocked, is revalidated and is promoted; WI-1 is left alone", () => {
		const status = (v: Vector, id: string) => v.then.state.workItems[id]?.status;
		const first = steps[0] as Vector;
		expect(status(first, "WI-2")).toBe("stale");
		expect(status(first, "WI-1")).toBe(projectState(first.given.state).workItems["WI-1"]?.status);
		expect(first.then.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-1", reasonCode: "NO_DEPENDENCY_ON_CHANGED_FACETS" }));
		const promotions = steps.filter((v) => (v.when.event as { type: string }).type === "PromotionRequested");
		expect(promotions.map((v) => v.then.effects.find((e) => e["type"] === "BLOCK_PROMOTION" || e["type"] === "ALLOW_PROMOTION")?.["type"])).toEqual(["BLOCK_PROMOTION", "ALLOW_PROMOTION"]);
		expect(steps.some((v) => v.then.effects.some((e) => e["type"] === "DISPATCH_WORK"))).toBe(true);
		expect(status(steps.at(-1) as Vector, "WI-2")).toBe("promoted");
	});
});
