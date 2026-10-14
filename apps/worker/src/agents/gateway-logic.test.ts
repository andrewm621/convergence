import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIMITS,
	UsageTracker,
	admit,
	allowGitCredential,
	allowModelCredential,
	canonicalUrl,
	deactivate,
	forwardModelHeaders,
	isExactModelSlug,
	isSaneMeter,
	limitStream,
	newMeter,
	prepareModelBody,
	recordUsage,
	reservedCostUsd,
	reservedTokens,
	settleModelCall,
	settleOutstanding,
	tapUsage,
	worstCaseCostUsd,
} from "./gateway-logic";
import { modelPrice, priceTokens } from "./model-prices";

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
		["GET", `${ok}/info/refs?service=git-upload-pack&service=git-upload-pack`],
		["GET", `${ok}/info/refs?service=git-upload-pack&`],
		["GET", `${ok}/info/refs?&service=git-upload-pack`],
		["GET", `${ok}/info/refs?service=git-upload-pack,git-receive-pack`],
		["GET", `${ok}/info/refs?service=git-upload-pack%00`],
		["GET", `${ok}/info/refs?service=git%2dupload-pack`],
		["GET", `${ok}/info/refs?service=GIT-UPLOAD-PACK`],
		["GET", `${ok}/info/refs?Service=git-upload-pack`],
		["GET", `${ok}/info/refs?service=`],
		["GET", `${ok}/info/refs?service`],
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
		["POST", `${ok}?beta=true&beta=true`],
		["POST", `${ok}?beta=true&beta=false`],
		["POST", `${ok}?beta=false&beta=true`],
		["POST", `${ok}?beta=true&`],
		["POST", `${ok}?&beta=true`],
		["POST", `${ok}?beta`],
		["POST", `${ok}?beta=`],
		["POST", `${ok}?beta=TRUE`],
		["POST", `${ok}?BETA=true`],
		["POST", `${ok}?beta=true%00`],
		["POST", `${ok}?beta=tru%65`],
		["POST", `${ok}?models=other%2Fmodel`],
		["POST", `${ok}?provider=x`],
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

	it("forwards the canonical re-serialization of a valid body, not the raw text", () => {
		const text = `  ${body({})}\n`;
		const r = prep(text);
		expect(r).toMatchObject({ ok: true, maxTokens: 1024 });
		expect(r.ok && r.body).toBe(JSON.stringify(JSON.parse(text)));
		expect(r.ok && r.body).not.toBe(text);
	});

	it("a duplicate key cannot be read differently upstream: only the validated model and clamped max_tokens are forwarded", () => {
		const raw = `{"model":"vendor/expensive","model":"${pinned}","max_tokens":100000,"max_tokens":100,"messages":[{"role":"user","content":"hi"}]}`;
		const r = prep(raw);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.body.match(/"model"/g)).toHaveLength(1);
		expect(r.body.match(/"max_tokens"/g)).toHaveLength(1);
		expect(JSON.parse(r.body)).toMatchObject({ model: pinned, max_tokens: 100 });
		expect(r.body).not.toContain("expensive");
		expect(r.body).not.toContain("100000");
		// the other order: the last value is the one that is checked, and it is the one forwarded
		const rev = prep(`{"model":"${pinned}","model":"vendor/expensive","max_tokens":100}`);
		expect(rev).toMatchObject({ ok: false, status: 403 });
		const big = prep(`{"model":"${pinned}","max_tokens":100,"max_tokens":999999}`);
		expect(big.ok && JSON.parse(big.body).max_tokens).toBe(8192);
		expect(big.ok && big.body.match(/"max_tokens"/g)).toHaveLength(1);
	});

	it("forwards well-formed text for lone surrogates and invalid UTF-8, and sizes the call by the larger body", () => {
		const bytes = new Uint8Array([...new TextEncoder().encode(`{"model":"${pinned}","max_tokens":5,"messages":[{"role":"user","content":"a`), 0xff, 0xfe, ...new TextEncoder().encode('\\ud800"}]}')]);
		const text = new TextDecoder().decode(bytes);
		const r = prepareModelBody(text, bytes.byteLength, pinned, 8192);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.body).toContain("\\ud800"); // the lone surrogate is escaped, not forwarded raw
		expect(() => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new TextEncoder().encode(r.body))).not.toThrow();
		expect(r.worstInputTokens).toBeGreaterThanOrEqual(bytes.byteLength);
		expect(r.worstInputTokens).toBeGreaterThanOrEqual(new TextEncoder().encode(r.body).byteLength);
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

