import { buildFanOut, seededId } from "scenario-notifications";
import { describe, expect, it } from "vitest";
import { createCellState } from "./cell-state";
import { reconcile } from "./reconcile";
import { summarizeEffects } from "./summary";
import { notifications as n } from "./testing/scenarios";
import { createCell, conditionTypes } from "./testing/harness";

const heads = { notifications: n.docs.notificationsV1.snapshot, statusModel: n.docs.statusModelV1.snapshot };

describe("fan-out: one decision change over many seeded work items", () => {
	it("one decision change over 50 seeded items stales only the items that depend on the changed facets", async () => {
		const fan = await buildFanOut(50, n.commits.baselineV1, heads, "2026-10-13T15:00:00Z");
		const cell = await createCell(n.seed, n.policy);
		for (const registration of fan.registrations) await cell.send(registration);
		const before = await cell.state();
		expect(Object.keys(before.workItems)).toHaveLength(50);
		expect(Object.values(before.workItems).every((wi) => wi.item.source === "seeded")).toBe(true);

		const result = await cell.send(n.events.v2);
		const after = await cell.state();

		// Exactly the 10 items whose declared facets changed are stale, each with its own facets.
		const staleIds = Object.values(after.workItems)
			.filter((wi) => conditionTypes(wi).includes("Stale"))
			.map((wi) => wi.item.id)
			.sort();
		expect(staleIds).toEqual([...fan.expectedStale].sort());
		expect(staleIds).toHaveLength(10);
		expect(after.workItems[seededId(0)]?.conditions.find((c) => c.type === "Stale")?.facetKeys).toEqual(["notifications.default"]);
		expect(after.workItems[seededId(1)]?.conditions.find((c) => c.type === "Stale")?.facetKeys).toEqual(["notifications.cadence"]);

		// The other 40 are byte-identical to before, and each says why it was left alone.
		const untouchedIds = Object.keys(before.workItems).filter((id) => !staleIds.includes(id));
		expect(untouchedIds).toHaveLength(40);
		for (const id of untouchedIds) {
			expect(after.workItems[id]).toEqual(before.workItems[id]);
			const effects = result.effects.filter((e) => "workItemId" in e && e.workItemId === id);
			expect(effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] })]);
		}

		// The results strip.
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 50, stale: 10, untouched: 40 });
		// The whole change is one ledger line.
		expect((await cell.store.ledger()).filter((e) => e.type === "BaselinePushed")).toHaveLength(1);
	});

	it("a facet the seeded work depends on that did not change leaves it untouched, even on the same record", async () => {
		const fan = await buildFanOut(50, n.commits.baselineV1, heads, "2026-10-13T15:00:00Z");
		const cell = await createCell(n.seed, n.policy);
		for (const registration of fan.registrations) await cell.send(registration);
		await cell.send(n.events.v2);
		// SEED-003 (index 2) depends on notifications.channel only; notifications changed, channel did not.
		expect(conditionTypes((await cell.wi(seededId(2))))).toEqual(["Fresh"]);
	});

	it("a prose-only edit over 50 seeded items touches none of them", async () => {
		const fan = await buildFanOut(50, n.commits.baselineV1, heads, "2026-10-13T15:00:00Z");
		const cell = await createCell(n.seed, n.policy);
		for (const registration of fan.registrations) await cell.send(registration);
		const before = await cell.state();
		const result = await cell.send(n.events.typoFix);
		expect((await cell.state()).workItems).toEqual(before.workItems);
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 0, stale: 0, untouched: 0 });
	});

	it("evaluates 300 seeded items in well under a second", async () => {
		const fan = await buildFanOut(300, n.commits.baselineV1, heads, "2026-10-13T15:00:00Z");
		let state = createCellState(n.seed);
		for (const registration of fan.registrations) {
			if (registration.type !== "WorkItemRegistered") continue;
			state = reconcile(state, registration, n.policy).state;
		}
		const started = performance.now();
		const result = reconcile(state, n.events.v2, n.policy);
		const elapsed = performance.now() - started;
		expect(summarizeEffects(result.effects)).toEqual({ evaluated: 300, stale: 60, untouched: 240 });
		expect(elapsed).toBeLessThan(1000);
	});
});
