import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIMITS,
	UsageTracker,
	admit,
	allowGitCredential,
	allowModelCredential,
	canonicalUrl,
	deactivate,
	limitStream,
	newMeter,
	prepareModelBody,
	recordUsage,
} from "./gateway-logic";

const HOST = "acct.artifacts.cloudflare.net";
const REPO = "/git/default/wi-1.git";
const git = (method: string, rawUrl: string) => allowGitCredential(method, rawUrl, HOST, REPO);
const model = (method: string, rawUrl: string) => allowModelCredential(method, rawUrl);

describe("canonicalUrl", () => {
	it("returns the URL only when the raw string is already in canonical form", () => {
		expect(canonicalUrl("https://openrouter.ai/api/v1/messages")?.pathname).toBe("/api/v1/messages");
		for (const raw of ["", "not a url", "https://", "HTTPS://openrouter.ai/api", "https://OPENROUTER.ai/api", "https://openrouter.ai:443/api", "https://openrouter.ai/a/../b"]) {
			expect(canonicalUrl(raw)).toBeNull();
		}
	});
});

describe("Artifacts credential allowlist: one canonical form", () => {
	const ok = `https://${HOST}${REPO}`;

	it.each([
		["GET", `${ok}/info/refs?service=git-upload-pack`],
		["GET", `${ok}/info/refs?service=git-receive-pack`],
		["POST", `${ok}/git-upload-pack`],
		["POST", `${ok}/git-receive-pack`],
	])("allows %s %s", (method, url) => {
		expect(git(method, url)).toBe(true);
	});

	it.each([
		// method mismatches
		["POST", `${ok}/info/refs?service=git-upload-pack`],
		["GET", `${ok}/git-upload-pack`],
		["GET", `${ok}/git-receive-pack`],
		["PUT", `${ok}/git-receive-pack`],
		["DELETE", `${ok}/git-receive-pack`],
		["PATCH", `${ok}/git-upload-pack`],
		["HEAD", `${ok}/info/refs?service=git-upload-pack`],
		["OPTIONS", `${ok}/git-upload-pack`],
		["post", `${ok}/git-upload-pack`],
		// query strings: exact where one is required, none elsewhere
		["GET", `${ok}/info/refs`],
		["GET", `${ok}/info/refs?`],
		["GET", `${ok}/info/refs?service=other`],
		["GET", `${ok}/info/refs?service=git-upload-pack&x=1`],
		["GET", `${ok}/info/refs?x=1&service=git-upload-pack`],
		["GET", `${ok}/info/refs?service=git-upload-pack&service=git-receive-pack`],
		["POST", `${ok}/git-upload-pack?x=1`],
		["POST", `${ok}/git-receive-pack?`],
		// fragments
		["GET", `${ok}/info/refs?service=git-upload-pack#frag`],
		["POST", `${ok}/git-upload-pack#`],
		// percent-encoding: separators, dots, backslashes, and plain letters
		["POST", `https://${HOST}/git/default/wi-1.git/%2e%2e/wi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git/default/wi-1.git/%2E%2E/wi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git/default%2fwi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git/default%2Fwi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git/default%5cwi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git/default/wi%2d1.git/git-upload-pack`],
		["POST", `${ok}/git%2dupload-pack`],
		["POST", `${ok}%2fgit-upload-pack`],
		// backslashes
		["POST", `https://${HOST}/git\\default\\wi-1.git\\git-upload-pack`],
		["POST", `https://${HOST}${REPO}\\git-upload-pack`],
		["POST", `https:\\\\${HOST}${REPO}/git-upload-pack`],
		// double slashes and dot segments
		["POST", `https://${HOST}//git/default/wi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git//default/wi-1.git/git-upload-pack`],
		["POST", `${ok}//git-upload-pack`],
		["POST", `${ok}/./git-upload-pack`],
		["POST", `https://${HOST}/git/default/../default/wi-1.git/git-upload-pack`],
		["POST", `https://${HOST}/git/default/wi-2.git/../wi-1.git/git-upload-pack`],
		// a different or longer path
		["POST", `https://${HOST}/git/default/wi-2.git/git-upload-pack`],
		["POST", `${ok}x/git-upload-pack`],
		["POST", `${ok}/git-upload-pack/`],
		["POST", `${ok}/git-upload-pack/extra`],
		["POST", `https://${HOST}${REPO.toUpperCase()}/git-upload-pack`],
		// host variants
		["POST", `https://ACCT.artifacts.cloudflare.net${REPO}/git-upload-pack`],
		["POST", `https://${HOST}.${REPO}/git-upload-pack`],
		["POST", `https://${HOST}.${REPO.slice(1)}/git-upload-pack`.replace(".git", ".git")],
		["POST", `https://x.${HOST}${REPO}/git-upload-pack`],
		["POST", `https://${HOST}.evil.example${REPO}/git-upload-pack`],
		["POST", `https://evil.example${REPO}/git-upload-pack`],
		["POST", `https://acct.artifacts.cloudflare。net${REPO}/git-upload-pack`],
		["POST", `https://acct.artifacts.cloudflare.net％2f${REPO}/git-upload-pack`],
		["POST", `https://аcct.artifacts.cloudflare.net${REPO}/git-upload-pack`],
		["POST", `https://xn--cct-7cd.artifacts.cloudflare.net${REPO}/git-upload-pack`],
		// userinfo
		["POST", `https://u:p@${HOST}${REPO}/git-upload-pack`],
		["POST", `https://u@${HOST}${REPO}/git-upload-pack`],
		["POST", `https://evil.example@${HOST}${REPO}/git-upload-pack`],
		["POST", `https://${HOST}@evil.example${REPO}/git-upload-pack`],
		// ports, including the explicit default
		["POST", `https://${HOST}:443${REPO}/git-upload-pack`],
		["POST", `https://${HOST}:8443${REPO}/git-upload-pack`],
		["POST", `https://${HOST}:80${REPO}/git-upload-pack`],
		// scheme
		["POST", `http://${HOST}${REPO}/git-upload-pack`],
		["POST", `HTTPS://${HOST}${REPO}/git-upload-pack`],
		["POST", `ftp://${HOST}${REPO}/git-upload-pack`],
		// whitespace, control characters, garbage
		["POST", `${ok}/git-upload-pack `],
		["POST", ` ${ok}/git-upload-pack`],
		["POST", `${ok}/git-upload-pack\n`],
		["POST", `${ok}/git-upload-pack\t`],
		["POST", `${ok}/git-upload-pack\u0000`],
		["POST", ""],
		["POST", "not a url"],
		["POST", `/git/default/wi-1.git/git-upload-pack`],
	])("refuses %s %j", (method, url) => {
		expect(git(method, url)).toBe(false);
	});

	it("refuses a host that is not lowercase ASCII without a trailing dot, even when it is the configured one", () => {
		expect(allowGitCredential("POST", `https://Acct.artifacts.cloudflare.net${REPO}/git-upload-pack`, "Acct.artifacts.cloudflare.net", REPO)).toBe(false);
		expect(allowGitCredential("POST", `https://${HOST}.${REPO}/git-upload-pack`, `${HOST}.`, REPO)).toBe(false);
	});
});