describe("prepareModelBody: nothing in the body can reroute or upgrade the pinned model", () => {
	const pinned = "vendor/model-a";
	const base = { model: pinned, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] };
	const prep = (o: object, model = pinned) => {
		const text = JSON.stringify(o);
		return prepareModelBody(text, new TextEncoder().encode(text).byteLength, model, 8192);
	};

	it.each([
		["a fallback model list", { models: ["other/model"] }],
		["provider routing preferences", { provider: { order: ["x"], allow_fallbacks: true } }],
		["a route", { route: "fallback" }],
		["a preset", { preset: "other" }],
		["plugins", { plugins: [{ id: "web" }] }],
		["web search options", { web_search_options: {} }],
		["transforms", { transforms: ["middle-out"] }],
		["mcp servers", { mcp_servers: [{ type: "url", url: "https://x.example" }] }],
		["a session id", { session_id: "s" }],
	])("refuses %s", (_name, extra) => {
		expect(prep({ ...base, ...extra })).toMatchObject({ ok: false, status: 400 });
	});

	it.each([
		":online",
		":nitro",
		":floor",
		":thinking",
		":free",
		":exacto",
		":extended",
	])("refuses the model with the %s suffix, and a pin that already carries one", (suffix) => {
		expect(prep({ ...base, model: `${pinned}${suffix}` })).toMatchObject({ ok: false, status: 403 });
		expect(prep({ ...base, model: `${pinned}${suffix}` }, `${pinned}${suffix}`)).toMatchObject({ ok: false, status: 403 });
	});

	it.each(["~vendor/model-a", "VENDOR/model-a", "vendor/model-a ", " vendor/model-a", "vendor//model-a", "vendor/model-a\n", "vendor/model-b"])(
		"refuses the near-miss model %j (exact string match only)",
		(model) => {
			expect(prep({ ...base, model })).toMatchObject({ ok: false, status: 403 });
		},
	);

	it("refuses server tools and malformed tools lists, and accepts client tools", () => {
		for (const tools of [
			[{ type: "web_search_20250305", name: "web_search" }],
			[{ type: "code_execution_20250522", name: "code_execution" }],
			[{ type: "computer_20250124", name: "computer" }],
			[{ type: "openrouter:web_search" }],
			[{ name: "ok", input_schema: {} }, { type: "web_fetch_20250910", name: "web_fetch" }],
			"web_search",
			{ name: "x" },
			[null],
			["web_search"],
		]) {
			expect(prep({ ...base, tools })).toMatchObject({ ok: false, status: 400 });
		}
		expect(prep({ ...base, tools: [{ name: "Read", description: "d", input_schema: { type: "object" } }, { type: "custom", name: "x", input_schema: {} }] })).toMatchObject({ ok: true });
	});

	it("drops top-level keys outside the whitelist and forwards only the whitelist", () => {
		const r = prep({ ...base, stream: true, system: "s", temperature: 0.2, metadata: { user_id: "u" }, tool_choice: { type: "auto" }, output_config: { effort: "high" }, context_management: {}, service_tier: "auto", user: "u", include_reasoning: true, anything: 1 });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.keys(JSON.parse(r.body)).sort()).toEqual(["max_tokens", "messages", "metadata", "model", "stream", "system", "temperature", "tool_choice"]);
	});

	it("does not treat an inherited or prototype key as part of the body", () => {
		const text = '{"model":"vendor/model-a","max_tokens":5,"messages":[],"__proto__":{"models":["x"]},"constructor":1}';
		const r = prepareModelBody(text, text.length, pinned, 8192);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(JSON.parse(r.body).models).toBeUndefined();
		expect(Object.keys(JSON.parse(r.body))).not.toContain("constructor");
	});

	it("bounds input tokens by the body size and reserves a third of it", () => {
		const text = JSON.stringify(base);
		const r = prepareModelBody(text, 3000, pinned, 8192);
		expect(r).toMatchObject({ ok: true, estInputTokens: 1000, worstInputTokens: 3000 });
	});

	it("recognises only exact slugs", () => {
		expect(isExactModelSlug("vendor/model-a")).toBe(true);
		for (const bad of ["vendor/model:online", "~vendor/model", "vendor", "", "a/b/c", "vendor/model a"]) expect(isExactModelSlug(bad)).toBe(false);
	});
});

