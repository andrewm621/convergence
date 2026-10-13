import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gateways extend WorkerEntrypoint from the Workers runtime; stand in for it so they can run under Node.
vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));

import { ArtifactsGateway, ModelGateway } from "./outbound";

const HOST = "acct.artifacts.cloudflare.net";
const REPO = "/git/default/wi-1.git";
const SECRET = ["art", "v2", "x"].join("_") + "_" + "A1b2C3d4E5".repeat(4);
const KEY = "test-openrouter-key-0123456789";
const MODEL = "vendor/model-a";

type Upstream = { url: string; method: string; headers: Headers; body: string };

let upstream: Upstream[];
let upstreamResponse: () => Response;
let waiting: Promise<unknown>[];
let admitCalls: unknown[];
let usageCalls: unknown[];
let admission: { ok: true } | { ok: false; status: 403 | 429; reason: string };

function env() {
	const stub = {
		admitRequest: vi.fn(async (_runId: string, req: unknown) => {
			admitCalls.push(req);
			return admission;
		}),
		recordModelUsage: vi.fn(async (_runId: string, u: unknown) => {
			usageCalls.push(u);
		}),
	};
	return { OPENROUTER_API_KEY: KEY, AGENT_SANDBOX: { getByName: () => stub } };
}

const ctx = <P>(props: P) => ({ props, waitUntil: (p: Promise<unknown>) => waiting.push(p) });

