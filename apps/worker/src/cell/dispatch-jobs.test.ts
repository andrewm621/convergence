import { describe, expect, it } from "vitest";
import type { CellState, DeltaEventInput } from "contracts";
import { InMemoryStore, createCellState, processEvent, currentSnapshot } from "delta-core";
import { buildNotificationsScenario } from "scenario-notifications";
import { claimsCheck, contextFileName, dispatchKey } from "./dispatch-jobs";
import { CellMeta } from "./meta";
import { nodeSqlite } from "./testing/node-sqlite";

const T = "2026-10-13T17:00:00Z";

/** The notifications scenario driven to "WI-2 revalidating after v2", then whatever the test sends. */
async function revalidating(...after: Array<(n: Awaited<ReturnType<typeof buildNotificationsScenario>>) => DeltaEventInput>) {
	const n = await buildNotificationsScenario();
	const store = new InMemoryStore();
	await store.init(createCellState(n.seed));
	const send = (event: DeltaEventInput) => processEvent(store, event, n.policy);
	await send(n.events.registerWi1);
	await send(n.events.registerWi2);
	await send(n.events.v2);
	await send(n.events.wi2PushedV1);
	const state = (await store.load()) as CellState;
	const record = currentSnapshot(state, "notifications");
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
			binding: { recordId: "notifications", version: record.version, blobHash: record.blobHash, baseSha: state.baselineCommit, forkHeadSha: n.commits.wi2HeadV1, contextSnapshotHash: state.snapshotHash },
			requestId: "rv-1",
			ts: T,
		},
	});
	await send(n.events.wi2ReceiptIssued);
	for (const next of after) await send(next(n));
	return { n, state: (await store.load()) as CellState };
}

const changes = [{ recordId: "notifications", toVersion: 2 }];
const push = (claims: unknown) => (n: Awaited<ReturnType<typeof buildNotificationsScenario>>): DeltaEventInput => ({
	type: "ForkPushed",
	ts: T,
	repo: n.workItems.wi2.forkRepo,
	commitSha: n.commits.wi2HeadRevalidated,
	workItemId: "WI-2",
	claims,
	contextPaths: [],
});

describe("claimsCheck (the Worker's own check on a revalidated push; not an executed test)", () => {
	it("passes when the claims cite the delivered versions, cite what changed, and agree with the accepted facets", async () => {
		const { n, state } = await revalidating((x) => push(x.claims.wi2V2)(x));
		expect(claimsCheck({ state, workItemId: "WI-2", policy: n.policy, receipt: n.receipts.wi2Revalidated, changes })).toEqual({ pass: true, problems: [] });
	});

	it("fails when the agent changed code but left the old claims (they cite the superseded version and conflict)", async () => {
		const { n, state } = await revalidating((x) => push(x.claims.wi2V1)(x));
		const verdict = claimsCheck({ state, workItemId: "WI-2", policy: n.policy, receipt: n.receipts.wi2Revalidated, changes });
		expect(verdict.pass).toBe(false);
		expect(verdict.problems.join(" ")).toMatch(/cites notifications@1, but the receipt delivered notifications@2/);
		expect(verdict.problems.join(" ")).toMatch(/no claim cites notifications@2/);
	});

	it("fails when no claim cites the record that changed, even if everything it does claim is right", async () => {
		const { n, state } = await revalidating((x) => push(x.claims.wi2V2.filter((c) => c.basedOn.startsWith("status-model")))(x));
		const verdict = claimsCheck({ state, workItemId: "WI-2", policy: n.policy, receipt: n.receipts.wi2Revalidated, changes });
		expect(verdict.pass).toBe(false);
		expect(verdict.problems).toEqual([expect.stringMatching(/no claim cites notifications@2/)]);
	});

	it("fails closed on missing or malformed claims, and when the head has no claims at all", async () => {
		for (const claims of [null, "not json", [{ subject: "x" }]]) {
			const { n, state } = await revalidating((x) => push(claims)(x));
			const verdict = claimsCheck({ state, workItemId: "WI-2", policy: n.policy, receipt: n.receipts.wi2Revalidated, changes });
			expect(verdict.pass, JSON.stringify(claims)).toBe(false);
		}
		const { n, state } = await revalidating(); // no push since the receipt: the claims are for an older head
		expect(claimsCheck({ state, workItemId: "WI-2", policy: n.policy, receipt: n.receipts.wi2Revalidated, changes }).pass).toBe(false);
	});

	it("fails for a work item the cell does not know", async () => {
		const { n, state } = await revalidating();
		expect(claimsCheck({ state, workItemId: "WI-9", policy: n.policy, receipt: n.receipts.wi2Revalidated, changes }).pass).toBe(false);
	});
});

