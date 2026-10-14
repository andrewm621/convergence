import { CellSnapshot, Dependency, IsoTimestamp, ReasonCode, RecordHistory, WsMessage, type AgentActivity } from "contracts";
import { z } from "zod";
import { API_BASE, POLL_INTERVAL_MS } from "@/config";
import { readToken, socketProtocols } from "./auth";
import { endpoints, NOT_IMPLEMENTED } from "./endpoints";
import type { AgentRunSummary, ClientHandlers, CommandResult, ConnectionState, ConsoleApi, ConsoleClient, ConsoleMessage, GateResult, MessageMeta, PollerHealth, ScenarioName } from "./types";

/**
 * The live client for the Worker's control loop (docs/control-loop.md).
 *
 *  - REST is `/api/scenarios/:s/...`, every route authenticated with the bearer secret; the
 *    WebSocket carries it in the subprotocol (`["delta.v1", "bearer.<b64url>"]`), because a
 *    browser cannot set headers on one;
 *  - every frame is a contract `WsMessage` plus a top-level `meta` (seq, gap, replay, evaluationMs,
 *    poller health), which is split off before the strict parse;
 *  - connect, receive `snapshot` first, then `event` and `agent-activity`; every `event` carries
 *    the ledger `seq`, and a hole in the sequence triggers a REST re-read. `agent-activity` has no
 *    seq in the contract; `meta.seq` is the ledger head when it was sent, so an activity ahead of
 *    what we have seen means a missed event;
 *  - on reconnect pass `?since=<seq>`; the Worker answers with a fresh snapshot and then the missed
 *    events (`meta.replay`), and the console accepts either;
 *  - if the socket keeps failing, poll the REST state every 3 seconds and keep trying the socket.
 *
 * The token is read from sessionStorage on use and is never logged or put in a URL.
 */

export type LiveOptions = {
	scenario: ScenarioName;
	/** The named cell to open, when it is not the scenario's own (`notifications-demo` for `notifications`). */
	cell?: string;
	apiBase?: string;
	fetchImpl?: typeof fetch;
	WebSocketImpl?: typeof WebSocket;
	pollIntervalMs?: number;
	/** Consecutive socket failures before polling starts. */
	failuresBeforePolling?: number;
	/** Where the bearer secret comes from. Defaults to sessionStorage. */
	token?: () => string | null;
};

const GateResponse = z.object({
	pass: z.boolean(),
	reasonCodes: z.array(ReasonCode),
	blockers: z.array(z.string()).optional().default([]),
	waivedBy: z
		.array(
			z.object({
				kind: z.string().optional(),
				scope: z.string().optional(),
				rationale: z.string().optional(),
				actor: z.object({ displayName: z.string() }).optional(),
			}),
		)
		.optional()
		.default([]),
	// A work item whose agent has not pushed yet has no fork head: the Worker sends null.
	baselineCommit: z.string().nullish(),
	forkHeadSha: z.string().nullish(),
});

/** `{ error: { code, message, reasonCodes? } }`. The first console build assumed top-level fields, so those are read as a fallback. */
function errorDetail(json: unknown): { code?: string; message?: string; reasonCodes?: ReasonCode[] } {
	if (!json || typeof json !== "object") return {};
	const nested = (json as { error?: unknown }).error;
	const source = nested && typeof nested === "object" ? (nested as Record<string, unknown>) : (json as Record<string, unknown>);
	const codes = Array.isArray(source.reasonCodes) ? source.reasonCodes.flatMap((c) => (ReasonCode.safeParse(c).success ? [c as ReasonCode] : [])) : undefined;
	return {
		code: typeof source.code === "string" ? source.code : undefined,
		message: typeof source.message === "string" ? source.message : undefined,
		reasonCodes: codes && codes.length > 0 ? codes : undefined,
	};
}

const PollerSchema = z.object({
	healthy: z.boolean(),
	degraded: z.array(z.object({ repo: z.string(), kind: z.enum(["baseline", "fork"]), lastError: z.string().nullable(), note: z.string().nullable() })),
});

