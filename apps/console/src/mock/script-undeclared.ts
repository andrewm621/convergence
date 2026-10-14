import { claims, commits, type NotificationsScenario } from "scenario-notifications";
import { currentSnapshot } from "delta-core";
import type { Beat, MockScript } from "./beats";

/**
 * The live Sonnet run, replayed: WI-1 reads notifications.md although it was only given status-model,
 * and cites notifications@1. Convergence holds it (the claim relies on a record the receipt never
 * carried) until a human accepts or rejects that dependency. Rejecting it frees WI-1 to merge, and
 * the decision change that follows then leaves WI-1 alone and blocks only WI-2.
 */
export function undeclaredScript(bundle: NotificationsScenario): MockScript {
	const beats: Beat[] = [
		{
			id: "start",
			title: "Two agents running",
			caption: "WI-1 is given status-model only. WI-2 is given notifications and status-model.",
			async run({ session, drip }) {
				await session.seedIfEmpty();
				await session.startAgents(["wi1", "wi2"]);
				drip([
					["WI-1", "status", "Started on its own fork. Built on: status-model@1"],
					["WI-2", "status", "Started on its own fork. Built on: notifications@1, status-model@1"],
				]);
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "agents-push",
			title: "WI-1 cites a decision it was not given",
			caption: "WI-1 read notifications.md on its own and cites notifications@1. It is held until a person decides.",
			async run({ session, drip }) {
				const state = await session.cell.state();
				if (!state.workItems["WI-1"]?.headSha) {
					await session.cell.send({ ...bundle.events.wi1Pushed, claims: claims.wi1Undeclared } as typeof bundle.events.wi1Pushed);
					await session.fixture("wi1Evidence");
					await session.finishRun("WI-1");
				}
				if (!state.workItems["WI-2"]?.headSha) {
					await session.fixture("wi2PushedV1");
					await session.fixture("wi2StatusPass");
					await session.finishRun("WI-2");
				}
				drip([
					["WI-1", "tool", "Read context/notifications.md"],
					["WI-1", "status", "Pushed. Wrote .delta/claims.json (2 claims, one based on notifications@1)"],
					["WI-2", "status", "Pushed. Wrote .delta/claims.json (3 claims, based on notifications@1)"],
				]);
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "reject-dependency",
			title: "Reject the inferred dependency",
			caption: "The decision owner says WI-1 does not rely on notifications. The hold clears and WI-1 is ready.",
			async run({ session }) {
				await session.decideDependencyNow("reject", "WI-1", "notifications");
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "commit-v2",
			title: "v2 lands: WI-2 blocked, WI-1 left alone",
			caption: "Only WI-2 depends on the changed decision. WI-1 is not slowed down.",
			async run({ session, drip }) {
				const record = currentSnapshot(await session.cell.state(), "notifications");
				if (record && record.version < 2) await session.fixture("v2");
				drip([["WI-2", "text", "Still building against default-on (it has not seen v2)"]]);
				return { select: "WI-2", tab: "why" };
			},
		},
		{
			id: "promote-wi1",
			title: "WI-1 merges",
			caption: "WI-1 passes the check at the current heads and merges. WI-2 stays blocked.",
			async run({ session }) {
				await session.promoteNow("WI-1");
				return { select: "WI-1", tab: "actions" };
			},
		},
	];

	return { id: "undeclared", label: "Held on an undeclared dependency", beats };
}
