import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTES_REF, parseReceiptNote, type ReconciliationEvent } from "contracts";
import { NOTIFICATIONS_V1, STATUS_MODEL_V1, claims, dependencies, policy } from "scenario-notifications";
import { runStubAgent } from "../../container/stub-agent-lib";
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

		// R8: each required check was run by Delta on the pushed files; beside them, the informational claims check.
		const atHead = after.evidence.filter((e) => e.headSha === after.headSha);
		const ran = atHead.filter((e) => e.kind === "delta-run-check");
		expect(ran.map((e) => e.check).sort()).toEqual(CHECKS);
		for (const e of ran) {
			expect(e).toMatchObject({ pass: true });
			expect(e.output).toMatch(/Delta-run contract check .* at [0-9a-f]{7}, reading src\/index\.ts, src\/work\/wi-2\.ts/);
			expect(e.output).not.toMatch(/NOT A TEST/);
		}
		// Each check asserts exactly the facets WI-2 declared a dependency on, and found them declared in the pushed code
		// (the status-model check does not pass for want of anything to check).
		const output = (check: string) => ran.find((e) => e.check === check)?.output ?? "";
		expect(output(CHECKS[0] as string)).toContain("asserting notifications.cadence, notifications.default");
		expect(output(CHECKS[0] as string)).toContain('src/work/wi-2.ts: notifications.default = "opt-in" as accepted');
		expect(output(CHECKS[1] as string)).toContain("asserting status.values");
		expect(output(CHECKS[1] as string)).toMatch(/src\/work\/wi-2\.ts: status\.values = \[.*\] as accepted/);
		const claimsEvidence = atHead.filter((e) => e.kind === "delta-claims-check");
		expect(claimsEvidence).toHaveLength(1);
		expect(claimsEvidence[0]).toMatchObject({ check: "delta:claims-vs-receipt", pass: true });
		expect(claimsEvidence[0].output).toMatch(/NOT A TEST/);
		expect(atHead).toHaveLength(3);
		expect(after.claims.status).toBe("ok");
		// Claims cover every record the receipt delivered, at the delivered versions.
		expect(new Set(after.claims.claims.map((c: any) => c.basedOn))).toEqual(new Set(["notifications@2", "status-model@1"]));

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

	it("a runtime that keeps answering 'a run is in flight' is waited for, not failed after five tries", async () => {
		const s = await stale({ agent: { failDispatches: 8, failCode: "RUN_IN_PROGRESS" } });
		await revalidate(s);
		const done = await jobAt(s, "done", 30_000);
		expect(done.error).toBeNull();
		const calls = await w.world(s, { op: "agentCalls" });
		expect(calls).toHaveLength(9);
		expect(new Set(calls.map((c: { idempotencyKey: string }) => c.idempotencyKey)).size).toBe(1);
		expect((await ledger(s)).filter((e) => e.type === "AgentRunStarted")).toHaveLength(1);
		expect((await gateOf(s)).pass).toBe(true);
	}, 45_000);

	it("a revalidation recorded without a job (the cell stopped before queueing it) is picked up once the runtime exists", async () => {
		const s = await stale({ agent: false });
		expect((await revalidate(s)).res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 400));
		expect(await jobs(s)).toEqual([]);
		// The runtime comes up; nothing re-sends the effect, so only the sweep can find the owed dispatch.
		await w.world(s, { op: "agent", behavior: {} });
		const done = await jobAt(s, "done", 20_000);
		expect(done.workItemId).toBe("WI-2");
		expect(await jobs(s)).toHaveLength(1);
		expect((await w.world(s, { op: "agentCalls" })).length).toBe(1);
		expect((await gateOf(s)).pass).toBe(true);
	}, 40_000);

	it("a second revalidate while one is under way is refused (409) and starts no second run", async () => {
		const s = await stale({ agent: { hold: true } });
		expect((await revalidate(s)).res.status).toBe(200);
		await jobAt(s, "running");
		const second = await revalidate(s);
		expect([second.res.status, second.res.body.error.code]).toEqual([409, "REVALIDATION_IN_PROGRESS"]);
		await w.world(s, { op: "agentRelease" });
		await jobAt(s, "done");
		expect(await w.world(s, { op: "agentCalls" })).toHaveLength(1);
		expect(await jobs(s)).toHaveLength(1);
	}, 30_000);

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
		// The failed run ended the revalidation (no push is coming); the old claims still conflict, so promotion stays closed.
		expect(gate.reasonCodes).toContain("CLAIM_CONFLICT");
		expect(gate.reasonCodes).not.toContain("REVALIDATION_PENDING");
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: gate.forkHeadSha });
		expect([promote.status, promote.body.error.code]).toEqual([409, "PROMOTION_BLOCKED"]);

		// The item is released: a human can revalidate again, that dispatches a second job, and this time it completes.
		await w.world(s, { op: "agent", behavior: { outcome: "push" } });
		const second = await revalidate(s);
		expect(second.res.status).toBe(200);
		await until(async () => ((await jobs(s)).filter((j) => j.phase === "done").length === 1 && (await jobs(s)).length === 2) || false, 15_000, "the second job to finish");
		expect((await w.world(s, { op: "agentCalls" })).length).toBe(2);
		expect((await gateOf(s)).pass).toBe(true);
	}, 40_000);

	it("a job that fails before any run starts also releases the item, and the next revalidate runs", async () => {
		const s = await stale({ agent: { failDispatches: 1, failCode: "REFUSED", failRetryable: false } });
		await revalidate(s);
		const failed = await jobAt(s, "failed");
		expect(failed.error).toMatch(/the runtime is busy/);
		expect((await ledger(s)).filter((e) => e.type === "AgentRunStarted")).toHaveLength(0);
		// The ledger records the end of the revalidation, under the id derived from the resolution's key.
		const closing = (await ledger(s)).filter((e) => e.type === "AgentRunFinished");
		expect(closing).toHaveLength(1);
		expect(closing[0]?.payload.event).toMatchObject({ outcome: "failure", workItemId: "WI-2", runId: expect.stringMatching(/^dispatch-failed:/) });
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).not.toContain("REVALIDATION_PENDING");
		expect(gate.reasonCodes).toContain("CLAIM_CONFLICT");

		const second = await revalidate(s);
		expect(second.res.status).toBe(200);
		await until(async () => (await jobs(s)).filter((j) => j.phase === "done").length === 1 || false, 15_000, "the second job to finish");
		expect((await jobs(s)).length).toBe(2);
		expect((await gateOf(s)).pass).toBe(true);
	}, 40_000);

	it("a run that pushed the right code but never updated its claims passes the contract check and stays blocked on its claims", async () => {
		const s = await stale({ agent: { outcome: "keep-old-claims" } });
		await revalidate(s);
		await jobAt(s, "done");
		const wi2 = await workItem(s, "WI-2");
		const atHead = wi2.evidence.filter((e) => e.headSha === wi2.headSha);
		expect(atHead.filter((e) => e.kind === "delta-run-check").every((e) => e.pass)).toBe(true);
		expect(atHead.find((e) => e.kind === "delta-claims-check")).toMatchObject({ check: "delta:claims-vs-receipt", pass: false });
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("CLAIM_CONFLICT");
		expect(gate.reasonCodes).not.toContain("TEST_FAILED"); // the claims check is not a test
		expect(gate.reasonCodes).not.toContain("STALE_RECEIPT"); // the receipt is current; the work is what is wrong
	}, 30_000);

	it("R8: claims that cite v2 over code that does not encode v2 fail the Delta-run contract check by its real name", async () => {
		const s = await stale({ agent: { outcome: "wrong-code" } });
		await revalidate(s);
		await jobAt(s, "done");
		const wi2 = await workItem(s, "WI-2");
		const failed = wi2.evidence.filter((e) => e.headSha === wi2.headSha && e.kind === "delta-run-check" && !e.pass);
		expect(failed.map((e) => e.check).sort()).toEqual(CHECKS);
		const notifications = failed.find((e) => e.check === CHECKS[0]);
		expect(notifications?.output).toMatch(/notifications contract failed/);
		expect(notifications?.output).toContain('src/work/wi-2.ts: notifications.default = "previous", accepted is "opt-in"');
		expect(failed.find((e) => e.check === CHECKS[1])?.output).toMatch(/status\.values = "previous"/);
		// The claims look right, so the claims check passes; it still cannot stand in for the test.
		expect(wi2.evidence.find((e) => e.kind === "delta-claims-check")).toMatchObject({ pass: true });
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("TEST_FAILED");
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: gate.forkHeadSha });
		expect([promote.status, promote.body.error.code]).toEqual([409, "PROMOTION_BLOCKED"]);
	}, 30_000);

	it("a run check with no declared required facet fails", async () => {
		// The push declares the notifications facets and nothing for status.values, which WI-2 depends on. The status-model
		// check must not pass for having found nothing to compare.
		const s = await stale({ agent: { outcome: "missing-facet" } });
		await revalidate(s);
		await jobAt(s, "done");
		const wi2 = await workItem(s, "WI-2");
		const ran = wi2.evidence.filter((e) => e.headSha === wi2.headSha && e.kind === "delta-run-check");
		expect(ran.find((e) => e.check === CHECKS[0])).toMatchObject({ pass: true });
		const status = ran.find((e) => e.check === CHECKS[1]);
		expect(status).toMatchObject({ pass: false });
		expect(status?.output).toContain("status.values is not declared in the code");
		const gate = await gateOf(s);
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("TEST_FAILED");
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: gate.forkHeadSha });
		expect([promote.status, promote.body.error.code]).toEqual([409, "PROMOTION_BLOCKED"]);
	}, 30_000);

	it("two concurrent stub agents promote one after the other without a merge conflict (live run: WI-2 got 409 MERGE_CONFLICT after WI-1)", async () => {
		const s = await scenario();
		// What each stub agent pushes to its own fork from the same baseline, on the notifications v1 context.
		const contextFiles = { "context/notifications.md": NOTIFICATIONS_V1, "context/status-model.md": STATUS_MODEL_V1 };
		const run = (workItemId: string, prompt: string) => runStubAgent({ workItemId, prompt, contextFiles }).files;
		await w.world(s, { op: "push", repo: WI1, files: run("wi-1", "Add status badges and the status-change API"), author: "workitem-wi-1" });
		await w.world(s, { op: "push", repo: WI2, files: run("wi-2", "Implement notification preferences and delivery"), author: "workitem-wi-2" });
		await w.cell(s, "pollNow");
		const heads = { "WI-1": (await workItem(s, "WI-1")).headSha as string, "WI-2": (await workItem(s, "WI-2")).headSha as string };
		expect(heads["WI-1"] && heads["WI-2"]).toBeTruthy();
		// The two forks edit different source files, so nothing but fork metadata is written by both.
		const [f1, f2] = [await w.world(s, { op: "files", repo: WI1 }), await w.world(s, { op: "files", repo: WI2 })];
		expect(f1["src/index.ts"]).toBe("export {};\n");
		expect(f2["src/index.ts"]).toBe("export {};\n");
		expect(f1[".delta/claims.json"]).not.toBe(f2[".delta/claims.json"]);

		for (const check of CHECKS.slice(1)) await evidence(s, WI1, "WI-1", heads["WI-1"], check);
		for (const check of CHECKS) await evidence(s, WI2, "WI-2", heads["WI-2"], check);
		const promote = async (id: "WI-1" | "WI-2") => {
			const gate = await gateOf(s, id);
			expect(gate, id).toMatchObject({ pass: true });
			return post(s, `/work-items/${id}/promote`, { expectedBaselineCommit: gate.baselineCommit, forkHeadSha: heads[id] });
		};
		const first = await promote("WI-1");
		expect([first.status, first.body.promoted]).toEqual([200, true]);
		// The baseline moved; WI-2's gate is now evaluated against the merge commit the poller records.
		await until(async () => ((await get(s, "/state")).body.baselineCommit === first.body.mergeCommitSha ? true : false), 8000, "the cell to see WI-1's merge");
		const second = await promote("WI-2");
		expect([second.status, second.body.promoted]).toEqual([200, true]);

		const merged = await w.world(s, { op: "files", repo: BASELINE });
		expect(merged["src/work/wi-1.ts"]).toContain("STATUS_VALUES");
		expect(merged["src/work/wi-2.ts"]).toContain("NOTIFICATIONS_DEFAULT");
		expect(merged["src/index.ts"]).toBe("export {};\n");
		expect((await ledger(s)).filter((e) => e.type === "PromotionMerged")).toHaveLength(2);
		expect([(await workItem(s, "WI-1")).item.status, (await workItem(s, "WI-2")).item.status]).toEqual(["promoted", "promoted"]);
	}, 30_000);

	it("R8: evidence the agent's own claims produced never satisfies the contract test, even recorded under the validation path", async () => {
		const s = await stale({ agent: { hold: true } });
		await revalidate(s);
		await jobAt(s, "running");
		await w.world(s, { op: "agentRelease" });
		await jobAt(s, "done");
		const wi2 = await workItem(s, "WI-2");
		const head = wi2.headSha as string;
		// A claims-check result under a validation path (as an earlier build wrote it) adds nothing and takes nothing away.
		for (const check of CHECKS) {
			await w.cell(s, "recordObservation", { type: "EvidenceRecorded", ts: "2026-10-13T16:00:00Z", repo: WI2, commitSha: head, runId: `run-${key("ev")}`, evidence: { workItemId: "WI-2", headSha: head, check, pass: false, output: "claims", kind: "delta-claims-check" } });
		}
		expect((await gateOf(s)).pass).toBe(true);
	}, 30_000);
});
