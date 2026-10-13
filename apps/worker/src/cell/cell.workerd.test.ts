import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReconciliationEvent, WsMessage } from "contracts";
import { NOTIFICATIONS_V1, NOTIFICATIONS_V2, STATUS_MODEL_V1, claims, dependencies, policy } from "scenario-notifications";
import { parseFrame } from "./api";
import { startWorkerd, type Workerd } from "./testing/workerd";

// The whole control loop inside workerd: real Durable Object SQLite, a real alarm-driven poller,
// real hibernating WebSockets, real Hono routes. Only Artifacts is the in-memory fake, so these
// prove the logic and the wiring, not the live binding (docs/control-loop.md lists what to check live).

let w: Workerd; // reassigned by the one test that needs a slower poller
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

let keys = 0;
const key = (label = "k") => `${label}-${++keys}-test-key`;
const post = (s: string, path: string, body: unknown, k = key(), headers: Record<string, string> = {}) =>
	w.api("POST", `/scenarios/${s}${path}`, { body, headers: { "Idempotency-Key": k, ...headers } });
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

async function ledger(s: string): Promise<ReconciliationEvent[]> {
	return (await get(s, "/ledger?limit=1000")).body.entries;
}
const lastOf = async (s: string, type: string) => (await ledger(s)).filter((e) => e.type === type).at(-1);
const reasons = (entry: ReconciliationEvent | undefined) => (entry?.payload.effects ?? []).flatMap((e) => e.reasonCodes);
async function item(s: string, id: string) {
	return ((await get(s, "/state")).body.workItems as Array<{ item: { id: string; status: string }; conditions: Array<{ type: string; reasonCodes: string[]; facetKeys: string[] }>; headSha: string | null; contextPaths?: string[] }>).find((wi) => wi.item.id === id);
}

/** A scenario with a baseline at v1, two forks, an initialised cell and both work items registered. */
async function scenario(options: { register?: boolean; authority?: Record<string, string> } = {}) {
	const s = `n-${++n}`;
	await w.world(s, { op: "create", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V1, "context/status-model.md": STATUS_MODEL_V1, "AGENTS.md": "# agents\n", "src/index.ts": "export {};\n" } });
	await w.world(s, { op: "fork", base: BASELINE, repo: WI1 });
	await w.world(s, { op: "fork", base: BASELINE, repo: WI2 });
	const init = await post(s, "/init", { baselineRepo: BASELINE, policy: { ...policy, authority: options.authority ?? policy.authority } });
	expect(init.status).toBe(201);
	if (options.register !== false) {
		const wi1 = await post(s, "/work-items", { id: "WI-1", title: "Status badges", forkRepo: WI1, requires: ["contract-test"], dependencies: dependencies.wi1.map((d) => ({ recordId: d.recordId, facetKeys: d.facetKeys })) });
		const wi2 = await post(s, "/work-items", { id: "WI-2", title: "Notification delivery", forkRepo: WI2, requires: ["contract-test"], dependencies: dependencies.wi2.map((d) => ({ recordId: d.recordId, facetKeys: d.facetKeys })) });
		expect([wi1.status, wi2.status]).toEqual([201, 201]);
	}
	return s;
}

async function bindingFor(s: string, id: string, recordId: string) {
	const state = (await get(s, "/state")).body;
	const history = state.records[recordId];
	const record = history.versions[String(history.current)];
	const wi = await item(s, id);
	return { recordId, version: record.version, blobHash: record.blobHash, baseSha: state.baselineCommit, forkHeadSha: wi?.headSha, contextSnapshotHash: state.snapshotHash };
}

const evidence = (s: string, repo: string, id: string, headSha: string, check: string, pass = true) =>
	w.cell(s, "recordObservation", { type: "EvidenceRecorded", ts: "2026-10-13T16:00:00Z", repo, commitSha: headSha, runId: `run-${key("ev")}`, evidence: { workItemId: id, headSha, check, pass, output: pass ? "ok" : "failed" } });

