import type { ScenarioName } from "@/client/types";
import { startMock } from "@/test/harness";
import { describe, expect, it } from "vitest";
import { processLanes, relativeTime, type ProcessLane, type ProcessModel } from "./process-lanes";

/** Replay a scenario `beats` steps in and read the Process model off the view the console would hold. */
async function modelAt(scenario: ScenarioName, beats: number): Promise<ProcessModel> {
	const mock = await startMock({ scenario });
	await mock.next(beats);
	const model = processLanes(mock.view);
	mock.stop();
	return model;
}

const laneOf = (model: ProcessModel, id: string): ProcessLane => {
	const lane = model.lanes.find((l) => l.workItemId === id);
	if (!lane) throw new Error(`no lane for ${id}`);
	return lane;
};
const kinds = (lane: ProcessLane) => lane.marks.map((m) => m.kind);
const redLanes = (model: ProcessModel) => model.lanes.filter((l) => l.marks.some((m) => m.tone === "danger")).map((l) => l.workItemId);

describe("an empty cell", () => {
	it("has nothing to draw", () => {
		expect(processLanes({ ledger: [], workItems: {} })).toEqual({ lanes: [], columns: [], decisions: [], empty: true });
	});

	it("is empty in the replay before the first step", async () => {
		expect((await modelAt("notifications", 0)).empty).toBe(true);
	});
});

describe("Scenario A, notifications", () => {
	it("after the agents start: two lanes with a run each, titles and agent names, no decision line, nothing red", async () => {
		const model = await modelAt("notifications", 1);
		expect(model.empty).toBe(false);
		expect(model.lanes.map((l) => l.workItemId)).toEqual(["WI-1", "WI-2"]);
		for (const lane of model.lanes) {
			expect(kinds(lane)).toEqual(["run"]);
			expect(lane.title.length).toBeGreaterThan(0);
			expect(lane.agent.length).toBeGreaterThan(0);
		}
		expect(laneOf(model, "WI-2").marks[0]?.detail).toEqual(["openai/gpt-6-luna"]);
		expect(model.decisions).toEqual([]);
		expect(redLanes(model)).toEqual([]);
	});

	it("a prose-only edit draws no decision line and marks no lane", async () => {
		const before = await modelAt("notifications", 1);
		const after = await modelAt("notifications", 2);
		expect(after.decisions).toEqual([]);
		expect(after.lanes.map(kinds)).toEqual(before.lanes.map(kinds));
	});

	it("right after v2 lands: one decision line, exactly one lane goes stale, the other stays clean", async () => {
		const model = await modelAt("notifications", 4);
		expect(model.decisions).toHaveLength(1);
		expect(model.decisions[0]).toMatchObject({ recordId: "notifications", from: 1, to: 2, label: "notifications v1 → v2" });
		expect(redLanes(model)).toEqual(["WI-2"]);

		const stale = laneOf(model, "WI-2").marks.find((m) => m.kind === "stale");
		expect(stale).toMatchObject({ tone: "danger", label: "went stale", detail: ["Setting changed"] });
		expect(stale?.reasonCodes).toContain("FACET_CHANGED");
		expect(stale?.column).toBe(model.decisions[0]?.column);
		expect(stale?.line).toMatchObject({ type: "BaselinePushed", seq: stale?.seq });

		const clean = laneOf(model, "WI-1");
		expect(kinds(clean)).toEqual(["run", "unaffected"]);
		expect(clean.marks.find((m) => m.kind === "unaffected")?.tone).toBe("muted");
		expect(clean.spans.filter((s) => s.kind === "blocked")).toEqual([]);

		// WI-2 is held from the decision's column to the right edge: nobody has acted yet.
		const held = laneOf(model, "WI-2").spans.filter((s) => s.kind === "blocked");
		expect(held).toEqual([{ kind: "blocked", from: model.decisions[0]?.column, to: model.columns.length - 1 }]);
	});

	it("after the agents push: WI-2 shows the claim conflict and the failing check; WI-1 pushes clean", async () => {
		const model = await modelAt("notifications", 5);
		expect(kinds(laneOf(model, "WI-2"))).toEqual(["run", "stale", "conflict", "check"]);
		const conflict = laneOf(model, "WI-2").marks.find((m) => m.kind === "conflict");
		expect(conflict?.reasonCodes).toContain("CLAIM_CONFLICT");
		expect(conflict?.detail[0]).toMatch(/^push [0-9a-f]{7}$/);
		expect(kinds(laneOf(model, "WI-1"))).toEqual(["run", "unaffected", "push"]);
		expect(laneOf(model, "WI-1").marks.find((m) => m.kind === "push")?.tone).toBe("neutral");
	});

	it("at the end: both merged, WI-2 was revalidated and re-run, and its hold ended at the sign-off", async () => {
		const model = await modelAt("notifications", 9);
		expect(kinds(laneOf(model, "WI-1")).at(-1)).toBe("merge");
		expect(kinds(laneOf(model, "WI-2"))).toEqual(["run", "stale", "conflict", "check", "resolution", "rerun", "push", "merge"]);
		for (const lane of model.lanes) expect(lane.marks.at(-1)).toMatchObject({ kind: "merge", tone: "success", label: "merged" });

		const wi2 = laneOf(model, "WI-2");
		const resolution = wi2.marks.find((m) => m.kind === "resolution");
		expect(resolution).toMatchObject({ tone: "info", label: "revalidate" });
		expect(resolution?.detail[0]).toBeTruthy();
		const held = wi2.spans.filter((s) => s.kind === "blocked");
		expect(held).toEqual([{ kind: "blocked", from: model.decisions[0]?.column, to: resolution?.column }]);
		expect(wi2.marks.find((m) => m.kind === "rerun")?.detail).toEqual(["openai/gpt-6-luna"]);
		expect(wi2.spans.filter((s) => s.kind === "running")).toHaveLength(2);
	});

	it("each mark sits in a column of its own ledger line, in ledger order, and columns carry a relative time", async () => {
		const model = await modelAt("notifications", 9);
		for (const lane of model.lanes) {
			for (const mark of lane.marks) expect(model.columns[mark.column]?.seq).toBe(mark.seq);
			expect(lane.marks.map((m) => m.seq)).toEqual([...lane.marks.map((m) => m.seq)].sort((a, b) => a - b));
		}
		expect(model.columns.map((c) => c.seq)).toEqual([...model.columns.map((c) => c.seq)].sort((a, b) => a - b));
		expect(new Set(model.columns.map((c) => c.seq)).size).toBe(model.columns.length);
		// Measured from the first line in view (the registrations), not from the first mark.
		for (const column of model.columns) expect(column.relative).toMatch(/^\+\d+:\d{2}$/);
	});
});