/** Each meta field is read on its own, so one the console does not understand cannot hide the others. */
export function readMeta(raw: unknown): MessageMeta | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const meta: MessageMeta = {};
	if (typeof source.seq === "number") meta.seq = source.seq;
	if (typeof source.replay === "boolean") meta.replay = source.replay;
	if (typeof source.gap === "boolean") meta.gap = source.gap;
	if (typeof source.evaluationMs === "number") meta.evaluationMs = source.evaluationMs;
	if (typeof source.baselineCommit === "string") meta.baselineCommit = source.baselineCommit;
	if (typeof source.snapshotHash === "string") meta.snapshotHash = source.snapshotHash;
	const bySeq = z.record(z.string(), z.number()).safeParse(source.evaluationMsBySeq);
	if (bySeq.success) meta.evaluationMsBySeq = bySeq.data;
	const poller = PollerSchema.safeParse(source.poller);
	if (poller.success) meta.poller = poller.data;
	const dependencies = z.array(Dependency).safeParse(source.dependencies);
	if (dependencies.success) meta.dependencies = dependencies.data;
	const records = z.record(z.string(), RecordHistory).safeParse(source.records);
	if (records.success) meta.records = records.data;
	return Object.keys(meta).length > 0 ? meta : undefined;
}

class UnauthorizedError extends Error {
	constructor() {
		super("The Worker refused the access token.");
	}
}