describe("auth and request hygiene", () => {
	it("needs the bearer secret, and an Idempotency-Key and a JSON object on every mutation", async () => {
		const s = await scenario();
		expect((await w.fetch(`/api/scenarios/${s}/state`)).status).toBe(401);
		expect((await w.api("POST", `/scenarios/${s}/context-changes`, { body: {} })).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
		expect((await post(s, "/context-changes", "nope" as never)).body.error.code).toBe("INVALID_JSON");
		expect((await post(s, "/context-changes", { recordId: "notifications" })).status).toBe(400);
		expect((await get("Bad_Name", "/state")).status).toBe(400);
		expect((await get("never-initialised", "/state")).body.error.code).toBe("NOT_INITIALIZED");
	});

	it("takes the actor from the session and refuses one in the body", async () => {
		const s = await scenario();
		const res = await post(s, "/work-items/WI-2/resolutions", { kind: "reject", rationale: "x", actor: { kind: "human", id: "decision-owner", displayName: "x" }, binding: await bindingFor(s, "WI-2", "notifications") });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("INVALID_INPUT");
	});
});

describe("Scenario A through the control loop", () => {
	it("typo beat: a prose-only edit is NO_ACTION / PROSE_ONLY and no work item changes", async () => {
		const s = await scenario();
		const before = (await get(s, "/state")).body.workItems.map((wi: { item: { status: string } }) => wi.item.status);
		const res = await post(s, "/context-changes", { recordId: "notifications", prose: "# Notifications\nUsers receive project status updates immediately, on by default.\n", rationale: "typo" });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ kind: "prose-edit", version: 1, decisionPath: null, observed: true });
		const entry = await lastOf(s, "BaselinePushed");
		expect(reasons(entry)).toEqual(["PROSE_ONLY"]);
		expect((await get(s, "/state")).body.workItems.map((wi: { item: { status: string } }) => wi.item.status)).toEqual(before);
	});

	it("a context change flips WI-2 to Stale and leaves WI-1 alone, and the ledger says why", async () => {
		const s = await scenario();
		await post(s, "/context-changes", { recordId: "notifications", prose: "# Notifications\nfixed typo\n", rationale: "typo" });
		const started = Date.now();
		const res = await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, not: { "notifications.default": "on", "notifications.cadence": "immediate" }, rationale: "Make notifications opt-in with a weekly digest." });
		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ kind: "new-version", version: 2, decisionPath: "decisions/0001-notifications-v2.md" });

		const wi2 = await item(s, "WI-2");
		expect(wi2?.item.status).toBe("stale");
		const stale = wi2?.conditions.find((c) => c.type === "Stale");
		expect(stale?.facetKeys).toEqual(["notifications.cadence", "notifications.default"]);
		const wi1 = await item(s, "WI-1");
		expect(wi1?.conditions.map((c) => c.type)).toEqual(["Fresh"]);
		expect(Date.now() - started).toBeLessThan(10_000);

		const entry = await lastOf(s, "BaselinePushed");
		const effects = entry?.payload.effects ?? [];
		expect(effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-1", reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] }));
		expect(effects.map((e) => e.type)).toEqual(expect.arrayContaining(["RECORD_CONDITION", "REQUEST_REVIEW", "BLOCK_PROMOTION"]));

		// The baseline now holds the new version and a decision stub, authored by the acting human, committed by the Worker.
		const files = await w.world(s, { op: "files", repo: BASELINE });
		expect(files["context/notifications.md"]).toContain("version: 2");
		expect(files["decisions/0001-notifications-v2.md"]).toContain("Make notifications opt-in");
		const commit = (await ledger(s)).length;
		expect(commit).toBeGreaterThan(3);
	});

	it("the poller picks up a fork push on its own and compares its claims (R3)", async () => {
		const s = await scenario();
		await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		const started = Date.now();
		await w.world(s, { op: "push", repo: WI2, files: { ".delta/claims.json": JSON.stringify(claims.wi2V1), "src/work.ts": "export const x = 1;\n" }, author: "workitem-wi-2" });
		const wi2 = await until(async () => {
			const found = await item(s, "WI-2");
			return found?.headSha ? found : false;
		}, 8000, "the poller to see the push");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(wi2.conditions.map((c) => c.type)).toEqual(expect.arrayContaining(["Stale", "ClaimConflict", "Blocked"]));
		expect(wi2.item.status).toBe("conflict");
	});

	it("missing claims are Uncertain/NO_CLAIMS and malformed claims MALFORMED_CLAIMS", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI1, files: { "src/a.ts": "a" } });
		const missing = await until(async () => (await item(s, "WI-1"))?.headSha && (await item(s, "WI-1")), 8000, "push");
		expect(missing && missing.conditions.find((c) => c.type === "Uncertain")?.reasonCodes).toContain("NO_CLAIMS");
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": "{not json" } });
		await until(async () => (await item(s, "WI-1"))?.conditions.some((c) => c.reasonCodes.includes("MALFORMED_CLAIMS")), 8000, "malformed claims");
	});

	it("a fork that edits context/** is blocked, and its copy is never an accepted version", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI2, files: { "context/notifications.md": NOTIFICATIONS_V2, ".delta/claims.json": JSON.stringify(claims.wi2V2) }, author: "workitem-wi-2" });
		const wi2 = await until(async () => {
			const found = await item(s, "WI-2");
			return found?.contextPaths?.length ? found : false;
		}, 8000, "the fork push");
		expect(wi2.contextPaths).toEqual(["context/notifications.md"]);
		const state = (await get(s, "/state")).body;
		expect(state.records.notifications.current).toBe(1); // not v2
		const gate = (await get(s, "/work-items/WI-2/gate")).body;
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("FORK_EDITS_CONTEXT");
		expect(reasons(await lastOf(s, "ForkPushed"))).toContain("FORK_CONTEXT_IGNORED");
	});

	it("dedupes: the same push delivered twice (poller, then the Queue path) is one ledger line", async () => {
		const s = await scenario();
		const sha = await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) } });
		await until(async () => (await item(s, "WI-1"))?.headSha === sha, 8000, "the poller");
		const count = async () => (await ledger(s)).filter((e) => e.type === "ForkPushed").length;
		expect(await count()).toBe(1);
		const again = await w.cell<{ outcome: string }>(s, "observePush", WI1, sha);
		const third = await w.cell<{ outcome: string }>(s, "observePush", WI1, sha);
		expect([again.outcome, third.outcome]).toEqual(["duplicate", "duplicate"]);
		await w.cell(s, "pollNow");
		expect(await count()).toBe(1);
	});

	it("keeps polling through a failing read and then catches up", async () => {
		const s = await scenario();
		await w.world(s, { op: "fail", method: "log", times: 4 });
		const sha = await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) } });
		await until(async () => (await item(s, "WI-1"))?.headSha === sha, 8000, "recovery after failures");
		const poller = (await get(s, "/poller")).body;
		expect(poller.intervalMs).toBe(150);
		expect(poller.repos.map((r: { repo: string }) => r.repo)).toEqual([BASELINE, WI1, WI2]);
	});
});