describe("model credential allowlist: one canonical form", () => {
	const ok = "https://openrouter.ai/api/v1/messages";

	it.each([
		["POST", ok],
		["POST", `${ok}?beta=true`],
	])("allows %s %s", (method, url) => {
		expect(model(method, url)).toBe(true);
	});

	it.each([
		["GET", ok],
		["PUT", ok],
		["DELETE", ok],
		["HEAD", ok],
		["post", ok],
		["POST", `${ok}?beta=false`],
		["POST", `${ok}?beta=true&x=1`],
		["POST", `${ok}?x=1`],
		["POST", `${ok}?`],
		["POST", `${ok}#frag`],
		["POST", `${ok}/`],
		["POST", `${ok}/count_tokens`],
		["POST", "https://openrouter.ai/api/v1/models"],
		["POST", "https://openrouter.ai/api/v1/chat/completions"],
		["POST", "https://openrouter.ai/api/v1/credits"],
		["POST", "https://openrouter.ai/API/v1/messages"],
		["POST", "https://openrouter.ai//api/v1/messages"],
		["POST", "https://openrouter.ai/api//v1/messages"],
		["POST", "https://openrouter.ai/api/v1//messages"],
		["POST", "https://openrouter.ai/api/v1/%6dessages"],
		["POST", "https://openrouter.ai/api/v1%2fmessages"],
		["POST", "https://openrouter.ai/api%2fv1/messages"],
		["POST", "https://openrouter.ai/api/%2e%2e/api/v1/messages"],
		["POST", "https://openrouter.ai/api/v1/x/../messages"],
		["POST", "https://openrouter.ai/api\\v1\\messages"],
		["POST", "https://openrouter.ai\\api/v1/messages"],
		["POST", "https://OPENROUTER.AI/api/v1/messages"],
		["POST", "https://openrouter.ai./api/v1/messages"],
		["POST", "https://openrouter.ai:443/api/v1/messages"],
		["POST", "https://openrouter.ai:8443/api/v1/messages"],
		["POST", "https://www.openrouter.ai/api/v1/messages"],
		["POST", "https://openrouter.ai.evil.example/api/v1/messages"],
		["POST", "https://openrоuter.ai/api/v1/messages"],
		["POST", "https://u:p@openrouter.ai/api/v1/messages"],
		["POST", "https://evil.example@openrouter.ai/api/v1/messages"],
		["POST", "http://openrouter.ai/api/v1/messages"],
		["POST", `${ok} `],
		["POST", `${ok}\n`],
		["POST", ""],
	])("refuses %s %j", (method, url) => {
		expect(model(method, url)).toBe(false);
	});
});

