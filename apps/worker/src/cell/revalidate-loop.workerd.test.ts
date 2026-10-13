import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTES_REF, parseReceiptNote, type ReconciliationEvent } from "contracts";
import { NOTIFICATIONS_V1, STATUS_MODEL_V1, claims, dependencies, policy } from "scenario-notifications";
import { startWorkerd, type Workerd } from "./testing/workerd";

// M4: the demo's hero loop, in workerd (real Durable Object SQLite, alarms, WebSockets, Hono routes) with the
// in-memory Artifacts and a scripted agent runtime. A human revalidates stale work and the Worker, not an
// operator, closes it: new receipt, the agent re-dispatched with the NEW context, the Worker's own check
// recorded as evidence, then the gate and a real promote. The scripted runtime pushes to the fork as the
// stub agent would (testing/fake-agent.ts). It does not prove the container, the live binding, or the
// note push to the live Artifacts service: docs/live-verification.md lists what is still unverified.

let w: Workerd;
let n = 0;

beforeAll(async () => {
	w = await startWorkerd({ pollIntervalMs: 150 });
}, 60_000);
afterAll(async () => {
	await w?.dispose();
});

const BASELINE = "notifications-baseline";
const WI1 = "notifications-wi-1";
const WI2 = "notifications-wi-2";
const V2_FACETS = { "notifications.default": "opt-in", "notifications.cadence": "weekly-digest", "notifications.channel": "in-app" };
const CHECKS = ["tests/contract/notifications.test.ts", "tests/contract/status-model.test.ts"];

let keys = 0;
const key = (label = "k") => `${label}-${++keys}-m4-key`;
const post = (s: string, path: string, body: unknown, k = key(), headers: Record<string, string> = {}) => w.api("POST", `/scenarios/${s}${path}`, { body, headers: { "Idempotency-Key": k, ...headers } });
const get = (s: string, path: string) => w.api("GET", `/scenarios/${s}${path}`);

async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 8000, what = "condition"): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 40));
	}
}

const ledger = async (s: string): Promise<ReconciliationEvent[]> => (await get(s, "/ledger?limit=1000")).body.entries;
type Wi = { item: { id: string; status: string }; headSha: string | null; receipt: any; evidence: any[]; claims: any };
const workItem = async (s: string, id: string) => ((await get(s, "/state")).body.workItems as Wi[]).find((x) => x.item.id === id) as Wi;

/** A scenario with a baseline at v1, two forks, an initialised cell and both work items registered (both require a contract test). */
async function scenario() {
	const s = `m4-${++n}`;
	await w.world(s, { op: "create", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V1, "context/status-model.md": STATUS_MODEL_V1, "AGENTS.md": "# agents\n", "src/index.ts": "export {};\n" } });
	await w.world(s, { op: "fork", base: BASELINE, repo: WI1 });
	await w.world(s, { op: "fork", base: BASELINE, repo: WI2 });
	expect((await post(s, "/init", { baselineRepo: BASELINE, policy })).status).toBe(201);
	const wi1 = await post(s, "/work-items", { id: "WI-1", title: "Status badges", forkRepo: WI1, requires: ["contract-test"], dependencies: dependencies.wi1.map((d) => ({ recordId: d.recordId, facetKeys: d.facetKeys })) });
	const wi2 = await post(s, "/work-items", { id: "WI-2", title: "Notification delivery", forkRepo: WI2, requires: ["contract-test"], dependencies: dependencies.wi2.map((d) => ({ recordId: d.recordId, facetKeys: d.facetKeys })) });
	expect([wi1.status, wi2.status]).toEqual([201, 201]);
	return s;
}

/** WI-2 built on notifications v1 and pushed; the decision then moves to v2. WI-2 is Stale with a claim conflict. */
async function stale(options: { agent?: Record<string, unknown> | false } = {}) {
	const s = await scenario();
	if (options.agent !== false) await w.world(s, { op: "agent", behavior: options.agent ?? {} });
	await w.world(s, { op: "push", repo: WI2, files: { ".delta/claims.json": JSON.stringify(claims.wi2V1), "src/work/wi-2.ts": 'export const NOTIFICATIONS_DEFAULT = "on";\n' }, author: "workitem-wi-2" });
	await w.cell(s, "pollNow");
	expect((await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "Make notifications opt-in with a weekly digest." })).status).toBe(201);
	return s;
}