describe("forwardModelHeaders: only a short whitelist crosses to the upstream", () => {
	it("keeps the Messages headers and drops everything else, including auth and routing hints", () => {
		const out = forwardModelHeaders(
			new Headers({
				"content-type": "application/json",
				accept: "text/event-stream",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "interleaved-thinking-2025-05-14",
				"user-agent": "claude-cli",
				authorization: "Bearer placeholder",
				"x-api-key": "placeholder",
				cookie: "a=b",
				"http-referer": "https://x.example",
				"x-title": "x",
				"x-openrouter-provider": "evil",
				"x-forwarded-for": "1.2.3.4",
			}),
		);
		expect([...out.keys()].sort()).toEqual(["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"]);
	});

	it("drops a whitelisted header whose value is not plain printable ASCII or is huge", () => {
		const out = forwardModelHeaders(new Headers({ "anthropic-beta": "x".repeat(600), "user-agent": "café" }));
		expect([...out.keys()]).toEqual([]);
	});
});

describe("per-run meter", () => {
	const limits = { ...DEFAULT_LIMITS, maxModelRequests: 3, maxGitRequests: 2, maxTotalTokens: 10_000, maxOutputTokens: 1000, maxCostUsd: 0.25 };
	let n = 0;
	const model1 = (reserveTokens = 1000, reserveCostUsd = 0.001, requestId = `req-${++n}`) => ({ kind: "model" as const, requestId, reserveTokens, reserveCostUsd });

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

	it("reserves worst-case dollars for in-flight requests so concurrent calls can't overshoot the cost ceiling", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, model1(100, 0.15)).meter;
		expect(reservedCostUsd(m)).toBeCloseTo(0.15);
		const second = admit(m, model1(100, 0.15));
		expect(second.admission).toMatchObject({ ok: false, status: 429 });
		expect(second.meter.exceeded).toMatch(/cost ceiling/);
	});

	it("releases a reservation when the call settles, so sequential calls are not blocked by earlier ones", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, model1(100, 0.15, "a")).meter;
		m = recordUsage(m, { requestId: "a", input: 10, output: 10, cost: 0.01 });
		expect(reservedCostUsd(m)).toBe(0);
		expect(admit(m, model1(100, 0.15, "b")).admission.ok).toBe(true);
	});

	it("replaces a reservation with the real usage, and trips once real usage reaches the ceiling", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, model1(4000, 0.001, "a")).meter;
		m = recordUsage(m, { requestId: "a", input: 1000, output: 500, cost: 0.001 });
		expect(reservedTokens(m)).toBe(0);
		expect(m.inputTokens + m.outputTokens).toBe(1500);
		expect(m.exceeded).toBeNull();
		m = admit(m, model1(100, 0.001, "b")).meter;
		m = recordUsage(m, { requestId: "b", input: 9000, output: 0, cost: 0.001 });
		expect(m.exceeded).toMatch(/token ceiling/);
	});

	it("adds up the charged dollars and trips the cost ceiling", () => {
		let m = newMeter("run-1", limits);
		m = admit(m, model1(100, 0.01, "a")).meter;
		m = recordUsage(m, { requestId: "a", input: 10, output: 10, cost: 0.1 });
		expect(m.costUsd).toBeCloseTo(0.1);
		expect(m.exceeded).toBeNull();
		m = admit(m, model1(100, 0.01, "b")).meter;
		m = recordUsage(m, { requestId: "b", input: 10, output: 10, cost: 0.2 });
		expect(m.exceeded).toMatch(/cost ceiling/);
		expect(admit(m, model1(1)).admission).toMatchObject({ ok: false, status: 429 });
	});

	it("charges the reservation's worst case, never zero, when the reported figures are NaN, negative or missing", () => {
		for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
			let m = admit(newMeter("run-1", limits), model1(3000, 0.05, "a")).meter;
			m = recordUsage(m, { requestId: "a", input: bad, output: 5, cost: bad });
			expect(Number.isFinite(m.inputTokens) && Number.isFinite(m.outputTokens) && Number.isFinite(m.costUsd)).toBe(true);
			expect(m.inputTokens + m.outputTokens).toBe(3000);
			expect(m.costUsd).toBeCloseTo(0.05);
		}
	});

	it("never lets a bad cost reduce the total", () => {
		let m = newMeter("run-1", limits);
		for (const [id, cost] of [["a", 0.05], ["b", -5], ["c", Number.NaN]] as const) {
			m = admit(m, model1(10, 0.02, id)).meter;
			m = recordUsage(m, { requestId: id, input: 1, output: 1, cost });
		}
		expect(m.costUsd).toBeCloseTo(0.05 + 0.02 + 0.02);
	});

	it("counts a settlement once: a repeated or unknown request id changes nothing", () => {
		let m = admit(newMeter("run-1", limits), model1(100, 0.01, "a")).meter;
		m = recordUsage(m, { requestId: "a", input: 10, output: 10, cost: 0.1 });
		const again = recordUsage(m, { requestId: "a", input: 10, output: 10, cost: 0.1 });
		expect(again).toEqual(m);
		expect(recordUsage(m, { requestId: "never-admitted", input: 1e6, output: 1e6, cost: 99 })).toEqual(m);
	});

	it("refuses a request id that is already in flight and reservations that are not finite numbers", () => {
		const m = admit(newMeter("run-1", limits), model1(100, 0.01, "a")).meter;
		expect(admit(m, model1(100, 0.01, "a")).admission).toMatchObject({ ok: false, status: 403 });
		expect(admit(m, model1(Number.NaN)).admission).toMatchObject({ ok: false, status: 403 });
		expect(admit(m, model1(100, Number.NaN)).admission).toMatchObject({ ok: false, status: 403 });
		expect(admit(m, model1(-1)).admission).toMatchObject({ ok: false, status: 403 });
		expect(admit(m, model1(100, 0.01, "")).admission).toMatchObject({ ok: false, status: 403 });
	});

	it("charges calls still in flight at the end of the run at their reserved worst case, once", () => {
		let m = admit(newMeter("run-1", limits), model1(3000, 0.05, "a")).meter;
		m = admit(m, model1(2000, 0.04, "b")).meter;
		const done = settleOutstanding(m);
		expect(done.inflight).toEqual({});
		expect(done.inputTokens).toBe(5000);
		expect(done.costUsd).toBeCloseTo(0.09);
		expect(settleOutstanding(done)).toEqual(done);
		// the late report for a folded call is ignored, so it is not charged twice
		expect(recordUsage(done, { requestId: "a", input: 10, output: 10, cost: 0.01 })).toEqual(done);
		const over = settleOutstanding(admit(newMeter("run-1", { ...limits, maxCostUsd: 0.06 }), model1(10, 0.05, "a")).meter);
		expect(over.exceeded).toBeNull();
		const trips = settleOutstanding({ ...over, inflight: { z: { tokens: 20_000, costUsd: 0.5 } } });
		expect(trips.exceeded).toMatch(/ceiling/);
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

	it("treats a stored meter that is not intact as no meter (fail closed on a lost or damaged counter)", () => {
		const good = newMeter("run-1", limits);
		expect(isSaneMeter(good)).toBe(true);
		const damaged: unknown[] = [
			undefined,
			null,
			"meter",
			{},
			{ ...good, costUsd: Number.NaN },
			{ ...good, inputTokens: -1 },
			{ ...good, modelRequests: "3" },
			{ ...good, inflight: undefined },
			{ ...good, inflight: { a: { tokens: Number.NaN, costUsd: 0 } } },
			{ ...good, limits: { ...limits, maxCostUsd: Number.NaN } },
			{ ...good, limits: undefined },
			{ ...good, active: "yes" },
			{ ...good, exceeded: 5 },
		];
		for (const d of damaged) expect(isSaneMeter(d)).toBe(false);
	});
});