describe("prepareModelBody: the model and its output budget are enforced in the gateway", () => {
	const pinned = "vendor/model-a";
	const body = (o: object) => JSON.stringify({ model: pinned, max_tokens: 1024, messages: [{ role: "user", content: "hi" }], ...o });
	const prep = (text: string, max = 8192) => prepareModelBody(text, new TextEncoder().encode(text).byteLength, pinned, max);

	it("passes a valid body through untouched", () => {
		const text = body({});
		expect(prep(text)).toMatchObject({ ok: true, body: text, maxTokens: 1024 });
	});

	it.each([
		["a missing model", JSON.stringify({ max_tokens: 5 })],
		["a non-string model", body({ model: 5 })],
		["another model", body({ model: "vendor/model-b" })],
		["the model in different case", body({ model: "Vendor/Model-A" })],
		["the model with a suffix", body({ model: `${pinned}:nitro` })],
		["an empty model", body({ model: "" })],
	])("rejects %s with 403", (_n, text) => {
		expect(prep(text)).toMatchObject({ ok: false, status: 403 });
	});

	it.each([
		["not JSON", "nope"],
		["an array", "[]"],
		["null", "null"],
		["a missing max_tokens", JSON.stringify({ model: pinned })],
		["a zero max_tokens", body({ max_tokens: 0 })],
		["a negative max_tokens", body({ max_tokens: -5 })],
		["a fractional max_tokens", body({ max_tokens: 10.5 })],
		["a string max_tokens", body({ max_tokens: "100" })],
		["an infinite max_tokens", '{"model":"vendor/model-a","max_tokens":1e999}'],
	])("rejects %s with 400", (_n, text) => {
		expect(prep(text)).toMatchObject({ ok: false, status: 400 });
	});

	it("clamps max_tokens above the ceiling and rewrites the body", () => {
		const r = prep(body({ max_tokens: 32_000 }));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.maxTokens).toBe(8192);
			expect(JSON.parse(r.body).max_tokens).toBe(8192);
		}
	});

	it("keeps an extended-thinking budget below the clamped max_tokens, or drops thinking", () => {
		const a = prep(body({ max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 20_000 } }));
		const b = prep(body({ max_tokens: 32_000, thinking: { type: "enabled", budget_tokens: 2_000 } }));
		const c = prep(body({ max_tokens: 5_000, thinking: { type: "enabled", budget_tokens: 4_000 } }), 1_000);
		expect(a.ok && JSON.parse(a.body).thinking.budget_tokens).toBeLessThan(8192);
		expect(b.ok && JSON.parse(b.body).thinking.budget_tokens).toBe(2_000);
		expect(c.ok && JSON.parse(c.body).thinking).toBeUndefined();
	});

	it("estimates input tokens conservatively from the body size", () => {
		const r = prep(body({ messages: [{ role: "user", content: "x".repeat(30_000) }] }));
		expect(r.ok && r.estInputTokens).toBeGreaterThanOrEqual(10_000);
	});
});