describe("what the dispatcher hands the runtime", () => {
	it("delivers a record under its baseline file name when that is a plain slug, else under <recordId>.md", () => {
		expect(contextFileName("notifications", "context/notifications.md")).toBe("notifications.md");
		expect(contextFileName("notifications", "context/Notifications v2.md")).toBe("notifications.md");
		expect(contextFileName("status-model", null)).toBe("status-model.md");
		expect(contextFileName("qualified-lead", "context/sales/qualified-lead.md")).toBe("qualified-lead.md");
	});

	it("derives one stable runtime key per resolution, distinct across scenarios and resolutions, and valid as an Idempotency-Key", async () => {
		const a = await dispatchKey("n-1", "rv-1");
		expect(a).toBe(await dispatchKey("n-1", "rv-1"));
		expect(new Set([a, await dispatchKey("n-2", "rv-1"), await dispatchKey("n-1", "rv-2")]).size).toBe(3);
		expect(a).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
		// A resolution key may carry "~", which the runtime's key alphabet does not allow: hashing makes that irrelevant.
		expect(await dispatchKey("n-1", "weird~key")).toMatch(/^redispatch-[0-9a-f]{32}$/);
	});
});

describe("dispatch job bookkeeping", () => {
	const meta = () => new CellMeta(nodeSqlite());

	it("queues one job per resolution key and ignores a replay", () => {
		const m = meta();
		m.enqueueDispatch({ requestId: "rv-1", workItemId: "WI-2", diff: [{ recordId: "notifications", fromVersion: 1, toVersion: 2, changes: [] }], nowMs: 1 });
		m.enqueueDispatch({ requestId: "rv-1", workItemId: "WI-2", diff: [], nowMs: 2 });
		expect(m.dispatches()).toHaveLength(1);
		expect(m.activeDispatches()[0]).toMatchObject({ requestId: "rv-1", phase: "queued", attempts: 0, payload: null, runId: null });
	});

	it("moves through its phases, keeps its payload as JSON, and leaves the active list when it ends", () => {
		const m = meta();
		m.enqueueDispatch({ requestId: "rv-1", workItemId: "WI-2", diff: [], nowMs: 1 });
		m.updateDispatch("rv-1", { phase: "prepared", payload: { runtimeId: "wi-2" } }, 2);
		m.updateDispatch("rv-1", { phase: "running", runId: "run-1", retryAt: 99, attempts: 3 }, 3);
		expect(m.activeDispatches()[0]).toMatchObject({ phase: "running", payload: { runtimeId: "wi-2" }, runId: "run-1", retryAt: 99, attempts: 3, updatedMs: 3 });
		m.updateDispatch("rv-1", { phase: "failed", error: "boom", retryAt: null }, 4);
		expect(m.activeDispatches()).toEqual([]);
		expect(m.dispatches()[0]).toMatchObject({ phase: "failed", error: "boom", retryAt: null });
	});

	it("refuses a phase the table does not know", () => {
		const m = meta();
		m.enqueueDispatch({ requestId: "rv-1", workItemId: "WI-2", diff: [], nowMs: 1 });
		expect(() => m.updateDispatch("rv-1", { phase: "limbo" as never }, 2)).toThrow();
	});
});