describe("settleModelCall: every outcome is charged, unknown usage at the worst case", () => {
	const price = { inPerM: 1, outPerM: 10 };
	const base = { upstreamOk: true, outcome: "end" as const, worstInputTokens: 30_000, maxTokens: 1000, price };
	const worstCost = (30_000 * 1 + 1000 * 10) / 1e6;

	it("charges what was seen for a clean 2xx with complete usage and a reported cost", () => {
		expect(settleModelCall({ ...base, seen: { input: 100, output: 20, cost: 0.0007, complete: true } })).toEqual({ input: 100, output: 20, cost: 0.0007 });
	});

	it.each([
		["a response with no usage", null],
		["a truncated stream", { input: 100, output: 20, cost: 0.0007, complete: false }],
	])("charges the worst case for %s", (_name, seen) => {
		const r = settleModelCall({ ...base, seen });
		expect(r.input).toBe(30_000);
		expect(r.output).toBe(1000);
		expect(r.cost).toBeCloseTo(worstCost);
	});

	it("charges the worst case for an aborted stream, even one that looked complete", () => {
		const r = settleModelCall({ ...base, outcome: "aborted", seen: { input: 100, output: 20, cost: 0.0007, complete: true } });
		expect(r).toMatchObject({ input: 30_000, output: 1000 });
		expect(r.cost).toBeCloseTo(worstCost);
	});

	it("charges the worst case for a non-2xx response, even one that reports usage", () => {
		const r = settleModelCall({ ...base, upstreamOk: false, seen: { input: 5, output: 5, cost: 0.0001, complete: true } });
		expect(r).toMatchObject({ input: 30_000, output: 1000 });
		expect(r.cost).toBeCloseTo(worstCost);
		expect(settleModelCall({ ...base, upstreamOk: false, seen: null }).cost).toBeCloseTo(worstCost);
	});

	it("never charges less than what was seen on a worst-case path", () => {
		const r = settleModelCall({ ...base, outcome: "aborted", seen: { input: 90_000, output: 4000, cost: 5, complete: false } });
		expect(r).toEqual({ input: 90_000, output: 4000, cost: 5 });
	});

	it.each([
		["missing", undefined],
		["NaN", Number.NaN],
		["negative", -1],
		["zero", 0],
		["infinite", Number.POSITIVE_INFINITY],
	])("prices the tokens from the table when the reported cost is %s", (_name, cost) => {
		const r = settleModelCall({ ...base, seen: { input: 2000, output: 500, ...(cost !== undefined ? { cost } : {}), complete: true } });
		expect(r.cost).toBeCloseTo((2000 * 1 + 500 * 10) / 1e6);
		expect(r.input).toBe(2000);
		expect(r.output).toBe(500);
	});
});

