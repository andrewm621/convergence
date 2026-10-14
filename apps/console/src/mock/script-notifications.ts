import { parseContextRecord } from "contracts";
import { currentSnapshot } from "delta-core";
import type { NotificationsScenario } from "scenario-notifications";
import type { Beat, MockScript } from "./beats";

/**
 * Scenario A, beat by beat (PRD section 6, video script segments 2 to 8). Every beat is
 * idempotent against the state it finds, so a presenter can also click the same action by hand
 * and the next beat simply sees it done.
 */
export function notificationsScript(bundle: NotificationsScenario): MockScript {
	const v2 = bundle.docs.notificationsV2.snapshot;
	const parsed = parseContextRecord(bundle.docs.notificationsV2.text);
	const v2Prose = parsed.ok ? parsed.record.body.trim() : "";

	const beats: Beat[] = [
		{
			id: "start",
			title: "Two agents running",
			caption: "Both forks hold receipts at v1. Each agent depends on different records.",
			async run({ session, drip }) {
				await session.seedIfEmpty();
				await session.startAgents(["wi1", "wi2"]);
				drip([
					["WI-1", "status", "Started on its own fork. Built on: status-model@1"],
					["WI-2", "status", "Started on its own fork. Built on: notifications@1, status-model@1"],
					["WI-1", "tool", "Read AGENTS.md"],
					["WI-2", "tool", "Read .delta/context/notifications.md"],
					["WI-1", "text", "Plan: status enum, badge component, status-change endpoint"],
					["WI-2", "text", "Building from notifications@1: updates are on by default and arrive immediately"],
					["WI-1", "tool", "Write src/status/badge.tsx"],
					["WI-2", "tool", "Write src/notifications/preferences.ts"],
				]);
				return { select: "WI-2", tab: "receipt" };
			},
		},
		{
			id: "typo",
			title: "Typo fix",
			caption: "Prose-only edit to notifications. NO_ACTION, PROSE_ONLY. Nothing goes red.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), "notifications");
				if (record && record.blobHash !== bundle.docs.notificationsV1.snapshot.blobHash) return undefined; // already edited or moved on
				await session.fixture("typoFix");
				return { tab: "why" };
			},
		},
		{
			id: "draft-v2",
			title: "Draft the decision change",
			caption: "The human edits the decision: opt-in, weekly digest. The editor opens prefilled.",
			async run({ drip }) {
				drip([
					["WI-1", "tool", "Edit src/api/status.ts"],
					["WI-2", "tool", "Write src/notifications/delivery.ts"],
				]);
				return {
					editor: {
						recordId: "notifications",
						facets: v2.facets,
						prose: v2Prose,
						rationale: "Notifications are opt-in with a weekly digest (decision 2026-10-13).",
					},
				};
			},
		},
		{
			id: "commit-v2",
			title: "v2 lands: WI-2 stale, WI-1 has no recorded dependency",
			caption: "Exactly one edge turns red. WI-1 is left alone, with a reason code.",
			async run({ session, drip }) {
				const record = currentSnapshot(await session.cell.state(), "notifications");
				if (record && record.version < 2) await session.fixture("v2");
				drip([["WI-2", "text", "Still building the settings page against default-on (it has not seen v2)"]]);
				return { select: "WI-2", tab: "why" };
			},
		},
		{
			id: "agents-push",
			title: "Claim conflict and failing check",
			caption: "WI-2 pushes. Its claims cite notifications@1, and Convergence's own check fails at its head.",
			async run({ session, drip }) {
				const state = await session.cell.state();
				if (!state.workItems["WI-1"]?.headSha) {
					await session.fixture("wi1Pushed");
					await session.fixture("wi1Evidence");
					await session.finishRun("WI-1");
				}
				if (!state.workItems["WI-2"]?.headSha) {
					await session.fixture("wi2PushedV1");
					await session.fixture("wi2FailsV2");
					await session.fixture("wi2StatusPass");
					await session.finishRun("WI-2");
				}
				drip([
					["WI-1", "status", "Pushed. Wrote .delta/claims.json (1 claim)"],
					["WI-2", "status", "Pushed. Wrote .delta/claims.json (3 claims, based on notifications@1)"],
				]);
				return { select: "WI-2", tab: "why" };
			},
		},
		{
			id: "promote-wi1",
			title: "WI-1 merges",
			caption: "Work with no recorded dependency on the change is not slowed down: WI-1 passes the gate and merges.",
			async run({ session }) {
				await session.promoteNow("WI-1");
				return { select: "WI-1", tab: "actions" };
			},
		},
		{
			id: "revalidate",
			title: "Revalidate WI-2",
			caption: "A human revalidates. Convergence issues a fresh receipt at notifications@2 and re-dispatches the agent.",
			async run({ session, drip }) {
				const wi = (await session.cell.state()).workItems["WI-2"];
				if (wi && !wi.revalidating && wi.revalidations === 0) {
					await session.resolveNow("revalidate", "WI-2", "notifications", "Decision changed under this work: notifications v1 to v2.");
				}
				drip([
					["WI-2", "status", "Revalidating: notifications changed v1 to v2 (notifications.default, notifications.cadence)"],
					["WI-2", "tool", "Read .delta/context/notifications.md (v2)"],
					["WI-2", "text", "Switching the default to opt-in and delivery to a weekly digest"],
					["WI-2", "tool", "Edit src/notifications/preferences.ts"],
					["WI-2", "tool", "Edit src/notifications/delivery.ts"],
				]);
				return { select: "WI-2", tab: "why" };
			},
		},
		{
			id: "rerun-lands",
			title: "Re-run lands: claims match",
			caption: "New claims cite notifications@2 and match the accepted facets. The check passes. Ready.",
			async run({ session, drip }) {
				await session.completeRerun("WI-2");
				drip([["WI-2", "status", "Pushed. Claims now based on notifications@2"]]);
				return { select: "WI-2", tab: "semantic" };
			},
		},
		{
			id: "promote-wi2",
			title: "WI-2 merges",
			caption: "Merge re-checks at the current heads, then merges. The baseline holds both changes.",
			async run({ session }) {
				await session.promoteNow("WI-2");
				return { select: "WI-2", tab: "actions" };
			},
		},
	];

	return { id: "story", label: "Notifications story", beats };
}
