import { parseContextRecord } from "contracts";
import { currentSnapshot } from "delta-core";
import type { SalesOpsScenario } from "scenario-sales-ops";
import type { Beat, MockScript } from "./beats";

/**
 * Scenario B, the same loop on knowledge work (video script segment 10). Sablewood is a
 * fictional software company. The definition of a qualified lead changes mid-flight: the forecast and
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
			caption: "A Q4 pipeline forecast, an SDR playbook and an activity glossary, each built from the definitions it was handed.",
			async run({ session, drip }) {
				await session.seedIfEmpty();
				await session.startAgents(["wi3", "wi4", "wi5"]);
				drip([
					["WI-3", "status", "Started. Built on: qualified-lead@1"],
					["WI-4", "status", "Started. Built on: qualified-lead@1, sales-activity@1"],
					["WI-5", "status", "Started. Built on: sales-activity@1"],
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
			title: "Definition reworded",
			caption: "The qualified-lead wording changes but no setting moves. Nothing goes red and nobody is paged.",
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
			title: "v2 lands: forecast and playbook blocked",
			caption: "Both were built on qualified-lead v1, so both are held. The glossary never used that definition, so it is left alone.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), "qualified-lead");
				if (record && record.version < 2) await session.fixture("v2");
				return { select: "WI-3", tab: "why" };
			},
		},
		{
			id: "agents-push",
			title: "Drafts come in",
			caption: "The forecast and the playbook still count leads the v1 way, so they conflict with v2. The glossary is clean.",
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
					["WI-3", "status", "Handed in reports/q4-forecast.md, built on qualified-lead@1"],
					["WI-4", "status", "Handed in playbooks/sdr-priorities.md, built on qualified-lead@1"],
					["WI-5", "status", "Handed in docs/glossary.md"],
				]);
				return { select: "WI-3", tab: "why" };
			},
		},
		{
			id: "exception",
			title: "Allow the forecast with an exception",
			caption: "The Q4 board deck already uses this forecast, so it stays on v1. The exception covers reports/q4-forecast.md only, and the reason is on the record.",
			async run({ session }) {
				const wi = (await session.cell.state()).workItems["WI-3"];
				if (wi && wi.resolutions.length === 0) {
					await session.resolveNow("accept-exception", "WI-3", "qualified-lead", "The Q4 board deck already uses this forecast. It stays on v1 until the definition changes again.", exception.scope);
				}
				return { select: "WI-3", tab: "actions" };
			},
		},
		{
			id: "revalidate",
			title: "Revalidate the playbook",
			caption: "Its agent is sent back with qualified-lead v2 and told exactly what changed.",
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
			caption: "The playbook now counts leads the v2 way, built on qualified-lead v2. Its checks pass. Ready to merge.",
			async run({ session, drip }) {
				await session.completeRerun("WI-4");
				drip([["WI-4", "status", "Handed in a new draft, built on qualified-lead@2"]]);
				return { select: "WI-4", tab: "semantic" };
			},
		},
		{
			id: "promote-all",
			title: "All three merge",
			caption: "Same gate, same audit log: the untouched glossary, the forecast on its exception and the revalidated playbook.",
			async run({ session }) {
				for (const id of ["WI-5", "WI-3", "WI-4"]) await session.promoteNow(id);
				return { select: "WI-3", tab: "actions" };
			},
		},
	];

	return { id: "story", label: "Qualified-lead story", beats };
}
