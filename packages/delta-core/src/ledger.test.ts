import { describe, expect, it } from "vitest";
import type { ReconciliationEvent } from "contracts";
import { EMPTY_LEDGER_HEAD, GENESIS_HASH, buildLedgerEntry, hashLedgerLine, verifyChain } from "./ledger";
import { notifications as n } from "./testing/scenarios";

async function chain(length: number): Promise<ReconciliationEvent[]> {
	const events = [n.events.registerWi1, n.events.registerWi2, n.events.v2, n.events.typoFix, n.events.wi1Pushed].slice(0, length);
	const entries: ReconciliationEvent[] = [];
	let head = EMPTY_LEDGER_HEAD;
	for (const event of events) {
		const entry = await buildLedgerEntry(head, { event, effects: [{ type: "NO_ACTION", reasonCodes: ["OBSERVATION_ONLY"] }], policyVersion: 1, baselineSha: n.commits.baselineV1 });
		entries.push(entry);
		head = { seq: entry.seq, hash: entry.hash };
	}
	return entries;
}

describe("ledger hash chain", () => {
	it("starts at genesis and links every line to the one before", async () => {
		const entries = await chain(4);
		expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
		expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
		for (let i = 1; i < entries.length; i++) expect(entries[i]?.prevHash).toBe(entries[i - 1]?.hash);
		expect(await verifyChain(entries)).toMatchObject({ ok: true, length: 4, head: { seq: 4, hash: entries[3]?.hash } });
	});

	it("an empty ledger verifies", async () => {
		expect(await verifyChain([])).toMatchObject({ ok: true, length: 0 });
	});

	it("is deterministic: the same inputs give the same hash, and time comes from the event", async () => {
		const a = await chain(3);
		const b = await chain(3);
		expect(a).toEqual(b);
		expect(a[2]?.ts).toBe(n.events.v2.ts);
	});

	it("verifies a tail against an anchor", async () => {
		const entries = await chain(5);
		const anchor = { seq: 2, hash: entries[1]?.hash as string };
		expect((await verifyChain(entries.slice(2), anchor)).ok).toBe(true);
		expect((await verifyChain(entries.slice(2), { ...anchor, hash: "3".repeat(64) })).ok).toBe(false);
	});

	it("a forger who recomputes the edited line's hash still breaks the next link", async () => {
		const entries = await chain(4);
		const forged = structuredClone(entries);
		const target = forged[1] as ReconciliationEvent;
		target.baselineSha = "dead000000000000000000000000000000000001";
		const { hash: _old, ...fields } = target;
		target.hash = await hashLedgerLine(fields);
		const verdict = await verifyChain(forged);
		expect(verdict).toMatchObject({ ok: false, brokenAtSeq: 3 });
	});

	it("a forger who rewrites the whole tail is caught by the head hash someone else holds", async () => {
		const entries = await chain(4);
		const rewritten = await (async () => {
			const out: ReconciliationEvent[] = [entries[0] as ReconciliationEvent];
			let head = { seq: 1, hash: (entries[0] as ReconciliationEvent).hash };
			for (const e of entries.slice(1)) {
				const entry = await buildLedgerEntry(head, { event: e.payload.event, effects: [], policyVersion: 1, baselineSha: "dead000000000000000000000000000000000001" });
				out.push(entry);
				head = { seq: entry.seq, hash: entry.hash };
			}
			return out;
		})();
		const original = await verifyChain(entries);
		const forgedChain = await verifyChain(rewritten);
		expect(original.ok && forgedChain.ok).toBe(true); // the forgery is internally consistent...
		if (original.ok && forgedChain.ok) expect(forgedChain.head.hash).not.toBe(original.head.hash); // ...but the published head differs
	});

	it("rejects a line that does not match the ledger schema", async () => {
		const entries = await chain(2);
		const bad = structuredClone(entries);
		(bad[1] as unknown as Record<string, unknown>).extra = "field";
		expect((await verifyChain(bad)).ok).toBe(false);
	});
});
