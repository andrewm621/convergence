import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTIFICATIONS_V1, STATUS_MODEL_V1, dependencies, policy } from "scenario-notifications";
import { TEST_MODEL_KEY, TEST_TOKEN, startWorkerd, type Workerd } from "./testing/workerd";

// The public read-only view against a real cell in workerd (real Durable Object SQLite and alarms, in-memory Artifacts):
// the allowlisted reads work without a token, every write and every other cell still needs it, and a read has no side effect.
// The poll interval is the maximum so the cell's own alarm cannot fire during a test and muddy the comparisons.

let w: Workerd;
const OPEN = "pub-open";
const SHUT = "pub-shut";
const BASELINE = "notifications-baseline";
const FORK = "notifications-wi-1";

// A title that looks like the secrets a public response must never carry. It is user data, so only the redaction layer can hide it.
const TOKEN_LIKE = "tok_v1_abcdefghijklmnopqrstuvwxyz0123?expires=1790000000";
const MODEL_KEY_LIKE = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123";
const CREDENTIAL_URL = "https://u:hunter2hunter2@h/x.git";
const ACCOUNT_HOST = "https://0123456789abcdef0123456789abcdef.artifacts.x/r";
const LEAKY_TITLE = `${TOKEN_LIKE} ${MODEL_KEY_LIKE} ${TEST_TOKEN}`;
const LEAKY_AGENT = { id: TEST_MODEL_KEY, displayName: `${CREDENTIAL_URL} ${ACCOUNT_HOST}` };

beforeAll(async () => {
	w = await startWorkerd({ pollIntervalMs: 60_000, publicRead: ` ${OPEN} ` });
	for (const s of [OPEN, SHUT]) {
		await w.world(s, { op: "create", repo: BASELINE, files: { "context/notifications.md": NOTIFICATIONS_V1, "context/status-model.md": STATUS_MODEL_V1, "AGENTS.md": "# agents\n", "src/index.ts": "export {};\n" } });
		await w.world(s, { op: "fork", base: BASELINE, repo: FORK });
		expect((await w.api("POST", `/scenarios/${s}/init`, { body: { baselineRepo: BASELINE, policy }, headers: { "Idempotency-Key": `init-${s}-key` } })).status).toBe(201);
		const registered = await w.api("POST", `/scenarios/${s}/work-items`, {
			body: { id: "WI-1", title: s === OPEN ? LEAKY_TITLE : "Status badges", ...(s === OPEN ? { agent: LEAKY_AGENT } : {}), forkRepo: FORK, requires: ["contract-test"], dependencies: dependencies.wi1.map((d) => ({ recordId: d.recordId, facetKeys: d.facetKeys })) },
			headers: { "Idempotency-Key": `wi-${s}-key` },
		});
		expect(registered.status, JSON.stringify(registered.body)).toBe(201);
	}
}, 60_000);
afterAll(async () => {
	await w?.dispose();
});

const head = async (s: string) => (await w.api("GET", `/scenarios/${s}/ledger`)).body.head as { seq: number; hash: string };