describe("per-run meter", () => {
	const limits = { ...DEFAULT_LIMITS, maxModelRequests: 3, maxGitRequests: 2, maxTotalTokens: 10_000, maxOutputTokens: 1000 };
	const model1 = (reserve = 1000) => ({ kind: "model" as const, reserve });

	it("admits requests under the caps and counts them", () => {
		let m = newMeter("run-1", limits);
		for (let i = 0; i < 3; i++) {
			const r = admit(m, model1(100));
			expect(r.admission.ok).toBe(true);
			m = r.meter;
		}
		expect(m.modelRequests).toBe(3);
	});

	it("429s the request that crosses the request cap, and every request after it", () => {
		let m = newMeter("run-1", limits);
		for (let i = 0; i < 3; i++) m = admit(m, model1(100)).meter;
		const over = admit(m, model1(100));
		expect(over.admission).toMatchObject({ ok: false, status: 429 });
		expect(over.meter.exceeded).toMatch(/request cap/);
		expect(admit(over.meter, model1(1)).admission).toMatchObject({ ok: false, status: 429 });
		expect(admit(over.meter, { kind: "git" }).admission).toMatchObject({ ok: false, status: 429 });
	});

	it("reserves the worst case up front so parallel requests can't overshoot the token ceiling", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, model1(6000)).meter;
		const second = admit(m, model1(6000));
		expect(second.admission).toMatchObject({ ok: false, status: 429 });
		expect(second.meter.exceeded).toMatch(/token ceiling/);
	});

	it("replaces a reservation with the real usage, and trips once real usage reaches the ceiling", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, model1(4000)).meter;
		m = recordUsage(m, { reserved: 4000, input: 1000, output: 500 });
		expect(m.reserved).toBe(0);
		expect(m.inputTokens + m.outputTokens).toBe(1500);
		expect(m.exceeded).toBeNull();
		m = admit(m, model1(100)).meter;
		m = recordUsage(m, { reserved: 100, input: 9000, output: 0 });
		expect(m.exceeded).toMatch(/token ceiling/);
	});

	it("adds up the reported dollar cost and trips the cost ceiling", () => {
		const capped = { ...limits, maxCostUsd: 0.25 };
		let m = newMeter("run-1", capped);
		m = admit(m, model1(100)).meter;
		m = recordUsage(m, { reserved: 100, input: 10, output: 10, cost: 0.1 });
		expect(m.costUsd).toBeCloseTo(0.1);
		expect(m.exceeded).toBeNull();
		m = admit(m, model1(100)).meter;
		m = recordUsage(m, { reserved: 100, input: 10, output: 10, cost: 0.2 });
		expect(m.exceeded).toMatch(/cost ceiling/);
		expect(admit(m, model1(1)).admission).toMatchObject({ ok: false, status: 429 });
	});

	it("never lets a bad cost reduce the total", () => {
		let m = newMeter("run-1", limits);
		m = recordUsage(m, { reserved: 0, input: 1, output: 1, cost: 0.05 });
		m = recordUsage(m, { reserved: 0, input: 1, output: 1, cost: -5 });
		m = recordUsage(m, { reserved: 0, input: 1, output: 1, cost: Number.NaN });
		expect(m.costUsd).toBeCloseTo(0.05);
	});

	it("caps git requests separately", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, { kind: "git" }).meter;
		m = admit(m, { kind: "git" }).meter;
		const over = admit(m, { kind: "git" });
		expect(over.admission).toMatchObject({ ok: false, status: 429 });
		expect(over.meter.exceeded).toMatch(/git request cap/);
	});

	it("refuses everything once the run is deactivated (the registration is cleared)", () => {
		const m = deactivate(newMeter("run-1", limits));
		expect(admit(m, model1(1)).admission).toMatchObject({ ok: false, status: 403 });
		expect(admit(m, { kind: "git" }).admission).toMatchObject({ ok: false, status: 403 });
	});
});