async function bindingFor(s: string, id: string, recordId: string) {
	const state = (await get(s, "/state")).body;
	const history = state.records[recordId];
	const record = history.versions[String(history.current)];
	return { recordId, version: record.version, blobHash: record.blobHash, baseSha: state.baselineCommit, forkHeadSha: (await workItem(s, id)).headSha, contextSnapshotHash: state.snapshotHash };
}

async function revalidate(s: string, k = key("rv")) {
	const binding = await bindingFor(s, "WI-2", "notifications");
	return { res: await post(s, "/work-items/WI-2/resolutions", { kind: "revalidate", rationale: "Decision changed under this work.", binding }, k), binding, k };
}

const jobs = async (s: string) => (await get(s, "/dispatches")).body.jobs as Array<Record<string, any>>;
const jobAt = (s: string, phase: string, ms = 12_000) => until(async () => (await jobs(s)).find((j) => j.phase === phase) ?? false, ms, `the re-dispatch to reach ${phase}`);
const gateOf = async (s: string, id = "WI-2") => (await get(s, `/work-items/${id}/gate`)).body;
const evidence = (s: string, repo: string, id: string, headSha: string, check: string) =>
	w.cell(s, "recordObservation", { type: "EvidenceRecorded", ts: "2026-10-13T16:00:00Z", repo, commitSha: headSha, runId: `run-${key("ev")}`, evidence: { workItemId: id, headSha, check, pass: true, output: "ok" } });
/** The ledger event types that name WI-2 or are fork pushes, in order. */
async function trail(s: string) {
	return (await ledger(s)).filter((e) => JSON.stringify(e.payload.event).includes('"WI-2"') || e.type === "ForkPushed").map((e) => e.type);
}

