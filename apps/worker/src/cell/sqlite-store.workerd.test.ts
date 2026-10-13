import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processEvent, createCellState } from "delta-core";
import { describeInvariants } from "delta-core/src/testing/invariants";
import { invariantScenarios, notifications } from "delta-core/src/testing/scenarios";
import { describeStoreConformance } from "delta-core/src/testing/store-conformance";
import { RemoteStore, startWorkerd, type Workerd } from "./testing/workerd";

// The shared suites against the SQLite store on REAL Durable Object storage, inside workerd.
let worker: Workerd;
let counter = 0;

beforeAll(async () => {
	worker = await startWorkerd();
}, 60_000);

afterAll(async () => {
	await worker?.dispose();
});

const makeStore = () => new RemoteStore(worker, `store-${++counter}`);

describeStoreConformance("SQLite store (Durable Object, workerd)", makeStore, {
	seed: notifications.seed,
	policy: notifications.policy,
	events: [notifications.events.registerWi1, notifications.events.registerWi2, notifications.events.wi1Pushed, notifications.events.v2],
});

describeInvariants("SQLite store (Durable Object, workerd)", makeStore, invariantScenarios);

describe("SQLite store on Durable Object storage: tamper evidence", () => {
	async function filled() {
		const store = makeStore();
		await store.init(createCellState(notifications.seed));
		for (const event of [notifications.events.registerWi1, notifications.events.registerWi2, notifications.events.v2]) {
			await processEvent(store, event, notifications.policy);
		}
		return store;
	}

	it("verifies an untouched chain, and reports an edited line", async () => {
		const store = await filled();
		expect(await store.verify()).toMatchObject({ ok: true, length: 3 });
		await store.sql("UPDATE ledger SET json = replace(json, 'WI-1', 'WI-9') WHERE seq = 1");
		expect(await store.verify()).toMatchObject({ ok: false, brokenAt: 1 });
	});

	it("reports a truncated tail even though the remaining lines chain correctly", async () => {
		const store = await filled();
		await store.sql("DELETE FROM ledger WHERE seq = 3");
		expect(await store.ledger()).toHaveLength(2);
		expect(await store.verify()).toMatchObject({ ok: false, brokenAt: 3 });
	});
});