describe("trust boundary", () => {
	it("a context commit nobody proved the Worker wrote is not accepted, whatever its author or accepted_by says", async () => {
		const s = await scenario();
		// An agent with a write token pushes v2 to the baseline, author set to the authority, file claiming the authority accepted it.
		await w.world(s, { op: "push", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V2 }, author: "decision-owner" });
		const entry = await until(async () => {
			const e = await lastOf(s, "BaselinePushed");
			return e && e.payload.event.type === "BaselinePushed" && e.payload.event.commitSha === (await w.world(s, { op: "head", repo: BASELINE })) ? e : false;
		}, 8000, "the poller");
		expect(reasons(entry)).toContain("RECORD_NOT_ACCEPTED");
		const state = (await get(s, "/state")).body;
		expect(state.records.notifications.current).toBe(1);
		expect((await item(s, "WI-2"))?.item.status).toBe("running");
	});

	it("a context change after a forged one builds on the accepted version, not the forged file", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V2.replace("opt-in", "forged-value") }, author: "decision-owner" });
		await w.cell(s, "pollNow");
		const res = await post(s, "/context-changes", { recordId: "notifications", bumpVersion: true, prose: "# Notifications\nbumped\n", rationale: "bump" });
		expect(res.status).toBe(201);
		const files = await w.world(s, { op: "files", repo: BASELINE });
		expect(files["context/notifications.md"]).not.toContain("forged-value");
		expect(files["context/notifications.md"]).toContain('"on"'); // v1's facets carried over
	});

	it("init takes authority from the policy, not from the record file", async () => {
		const s = `n-${++n}`;
		await w.world(s, { op: "create", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V1 } });
		const res = await post(s, "/init", { baselineRepo: BASELINE, policy: { ...policy, authority: {} } });
		expect(res.status).toBe(201);
		expect(res.body.records).toEqual([]);
		expect(res.body.ignored[0].reason).toMatch(/names no authority/);
	});

	it("registration refuses a base commit that is not baseline history", async () => {
		const s = await scenario({ register: false });
		const forkOnly = await w.world(s, { op: "push", repo: WI1, files: { "context/notifications.md": NOTIFICATIONS_V2 } });
		const res = await post(s, "/work-items", { id: "WI-1", title: "x", forkRepo: WI1, baseCommit: forkOnly, dependencies: [] });
		expect(res.status).toBe(409);
		expect(res.body.error.code).toBe("UNKNOWN_BASE_COMMIT");
	});

	it("only the record's authority changes it, and only a human", async () => {
		const other = await scenario({ register: false, authority: { notifications: "someone-else", "status-model": "decision-owner" } });
		const denied = await post(other, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "x" });
		expect([denied.status, denied.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);

		const s = await scenario();
		const asAgent = await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "x" }, key(), { "X-Delta-Principal": "agent:agent-b" });
		expect([asAgent.status, asAgent.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);
		expect((await w.world(s, { op: "files", repo: BASELINE }))["context/notifications.md"]).toContain("version: 1");
	});
});

