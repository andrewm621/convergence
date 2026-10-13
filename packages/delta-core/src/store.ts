import { CellState, ReconciliationEvent } from "contracts";
import { EMPTY_LEDGER_HEAD, type LedgerHead } from "./ledger";

/**
 * Where a cell keeps its state and ledger. The reconciler never touches a store; the engine
 * does. `commit` is atomic: the new state and the new ledger line land together or not at all.
 *
 * The Durable Object (SQLite) implementation arrives in M2 and drops in here. Anything that
 * satisfies the shared conformance suite (`testing/store-conformance`) is a valid store.
 */
export interface CellStore {
	/** The current state, or null before `init`. */
	load(): Promise<CellState | null>;
	/** Set the initial state. Throws if the cell was already initialised. */
	init(state: CellState): Promise<void>;
	/** Last ledger line's seq and hash; `EMPTY_LEDGER_HEAD` when the ledger is empty. */
	head(): Promise<LedgerHead>;
	/**
	 * Persist `state` and append `entry` atomically. Must reject with `LedgerConflictError` unless
	 * `entry` extends the current head (`seq === head.seq + 1` and `prevHash === head.hash`).
	 */
	commit(change: { state: CellState; entry: ReconciliationEvent }): Promise<void>;
	/** Ledger lines in seq order, after `afterSeq`, at most `limit`. */
	ledger(options?: { afterSeq?: number; limit?: number }): Promise<ReconciliationEvent[]>;
}

export class LedgerConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerConflictError";
	}
}

/** Reference store. It round-trips through structuredClone so callers can never alias stored state. */
export class InMemoryStore implements CellStore {
	#state: CellState | null = null;
	#ledger: ReconciliationEvent[] = [];

	async load(): Promise<CellState | null> {
		return this.#state === null ? null : structuredClone(this.#state);
	}

	async init(state: CellState): Promise<void> {
		if (this.#state !== null) throw new Error("cell already initialised");
		this.#state = structuredClone(CellState.parse(state));
	}

	async head(): Promise<LedgerHead> {
		const last = this.#ledger.at(-1);
		return last ? { seq: last.seq, hash: last.hash } : EMPTY_LEDGER_HEAD;
	}

	async commit({ state, entry }: { state: CellState; entry: ReconciliationEvent }): Promise<void> {
		const head = await this.head();
		if (entry.seq !== head.seq + 1 || entry.prevHash !== head.hash) {
			throw new LedgerConflictError(`entry ${entry.seq} does not extend the ledger head ${head.seq}`);
		}
		this.#state = structuredClone(CellState.parse(state));
		this.#ledger.push(structuredClone(entry));
	}

	async ledger(options: { afterSeq?: number; limit?: number } = {}): Promise<ReconciliationEvent[]> {
		const after = options.afterSeq ?? 0;
		return structuredClone(this.#ledger.filter((entry) => entry.seq > after).slice(0, options.limit ?? Number.POSITIVE_INFINITY));
	}
}