describe("model price table", () => {
	it("prices every model the deployment allows, at the highest applicable rate", () => {
		for (const slug of ["openai/gpt-6-luna", "z-ai/glm-5.3-flash", "minimax/minimax-m3", "anthropic/claude-sonnet-5.5"]) {
			expect(modelPrice(slug)).not.toBeNull();
		}
		expect(modelPrice("minimax/minimax-m3")).toEqual({ inPerM: 0.3, outPerM: 1.2 });
		// Dollars per million tokens, as OpenRouter lists them: $0.10 in, $0.50 out.
		expect(modelPrice("openai/gpt-6-luna")).toEqual({ inPerM: 0.1, outPerM: 0.5 });
	});

	it("has no price for an unknown model, a suffixed or aliased slug, or an inherited property name", () => {
		for (const slug of ["vendor/unknown", "openai/gpt-6-luna:online", "~openai/gpt-6-luna", "toString", "__proto__", "constructor", ""]) {
			expect(modelPrice(slug)).toBeNull();
		}
	});

	it("prices tokens, and fails closed on a count that is not a finite non-negative number", () => {
		expect(priceTokens({ inPerM: 2, outPerM: 4 }, 1_000_000, 500_000)).toBeCloseTo(4);
		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			expect(priceTokens({ inPerM: 2, outPerM: 4 }, bad, 1)).toBeGreaterThan(1000);
			expect(priceTokens({ inPerM: 2, outPerM: 4 }, 1, bad)).toBeGreaterThan(1000);
		}
		expect(worstCaseCostUsd({ inPerM: 2, outPerM: 4 }, 1_000_000, 0)).toBeCloseTo(2);
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
			expect(t.result()).toEqual({ input: 125, output: 55, complete: true });
		}
	});

	it("takes input tokens from message_delta too (OpenRouter reports 0 input in message_start)", () => {
		const t = new UsageTracker();
		t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":null}}}\n');
		t.feed('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":18,"output_tokens":32,"cache_read_input_tokens":4,"cost":0.00000286}}\n');
		expect(t.result()).toEqual({ input: 22, output: 32, cost: 0.00000286, complete: true });
	});

	it("marks a stream that never reached its closing event as incomplete", () => {
		const cut = sse.slice(0, sse.indexOf("event: message_stop"));
		const t = new UsageTracker();
		t.feed(cut);
		expect(t.result()).toEqual({ input: 125, output: 55, complete: false });
		const startOnly = new UsageTracker();
		startOnly.feed(sse.slice(0, sse.indexOf("event: content_block_delta")));
		expect(startOnly.result()).toMatchObject({ complete: false });
	});

	it("marks a stream cut off in the middle of an event as incomplete", () => {
		const t = new UsageTracker();
		t.feed(sse.slice(0, sse.length - 20));
		expect(t.result()?.complete).toBe(false);
	});

	it("reads a plain JSON response", () => {
		const t = new UsageTracker();
		t.feed(JSON.stringify({ id: "x", usage: { input_tokens: 10, output_tokens: 4 } }));
		expect(t.result()).toEqual({ input: 10, output: 4, complete: true });
	});

	it("reports nothing when there was no usage, so the caller charges the worst case", () => {
		const t = new UsageTracker();
		t.feed("event: ping\ndata: {}\n\n");
		expect(t.result()).toBeNull();
		expect(new UsageTracker().result()).toBeNull();
	});

	it("reports nothing for a plain body that is not valid JSON", () => {
		const t = new UsageTracker();
		t.feed('{"usage":{"input_tokens":10,"output_tokens":4}');
		expect(t.result()).toBeNull();
	});

	it("reads the dollar cost OpenRouter reports, from SSE and from a plain body", () => {
		const t = new UsageTracker();
		t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n');
		t.feed('data: {"type":"message_delta","usage":{"output_tokens":5,"cost":0.0042}}\n');
		t.feed('data: {"type":"message_stop"}\n');
		expect(t.result()).toEqual({ input: 10, output: 5, cost: 0.0042, complete: true });
		const p = new UsageTracker();
		p.feed(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2, cost: 1.45e-5 } }));
		expect(p.result()).toEqual({ input: 3, output: 2, cost: 1.45e-5, complete: true });
	});

	it("ignores a negative, NaN or absurd cost", () => {
		for (const cost of [-1, "x", 1e9, null]) {
			const t = new UsageTracker();
			t.feed(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2, cost } }));
			expect(t.result()).toEqual({ input: 3, output: 2, complete: true });
		}
	});

	it("ignores garbage and absurd numbers", () => {
		const t = new UsageTracker();
		t.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":-5,"output_tokens":"x"}}}\ndata: not json\n');
		expect(t.result()).toBeNull();
	});
});