describe("idempotency", () => {
	it("replays the same result for the same key, and refuses the same key on a different body", async () => {
		const s = await scenario();
		const k = key("ctx");
		const body = { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" };
		const first = await post(s, "/context-changes", body, k);
		const head = await w.world(s, { op: "head", repo: BASELINE });
		const replay = await post(s, "/context-changes", body, k);
		expect(replay.status).toBe(first.status);
		expect(replay.body).toEqual(first.body);
		expect(replay.headers.get("Idempotent-Replay")).toBe("true");
		expect(await w.world(s, { op: "head", repo: BASELINE })).toBe(head); // no second commit
		const conflict = await post(s, "/context-changes", { ...body, rationale: "something else" }, k);
		expect([conflict.status, conflict.body.error.code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
	});
});

describe("gate, resolutions and promotion", () => {
	async function staleConflict() {
		const s = await scenario();
		await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		await w.world(s, { op: "push", repo: WI2, files: { ".delta/claims.json": JSON.stringify(claims.wi2V1) }, author: "workitem-wi-2" });
		await w.cell(s, "pollNow");
		return s;
	}

	it("GET gate is a dry run with reason codes; the same codes block promote", async () => {
		const s = await staleConflict();
		const gate = await get(s, "/work-items/WI-2/gate");
		expect(gate.status).toBe(200);
		expect(gate.body.pass).toBe(false);
		expect(gate.body.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT"]));
		expect((await get(s, "/work-items/NOPE/gate")).status).toBe(404);

		const state = (await get(s, "/state")).body;
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: state.baselineCommit, forkHeadSha: gate.body.forkHeadSha });
		expect([promote.status, promote.body.error.code]).toEqual([409, "PROMOTION_BLOCKED"]);
		expect(promote.body.error.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT"]));
		expect((await w.world(s, { op: "files", repo: BASELINE }))["src/work.ts"]).toBeUndefined();
	});

	it("an agent cannot resolve or promote: 403 FORBIDDEN_ACTOR, and the refusal is in the ledger", async () => {
		const s = await staleConflict();
		const binding = await bindingFor(s, "WI-2", "notifications");
		for (const kind of ["revalidate", "reject"]) {
			const res = await post(s, "/work-items/WI-2/resolutions", { kind, rationale: "trying", binding }, key(), { "X-Delta-Principal": "agent:agent-b" });
			expect([res.status, res.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);
		}
		const state = (await get(s, "/state")).body;
		const promote = await post(s, "/work-items/WI-2/promote", { expectedBaselineCommit: state.baselineCommit, forkHeadSha: binding.forkHeadSha }, key(), { "X-Delta-Principal": "agent:agent-b" });
		expect([promote.status, promote.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);
		expect((await ledger(s)).filter((e) => e.type === "ResolutionRecorded")).toHaveLength(2);
		expect((await item(s, "WI-2"))?.item.status).toBe("conflict");
	});

	it("a human revalidates; a stale binding is refused; replay and conflict follow the key", async () => {
		const s = await staleConflict();
		const binding = await bindingFor(s, "WI-2", "notifications");
		const stale = await post(s, "/work-items/WI-2/resolutions", { kind: "revalidate", rationale: "go", binding: { ...binding, baseSha: "a".repeat(40) } });
		expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_BINDING"]);

		const k = key("rv");
		const body = { kind: "revalidate", rationale: "Decision changed under this work.", binding };
		const ok = await post(s, "/work-items/WI-2/resolutions", body, k);
		expect(ok.status).toBe(200);
		expect(ok.body.effects.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["REQUEST_REVALIDATION", "DISPATCH_WORK"]));
		expect((await item(s, "WI-2"))?.item.status).toBe("revalidating");
		const replay = await post(s, "/work-items/WI-2/resolutions", body, k);
		expect(replay.body).toEqual(ok.body);
		expect((await post(s, "/work-items/WI-2/resolutions", { ...body, rationale: "different" }, k)).body.error.code).toBe("IDEMPOTENCY_CONFLICT");
		expect((await ledger(s)).filter((e) => e.type === "ResolutionRecorded" && e.payload.effects.some((x) => x.type === "DISPATCH_WORK"))).toHaveLength(1);
	});

	it("accept-exception needs a scope", async () => {
		const s = await staleConflict();
		const binding = await bindingFor(s, "WI-2", "notifications");
		const res = await post(s, "/work-items/WI-2/resolutions", { kind: "accept-exception", rationale: "grandfathered", binding });
		expect(res.status).toBe(400);
	});

	it("promotes unaffected work: request, merge, record, with a compare-and-swap on the baseline", async () => {
		const s = await staleConflict();
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1), "src/wi1.ts": "export const badge = 1;\n" }, author: "workitem-wi-1" });
		await w.cell(s, "pollNow");
		const wi1 = await item(s, "WI-1");
		expect(wi1?.headSha).toBeTruthy();
		await evidence(s, WI1, "WI-1", wi1?.headSha as string, "tests/contract/status-model.test.ts");
		const gate = (await get(s, "/work-items/WI-1/gate")).body;
		expect(gate).toMatchObject({ pass: true, reasonCodes: [] });

		const state = (await get(s, "/state")).body;
		const wrongBaseline = await post(s, "/work-items/WI-1/promote", { expectedBaselineCommit: "b".repeat(40), forkHeadSha: gate.forkHeadSha });
		expect([wrongBaseline.status, wrongBaseline.body.error.code]).toEqual([409, "BASELINE_MOVED"]);

		const k = key("promote");
		const body = { expectedBaselineCommit: state.baselineCommit, forkHeadSha: gate.forkHeadSha };
		const res = await post(s, "/work-items/WI-1/promote", body, k);
		expect(res.status).toBe(200);
		expect(res.body.promoted).toBe(true);

		const files = await w.world(s, { op: "files", repo: BASELINE });
		expect(files["src/wi1.ts"]).toContain("badge");
		expect(files["context/notifications.md"]).toContain("version: 2"); // the decision change is still there
		expect((await item(s, "WI-1"))?.item.status).toBe("promoted");
		const after = (await get(s, "/state")).body;
		expect(after.baselineCommit).toBe(res.body.mergeCommitSha);

		const types = (await ledger(s)).map((e) => e.type);
		expect(types.slice(types.lastIndexOf("PromotionRequested"))).toEqual(["PromotionRequested", "PromotionMerged", "BaselinePushed"]);

		// A double click is one merge.
		const replay = await post(s, "/work-items/WI-1/promote", body, k);
		expect(replay.body).toEqual(res.body);
		const again = await post(s, "/work-items/WI-1/promote", { ...body, expectedBaselineCommit: after.baselineCommit }, key("p2"));
		expect([again.status, again.body.error.code]).toEqual([409, "ALREADY_PROMOTED"]);
		expect((await ledger(s)).filter((e) => e.type === "PromotionMerged")).toHaveLength(1);
		expect(await (await get(s, "/ledger/verify")).body).toMatchObject({ ok: true });
	});

	it("a context push between the approval and the merge cannot slip through", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) } });
		await w.cell(s, "pollNow");
		const head = (await item(s, "WI-1"))?.headSha as string;
		await evidence(s, WI1, "WI-1", head, "tests/contract/status-model.test.ts");
		const state = (await get(s, "/state")).body;
		// The baseline moves in git after the console read it (not yet seen by the cell).
		await w.world(s, { op: "push", repo: BASELINE, files: { "src/other.ts": "x" } });
		const res = await post(s, "/work-items/WI-1/promote", { expectedBaselineCommit: state.baselineCommit, forkHeadSha: head });
		expect([res.status, res.body.error.code]).toEqual([409, "BASELINE_MOVED"]);
		expect((await item(s, "WI-1"))?.item.status).not.toBe("promoted");
	});
});

