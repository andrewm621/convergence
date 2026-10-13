import { describe, expect, it } from "vitest";
import { createCellState, processEvent, type CellStore } from "delta-core";
import { describeInvariants } from "delta-core/src/testing/invariants";
import { invariantScenarios, notifications } from "delta-core/src/testing/scenarios";
import { describeStoreConformance } from "delta-core/src/testing/store-conformance";
import { LedgerCorruptionError, SqliteCellStore } from "./sqlite-store";
import type { SqlDb } from "./sql";
import { nodeSqlite } from "./testing/node-sqlite";

// The shared suites, unchanged, against the SQLite store. Here on Node's SQLite (same SQL, no
// Workers runtime); the same suites run again inside workerd in sqlite-store.workerd.test.ts.
function makeStore(): CellStore {
	return new SqliteCellStore(nodeSqlite());
}

describeStoreConformance("SQLite store (node:sqlite)", makeStore, {
	seed: notifications.seed,
	policy: notifications.policy,
	events: [notifications.events.registerWi1, notifications.events.registerWi2, notifications.events.wi1Pushed, notifications.events.v2],
});

describeInvariants("SQLite store (node:sqlite)", makeStore, invariantScenarios);

const events = [notifications.events.registerWi1, notifications.events.registerWi2, notifications.events.wi1Pushed, notifications.events.v2, notifications.events.typoFix];

async function filled() {
	const db = nodeSqlite();
	const store = new SqliteCellStore(db);
	await store.init(createCellState(notifications.seed));
	for (const event of events) await processEvent(store, event, notifications.policy);
	return { db, store };
}

describe("SQLite store: ledger head and tamper evidence", () => {
	it("keeps the ledger head in its own row, written with each line", async () => {
		const { db, store } = await filled();
		const rows = db.all<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger_head");
		const last = (await store.ledger()).at(-1);
		expect(rows).toEqual([{ seq: events.length, hash: last?.hash }]);
		expect(await store.head()).toEqual({ seq: events.length, hash: last?.hash });
	});

	it("verifies an untouched chain", async () => {
		const { store } = await filled();
		expect(await store.verify()).toMatchObject({ ok: true, length: events.length });
	});

	it("reports ok:false and the seq when a stored line is edited", async () => {
		const { db, store } = await filled();
		const [row] = db.all<{ json: string }>("SELECT json FROM ledger WHERE seq = 3");
		db.all("UPDATE ledger SET json = ? WHERE seq = 3", (row?.json ?? "").replace(/"ts":"[^"]+"/, '"ts":"2031-01-01T00:00:00Z"'));
		expect(await store.verify()).toMatchObject({ ok: false, brokenAt: 3 });
	});

	it("reports a line whose hash column was edited, and unparseable lines", async () => {
		const { db, store } = await filled();
		db.all("UPDATE ledger SET hash = ? WHERE seq = 2", "9".repeat(64));
		expect(await store.verify()).toMatchObject({ ok: false, brokenAt: 2 });
		db.all("UPDATE ledger SET json = 'not json' WHERE seq = 4");
		expect(await store.verify()).toMatchObject({ ok: false });
	});

	it("catches a truncated tail, which a head derived from the last line would miss", async () => {
		const { db, store } = await filled();
		db.all("DELETE FROM ledger WHERE seq > ?", events.length - 2);
		// The remaining lines are a perfectly valid shorter chain...
		const remaining = await store.ledger();
		expect(remaining).toHaveLength(events.length - 2);
		// ...but the recorded head says otherwise.
		expect(await store.verify()).toMatchObject({ ok: false, brokenAt: events.length - 1 });
	});

	it("refuses to append after the tail was removed", async () => {
		const { db, store } = await filled();
		db.all("DELETE FROM ledger WHERE seq = ?", events.length);
		await expect(processEvent(store, notifications.events.wi2PushedV1, notifications.policy)).rejects.toBeInstanceOf(LedgerCorruptionError);
	});

	it("catches a lowered head row", async () => {
		const { db, store } = await filled();
		const [row] = db.all<{ hash: string }>("SELECT hash FROM ledger WHERE seq = 2");
		db.all("UPDATE ledger_head SET seq = 2, hash = ? WHERE id = 1", row?.hash);
		expect(await store.verify()).toMatchObject({ ok: false });
	});
});

describe("SQLite store: persistence", () => {
	it("a new store on the same database sees the same state, ledger and dedupe table", async () => {
		const { db, store } = await filled();
		const reopened = new SqliteCellStore(db);
		expect(await reopened.load()).toEqual(await store.load());
		expect(await reopened.ledger()).toEqual(await store.ledger());
		// Dedupe survived: a replay of the same push is a duplicate, and adds no line.
		const replay = await processEvent(reopened, notifications.events.v2, notifications.policy);
		expect(replay.outcome).toBe("duplicate");
		expect((await reopened.ledger()).length).toBe(events.length);
	});

	it("rewrites only the rows that changed", async () => {
		const { db, store } = await filled();
		const writes: string[] = [];
		const spy: SqlDb = { transaction: (fn) => db.transaction(fn), all: ((query: string, ...bindings: unknown[]) => (writes.push(query), db.all(query, ...bindings))) as SqlDb["all"] };
		const watched = new SqliteCellStore(spy);
		await processEvent(watched, notifications.events.wi2PushedV1, notifications.policy);
		const workItemWrites = writes.filter((q) => q.startsWith("INSERT OR REPLACE INTO cell_work_items"));
		const recordWrites = writes.filter((q) => q.startsWith("INSERT OR REPLACE INTO cell_records"));
		expect(workItemWrites.length).toBeGreaterThan(0);
		expect(workItemWrites.length).toBeLessThanOrEqual(2); // WI-2, and possibly a counterpart; never every item
		expect(recordWrites).toHaveLength(0);
	});
});
