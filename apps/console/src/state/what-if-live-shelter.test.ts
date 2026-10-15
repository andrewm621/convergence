import { fakeSha, loadDoc, snapshotHashOf, type DeltaEvent, type Policy, type WorkItem } from "contracts";
import { buildReceipt, createCellState, currentSnapshot, reconcile, whatIf } from "delta-core";
import { SHELTER_POLICY_PATH, SHELTER_POLICY_V1_TYPO_FIXED, VOLUNTEER_ROLES_PATH, VOLUNTEER_ROLES_V1 } from "scenario-shelter-intake";
import { describe, expect, it } from "vitest";
import { baselineFor } from "@/test/baseline-for";
import { initialViewState, toCellState, type ViewState } from "./store";
import { compareOptions } from "./what-if";

/**
 * Guards the numbers the video script's row 10a speaks for the LIVE shelter act (docs/submission/video-script.md).
 *
 * The staged live cell `shelter-intake-rec1` has two work items, seeded by apps/worker/src/smoke-shelter.ts:
 *   SH-1 Front-desk intake script        relies on pets, id_required
 *   SH-2 Cots and blankets supply list   relies on capacity_note
 * The replay has five drafts and different numbers (compare-alternatives.test.tsx pins those). This builds the live
 * two-item state offline, the way the Worker does (registerWorkItem: buildReceipt over the declared records, declared
 * dependencies, status running), and asks the console adapter what each option would do. No Worker is contacted.
 */

const RECORD = "shelter-intake-policy";
// The Worker swaps the fixtures' coordinator for the demo identity that owns every record in the live cell.
const asDemoOwner = (text: string) => text.replaceAll("shelter-coordinator", "decision-owner");

const POLICY: Policy = {
	version: 1,
	authority: { "shelter-intake-policy": "decision-owner", "volunteer-roles": "decision-owner" },
	staleness: "facet",
	requires: [],
	maxRevalidations: 2,
};

const BASELINE = fakeSha("a", 1);
const ts = "2026-10-14T09:00:00Z";

function item(id: string, title: string, agentId: string, agentName: string, forkRepo: string, requires: WorkItem["requires"]): WorkItem {
	return { id, title, actor: { kind: "agent", id: agentId, displayName: agentName }, forkRepo, source: "live", intent: "delivery", requires, status: "running" };
}

/** The live cell, as the console would hold it: v1 accepted, SH-1 working, SH-2 pushed and ready. */
async function liveShelterView(options: { scriptPushed: boolean }): Promise<ViewState> {
	const policyDoc = await loadDoc(SHELTER_POLICY_PATH, asDemoOwner(SHELTER_POLICY_V1_TYPO_FIXED));
	const rolesDoc = await loadDoc(VOLUNTEER_ROLES_PATH, asDemoOwner(VOLUNTEER_ROLES_V1));
	let state = createCellState({ baselineCommit: BASELINE, snapshotHash: await snapshotHashOf([policyDoc.snapshot, rolesDoc.snapshot]), records: [policyDoc.snapshot, rolesDoc.snapshot] });

	const register = async (workItem: WorkItem, facetKeys: string[]): Promise<DeltaEvent> => ({
		type: "WorkItemRegistered",
		ts,
		item: workItem,
		receipt: await buildReceipt(state, { baselineCommit: state.baselineCommit, recordIds: [RECORD] }),
		dependencies: [{ workItemId: workItem.id, recordId: RECORD, facetKeys, basis: "declared", status: "accepted", evidenceRefs: [] }],
	});
	const facets = policyDoc.snapshot.facets;
	const events: DeltaEvent[] = [
		await register(item("SH-1", "Front-desk intake script", "agent-script", "Script agent", "smoke-sh-1", ["contract-test"]), ["pets", "id_required"]),
		await register(item("SH-2", "Cots and blankets supply list", "agent-supplies", "Supplies agent", "smoke-sh-2", []), ["capacity_note"]),
		{ type: "ForkPushed", ts, repo: "smoke-sh-2", commitSha: fakeSha("c", 2), workItemId: "SH-2", claims: [{ subject: "capacity_note", value: facets["capacity_note"], basedOn: `${RECORD}@1` }], contextPaths: [] },
	];
	if (options.scriptPushed) {
		events.push({
			type: "ForkPushed",
			ts,
			repo: "smoke-sh-1",
			commitSha: fakeSha("c", 1),
			workItemId: "SH-1",
			claims: [
				{ subject: "pets", value: facets["pets"], basedOn: `${RECORD}@1` },
				{ subject: "id_required", value: facets["id_required"], basedOn: `${RECORD}@1` },
			],
			contextPaths: [],
		});
	}
	for (const event of events) state = reconcile(state, event, POLICY).state;

	return { ...initialViewState, ready: true, scenario: "shelter-intake-rec1", baselineCommit: state.baselineCommit, snapshotHash: state.snapshotHash, policy: POLICY, records: state.records, workItems: state.workItems, dependencies: state.dependencies };
}