describe("concurrent requests against one baseline", () => {
	it("two context changes made from the same baseline: one commits, the other is refused with BASELINE_MOVED and the baseline it is at", async () => {
		const s = await scenario();
		const opened = (await get(s, "/state")).body.baselineCommit as string;
		const mine = { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in", expectedBaselineCommit: opened };
		const theirs = { recordId: "notifications", facets: { ...V2_FACETS, "notifications.cadence": "daily-digest" }, rationale: "daily", expectedBaselineCommit: opened };
		const first = await post(s, "/context-changes", mine);
		expect([first.status, first.body.version]).toEqual([201, 2]);
		const second = await post(s, "/context-changes", theirs);
		expect([second.status, second.body.error.code]).toEqual([409, "BASELINE_MOVED"]);
		expect(second.body.error.baselineCommit).toBe(first.body.commitSha);
		expect((await w.world(s, { op: "files", repo: BASELINE }))["context/notifications.md"]).not.toContain("daily-digest");
	});

	it("two promote requests fired together against one baseline: exactly one merges, the other is a clean 409, and the ledger has one PromotionMerged", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1), "src/wi1.ts": "export const badge = 1;\n" }, author: "workitem-wi-1" });
		await w.cell(s, "pollNow");
		const head = (await item(s, "WI-1"))?.headSha as string;
		await evidence(s, WI1, "WI-1", head, "tests/contract/status-model.test.ts");
		const state = (await get(s, "/state")).body;
		const body = { expectedBaselineCommit: state.baselineCommit, forkHeadSha: head };

		const results = await Promise.all([post(s, "/work-items/WI-1/promote", body, key("race-a")), post(s, "/work-items/WI-1/promote", body, key("race-b"))]);
		const outcomes = results.map((r) => [r.status, r.body.error?.code ?? null]).sort((a, b) => (a[0] as number) - (b[0] as number));
		expect(outcomes[0]).toEqual([200, null]);
		// The cell runs requests one at a time, so the loser is judged after the winner's merge is recorded: the item is already promoted.
		expect(outcomes[1]).toEqual([409, "ALREADY_PROMOTED"]);
		const entries = await ledger(s);
		expect(entries.filter((e) => e.type === "PromotionMerged")).toHaveLength(1);
		// Both requests are on the ledger, but only the first was allowed; the second is a recorded refusal.
		const requests = entries.filter((e) => e.type === "PromotionRequested");
		expect(requests.map((e) => reasons(e))).toEqual([[], ["ALREADY_PROMOTED"]]);
		expect((await w.world(s, { op: "files", repo: BASELINE }))["src/wi1.ts"]).toContain("badge");
		expect((await item(s, "WI-1"))?.item.status).toBe("promoted");
		expect((await get(s, "/ledger/verify")).body).toMatchObject({ ok: true });
	});
});

describe("ledger", () => {
	it("verifies an untouched chain and reports the seq of an edited line", async () => {
		const s = await scenario();
		await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		expect((await get(s, "/ledger/verify")).body).toMatchObject({ ok: true });
		await w.cell(s, "testSql", "UPDATE ledger SET json = replace(json, 'WI-2', 'WI-3') WHERE seq = 2");
		expect((await get(s, "/ledger/verify")).body).toMatchObject({ ok: false, brokenAt: 2 });
	});
});

