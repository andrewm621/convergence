import type { CellSnapshot } from "contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMock } from "@/test/harness";
import { toBase64Url } from "./auth";
import { createLiveClient, readMeta } from "./live";
import { newIdempotencyKey, type ConnectionState, type ConsoleMessage } from "./types";

const SECRET = "s3cret+/token=";

/** A WebSocket you can drive by hand. */
class FakeSocket {
	static instances: FakeSocket[] = [];
	protocols: string[] | string | undefined;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	constructor(
		readonly url: string,
		protocols?: string[] | string,
	) {
		this.protocols = protocols;
		FakeSocket.instances.push(this);
	}
	send(message: unknown) {
		this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
	}
	close() {
		this.closed = true;
	}
	drop() {
		this.onclose?.();
	}
}

async function realisticMessages() {
	const mock = await startMock();
	await mock.jump(4);
	const snapshotMessage = mock.messages.find((m) => m.type === "snapshot");
	if (!snapshotMessage || snapshotMessage.type !== "snapshot") throw new Error("no snapshot");
	// A snapshot at beat 4 and the events that follow it (beats 5 and 6).
	const base = mock.view.ledgerHead.seq;
	const snapshot: CellSnapshot = {
		scenario: mock.view.scenario,
		baselineCommit: mock.view.baselineCommit,
		snapshotHash: mock.view.snapshotHash,
		policy: mock.view.policy as NonNullable<typeof mock.view.policy>,
		records: mock.view.records,
		workItems: Object.values(mock.view.workItems),
		dependencies: mock.view.dependencies,
		ledgerTail: mock.view.ledger,
		ledgerHead: mock.view.ledgerHead,
	};
	const start = mock.messages.length;
	await mock.next(2);
	const events = mock.messages.slice(start).filter((m) => m.type === "event");
	mock.stop();
	return { snapshot, events, base };
}