// Option A is the 6:04 edit; Option B changes the capacity note only (the example value compare-alternatives.test.tsx uses).
const PETS_V2 = "crated pets admitted, pet area in Hall B";
const ID_V2 = "ID not listed as a requirement";
const CAPACITY_B = "Hall A holds 100 cots; the shift lead decides on overflow";

describe.each([
	["SH-1 still working", { scriptPushed: false }],
	["SH-1 has pushed its draft", { scriptPushed: true }],
])("the live shelter act's compare alternatives (%s)", (_label, options) => {
	it("seeds the two live items the way the staged cell has them", async () => {
		const view = await liveShelterView(options);
		expect(Object.keys(view.workItems).sort()).toEqual(["SH-1", "SH-2"]);
		expect(view.workItems["SH-1"]?.item.title).toBe("Front-desk intake script");
		expect(view.workItems["SH-2"]?.item.title).toBe("Cots and blankets supply list");
		expect(view.workItems["SH-2"]?.item.status).toBe("ready");
		expect(view.dependencies.map((d) => [d.workItemId, d.facetKeys])).toEqual([
			["SH-1", ["pets", "id_required"]],
			["SH-2", ["capacity_note"]],
		]);
	});

	it("Option A (pets and ID, the 6:04 edit) blocks the intake script and leaves the supply list; Option B (capacity note only) blocks the supply list and leaves the script", async () => {
		const view = await liveShelterView(options);
		const current = currentSnapshot(toCellState(view), RECORD)!;
		const optionA = { ...current.facets, pets: PETS_V2, id_required: ID_V2 };
		const optionB = { ...current.facets, capacity_note: CAPACITY_B };

		const got = await compareOptions(view, RECORD, [
			{ id: "a", facets: optionA },
			{ id: "b", facets: optionB },
		]);
		expect(got?.map((o) => [o.candidateId, o.blockedCount, o.blockedIds])).toEqual([
			["a", 1, ["SH-1"]],
			["b", 1, ["SH-2"]],
		]);
		const titleOf = (id: string) => view.workItems[id]?.item.title;
		expect(got?.map((o) => o.blockedIds.map(titleOf))).toEqual([["Front-desk intake script"], ["Cots and blankets supply list"]]);
		expect(got?.map((o) => o.items.filter((i) => !i.blocked).map((i) => titleOf(i.workItemId)))).toEqual([["Cots and blankets supply list"], ["Front-desk intake script"]]);

		// The same verdicts from events built a different way (no shared code with the adapter).
		const truth = whatIf(toCellState(view), POLICY, [
			{ id: "a", change: await baselineFor(view, RECORD, optionA, "e".repeat(40)) },
			{ id: "b", change: await baselineFor(view, RECORD, optionB, "d".repeat(40)) },
		]);
		expect(got?.map((o) => o.blockedIds)).toEqual(truth.map((o) => o.blockedIds));
	});
});
