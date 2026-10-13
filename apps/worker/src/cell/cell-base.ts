import { DurableObject } from "cloudflare:workers";
import {
	AgentActivity,
	CellSnapshot,
	DeltaEvent,
	canonicalJson,
	sha256Hex,
	type Actor,
	type CellState,
	type Effect,
	type Policy,
	type ReconciliationEvent,
	type WorkItemState,
} from "contracts";
import {
	authorityFor,
	buildReceipt,
	createCellState,
	currentSnapshot,
	evaluateGate,
	processEvent,
	type ProcessResult,
} from "delta-core";
import { PromoteRequest, RegisterRequest, ResolveRequest, InitRequest, failure, invalidInput, refusalOf, type CellResult, type WsFrame } from "./api";
import { WS_PROTOCOL } from "./auth";
import { ContextChangeRequest, planContextChange } from "./context-change";
import { ContextReader, snapshotHashOf } from "./context-tree";
import { CellMeta, type TrackedRow } from "./meta";
import { WORKER_COMMITTER, observeBaselineCommit, observeForkCommit, type ObserveDeps } from "./observe";
import { PortError, type ArtifactsPort, type RepoCommit } from "./ports";
import { durableObjectSql } from "./sql";
import { SqliteCellStore, type LedgerVerdict } from "./sqlite-store";
import type { FlatTree } from "../artifacts/tree-diff";

const LEDGER_TAIL = 50;
const REPLAY_LIMIT = 200;
const POLL_WINDOW = 50;
/** After this many failed attempts at one commit the poller gives up on it (and says so) instead of retrying forever. */
const MAX_COMMIT_FAILURES = 4;
const DEFAULT_POLL_MS = 3000;
const WORKER_IDENTITY = { name: WORKER_COMMITTER, email: "delta@example.invalid" };

class NotInitialized extends Error {}

/**
 * The WorkspaceCell: one Durable Object per scenario. It owns the cell state and the hash-chained
 * ledger (DO SQLite), watches the scenario's repos through an alarm-driven poller, runs the pure
 * reconciler on what it sees, executes the effects, and fans the result out over hibernating
 * WebSockets.
 *
 * Everything that changes state goes through `#serial`, so events are applied one at a time.
 * Artifacts access goes through the `ArtifactsPort`, supplied by the subclass.
 */
export abstract class CellBase extends DurableObject<Env> {
	protected abstract createPort(): ArtifactsPort;

	readonly #store: SqliteCellStore;
	readonly #meta: CellMeta;
	readonly #trees = new Map<string, FlatTree>();
	#port: ArtifactsPort | null = null;
	#reader: ContextReader | null = null;
	#policy: Policy | null = null;
	#tail: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const db = durableObjectSql(ctx.storage);
		this.#store = new SqliteCellStore(db);
		this.#meta = new CellMeta(db);
		// Answered by the runtime without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	/** ISO-8601 instant without milliseconds. Overridden in tests. */
	protected now(): string {
		return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	}

	protected pollIntervalMs(): number {
		const configured = Number((this.env as { POLL_INTERVAL_MS?: string }).POLL_INTERVAL_MS);
		return Number.isFinite(configured) && configured >= 100 ? Math.min(configured, 60_000) : DEFAULT_POLL_MS;
	}

	/**
	 * DISPATCH_WORK: the reconciler asked for the agent to be re-run on fresh context. Dispatching
	 * is the agent runtime's job (M4); here it is announced to the console as agent activity.
	 */
	protected async onDispatchWork(effect: Extract<Effect, { type: "DISPATCH_WORK" }>): Promise<void> {
		const changed = effect.diff.map((d) => `${d.recordId} v${d.fromVersion} to v${d.toVersion}`).join(", ");
		await this.publishActivity({
			type: "agent-activity",
			workItemId: effect.workItemId,
			runId: "delta",
			kind: "status",
			text: `Revalidation requested${changed ? `: ${changed}` : ""}.`,
			ts: this.now(),
		});
	}

	// ---------- plumbing ----------

	get #artifacts(): ArtifactsPort {
		return (this.#port ??= this.createPort());
	}

	get #contextReader(): ContextReader {
		return (this.#reader ??= new ContextReader(this.#artifacts));
	}

