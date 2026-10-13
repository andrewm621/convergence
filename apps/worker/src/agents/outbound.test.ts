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
const MODEL = "minimax/minimax-m3";

type Upstream = { url: string; method: string; headers: Headers; body: string };

let upstream: Upstream[];
let upstreamResponse: () => Response;
let waiting: Promise<unknown>[];
let admitCalls: unknown[];
let usageCalls: unknown[];
let admission: { ok: true } | { ok: false; status: 403 | 429; reason: string };
let admitThrows: boolean;
let usageFailures: number;

function env() {
	const stub = {
		admitRequest: vi.fn(async (_runId: string, req: unknown) => {
			admitCalls.push(req);
			if (admitThrows) throw new Error("DO unavailable");
			return admission;
		}),
		recordModelUsage: vi.fn(async (_runId: string, u: unknown) => {
			if (usageFailures > 0) {
				usageFailures--;
				throw new Error("DO unavailable");
			}
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
	admitThrows = false;
	usageFailures = 0;
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

	it("reserves the worst case in tokens and dollars when admitting a call", async () => {
		await gateway().fetch(call(valid));
		const req = admitCalls[0] as { kind: string; requestId: string; reserveTokens: number; reserveCostUsd: number };
		expect(req.kind).toBe("model");
		expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(req.reserveTokens).toBeGreaterThanOrEqual(1024);
		// 1024 output tokens at the model's top output rate is a floor on the reserved dollars
		expect(req.reserveCostUsd).toBeGreaterThanOrEqual((1024 * 1.2) / 1e6);
	});

	const sseOf = (chunks: string[]) => {
		const bytes = new TextEncoder().encode(chunks.join(""));
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
	const START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":1}}}\n\n';
	const DELTA = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n';
	const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

	async function settled(res: Response): Promise<{ requestId: string; input: number; output: number; cost: number }> {
		await res.text().catch(() => undefined);
		await Promise.all(waiting);
		expect(usageCalls).toHaveLength(1);
		return usageCalls[0] as never;
	}

	it("reads usage from a streamed response, passes the stream through intact and reports it under the admitted request id", async () => {
		const chunks = [START, DELTA, STOP];
		upstreamResponse = () => sseOf(chunks);
		const res = await gateway().fetch(call({ ...valid, stream: true }));
		expect(await res.clone().text()).toBe(chunks.join(""));
		const u = await settled(res);
		expect(u).toMatchObject({ input: 120, output: 55 });
		expect(u.requestId).toBe((admitCalls[0] as { requestId: string }).requestId);
		// no reported cost: priced from the table (120 in, 55 out at $0.30 / $1.20 per M)
		expect(u.cost).toBeCloseTo((120 * 0.3 + 55 * 1.2) / 1e6);
	});

	it("passes the upstream's dollar cost to the meter", async () => {
		upstreamResponse = () => Response.json({ usage: { input_tokens: 50, output_tokens: 19, cost: 1.45e-5 } });
		expect(await settled(await gateway().fetch(call(valid)))).toMatchObject({ input: 50, output: 19, cost: 1.45e-5 });
	});

	it("prices the tokens when the response reports no cost, or a NaN or zero one", async () => {
		for (const cost of [undefined, null, 0, -1]) {
			usageCalls = [];
			waiting = [];
			upstreamResponse = () => Response.json({ usage: { input_tokens: 1000, output_tokens: 100, ...(cost !== undefined ? { cost } : {}) } });
			const u = await settled(await gateway().fetch(call(valid)));
			expect(u.cost).toBeCloseTo((1000 * 0.3 + 100 * 1.2) / 1e6);
		}
	});

	// A call whose usage is unknown is charged all of its request body as input and max_tokens as output (or what was
	// seen of it before it broke off, if that is more).
	function expectWorstCase(u: { input: number; output: number; cost: number }) {
		const bodyBytes = new TextEncoder().encode(JSON.stringify(valid)).byteLength;
		expect(u.output).toBe(1024);
		expect(u.input).toBeGreaterThanOrEqual(bodyBytes);
		expect(u.cost).toBeGreaterThanOrEqual((bodyBytes * 0.3 + 1024 * 1.2) / 1e6 - 1e-12);
	}

	it("charges the worst case for an upstream error response", async () => {
		upstreamResponse = () => Response.json({ error: "bad" }, { status: 400 });
		expectWorstCase(await settled(await gateway().fetch(call(valid))));
	});

	it("charges the worst case for a non-2xx response even when it reports usage", async () => {
		upstreamResponse = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1, cost: 1e-9 } }, { status: 529 });
		expectWorstCase(await settled(await gateway().fetch(call(valid))));
	});

	it("charges the worst case when a response carries no usage", async () => {
		upstreamResponse = () => new Response("no usage here", { headers: { "content-type": "text/event-stream" } });
		expectWorstCase(await settled(await gateway().fetch(call(valid))));
	});

	it("charges the worst case when the JSON body is unparseable", async () => {
		upstreamResponse = () => new Response('{"usage":{"input_tokens":10,"output_tokens":4}', { headers: { "content-type": "application/json" } });
		expectWorstCase(await settled(await gateway().fetch(call(valid))));
	});

	it("charges the worst case for a stream that ends before its closing event", async () => {
		upstreamResponse = () => sseOf([START, DELTA]);
		expectWorstCase(await settled(await gateway().fetch(call({ ...valid, stream: true }))));
	});

	it("charges the worst case when the upstream stream fails mid-body", async () => {
		upstreamResponse = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new TextEncoder().encode(START));
						c.error(new Error("reset"));
					},
				}),
			);
		expectWorstCase(await settled(await gateway().fetch(call({ ...valid, stream: true }))));
	});

	it("charges the worst case when the container hangs up mid-stream", async () => {
		upstreamResponse = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull(c) {
						c.enqueue(new TextEncoder().encode(START));
					},
				}),
			);
		const res = await gateway().fetch(call({ ...valid, stream: true }));
		const reader = res.body!.getReader();
		await reader.read();
		await reader.cancel();
		await Promise.all(waiting);
		expect(usageCalls).toHaveLength(1);
		expectWorstCase(usageCalls[0] as never);
	});

	it("charges the worst case, and answers 502, when the upstream fetch itself fails", async () => {
		(fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
		const res = await gateway().fetch(call(valid));
		expect(res.status).toBe(502);
		await Promise.all(waiting);
		expect(usageCalls).toHaveLength(1);
		expectWorstCase(usageCalls[0] as never);
	});

	it("settles each admitted call exactly once", async () => {
		upstreamResponse = () => sseOf([START, DELTA, STOP]);
		const res = await gateway().fetch(call({ ...valid, stream: true }));
		await res.text();
		await res.body?.cancel().catch(() => undefined);
		await Promise.all(waiting);
		expect(usageCalls).toHaveLength(1);
	});

	it("retries a usage report once when the meter can't be reached", async () => {
		usageFailures = 1;
		upstreamResponse = () => Response.json({ usage: { input_tokens: 5, output_tokens: 5, cost: 0.001 } });
		expect(await settled(await gateway().fetch(call(valid)))).toMatchObject({ input: 5, output: 5 });
	});

	it("refuses and forwards nothing when the meter can't be reached", async () => {
		admitThrows = true;
		const res = await gateway().fetch(call(valid));
		expect(res.status).toBe(503);
		expect(upstream).toHaveLength(0);
	});

	it("refuses and forwards nothing when the meter doesn't know the run", async () => {
		admission = { ok: false, status: 403, reason: "unknown run" };
		const res = await gateway().fetch(call(valid));
		expect(res.status).toBe(403);
		expect(upstream).toHaveLength(0);
		expect(usageCalls).toHaveLength(0);
	});

	it("refuses a pinned model that has no price, before any DO call or upstream request", async () => {
		const unpriced = { ...props, model: "vendor/unpriced" };
		const g = new ModelGateway(ctx(unpriced) as never, env() as never);
		expect((await g.fetch(call({ ...valid, model: "vendor/unpriced" }))).status).toBe(403);
		expect(admitCalls).toHaveLength(0);
		expect(upstream).toHaveLength(0);
	});

	it.each([
		["a fallback model list", { models: ["vendor/other"] }],
		["provider routing", { provider: { order: ["x"] } }],
		["plugins", { plugins: [{ id: "web" }] }],
		["a server tool", { tools: [{ type: "web_search_20250305", name: "web_search" }] }],
		["a suffixed model", { model: `${MODEL}:online` }],
	])("refuses %s before it reaches the meter or the upstream", async (_n, extra) => {
		const res = await gateway().fetch(call({ ...valid, ...extra }));
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(admitCalls).toHaveLength(0);
		expect(upstream).toHaveLength(0);
	});

	it("forwards only whitelisted body fields and headers, to a fixed URL", async () => {
		await gateway().fetch(
			call(
				{ ...valid, stream: true, service_tier: "auto", user: "u", include_reasoning: true },
				{
					headers: {
						"content-type": "application/json",
						"anthropic-version": "2023-06-01",
						"x-api-key": "placeholder",
						authorization: "Bearer placeholder",
						cookie: "a=b",
						"http-referer": "https://x.example",
						"x-openrouter-provider": "evil",
					},
				},
				"https://openrouter.ai/api/v1/messages?beta=true",
			),
		);
		const sent = upstream[0]!;
		expect(sent.url).toBe("https://openrouter.ai/api/v1/messages");
		expect(Object.keys(JSON.parse(sent.body)).sort()).toEqual(["max_tokens", "messages", "model", "stream"]);
		expect([...sent.headers.keys()].sort()).toEqual(["anthropic-version", "authorization", "content-type"]);
		expect(sent.headers.get("authorization")).toBe(`Bearer ${KEY}`);
	});

	it("does not follow an upstream redirect", async () => {
		await gateway().fetch(call(valid));
		const init = (fetch as unknown as { mock: { calls: [Request][] } }).mock.calls[0]![0];
		expect(init.redirect).toBe("manual");
	});
});