describe("live client: the WebSocket contract", () => {
	let fixture: Awaited<ReturnType<typeof realisticMessages>>;
	// Built with real timers: the mock needs them. Each test then runs on fake ones.
	beforeAll(async () => {
		fixture = await realisticMessages();
	});
	const realisticMessagesCached = async () => fixture;

	beforeEach(() => {
		FakeSocket.instances = [];
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	function connect(extra: Partial<Parameters<typeof createLiveClient>[0]> = {}) {
		const messages: ConsoleMessage[] = [];
		const states: ConnectionState[] = [];
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", WebSocketImpl: FakeSocket as unknown as typeof WebSocket, fetchImpl, pollIntervalMs: 3000, token: () => SECRET, ...extra });
		const stop = client.connect({ onMessage: (m) => messages.push(m), onConnection: (s) => states.push(s) });
		return { client, messages, states, fetchImpl, stop };
	}

	it("waits for a snapshot, then applies events in order and drops replays", async () => {
		const { snapshot, events } = await realisticMessagesCached();
		const { messages, states } = connect();
		const socket = FakeSocket.instances[0] as FakeSocket;
		expect(socket.url).toBe("ws://delta.test/api/scenarios/notifications/ws");
		// The secret rides in the subprotocol, never the URL.
		expect(socket.protocols).toEqual(["delta.v1", `bearer.${toBase64Url(SECRET)}`]);
		expect(socket.url).not.toContain("s3cret");
		expect(states).toEqual(["connecting"]);

		socket.send({ type: "snapshot", snapshot });
		expect(states.at(-1)).toBe("live");
		for (const event of events) socket.send(event);
		socket.send(events[0]); // a replayed line
		expect(messages.map((m) => m.type)).toEqual(["snapshot", ...events.map(() => "event")]);
	});

	it("a named cell scopes the socket and every route to that cell, and the token still rides in the subprotocol", async () => {
		const { client, fetchImpl } = connect({ cell: "notifications-demo" });
		const socket = FakeSocket.instances[0] as FakeSocket;
		expect(socket.url).toBe("ws://delta.test/api/scenarios/notifications-demo/ws");
		expect(socket.protocols).toEqual(["delta.v1", `bearer.${toBase64Url(SECRET)}`]);
		expect(client.scenario).toBe("notifications"); // the scenario the cell shows, for the labels
		fetchImpl.mockResolvedValue(new Response(JSON.stringify({ pass: true, reasonCodes: [] }), { status: 200 }));
		await client.api.gate("WI-2");
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://delta.test/api/scenarios/notifications-demo/work-items/WI-2/gate");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
	});

	it("passes the last seq as ?since= when it reconnects", async () => {
		const { snapshot, events } = await realisticMessagesCached();
		const { states } = connect();
		const first = FakeSocket.instances[0] as FakeSocket;
		first.send({ type: "snapshot", snapshot });
		for (const event of events) first.send(event);
		const lastSeq = events.at(-1)?.type === "event" ? (events.at(-1) as { event: { seq: number } }).event.seq : 0;

		first.drop();
		expect(states.at(-1)).toBe("reconnecting");
		await vi.advanceTimersByTimeAsync(600);
		const second = FakeSocket.instances[1] as FakeSocket;
		expect(new URL(second.url).searchParams.get("since")).toBe(String(lastSeq));
	});

	it("accepts a fresh snapshot when the server cannot resume (a gap)", async () => {
		const { snapshot } = await realisticMessagesCached();
		const { messages } = connect();
		const socket = FakeSocket.instances[0] as FakeSocket;
		socket.send({ type: "snapshot", snapshot });
		socket.drop();
		await vi.advanceTimersByTimeAsync(600);
		(FakeSocket.instances[1] as FakeSocket).send({ type: "snapshot", snapshot: { ...snapshot, ledgerHead: { ...snapshot.ledgerHead, seq: snapshot.ledgerHead.seq + 5 } } });
		expect(messages.filter((m) => m.type === "snapshot")).toHaveLength(2);
	});

	it("re-reads the state over REST when the ledger has a hole", async () => {
		const { snapshot, events } = await realisticMessagesCached();
		const { fetchImpl } = connect();
		fetchImpl.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));
		const socket = FakeSocket.instances[0] as FakeSocket;
		socket.send({ type: "snapshot", snapshot });
		const second = events[1] as { type: "event"; event: { seq: number } };
		socket.send(events[1]); // skips events[0]
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://delta.test/api/scenarios/notifications/state");
		expect(second.event.seq).toBeGreaterThan(snapshot.ledgerHead.seq + 1);
	});

	it("falls back to polling the REST state every 3 seconds when the socket keeps failing", async () => {
		const { snapshot } = await realisticMessagesCached();
		const { states, messages, fetchImpl } = connect();
		fetchImpl.mockImplementation(async () => new Response(JSON.stringify(snapshot), { status: 200 }));

		(FakeSocket.instances[0] as FakeSocket).drop();
		await vi.advanceTimersByTimeAsync(600);
		(FakeSocket.instances[1] as FakeSocket).drop();
		expect(states.at(-1)).toBe("polling");
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(messages.filter((m) => m.type === "snapshot").length).toBeGreaterThanOrEqual(3);

		// When the socket comes back it takes over and polling stops.
		await vi.advanceTimersByTimeAsync(2000);
		const latest = FakeSocket.instances.at(-1) as FakeSocket;
		latest.send({ type: "snapshot", snapshot });
		expect(states.at(-1)).toBe("live");
		const calls = fetchImpl.mock.calls.length;
		await vi.advanceTimersByTimeAsync(9000);
		expect(fetchImpl.mock.calls.length).toBe(calls);
	});

	it("goes offline when neither the socket nor REST answer", async () => {
		const { states, fetchImpl } = connect();
		fetchImpl.mockRejectedValue(new Error("down"));
		(FakeSocket.instances[0] as FakeSocket).drop();
		await vi.advanceTimersByTimeAsync(600);
		(FakeSocket.instances[1] as FakeSocket).drop();
		await vi.advanceTimersByTimeAsync(10);
		expect(states.at(-1)).toBe("offline");
	});

	it("ignores messages that are not part of the contract", async () => {
		const { messages } = connect();
		const socket = FakeSocket.instances[0] as FakeSocket;
		socket.send({ type: "something-else" });
		socket.send("not json");
		expect(messages).toHaveLength(0);
	});
});

