import { currentSnapshot, whatIf } from "delta-core";
import { describe, expect, it } from "vitest";
import { baselineFor } from "@/test/baseline-for";
import type { UiHint } from "@/mock/beats";
import { startMock } from "@/test/harness";
import { previewImpact } from "./derive";
import { stillBlocked, toCellState } from "./store";
import { compareOptions } from "./what-if";

type Mock = Awaited<ReturnType<typeof startMock>>;
type Scenario = "notifications" | "shelter-intake" | "sales-ops";

async function playToDraft(mock: Mock): Promise<NonNullable<UiHint["editor"]>> {
	let draft: UiHint["editor"] | undefined;
	const stop = mock.client.controls.onUi((hint) => {
		if (hint.editor) draft = hint.editor;
	});
	for (let i = 0; i < mock.beats.length && !draft; i++) await mock.next();
	stop();
	if (!draft) throw new Error("the script never opens the editor");
	return draft;
}

const SHA = (n: number) => n.toString(16).padStart(40, "e");

describe("compareOptions asks the real engine", () => {
	it("gives the shelter policy's two candidates the same verdicts as whatIf on independently built events", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		const draft = await playToDraft(mock);
		const view = mock.view;
		const current = currentSnapshot(toCellState(view), draft.recordId);
		const optionA = draft.facets; // the story's change: pets and id_required
		const optionB = { ...(current?.facets ?? {}), capacity_note: "Hall A holds 100 cots; the shift lead decides on overflow" };

		const got = await compareOptions(view, draft.recordId, [
			{ id: "a", facets: optionA },
			{ id: "b", facets: optionB },
		]);
		const expected = whatIf(toCellState(view), view.policy!, [
			{ id: "a", change: await baselineFor(view, draft.recordId, optionA, SHA(1)) },
			{ id: "b", change: await baselineFor(view, draft.recordId, optionB, SHA(2)) },
		]);

		expect(got).not.toBeNull();
		// The decision change blocks three; a capacity-only change blocks the one list that relies on it.
		expect(got?.map((o) => o.blockedIds)).toEqual([["WI-1", "WI-2", "WI-3"], ["WI-4"]]);
		expect(got?.map((o) => o.items.map((i) => [i.workItemId, i.status, i.blocked, i.reasonCodes]))).toEqual(expected.map((o) => o.items.map((i) => [i.workItemId, i.status, i.blocked, i.reasonCodes])));
		expect(got?.map((o) => o.blockedCount)).toEqual(expected.map((o) => o.blockedCount));
		mock.stop();
	});

	it("matches what committing the option for real does, and changes nothing while previewing", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		const draft = await playToDraft(mock);
		const before = mock.view;
		const [outcome] = (await compareOptions(before, draft.recordId, [{ id: "a", facets: draft.facets }])) ?? [];
		// Previewing wrote nothing: the ledger has not moved.
		expect(mock.view.ledgerHead).toEqual(before.ledgerHead);
		expect(mock.view.baselineCommit).toBe(before.baselineCommit);

		const prose = await mock.client.api.readRecordText(draft.recordId);
		const result = await mock.client.api.proposeContextChange({ recordId: draft.recordId, facets: draft.facets, prose, rationale: "compare check" }, "compare-check-1");
		expect(result).toMatchObject({ ok: true });
		const committed = Object.values(mock.view.workItems).filter((wi) => stillBlocked(wi)).map((wi) => wi.item.id).sort();
		expect(outcome?.blockedIds).toEqual(committed);
		mock.stop();
	});

	it("answers that nothing changes for an option equal to the accepted version", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		const draft = await playToDraft(mock);
		const current = currentSnapshot(toCellState(mock.view), draft.recordId);
		const [outcome] = (await compareOptions(mock.view, draft.recordId, [{ id: "same", facets: current?.facets ?? {} }])) ?? [];
		expect(outcome?.blockedCount).toBe(0);
		mock.stop();
	});
});

describe("previewImpact agrees with whatIf", () => {
	it.each<Scenario>(["notifications", "shelter-intake", "sales-ops"])("the %s decision change: the work previewImpact blocks is the work whatIf blocks", async (scenario) => {
		const mock = await startMock({ scenario });
		const draft = await playToDraft(mock);
		const view = mock.view;
		const impact = previewImpact(view, draft.recordId, draft.facets);
		const [outcome] = (await compareOptions(view, draft.recordId, [{ id: "draft", facets: draft.facets }])) ?? [];
		if (!impact || !outcome) throw new Error("no preview");
		const live = new Set(Object.values(view.workItems).filter((wi) => wi.item.status !== "promoted" && wi.item.status !== "rejected").map((wi) => wi.item.id));
		const engine = outcome.blockedIds.filter((id) => live.has(id)).sort();
		// previewImpact names the work this decision blocks and, separately, work already blocked on another decision: whatIf counts both as blocked.
		expect([...impact.blocked, ...impact.blockedElsewhere].map((b) => b.id).sort()).toEqual(engine);
		expect(impact.leftAlone.map((b) => b.id).sort()).toEqual([...live].filter((id) => !engine.includes(id)).sort());
		mock.stop();
	});
});