describe("tapUsage: the report is sent once, with how the stream ended", () => {
	const enc = new TextEncoder();
	const streamOf = (chunks: string[], fail = false) =>
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const x of chunks) c.enqueue(enc.encode(x));
				if (fail) c.error(new Error("upstream reset"));
				else c.close();
			},
		});

	it("reports 'end' after the whole body was read, passing it through unchanged", async () => {
		const outcomes: string[] = [];
		const out = tapUsage(streamOf(["data: {}\n", "x"]), new UsageTracker(), (o) => outcomes.push(o));
		expect(await new Response(out).text()).toBe("data: {}\nx");
		expect(outcomes).toEqual(["end"]);
	});

	it("reports 'aborted' when the reader hangs up before the end, exactly once", async () => {
		const outcomes: string[] = [];
		const out = tapUsage(
			new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(enc.encode("data: {}\n")) }),
			new UsageTracker(),
			(o) => outcomes.push(o),
		);
		const reader = out.getReader();
		await reader.read();
		await reader.cancel();
		await reader.cancel().catch(() => undefined);
		expect(outcomes).toEqual(["aborted"]);
	});

	it("reports 'aborted' and errors the stream when the upstream fails mid-body", async () => {
		const outcomes: string[] = [];
		const out = tapUsage(streamOf(["data: {}\n"], true), new UsageTracker(), (o) => outcomes.push(o));
		await expect(new Response(out).text()).rejects.toThrow();
		expect(outcomes).toEqual(["aborted"]);
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

// ---- Cost-cap bypass audit (finding from the automated review of 8439945) ----
// Every path where a call's dollars could escape the per-run cap: a reported cost trusted over the token count, a zero
// cost accepted by the meter, usage fields dropped as zero, reasoning tokens, settled ids reused, and rounding.
describe("cost cap: a call is never charged less than its tokens at the table rates", () => {
	const price = { inPerM: 1, outPerM: 10 };
	const base = { upstreamOk: true, outcome: "end" as const, worstInputTokens: 30_000, maxTokens: 1000, price };
	const priced = (i: number, o: number) => (i * 1 + o * 10) / 1e6;

	it("charges max(reported, computed) when the reported cost is positive but far below the tokens times price", () => {
		for (const cost of [1e-300, 5e-324, 1e-9, 0.00001]) {
			const r = settleModelCall({ ...base, seen: { input: 200_000, output: 5000, cost, complete: true } });
			expect(r.cost).toBeCloseTo(priced(200_000, 5000));
			expect(r.input).toBe(200_000);
		}
	});

	it("keeps a reported cost that is higher than the computed one (a surcharge the table doesn't know about)", () => {
		expect(settleModelCall({ ...base, seen: { input: 100, output: 20, cost: 0.5, complete: true } }).cost).toBe(0.5);
	});

	it("the meter itself never takes a zero cost for a call that used tokens, whoever reports it", () => {
		const limits = { ...DEFAULT_LIMITS, maxCostUsd: 0.25 };
		for (const cost of [0, undefined as unknown as number]) {
			const m0 = admit(newMeter("run-1", limits), { kind: "model", requestId: "a", reserveTokens: 100, reserveCostUsd: 0.04 }).meter;
			const m = recordUsage(m0, { requestId: "a", input: 500_000, output: 10, cost });
			expect(m.costUsd).toBeCloseTo(0.04);
		}
	});

	it("counts the whole run at the cost cap: many cheap-looking reports cannot add up to less than the tokens cost", () => {
		let m = newMeter("run-1", { ...DEFAULT_LIMITS, maxTotalTokens: 10_000_000, maxCostUsd: 0.25 });
		let n = 0;
		for (; n < 20 && !m.exceeded; n++) {
			const id = `r${n}`;
			m = admit(m, { kind: "model", requestId: id, reserveTokens: 10, reserveCostUsd: 0.001 }).meter;
			const c = settleModelCall({ ...base, seen: { input: 100_000, output: 1000, cost: 1e-12, complete: true } });
			m = recordUsage(m, { requestId: id, ...c });
		}
		// 100k in + 1k out at $1/$10 per M is $0.11 a call: the third call crosses $0.25.
		expect(m.exceeded).toMatch(/cost ceiling/);
		expect(n).toBeLessThanOrEqual(3);
	});
});

describe("cost cap: a settled request id cannot be admitted or settled again", () => {
	const limits = { ...DEFAULT_LIMITS, maxCostUsd: 0.25 };
	const req = (requestId: string) => ({ kind: "model" as const, requestId, reserveTokens: 100, reserveCostUsd: 0.01 });

	it("refuses to admit an id that was already settled, so a stale report can't be replayed onto a new reservation", () => {
		let m = admit(newMeter("run-1", limits), req("a")).meter;
		m = recordUsage(m, { requestId: "a", input: 10, output: 10, cost: 0.1 });
		expect(admit(m, req("a")).admission).toMatchObject({ ok: false, status: 403 });
	});

	it("refuses an id that was folded in at the end of the run", () => {
		const m = settleOutstanding(admit(newMeter("run-1", limits), req("a")).meter);
		expect(admit(m, req("a")).admission).toMatchObject({ ok: false, status: 403 });
	});

	it("still accepts a meter stored before settled ids were tracked, and rejects a damaged list", () => {
		const m = newMeter("run-1", limits);
		const { settled: _s, ...old } = m;
		expect(isSaneMeter(old)).toBe(true);
		expect(isSaneMeter({ ...m, settled: "a" })).toBe(false);
		expect(isSaneMeter({ ...m, settled: [1] })).toBe(false);
	});
});

describe("cost cap: usage the tracker cannot read is not read as zero", () => {
	function track(...events: unknown[]) {
		const t = new UsageTracker();
		for (const e of events) t.feed(`data: ${JSON.stringify(e)}\n`);
		return t.result();
	}
	const stop = { type: "message_stop" };

	it("marks usage incomplete when an input field is present but unreadable, instead of dropping it", () => {
		for (const bad of [1.5, -3, "100", 2e9]) {
			const r = track({ type: "message_start", message: { usage: { input_tokens: bad, cache_read_input_tokens: 5, output_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 9 } }, stop);
			expect(r?.complete).toBe(false);
		}
	});

	it("still treats an absent or null cache field as absent (OpenRouter sends null)", () => {
		const r = track({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: null, output_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 9 } }, stop);
		expect(r).toEqual({ input: 10, output: 9, complete: true });
	});

	it("does not trust a complete stream that reports zero input tokens for a request that had a body", () => {
		const r = track({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } }, { type: "message_delta", usage: { output_tokens: 40 } }, stop);
		expect(r?.complete).toBe(false);
	});

	it("counts reasoning tokens even when output_tokens does not include them", () => {
		const r = track({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }, { type: "message_delta", usage: { output_tokens: 5, output_tokens_details: { reasoning_tokens: 4000 } } }, stop);
		expect(r).toMatchObject({ output: 4000, complete: true });
		const r2 = track({ type: "message_start", message: { usage: { input_tokens: 10 } } }, { type: "message_delta", usage: { output_tokens: 5, completion_tokens_details: { reasoning_tokens: 3000 } } }, stop);
		expect(r2).toMatchObject({ output: 3000 });
		const r3 = track({ type: "message_start", message: { usage: { input_tokens: 10 } } }, { type: "message_delta", usage: { output_tokens: 5, reasoning_tokens: 2000 } }, stop);
		expect(r3).toMatchObject({ output: 2000 });
	});

	it("uses OpenAI-style prompt and completion token figures when they are the larger", () => {
		const t = new UsageTracker();
		t.feed(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 2, prompt_tokens: 900, completion_tokens: 700 } }));
		expect(t.result()).toEqual({ input: 900, output: 700, complete: true });
	});
});