describe("WebSocket", () => {
	it("needs the secret, sends a snapshot first, then events and agent activity, each with meta.seq; resumes with ?since", async () => {
		const s = await scenario();
		const denied = (await w.fetch(`/api/scenarios/${s}/ws`, { headers: { Upgrade: "websocket" } })).status;
		expect(denied).toBe(401);

		const socket = await w.openSocket(s);
		expect(socket.status).toBe(101);
		const first = await socket.waitFor(() => true);
		expect(first.type).toBe("snapshot");
		const head = (await get(s, "/state")).body.ledgerHead.seq;
		expect(first.meta.seq).toBe(head);

		await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		const event = await socket.waitFor((f) => f.type === "event" && f.event.type === "BaselinePushed");
		expect(event.meta.seq).toBe(event.event.seq);
		expect(event.workItems.map((x: { item: { id: string } }) => x.item.id)).toEqual(["WI-1", "WI-2"]);
		// What the console asked for, so it need not re-read the state.
		expect(event.meta.evaluationMs).toBeGreaterThanOrEqual(0);
		expect(event.meta.baselineCommit).toBe(event.event.baselineSha);
		expect(event.meta.records.notifications.current).toBe(2);

		await w.cell(s, "publishActivity", { type: "agent-activity", workItemId: "WI-2", runId: "run-1", kind: "text", text: "thinking", ts: "2026-10-13T16:00:00Z" });
		const activity = await socket.waitFor((f) => f.type === "agent-activity");
		expect(activity.meta.seq).toBeGreaterThanOrEqual(event.meta.seq);

		// The pushed work arrives without anyone asking, with its dependencies.
		await w.world(s, { op: "push", repo: WI2, files: { ".delta/claims.json": JSON.stringify(claims.wi2V1) } });
		const forkEvent = await socket.waitFor((f) => f.type === "event" && f.event.type === "ForkPushed");
		expect(forkEvent.meta.dependencies.length).toBeGreaterThan(0);

		// Every frame is a valid contract message once `meta` is split off.
		for (const frame of socket.frames) {
			const parsed = parseFrame(frame);
			expect(parsed, JSON.stringify(frame).slice(0, 200)).not.toBeNull();
			expect(WsMessage.safeParse(parsed?.message).success).toBe(true);
		}
		socket.close();

		// A client that saw up to the BaselinePushed line reconnects and gets a snapshot, then what it missed.
		const resumed = await w.openSocket(s, event.meta.seq);
		await resumed.waitFor((f) => f.meta.replay === true && f.event.seq === forkEvent.meta.seq);
		expect(resumed.frames[0].type).toBe("snapshot");
		expect(resumed.frames[0].meta.gap).toBeUndefined();
		const replayed = resumed.frames.filter((f) => f.meta.replay).map((f) => f.meta.seq);
		expect(replayed).toEqual(replayed.slice().sort((a, b) => a - b));
		expect(replayed[0]).toBe(event.meta.seq + 1);
		resumed.close();

		// A client that is ahead of the server is told to trust the snapshot.
		const ahead = await w.openSocket(s, 9999);
		expect((await ahead.waitFor(() => true)).meta.gap).toBe(true);
		ahead.close();
	});

	it("the snapshot's ledgerTail reaches back to the latest BaselinePushed, with evaluation times", async () => {
		const s = await scenario();
		await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		const pushSeq = (await lastOf(s, "BaselinePushed"))?.seq as number;
		for (let i = 0; i < 60; i++) await w.world(s, { op: "push", repo: WI1, files: { [`src/f${i}.ts`]: "x" } }).then(() => w.cell(s, "pollNow"));
		const socket = await w.openSocket(s);
		const snapshot = await socket.waitFor(() => true);
		// Forks only count their newest commit per poll, so 60 pushes are 60 lines here.
		expect(snapshot.snapshot.ledgerTail[0].seq).toBeLessThanOrEqual(pushSeq);
		expect(Object.keys(snapshot.meta.evaluationMsBySeq).length).toBeGreaterThan(50);
		socket.close();
	});
});

describe("restart", () => {
	it("a reset Durable Object comes back with its state, its dedupe table and its poller", async () => {
		const s = await scenario();
		await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		const before = (await get(s, "/state")).body;
		await w.cell(s, "testAbort").catch(() => undefined);
		const after = (await get(s, "/state")).body;
		expect(after.ledgerHead).toEqual(before.ledgerHead);
		expect(after.records.notifications.current).toBe(2);
		// Dedupe survived: observing the baseline head again adds nothing.
		const head = await w.world(s, { op: "head", repo: BASELINE });
		expect((await w.cell<{ outcome: string }>(s, "observePush", BASELINE, head)).outcome).toBe("duplicate");
		// And the alarm is still ticking: a new fork push is found.
		const sha = await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) } });
		await until(async () => (await item(s, "WI-1"))?.headSha === sha, 8000, "the poller after a restart");
	});
});

describe("console compatibility", () => {
	it("serves a record's accepted prose as Markdown", async () => {
		const s = await scenario();
		const res = await w.fetch(`/api/scenarios/${s}/context/notifications`, { headers: { Authorization: "Bearer test-bearer-token" } });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/markdown");
		expect(await res.text()).toContain("# Notifications");
		expect((await get(s, "/context/nope")).status).toBe(404);
	});

	it("accepts the work item id repeated in the body only when it matches the path", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI2, files: { ".delta/claims.json": JSON.stringify(claims.wi2V1) } });
		await w.cell(s, "pollNow");
		const binding = await bindingFor(s, "WI-2", "notifications");
		const mismatch = await post(s, "/work-items/WI-2/resolutions", { workItemId: "WI-1", kind: "reject", rationale: "x", binding });
		expect([mismatch.status, mismatch.body.error.code]).toEqual([400, "WORK_ITEM_MISMATCH"]);
		const match = await post(s, "/work-items/WI-2/resolutions", { workItemId: "WI-2", kind: "reject", rationale: "x", binding: { ...binding, forkHeadSha: "c".repeat(40) } });
		expect(match.body.error.code).toBe("STALE_BINDING"); // it got as far as the reconciler
	});
});

