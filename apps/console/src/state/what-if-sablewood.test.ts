import { buildSalesOpsScenario } from "scenario-sales-ops";
import { createCellState, currentSnapshot, reconcile, whatIf } from "delta-core";
import { describe, expect, it } from "vitest";
import { baselineFor } from "@/test/baseline-for";
import { initialViewState, toCellState, type ViewState } from "./store";
import { compareOptions } from "./what-if";

/**
 * Guards the numbers the Sablewood act's compare alternatives shows (the replay, `?mock=1&scenario=sales-ops`).
 *
 * At the "Draft the definition change" beat three items are running, built on the v1 definitions:
 *   WI-3 Q4 pipeline forecast    relies on lead.qualified.criteria, lead.qualified.min-employees
 *   WI-4 SDR weekly priorities   relies on lead.qualified.criteria (and sales-activity)
 *   WI-5 Activity glossary       relies on sales-activity only
 * Option A is the story's v2, as the editor opens prefilled (criteria now need a verified budget signal, and the signal is required).
 * Option B puts the criteria back to v1 and makes the new signal optional: nothing relies on it, so nothing is blocked.
 * Option C is B plus a size bar of 100 employees: only the forecast counts employees, so only the forecast is blocked.
 * The editor cannot drop a prefilled setting, so B and C keep `verified-budget-signal` and set it to "optional".
 */

const RECORD = "qualified-lead";

/** The replay's state at the draft beat: seeded, three agents registered, the wording-only edit made. */
async function draftBeatView(): Promise<ViewState> {
	const s = await buildSalesOpsScenario();
	let state = createCellState(s.seed);
	for (const event of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5, s.events.proseOnly]) state = reconcile(state, event, s.policy).state;
	return { ...initialViewState, ready: true, scenario: "sales-ops", baselineCommit: state.baselineCommit, snapshotHash: state.snapshotHash, policy: s.policy, records: state.records, workItems: state.workItems, dependencies: state.dependencies };
}

describe("the Sablewood act's compare alternatives", () => {
	it("Option A (verified budget, the story's v2) blocks the forecast and the playbook; B (budget optional) blocks nothing; C (100 employees) blocks the forecast only", async () => {
		const s = await buildSalesOpsScenario();
		const view = await draftBeatView();
		expect(Object.fromEntries(Object.values(view.workItems).map((wi) => [wi.item.id, wi.item.title]))).toEqual({
			"WI-3": "Q4 pipeline forecast",
			"WI-4": "SDR weekly priorities",
			"WI-5": "Activity glossary",
		});
		const current = currentSnapshot(toCellState(view), RECORD)!;
		expect(current.facets).toEqual({
			"lead.qualified.criteria": "form-fill-and-50-plus-employees",
			"lead.qualified.min-employees": 50,
			"lead.qualified.requires-form-fill": true,
		});
		// Option A is what the editor opens prefilled with at the draft beat.
		const optionA = s.docs.qualifiedLeadV2.snapshot.facets;
		expect(optionA).toEqual({ ...current.facets, "lead.qualified.criteria": "form-fill-50-plus-employees-and-verified-budget", "lead.qualified.verified-budget-signal": "required" });
		const optionB = { ...current.facets, "lead.qualified.verified-budget-signal": "optional" };
		const optionC = { ...optionB, "lead.qualified.min-employees": 100 };

		const got = await compareOptions(view, RECORD, [
			{ id: "a", facets: optionA },
			{ id: "b", facets: optionB },
			{ id: "c", facets: optionC },
		]);
		expect(got?.map((o) => [o.candidateId, o.blockedCount, o.blockedIds])).toEqual([
			["a", 2, ["WI-3", "WI-4"]],
			["b", 0, []],
			["c", 1, ["WI-3"]],
		]);
		const titleOf = (id: string) => view.workItems[id]?.item.title;
		expect(got?.map((o) => o.items.filter((i) => !i.blocked).map((i) => titleOf(i.workItemId)))).toEqual([["Activity glossary"], ["Q4 pipeline forecast", "SDR weekly priorities", "Activity glossary"], ["SDR weekly priorities", "Activity glossary"]]);

		// The same verdicts from events built a different way (no shared code with the adapter).
		const truth = whatIf(toCellState(view), s.policy, [
			{ id: "a", change: await baselineFor(view, RECORD, optionA, "e".repeat(40)) },
			{ id: "b", change: await baselineFor(view, RECORD, optionB, "d".repeat(40)) },
			{ id: "c", change: await baselineFor(view, RECORD, optionC, "c".repeat(40)) },
		]);
		expect(got?.map((o) => o.blockedIds)).toEqual(truth.map((o) => o.blockedIds));
	});
});
