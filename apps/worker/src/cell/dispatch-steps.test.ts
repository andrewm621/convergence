import { describe, expect, it } from "vitest";
import type { CellState, DeltaEventInput } from "contracts";
import { InMemoryStore, createCellState, currentSnapshot, processEvent } from "delta-core";
import { buildNotificationsScenario } from "scenario-notifications";
import { AgentRuntimeError, type AgentDispatch, type AgentRunView, type AgentRuntimePort } from "./agent-port";
import { RevalidationDispatcher, type DispatchHost } from "./dispatch-jobs";
import { CellMeta } from "./meta";
import type { ArtifactsPort } from "./ports";
import { nodeSqlite } from "./testing/node-sqlite";

// The dispatcher's step logic against a scripted host: real reconciler and real job table, a runtime and
// an Artifacts port that answer what the test says. These are the paths the in-workerd loop cannot reach
// on demand (a baseline that moves mid-job, a clash of context file names, a runtime that errs with a token).

const T = "2026-10-13T17:00:00Z";
type Scenario = Awaited<ReturnType<typeof buildNotificationsScenario>>;

function run(patch: Partial<AgentRunView> = {}): AgentRunView {
	return { runId: "run-wi-2-1", workItemId: "wi-2", state: "running", startedAt: T, finishedAt: null, commit: null, pushVerified: null, baseHead: null, model: "stub agent", author: "workitem-wi-2", error: null, ...patch };
}

class ScriptedRuntime implements AgentRuntimePort {
	readonly calls: AgentDispatch[] = [];
	dispatchError: Error | null = null;
	view: AgentRunView | null = null;
	async dispatch(request: AgentDispatch): Promise<AgentRunView> {
		this.calls.push(request);
		if (this.dispatchError) throw this.dispatchError;
		this.view = run();
		return this.view;
	}
	async status(): Promise<AgentRunView | null> {
		return this.view;
	}
}

/** The notifications scenario at "WI-2 revalidating after v2" (resolution recorded), optionally with the receipt already issued. */
async function setup(options: { receipted?: boolean; enqueue?: boolean; recordPaths?: Record<string, string>; mangleReceipts?: number; queuedMsAgo?: number } = {}) {
	const n: Scenario = await buildNotificationsScenario();
	const store = new InMemoryStore();
	await store.init(createCellState(n.seed));
	const send = (event: DeltaEventInput) => processEvent(store, event, n.policy);
	for (const event of [n.events.registerWi1, n.events.registerWi2, n.events.v2, n.events.wi2PushedV1]) await send(event);
	const before = (await store.load()) as CellState;
	const record = currentSnapshot(before, "notifications");
	if (!record) throw new Error("no notifications record");
	await send({
		type: "ResolutionRecorded",
		ts: T,
		requestId: "rv-1",
		resolution: {
			kind: "revalidate",
			workItemId: "WI-2",
			actor: n.actors.decisionOwner,
			rationale: "Decision changed under this work.",
			binding: { recordId: "notifications", version: record.version, blobHash: record.blobHash, baseSha: before.baselineCommit, forkHeadSha: n.commits.wi2HeadV1, contextSnapshotHash: before.snapshotHash },
			requestId: "rv-1",
			ts: T,
		},
	});
	if (options.receipted) await send(n.events.wi2ReceiptIssued);

	const meta = new CellMeta(nodeSqlite());
	if (options.recordPaths) meta.setRecordPaths(options.recordPaths);
	if (options.enqueue !== false) meta.enqueueDispatch({ requestId: "rv-1", workItemId: "WI-2", diff: [], nowMs: Date.now() - (options.queuedMsAgo ?? 0) });

	const blobs = new Map(Object.values(n.docs).map((d) => [d.snapshot.blobHash, d.text]));
	const port = {
		readBlob: async (_repo: string, oid: string) => blobs.get(oid) ?? null,
		log: async () => [{ sha: n.commits.wi2HeadV1, message: "m", authorName: "workitem-wi-2", committerName: "delta", parents: [], committedAt: 1 }],
		writeNote: async () => undefined,
		tree: async () => new Map(),
	} as unknown as ArtifactsPort;

	const runtime = new ScriptedRuntime();
	const activity: string[] = [];
	const submitted: DeltaEventInput[] = [];
	let mangle = options.mangleReceipts ?? 0;
	const host: DispatchHost = {
		port,
		runtime,
		meta,
		scenario: () => "unit",
		baselineRepo: () => n.repo,
		policy: () => n.policy,
		now: () => T,
		loadState: async () => (await store.load()) as CellState,
		submit: async (event) => {
			submitted.push(event);
			if (mangle > 0 && event.type === "ReceiptIssued") {
				// The accepted versions moved between preparing and issuing: this receipt no longer covers what is accepted.
				mangle--;
				return send({ ...event, receipt: { ...event.receipt, contextPacketHash: `${"0".repeat(63)}${mangle}`, accepted: event.receipt.accepted.slice(1) } });
			}
			return send(event);
		},
		catchUp: async () => undefined,
		activity: async (_id, _kind, text) => {
			activity.push(text);
		},
		retryIntervalMs: () => 1,
		logError: () => undefined,
	};
	const dispatcher = new RevalidationDispatcher(host);
	return { n, store, meta, runtime, dispatcher, activity, submitted };
}

const job = (meta: CellMeta, requestId = "rv-1") => meta.dispatches().find((j) => j.requestId === requestId);