describe("revalidate loop (M4)", () => {
	it("closes the loop: stale, revalidate, re-dispatch with v2, new receipt, push, evidence, fresh gate, promote merges", async () => {
		const s = await stale({ agent: { hold: true } });
		const oldHead = (await workItem(s, "WI-2")).headSha as string;
		expect((await workItem(s, "WI-2")).item.status).toBe("conflict");
		expect((await gateOf(s)).reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT"]));

		const { res, k, binding } = await revalidate(s);
		expect(res.status).toBe(200);
		expect(res.body.effects.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["REQUEST_REVALIDATION", "DISPATCH_WORK"]));

		// The agent is dispatched with the NEW accepted context, under the runtime's id, and a run is open.
		expect(await jobAt(s, "running")).toMatchObject({ workItemId: "WI-2", runtimeId: "wi-2", error: null });
		const calls = await w.world(s, { op: "agentCalls" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ workItemId: "wi-2", forkRepo: WI2 });
		expect(calls[0].revalidate.changes).toEqual([{ recordId: "notifications", fromVersion: 1, toVersion: 2 }]);
		expect(calls[0].revalidate.context["notifications.md"]).toContain("version: 2");
		expect(calls[0].revalidate.context["notifications.md"]).toContain("opt-in");
		expect(Object.keys(calls[0].revalidate.context).sort()).toEqual(["notifications.md", "status-model.md"]);

		// The Worker issued the receipt it handed over: record versions and facets, with the note ref.
		const held = await workItem(s, "WI-2");
		expect(held.receipt.accepted.map((e: any) => `${e.recordId}@${e.version}`)).toEqual(["notifications@2", "status-model@1"]);
		expect(held.receipt.noteRef).toBe(`${NOTES_REF}:${oldHead}`);
		const note = parseReceiptNote(await w.world(s, { op: "note", repo: WI2, commit: oldHead }));
		const { noteRef: _noteRef, ...receiptWithoutRef } = held.receipt;
		expect(note.ok && note.receipt).toEqual(receiptWithoutRef);
		expect((await ledger(s)).some((e) => e.type === "ReceiptIssued")).toBe(true);

		// While the agent works: no longer Stale, but not promotable either.
		const mid = await gateOf(s);
		expect(mid.pass).toBe(false);
		expect(mid.reasonCodes).toContain("REVALIDATION_PENDING");
		expect(mid.reasonCodes).not.toContain("STALE_RECEIPT");
		expect((await workItem(s, "WI-2")).item.status).toBe("revalidating");

		// The run ends: its push is verified, the cell sees it, the Worker records its own check.
		await w.world(s, { op: "agentRelease" });
		await jobAt(s, "done");
		const after = await workItem(s, "WI-2");
		expect(after.headSha).not.toBe(oldHead);
		expect(after.item.status).toBe("ready");
		const gate = await gateOf(s);
		expect(gate).toMatchObject({ pass: true, reasonCodes: [] });

		const atHead = after.evidence.filter((e) => e.headSha === after.headSha);
		expect(atHead.map((e) => e.check).sort()).toEqual(CHECKS);
		for (const e of atHead) {
			expect(e).toMatchObject({ pass: true, kind: "delta-claims-check" });
			expect(e.output).toMatch(/NOT AN EXECUTED TEST/);
		}
		expect(after.claims.status).toBe("ok");
		expect(after.claims.claims.every((c: any) => c.basedOn === "notifications@2")).toBe(true);

		// The console can name the agent: the run-started event carries what runs the work.
		expect((await ledger(s)).find((e) => e.type === "AgentRunStarted")?.payload.event).toMatchObject({ workItemId: "WI-2", model: "stub agent" });

		// The ledger tells it in order: resolution, receipt, run start, push, run end, evidence.
		const order = await trail(s);
		expect(order.indexOf("ReceiptIssued")).toBeGreaterThan(order.indexOf("ResolutionRecorded"));
		expect(order.indexOf("AgentRunStarted")).toBeGreaterThan(order.indexOf("ReceiptIssued"));
		expect(order.lastIndexOf("ForkPushed")).toBeGreaterThan(order.indexOf("ReceiptIssued"));
		expect(order.indexOf("AgentRunFinished")).toBeGreaterThan(order.indexOf("AgentRunStarted"));
		expect(order.lastIndexOf("EvidenceRecorded")).toBeGreaterThan(order.lastIndexOf("ForkPushed"));

		// Idempotency: the resolution's key replays its answer, and the runtime was asked exactly once.
		const replay = await post(s, "/work-items/WI-2/resolutions", { kind: "revalidate", rationale: "Decision changed under this work.", binding }, k);
		expect(replay.body).toEqual(res.body);
		expect(await w.world(s, { op: "agentCalls" })).toHaveLength(1);
		expect(await jobs(s)).toHaveLength(1);

		// Promote: a real merge, with the decision still in the baseline.
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: gate.forkHeadSha });
		expect([promote.status, promote.body.promoted]).toEqual([200, true]);
		const files = await w.world(s, { op: "files", repo: BASELINE });
		expect(files["src/work/wi-2.ts"]).toContain("opt-in");
		expect(files["src/work/wi-2.ts"]).not.toContain('"on"');
		expect(files["context/notifications.md"]).toContain("version: 2");
		expect(files["decisions/0001-notifications-v2.md"]).toBeTruthy();
		expect((await workItem(s, "WI-2")).item.status).toBe("promoted");
		expect((await get(s, "/ledger/verify")).body).toMatchObject({ ok: true });
	}, 30_000);

	it("R7: a fork still at the old receipt stays blocked, however good its claims look; only the Worker's receipt unblocks it", async () => {
		// No agent runtime here: the revalidation is announced, nothing is re-dispatched, no receipt is issued.
		const s = await stale({ agent: false });
		expect((await revalidate(s)).res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 600)); // several alarm ticks
		expect((await get(s, "/dispatches")).body).toMatchObject({ runtime: false, jobs: [] });
		expect((await ledger(s)).some((e) => e.type === "ReceiptIssued")).toBe(false);

		// Someone pushes work that claims the new values, and checks "pass"; the receipt is still v1.
		await w.world(s, { op: "push", repo: WI2, files: { ".delta/claims.json": JSON.stringify(claims.wi2V2) }, author: "workitem-wi-2" });
		await w.cell(s, "pollNow");
		const head = (await workItem(s, "WI-2")).headSha as string;
		for (const check of CHECKS) await evidence(s, WI2, "WI-2", head, check);
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("STALE_RECEIPT");
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: head });
		expect([promote.status, promote.body.error.code]).toEqual([409, "PROMOTION_BLOCKED"]);
		expect(promote.body.error.reasonCodes).toContain("STALE_RECEIPT");
		expect((await w.world(s, { op: "files", repo: BASELINE }))["src/work/wi-2.ts"]).toBeUndefined();
	}, 30_000);

	it("the loop starts only from a human's revalidate, and the receipt is not writable over HTTP", async () => {
		const s = await stale();
		const binding = await bindingFor(s, "WI-2", "notifications");
		const asAgent = await post(s, "/work-items/WI-2/resolutions", { kind: "revalidate", rationale: "me", binding }, key(), { "X-Delta-Principal": "agent:agent-b" });
		expect([asAgent.status, asAgent.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);
		await new Promise((r) => setTimeout(r, 500));
		expect(await w.world(s, { op: "agentCalls" })).toHaveLength(0);
		expect(await jobs(s)).toHaveLength(0);
		// The observation hook the runtime uses takes evidence and run markers, never a receipt.
		await expect(w.cell(s, "recordObservation", { type: "ReceiptIssued", ts: "2026-10-13T16:00:00Z", workItemId: "WI-2", receipt: (await workItem(s, "WI-2")).receipt })).rejects.toThrow(/does not take ReceiptIssued/);
	}, 30_000);

	it("a receipt note that cannot be written does not block the dispatch; the failure is reported", async () => {
		const s = await stale();
		await w.world(s, { op: "fail", method: "writeNote", times: 5 });
		const socket = await w.openSocket(s);
		await revalidate(s);
		const done = await jobAt(s, "done");
		expect(done.noteError).toMatch(/injected writeNote failure/);
		const wi2 = await workItem(s, "WI-2");
		expect(wi2.receipt.noteRef).toBeUndefined();
		expect(wi2.receipt.accepted.map((e: any) => e.version).sort()).toEqual([1, 2]);
		await socket.waitFor((f) => f.type === "agent-activity" && /Receipt note not written/.test(f.text));
		socket.close();
		expect((await gateOf(s)).pass).toBe(true);
	}, 30_000);

	it("a dispatch that fails transiently is retried under the same key and starts one run", async () => {
		const s = await stale({ agent: { failDispatches: 1, model: "openai/gpt-6-luna" } });
		await revalidate(s);
		await jobAt(s, "done", 20_000);
		expect((await ledger(s)).find((e) => e.type === "AgentRunStarted")?.payload.event).toMatchObject({ model: "openai/gpt-6-luna" });
		const calls = await w.world(s, { op: "agentCalls" });
		expect(calls).toHaveLength(2);
		expect(new Set(calls.map((c: { idempotencyKey: string }) => c.idempotencyKey)).size).toBe(1);
		expect((await ledger(s)).filter((e) => e.type === "AgentRunStarted")).toHaveLength(1);
		expect((await gateOf(s)).pass).toBe(true);
	}, 40_000);

	it("a failed run leaves the work blocked, closes the run as a failure and records no evidence", async () => {
		const s = await stale({ agent: { outcome: "fail" } });
		await revalidate(s);
		const failed = await jobAt(s, "failed");
		expect(failed.error).toMatch(/exited with code 3/);
		const finished = (await ledger(s)).filter((e) => e.type === "AgentRunFinished");
		expect(finished).toHaveLength(1);
		expect(finished[0]?.payload.event).toMatchObject({ outcome: "failure", workItemId: "WI-2" });
		expect((await ledger(s)).some((e) => e.type === "EvidenceRecorded")).toBe(false);
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("REVALIDATION_PENDING");
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: gate.forkHeadSha });
		expect([promote.status, promote.body.error.code]).toEqual([409, "PROMOTION_BLOCKED"]);
	}, 30_000);

	it("a run that pushed code but never updated its claims fails the Worker's check and stays blocked", async () => {
		const s = await stale({ agent: { outcome: "keep-old-claims" } });
		await revalidate(s);
		await jobAt(s, "done");
		const wi2 = await workItem(s, "WI-2");
		const atHead = wi2.evidence.filter((e) => e.headSha === wi2.headSha);
		expect(atHead.length).toBeGreaterThan(0);
		for (const e of atHead) {
			expect(e).toMatchObject({ pass: false, kind: "delta-claims-check" });
			expect(e.output).toMatch(/failed/);
		}
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toEqual(expect.arrayContaining(["CLAIM_CONFLICT", "TEST_FAILED"]));
		expect(gate.reasonCodes).not.toContain("STALE_RECEIPT"); // the receipt is current; the work is what is wrong
	}, 30_000);
});
