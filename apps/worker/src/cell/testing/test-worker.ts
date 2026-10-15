// A Worker used only by tests, bundled and run inside workerd by testing/workerd.ts. It hosts the
// real cell code (CellBase, the SQLite store, the Hono routes) on real Durable Object storage,
// with the in-memory Artifacts in place of the binding, plus /__test routes to drive and inspect it.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { LedgerConflictError } from "delta-core";
import { apiGuard } from "../auth";
import { CellBase } from "../cell-base";
import type { AgentRuntimePort } from "../agent-port";
import type { ArtifactsPort } from "../ports";
import { cellApi } from "../routes";
import { durableObjectSql } from "../sql";
import { LedgerCorruptionError, SqliteCellStore } from "../sqlite-store";
import { FakeAgentRuntime, type FakeAgentBehavior } from "./fake-agent";
import { FakeWorld, type PortMethod } from "./fake-artifacts";

// Module scope holds only plain maps (no I/O). Keyed by scenario so each test gets its own world,
// and so a world survives the Durable Object being reset mid-test.
const worlds = new Map<string, FakeWorld>();
function worldFor(name: string): FakeWorld {
	let world = worlds.get(name);
	if (!world) {
		world = new FakeWorld();
		worlds.set(name, world);
	}
	return world;
}

const agents = new Map<string, FakeAgentRuntime>();
function agentFor(name: string): FakeAgentRuntime {
	let agent = agents.get(name);
	if (!agent) {
		agent = new FakeAgentRuntime(worldFor(name));
		agents.set(name, agent);
	}
	return agent;
}

export type WorldOp =
	| { op: "create"; repo: string; files: Record<string, string>; author?: string }
	| { op: "fork"; base: string; repo: string }
	| { op: "push"; repo: string; files: Record<string, string | null>; author?: string; message?: string }
	| { op: "head"; repo: string }
	| { op: "files"; repo: string }
	| { op: "pushMany"; repo: string; count: number }
	| { op: "fail"; method: PortMethod; times?: number; skip?: number }
	| { op: "failAfter"; method: PortMethod }
	| { op: "nullBlobs"; times?: number; skip?: number }
	| { op: "calls" }
	| { op: "note"; repo: string; commit: string }
	| { op: "agent"; behavior: Partial<FakeAgentBehavior> }
	| { op: "agentRelease" }
	| { op: "agentCalls" };

export class TestCell extends CellBase {
	protected createPort(): ArtifactsPort {
		return worldFor(this.ctx.id.name ?? "default").port();
	}

	protected override createAgentRuntime(): AgentRuntimePort | null {
		const name = this.ctx.id.name ?? "default";
		// A scenario has an agent runtime only once a test asks for one, so the other tests see a cell with none.
		return agents.has(name) ? agentFor(name) : null;
	}

	async testWorld(op: WorldOp): Promise<unknown> {
		const world = worldFor(this.ctx.id.name ?? "default");
		switch (op.op) {
			case "create":
				return world.create(op.repo, op.files, op.author);
			case "fork":
				return world.fork(op.base, op.repo);
			case "push":
				return world.push(op.repo, op.files, { author: op.author, message: op.message });
			case "head":
				return world.headOf(op.repo);
			case "files":
				return world.filesAt(op.repo);
			case "pushMany": {
				let last = "";
				for (let i = 0; i < op.count; i++) last = await world.push(op.repo, { [`src/bulk-${i}.ts`]: `export const n = ${i};\n` }, { author: "delta-convergence" });
				return last;
			}
			case "fail":
				world.failNext(op.method, op.times ?? 1, undefined, op.skip ?? 0);
				return null;
			case "nullBlobs":
				world.nullNextBlobs(op.times ?? 1, op.skip ?? 0);
				return null;
			case "failAfter":
				world.failAfterNext(op.method);
				return null;
			case "calls":
				return world.calls;
			case "note":
				return world.noteAt(op.repo, op.commit);
			case "agent":
				agentFor(this.ctx.id.name ?? "default").setBehavior(op.behavior);
				return null;
			case "agentRelease":
				agentFor(this.ctx.id.name ?? "default").release();
				return null;
			case "agentCalls":
				return agentFor(this.ctx.id.name ?? "default").calls;
		}
	}

	/** Raw SQL against the cell's own database, for tamper tests. */
	testSql(query: string, bindings: unknown[] = []): unknown[] {
		return durableObjectSql(this.ctx.storage).all(query, ...bindings);
	}

	/** The poller's alarm: its scheduled time, or null. "clear" removes it first (to prove a read does not arm it). */
	async testAlarm(op: "get" | "clear"): Promise<number | null> {
		if (op === "clear") await this.ctx.storage.deleteAlarm();
		return this.ctx.storage.getAlarm();
	}

	/** Reset the object as a crash or eviction would; storage and alarms survive. */
	testAbort(): void {
		this.ctx.abort("test restart");
	}
}

/** The SQLite store alone, on real Durable Object storage, driven over fetch by the shared conformance suites. */
export class StoreHarness extends DurableObject<Env> {
	readonly #store: SqliteCellStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#store = new SqliteCellStore(durableObjectSql(ctx.storage));
	}

	override async fetch(request: Request): Promise<Response> {
		const { op, arg } = (await request.json()) as { op: string; arg?: unknown };
		try {
			const store = this.#store;
			const arg2 = arg as never;
			const result =
				op === "load"
					? await store.load()
					: op === "init"
						? await store.init(arg2)
						: op === "head"
							? await store.head()
							: op === "commit"
								? await store.commit(arg2)
								: op === "ledger"
									? await store.ledger(arg2)
									: op === "verify"
										? await store.verify()
										: op === "sql"
											? durableObjectSql(this.ctx.storage).all((arg as { query: string }).query)
											: (() => {
													throw new Error(`unknown op ${op}`);
												})();
			return Response.json({ ok: result ?? null });
		} catch (error) {
			const name = error instanceof LedgerConflictError || error instanceof LedgerCorruptionError ? error.name : error instanceof Error ? error.name : "Error";
			return Response.json({ error: { name, message: error instanceof Error ? error.message : String(error) } });
		}
	}
}

type TestEnv = Env & { STORE: DurableObjectNamespace<StoreHarness> };

const app = new Hono<{ Bindings: TestEnv }>();

// The very guard index.ts mounts on /api.
app.use("/api/*", apiGuard);
app.route("/api", cellApi);

app.post("/__test/store/:id", async (c) => c.env.STORE.getByName(c.req.param("id")).fetch(c.req.raw));

app.post("/__test/cell/:scenario/:method", async (c) => {
	const cell = c.env.WORKSPACE_CELL.getByName(c.req.param("scenario")) as unknown as DurableObjectStub<TestCell>;
	const method = c.req.param("method");
	const args = ((await c.req.json().catch(() => [])) as unknown[]) ?? [];
	try {
		const result = await (cell as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]?.(...args);
		return c.json({ ok: result ?? null });
	} catch (error) {
		return c.json({ error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
	}
});

export default app;