beforeEach(() => {
	upstream = [];
	waiting = [];
	admitCalls = [];
	usageCalls = [];
	admission = { ok: true };
	upstreamResponse = () => new Response("ok");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Request) => {
			upstream.push({ url: input.url, method: input.method, headers: new Headers(input.headers), body: await input.text() });
			return upstreamResponse();
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("ArtifactsGateway", () => {
	const props = { host: HOST, repoPath: REPO, secret: SECRET, workItemId: "wi-1", runId: "run-1" };
	const gateway = () => new ArtifactsGateway(ctx(props) as never, env() as never);
	const good = () => new Request(`https://${HOST}${REPO}/git-receive-pack`, { method: "POST", body: "PACK" });

	it("adds the token for an exact smart-HTTP request and forwards it without following redirects", async () => {
		const res = await gateway().fetch(good());
		expect(res.status).toBe(200);
		expect(upstream).toHaveLength(1);
		expect(upstream[0]?.headers.get("authorization")).toBe(`Basic ${btoa(`x:${SECRET}`)}`);
		expect(upstream[0]?.body).toBe("PACK");
	});

	it("never forwards or injects anything for a non-canonical or foreign request", async () => {
		const bad = [
			new Request(`https://${HOST}${REPO}/git-receive-pack?x=1`, { method: "POST" }),
			new Request(`https://${HOST}/git/default/wi-2.git/git-receive-pack`, { method: "POST" }),
			new Request(`https://${HOST}${REPO}/info/refs?service=git-upload-pack`, { method: "POST" }),
			new Request(`https://evil.example${REPO}/git-receive-pack`, { method: "POST" }),
		];
		for (const req of bad) expect((await gateway().fetch(req)).status).toBe(403);
		expect(upstream).toHaveLength(0);
		expect(admitCalls).toHaveLength(0);
	});

	it("429s without forwarding once the run's git request cap is spent", async () => {
		admission = { ok: false, status: 429, reason: "git request cap" };
		const res = await gateway().fetch(good());
		expect(res.status).toBe(429);
		expect(upstream).toHaveLength(0);
	});

	it("refuses a request whose declared body is over the size cap, before admitting it", async () => {
		const big = new Request(`https://${HOST}${REPO}/git-receive-pack`, { method: "POST", body: "x", headers: { "content-length": String(200 * 1024 * 1024) } });
		expect((await gateway().fetch(big)).status).toBe(413);
		expect(upstream).toHaveLength(0);
	});

	it("does not let the container's own Authorization header through", async () => {
		const req = new Request(`https://${HOST}${REPO}/git-upload-pack`, { method: "POST", body: "x", headers: { authorization: "Bearer attacker" } });
		await gateway().fetch(req);
		expect(upstream[0]?.headers.get("authorization")).toBe(`Basic ${btoa(`x:${SECRET}`)}`);
	});
});

describe("ModelGateway", () => {
	const props = { model: MODEL, workItemId: "wi-2", runId: "run-1", maxOutputTokens: 8192 };
	const gateway = () => new ModelGateway(ctx(props) as never, env() as never);
	const call = (body: object | string, init: RequestInit = {}, url = "https://openrouter.ai/api/v1/messages") =>
		new Request(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...init });
	const valid = { model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] };

	it("adds the key for an exact Messages call with the pinned model and drops the placeholder", async () => {
		const res = await gateway().fetch(call(valid, { headers: { "x-api-key": "placeholder", authorization: "Bearer placeholder" } }));
		expect(res.status).toBe(200);
		expect(upstream[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(upstream[0]?.headers.get("x-api-key")).toBeNull();
	});

	it("rejects other models, a missing model and a bad max_tokens, forwarding nothing", async () => {
		expect((await gateway().fetch(call({ ...valid, model: "vendor/other" }))).status).toBe(403);
		expect((await gateway().fetch(call({ max_tokens: 5 }))).status).toBe(403);
		expect((await gateway().fetch(call({ model: MODEL }))).status).toBe(400);
		expect((await gateway().fetch(call("not json"))).status).toBe(400);
		expect(upstream).toHaveLength(0);
	});

	it("refuses non-canonical URLs and other endpoints without a key or a DO call", async () => {
		for (const url of ["https://openrouter.ai/api/v1/messages?x=1", "https://openrouter.ai/api/v1/models", "https://openrouter.ai//api/v1/messages", "https://openrouter.ai:8443/api/v1/messages"]) {
			expect((await gateway().fetch(call(valid, {}, url))).status).toBe(403);
		}
		expect((await gateway().fetch(new Request("https://openrouter.ai/api/v1/messages", { method: "GET" }))).status).toBe(403);
		expect(upstream).toHaveLength(0);
		expect(admitCalls).toHaveLength(0);
	});

	it("clamps max_tokens above the ceiling before forwarding", async () => {
		await gateway().fetch(call({ ...valid, max_tokens: 64_000 }));
		expect(JSON.parse(upstream[0]!.body).max_tokens).toBe(8192);
	});

	it("rejects a body over the size cap", async () => {
		const big = call(valid, { headers: { "content-length": String(50 * 1024 * 1024) } });
		expect((await gateway().fetch(big)).status).toBe(413);
		expect(upstream).toHaveLength(0);
	});

	it("429s every call once the run's budget is spent, and never reaches the upstream", async () => {
		admission = { ok: false, status: 429, reason: "token ceiling" };
		const res = await gateway().fetch(call(valid));
		expect(res.status).toBe(429);
		expect(await res.text()).toContain("token ceiling");
		expect(upstream).toHaveLength(0);
	});

	it("reserves the worst case when admitting a call", async () => {
		await gateway().fetch(call(valid));
		const req = admitCalls[0] as { kind: string; reserve: number };
		expect(req.kind).toBe("model");
		expect(req.reserve).toBeGreaterThanOrEqual(1024);
	});

	it("reads usage from a streamed response, passes the stream through intact and reports it", async () => {
		const sse =
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":1}}}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n';
		upstreamResponse = () => {
			const bytes = new TextEncoder().encode(sse);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						for (let i = 0; i < bytes.length; i += 9) c.enqueue(bytes.slice(i, i + 9));
						c.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		};
		const res = await gateway().fetch(call({ ...valid, stream: true }));
		expect(await res.text()).toBe(sse);
		await Promise.all(waiting);
		expect(usageCalls).toHaveLength(1);
		expect(usageCalls[0]).toMatchObject({ input: 120, output: 55 });
		expect((usageCalls[0] as { reserved: number }).reserved).toBeGreaterThan(0);
	});

	it("passes the upstream's dollar cost to the meter", async () => {
		upstreamResponse = () => Response.json({ usage: { input_tokens: 50, output_tokens: 19, cost: 1.45e-5 } });
		const res = await gateway().fetch(call(valid));
		await res.text();
		await Promise.all(waiting);
		expect(usageCalls[0]).toMatchObject({ input: 50, output: 19, cost: 1.45e-5 });
	});

	it("does not charge an upstream error response", async () => {
		upstreamResponse = () => Response.json({ error: "bad" }, { status: 400 });
		const res = await gateway().fetch(call(valid));
		await res.text();
		await Promise.all(waiting);
		expect(usageCalls[0]).toMatchObject({ input: 0, output: 0 });
	});

	it("reads usage from a plain JSON response", async () => {
		upstreamResponse = () => Response.json({ usage: { input_tokens: 10, output_tokens: 4 } });
		const res = await gateway().fetch(call(valid));
		await res.text();
		await Promise.all(waiting);
		expect(usageCalls[0]).toMatchObject({ input: 10, output: 4 });
	});

	it("counts conservatively (worst case) when a response carries no usage", async () => {
		upstreamResponse = () => new Response("no usage here", { headers: { "content-type": "text/event-stream" } });
		const res = await gateway().fetch(call(valid));
		await res.text();
		await Promise.all(waiting);
		expect(usageCalls[0]).toMatchObject({ output: 1024 });
		expect((usageCalls[0] as { input: number }).input).toBeGreaterThan(0);
	});

	it("does not follow an upstream redirect", async () => {
		await gateway().fetch(call(valid));
		const init = (fetch as unknown as { mock: { calls: [Request][] } }).mock.calls[0]![0];
		expect(init.redirect).toBe("manual");
	});
});