describe("live client: commands", () => {
	it("sends every mutation with an Idempotency-Key and reads the gate dry run", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", fetchImpl, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, token: () => SECRET });

		fetchImpl.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					pass: true,
					reasonCodes: ["EXCEPTION_APPLIED"],
					blockers: [],
					waivedBy: [{ kind: "accept-exception", scope: "Hall A only", rationale: "ok", actor: { kind: "human", id: "d", displayName: "Andrew" } }],
					baselineCommit: "b".repeat(40),
					snapshotHash: "c".repeat(64),
					forkHeadSha: "f".repeat(40),
				}),
				{ status: 200 },
			),
		);
		const gate = await client.api.gate("WI-2");
		expect(gate).toMatchObject({ pass: true, reasonCodes: ["EXCEPTION_APPLIED"], blockers: [], waivedBy: [{ kind: "accept-exception", scope: "Hall A only", actor: "Andrew" }], forkHeadSha: "f".repeat(40) });
		// Work item routes are scoped to the scenario and sit under /api, and carry the bearer secret.
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://delta.test/api/scenarios/notifications/work-items/WI-2/gate");
		expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ pass: false, reasonCodes: ["STALE_RECEIPT", "TEST_FAILED"], blockers: ["x"], waivedBy: [] }), { status: 200 }));
		expect(await client.api.gate("WI-2")).toEqual({ pass: false, reasonCodes: ["STALE_RECEIPT", "TEST_FAILED"], blockers: ["x"], waivedBy: [] });
		fetchImpl.mockClear();
		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ pass: false, reasonCodes: [], blockers: [], waivedBy: [] }), { status: 200 }));
		await client.api.gate("WI-2");
		fetchImpl.mockClear();

		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Committed." }), { status: 200 }));
		const result = await client.api.proposeContextChange({ recordId: "notifications", facets: { "notifications.default": "opt-in" }, prose: "x", rationale: "y" }, "key-123");
		expect(result).toEqual({ ok: true, message: "Committed." });
		const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
		expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-123");
		expect(init.method).toBe("POST");
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://delta.test/api/scenarios/notifications/context-changes");

		// The Worker's error shape: { error: { code, message, reasonCodes } }.
		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "STALE_BINDING", message: "Moved.", reasonCodes: ["STALE_BINDING"] } }), { status: 409 }));
		const refused = await client.api.promote({ workItemId: "WI-2", expectedBaselineCommit: "b".repeat(40), forkHeadSha: "f".repeat(40) }, "key-456");
		expect(refused).toEqual({ ok: false, code: "STALE_BINDING", message: "Moved.", reasonCodes: ["STALE_BINDING"] });
		expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://delta.test/api/scenarios/notifications/work-items/WI-2/promote");

		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ commitSha: "abcdef1234567890" }), { status: 201 }));
		expect(await client.api.resolve({ kind: "revalidate", workItemId: "WI-2", rationale: "r", binding: {} as never }, "key-789")).toEqual({ ok: true, message: "Committed abcdef1." });
		expect(String(fetchImpl.mock.calls[2]?.[0])).toBe("http://delta.test/api/scenarios/notifications/work-items/WI-2/resolutions");
	});

	it("reads a gate for work that has not pushed yet (the Worker sends a null fork head)", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", fetchImpl, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, token: () => SECRET });
		fetchImpl.mockResolvedValueOnce(
			new Response(JSON.stringify({ pass: false, reasonCodes: ["MISSING_EVIDENCE", "STALE_RECEIPT"], blockers: ["Stale."], waivedBy: [], baselineCommit: "b".repeat(40), snapshotHash: "c".repeat(64), forkHeadSha: null }), { status: 200 }),
		);
		const gate = await client.api.gate("WI-2");
		expect(gate).toEqual({ pass: false, reasonCodes: ["MISSING_EVIDENCE", "STALE_RECEIPT"], blockers: ["Stale."], waivedBy: [], baselineCommit: "b".repeat(40) });
		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ nonsense: true }), { status: 200 }));
		await expect(client.api.gate("WI-2")).rejects.toThrow("not in the expected shape");
	});

	it("reads a blocked promote's reason codes out of error.reasonCodes", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", fetchImpl, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, token: () => SECRET });
		fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "PROMOTION_BLOCKED", message: "Blocked.", reasonCodes: ["STALE_RECEIPT", "NOT_A_REAL_CODE"] } }), { status: 409 }));
		const result = await client.api.promote({ workItemId: "WI-2", expectedBaselineCommit: "b".repeat(40), forkHeadSha: "f".repeat(40) }, "k");
		expect(result).toEqual({ ok: false, code: "PROMOTION_BLOCKED", message: "Blocked.", reasonCodes: ["STALE_RECEIPT"] });
	});

	it("does not offer the routes the Worker does not have: seed, start and per-file changes", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", fetchImpl, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, token: () => SECRET });
		expect(client.capabilities).toEqual({ seed: false, start: false, changes: false });
		expect(await client.api.seedScenario("k")).toMatchObject({ ok: false, code: "NOT_IMPLEMENTED" });
		expect(await client.api.startScenario("k")).toMatchObject({ ok: false, code: "NOT_IMPLEMENTED" });
		expect(await client.api.changes("WI-2")).toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("uses a fresh Idempotency-Key for each attempt the console makes", async () => {
		const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
		expect(keys.size).toBe(50);
		for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9._:~-]{1,128}$/);
	});

	it("reports an unreachable API as a failed command, not a crash", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", fetchImpl, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
		expect(await client.api.resolve({ kind: "reject", workItemId: "WI-2", rationale: "r", binding: {} as never }, "k")).toMatchObject({ ok: false, code: "NETWORK" });
	});
});