describe("public reads, allowlisted cell", () => {
	it("serves state, ledger and the gate with no token", async () => {
		const state = await w.anon("GET", `/scenarios/${OPEN}/state`);
		expect(state.status).toBe(200);
		expect(state.headers.get("X-Delta-Access")).toBe("public-read");
		expect(JSON.parse(state.text)).toMatchObject({ scenario: OPEN, workItems: [{ item: { id: "WI-1" } }] });

		const ledger = await w.anon("GET", `/scenarios/${OPEN}/ledger?limit=5`);
		expect(ledger.status).toBe(200);
		expect(JSON.parse(ledger.text).entries.length).toBeGreaterThan(0);

		const gate = await w.anon("GET", `/scenarios/${OPEN}/work-items/WI-1/gate`);
		expect(gate.status).toBe(200);
		expect(JSON.parse(gate.text)).toMatchObject({ workItemId: "WI-1" });
	});

	it("is side-effect free: no Artifacts call, no ledger line, no alarm, no poll", async () => {
		await w.cell(OPEN, "testAlarm", "clear");
		const headBefore = await head(OPEN);
		const pollerBefore = (await w.api("GET", `/scenarios/${OPEN}/poller`)).body;

		// New work lands in the baseline while the cell's alarm is cleared. If a read armed the poller or polled, the ledger would grow.
		const baselineBefore = await w.world(OPEN, { op: "head", repo: BASELINE });
		await w.world(OPEN, { op: "push", repo: BASELINE, files: { "src/new.ts": "export const n = 1;\n" } });
		expect(await w.world(OPEN, { op: "head", repo: BASELINE })).not.toEqual(baselineBefore);
		const callsBefore = (await w.world(OPEN, { op: "calls" })) as string[];

		for (let i = 0; i < 6; i++) {
			for (const path of ["/state", "/ledger", "/work-items/WI-1/gate"]) expect((await w.anon("GET", `/scenarios/${OPEN}${path}`)).status).toBe(200);
		}
		await new Promise((r) => setTimeout(r, 300));

		expect(await w.cell(OPEN, "testAlarm", "get")).toBeNull();
		expect(await head(OPEN)).toEqual(headBefore);
		expect((await w.world(OPEN, { op: "calls" })) as string[]).toEqual(callsBefore);
		expect((await w.api("GET", `/scenarios/${OPEN}/poller`)).body).toEqual(pollerBefore);
	});

	it("does not leak tokens, keys, credentialed URLs or the account id, even where user data holds them", async () => {
		const authed = JSON.stringify((await w.api("GET", `/scenarios/${OPEN}/state`)).body);
		expect(authed).toContain("hunter2hunter2"); // the title really is in the cell, so the redaction below is doing the work
		const bodies: string[] = [];
		for (const path of ["/state", "/ledger?limit=1000", "/work-items/WI-1/gate"]) {
			const res = await w.anon("GET", `/scenarios/${OPEN}${path}`);
			expect(res.status).toBe(200);
			bodies.push(res.text, JSON.stringify([...res.headers.entries()]));
		}
		const everything = bodies.join("\n");
		const forbidden: Array<[string, RegExp]> = [
			["artifacts token", /\b[a-z]+_v\d+_[A-Za-z0-9_]{24,}/],
			["token expiry suffix", /\?expires=\d+/],
			["model key", /\bsk-[A-Za-z0-9_-]{16,}/],
			["url credentials", /https?:\/\/[^/\s"@]+@/],
			["account id", /\b[0-9a-f]{32}\b/],
			["bearer secret", new RegExp(TEST_TOKEN)],
			["worker model key", new RegExp(TEST_MODEL_KEY)],
			["authorization header", /authorization/i],
		];
		for (const [name, pattern] of forbidden) expect(everything, name).not.toMatch(pattern);
	});
});

describe("public reads, everything else stays closed", () => {
	it("is 401 for a cell that is not allowlisted, on all three reads", async () => {
		for (const path of ["/state", "/ledger", "/work-items/WI-1/gate"]) expect((await w.anon("GET", `/scenarios/${SHUT}${path}`)).status, path).toBe(401);
	});

	it("is 401 for every other route of the allowlisted cell, and for an unknown route", async () => {
		const headBefore = await head(OPEN);
		const closed: Array<[string, string, unknown?]> = [
			["GET", "/poller"],
			["GET", "/dispatches"],
			["GET", "/ledger/verify"],
			["GET", "/context/notifications"],
			["GET", "/ws"],
			["POST", "/init", { baselineRepo: BASELINE, policy }],
			["POST", "/work-items", { id: "WI-9", title: "x", forkRepo: FORK }],
			["POST", "/context-changes", { recordId: "notifications", prose: "x", rationale: "x" }],
			["POST", "/work-items/WI-1/resolutions", { kind: "reject", rationale: "x" }],
			["POST", "/work-items/WI-1/dependencies", { recordId: "notifications", decision: "accept" }],
			["POST", "/work-items/WI-1/promote", { expectedBaselineCommit: "a".repeat(40), forkHeadSha: "a".repeat(40) }],
			["PUT", "/state", {}],
			["DELETE", "/state"],
			["POST", "/state", {}],
			["GET", "/nope"],
		];
		for (const [method, path, body] of closed) {
			const res = await w.anon(method, `/scenarios/${OPEN}${path}`, { body, headers: { "Idempotency-Key": "anon-key-1" } });
			expect(res.status, `${method} ${path}`).toBe(401);
		}
		for (const [method, path] of [["POST", "/smoke"], ["POST", "/smoke/seed"], ["POST", "/agents/dispatch"], ["GET", "/agents/runs/wi-1"], ["GET", `/repos/${BASELINE}/log`], ["GET", `/cell/${OPEN}`], ["GET", "/nothing-here"]] as const) {
			expect((await w.anon(method, path, { body: method === "POST" ? {} : undefined })).status, `${method} ${path}`).toBe(401);
		}
		expect(await head(OPEN)).toEqual(headBefore);
	});

	it("keeps the token working for the closed routes, and a wrong token is still refused", async () => {
		expect((await w.api("GET", `/scenarios/${OPEN}/poller`)).status).toBe(200);
		expect((await w.anon("GET", `/scenarios/${OPEN}/poller`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
	});
});
