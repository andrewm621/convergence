import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPointerSeed } from "../smoke-build";
import { HUMAN_RESOLVED_TEXT, NOT_PROMOTABLE_MESSAGE, isPointerScenario } from "./pointer-scenario";
import { startWorkerd, type Workerd } from "./testing/workerd";

// Convergence governing its own build (docs/dogfooding.md). The cell's work items are pointers to real work:
// a revalidation is recorded and dispatches nothing, even when the Worker has an agent runtime, and nothing promotes.

let w: Workerd;
let n = 0;

beforeAll(async () => {
	w = await startWorkerd({ pollIntervalMs: 150 });
}, 60_000);
afterAll(async () => {
	await w?.dispose();
});

const BASELINE = "build-baseline";
let keys = 0;
const key = (label = "k") => `${label}-${++keys}-pointer-key`;
const post = (s: string, path: string, body: unknown, k = key()) => w.api("POST", `/scenarios/${s}${path}`, { body, headers: { "Idempotency-Key": k } });
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

type Wi = { item: { id: string; status: string }; headSha: string | null; conditions: Array<{ type: string }> };
const items = async (s: string) => (await get(s, "/state")).body.workItems as Wi[];
const staleIds = async (s: string) => (await items(s)).filter((wi) => wi.conditions.some((c) => c.type === "Stale")).map((wi) => wi.item.id);

/** The cell named `name`, seeded as `dogfood.mjs seed` does: the seed's repos, init with its policy, its work items registered. */
async function seeded(name: string) {
	const seed = buildPointerSeed();
	await w.world(name, { op: "create", repo: BASELINE, files: seed.baselineFiles });
	for (const item of seed.workItems) {
		await w.world(name, { op: "fork", base: BASELINE, repo: `build-${item.id.toLowerCase()}` });
		await w.world(name, { op: "push", repo: `build-${item.id.toLowerCase()}`, files: item.forkFiles, author: "pointer" });
	}
	expect((await post(name, "/init", { baselineRepo: BASELINE, policy: seed.policy })).status).toBe(201);
	for (const item of seed.workItems) {
		const res = await post(name, "/work-items", { id: item.id, title: item.title, forkRepo: `build-${item.id.toLowerCase()}`, agent: item.agent, requires: item.requires, dependencies: item.dependencies });
		expect(res.status, item.id).toBe(201);
	}
	await w.cell(name, "pollNow");
	return seed;
}

/** The record a resolution must bind to, as the cell holds it now. */
async function bindingFor(s: string, id: string, recordId: string) {
	const state = (await get(s, "/state")).body;
	const history = state.records[recordId];
	const record = history.versions[String(history.current)];
	const wi = (await items(s)).find((x) => x.item.id === id) as Wi;
	return { recordId, version: record.version, blobHash: record.blobHash, baseSha: state.baselineCommit, forkHeadSha: wi.headSha, contextSnapshotHash: state.snapshotHash };
}