describe("poller: never loses a baseline change, and says when it is struggling", () => {
	it("keeps retrying a baseline commit it cannot read, reports itself degraded meanwhile, then records it", async () => {
		const s = await scenario();
		const state = () => w.api("GET", `/scenarios/${s}/state`);
		expect((await state()).headers.get("x-delta-poller")).toBe("healthy");
		await w.world(s, { op: "fail", method: "tree", times: 5 });
		const sha = await w.world(s, { op: "push", repo: BASELINE, files: { "src/new.ts": "x" }, author: "delta-convergence" });
		await until(async () => (await state()).headers.get("x-delta-poller") === "degraded", 8000, "the poller to report trouble");
		const poller = (await get(s, "/poller")).body;
		expect(poller.health.healthy).toBe(false);
		expect(poller.health.degraded[0]).toMatchObject({ repo: BASELINE, kind: "baseline" });
		// Past the point where an older version gave up (4 failures): the commit is still not lost.
		const recorded = await until(
			async () => (await ledger(s)).some((e) => e.payload.event.type === "BaselinePushed" && e.payload.event.commitSha === sha),
			20_000,
			"the baseline commit to be recorded after the failures end",
		);
		expect(recorded).toBe(true);
		await until(async () => (await state()).headers.get("x-delta-poller") === "healthy", 8000, "the poller to recover");
	}, 40_000);

	it("fails closed on a decision file it cannot read: the change is not dropped, nothing promotes meanwhile, and the next poll lands it", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) }, author: "workitem-wi-1" });
		await w.cell(s, "pollNow");
		const wi1Head = (await item(s, "WI-1"))?.headSha as string;
		await evidence(s, WI1, "WI-1", wi1Head, "tests/contract/status-model.test.ts");
		const before = (await get(s, "/state")).body;

		// The Worker writes v2 and reads it straight back; Artifacts answers "not found" for the new blob (skip the one read of the sitting version).
		await w.world(s, { op: "nullBlobs", times: 1000, skip: 1 });
		const change = await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		expect(change.status).toBe(201);
		expect(change.body.observed).toBe(false);
		const sha = change.body.commitSha as string;
		await w.cell(s, "pollNow");

		// Unknown is not invalid: no line for the commit (so no RECORD_NOT_ACCEPTED either), the cursor stays behind it, and the baseline has not moved.
		const entries = await ledger(s);
		expect(entries.some((e) => e.payload.event.type === "BaselinePushed" && e.payload.event.commitSha === sha)).toBe(false);
		expect(reasons(entries.at(-1))).not.toContain("RECORD_NOT_ACCEPTED");
		const mid = (await get(s, "/state")).body;
		expect(mid.baselineCommit).toBe(before.baselineCommit);
		expect(mid.records.notifications.current).toBe(1);
		expect((await get(s, "/poller")).body.health.healthy).toBe(false);
		// Promotion is refused while the cell is behind the baseline; it never merges v1-based work into a v2 baseline.
		const promote = await post(s, "/work-items/WI-1/promote", { expectedBaselineCommit: before.baselineCommit, forkHeadSha: wi1Head });
		expect([promote.status, promote.body.error.code]).toEqual([503, "POLLER_BEHIND"]);
		expect((await item(s, "WI-1"))?.item.status).not.toBe("promoted");
		expect((await w.world(s, { op: "files", repo: BASELINE }))["src/wi1.ts"]).toBeUndefined();

		// The read works on a later poll: the change lands and the dependent goes stale.
		await w.world(s, { op: "nullBlobs", times: 0 });
		await until(async () => (await item(s, "WI-2"))?.item.status === "stale", 20_000, "the retried read to land the change");
		const landed = (await ledger(s)).filter((e) => e.payload.event.type === "BaselinePushed" && e.payload.event.commitSha === sha);
		expect(landed).toHaveLength(1);
		expect(reasons(landed[0])).not.toContain("RECORD_NOT_ACCEPTED");
		expect((await get(s, "/state")).body.records.notifications.current).toBe(2);
		expect((await item(s, "WI-1"))?.conditions.map((c) => c.type)).toEqual(["Fresh", "TestsPassed", "Ready"]); // no dependency on the changed facets
	}, 40_000);

	it("tells the console in the snapshot meta, and refuses to promote or change context on a baseline it has not caught up with", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) } });
		await w.cell(s, "pollNow");
		await evidence(s, WI1, "WI-1", (await item(s, "WI-1"))?.headSha as string, "tests/contract/status-model.test.ts");
		const state = (await get(s, "/state")).body;
		const headSha = (await item(s, "WI-1"))?.headSha;
		// The baseline moves and the cell cannot read it.
		await w.world(s, { op: "push", repo: BASELINE, files: { "src/other.ts": "x" } });
		await w.world(s, { op: "fail", method: "tree", times: 40 });
		const promote = await post(s, "/work-items/WI-1/promote", { expectedBaselineCommit: state.baselineCommit, forkHeadSha: headSha });
		expect([promote.status, promote.body.error.code]).toEqual([503, "POLLER_BEHIND"]);
		const change = await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "x" });
		expect([change.status, change.body.error.code]).toEqual([503, "POLLER_BEHIND"]);
		const socket = await w.openSocket(s);
		const snapshot = await socket.waitFor(() => true);
		expect(snapshot.meta.poller.healthy).toBe(false);
		socket.close();
		await w.world(s, { op: "fail", method: "tree", times: 0 });
	});

	it("a fork push it cannot read is retried, then delivered fail-closed rather than dropped", async () => {
		const s = await scenario();
		await w.world(s, { op: "fail", method: "readFile", times: 3 });
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1), "src/wi1.ts": "export const x = 1;\n" }, author: "workitem-wi-1" });
		const wi1 = await until(async () => {
			const found = await item(s, "WI-1");
			return found?.headSha ? found : false;
		}, 15_000, "the push to be delivered");
		expect(wi1.conditions.flatMap((c) => c.reasonCodes)).toContain("MALFORMED_CLAIMS");
		await w.cell(s, "pollNow"); // a clean read of the same head is a no-op; the next real push reads normally
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1) }, author: "workitem-wi-1" });
		await until(async () => !(await item(s, "WI-1"))?.conditions.some((c) => c.reasonCodes.includes("MALFORMED_CLAIMS")), 8000, "the readable push to replace it");
	}, 30_000);

	it("catches up on a baseline that moved more than 50 commits between polls", async () => {
		const slow = await startWorkerd({ pollIntervalMs: 60_000 }); // the alarm will not fire during this test
		const fast = w;
		w = slow; // the helpers above talk to `w`; tests in a file run one at a time
		try {
			const s = await scenario();
			await w.world(s, { op: "pushMany", repo: BASELINE, count: 120 });
			await w.cell(s, "pollNow");
			const pushes = (await ledger(s)).filter((e) => e.type === "BaselinePushed");
			expect(pushes).toHaveLength(120);
		} finally {
			w = fast;
			await slow.dispose();
		}
	}, 60_000);
});

