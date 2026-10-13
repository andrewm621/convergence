import { buildFanOut, type NotificationsScenario } from "scenario-notifications";
import { currentSnapshot } from "delta-core";
import type { Beat, MockScript } from "./beats";

export const FANOUT_COUNT = 40;

/**
 * The fan-out beat (PRD section 6 step 9, video script segment 9): forty seeded work items hold
 * receipts against the same records, one decision changes, and the reconciler evaluates all of
 * them at once. They are synthetic and labelled "seeded" everywhere they appear.
 */
export function fanoutScript(bundle: NotificationsScenario): MockScript {
	const beats: Beat[] = [
		{
			id: "seed",
			title: `${FANOUT_COUNT} seeded work items`,
			caption: "Synthetic items, no model behind them. Each holds a receipt against the same records.",
			async run({ session, cell }) {
				if (Object.keys((await cell.state()).workItems).length > 0) return undefined;
				await session.seedIfEmpty();
				const state = await cell.state();
				const notifications = currentSnapshot(state, "notifications");
				const statusModel = currentSnapshot(state, "status-model");
				if (!notifications || !statusModel) return undefined;
				const { registrations } = await buildFanOut(FANOUT_COUNT, state.baselineCommit, { notifications, statusModel }, "2026-10-13T15:00:00Z");
				for (const event of registrations) await cell.send(event, { stepSeconds: 0.05 });
				return {};
			},
		},
		{
			id: "change",
			title: "One decision changes",
			caption: "notifications v2 is evaluated across every item: a few go stale, the rest are left alone.",
			async run({ session }) {
				const record = currentSnapshot(await session.cell.state(), "notifications");
				if (record && record.version < 2) await session.fixture("v2");
				return {};
			},
		},
		{
			id: "stale-item",
			title: "Open a stale item",
			caption: "It depends on a facet that changed. The reason codes say which.",
			async run() {
				return { select: "SEED-001", tab: "why" };
			},
		},
		{
			id: "untouched-item",
			title: "Open an untouched item",
			caption: "Same record, but it relies on a facet v2 left alone. Left alone, with a reason code.",
			async run() {
				return { select: "SEED-003", tab: "why" };
			},
		},
	];
	void bundle;
	return { id: "fanout", label: `Fan-out (${FANOUT_COUNT} seeded)`, beats };
}