	#serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(fn, fn);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	async #requireState(): Promise<CellState> {
		const state = await this.#store.load();
		if (!state) throw new NotInitialized();
		return state;
	}

	#requirePolicy(): Policy {
		this.#policy ??= this.#meta.policy();
		if (!this.#policy) throw new NotInitialized();
		return this.#policy;
	}

	#baselineRepo(): string {
		const repo = this.#meta.baselineRepo();
		if (!repo) throw new NotInitialized();
		return repo;
	}

	/** Map the errors the API treats as answers (not initialised, repo missing) to results; anything else is a 500. */
	async #answer(fn: () => Promise<CellResult>): Promise<CellResult> {
		try {
			return await fn();
		} catch (error) {
			if (error instanceof NotInitialized) return failure(409, "NOT_INITIALIZED", "this scenario has not been initialised");
			if (error instanceof PortError && error.code === "NOT_FOUND") return failure(404, "NOT_FOUND", error.message);
			throw error;
		}
	}

	/**
	 * Run a mutating request once per Idempotency-Key. The same key with the same request replays
	 * the stored response; the same key with a different request is IDEMPOTENCY_CONFLICT.
	 */
	#idempotent(key: string, scope: string, input: unknown, run: () => Promise<CellResult & { remember?: boolean }>): Promise<CellResult> {
		return this.#serial(() =>
			this.#answer(async () => {
				const fingerprint = await sha256Hex(canonicalJson({ scope, input }));
				const prior = this.#meta.idempotent(key);
				if (prior) {
					if (prior.fingerprint !== fingerprint) return failure(409, "IDEMPOTENCY_CONFLICT", "this Idempotency-Key was already used for a different request");
					return { ...prior.response, replay: true };
				}
				const result = await run();
				if (result.remember ?? result.status < 500) this.#meta.rememberResponse(key, fingerprint, { status: result.status, body: result.body }, this.now());
				return { status: result.status, body: result.body };
			}),
		);
	}

	async getId(): Promise<string> {
		return this.ctx.id.toString();
	}

	// ---------- the pipeline: event in, state + ledger line + effects + broadcast out ----------

	async #submit(input: unknown): Promise<ProcessResult> {
		const result = await processEvent(this.#store, input, this.#requirePolicy());
		if (result.outcome === "applied") await this.#afterApplied(result.entry, result.effects);
		return result;
	}

	/**
	 * Execute what the reconciler asked for. BLOCK_PROMOTION, REQUEST_REVIEW and RECORD_CONDITION are
	 * notifications: they ride in the `event` frame to every connected console. DISPATCH_WORK goes
	 * to the dispatch hook. ALLOW_PROMOTION is acted on by `promote`, which is waiting for it.
	 * A failing effect never fails the request that caused it; the ledger line is already written.
	 */
	async #afterApplied(entry: ReconciliationEvent, effects: Effect[]): Promise<void> {
		try {
			const state = await this.#store.load();
			if (state) this.#broadcast({ seq: entry.seq, message: { type: "event", event: entry, workItems: touchedItems(state, entry) } });
		} catch (error) {
			console.error("broadcast failed", error instanceof Error ? error.message : error);
		}
		for (const effect of effects) {
			if (effect.type !== "DISPATCH_WORK") continue;
			try {
				await this.onDispatchWork(effect);
			} catch (error) {
				console.error("dispatch effect failed", error instanceof Error ? error.message : error);
			}
		}
	}

	// ---------- WebSocket (hibernation API) ----------

	#broadcast(frame: WsFrame): void {
		const text = JSON.stringify(frame);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(text);
			} catch {
				// The socket is closing; the runtime will call webSocketClose.
			}
		}
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return Response.json({ error: { code: "UPGRADE_REQUIRED", message: "this endpoint speaks WebSocket" } }, { status: 426 });
		}
		if (!(await this.#store.load())) {
			return Response.json({ error: { code: "NOT_INITIALIZED", message: "this scenario has not been initialised" } }, { status: 409 });
		}
		const sinceParam = new URL(request.url).searchParams.get("since");
		const since = sinceParam !== null && /^\d{1,12}$/.test(sinceParam) ? Number(sinceParam) : null;

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		await this.#serial(() => this.#greet(server, since));
		await this.#ensureAlarm();
		return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": WS_PROTOCOL } });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// "ping" is auto-answered by the runtime. "resync" asks for a fresh snapshot (e.g. after a client-side error).
		if (message === "resync") await this.#serial(() => this.#greet(ws, null));
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		try {
			ws.close(1011, "error");
		} catch {
			// Already closed.
		}
	}

	/** Snapshot first, then (on a reconnect) the ledger lines the client missed. */
	async #greet(ws: WebSocket, since: number | null): Promise<void> {
		const snapshot = await this.#snapshot();
		const head = snapshot.ledgerHead.seq;
		const resuming = since !== null && since < head;
		const gap = since !== null && (since > head || head - since > REPLAY_LIMIT);
		const frames: WsFrame[] = [{ seq: head, ...(gap ? { gap: true } : {}), message: { type: "snapshot", snapshot } }];
		if (resuming) {
			const state = await this.#requireState();
			const lines = await this.#store.ledger({ afterSeq: Math.max(since, head - REPLAY_LIMIT), limit: REPLAY_LIMIT });
			// Replayed lines carry the work items' state now, not as it was at that line.
			for (const line of lines) frames.push({ seq: line.seq, replay: true, message: { type: "event", event: line, workItems: touchedItems(state, line) } });
		}
		for (const frame of frames) ws.send(JSON.stringify(frame));
	}

	async #snapshot(): Promise<CellSnapshot> {
		const state = await this.#requireState();
		const head = await this.#store.head();
		const tail = await this.#store.ledger({ afterSeq: Math.max(0, head.seq - LEDGER_TAIL) });
		return {
			scenario: this.#meta.scenario() ?? "unknown",
			baselineCommit: state.baselineCommit,
			snapshotHash: state.snapshotHash,
			policy: this.#requirePolicy(),
			records: state.records,
			workItems: Object.values(state.workItems).sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)),
			dependencies: state.dependencies,
			ledgerTail: tail,
			ledgerHead: head,
		};
	}

	/** Live agent output (stream-json lines) for the console. Not persisted: the agent runtime keeps its own log. */
	async publishActivity(input: unknown): Promise<void> {
		const activity = AgentActivity.parse(input);
		this.#broadcast({ seq: (await this.#store.head()).seq, message: activity });
	}

	// ---------- the poller ----------

	async #ensureAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
	}

	override async alarm(): Promise<void> {
		try {
			await this.#serial(() => this.#pollAll());
		} catch (error) {
			console.error("poll failed", error instanceof Error ? error.message : error);
		} finally {
			// Always schedule the next tick: a failed one must not stop the loop.
			if (this.#meta.baselineRepo()) await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalMs());
		}
	}

	/** Look at every tracked repo once. A cheap `log({limit: 1})` per repo; only a moved head costs more. */
	async #pollAll(repos?: string[]): Promise<number> {
		let applied = 0;
		const tracked = this.#meta.tracked().filter((t) => !repos || repos.includes(t.repo));
		const heads = await Promise.all(
			tracked.map((t) =>
				this.#artifacts.log(t.repo, { limit: 1 }).then(
					(commits) => ({ ok: true as const, head: commits[0] ?? null }),
					(error: unknown) => ({ ok: false as const, error }),
				),
			),
		);
		for (const [i, t] of tracked.entries()) {
			const seen = heads[i];
			if (!seen) continue;
			if (!seen.ok) {
				this.#meta.fail(t.repo, seen.error instanceof Error ? seen.error.message : String(seen.error), this.now());
				continue;
			}
			if (!seen.head || seen.head.sha === t.cursor) {
				this.#meta.touch(t.repo, this.now());
				continue;
			}
			applied += await this.#pollRepo(t);
		}
		return applied;
	}

	/** Read the commits after this repo's cursor and turn each into events. Returns how many ledger lines it added. */
	async #pollRepo(t: TrackedRow): Promise<number> {
		let window: RepoCommit[];
		try {
			window = await this.#artifacts.log(t.repo, { limit: POLL_WINDOW });
		} catch (error) {
			this.#meta.fail(t.repo, error instanceof Error ? error.message : String(error), this.now());
			return 0;
		}
		const at = t.cursor ? window.findIndex((c) => c.sha === t.cursor) : -1;
		let fresh = (at === -1 ? window : window.slice(0, at)).reverse(); // oldest first
		// A fork's claims and context paths are replaced by every push, so only its newest commit matters.
		// Baseline commits each matter: a typo fix and a decision change can land within one poll.
		if (t.kind === "fork") fresh = fresh.slice(-1);

		let added = 0;
		for (const commit of fresh) {
			try {
				const result = await this.#observeCommit(t, commit, { degraded: t.failures >= MAX_COMMIT_FAILURES - 2 });
				if (result?.outcome === "applied") added += 1;
				this.#meta.advance(t.repo, commit.sha, this.now());
			} catch (error) {
				const failures = this.#meta.fail(t.repo, `${commit.sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`, this.now());
				if (failures >= MAX_COMMIT_FAILURES) this.#meta.advance(t.repo, commit.sha, this.now()); // give up on it; last_error says why
				break;
			}
			t = this.#meta.trackedRepo(t.repo) ?? t;
		}
		return added;
	}

	/** Turn one commit into events and run them. The poller and `observePush` (the Queue path) both end here. */
	async #observeCommit(t: TrackedRow, commit: RepoCommit, options: { degraded?: boolean } = {}): Promise<ProcessResult | null> {
		const state = await this.#requireState();
		const policy = this.#requirePolicy();
		const deps: ObserveDeps = {
			port: this.#artifacts,
			reader: this.#contextReader,
			now: () => this.now(),
			trees: this.#trees,
			// Never the record file's own `authority` text: that is written by whoever wrote the file.
			authorityOf: (snapshot) => authorityFor(state, policy, snapshot.recordId),
			written: (sha) => this.#meta.written(sha),
		};
		if (t.kind === "baseline") {
			const { event, recordPaths } = await observeBaselineCommit(deps, t.repo, commit);
			const result = await this.#submit(event);
			this.#meta.setRecordPaths(recordPaths);
			return result;
		}
		return this.#submit(await observeForkCommit(deps, t, this.#baselineRepo(), commit, options));
	}

	/** Test and operations hook: poll now instead of waiting for the alarm. */
	pollNow(): Promise<{ lines: number }> {
		return this.#serial(async () => ({ lines: await this.#pollAll() }));
	}

	/**
	 * The Queue path: Artifacts says `repo` has a new commit `sha`. Same mapping, same R9 dedupe as
	 * the poller, so a push seen by both yields one ledger line.
	 */
	observePush(repo: string, sha: string): Promise<{ outcome: string }> {
		return this.#serial(async () => {
			const t = this.#meta.trackedRepo(repo);
			if (!t) return { outcome: "untracked" };
			const window = await this.#artifacts.log(repo, { limit: POLL_WINDOW });
			const commit = window.find((c) => c.sha === sha);
			if (!commit) return { outcome: "unknown-commit" };
			return { outcome: (await this.#observeCommit(t, commit))?.outcome ?? "ignored" };
		});
	}

	pollerStatus(): Promise<{ intervalMs: number; repos: TrackedRow[] }> {
		return Promise.resolve({ intervalMs: this.pollIntervalMs(), repos: this.#meta.tracked() });
	}

	// ---------- setup ----------

	init(scenario: string, input: unknown, key: string): Promise<CellResult> {
		return this.#idempotent(key, "init", { scenario, input }, async () => {
			const parsed = InitRequest.safeParse(input);
			if (!parsed.success) return invalidInput(parsed.error, "init request");
			if (await this.#store.load()) return failure(409, "ALREADY_INITIALIZED", "this scenario is already initialised");
			const { baselineRepo, policy } = parsed.data;

			const head = (await this.#artifacts.log(baselineRepo, { limit: 1 }))[0];
			if (!head) return failure(409, "BASELINE_EMPTY", `${baselineRepo} has no commits to start from`);
			const tree = await this.#artifacts.tree(baselineRepo, head.sha);
			const files = await this.#contextReader.readAll(baselineRepo, tree);

			// Start from the records the baseline holds now, applying the same authority rule the reconciler applies later.
			const records = [];
			const ignored: Array<{ path: string; reason: string }> = [];
			const recordPaths: Record<string, string> = {};
			for (const file of files) {
				if (!file.result.ok) {
					ignored.push({ path: file.path, reason: file.result.error });
					continue;
				}
				const snap = file.result.snapshot;
				// The authority is the policy's, never the file's own `authority` text: an agent can write that.
				const authority = policy.authority[snap.recordId];
				if (snap.status !== "accepted" || !authority || snap.acceptedBy !== authority) {
					const reason = snap.status !== "accepted" ? `status is ${snap.status}` : !authority ? "the policy names no authority for this record" : `accepted_by is not the authority ${authority}`;
					ignored.push({ path: file.path, reason });
					continue;
				}
				records.push(snap);
				recordPaths[snap.recordId] = file.path;
			}

			const snapshotHash = await snapshotHashOf(files);
			await this.#store.init(createCellState({ baselineCommit: head.sha, snapshotHash, records }));
			this.#meta.set("scenario", scenario);
			this.#meta.set("baselineRepo", baselineRepo);
			this.#meta.set("policy", JSON.stringify(policy));
			this.#policy = policy;
			this.#meta.setRecordPaths(recordPaths);
			this.#meta.track({ repo: baselineRepo, kind: "baseline", workItemId: null, baseCommit: null, cursor: head.sha });
			await this.#ensureAlarm();
			return {
				status: 201,
				body: { scenario, baselineRepo, baselineCommit: head.sha, snapshotHash, records: records.map((r) => `${r.recordId}@${r.version}`), ignored },
			};
		});
	}

	registerWorkItem(input: unknown, key: string): Promise<CellResult> {
		return this.#idempotent(key, "register", input, async () => {
			const parsed = RegisterRequest.safeParse(input);
			if (!parsed.success) return invalidInput(parsed.error, "work item");
			const req = parsed.data;
			const state = await this.#requireState();
			if (state.workItems[req.id]) return failure(409, "ALREADY_REGISTERED", `${req.id} is already registered`);
			const missing = req.dependencies.map((d) => d.recordId).filter((id) => !currentSnapshot(state, id));
			if (missing.length > 0) return failure(409, "UNKNOWN_RECORD", `no accepted version of: ${[...new Set(missing)].join(", ")}`);
			if ((await this.#artifacts.log(req.forkRepo, { limit: 1 })).length === 0) return failure(404, "NOT_FOUND", `${req.forkRepo} has no commits (is it a fork of the baseline?)`);

			const baseCommit = req.baseCommit ?? state.baselineCommit;
			if (req.baseCommit) {
				// contextPaths is measured against this commit, so it must be real baseline history, not a commit the fork made up.
				const history = await this.#artifacts.log(this.#baselineRepo(), { limit: 1000 });
				if (!history.some((c) => c.sha === req.baseCommit)) return failure(409, "UNKNOWN_BASE_COMMIT", `${req.baseCommit} is not a commit of the baseline`);
			}
			const receipt = await buildReceipt(state, { baselineCommit: state.baselineCommit, recordIds: req.dependencies.map((d) => d.recordId) });
			const agentId = req.agent?.id ?? req.id.toLowerCase();
			const event = {
				type: "WorkItemRegistered" as const,
				ts: this.now(),
				item: {
					id: req.id,
					title: req.title,
					actor: { kind: "agent" as const, id: agentId, displayName: req.agent?.displayName ?? agentId },
					forkRepo: req.forkRepo,
					source: req.source,
					intent: req.intent,
					requires: req.requires,
					status: "running" as const,
				},
				receipt,
				dependencies: req.dependencies.map((d) => ({ workItemId: req.id, recordId: d.recordId, facetKeys: d.facetKeys, basis: "declared" as const, status: "accepted" as const, evidenceRefs: [] })),
			};
			const checked = DeltaEvent.safeParse(event);
			if (!checked.success) return invalidInput(checked.error, "work item");
			const result = await this.#submit(checked.data);
			if (result.outcome !== "applied") return failure(409, "ALREADY_REGISTERED", `${req.id} is already registered`);
			// Watch the fork from the commit it was made from, so a push that landed before registration is not missed.
			this.#meta.track({ repo: req.forkRepo, kind: "fork", workItemId: req.id, baseCommit, cursor: baseCommit });
			await this.#ensureAlarm();
			return { status: 201, body: { workItemId: req.id, seq: result.entry.seq, receipt, baseCommit } };
		});
	}

	// ---------- reads ----------

	snapshot(): Promise<CellResult> {
		return this.#answer(async () => ({ status: 200, body: await this.#snapshot() }));
	}

	ledger(options: { afterSeq?: number; limit?: number } = {}): Promise<CellResult> {
		return this.#answer(async () => {
			const afterSeq = Math.max(0, Math.floor(options.afterSeq ?? 0));
			const limit = Math.min(Math.max(Math.floor(options.limit ?? 200), 1), 1000);
			await this.#requireState();
			const entries = await this.#store.ledger({ afterSeq, limit });
			return { status: 200, body: { entries, head: await this.#store.head() } };
		});
	}

	verifyLedger(): Promise<CellResult> {
		return this.#answer(async () => {
			await this.#requireState();
			const verdict: LedgerVerdict = await this.#store.verify();
			return { status: 200, body: verdict };
		});
	}

	/** Dry-run of the promotion gate: the same `gateFrom` the reconciler runs inside PromotionRequested. */
	gate(workItemId: string): Promise<CellResult> {
		return this.#answer(async () => {
			const state = await this.#requireState();
			const wi = state.workItems[workItemId];
			if (!wi) return failure(404, "UNKNOWN_WORK_ITEM", `no work item ${workItemId}`);
			const verdict = evaluateGate(state, workItemId, this.#requirePolicy());
			return {
				status: 200,
				body: {
					workItemId,
					pass: verdict.promotable,
					reasonCodes: verdict.reasonCodes,
					blockers: verdict.blockers,
					waivedBy: verdict.waivedBy,
					// What a Resolution or a promotion must bind to.
					baselineCommit: state.baselineCommit,
					snapshotHash: state.snapshotHash,
					forkHeadSha: wi.headSha,
				},
			};
		});
	}

	// ---------- context changes: the Worker commits to the baseline as the authority ----------

	changeContext(input: unknown, actor: Actor, key: string): Promise<CellResult> {
		return this.#idempotent(key, "context-change", { actor, input }, async () => {
			const parsed = ContextChangeRequest.safeParse(input);
			if (!parsed.success) return invalidInput(parsed.error, "context change");
			const req = parsed.data;
			if (actor.kind !== "human") return failure(403, "FORBIDDEN_ACTOR", `${actor.kind} ${actor.id} cannot change context; only a human can.`);

			const baselineRepo = this.#baselineRepo();
			const policy = this.#requirePolicy();
			// Be current before judging anything: another commit may have landed since the last tick.
			await this.#pollAll([baselineRepo]);
			const state = await this.#requireState();

			const head = (await this.#artifacts.log(baselineRepo, { limit: 1 }))[0];
			if (!head) return failure(409, "BASELINE_EMPTY", "the baseline has no commits");
			if (req.expectedBaselineCommit && req.expectedBaselineCommit !== head.sha) {
				return failure(409, "BASELINE_MOVED", `the baseline is at ${head.sha}, not ${req.expectedBaselineCommit}`, { baselineCommit: head.sha });
			}

			const sitting = currentSnapshot(state, req.recordId);
			const authority = authorityFor(state, policy, req.recordId);
			if (authority !== null && actor.id !== authority) {
				return failure(403, "FORBIDDEN_ACTOR", `only ${authority} can change ${req.recordId}`);
			}

			// Build on the version the reconciler accepted, not on whatever file sits at the head: an
			// unauthorised commit may have left a different file there, and it must not leak into this one.
			const path = this.#meta.recordPath(req.recordId) ?? `context/${req.recordId}.md`;
			const text = sitting ? await this.#artifacts.readBlob(baselineRepo, sitting.blobHash) : null;
			const tree = await this.#artifacts.tree(baselineRepo, head.sha);
			const plan = planContextChange({
				request: req,
				actor,
				now: this.now(),
				idempotencyKey: key,
				previous: text === null ? null : { path, text },
				currentVersion: sitting?.version ?? null,
				existingPaths: [...tree.keys()],
			});
			if (!plan.ok) return failure(plan.code === "INVALID_INPUT" ? 400 : 409, plan.code, plan.message);

			let committed: { commitSha: string };
			try {
				// The commit's author is the acting human. The poller refuses a baseline change authored by anyone else.
				committed = await this.#artifacts.commitFiles({
					repo: baselineRepo,
					files: plan.files,
					message: plan.message,
					author: { name: actor.id, email: `${actor.id}@delta.invalid` },
					committer: WORKER_IDENTITY,
					expectedHead: head.sha,
				});
				// Remember it now: only a commit recorded here can be accepted as context when the poller reads it back.
				this.#meta.markWritten(committed.commitSha, "context", actor.id);
			} catch (error) {
				if (error instanceof PortError && error.code === "STALE_HEAD") return failure(409, "BASELINE_MOVED", "the baseline moved while this change was being written; reload and try again");
				throw error;
			}

			// Do not wait for the next tick: observe the commit now. The poller will see it too, and R9 drops the repeat.
			let observed = true;
			try {
				const row = this.#meta.trackedRepo(baselineRepo);
				if (row) await this.#pollRepo(row);
			} catch (error) {
				observed = false;
				console.error("could not observe our own commit yet", error instanceof Error ? error.message : error);
			}
			return {
				status: 201,
				body: { commitSha: committed.commitSha, recordId: plan.recordId, version: plan.version, kind: plan.kind, path: plan.path, decisionPath: plan.decisionPath, observed },
			};
		});
	}

	// ---------- resolutions ----------

	resolve(workItemId: string, input: unknown, actor: Actor, key: string): Promise<CellResult> {
		return this.#idempotent(key, `resolve:${workItemId}`, { actor, input }, async () => {
			const parsed = ResolveRequest.safeParse(input);
			if (!parsed.success) return invalidInput(parsed.error, "resolution");
			const req = parsed.data;
			const ts = this.now();
			// The actor is the authenticated session's, handed in by the Worker; the body has no such field.
			const event = {
				type: "ResolutionRecorded" as const,
				ts,
				requestId: key,
				resolution: {
					kind: req.kind,
					workItemId,
					actor,
					rationale: req.rationale,
					...(req.scope ? { scope: req.scope } : {}),
					binding: req.binding,
					requestId: key,
					ts,
				},
			};
			const checked = DeltaEvent.safeParse(event);
			if (!checked.success) return invalidInput(checked.error, "resolution");
			const result = await this.#submit(checked.data);
			const refusal = refusalOf(result.effects);
			const seq = result.entry?.seq ?? null;
			if (refusal) {
				return { status: refusal.status, body: { error: { code: refusal.code, message: refusal.message }, recorded: seq !== null, seq, effects: result.effects } };
			}
			return { status: 200, body: { recorded: true, outcome: result.outcome, seq, effects: result.effects } };
		});
	}

	// ---------- promotion: request, merge, record ----------

	promote(workItemId: string, input: unknown, actor: Actor, key: string): Promise<CellResult> {
		return this.#idempotent(key, `promote:${workItemId}`, { actor, input }, async () => {
			const parsed = PromoteRequest.safeParse(input);
			if (!parsed.success) return invalidInput(parsed.error, "promote request");
			const req = parsed.data;
			const baselineRepo = this.#baselineRepo();
			const before = await this.#requireState();
			const forkRepo = before.workItems[workItemId]?.item.forkRepo;

			// Be current first, so the reconciler's re-check (R7) runs against the heads that exist now.
			await this.#pollAll(forkRepo ? [baselineRepo, forkRepo] : [baselineRepo]);

			// Phase 1: PromotionRequested. The reconciler re-runs the gate and either refuses or emits ALLOW_PROMOTION.
			const requested = await this.#submit({
				type: "PromotionRequested",
				ts: this.now(),
				requestId: key,
				workItemId,
				actor,
				expectedBaselineCommit: req.expectedBaselineCommit,
				forkHeadSha: req.forkHeadSha,
			});
			const allow = requested.effects.find((e): e is Extract<Effect, { type: "ALLOW_PROMOTION" }> => e.type === "ALLOW_PROMOTION");
			if (!allow) {
				const refusal = refusalOf(requested.effects);
				if (refusal) return { status: refusal.status, body: { error: { code: refusal.code, message: refusal.message }, promoted: false, effects: requested.effects } };
				const blocked = requested.effects.find((e) => e.type === "BLOCK_PROMOTION");
				return {
					status: 409,
					body: { error: { code: "PROMOTION_BLOCKED", message: "the promotion gate does not pass", reasonCodes: blocked?.reasonCodes ?? [] }, promoted: false, effects: requested.effects },
				};
			}

			// Phase 2: the merge, compare-and-swap on the baseline commit the approval was given against.
			let mergeCommitSha: string;
			try {
				const wi = (await this.#requireState()).workItems[workItemId] as WorkItemState;
				({ mergeCommitSha } = await this.#artifacts.mergeFork({
					baselineRepo,
					forkRepo: wi.item.forkRepo,
					expectedBaselineCommit: allow.baselineCommit,
					forkHeadSha: allow.forkHeadSha,
					message: `promote ${workItemId}\n\nPromoted-by: ${actor.id}\nIdempotency-Key: ${key}\n`,
					author: { name: actor.id, email: `${actor.id}@delta.invalid` },
					committer: WORKER_IDENTITY,
				}));
				// A promotion carries a fork's files; it is recorded so it can never be read back as a context change.
				this.#meta.markWritten(mergeCommitSha, "merge", actor.id);
			} catch (error) {
				if (error instanceof PortError && error.code === "STALE_HEAD") {
					return { status: 409, body: { error: { code: "BASELINE_MOVED", message: "the baseline or the fork moved before the merge; request promotion again" }, promoted: false } };
				}
				if (error instanceof PortError && error.code === "MERGE_CONFLICT") {
					return { status: 409, body: { error: { code: "MERGE_CONFLICT", message: error.message }, promoted: false } };
				}
				// Stored on purpose: a retry with this key would find the request already recorded. Use a new key.
				return {
					status: 502,
					remember: true,
					body: { error: { code: "MERGE_FAILED", message: "the merge could not be completed; retry with a new Idempotency-Key" }, promoted: false },
				};
			}

			// Phase 3: PromotionMerged. The reconciler runs the gate once more; it only records a promotion if it still passes.
			const merged = await this.#submit({ type: "PromotionMerged", ts: this.now(), workItemId, repo: baselineRepo, mergeCommitSha });
			const row = this.#meta.trackedRepo(baselineRepo);
			if (row) await this.#pollRepo(row).catch(() => 0); // consume the merge commit as a baseline push
			const after = (await this.#requireState()).workItems[workItemId];
			if (after?.item.status !== "promoted") {
				return {
					status: 409,
					body: {
						error: { code: "PROMOTION_NOT_RECORDED", message: "the merge reached the baseline but the gate no longer passed, so it was not recorded as a promotion" },
						promoted: false,
						mergeCommitSha,
						effects: merged.effects,
					},
				};
			}
			return { status: 200, body: { promoted: true, workItemId, mergeCommitSha, seq: merged.entry?.seq ?? null } };
		});
	}

	// ---------- observations from inside the Worker ----------

	/** Delta-run evidence and agent run markers. Internal (Durable Object RPC) only: they are not reachable over HTTP. */
	recordObservation(input: unknown): Promise<{ outcome: string; seq: number | null }> {
		return this.#serial(async () => {
			const event = DeltaEvent.parse(input);
			if (event.type !== "EvidenceRecorded" && event.type !== "AgentRunStarted" && event.type !== "AgentRunFinished") {
				throw new Error(`recordObservation does not take ${event.type}`);
			}
			const result = await this.#submit(event);
			return { outcome: result.outcome, seq: result.entry?.seq ?? null };
		});
	}
}

/** The work items an event touched, in id order: those named by its effects or by the event itself. */
function touchedItems(state: CellState, entry: ReconciliationEvent): WorkItemState[] {
	const ids = new Set<string>();
	const event = entry.payload.event;
	if (event.type === "WorkItemRegistered") ids.add(event.item.id);
	else if ("workItemId" in event) ids.add(event.workItemId);
	else if (event.type === "ResolutionRecorded") ids.add(event.resolution.workItemId);
	else if (event.type === "EvidenceRecorded") ids.add(event.evidence.workItemId);
	for (const effect of entry.payload.effects) {
		if ("workItemId" in effect && effect.workItemId) ids.add(effect.workItemId);
	}
	return [...ids]
		.sort()
		.map((id) => state.workItems[id])
		.filter((wi): wi is WorkItemState => wi !== undefined);
}