describe("UsageTracker (streamed and plain responses)", () => {
	const sse = [
		'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n',
		'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
		'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n',
		'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	].join("");

	it("sums input and takes the final cumulative output from SSE events, whatever the chunking", () => {
		for (const size of [1, 3, 7, 64, sse.length]) {
			const t = new UsageTracker();
			for (let i = 0; i < sse.length; i += size) t.feed(sse.slice(i, i + size));
			expect(t.result()).toEqual({ input: 125, output: 55 });
		}
	});

	it("takes input tokens from message_delta too (OpenRouter reports 0 input in message_start)", () => {
		const t = new UsageTracker();
		t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":null}}}\n');
		t.feed('data: {"type":"message_delta","usage":{"input_tokens":18,"output_tokens":32,"cache_read_input_tokens":4,"cost":0.00000286}}\n');
		expect(t.result()).toEqual({ input: 22, output: 32, cost: 0.00000286 });
	});

	it("reads a plain JSON response", () => {
		const t = new UsageTracker();
		t.feed(JSON.stringify({ id: "x", usage: { input_tokens: 10, output_tokens: 4 } }));
		expect(t.result()).toEqual({ input: 10, output: 4 });
	});

	it("reports nothing when there was no usage, so the caller counts conservatively", () => {
		const t = new UsageTracker();
		t.feed("event: ping\ndata: {}\n\n");
		expect(t.result()).toBeNull();
		expect(new UsageTracker().result()).toBeNull();
	});

	it("reads the dollar cost OpenRouter reports, from SSE and from a plain body", () => {
		const t = new UsageTracker();
		t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n');
		t.feed('data: {"type":"message_delta","usage":{"output_tokens":5,"cost":0.0042}}\n');
		expect(t.result()).toEqual({ input: 10, output: 5, cost: 0.0042 });
		const p = new UsageTracker();
		p.feed(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2, cost: 1.45e-5 } }));
		expect(p.result()).toEqual({ input: 3, output: 2, cost: 1.45e-5 });
	});

	it("ignores a negative, NaN or absurd cost", () => {
		for (const cost of [-1, "x", 1e9, null]) {
			const t = new UsageTracker();
			t.feed(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2, cost } }));
			expect(t.result()).toEqual({ input: 3, output: 2 });
		}
	});

	it("ignores garbage and absurd numbers", () => {
		const t = new UsageTracker();
		t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":-5,"output_tokens":"x"}}}\ndata: not json\n');
		expect(t.result()).toBeNull();
	});
});

describe("limitStream", () => {
	const streamOf = (...parts: string[]) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const p of parts) c.enqueue(new TextEncoder().encode(p));
				c.close();
			},
		});

	it("passes a body under the cap through unchanged", async () => {
		const text = await new Response(limitStream(streamOf("ab", "cd"), 10)).text();
		expect(text).toBe("abcd");
	});

	it("errors the stream once the cap is crossed, without reading on", async () => {
		await expect(new Response(limitStream(streamOf("abcde", "fghij", "k"), 8)).text()).rejects.toThrow(/body too large/);
	});
});
