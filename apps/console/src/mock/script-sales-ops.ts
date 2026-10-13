import { parseContextRecord } from "contracts";
import { currentSnapshot } from "delta-core";
import type { SalesOpsScenario } from "scenario-sales-ops";
import type { Beat, MockScript } from "./beats";

/**
 * Scenario B, the same loop on knowledge work (video script segment 10). Northwind Field
 * Services is synthetic. The definition of a qualified lead changes mid-flight: the forecast and
 * the playbook go stale, the glossary does not. One is revalidated, one takes a scoped exception.
 */
export function salesOpsScript(bundle: SalesOpsScenario): MockScript {
	const v2 = bundle.docs.qualifiedLeadV2;
	const parsed = parseContextRecord(v2.text);
	const v2Prose = parsed.ok ? parsed.record.body.trim() : "";
	const exception = bundle.expected.resolutions["WI-3"];

	const beats: Beat[] = [
		{
			id: "start",
			title: "Three agents running",
			caption: "A forecast, a playbook and a glossary, each built from the definitions it was handed.",
			async run({ session, drip }) {
				await session.seedIfEmpty();
				await session.startAgents(["wi3", "wi4", "wi5"]);
				drip([
					["WI-3", "status", "Started. Receipt: qualified-lead@1"],
					["WI-4", "status", "Started. Receipt: qualified-lead@1, sales-activity@1"],
					["WI-5", "status", "Started. Receipt: sales-activity@1"],
					["WI-3", "tool", "Read .delta/context/definitions/qualified-lead.md"],
					["WI-4", "tool", "Read .delta/context/definitions/sales-activity.md"],
					["WI-3", "text", "Counting leads that filled the form and have 50 or more employees"],
					["WI-5", "tool", "Write docs/glossary.md"],
				]);
				return { select: "WI-3", tab: "receipt" };
			},
		},
		{
			id: "reword",
			title: "Reworded definition",
			caption: "Prose-only edit to qualified-lead. NO_ACTION, PROSE_ONLY. Nobody is paged.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), "qualified-lead");
				if (record && record.blobHash !== bundle.docs.qualifiedLeadV1.snapshot.blobHash) return undefined;
				await session.fixture("proseOnly");
				return { tab: "why" };
			},
		},
		{
			id: "draft-v2",
			title: "Draft the definition change",
			caption: "A qualified lead now also needs a verified budget signal. The editor opens prefilled.",
			async run({ drip }) {
				drip([["WI-4", "tool", "Write playbooks/sdr-priorities.md"]]);
				return {
					editor: {
						recordId: "qualified-lead",
						facets: v2.snapshot.facets,
						prose: v2Prose,
						rationale: "A qualified lead needs a verified budget signal (decision 2026-10-13).",
					},
				};
			},
		},
		{
			id: "commit-v2",
			title: "v2 lands: forecast and playbook stale",
			caption: "Two edges turn red. The glossary never used that definition, so it is left alone.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), "qualified-lead");
				if (record && record.version < 2) await session.fixture("v2");
				return { select: "WI-3", tab: "why" };
			},
		},
		{
			id: "agents-push",
			title: "Agents push their v1 work",
			caption: "Forecast and playbook cite qualified-lead@1: claim conflicts. The glossary is clean.",
			async run({ session, drip }) {
				const state = await session.cell.state();
				if (!state.workItems["WI-3"]?.headSha) {
					await session.fixture("wi3Pushed");
					await session.finishRun("WI-3");
				}
				if (!state.workItems["WI-4"]?.headSha) {
					await session.fixture("wi4Pushed");
					await session.finishRun("WI-4");
				}
				if (!state.workItems["WI-5"]?.headSha) {
					await session.fixture("wi5Pushed");
					await session.fixture("wi5Evidence");
					await session.finishRun("WI-5");
				}
				drip([
					["WI-3", "status", "Pushed reports/q4-forecast.md with claims based on qualified-lead@1"],
					["WI-4", "status", "Pushed playbooks/sdr-priorities.md with claims based on qualified-lead@1"],
					["WI-5", "status", "Pushed docs/glossary.md"],
				]);
				return { select: "WI-3", tab: "why" };
			},
		},
		{
			id: "exception",
			title: "Accept exception for the forecast",
			caption: "Grandfathered on v1 for the board deck. Scope and rationale are on the record.",
			async run({ session }) {
				const wi = (await session.cell.state()).workItems["WI-3"];
				if (wi && wi.resolutions.length === 0) {
					await session.resolveNow("accept-exception", "WI-3", "qualified-lead", "Q4 forecast is grandfathered on v1 for the board deck.", exception.scope);
				}
				return { select: "WI-3", tab: "actions" };
			},
		},
		{
			id: "revalidate",
			title: "Revalidate the playbook",
			caption: "WI-4 gets a fresh receipt at qualified-lead@2 and its agent is re-dispatched.",
			async run({ session, drip }) {
				const wi = (await session.cell.state()).workItems["WI-4"];
				if (wi && !wi.revalidating && wi.revalidations === 0) {
					await session.resolveNow("revalidate", "WI-4", "qualified-lead", "Definition changed: qualified-lead v1 to v2.");
				}
				drip([
					["WI-4", "status", "Revalidating: qualified-lead changed v1 to v2 (lead.qualified.criteria)"],
					["WI-4", "text", "Leads without a verified budget signal move to nurture"],
				]);
				return { select: "WI-4", tab: "why" };
			},
		},
		{
			id: "rerun-lands",
			title: "Re-run lands: claims match",
			caption: "The playbook now cites qualified-lead@2. Its check passes. Ready.",
			async run({ session, drip }) {
				await session.completeRerun("WI-4");
				drip([["WI-4", "status", "Pushed. Claims now based on qualified-lead@2"]]);
				return { select: "WI-4", tab: "semantic" };
			},
		},
		{
			id: "promote-all",
			title: "All three merge",
			caption: "Same gate, same ledger: glossary, excepted forecast and revalidated playbook.",
			async run({ session }) {
				for (const id of ["WI-5", "WI-3", "WI-4"]) await session.promoteNow(id);
				return { select: "WI-3", tab: "actions" };
			},
		},
	];

	return { id: "story", label: "Qualified-lead story", beats };
}