describe("a cell of our own build (pointer work items)", () => {
	it("recognises its scenario by name", () => {
		expect(isPointerScenario("delta-convergence-build")).toBe(true);
		expect(isPointerScenario("delta-convergence-build-live")).toBe(true);
		for (const other of [null, "notifications", "notifications-demo", "delta-convergence-builder", "my-delta-convergence-build"]) expect(isPointerScenario(other), String(other)).toBe(false);
	});

	it("starts at the end state: six records, seven work items, all fresh at the latest versions", async () => {
		const s = `delta-convergence-build-t${++n}`;
		await seeded(s);
		const state = (await get(s, "/state")).body;
		expect(Object.keys(state.records).sort()).toEqual(["demo-identity", "evidence-policy", "positioning", "product-naming", "scenario-naming", "scenario-plan"]);
		expect(state.records["evidence-policy"].current).toBe(3);
		expect(state.records["scenario-naming"].current).toBe(2);
		expect(state.workItems.map((wi: Wi) => wi.item.id)).toEqual(["WI-1", "WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"]);
		// Every pointer push was read: a head each, claims at the latest versions, nothing stale or conflicting.
		expect(state.workItems.every((wi: Wi) => wi.headSha !== null)).toBe(true);
		expect(await staleIds(s)).toEqual([]);
		for (const wi of state.workItems) expect(wi.claims.status, wi.item.id).toBe("ok");
	}, 30_000);

	it("a decision makes exactly the work that relied on it stale; a revalidation is recorded and dispatches nothing", async () => {
		const s = `delta-convergence-build-t${++n}`;
		await seeded(s);
		// The Worker has an agent runtime here: it must still not be used.
		await w.world(s, { op: "agent", behavior: {} });

		const change = await post(s, "/context-changes", { recordId: "scenario-naming", facets: { "scenario.county": "Elmsworth County", "scenario.network": "Larkhaven Mutual Aid Network" }, rationale: "Rename the fictional county again." });
		expect(change.status).toBe(201);
		await until(async () => ((await staleIds(s)).length > 0 ? true : false), 8000, "the stale items");
		expect(await staleIds(s)).toEqual(["WI-3", "WI-4", "WI-5"]);

		const socket = await w.openSocket(s);
		const binding = await bindingFor(s, "WI-4", "scenario-naming");
		const res = await post(s, "/work-items/WI-4/resolutions", { kind: "revalidate", rationale: "Redoing the fixtures in the real PR.", binding });
		expect(res.status).toBe(200);
		expect(res.body.effects.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["REQUEST_REVALIDATION", "DISPATCH_WORK"]));

		// Recorded, announced as a human's job, and never handed to a runtime.
		const said = await socket.waitFor((f) => f.type === "agent-activity" && f.text.startsWith(HUMAN_RESOLVED_TEXT));
		expect(said.text).toContain("scenario-naming v2 to v3");
		socket.close();
		await new Promise((r) => setTimeout(r, 600)); // several alarm ticks
		expect(await w.world(s, { op: "agentCalls" })).toHaveLength(0);
		expect((await get(s, "/dispatches")).body).toMatchObject({ runtime: false, jobs: [] });
		const ledger = (await get(s, "/ledger?limit=1000")).body.entries as Array<{ type: string }>;
		expect(ledger.some((e) => e.type === "ResolutionRecorded")).toBe(true);
		expect(ledger.some((e) => e.type === "ReceiptIssued" || e.type === "AgentRunStarted")).toBe(false);
		expect((await items(s)).find((wi) => wi.item.id === "WI-4")?.item.status).toBe("revalidating");
	}, 40_000);

	it("a pointer's next push (the real work done) ends the revalidation", async () => {
		const s = `delta-convergence-build-t${++n}`;
		const seed = await seeded(s);
		await post(s, "/context-changes", { recordId: "scenario-naming", facets: { "scenario.county": "Elmsworth County", "scenario.network": "Larkhaven Mutual Aid Network" }, rationale: "Rename the fictional county again." });
		await until(async () => ((await staleIds(s)).includes("WI-4") ? true : false), 8000, "WI-4 stale");
		await post(s, "/work-items/WI-4/resolutions", { kind: "revalidate", rationale: "Redoing the fixtures in the real PR.", binding: await bindingFor(s, "WI-4", "scenario-naming") });
		const claims = JSON.parse(seed.workItems[3]?.forkFiles[".delta/claims.json"] ?? "[]").map((c: { subject: string; value: string; basedOn: string }) => ({ ...c, value: "Elmsworth County", basedOn: "scenario-naming@3" }));
		await w.world(s, { op: "push", repo: "build-wi-4", files: { ".delta/claims.json": JSON.stringify(claims) }, author: "pointer" });
		await w.cell(s, "pollNow");
		const wi4 = (await items(s)).find((wi) => wi.item.id === "WI-4") as Wi;
		expect(wi4.item.status).not.toBe("revalidating");
		expect(wi4.conditions.some((c) => c.type === "Stale")).toBe(false);
	}, 40_000);

	it("promote is refused with a clear message, and nothing is merged", async () => {
		const s = `delta-convergence-build-t${++n}`;
		await seeded(s);
		const state = (await get(s, "/state")).body;
		const wi1 = (await items(s)).find((wi) => wi.item.id === "WI-1") as Wi;
		const promote = await post(s, "/work-items/WI-1/promote", { expectedBaselineCommit: state.baselineCommit, forkHeadSha: wi1.headSha });
		expect(promote.status).toBe(409);
		expect(promote.body).toEqual({ error: { code: "NOT_PROMOTABLE", message: NOT_PROMOTABLE_MESSAGE }, promoted: false });
		expect(NOT_PROMOTABLE_MESSAGE).toBe("not promotable: work items here are pointers to real PRs");
		const ledger = (await get(s, "/ledger?limit=1000")).body.entries as Array<{ type: string }>;
		expect(ledger.some((e) => e.type === "PromotionRequested" || e.type === "PromotionMerged")).toBe(false);
		expect((await items(s)).find((wi) => wi.item.id === "WI-1")?.item.status).not.toBe("promoted");
	}, 30_000);
});
