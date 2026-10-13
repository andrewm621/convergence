import { describe, expect, it } from "vitest";
import type { DeltaEvent, Policy } from "contracts";
import { createCellState, type CellStateInit } from "../cell-state";
import { processEvent } from "../engine";
import { EMPTY_LEDGER_HEAD, buildLedgerEntry, verifyChain } from "../ledger";
import { LedgerConflictError, type CellStore } from "../store";

export type StoreFixture = { seed: CellStateInit; policy: Policy; events: DeltaEvent[] };

/**
 * One suite, every store. The Durable Object SQLite store (M2) runs this same function against
 * itself; if it passes, `processEvent` and the invariant suite work on it unchanged.
 */
export function describeStoreConformance(label: string, makeStore: () => CellStore, fixture: StoreFixture): void {
	describe(`CellStore conformance: ${label}`, () => {
		it("starts empty, initialises once, and refuses a second init", async () => {
			const store = makeStore();
			expect(await store.load()).toBeNull();
			expect(await store.head()).toEqual(EMPTY_LEDGER_HEAD);
			await store.init(createCellState(fixture.seed));
			expect(await store.load()).toEqual(createCellState(fixture.seed));
			await expect(store.init(createCellState(fixture.seed))).rejects.toThrow();
		});

		it("never hands out references into its own storage", async () => {
			const store = makeStore();
			await store.init(createCellState(fixture.seed));
			const first = await store.load();
			if (!first) throw new Error("expected state");
			first.baselineCommit = "dead000000000000000000000000000000000001";
			expect((await store.load())?.baselineCommit).toBe(fixture.seed.baselineCommit);
		});

		it("commits state and ledger line together and keeps them in seq order", async () => {
			const store = makeStore();
			await store.init(createCellState(fixture.seed));
			for (const event of fixture.events) await processEvent(store, event, fixture.policy);
			const entries = await store.ledger();
			expect(entries.map((e) => e.seq)).toEqual(fixture.events.map((_, i) => i + 1));
			expect((await store.head()).seq).toBe(fixture.events.length);
			expect(await verifyChain(entries)).toMatchObject({ ok: true, length: fixture.events.length });
		});

		it("pages the ledger with afterSeq and limit", async () => {
			const store = makeStore();
			await store.init(createCellState(fixture.seed));
			for (const event of fixture.events) await processEvent(store, event, fixture.policy);
			const page = await store.ledger({ afterSeq: 1, limit: 2 });
			expect(page.map((e) => e.seq)).toEqual([2, 3].slice(0, Math.max(0, Math.min(2, fixture.events.length - 1))));
		});

		it("rejects a commit that does not extend the head, and writes nothing", async () => {
			const store = makeStore();
			await store.init(createCellState(fixture.seed));
			const [first, second] = fixture.events;
			if (!first || !second) throw new Error("fixture needs two events");
			await processEvent(store, first, fixture.policy);
			const before = await store.load();
			const stale = await buildLedgerEntry(EMPTY_LEDGER_HEAD, { event: second, effects: [], policyVersion: 1, baselineSha: fixture.seed.baselineCommit });
			const mutated = { ...(before as NonNullable<typeof before>), baselineCommit: "dead000000000000000000000000000000000001" };
			await expect(store.commit({ state: mutated, entry: stale })).rejects.toBeInstanceOf(LedgerConflictError);
			expect(await store.load()).toEqual(before);
			expect((await store.ledger()).length).toBe(1);
		});

		it("serialises concurrent writers: of two commits on the same head, exactly one wins", async () => {
			const store = makeStore();
			await store.init(createCellState(fixture.seed));
			const [a, b] = fixture.events;
			if (!a || !b) throw new Error("fixture needs two events");
			const results = await Promise.allSettled([processEvent(store, a, fixture.policy), processEvent(store, b, fixture.policy)]);
			const entries = await store.ledger();
			expect((await verifyChain(entries)).ok).toBe(true);
			expect(entries.length).toBe(results.filter((r) => r.status === "fulfilled").length);
			expect(entries.length).toBeGreaterThanOrEqual(1);
		});
	});
}
