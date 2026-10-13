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
		failing_sha TEXT,
		failures INTEGER NOT NULL DEFAULT 0,
		streak INTEGER NOT NULL DEFAULT 0,
		last_error TEXT,
		degraded_note TEXT,
		retry_at INTEGER,
		last_polled_at TEXT
	)`,
	"CREATE TABLE IF NOT EXISTS written_commits (sha TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('context', 'merge')), actor TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS eval_ms (seq INTEGER PRIMARY KEY, ms REAL NOT NULL)",
	"CREATE TABLE IF NOT EXISTS record_paths (record_id TEXT PRIMARY KEY, path TEXT NOT NULL)",
	`CREATE TABLE IF NOT EXISTS pending_promotions (
		work_item_id TEXT PRIMARY KEY,
		expected_baseline TEXT NOT NULL,
		fork_head TEXT NOT NULL,
		merge_sha TEXT,
		actor TEXT NOT NULL,
		created_ms INTEGER NOT NULL
	)`,
	// Re-dispatches the cell owes the agent runtime: one row per accepted revalidate resolution, keyed by its Idempotency-Key.
	`CREATE TABLE IF NOT EXISTS dispatch_jobs (
		request_id TEXT PRIMARY KEY,
		work_item_id TEXT NOT NULL,
		phase TEXT NOT NULL CHECK (phase IN ('queued', 'prepared', 'receipted', 'running', 'done', 'failed')),
		diff TEXT NOT NULL,
		payload TEXT,
		run_id TEXT,
		attempts INTEGER NOT NULL DEFAULT 0,
		misses INTEGER NOT NULL DEFAULT 0,
		requeues INTEGER NOT NULL DEFAULT 0,
		retry_at INTEGER,
		error TEXT,
		created_ms INTEGER NOT NULL,
		updated_ms INTEGER NOT NULL
	)`,
	"CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)",
];

export type TrackedRow = TrackedRepo & {
	cursor: string | null;
	/** The commit the poller is failing on, and how many times in a row it failed on that one commit. */
	failingSha: string | null;
	failures: number;
	/** Consecutive failed attempts of any kind since the last success; drives the backoff. */
	streak: number;
	lastError: string | null;
	/** Set when the poller had to skip a fork commit it could not read. Cleared by the next commit it reads. */
	degradedNote: string | null;
	/** Do not retry before this instant (ms since epoch); null when not backing off. */
	retryAt: number | null;
	lastPolledAt: string | null;
};

export type PollerHealth = {
	healthy: boolean;
	/** Only the repos that are failing or were degraded. */
	degraded: Array<{ repo: string; kind: "baseline" | "fork"; lastError: string | null; note: string | null; failures: number }>;
};

/** A promotion whose merge may have landed without the cell having recorded it. */
export type PendingPromotion = {
	workItemId: string;
	expectedBaseline: string;
	forkHead: string;
	/** The merge commit, once the merge returned; null if the answer was lost. */
	mergeSha: string | null;
	actor: string;
	createdMs: number;
};

export type DispatchPhase = "queued" | "prepared" | "receipted" | "running" | "done" | "failed";

/** A re-dispatch the cell owes the agent runtime. `diff` and `payload` are JSON the dispatcher owns (dispatch-jobs.ts). */
export type DispatchJobRow = {
	requestId: string;
	workItemId: string;
	phase: DispatchPhase;
	diff: unknown;
	payload: unknown | null;
	runId: string | null;
	attempts: number;
	/** Consecutive status reads that found no run record, while one should exist. */
	misses: number;
	/** Times the job was sent back to the start because the receipt it prepared was overtaken (the baseline moved). */
	requeues: number;
	retryAt: number | null;
	error: string | null;
	createdMs: number;
	updatedMs: number;
};

export type DispatchJobPatch = Partial<Pick<DispatchJobRow, "phase" | "payload" | "runId" | "attempts" | "misses" | "requeues" | "retryAt" | "error">>;

type RawDispatch = {
	request_id: string;
	work_item_id: string;
	phase: DispatchPhase;
	diff: string;
	payload: string | null;
	run_id: string | null;
	attempts: number;
	misses: number;
	requeues: number;
	retry_at: number | null;
	error: string | null;
	created_ms: number;
	updated_ms: number;
};

export type StoredResponse = { status: number; body: unknown };

type RawTracked = {
	repo: string;
	kind: "baseline" | "fork";
	work_item_id: string | null;
	base_commit: string | null;
	cursor_sha: string | null;
	failing_sha: string | null;
	failures: number;
	streak: number;
	last_error: string | null;
	degraded_note: string | null;
	retry_at: number | null;
	last_polled_at: string | null;
};

type RawPending = { work_item_id: string; expected_baseline: string; fork_head: string; merge_sha: string | null; actor: string; created_ms: number };

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

	/** Start watching a repo. Throws if it is already watched: a second registration must never replace a cursor. */
	track(row: { repo: string; kind: "baseline" | "fork"; workItemId: string | null; baseCommit: string | null; cursor: string | null }): void {
		this.#db.all("INSERT INTO tracked_repos (repo, kind, work_item_id, base_commit, cursor_sha) VALUES (?, ?, ?, ?, ?)", row.repo, row.kind, row.workItemId, row.baseCommit, row.cursor);
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

	/** The commit was read and recorded: move the cursor and forget every failure. */
	advance(repo: string, cursor: string, at: string): void {
		this.#db.all(
			"UPDATE tracked_repos SET cursor_sha = ?, failing_sha = NULL, failures = 0, streak = 0, last_error = NULL, degraded_note = NULL, retry_at = NULL, last_polled_at = ? WHERE repo = ?",
			cursor,
			at,
			repo,
		);
	}

	/** Move past a commit that could not be read (forks only). The note stays until a later commit is read cleanly. */
	skip(repo: string, sha: string, note: string, at: string): void {
		this.#db.all(
			"UPDATE tracked_repos SET cursor_sha = ?, failing_sha = NULL, failures = 0, streak = 0, last_error = NULL, degraded_note = ?, retry_at = NULL, last_polled_at = ? WHERE repo = ?",
			sha,
			note.slice(0, 500),
			at,
			repo,
		);
	}

	/** The head was read and there is nothing new: clear any repo-level error and backoff. */
	touchOk(repo: string, at: string): void {
		this.#db.all("UPDATE tracked_repos SET failing_sha = NULL, failures = 0, streak = 0, last_error = NULL, retry_at = NULL, last_polled_at = ? WHERE repo = ?", at, repo);
	}

	/** The repo could not be read at all (log failed). Not counted against any commit. */
	repoError(repo: string, error: string, at: string, retryAt: number): void {
		this.#db.all("UPDATE tracked_repos SET streak = streak + 1, last_error = ?, retry_at = ?, last_polled_at = ? WHERE repo = ?", error.slice(0, 500), retryAt, at, repo);
	}

	/** One commit failed. Returns how many times in a row this same commit has now failed. */
	failCommit(repo: string, sha: string, error: string, at: string, retryAt: number): number {
		const row = this.trackedRepo(repo);
		const failures = row?.failingSha === sha ? row.failures + 1 : 1;
		this.#db.all(
			"UPDATE tracked_repos SET failing_sha = ?, failures = ?, streak = streak + 1, last_error = ?, retry_at = ?, last_polled_at = ? WHERE repo = ?",
			sha,
			failures,
			error.slice(0, 500),
			retryAt,
			at,
			repo,
		);
		return failures;
	}

	health(): PollerHealth {
		const degraded = this.tracked()
			.filter((t) => t.lastError !== null || t.degradedNote !== null)
			.map((t) => ({ repo: t.repo, kind: t.kind, lastError: t.lastError, note: t.degradedNote, failures: t.failures }));
		return { healthy: degraded.length === 0, degraded };
	}

	// ---------- promotions whose merge may have landed without being recorded ----------

	startPromotion(p: { workItemId: string; expectedBaseline: string; forkHead: string; actor: string; createdMs: number }): void {
		this.#db.all(
			"INSERT OR REPLACE INTO pending_promotions (work_item_id, expected_baseline, fork_head, merge_sha, actor, created_ms) VALUES (?, ?, ?, NULL, ?, ?)",
			p.workItemId,
			p.expectedBaseline,
			p.forkHead,
			p.actor,
			p.createdMs,
		);
	}

	setPromotionMerge(workItemId: string, mergeSha: string): void {
		this.#db.all("UPDATE pending_promotions SET merge_sha = ? WHERE work_item_id = ?", mergeSha, workItemId);
	}

	pendingPromotions(): PendingPromotion[] {
		return this.#db.all<RawPending>("SELECT * FROM pending_promotions ORDER BY created_ms").map((r) => ({
			workItemId: r.work_item_id,
			expectedBaseline: r.expected_baseline,
			forkHead: r.fork_head,
			mergeSha: r.merge_sha,
			actor: r.actor,
			createdMs: r.created_ms,
		}));
	}

	clearPromotion(workItemId: string): void {
		this.#db.all("DELETE FROM pending_promotions WHERE work_item_id = ?", workItemId);
	}

	// ---------- re-dispatches owed to the agent runtime ----------

	/** Queue a re-dispatch. A second call with the same key (the resolution replayed) is ignored. */
	enqueueDispatch(job: { requestId: string; workItemId: string; diff: unknown; nowMs: number }): void {
		this.#db.all(
			"INSERT OR IGNORE INTO dispatch_jobs (request_id, work_item_id, phase, diff, created_ms, updated_ms) VALUES (?, ?, 'queued', ?, ?, ?)",
			job.requestId,
			job.workItemId,
			JSON.stringify(job.diff),
			job.nowMs,
			job.nowMs,
		);
	}

	/** Jobs still owed work, oldest first. */
	activeDispatches(): DispatchJobRow[] {
		return this.#db.all<RawDispatch>("SELECT * FROM dispatch_jobs WHERE phase NOT IN ('done', 'failed') ORDER BY created_ms, request_id").map(toDispatch);
	}

	/** Every job, newest first (a diagnostic: GET .../dispatches). */
	dispatches(): DispatchJobRow[] {
		return this.#db.all<RawDispatch>("SELECT * FROM dispatch_jobs ORDER BY created_ms DESC, request_id DESC").map(toDispatch);
	}

	updateDispatch(requestId: string, patch: DispatchJobPatch, nowMs: number): void {
		const sets: string[] = ["updated_ms = ?"];
		const values: unknown[] = [nowMs];
		const column: Record<keyof DispatchJobPatch, string> = { phase: "phase", payload: "payload", runId: "run_id", attempts: "attempts", misses: "misses", requeues: "requeues", retryAt: "retry_at", error: "error" };
		for (const key of Object.keys(patch) as Array<keyof DispatchJobPatch>) {
			sets.push(`${column[key]} = ?`);
			const value = patch[key];
			values.push(key === "payload" ? (value === null || value === undefined ? null : JSON.stringify(value)) : (value ?? null));
		}
		this.#db.all(`UPDATE dispatch_jobs SET ${sets.join(", ")} WHERE request_id = ?`, ...values, requestId);
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

	/** The most recent commits the Worker pushed to the baseline, newest first (a diagnostic: GET .../poller). */
	recentWritten(limit: number): Array<{ sha: string; kind: "context" | "merge"; actor: string }> {
		return this.#db.all<{ sha: string; kind: "context" | "merge"; actor: string }>("SELECT sha, kind, actor FROM written_commits ORDER BY rowid DESC LIMIT ?", limit);
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

function toDispatch(row: RawDispatch): DispatchJobRow {
	return {
		requestId: row.request_id,
		workItemId: row.work_item_id,
		phase: row.phase,
		diff: JSON.parse(row.diff),
		payload: row.payload === null ? null : JSON.parse(row.payload),
		runId: row.run_id,
		attempts: row.attempts,
		misses: row.misses,
		requeues: row.requeues,
		retryAt: row.retry_at,
		error: row.error,
		createdMs: row.created_ms,
		updatedMs: row.updated_ms,
	};
}

function toTracked(row: RawTracked): TrackedRow {
	return {
		repo: row.repo,
		kind: row.kind,
		workItemId: row.work_item_id,
		baseCommit: row.base_commit,
		cursor: row.cursor_sha,
		failingSha: row.failing_sha,
		failures: row.failures,
		streak: row.streak,
		lastError: row.last_error,
		degradedNote: row.degraded_note,
		retryAt: row.retry_at,
		lastPolledAt: row.last_polled_at,
	};
}
