import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGuard } from "./auth";
import { isPublicRead, parsePublicScenarios, redactPublic } from "./public-read";
import { cellApi } from "./routes";

// The allowlist logic and the guard in front of every /api route, in Node. The same guard runs against a real cell
// in workerd in public-read.workerd.test.ts.

const TOKEN = "unit-test-token";
const OPEN = "notifications-open";
const SHUT = "notifications-shut";

// `crypto.subtle.timingSafeEqual` is a Workers extension: Node has the same comparison under node:crypto.
beforeAll(() => {
	if ("timingSafeEqual" in crypto.subtle) return;
	Object.defineProperty(crypto.subtle, "timingSafeEqual", { value: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)) });
});

describe("parsePublicScenarios", () => {
	it("is empty by default, for an empty string and for whitespace and commas", () => {
		expect(parsePublicScenarios(undefined).size).toBe(0);
		expect(parsePublicScenarios("").size).toBe(0);
		expect(parsePublicScenarios(" , ,").size).toBe(0);
	});

	it("reads a comma-separated list and drops anything that is not a valid cell name", () => {
		expect([...parsePublicScenarios(" a-1 , b2,Bad_Name,*,../x,,a-1")]).toEqual(["a-1", "b2"]);
	});
});

describe("isPublicRead", () => {
	const allowed = parsePublicScenarios(OPEN);

	it("opens exactly four GET routes of an allowlisted cell", () => {
		for (const path of [`/api/scenarios/${OPEN}/state`, `/api/scenarios/${OPEN}/ledger`, `/api/scenarios/${OPEN}/ledger/verify`, `/api/scenarios/${OPEN}/work-items/WI-1/gate`]) {
			expect(isPublicRead("GET", path, allowed), path).toBe(true);
		}
	});

	it("opens nothing with an empty allowlist", () => {
		expect(isPublicRead("GET", `/api/scenarios/${OPEN}/state`, parsePublicScenarios(""))).toBe(false);
	});

	it("refuses other cells, other methods and every other route", () => {
		expect(isPublicRead("GET", `/api/scenarios/${SHUT}/state`, allowed)).toBe(false);
		expect(isPublicRead("GET", `/api/scenarios/${OPEN}x/state`, allowed)).toBe(false);
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) expect(isPublicRead(method, `/api/scenarios/${OPEN}/state`, allowed), method).toBe(false);
		for (const rest of ["/poller", "/dispatches", "/ws", "/context/notifications", "/init", "/work-items", "/context-changes", "/work-items/WI-1/promote", "/work-items/WI-1/resolutions", "/work-items/WI-1", "/work-items/WI-1/gate/x"]) {
			expect(isPublicRead("GET", `/api/scenarios/${OPEN}${rest}`, allowed), rest).toBe(false);
		}
	});

	it("refuses path tricks: trailing slash, dot segments, encoding, a second slash, a query smuggled into the path", () => {
		for (const path of [`/api/scenarios/${OPEN}/state/`, `/api/scenarios/${OPEN}/../${SHUT}/state`, `/api/scenarios/%6eotifications-open/state`, `//api/scenarios/${OPEN}/state`, `/api/scenarios/${OPEN}//state`, `/api/scenarios/${OPEN}/state%2f..`, `/api/scenarios/${OPEN}/work-items/../gate`, `/API/scenarios/${OPEN}/state`]) {
			expect(isPublicRead("GET", path, allowed), path).toBe(false);
		}
	});
});

describe("redactPublic", () => {
	it("removes artifacts tokens, URL credentials, account hosts, model keys and the Worker's own secrets", () => {
		const text = JSON.stringify({
			a: "tok_v1_abcdefghijklmnopqrstuvwxyz0123?expires=1790000000",
			b: "https://x:secretpw@repo.example/git",
			c: "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/r.git",
			d: "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
			e: `bearer ${TOKEN}`,
		});
		const out = redactPublic(text, [TOKEN]);
		for (const needle of ["abcdefghijklmnopqrstuvwxyz0123", "secretpw", "0123456789abcdef0123456789abcdef", "sk-or-v1", TOKEN]) expect(out).not.toContain(needle);
	});

	it("leaves ordinary ledger content alone, hashes and commit shas included", () => {
		const text = JSON.stringify({ hash: "a".repeat(64), sha: "b".repeat(40), note: "Make notifications opt-in" });
		expect(redactPublic(text, [TOKEN])).toBe(text);
	});
});

// A cell stub that records every call, so "401 before the cell is touched" is something the test can see.
function cellRecorder() {
	const calls: string[] = [];
	const stub = new Proxy({}, { get: (_t, method) => (...args: unknown[]) => {
		calls.push(String(method));
		void args;
		return Promise.resolve({ status: 200, body: { ok: true, token: TOKEN, key: "sk-or-v1-abcdefghijklmnopqrstuvwxyz" }, headers: {} });
	} });
	return { calls, env: { DEV_TOKEN: TOKEN, WORKSPACE_CELL: { getByName: () => stub } } };
}

function appWith(env: Record<string, unknown>) {
	const app = new Hono<{ Bindings: Record<string, unknown> }>();
	app.use("/api/*", apiGuard);
	app.route("/api", cellApi);
	// Stands in for every route index.ts mounts itself (smoke, agents, repos, cell): reaching it means the guard let the request in.
	app.all("*", (c) => c.json({ reached: true }));
	return { request: (method: string, path: string, init: RequestInit = {}) => app.request(path, { method, ...init }, env) };
}