describe("cost cap: rounding", () => {
	it("prices without drifting below the exact figure for large counts, and settles integral token counts", () => {
		const p = { inPerM: 0.0261, outPerM: 0.9 };
		expect(priceTokens(p, 999_999, 8192)).toBeGreaterThan(0.0261 * 0.999999);
		expect(settleModelCall({ upstreamOk: true, outcome: "end", worstInputTokens: 10, maxTokens: 10, price: p, seen: { input: 1, output: 1, complete: true } }).cost).toBeGreaterThan(0);
	});

	it("trips at exactly the cap and not one rounding step above it", () => {
		let m = newMeter("run-1", { ...DEFAULT_LIMITS, maxCostUsd: 0.25 });
		m = admit(m, { kind: "model", requestId: "a", reserveTokens: 1, reserveCostUsd: 0.1 }).meter;
		m = recordUsage(m, { requestId: "a", input: 1, output: 1, cost: 0.25 });
		expect(m.exceeded).toMatch(/cost ceiling/);
		let n = newMeter("run-1", { ...DEFAULT_LIMITS, maxCostUsd: 0.25 });
		for (let i = 0; i < 10; i++) {
			n = admit(n, { kind: "model", requestId: `r${i}`, reserveTokens: 1, reserveCostUsd: 0.025 }).meter;
			n = recordUsage(n, { requestId: `r${i}`, input: 1, output: 1, cost: 0.025 });
		}
		// ten charges of 0.025 sum to 0.25 (give or take a float error): the run must be at its cap
		expect(n.exceeded).toMatch(/cost ceiling/);
	});
});
