import {
	ReconciliationEvent,
	canonicalJson,
	sha256Hex,
	type DeltaEvent,
	type Effect,
} from "contracts";

/** `prevHash` of the first ledger line. */
export const GENESIS_HASH = "0".repeat(64);

export type LedgerHead = { seq: number; hash: string };

export const EMPTY_LEDGER_HEAD: LedgerHead = { seq: 0, hash: GENESIS_HASH };

type HashedFields = Omit<ReconciliationEvent, "hash">;

/** The hash covers every field of the line except the hash itself, in canonical JSON. */
export async function hashLedgerLine(fields: HashedFields): Promise<string> {
	return sha256Hex(canonicalJson(fields));
}

export type LedgerAppend = {
	event: DeltaEvent;
	effects: Effect[];
	policyVersion: number;
	/** Baseline commit after the event was applied. */
	baselineSha: string;
};

/** Build the next line of the chain. Time comes from the event, never from a clock. */
export async function buildLedgerEntry(head: LedgerHead, input: LedgerAppend): Promise<ReconciliationEvent> {
	const fields: HashedFields = {
		seq: head.seq + 1,
		prevHash: head.hash,
		type: input.event.type,
		payload: { event: input.event, effects: input.effects },
		policyVersion: input.policyVersion,
		baselineSha: input.baselineSha,
		ts: input.event.ts,
	};
	return { ...fields, hash: await hashLedgerLine(fields) };
}

export type ChainVerdict =
	| { ok: true; length: number; head: LedgerHead }
	| { ok: false; brokenAtSeq: number; reason: string };

/**
 * Re-derive every hash and check every link. Fails at the first line that was edited, removed,
 * reordered or forged. Pass `anchor` to verify a tail that does not start at genesis.
 */
export async function verifyChain(entries: readonly ReconciliationEvent[], anchor: LedgerHead = EMPTY_LEDGER_HEAD): Promise<ChainVerdict> {
	let head = anchor;
	for (const [index, entry] of entries.entries()) {
		const shape = ReconciliationEvent.safeParse(entry);
		if (!shape.success) return { ok: false, brokenAtSeq: entry?.seq ?? index + 1, reason: "line does not match the ledger schema" };
		if (entry.seq !== head.seq + 1) return { ok: false, brokenAtSeq: entry.seq, reason: `expected seq ${head.seq + 1}` };
		if (entry.prevHash !== head.hash) return { ok: false, brokenAtSeq: entry.seq, reason: "prevHash does not match the previous line" };
		const { hash, ...fields } = entry;
		if ((await hashLedgerLine(fields)) !== hash) return { ok: false, brokenAtSeq: entry.seq, reason: "hash does not match the line contents" };
		head = { seq: entry.seq, hash: entry.hash };
	}
	return { ok: true, length: entries.length, head };
}