export function createLiveClient(options: LiveOptions): ConsoleClient {
	/** The cell every route is scoped to. */
	const cell = options.cell ?? options.scenario;
	const base = options.apiBase ?? API_BASE;
	const pollMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const failuresBeforePolling = options.failuresBeforePolling ?? 2;
	const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));
	const SocketCtor = options.WebSocketImpl ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
	const getToken = options.token ?? (() => readToken());

	let handlers: ClientHandlers | null = null;
	let socket: WebSocket | null = null;
	let lastSeq = 0;
	let failures = 0;
	let disposed = false;
	let halted = false;
	let resyncing = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	const setConnection = (state: ConnectionState) => handlers?.onConnection(state);

	function socketUrl(): string {
		const path = endpoints.socket(cell);
		const root = base || (typeof location === "undefined" ? "" : location.origin);
		const url = new URL(path, root.replace(/^http/, "ws"));
		if (lastSeq > 0) url.searchParams.set("since", String(lastSeq));
		return url.toString();
	}

	function authHeaders(): Record<string, string> {
		const token = getToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}

	/** The Worker refused the secret: stop hammering it and let the header offer to re-enter it. */
	function halt() {
		halted = true;
		stopPolling();
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;
		socket?.close();
		socket = null;
		setConnection("unauthorized");
	}

	async function readState(): Promise<void> {
		const response = await doFetch(`${base}${endpoints.state(cell)}`, { headers: { Accept: "application/json", ...authHeaders() } });
		if (response.status === 401) throw new UnauthorizedError();
		if (!response.ok) throw new Error(`state read failed: ${response.status}`);
		const snapshot = CellSnapshot.parse(await response.json());
		lastSeq = snapshot.ledgerHead.seq;
		// The REST read cannot list failing repos, but its header says whether any are failing.
		const header = response.headers.get("X-Delta-Poller");
		const poller: PollerHealth | undefined = header === "degraded" ? { healthy: false, degraded: [] } : header === "healthy" ? { healthy: true, degraded: [] } : undefined;
		handlers?.onMessage({ type: "snapshot", snapshot, meta: { seq: lastSeq, ...(poller ? { poller } : {}) } });
	}

	/** One re-read at a time, however many hints arrive while it is in flight. */
	function resync() {
		if (resyncing) return;
		resyncing = true;
		void readState()
			.catch((error: unknown) => {
				if (error instanceof UnauthorizedError) halt();
			})
			.finally(() => {
				resyncing = false;
			});
	}

	function startPolling() {
		if (pollTimer || halted) return;
		setConnection("polling");
		const tick = () => {
			readState().catch((error: unknown) => {
				if (error instanceof UnauthorizedError) halt();
				else setConnection("offline");
			});
		};
		tick();
		pollTimer = setInterval(tick, pollMs);
	}

	function stopPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
	}

	function scheduleReconnect() {
		if (disposed || halted || reconnectTimer) return;
		failures += 1;
		if (failures >= failuresBeforePolling) startPolling();
		else setConnection("reconnecting");
		// Back off, but keep knocking while polling so the socket takes over again when it can.
		const delay = Math.min(500 * 2 ** (failures - 1), 8000);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			openSocket();
		}, delay);
	}

	function onSocketMessage(raw: unknown) {
		let json: unknown;
		try {
			json = JSON.parse(String(raw));
		} catch {
			return;
		}
		// The strict contract schemas do not know `meta`: split it off, then parse the rest.
		let meta: MessageMeta | undefined;
		if (json && typeof json === "object" && "meta" in json) {
			const { meta: rawMeta, ...rest } = json as { meta?: unknown };
			meta = readMeta(rawMeta);
			json = rest;
		}
		const parsed = WsMessage.safeParse(json);
		if (!parsed.success) return;
		const message: ConsoleMessage = meta ? { ...parsed.data, meta } : parsed.data;
		if (message.type === "snapshot") {
			lastSeq = message.snapshot.ledgerHead.seq;
			failures = 0;
			stopPolling();
			setConnection("live");
			handlers?.onMessage(message);
		} else if (message.type === "event") {
			const seq = message.event.seq;
			if (seq <= lastSeq) return; // a replayed line we already have
			if (seq > lastSeq + 1) {
				// A hole in the ledger: do not apply a line we cannot place. Re-read the state.
				resync();
				return;
			}
			lastSeq = seq;
			handlers?.onMessage(message);
		} else {
			// agent-activity is live only and has no seq of its own. Its meta.seq is the ledger head when it
			// was sent: ahead of what we have applied means an event was lost on the way.
			if (meta?.seq !== undefined && meta.seq > lastSeq) resync();
			handlers?.onMessage(message);
		}
	}

	function openSocket() {
		if (disposed || halted) return;
		if (!SocketCtor) {
			startPolling();
			return;
		}
		if (failures === 0) setConnection("connecting");
		let ws: WebSocket;
		try {
			ws = new SocketCtor(socketUrl(), socketProtocols(getToken()));
		} catch {
			scheduleReconnect();
			return;
		}
		socket = ws;
		ws.onmessage = (e) => onSocketMessage(e.data);
		ws.onclose = () => {
			if (socket === ws) socket = null;
			scheduleReconnect();
		};
		ws.onerror = () => {
			// `onclose` follows; reconnection is scheduled there.
		};
	}

	// ---------- REST commands ----------

	async function send(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
		return doFetch(`${base}${path}`, {
			method,
			headers: {
				Accept: "application/json",
				...authHeaders(),
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	}

	async function command(path: string, body: unknown, idempotencyKey: string): Promise<CommandResult> {
		try {
			const response = await send("POST", path, body, idempotencyKey);
			if (response.ok) {
				const json: unknown = await response.json().catch(() => null);
				return { ok: true, message: successMessage(json) };
			}
			if (response.status === 401) halt();
			const detail = errorDetail(await response.json().catch(() => null));
			return { ok: false, code: detail.code ?? String(response.status), message: detail.message ?? `The server answered ${response.status}.`, reasonCodes: detail.reasonCodes };
		} catch {
			return { ok: false, code: "NETWORK", message: "Could not reach the Convergence API." };
		}
	}

	function unavailable(route: string): CommandResult {
		return { ok: false, code: "NOT_IMPLEMENTED", message: `The Worker does not offer ${route} yet.` };
	}

	const api: ConsoleApi = {
		async gate(workItemId): Promise<GateResult> {
			const response = await send("GET", endpoints.gate(cell, workItemId));
			if (response.status === 401) halt();
			if (!response.ok) throw new Error(errorDetail(await response.json().catch(() => null)).message ?? `gate read failed: ${response.status}`);
			const parsed = GateResponse.safeParse(await response.json().catch(() => null));
			if (!parsed.success) throw new Error("The gate answer was not in the expected shape.");
			const gate = parsed.data;
			return {
				pass: gate.pass,
				reasonCodes: gate.reasonCodes,
				blockers: gate.blockers,
				waivedBy: gate.waivedBy.map((w) => ({ kind: w.kind, scope: w.scope, rationale: w.rationale, actor: w.actor?.displayName })),
				...(gate.baselineCommit ? { baselineCommit: gate.baselineCommit } : {}),
				...(gate.forkHeadSha ? { forkHeadSha: gate.forkHeadSha } : {}),
			};
		},
		// Per-file diffs are not served yet; the Changes tab says so (capabilities.changes) and does not ask.
		async changes() {
			return [];
		},
		// Runs are keyed by agent id (the lowercase work item id) across every cell. A 404, a network error or a run of
		// another cell is not a problem: that work item simply has nothing earlier to show.
		async agentRuns(workItems) {
			const runs = await Promise.all(
				workItems.map(async (item): Promise<AgentRunSummary | null> => {
					try {
						const response = await send("GET", endpoints.agentRun(item.id.toLowerCase()));
						if (response.status === 401) halt();
						if (!response.ok) return null;
						return summarizeRun(item, await response.json().catch(() => null));
					} catch {
						return null;
					}
				}),
			);
			return runs.flatMap((run) => (run ? [run] : []));
		},
		async readRecordText(recordId) {
			const response = await send("GET", endpoints.context(cell, recordId));
			return response.ok ? await response.text() : "";
		},
		proposeContextChange: (input, key) => command(endpoints.contextChanges(cell), input, key),
		resolve: (input, key) => command(endpoints.resolutions(cell, input.workItemId), input, key),
		promote: (input, key) => command(endpoints.promote(cell, input.workItemId), input, key),
		decideDependency: (input, key) => command(endpoints.dependencies(cell, input.workItemId), { recordId: input.recordId, decision: input.decision }, key),
		seedScenario: async () => unavailable(NOT_IMPLEMENTED.seed),
		startScenario: async () => unavailable(NOT_IMPLEMENTED.start),
	};

	return {
		kind: "live",
		scenario: options.scenario,
		capabilities: { seed: false, start: false, changes: false },
		api,
		connect(next) {
			handlers = next;
			disposed = false;
			halted = false;
			failures = 0;
			lastSeq = 0;
			openSocket();
			return () => {
				disposed = true;
				handlers = null;
				if (reconnectTimer) clearTimeout(reconnectTimer);
				reconnectTimer = null;
				stopPolling();
				socket?.close();
				socket = null;
			};
		},
		refresh: () => readState(),
	};
}

/** The part of `GET /api/agents/runs/:agentId` the console reads. Every other field is ignored. */
const RunResponse = z.object({
	forkRepo: z.string(),
	mode: z.string().nullish(),
	model: z.string().nullish(),
	runId: z.string().nullish(),
	activity: z.array(z.unknown()).nullish(),
});

const RunLine = z.object({ ts: IsoTimestamp, kind: z.string(), text: z.string() });

/** The Worker's activity kinds are open-ended ("clone", "push", ...); the console draws four. Anything else reads as a status line. */
function lineKind(kind: string): AgentActivity["kind"] {
	return kind === "tool" || kind === "text" || kind === "error" ? kind : "status";
}

/**
 * One agent run in the console's terms, or null when it is not this work item's: runs are keyed by agent id across every
 * cell, so the run must have worked on the fork this cell registered for the item. Lines that do not parse are dropped.
 */
export function summarizeRun(item: { id: string; forkRepo: string }, raw: unknown): AgentRunSummary | null {
	const parsed = RunResponse.safeParse(raw);
	if (!parsed.success || parsed.data.forkRepo !== item.forkRepo) return null;
	const run = parsed.data;
	const runId = run.runId || item.id.toLowerCase();
	const activity: AgentActivity[] = [];
	for (const line of run.activity ?? []) {
		const one = RunLine.safeParse(line);
		if (one.success) activity.push({ type: "agent-activity", workItemId: item.id, runId, kind: lineKind(one.data.kind), text: one.data.text, ts: one.data.ts });
	}
	return { workItemId: item.id, model: run.mode === "stub" ? "stub agent" : run.model || null, activity };
}

/** A short line for a toast: what a successful command did, from whatever the Worker returned. */
function successMessage(json: unknown): string | undefined {
	if (!json || typeof json !== "object") return undefined;
	const body = json as { message?: unknown; commitSha?: unknown; mergeCommitSha?: unknown };
	if (typeof body.message === "string") return body.message;
	const sha = typeof body.commitSha === "string" ? body.commitSha : typeof body.mergeCommitSha === "string" ? body.mergeCommitSha : null;
	return sha ? `Committed ${sha.slice(0, 7)}.` : undefined;
}