describe("live client: frame meta, poller health and auth", () => {
	beforeEach(() => {
		FakeSocket.instances = [];
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	function open(extra: Partial<Parameters<typeof createLiveClient>[0]> = {}) {
		const messages: ConsoleMessage[] = [];
		const states: ConnectionState[] = [];
		const fetchImpl = vi.fn<typeof fetch>();
		const client = createLiveClient({ scenario: "notifications", apiBase: "http://delta.test", WebSocketImpl: FakeSocket as unknown as typeof WebSocket, fetchImpl, token: () => SECRET, ...extra });
		client.connect({ onMessage: (m) => messages.push(m), onConnection: (s) => states.push(s) });
		return { client, messages, states, fetchImpl, socket: FakeSocket.instances[0] as FakeSocket };
	}

	async function fixtureSnapshot(): Promise<CellSnapshot> {
		const mock = await startMock();
		await mock.jump(4);
		const snapshot = {
			scenario: mock.view.scenario,
			baselineCommit: mock.view.baselineCommit,
			snapshotHash: mock.view.snapshotHash,
			policy: mock.view.policy as NonNullable<typeof mock.view.policy>,
			records: mock.view.records,
			workItems: Object.values(mock.view.workItems),
			dependencies: mock.view.dependencies,
			ledgerTail: mock.view.ledger,
			ledgerHead: mock.view.ledgerHead,
		};
		mock.stop();
		return snapshot;
	}

	it("splits meta off before the strict parse and passes seq, replay, gap and poller through", async () => {
		vi.useRealTimers();
		const snapshot = await fixtureSnapshot();
		vi.useFakeTimers();
		const { messages, socket } = open();
		const poller = { healthy: false, degraded: [{ repo: "baseline-x", kind: "baseline", lastError: "timeout", note: "retrying" }] };
		socket.send({ type: "snapshot", snapshot, meta: { seq: snapshot.ledgerHead.seq, gap: true, poller, evaluationMsBySeq: { "3": 1.5 }, somethingNew: 1 } });
		expect(messages).toHaveLength(1);
		expect(messages[0]?.meta).toMatchObject({ seq: snapshot.ledgerHead.seq, gap: true, poller, evaluationMsBySeq: { "3": 1.5 } });
	});

	it("reads each meta field on its own, so one it does not understand cannot hide the rest", () => {
		const meta = readMeta({ seq: 4, poller: { healthy: "nope" }, evaluationMs: 2.5, dependencies: "bad", replay: true });
		expect(meta).toEqual({ seq: 4, evaluationMs: 2.5, replay: true });
		expect(readMeta(undefined)).toBeUndefined();
		expect(readMeta({})).toBeUndefined();
	});

	it("uses agent-activity's meta.seq as a gap signal: activity ahead of the ledger means a lost event", async () => {
		vi.useRealTimers();
		const snapshot = await fixtureSnapshot();
		vi.useFakeTimers();
		const { messages, socket, fetchImpl } = open();
		fetchImpl.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200 }));
		socket.send({ type: "snapshot", snapshot, meta: { seq: snapshot.ledgerHead.seq } });
		const activity = { type: "agent-activity", workItemId: "WI-1", runId: "run-1", kind: "status", text: "x", ts: "2026-10-13T11:00:00.000Z" };

		socket.send({ ...activity, meta: { seq: snapshot.ledgerHead.seq } }); // in step: no re-read
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchImpl).not.toHaveBeenCalled();

		socket.send({ ...activity, meta: { seq: snapshot.ledgerHead.seq + 2 } }); // two lines ahead: re-read, once
		socket.send({ ...activity, meta: { seq: snapshot.ledgerHead.seq + 2 } });
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(messages.filter((m) => m.type === "agent-activity")).toHaveLength(3);
	});

	it("takes the poller's health from the X-Delta-Poller header on a REST read", async () => {
		vi.useRealTimers();
		const snapshot = await fixtureSnapshot();
		vi.useFakeTimers();
		const { client, messages, fetchImpl } = open();
		fetchImpl.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200, headers: { "X-Delta-Poller": "degraded" } }));
		await client.refresh();
		expect(messages.at(-1)).toMatchObject({ type: "snapshot", meta: { poller: { healthy: false } } });
		fetchImpl.mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200, headers: { "X-Delta-Poller": "healthy" } }));
		await client.refresh();
		expect(messages.at(-1)).toMatchObject({ meta: { poller: { healthy: true } } });
	});

	it("stops retrying and says so when the Worker refuses the token", async () => {
		const { states, fetchImpl, socket } = open();
		fetchImpl.mockResolvedValue(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }), { status: 401 }));
		socket.drop();
		await vi.advanceTimersByTimeAsync(600);
		(FakeSocket.instances[1] as FakeSocket).drop(); // second failure: polling starts, the read gets a 401
		await vi.advanceTimersByTimeAsync(10);
		expect(states.at(-1)).toBe("unauthorized");
		const calls = fetchImpl.mock.calls.length;
		const sockets = FakeSocket.instances.length;
		await vi.advanceTimersByTimeAsync(30000);
		expect(fetchImpl.mock.calls.length).toBe(calls);
		expect(FakeSocket.instances.length).toBe(sockets);
	});

	it("never writes the token to the console, a URL or a message", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
		const { client, socket, fetchImpl, messages } = open();
		fetchImpl.mockRejectedValue(new Error("down"));
		await client.api.resolve({ kind: "reject", workItemId: "WI-2", rationale: "r", binding: {} as never }, "k");
		socket.send("not json");
		socket.drop();
		await vi.advanceTimersByTimeAsync(5000);
		const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		expect(logged).not.toContain("s3cret");
		for (const call of fetchImpl.mock.calls) expect(String(call[0])).not.toContain("s3cret");
		for (const instance of FakeSocket.instances) expect(instance.url).not.toContain("s3cret");
		expect(JSON.stringify(messages)).not.toContain("s3cret");
	});
});
