import { CellState, ReconciliationEvent, canonicalJson } from "contracts";
import { EMPTY_LEDGER_HEAD, LedgerConflictError, verifyChain, type CellStore, type LedgerHead } from "delta-core";
import type { SqlDb } from "./sql";

// CellStore on SQLite (Durable Object storage, or any SqlDb).
//
// Layout: the cell state is split across rows so a commit rewrites only what changed (one work
// item, one record) instead of the whole state. The dedupe table (R9) and the ledger are rows too.
// The ledger head is its own row, written in the same transaction as the line it points at. It is
// never derived from the last ledger row: otherwise deleting the tail would look like a valid,
// shorter chain. Commit and verify both compare the two.

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS cell_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS cell_records (record_id TEXT PRIMARY KEY, json TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS cell_work_items (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS cell_processed (dedupe_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, hash TEXT NOT NULL, prev_hash TEXT NOT NULL, json TEXT NOT NULL)",
	"CREATE INDEX IF NOT EXISTS ledger_by_type ON ledger (type, seq)",
	"CREATE TABLE IF NOT EXISTS ledger_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL)",
];

const CORE = "core";
const DEPENDENCIES = "dependencies";

export class LedgerCorruptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerCorruptionError";
	}
}

export type LedgerVerdict = { ok: true; length: number; head: LedgerHead } | { ok: false; brokenAt: number; reason: string };

export function migrateStoreSchema(db: SqlDb): void {
	for (const statement of SCHEMA) db.all(statement);
}

type Core = Pick<CellState, "schemaVersion" | "baselineCommit" | "snapshotHash">;

export class SqliteCellStore implements CellStore {
	readonly #db: SqlDb;
	// What the tables hold, as canonical JSON, so commit can skip rows that did not change.
	// Filled lazily; only updated after a transaction succeeded.
	#warm = false;
	#records = new Map<string, string>();
	#workItems = new Map<string, string>();
	#processed = new Map<string, string>();
	#core: string | null = null;
	#dependencies: string | null = null;

	constructor(db: SqlDb) {
		this.#db = db;
		migrateStoreSchema(db);
	}

	async load(): Promise<CellState | null> {
		const coreRow = this.#kv(CORE);
		if (coreRow === null) return null;
		const records = this.#db.all<{ record_id: string; json: string }>("SELECT record_id, json FROM cell_records");
		const workItems = this.#db.all<{ id: string; json: string }>("SELECT id, json FROM cell_work_items");
		const processed = this.#db.all<{ dedupe_key: string; fingerprint: string }>("SELECT dedupe_key, fingerprint FROM cell_processed");
		const dependenciesRow = this.#kv(DEPENDENCIES) ?? "[]";
		this.#remember({ core: coreRow, dependencies: dependenciesRow, records, workItems, processed });
		const core = JSON.parse(coreRow) as Core;
		// Parsing through the schema on every read means a corrupted or hand-edited row fails closed.
		return CellState.parse({
			...core,
			records: Object.fromEntries(records.map((row) => [row.record_id, JSON.parse(row.json)])),
			workItems: Object.fromEntries(workItems.map((row) => [row.id, JSON.parse(row.json)])),
			dependencies: JSON.parse(dependenciesRow),
			processed: Object.fromEntries(processed.map((row) => [row.dedupe_key, row.fingerprint])),
		});
	}

