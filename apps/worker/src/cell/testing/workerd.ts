import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { LedgerConflictError, type CellStore, type LedgerHead } from "delta-core";
import type { CellState, ReconciliationEvent } from "contracts";
import type { LedgerVerdict } from "../sqlite-store";
import type { WorldOp } from "./test-worker";

// Runs the real cell inside workerd (the Workers runtime) through Miniflare, so tests exercise
// real Durable Object SQLite, alarms and hibernating WebSockets. Artifacts is the in-memory fake.

export const TEST_TOKEN = "test-bearer-token";
const ENTRY = fileURLToPath(import.meta.url).replace(/[^/]+$/, "test-worker.ts");

export type WorkerdOptions = { pollIntervalMs?: number };

export type Workerd = {
	/** `Authorization` is added for /api paths. */
	fetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response>;
	/** JSON request with the bearer secret; returns status, body and headers. */
	api(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
	/** Call a public method on a scenario's cell (Durable Object RPC) and return its result. */
	cell<T = unknown>(scenario: string, method: string, ...args: unknown[]): Promise<T>;
	world(scenario: string, op: WorldOp): Promise<any>;
	/** Open the cell's WebSocket the way a browser does (secret in the subprotocol). */
	openSocket(scenario: string, since?: number): Promise<{ frames: any[]; waitFor(predicate: (frame: any) => boolean, ms?: number): Promise<any>; close(): void; status: number }>;
	dispose(): Promise<void>;
};

let bundle: Promise<string> | undefined;

function bundled(): Promise<string> {
	bundle ??= build({
		entryPoints: [ENTRY],
		bundle: true,
		write: false,
		format: "esm",
		target: "es2023",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser", "import"],
		mainFields: ["module", "main"],
		external: ["cloudflare:*", "node:*"],
		logLevel: "silent",
	}).then((result) => {
		const file = result.outputFiles[0];
		if (!file) throw new Error("esbuild produced no output for the test worker");
		return file.text;
	});
	return bundle;
}

export async function startWorkerd(options: WorkerdOptions = {}): Promise<Workerd> {
	const script = await bundled();
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			logRequests: false,
			workers: [
				{
					name: "delta-test",
					modules: true,
					script,
					compatibilityDate: "2026-10-12",
					compatibilityFlags: ["nodejs_compat"],
					bindings: {
						DEV_TOKEN: TEST_TOKEN,
						POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 150),
						DEMO_ACTOR_ID: "decision-owner",
						DEMO_ACTOR_NAME: "Decision owner (demo identity)",
					},
					durableObjects: {
						WORKSPACE_CELL: { className: "TestCell", useSQLite: true },
						STORE: { className: "StoreHarness", useSQLite: true },
					},
				},
			],
		}),
	);

	const send: Workerd["fetch"] = async (path, init = {}) => {
		const headers: Record<string, string> = { ...(init.headers ?? {}) };
		const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
		return (await mf.dispatchFetch(`http://delta.test${path}`, { method: init.method ?? (body === undefined ? "GET" : "POST"), headers, body })) as unknown as Response;
	};

	const api: Workerd["api"] = async (method, path, { body, headers = {} } = {}) => {
		const res = await send(`/api${path}`, { method, headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body });
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
	};

	const cell: Workerd["cell"] = async (scenario, method, ...args) => {
		const res = await send(`/__test/cell/${scenario}/${method}`, { method: "POST", body: JSON.stringify(args) });
		const out = (await res.json()) as { ok?: any; error?: { name: string; message: string } };
		if (out.error) throw Object.assign(new Error(out.error.message), { name: out.error.name });
		return out.ok;
	};

	return {
		fetch: send,
		api,
		cell,
		world: (scenario, op) => cell(scenario, "testWorld", op),
		async openSocket(scenario, since) {
			const secret = btoa(TEST_TOKEN).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const res = (await mf.dispatchFetch(`http://delta.test/api/scenarios/${scenario}/ws${since === undefined ? "" : `?since=${since}`}`, {
				headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `delta.v1, bearer.${secret}` },
			})) as unknown as { status: number; webSocket?: any };
			const ws = res.webSocket;
			const frames: any[] = [];
			const waiters: Array<() => void> = [];
			if (ws) {
				ws.accept();
				ws.addEventListener("message", (event: { data: string }) => {
					frames.push(JSON.parse(event.data));
					for (const wake of waiters.splice(0)) wake();
				});
			}
			return {
				status: res.status,
				frames,
				close: () => ws?.close(),
				async waitFor(predicate, ms = 8000) {
					const deadline = Date.now() + ms;
					for (;;) {
						const hit = frames.find(predicate);
						if (hit) return hit;
						const left = deadline - Date.now();
						if (left <= 0) throw new Error(`timed out waiting for a frame; saw ${frames.map((f) => `${f.message?.type}@${f.seq}`).join(", ") || "none"}`);
						await new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, left);
							waiters.push(() => {
								clearTimeout(timer);
								resolve();
							});
						});
					}
				},
			};
		},
		dispose: () => mf.dispose(),
	};
}

/** A CellStore whose every call is a request to a StoreHarness Durable Object: the SQLite store on real DO storage. */
export class RemoteStore implements CellStore {
	readonly #worker: Workerd;
	readonly #id: string;

	constructor(worker: Workerd, id: string) {
		this.#worker = worker;
		this.#id = id;
	}

	async #call(op: string, arg?: unknown): Promise<any> {
		const res = await this.#worker.fetch(`/__test/store/${this.#id}`, { method: "POST", body: JSON.stringify({ op, arg }) });
		const out = (await res.json()) as { ok?: unknown; error?: { name: string; message: string } };
		if (out.error) {
			if (out.error.name === "LedgerConflictError") throw new LedgerConflictError(out.error.message);
			throw Object.assign(new Error(out.error.message), { name: out.error.name });
		}
		return out.ok;
	}

	load(): Promise<CellState | null> {
		return this.#call("load");
	}
	async init(state: CellState): Promise<void> {
		await this.#call("init", state);
	}
	head(): Promise<LedgerHead> {
		return this.#call("head");
	}
	async commit(change: { state: CellState; entry: ReconciliationEvent }): Promise<void> {
		await this.#call("commit", change);
	}
	ledger(options?: { afterSeq?: number; limit?: number }): Promise<ReconciliationEvent[]> {
		return this.#call("ledger", options ?? {});
	}
	verify(): Promise<LedgerVerdict> {
		return this.#call("verify");
	}
	sql(query: string): Promise<Array<Record<string, unknown>>> {
		return this.#call("sql", { query });
	}
}