/** Every method + path the cell API registers (middleware entries aside), with params filled in. */
function cellRoutes(cell: string) {
	const all = cellApi.routes
		.filter((r) => r.method !== "ALL")
		.map((r) => ({ method: r.method, path: `/api${r.path}`.replace(":scenario", cell).replace(":id", "WI-1").replace(":recordId", "notifications") }));
	// A route with a body-limit middleware is registered once per handler.
	return [...new Map(all.map((r) => [`${r.method} ${r.path}`, r])).values()];
}

const INDEX_ROUTES: Array<[string, string]> = [
	["POST", "/api/smoke"],
	["DELETE", "/api/smoke"],
	["POST", "/api/smoke/seed"],
	["POST", "/api/smoke/pointer-fork"],
	["POST", "/api/smoke/pointer-push"],
	["POST", "/api/agents/dispatch"],
	["GET", "/api/agents/runs/wi-1"],
	["GET", "/api/repos/some-repo/log"],
	["GET", "/api/repos/some-repo/file?path=a.md"],
	["GET", `/api/cell/${OPEN}`],
];

describe("apiGuard", () => {
	it("with PUBLIC_READ_SCENARIOS unset or empty, every route is 401 without the token and nothing reaches a cell", async () => {
		for (const publicRead of [undefined, ""]) {
			const { calls, env } = cellRecorder();
			const { request } = appWith({ ...env, ...(publicRead === undefined ? {} : { PUBLIC_READ_SCENARIOS: publicRead }) });
			for (const route of [...cellRoutes(OPEN), ...INDEX_ROUTES.map(([method, path]) => ({ method, path })), { method: "GET", path: "/api/nope" }]) {
				const res = await request(route.method, route.path);
				expect(res.status, `${route.method} ${route.path}`).toBe(401);
			}
			expect(calls).toEqual([]);
		}
	});

	it("registers the routes this suite expects, so a new route cannot slip past the table above", () => {
		expect(cellRoutes("c").map((r) => `${r.method} ${r.path}`).sort()).toEqual(
			[
				"GET /api/scenarios/c/context/notifications",
				"GET /api/scenarios/c/dispatches",
				"GET /api/scenarios/c/ledger",
				"GET /api/scenarios/c/ledger/verify",
				"GET /api/scenarios/c/poller",
				"GET /api/scenarios/c/state",
				"GET /api/scenarios/c/work-items/WI-1/gate",
				"GET /api/scenarios/c/ws",
				"POST /api/scenarios/c/context-changes",
				"POST /api/scenarios/c/init",
				"POST /api/scenarios/c/work-items",
				"POST /api/scenarios/c/work-items/WI-1/dependencies",
				"POST /api/scenarios/c/work-items/WI-1/promote",
				"POST /api/scenarios/c/work-items/WI-1/resolutions",
			].sort(),
		);
	});

	it("with a cell allowlisted, exactly the four reads pass for it; every other route and every other cell is 401 and untouched", async () => {
		const { calls, env } = cellRecorder();
		const { request } = appWith({ ...env, PUBLIC_READ_SCENARIOS: OPEN });
		const passed: string[] = [];
		for (const route of [...cellRoutes(OPEN), ...cellRoutes(SHUT), ...INDEX_ROUTES.map(([method, path]) => ({ method, path })), { method: "GET", path: "/api/nope" }]) {
			const res = await request(route.method, route.path);
			if (res.status !== 401) passed.push(`${route.method} ${route.path}`);
		}
		expect(passed.sort()).toEqual(
			[
				`GET /api/scenarios/${OPEN}/ledger`,
				`GET /api/scenarios/${OPEN}/ledger/verify`,
				`GET /api/scenarios/${OPEN}/state`,
				`GET /api/scenarios/${OPEN}/work-items/WI-1/gate`,
			].sort(),
		);
		expect(calls.sort()).toEqual(["gate", "ledger", "snapshot", "verifyLedger"]);
	});

	it("a wrong token does not widen anything: 401 on a closed route, the public answer on an open one", async () => {
		const { env } = cellRecorder();
		const { request } = appWith({ ...env, PUBLIC_READ_SCENARIOS: OPEN });
		const bad = { headers: { Authorization: "Bearer wrong" } };
		expect((await request("POST", `/api/scenarios/${OPEN}/init`, bad)).status).toBe(401);
		expect((await request("GET", `/api/scenarios/${SHUT}/state`, bad)).status).toBe(401);
		expect((await request("GET", `/api/scenarios/${OPEN}/state`, bad)).status).toBe(200);
	});

	it("a WebSocket upgrade with no token is 401 even for an allowlisted cell", async () => {
		const { calls, env } = cellRecorder();
		const { request } = appWith({ ...env, PUBLIC_READ_SCENARIOS: OPEN });
		const res = await request("GET", `/api/scenarios/${OPEN}/ws`, { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "delta.v1.public" } });
		expect(res.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it("a token holder is untouched: the response is not rewritten or marked public", async () => {
		const { env } = cellRecorder();
		const { request } = appWith({ ...env, PUBLIC_READ_SCENARIOS: OPEN });
		const res = await request("GET", `/api/scenarios/${OPEN}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } });
		expect(res.status).toBe(200);
		expect(res.headers.get("X-Delta-Access")).toBeNull();
		expect(await res.text()).toContain(TOKEN);
	});

	it("marks and redacts a public response", async () => {
		const { env } = cellRecorder();
		const { request } = appWith({ ...env, PUBLIC_READ_SCENARIOS: OPEN, OPENROUTER_API_KEY: "model-key-fixture-0123456789" });
		const res = await request("GET", `/api/scenarios/${OPEN}/state`);
		const text = await res.text();
		expect(res.headers.get("X-Delta-Access")).toBe("public-read");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain("sk-or-v1");
	});
});
