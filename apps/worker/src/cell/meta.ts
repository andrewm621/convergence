import { Policy } from "contracts";
import type { SqlDb } from "./sql";
import type { TrackedRepo } from "./observe";

// Cell bookkeeping that is not reconciler state: which repos are watched and how far the poller
// has read, which Idempotency-Keys were answered, and which file holds each record. It lives in
// the same SQLite database as the store, in its own tables.

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS meta_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	`CREATE TABLE IF NOT EXISTS tracked_repos (
		repo TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('baseline', 'fork')),
		work_item_id TEXT,
		base_commit TEXT,
		cursor_sha TEXT,
		failures INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		last_polled_at TEXT
	)`,
	"CREATE TABLE IF NOT EXISTS written_commits (sha TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('context', 'merge')), actor TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS eval_ms (seq INTEGER PRIMARY KEY, ms REAL NOT NULL)",
	"CREATE TABLE IF NOT EXISTS record_paths (record_id TEXT PRIMARY KEY, path TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)",
];

export type TrackedRow = TrackedRepo & {
	cursor: string | null;
	failures: number;
	lastError: string | null;
	lastPolledAt: string | null;
};

export type StoredResponse = { status: number; body: unknown };

type RawTracked = {
	repo: string;
	kind: "baseline" | "fork";
	work_item_id: string | null;
	base_commit: string | null;
	cursor_sha: string | null;
	failures: number;
	last_error: string | null;
	last_polled_at: string | null;
};

export class CellMeta {
	readonly #db: SqlDb;

	constructor(db: SqlDb) {
		this.#db = db;
		for (const statement of SCHEMA) db.all(statement);
	}

	// ---------- key/value ----------

	get(key: string): string | null {
		return this.#db.all<{ value: string }>("SELECT value FROM meta_kv WHERE key = ?", key)[0]?.value ?? null;
	}

	set(key: string, value: string): void {
		this.#db.all("INSERT OR REPLACE INTO meta_kv (key, value) VALUES (?, ?)", key, value);
	}

	scenario(): string | null {
		return this.get("scenario");
	}

	baselineRepo(): string | null {
		return this.get("baselineRepo");
	}

	policy(): Policy | null {
		const raw = this.get("policy");
		return raw === null ? null : Policy.parse(JSON.parse(raw));
	}

	// ---------- watched repos ----------

	track(row: { repo: string; kind: "baseline" | "fork"; workItemId: string | null; baseCommit: string | null; cursor: string | null }): void {
		this.#db.all(
			"INSERT OR REPLACE INTO tracked_repos (repo, kind, work_item_id, base_commit, cursor_sha, failures, last_error, last_polled_at) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)",
			row.repo,
			row.kind,
			row.workItemId,
			row.baseCommit,
			row.cursor,
		);
	}

	tracked(): TrackedRow[] {
		// Baseline first, then forks in a stable order, so the baseline change is evaluated before any fork push.
		return this.#db
			.all<RawTracked>("SELECT * FROM tracked_repos ORDER BY CASE kind WHEN 'baseline' THEN 0 ELSE 1 END, repo")
			.map(toTracked);
	}

	trackedRepo(repo: string): TrackedRow | null {
		const row = this.#db.all<RawTracked>("SELECT * FROM tracked_repos WHERE repo = ?", repo)[0];
		return row ? toTracked(row) : null;
	}

	advance(repo: string, cursor: string, at: string): void {
		this.#db.all("UPDATE tracked_repos SET cursor_sha = ?, failures = 0, last_error = NULL, last_polled_at = ? WHERE repo = ?", cursor, at, repo);
	}

	touch(repo: string, at: string): void {
		this.#db.all("UPDATE tracked_repos SET last_polled_at = ? WHERE repo = ?", at, repo);
	}

	fail(repo: string, error: string, at: string): number {
		this.#db.all("UPDATE tracked_repos SET failures = failures + 1, last_error = ?, last_polled_at = ? WHERE repo = ?", error.slice(0, 500), at, repo);
		return this.trackedRepo(repo)?.failures ?? 0;
	}

	// ---------- record files ----------

	recordPath(recordId: string): string | null {
		return this.#db.all<{ path: string }>("SELECT path FROM record_paths WHERE record_id = ?", recordId)[0]?.path ?? null;
	}

	setRecordPaths(paths: Record<string, string>): void {
		for (const [recordId, path] of Object.entries(paths)) {
			this.#db.all("INSERT OR REPLACE INTO record_paths (record_id, path) VALUES (?, ?)", recordId, path);
		}
	}

	// ---------- how long the reconciler took per ledger line (for the results strip) ----------

	recordEvaluation(seq: number, ms: number): void {
		this.#db.all("INSERT OR REPLACE INTO eval_ms (seq, ms) VALUES (?, ?)", seq, ms);
	}

	evaluationMs(seq: number): number | null {
		return this.#db.all<{ ms: number }>("SELECT ms FROM eval_ms WHERE seq = ?", seq)[0]?.ms ?? null;
	}

	evaluationsAfter(seq: number): Record<string, number> {
		const rows = this.#db.all<{ seq: number; ms: number }>("SELECT seq, ms FROM eval_ms WHERE seq > ? ORDER BY seq", seq);
		return Object.fromEntries(rows.map((r) => [String(r.seq), r.ms]));
	}

	// ---------- commits the Worker pushed to the baseline ----------

	markWritten(sha: string, kind: "context" | "merge", actor: string): void {
		this.#db.all("INSERT OR REPLACE INTO written_commits (sha, kind, actor) VALUES (?, ?, ?)", sha, kind, actor);
	}

	written(sha: string): { kind: "context" | "merge"; actor: string } | null {
		const row = this.#db.all<{ kind: "context" | "merge"; actor: string }>("SELECT kind, actor FROM written_commits WHERE sha = ?", sha)[0];
		return row ? { kind: row.kind, actor: row.actor } : null;
	}

	// ---------- Idempotency-Key ----------

	idempotent(key: string): { fingerprint: string; response: StoredResponse } | null {
		const row = this.#db.all<{ fingerprint: string; status: number; body: string }>("SELECT fingerprint, status, body FROM idempotency WHERE key = ?", key)[0];
		return row ? { fingerprint: row.fingerprint, response: { status: row.status, body: JSON.parse(row.body) } } : null;
	}

	rememberResponse(key: string, fingerprint: string, response: StoredResponse, at: string): void {
		this.#db.all("INSERT OR REPLACE INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)", key, fingerprint, response.status, JSON.stringify(response.body), at);
	}
}

function toTracked(row: RawTracked): TrackedRow {
	return {
		repo: row.repo,
		kind: row.kind,
		workItemId: row.work_item_id,
		baseCommit: row.base_commit,
		cursor: row.cursor_sha,
		failures: row.failures,
		lastError: row.last_error,
		lastPolledAt: row.last_polled_at,
	};
}
