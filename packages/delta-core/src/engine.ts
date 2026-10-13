import { DeltaEvent, type Effect, type Policy, type ReconciliationEvent } from "contracts";
import { buildLedgerEntry } from "./ledger";
import { classifyEvent, reconcile } from "./reconcile";
import { LedgerConflictError, type CellStore } from "./store";

export type ProcessResult =
	| { outcome: "applied"; effects: Effect[]; entry: ReconciliationEvent }
	/** R9: already processed. State and ledger are untouched, so a replay yields no second ledger line. */
	| { outcome: "duplicate"; effects: Effect[]; entry: null }
	/** The Idempotency-Key was reused with a different request. Nothing is written; callers answer 409. */
	| { outcome: "idempotency-conflict"; effects: Effect[]; entry: null };

const MAX_ATTEMPTS = 3;

/**
 * Apply one event to a cell: validate it, reconcile, and append exactly one ledger line, with
 * the new state, in a single atomic commit. The Durable Object serialises calls per cell; as a
 * second line of defence the store rejects a commit that does not extend the ledger head, and a
 * writer that loses that race re-reads and tries again, so no update is ever applied to a stale state.
 */
export async function processEvent(store: CellStore, input: unknown, policy: Policy): Promise<ProcessResult> {
	const event = DeltaEvent.parse(input);
	for (let attempt = 1; ; attempt++) {
		if (attempt > 10) throw new Error("processEvent: the ledger head kept moving; giving up");
		const head = await store.head();
		const state = await store.load();
		if (state === null) throw new Error("cell is not initialised");
		const recheck = await store.head();
		if (recheck.seq !== head.seq || recheck.hash !== head.hash) continue; // a commit landed between the reads

		const verdict = classifyEvent(state, event);
		const { state: next, effects } = reconcile(state, event, policy);
		if (verdict === "duplicate") return { outcome: "duplicate", effects, entry: null };
		if (verdict === "idempotency-conflict") return { outcome: "idempotency-conflict", effects, entry: null };

		const entry = await buildLedgerEntry(head, { event, effects, policyVersion: policy.version, baselineSha: next.baselineCommit });
		try {
			await store.commit({ state: next, entry });
		} catch (error) {
			if (error instanceof LedgerConflictError && attempt < MAX_ATTEMPTS) continue;
			throw error;
		}
		return { outcome: "applied", effects, entry };
	}
}