describe("Scenario B, sales-ops", () => {
	it("right after the definition changes: WI-3 and WI-4 go stale, WI-5 is untouched", async () => {
		const model = await modelAt("sales-ops", 4);
		expect(model.decisions.map((d) => d.label)).toEqual(["qualified-lead v1 → v2"]);
		expect(redLanes(model)).toEqual(["WI-3", "WI-4"]);
		for (const id of ["WI-3", "WI-4"]) expect(laneOf(model, id).marks.some((m) => m.kind === "stale")).toBe(true);
		expect(kinds(laneOf(model, "WI-5"))).toEqual(["run", "unaffected"]);
	});

	it("in the middle: the drafts conflict with v2 and the glossary is clean", async () => {
		const model = await modelAt("sales-ops", 5);
		expect(redLanes(model)).toEqual(["WI-3", "WI-4"]);
		expect(kinds(laneOf(model, "WI-3"))).toEqual(["run", "stale", "conflict"]);
		expect(kinds(laneOf(model, "WI-5"))).toEqual(["run", "unaffected", "push"]);
	});

	it("at the end: everything merged; the exception and the revalidation are each on their own lane; WI-5 never went red", async () => {
		const model = await modelAt("sales-ops", (await startMock({ scenario: "sales-ops" })).beats.length);
		for (const lane of model.lanes) expect(lane.marks.at(-1)?.kind).toBe("merge");
		expect(laneOf(model, "WI-3").marks.find((m) => m.kind === "resolution")?.label).toBe("exception");
		expect(kinds(laneOf(model, "WI-4"))).toContain("rerun");
		expect(laneOf(model, "WI-4").marks.find((m) => m.kind === "resolution")?.label).toBe("revalidate");
		expect(redLanes(model)).toEqual(["WI-3", "WI-4"]);
		expect(laneOf(model, "WI-5").marks.some((m) => m.tone === "danger")).toBe(false);
		expect(laneOf(model, "WI-5").spans.filter((s) => s.kind === "blocked")).toEqual([]);
		// Nothing is still held at the end.
		for (const lane of model.lanes) expect(lane.spans.filter((s) => s.kind === "blocked").every((s) => s.to < model.columns.length - 1)).toBe(true);
	});
});

describe("Scenario C, shelter intake", () => {
	it("draws both decision changes, and the exception lapses on the second", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.next(mock.beats.length);
		const model = processLanes(mock.view);
		mock.stop();
		expect(model.decisions.map((d) => d.label.replace(/^.* (v\d+ → v\d+)$/, "$1"))).toEqual(["v1 → v2", "v2 → v3"]);
		expect(model.lanes).toHaveLength(5);
		const lapsed = laneOf(model, "WI-2").marks.filter((m) => m.kind === "stale");
		expect(lapsed.at(-1)?.detail).toEqual(["Exception ended"]);
		// The two items the change never reached stay calm throughout.
		for (const id of ["WI-4", "WI-5"]) expect(laneOf(model, id).marks.some((m) => m.tone === "danger")).toBe(false);
	});
});

describe("relativeTime", () => {
	it("reads as minutes and seconds, and hours when long", () => {
		expect(relativeTime(0)).toBe("+0:00");
		expect(relativeTime(12_000)).toBe("+0:12");
		expect(relativeTime(245_000)).toBe("+4:05");
		expect(relativeTime(3_723_000)).toBe("+1:02:03");
		expect(relativeTime(Number.NaN)).toBeNull();
		expect(relativeTime(-5)).toBeNull();
	});
});