	async init(state: CellState): Promise<void> {
		const checked = CellState.parse(state);
		this.#db.transaction(() => {
			if (this.#kv(CORE) !== null) throw new Error("cell already initialised");
			this.#write(checked, null);
			this.#db.all("INSERT OR REPLACE INTO ledger_head (id, seq, hash) VALUES (1, ?, ?)", EMPTY_LEDGER_HEAD.seq, EMPTY_LEDGER_HEAD.hash);
		});
		this.#warm = false;
	}

	async head(): Promise<LedgerHead> {
		return this.#readHead();
	}

	async commit({ state, entry }: { state: CellState; entry: ReconciliationEvent }): Promise<void> {
		const checkedState = CellState.parse(state);
		const checkedEntry = ReconciliationEvent.parse(entry);
		this.#db.transaction(() => {
			this.#assertHeadMatchesLedger();
			const head = this.#readHead();
			if (checkedEntry.seq !== head.seq + 1 || checkedEntry.prevHash !== head.hash) {
				throw new LedgerConflictError(`entry ${checkedEntry.seq} does not extend the ledger head ${head.seq}`);
			}
			if (!this.#warm) this.#warmUp();
			this.#write(checkedState, checkedEntry);
		});
		// Only now is it safe to treat the written rows as what the tables hold.
		this.#warm = false;
	}

	async ledger(options: { afterSeq?: number; limit?: number } = {}): Promise<ReconciliationEvent[]> {
		const rows = this.#db.all<{ json: string }>("SELECT json FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?", options.afterSeq ?? 0, options.limit ?? -1);
		return rows.map((row) => ReconciliationEvent.parse(JSON.parse(row.json)));
	}

	/** The seq of the newest ledger line of this type, or null. */
	latestSeqOfType(type: string): number | null {
		return this.#db.all<{ seq: number }>("SELECT seq FROM ledger WHERE type = ? ORDER BY seq DESC LIMIT 1", type)[0]?.seq ?? null;
	}

	/**
	 * Re-derive every hash and link from the stored lines, then compare the end of the chain with
	 * the head row. An edited line breaks at its own seq; a truncated tail breaks at the first
	 * missing seq.
	 */
	async verify(): Promise<LedgerVerdict> {
		const head = this.#readHead();
		const rows = this.#db.all<{ seq: number; hash: string; prev_hash: string; json: string }>("SELECT seq, hash, prev_hash, json FROM ledger ORDER BY seq");
		const entries: ReconciliationEvent[] = [];
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.json);
			} catch {
				return { ok: false, brokenAt: row.seq, reason: "ledger row is not valid JSON" };
			}
			const line = parsed as Partial<ReconciliationEvent> | null;
			if (line?.seq !== row.seq || line?.hash !== row.hash || line?.prevHash !== row.prev_hash) {
				return { ok: false, brokenAt: row.seq, reason: "ledger row columns disagree with the stored line" };
			}
			entries.push(parsed as ReconciliationEvent);
		}
		const chain = await verifyChain(entries);
		if (!chain.ok) return { ok: false, brokenAt: chain.brokenAtSeq, reason: chain.reason };
		if (chain.head.seq !== head.seq || chain.head.hash !== head.hash) {
			return {
				ok: false,
				brokenAt: Math.min(chain.head.seq, head.seq) + 1,
				reason: `ledger ends at seq ${chain.head.seq} but its recorded head is seq ${head.seq} (lines were removed or the head was edited)`,
			};
		}
		return { ok: true, length: entries.length, head: chain.head };
	}

	// ---------- internals ----------

	#kv(key: string): string | null {
		const rows = this.#db.all<{ value: string }>("SELECT value FROM cell_kv WHERE key = ?", key);
		return rows[0]?.value ?? null;
	}

	#readHead(): LedgerHead {
		const rows = this.#db.all<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger_head WHERE id = 1");
		const row = rows[0];
		return row ? { seq: row.seq, hash: row.hash } : EMPTY_LEDGER_HEAD;
	}

	/** The head row and the last ledger line must agree. Cheap (one indexed read), so it runs on every commit. */
	#assertHeadMatchesLedger(): void {
		const head = this.#readHead();
		const last = this.#db.all<{ seq: number; hash: string }>("SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1")[0];
		const lastHead = last ? { seq: last.seq, hash: last.hash } : EMPTY_LEDGER_HEAD;
		if (lastHead.seq !== head.seq || lastHead.hash !== head.hash) {
			throw new LedgerCorruptionError(`ledger head row says seq ${head.seq} but the last ledger line is seq ${lastHead.seq}; refusing to append`);
		}
	}

	#remember(rows: {
		core: string;
		dependencies: string;
		records: Array<{ record_id: string; json: string }>;
		workItems: Array<{ id: string; json: string }>;
		processed: Array<{ dedupe_key: string; fingerprint: string }>;
	}): void {
		this.#core = rows.core;
		this.#dependencies = rows.dependencies;
		this.#records = new Map(rows.records.map((r) => [r.record_id, r.json]));
		this.#workItems = new Map(rows.workItems.map((r) => [r.id, r.json]));
		this.#processed = new Map(rows.processed.map((r) => [r.dedupe_key, r.fingerprint]));
		this.#warm = true;
	}

	#warmUp(): void {
		this.#remember({
			core: this.#kv(CORE) ?? "",
			dependencies: this.#kv(DEPENDENCIES) ?? "[]",
			records: this.#db.all("SELECT record_id, json FROM cell_records"),
			workItems: this.#db.all("SELECT id, json FROM cell_work_items"),
			processed: this.#db.all("SELECT dedupe_key, fingerprint FROM cell_processed"),
		});
	}

	/** Write the state (only rows that changed) and, if given, the ledger line and its head row. */
	#write(state: CellState, entry: ReconciliationEvent | null): void {
		const core = canonicalJson({ schemaVersion: state.schemaVersion, baselineCommit: state.baselineCommit, snapshotHash: state.snapshotHash });
		if (core !== this.#core) this.#db.all("INSERT OR REPLACE INTO cell_kv (key, value) VALUES (?, ?)", CORE, core);
		const dependencies = canonicalJson(state.dependencies);
		if (dependencies !== this.#dependencies) this.#db.all("INSERT OR REPLACE INTO cell_kv (key, value) VALUES (?, ?)", DEPENDENCIES, dependencies);

		this.#syncRows("cell_records", "record_id", state.records, this.#records);
		this.#syncRows("cell_work_items", "id", state.workItems, this.#workItems);
		for (const [key, fingerprint] of Object.entries(state.processed)) {
			if (this.#processed.get(key) !== fingerprint) {
				this.#db.all("INSERT OR REPLACE INTO cell_processed (dedupe_key, fingerprint) VALUES (?, ?)", key, fingerprint);
			}
		}

		if (entry) {
			// Plain JSON, in the order the line was built: the hash already covers a canonical form, and callers may compare serialisations.
			this.#db.all("INSERT INTO ledger (seq, type, hash, prev_hash, json) VALUES (?, ?, ?, ?, ?)", entry.seq, entry.type, entry.hash, entry.prevHash, JSON.stringify(entry));
			this.#db.all("INSERT OR REPLACE INTO ledger_head (id, seq, hash) VALUES (1, ?, ?)", entry.seq, entry.hash);
		}
	}

	#syncRows(table: "cell_records" | "cell_work_items", idColumn: "record_id" | "id", next: Record<string, unknown>, known: Map<string, string>): void {
		for (const [id, value] of Object.entries(next)) {
			const json = canonicalJson(value);
			if (known.get(id) !== json) this.#db.all(`INSERT OR REPLACE INTO ${table} (${idColumn}, json) VALUES (?, ?)`, id, json);
		}
		for (const id of known.keys()) {
			if (!(id in next)) this.#db.all(`DELETE FROM ${table} WHERE ${idColumn} = ?`, id);
		}
	}
}
