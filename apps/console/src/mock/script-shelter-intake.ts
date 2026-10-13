import { parseContextRecord } from "contracts";
import { currentSnapshot } from "delta-core";
import type { ShelterIntakeScenario } from "scenario-shelter-intake";
import type { Beat, MockScript } from "./beats";

/**
 * The shelter scenario, knowledge work with no software in it. Synthetic scenario. Not operational guidance.
 * Larkhaven County and its river flood are invented. Five agents draft volunteer materials from one
 * intake policy; the policy changes mid-flight. Three drafts go stale, two are never touched.
 * The signage takes a scoped exception, the script and the briefing are revalidated. Four drafts
 * promote; before the signage does, the last beat moves the policy to v3 and its exception lapses on its own.
 */
export function shelterIntakeScript(bundle: ShelterIntakeScenario): MockScript {
	const v2 = bundle.docs.policyV2;
	const parsed = parseContextRecord(v2.text);
	const v2Prose = parsed.ok ? parsed.record.body.trim() : "";
	const exception = bundle.expected.resolutions["WI-2"];
	const RECORD = "shelter-intake-policy";

	const beats: Beat[] = [
		{
			id: "start",
			title: "Five drafting agents",
			caption: "A front-desk script, door signage, a volunteer briefing, a supply list and a shift schedule, each drafted from the intake policy as it stands.",
			async run({ session, drip }) {
				await session.seedIfEmpty();
				await session.startAgents(["wi1", "wi2", "wi3", "wi4", "wi5"]);
				drip([
					["WI-1", "status", "Started. Built on: shelter-intake-policy@1"],
					["WI-2", "status", "Started. Built on: shelter-intake-policy@1"],
					["WI-3", "status", "Started. Built on: shelter-intake-policy@1"],
					["WI-4", "status", "Started. Built on: shelter-intake-policy@1"],
					["WI-5", "status", "Started. Built on: shelter-intake-policy@1, volunteer-roles@1"],
					["WI-1", "tool", "Read .delta/context/policies/shelter-intake-policy.md"],
					["WI-1", "text", "Drafting the welcome, ID and pets lines for the front desk"],
					["WI-4", "tool", "Write supplies/cots-and-blankets.md"],
				]);
				return { select: "WI-1", tab: "receipt" };
			},
		},
		{
			id: "reword",
			title: "Typo fixed in the welcome text",
			caption: "Prose-only edit to the intake policy. NO_ACTION, PROSE_ONLY. Nothing goes red and nobody is paged.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), RECORD);
				if (record && record.blobHash !== bundle.docs.policyV1.snapshot.blobHash) return undefined;
				await session.fixture("proseOnly");
				return { tab: "why" };
			},
		},
		{
			id: "draft-v2",
			title: "Draft the policy change",
			caption: "In this fictional exercise, the policy record changes: crated pets are included, with a pet area in Hall B, and ID is no longer listed as a requirement. The editor opens prefilled.",
			async run({ drip }) {
				drip([["WI-3", "tool", "Write briefing/one-pager.md"]]);
				return {
					editor: {
						recordId: RECORD,
						facets: v2.snapshot.facets,
						prose: v2Prose,
						rationale: "Crated pets are included and ID is no longer listed as a requirement (fictional decision, 2026-10-13).",
					},
				};
			},
		},
		{
			id: "commit-v2",
			title: "v2 lands: three drafts stale",
			caption: "The script, the signage and the briefing depend on what changed. The supply list and the shift schedule do not, so they are left alone.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), RECORD);
				if (record && record.version < 2) await session.fixture("v2");
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "drafts-in",
			title: "Drafts come in",
			caption: "The script, signage and briefing still say what v1 said, so their claims conflict. Delta Convergence's own check fails the script.",
			async run({ session, drip }) {
				const state = await session.cell.state();
				const handIn = async (id: string, key: string, withEvidence: boolean) => {
					if (state.workItems[id]?.headSha) return;
					await session.fixture(`${key}Pushed`);
					if (withEvidence) await session.fixture(`${key}Evidence`);
					await session.finishRun(id);
				};
				await handIn("WI-1", "wi1", true);
				await handIn("WI-2", "wi2", false);
				await handIn("WI-3", "wi3", true);
				await handIn("WI-4", "wi4", true);
				await handIn("WI-5", "wi5", true);
				drip([
					["WI-1", "status", "Handed in scripts/front-desk.md, built on shelter-intake-policy@1"],
					["WI-2", "status", "Handed in signs/door.md, built on shelter-intake-policy@1"],
					["WI-3", "status", "Handed in briefing/one-pager.md, built on shelter-intake-policy@1"],
					["WI-4", "status", "Handed in supplies/cots-and-blankets.md"],
					["WI-5", "status", "Handed in schedule/shifts.md"],
				]);
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "exception",
			title: "Scoped exception for the door signage",
			caption: "Existing printed signs stay posted until replacements arrive. The exception covers signs/door.md only and expires on the next policy version.",
			async run({ session }) {
				const wi = (await session.cell.state()).workItems["WI-2"];
				if (wi && wi.resolutions.length === 0) await session.resolveNow("accept-exception", "WI-2", RECORD, exception.rationale, exception.scope);
				return { select: "WI-2", tab: "actions" };
			},
		},
		{
			id: "revalidate",
			title: "Revalidate the script and the briefing",
			caption: "Each gets a fresh receipt at shelter-intake-policy@2 and its agent is sent back to reconcile its draft.",
			async run({ session, drip }) {
				for (const id of ["WI-1", "WI-3"]) {
					const wi = (await session.cell.state()).workItems[id];
					if (wi && !wi.revalidating && wi.revalidations === 0) {
						await session.resolveNow("revalidate", id, RECORD, "Policy changed: shelter-intake-policy v1 to v2 (pets, id_required).");
					}
				}
				drip([
					["WI-1", "status", "Revalidating: shelter-intake-policy changed v1 to v2 (pets, id_required)"],
					["WI-1", "text", "Pets: crated pets are included, pet area in Hall B. ID is not listed as a requirement"],
					["WI-3", "status", "Revalidating: shelter-intake-policy changed v1 to v2 (pets, id_required)"],
				]);
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "rerun-lands",
			title: "Re-runs land: claims match",
			caption: "Both drafts now cite shelter-intake-policy@2, and the script mentions the pet area. The check passes. Ready.",
			async run({ session, drip }) {
				await session.completeRerun("WI-1");
				await session.completeRerun("WI-3");
				drip([
					["WI-1", "status", "Handed in a new draft. Claims now based on shelter-intake-policy@2"],
					["WI-3", "status", "Handed in a new draft. Claims now based on shelter-intake-policy@2"],
				]);
				return { select: "WI-1", tab: "semantic" };
			},
		},
		{
			id: "promote-all",
			title: "Four go through",
			caption: "Same gate, same ledger: two untouched drafts and two revalidated drafts. The signage is cleared by its exception but has not gone through yet.",
			async run({ session }) {
				for (const id of ["WI-4", "WI-5", "WI-1", "WI-3"]) await session.promoteNow(id);
				return { select: "WI-1", tab: "actions" };
			},
		},
		{
			id: "lapse",
			title: "Policy moves to v3: the exception lapses",
			caption: "A new version ends the exception automatically.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), RECORD);
				if (record && record.version < 3) await session.fixture("v3");
				return { select: "WI-2", tab: "actions" };
			},
		},
	];

	return { id: "story", label: "Shelter rules story", beats };
}
