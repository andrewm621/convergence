import { describe, expect, it } from "vitest";
import { DispatchError, dispatchAgent, readAgentConfig } from "./dispatch";
import { DispatchRequest, dispatchFingerprint, parseModelAllowlist, resolveModel } from "./protocol";

const DEFAULT = "openai/gpt-6-luna";
const LIST = "openai/gpt-6-luna, z-ai/glm-5.3-flash ,minimax/minimax-m3";
const base = { forkRepo: "notifications-wi-2", workItemId: "wi-2", prompt: "Implement delivery" };
const env = (vars: Record<string, string>) => vars as unknown as Env;

describe("model allowlist", () => {
	it("puts the default first, trims, and removes duplicates", () => {
		expect(parseModelAllowlist(LIST, DEFAULT)).toEqual(["openai/gpt-6-luna", "z-ai/glm-5.3-flash", "minimax/minimax-m3"]);
		expect(parseModelAllowlist("", DEFAULT)).toEqual([DEFAULT]);
		expect(parseModelAllowlist(undefined, DEFAULT)).toEqual([DEFAULT]);
		expect(parseModelAllowlist("a/b,,a/b", "c/d")).toEqual(["c/d", "a/b"]);
	});

	it("rejects a malformed slug anywhere in the list", () => {
		for (const bad of ["not a slug", "no-vendor", "a/b c", "../x/y", "a/b;rm", "a//b", "/b"]) {
			expect(() => parseModelAllowlist(bad, DEFAULT)).toThrow();
		}
		expect(() => parseModelAllowlist("a/b", "bad")).toThrow();
	});

	it("refuses variant suffixes and aliases outright, in the list, the default and a dispatch request", () => {
		for (const bad of ["openai/gpt-6-luna:online", "openai/gpt-6-luna:nitro", "openai/gpt-6-luna:floor", "z-ai/glm-5.3-flash:thinking", "~openai/gpt-6-luna"]) {
			expect(() => parseModelAllowlist(bad, DEFAULT)).toThrow();
			expect(() => parseModelAllowlist("", bad)).toThrow();
			expect(DispatchRequest.safeParse({ ...base, model: bad }).success).toBe(false);
		}
	});

	it("resolves the requested model only if allowlisted, else the default", () => {
		const list = parseModelAllowlist(LIST, DEFAULT);
		expect(resolveModel(undefined, DEFAULT, list)).toEqual({ ok: true, model: DEFAULT });
		expect(resolveModel("z-ai/glm-5.3-flash", DEFAULT, list)).toEqual({ ok: true, model: "z-ai/glm-5.3-flash" });
		expect(resolveModel("anthropic/claude-opus-5.5", DEFAULT, list)).toMatchObject({ ok: false });
		expect(resolveModel("openai/gpt-6-luna:nitro", DEFAULT, list)).toMatchObject({ ok: false });
		expect(resolveModel("OPENAI/GPT-6-LUNA", DEFAULT, list)).toMatchObject({ ok: false });
	});
});

describe("dispatch model field", () => {
	it("accepts a slug and leaves it optional", () => {
		expect(DispatchRequest.parse(base).model).toBeUndefined();
		expect(DispatchRequest.parse({ ...base, model: "z-ai/glm-5.3-flash" }).model).toBe("z-ai/glm-5.3-flash");
	});

	it.each(["", "glm", "z-ai/", "a b/c", "x".repeat(200), 5, null, "a/b\nc"])("rejects model %j", (model) => {
		expect(DispatchRequest.safeParse({ ...base, model }).success).toBe(false);
	});

	it("makes a different model a different request for idempotency", async () => {
		const a = await dispatchFingerprint({ ...base, model: "z-ai/glm-5.3-flash" });
		expect(await dispatchFingerprint({ ...base, model: "z-ai/glm-5.3-flash" })).toBe(a);
		expect(await dispatchFingerprint({ ...base, model: "minimax/minimax-m3" })).not.toBe(a);
		expect(await dispatchFingerprint(base)).not.toBe(a);
	});
});

describe("readAgentConfig", () => {
	it("defaults to stub mode, one allowed model and the standard caps", () => {
		const cfg = readAgentConfig(env({}));
		expect(cfg.mode).toBe("stub");
		expect(cfg.models).toEqual([cfg.model]);
		expect(cfg.limits).toMatchObject({ maxModelRequests: 40, maxGitRequests: 60, maxTotalTokens: 1_000_000, maxOutputTokens: 8192, maxCostUsd: 0.25 });
	});

	it("reads the default model, the allowlist and the caps from vars", () => {
		const cfg = readAgentConfig(
			env({ AGENT_MODE: "claude", AGENT_MODEL: DEFAULT, AGENT_MODELS: LIST, AGENT_MAX_COST_USD: "0.10", AGENT_MAX_MODEL_REQUESTS: "12" }),
		);
		expect(cfg.model).toBe(DEFAULT);
		expect(cfg.models).toEqual(["openai/gpt-6-luna", "z-ai/glm-5.3-flash", "minimax/minimax-m3"]);
		expect(cfg.limits).toMatchObject({ maxCostUsd: 0.1, maxModelRequests: 12 });
	});

	it.each([
		["a bad mode", { AGENT_MODE: "bogus" }],
		["a bad default model", { AGENT_MODEL: "not a slug" }],
		["a bad allowlist entry", { AGENT_MODELS: "ok/model,not a slug" }],
		["a zero cost cap", { AGENT_MAX_COST_USD: "0" }],
		["an absurd request cap", { AGENT_MAX_MODEL_REQUESTS: "100000" }],
	])("fails loudly on %s", (_n, vars) => {
		expect(() => readAgentConfig(env(vars))).toThrow(DispatchError);
	});
});

describe("claude mode needs a price for the model", () => {
	it("refuses a dispatch for an allowlisted model with no price, before touching any sandbox", async () => {
		const e = env({ AGENT_MODE: "claude", OPENROUTER_API_KEY: "k", AGENT_MODEL: "vendor/unpriced" });
		const req = DispatchRequest.parse(base);
		await expect(dispatchAgent(e, req, "key-1")).rejects.toMatchObject({ status: 400, code: "MODEL_NOT_ALLOWED" });
	});
});
