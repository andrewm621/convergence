import { CellState, ReconciliationEvent } from "contracts";
import { EMPTY_LEDGER_HEAD, type LedgerHead } from "../ledger";
import { LedgerConflictError, type CellStore } from "../store";

/**
 * A second, independent `CellStore` for tests. It keeps state and ledger lines as JSON strings in
 * rows, the way the Durable Object's SQLite tables will, and it parses them back through the Zod
 * schemas on every read. Passing the shared suite against both this and `InMemoryStore` shows the
 * engine only needs what the interface promises and that every persisted value is plain JSON.
 */
export class SerializingStore implements CellStore {
	readonly #kv = new Map<string, string>();
	readonly #rows: string[] = [];

	async load(): Promise<CellState | null> {
		const raw = this.#kv.get("state");
		return raw === undefined ? null : CellState.parse(JSON.parse(raw));
	}

	async init(state: CellState): Promise<void> {
		if (this.#kv.has("state")) throw new Error("cell already initialised");
		this.#kv.set("state", JSON.stringify(CellState.parse(state)));
	}

	async head(): Promise<LedgerHead> {
		const last = this.#rows.at(-1);
		if (last === undefined) return EMPTY_LEDGER_HEAD;
		const entry = ReconciliationEvent.parse(JSON.parse(last));
		return { seq: entry.seq, hash: entry.hash };
	}

	async commit({ state, entry }: { state: CellState; entry: ReconciliationEvent }): Promise<void> {
		const head = await this.head();
		if (entry.seq !== head.seq + 1 || entry.prevHash !== head.hash) {
			throw new LedgerConflictError(`entry ${entry.seq} does not extend the ledger head ${head.seq}`);
		}
		// Serialise both before writing either, so a failure cannot leave half a commit behind.
		const stateJson = JSON.stringify(CellState.parse(state));
		const rowJson = JSON.stringify(ReconciliationEvent.parse(entry));
		this.#kv.set("state", stateJson);
		this.#rows.push(rowJson);
	}

	async ledger(options: { afterSeq?: number; limit?: number } = {}): Promise<ReconciliationEvent[]> {
		const after = options.afterSeq ?? 0;
		return this.#rows
			.map((row) => ReconciliationEvent.parse(JSON.parse(row)))
			.filter((entry) => entry.seq > after)
			.slice(0, options.limit ?? Number.POSITIVE_INFINITY);
	}
}