describe("promotion that lands but is not recorded", () => {
	it("is finalized on the next poll when the merge commit is the head", async () => {
		const s = await scenario();
		await w.world(s, { op: "push", repo: WI1, files: { ".delta/claims.json": JSON.stringify(claims.wi1), "src/wi1.ts": "export const badge = 1;\n" }, author: "workitem-wi-1" });
		await w.cell(s, "pollNow");
		const head = (await item(s, "WI-1"))?.headSha as string;
		await evidence(s, WI1, "WI-1", head, "tests/contract/status-model.test.ts");
		const state = (await get(s, "/state")).body;

		await w.world(s, { op: "failAfter", method: "mergeFork" }); // the merge lands, the answer is lost
		const lost = await post(s, "/work-items/WI-1/promote", { expectedBaselineCommit: state.baselineCommit, forkHeadSha: head });
		expect([lost.status, lost.body.error.code]).toEqual([502, "MERGE_FAILED"]);
		expect((await w.world(s, { op: "files", repo: BASELINE }))["src/wi1.ts"]).toContain("badge"); // it did land

		await until(async () => (await item(s, "WI-1"))?.item.status === "promoted", 8000, "the poller to finalize the promotion");
		expect((await ledger(s)).filter((e) => e.type === "PromotionMerged")).toHaveLength(1);
		const after = (await get(s, "/state")).body;
		expect(after.baselineCommit).toBe(await w.world(s, { op: "head", repo: BASELINE }));
		expect((await get(s, "/ledger/verify")).body.ok).toBe(true);
	});
});

describe("registration and setup hygiene", () => {
	it("refuses to track the baseline, or a repo that is already tracked, as a fork", async () => {
		const s = await scenario({ register: false });
		const asBaseline = await post(s, "/work-items", { id: "WI-1", title: "x", forkRepo: BASELINE, dependencies: [] });
		expect([asBaseline.status, asBaseline.body.error.code]).toEqual([409, "REPO_ALREADY_TRACKED"]);
		expect((await post(s, "/work-items", { id: "WI-1", title: "x", forkRepo: WI1, dependencies: [] })).status).toBe(201);
		const twice = await post(s, "/work-items", { id: "WI-9", title: "y", forkRepo: WI1, dependencies: [] });
		expect([twice.status, twice.body.error.code]).toEqual([409, "REPO_ALREADY_TRACKED"]);
		// The baseline is still watched as the baseline.
		expect((await get(s, "/poller")).body.repos.find((r: { repo: string }) => r.repo === BASELINE).kind).toBe("baseline");
	});

	it("only a human can initialise a scenario or register work", async () => {
		const s = `n-${++n}`;
		await w.world(s, { op: "create", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V1 } });
		const asAgent = await post(s, "/init", { baselineRepo: BASELINE, policy }, key(), { "X-Delta-Principal": "agent:agent-b" });
		expect([asAgent.status, asAgent.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);
		const ok = await scenario({ register: false });
		const reg = await post(ok, "/work-items", { id: "WI-1", title: "x", forkRepo: WI1, dependencies: [] }, key(), { "X-Delta-Principal": "agent:agent-b" });
		expect([reg.status, reg.body.error.code]).toEqual([403, "FORBIDDEN_ACTOR"]);
	});

	it("reports observed:false when the cell could not read its own commit yet, and then catches up", async () => {
		const s = await scenario();
		await w.world(s, { op: "fail", method: "tree", times: 3, skip: 1 }); // let the planner's read through, fail the observation
		const res = await post(s, "/context-changes", { recordId: "notifications", facets: V2_FACETS, rationale: "opt-in" });
		expect(res.status).toBe(201);
		expect(res.body.observed).toBe(false);
		await until(async () => (await get(s, "/state")).body.records.notifications.current === 2, 15_000, "the poller to pick up the change");
	}, 30_000);
});