describe("dispatcher steps against a scripted host", () => {
	it("a receipt the cell refuses as RECEIPT_MISMATCH while the revalidation is under way is prepared again, then goes through", async () => {
		const t = await setup({ mangleReceipts: 1 });
		await t.dispatcher.step();
		expect(job(t.meta)).toMatchObject({ phase: "queued", requeues: 1, payload: null });
		expect(t.runtime.calls).toHaveLength(0);
		await new Promise((r) => setTimeout(r, 150)); // the short retry delay
		await t.dispatcher.step();
		expect(job(t.meta)).toMatchObject({ phase: "running", requeues: 1, error: null });
		expect(t.runtime.calls).toHaveLength(1);
		expect(t.activity.some((a) => /Preparing the receipt again/.test(a))).toBe(true);
	});

	it("gives up on a baseline that will not hold still after a bounded number of requeues", async () => {
		const t = await setup({ mangleReceipts: 10 });
		for (let i = 0; i < 6 && job(t.meta)?.phase !== "failed"; i++) {
			t.meta.updateDispatch("rv-1", { retryAt: null }, Date.now());
			await t.dispatcher.step();
		}
		expect(job(t.meta)).toMatchObject({ phase: "failed", requeues: 3 });
		expect(job(t.meta)?.error).toMatch(/prepared 4 times/);
		expect(t.runtime.calls).toHaveLength(0);
	});

	it("a conflict with no version change (nothing in the diff) is delivered as a conflict-only revalidation, not failed", async () => {
		// The work already holds the current receipt, so no record changed for it; it is still revalidating (a conflict).
		const t = await setup({ receipted: true });
		await t.dispatcher.step();
		expect(job(t.meta)).toMatchObject({ phase: "running", error: null });
		expect(t.runtime.calls).toHaveLength(1);
		expect(t.runtime.calls[0]?.revalidate.changes).toEqual([]);
		expect(Object.keys(t.runtime.calls[0]?.revalidate.context ?? {}).sort()).toEqual(["notifications.md", "status-model.md"]);
		expect(t.activity.some((a) => /to reconcile its claims/.test(a))).toBe(true);
	});

	it("two records that would be delivered under one file name fail the job instead of silently replacing one", async () => {
		const t = await setup({ recordPaths: { notifications: "context/shared.md", "status-model": "context/shared.md" } });
		await t.dispatcher.step();
		expect(job(t.meta)).toMatchObject({ phase: "failed" });
		expect(job(t.meta)?.error).toMatch(/two records would be delivered as shared\.md/);
		expect(t.runtime.calls).toHaveLength(0);
		expect(t.submitted.some((e) => e.type === "ReceiptIssued")).toBe(false);
	});

	it("redacts a token that a failed run's error carries before it reaches the job, the ledger event or the activity feed", async () => {
		const t = await setup();
		await t.dispatcher.step(); // queued -> running
		const secret = `art_v1_${"A".repeat(32)}`;
		t.runtime.view = run({ state: "failed", finishedAt: T, error: `push rejected for https://x:${secret}@host/repo.git (${secret})` });
		await t.dispatcher.step();
		const row = job(t.meta);
		expect(row?.phase).toBe("failed");
		expect(row?.error).not.toContain(secret);
		expect(t.activity.join("\n")).not.toContain(secret);
		expect(JSON.stringify(t.submitted)).not.toContain(secret);
	});

	it("a busy runtime is not charged as a failed attempt", async () => {
		const t = await setup();
		t.runtime.dispatchError = new AgentRuntimeError("RUN_IN_PROGRESS", "work item wi-2 already has a run in flight", true);
		for (let i = 0; i < 8; i++) {
			await t.dispatcher.step();
			await new Promise((r) => setTimeout(r, 120));
		}
		expect(job(t.meta)).toMatchObject({ phase: "receipted", attempts: 0 });
		expect(t.runtime.calls.length).toBeGreaterThanOrEqual(6);
		t.runtime.dispatchError = null;
		await t.dispatcher.step();
		expect(job(t.meta)?.phase).toBe("running");
	});

	it("a busy runtime that never clears fails the job once the wall-clock bound passes", async () => {
		const t = await setup({ queuedMsAgo: 16 * 60_000 });
		t.runtime.dispatchError = new AgentRuntimeError("RUN_IN_PROGRESS", "busy", true);
		await t.dispatcher.step();
		expect(job(t.meta)?.phase).toBe("failed");
		expect(job(t.meta)?.error).toMatch(/still busy with another run/);
	});

	it("the sweep queues a recorded revalidation that has no job, and leaves one that has a job in any phase", async () => {
		const t = await setup({ enqueue: false });
		expect(t.meta.dispatches()).toEqual([]);
		await t.dispatcher.step();
		expect(job(t.meta)).toMatchObject({ workItemId: "WI-2" });
		expect(job(t.meta)?.phase).toBe("running");
		expect(t.meta.dispatches()).toHaveLength(1);

		// A failed job stays failed: the sweep does not queue the same resolution again.
		const f = await setup();
		f.meta.updateDispatch("rv-1", { phase: "failed", error: "boom", retryAt: null }, Date.now());
		await f.dispatcher.step();
		expect(f.meta.dispatches()).toHaveLength(1);
		expect(job(f.meta)?.phase).toBe("failed");
		expect(f.runtime.calls).toHaveLength(0);
	});

	it("the sweep ignores work that is not under revalidation", async () => {
		const t = await setup({ enqueue: false, receipted: true });
		await t.store.load();
		const n = t.n;
		await processEvent(t.store, n.events.wi2PushedRevalidated, n.policy);
		await t.dispatcher.step();
		expect(t.meta.dispatches()).toEqual([]);
	});
});
