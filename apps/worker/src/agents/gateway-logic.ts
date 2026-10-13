// Pure logic behind the outbound gateways: URL allowlisting in one canonical form, request-body checks, the
// per-run meter, and stream helpers. No Workers APIs, so every rule here is unit-tested under Node.
//
// None of this trusts the container. It controls Claude Code's flags, its environment and every byte of every
// request, so the caps below are enforced by the gateways, not requested of the agent.

import { priceTokens, type ModelPrice } from "./model-prices";

// ---- URL allowlist: a request is matched in exactly one canonical form ----

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * Parse `raw` and return the URL only if `raw` already IS its canonical serialization. The WHATWG parser
 * lowercases hosts, strips default ports, resolves dot segments, turns backslashes into slashes and encodes
 * stray characters; if any of that changed the string, the sender was not using the canonical form and we
 * refuse rather than guess what the upstream server will make of it. Also rejects userinfo, ports, fragments,
 * percent-encoding or backslashes in the path, double slashes, and hosts that aren't plain lowercase ASCII
 * without a trailing dot.
 */
export function canonicalUrl(raw: string): URL | null {
	if (typeof raw !== "string" || raw === "") return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.href !== raw) return null;
	if (url.protocol !== "https:") return null;
	if (url.username !== "" || url.password !== "" || url.port !== "") return null;
	if (raw.includes("#")) return null;
	if (!HOSTNAME_RE.test(url.hostname) || url.hostname.includes("..")) return null;
	if (/[%\\]/.test(url.pathname) || url.pathname.includes("//")) return null;
	return url;
}

/** The query exactly as sent (`?a=b`), or "" when there is none. A bare `?` is kept, so it can be refused. */
function rawQuery(raw: string): string {
	const i = raw.indexOf("?");
	return i >= 0 ? raw.slice(i) : "";
}

function plainRepoPath(path: string): boolean {
	return path.startsWith("/") && !/[%\\]/.test(path) && !path.includes("//") && !path.endsWith("/");
}

/**
 * May the Artifacts token be added to this request? Only: GET <repo>/info/refs?service=git-upload-pack|git-receive-pack,
 * and POST <repo>/git-upload-pack|git-receive-pack with no query, on exactly the fork's host over plain https.
 */
export function allowGitCredential(method: string, rawUrl: string, host: string, repoPath: string): boolean {
	if (!HOSTNAME_RE.test(host) || !plainRepoPath(repoPath)) return false;
	const url = canonicalUrl(rawUrl);
	if (!url || url.hostname !== host) return false;
	const query = rawQuery(rawUrl);
	if (method === "GET") {
		return url.pathname === `${repoPath}/info/refs` && (query === "?service=git-upload-pack" || query === "?service=git-receive-pack");
	}
	if (method === "POST") {
		return query === "" && (url.pathname === `${repoPath}/git-upload-pack` || url.pathname === `${repoPath}/git-receive-pack`);
	}
	return false;
}

/** May the model key be added to this request? Only POST https://openrouter.ai/api/v1/messages (`?beta=true` allowed). */
export function allowModelCredential(method: string, rawUrl: string): boolean {
	if (method !== "POST") return false;
	const url = canonicalUrl(rawUrl);
	if (!url || url.hostname !== "openrouter.ai" || url.pathname !== "/api/v1/messages") return false;
	const query = rawQuery(rawUrl);
	return query === "" || query === "?beta=true";
}

// ---- Request bodies ----

export const MAX_MODEL_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_GIT_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The only top-level keys of a Messages request that reach the upstream. Anything else is dropped (or, for the
 * keys that can reroute or upgrade a call, refused outright).
 */
const BODY_KEYS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"system",
	"max_tokens",
	"metadata",
	"stop_sequences",
	"stream",
	"temperature",
	"top_p",
	"top_k",
	"tools",
	"tool_choice",
	"thinking",
]);

/**
 * OpenRouter extensions (and Anthropic server features) that change which model, provider or capability serves a
 * call: fallback model lists, provider routing, presets, plugins and web search, prompt transforms, MCP servers.
 * Claude Code sends none of them, so a request that carries one is refused rather than quietly trimmed.
 */
const REROUTING_KEYS: ReadonlySet<string> = new Set([
	"models",
	"provider",
	"route",
	"preset",
	"plugins",
	"web_search_options",
	"transforms",
	"mcp_servers",
	"session_id",
	"trace",
	"usage",
]);

/** A pinned slug is `vendor/name` with no `:variant` suffix and no `~alias`: the model string must be an exact match. */
const EXACT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export function isExactModelSlug(slug: string): boolean {
	return typeof slug === "string" && EXACT_SLUG_RE.test(slug);
}

export type ModelPrep =
	| { ok: true; body: string; maxTokens: number; estInputTokens: number; worstInputTokens: number }
	| { ok: false; status: 400 | 403; reason: string };

/** A client tool has no `type` (or "custom"). Typed tools are server-side features (web search, code execution, computer use). */
function toolsAllowed(tools: unknown): boolean {
	if (tools === undefined) return true;
	if (!Array.isArray(tools)) return false;
	return tools.every((t) => {
		if (!t || typeof t !== "object" || Array.isArray(t)) return false;
		const type = (t as { type?: unknown }).type;
		return type === undefined || type === "custom";
	});
}

/**
 * Check a model request body against the run's pin and output ceiling. The model must be exactly the pinned slug
 * (no suffix, no alias), only whitelisted top-level keys are forwarded, rerouting keys and server tools are refused,
 * `max_tokens` must be a positive integer and is clamped to the ceiling (with any extended-thinking budget kept
 * below it). Returns the body to forward: always the canonical re-serialization, never the raw text.
 */
export function prepareModelBody(bodyText: string, bodyBytes: number, pinnedModel: string, maxOutputTokens: number): ModelPrep {
	if (!isExactModelSlug(pinnedModel)) return { ok: false, status: 403, reason: "model not allowed for this run" };
	let json: unknown;
	try {
		json = JSON.parse(bodyText);
	} catch {
		return { ok: false, status: 400, reason: "request body is not valid JSON" };
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, status: 400, reason: "request body must be a JSON object" };
	const body = json as Record<string, unknown>;

	if (typeof body.model !== "string" || body.model !== pinnedModel) return { ok: false, status: 403, reason: "model not allowed for this run" };
	for (const key of Object.keys(body)) {
		if (REROUTING_KEYS.has(key)) return { ok: false, status: 400, reason: `request field not allowed: ${key}` };
	}
	if (!toolsAllowed(body.tools)) return { ok: false, status: 400, reason: "only client tools are allowed" };
	const requested = body.max_tokens;
	if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
		return { ok: false, status: 400, reason: "max_tokens must be a positive integer" };
	}

	for (const key of Object.keys(body)) {
		if (!BODY_KEYS.has(key)) delete body[key];
	}
	const maxTokens = Math.min(requested, maxOutputTokens);
	if (maxTokens !== requested) {
		body.max_tokens = maxTokens;
		const thinking = body.thinking;
		if (thinking && typeof thinking === "object") {
			const t = thinking as { budget_tokens?: unknown };
			if (typeof t.budget_tokens === "number" && t.budget_tokens >= maxTokens) {
				const budget = maxTokens - 1;
				if (budget >= 1024) t.budget_tokens = budget;
				else delete body.thinking;
			}
		}
	}
	// What is forwarded is always the canonical re-serialization of what was validated here, never the raw text. A raw
	// body can carry duplicate keys (JSON.parse keeps the last, another parser may keep the first: a second `model`
	// or `max_tokens` would pass the pin and the ceiling and then be read differently upstream), lone surrogates or
	// invalid UTF-8; the re-serialization has one value per key and well-formed text.
	const forwarded = JSON.stringify(body);
	// A token is at least one byte, so the body's size bounds its input tokens from above (the larger of what was
	// received and what is forwarded). The cheaper estimate (a third of that) sizes reservations; the bound is what a
	// call with unknown usage is charged.
	const sizeBytes = Math.max(bodyBytes, new TextEncoder().encode(forwarded).byteLength);
	return {
		ok: true,
		body: forwarded,
		maxTokens,
		estInputTokens: Math.ceil(sizeBytes / 3),
		worstInputTokens: sizeBytes,
	};
}

/** The only headers that cross to the upstream; everything else the container set (routing hints, cookies, its own auth) is dropped. */
const FORWARD_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "user-agent"] as const;
const HEADER_VALUE_RE = /^[\x20-\x7e]{0,512}$/;

export function forwardModelHeaders(incoming: Headers): Headers {
	const out = new Headers();
	for (const name of FORWARD_HEADERS) {
		const value = incoming.get(name);
		if (value !== null && HEADER_VALUE_RE.test(value)) out.set(name, value);
	}
	return out;
}

// ---- Per-run meter ----

export interface RunLimits {
	maxModelRequests: number;
	maxGitRequests: number;
	/** Input plus output tokens, across the run. */
	maxTotalTokens: number;
	/** Ceiling on a single request's max_tokens. */
	maxOutputTokens: number;
	/** Dollars, summed from the `usage.cost` OpenRouter reports (or the priced worst case when it reports none). */
	maxCostUsd: number;
}

export const DEFAULT_LIMITS: RunLimits = {
	maxModelRequests: 40,
	maxGitRequests: 60,
	maxTotalTokens: 1_000_000,
	maxOutputTokens: 8192,
	maxCostUsd: 0.25,
};

/** What an admitted but not yet settled model request holds against the budget. */
export interface Reservation {
	tokens: number;
	costUsd: number;
}

export interface Meter {
	runId: string;
	/** False once the run has ended: the gateway registration is cleared and nothing is admitted. */
	active: boolean;
	/** Why the run's budget was exceeded, once it has been. Sticky. */
	exceeded: string | null;
	modelRequests: number;
	gitRequests: number;
	inputTokens: number;
	outputTokens: number;
	/** Dollars charged so far. */
	costUsd: number;
	/** Admitted model requests that have not been settled yet, by request id. Each holds its worst case. */
	inflight: Record<string, Reservation>;
	/**
	 * Ids that were admitted and since settled (or folded in at the run's end). An id is single-use: it can't be
	 * admitted again, so a replayed report can never settle a new reservation with an old, smaller figure. At most
	 * `maxModelRequests` entries. Absent on a meter stored before this field existed.
	 */
	settled?: string[];
	limits: RunLimits;
}

export type Admission = { ok: true } | { ok: false; status: 403 | 429; reason: string };

export type AdmitRequest = { kind: "model"; requestId: string; reserveTokens: number; reserveCostUsd: number } | { kind: "git" };

export function newMeter(runId: string, limits: RunLimits): Meter {
	return { runId, active: true, exceeded: null, modelRequests: 0, gitRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, inflight: {}, limits };
}

function sum(inflight: Record<string, Reservation>, key: keyof Reservation): number {
	return Object.values(inflight).reduce((a, r) => a + r[key], 0);
}

/** Tokens held by in-flight requests. */
export function reservedTokens(meter: Meter): number {
	return sum(meter.inflight, "tokens");
}

/** Dollars held by in-flight requests. */
export function reservedCostUsd(meter: Meter): number {
	return sum(meter.inflight, "costUsd");
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Dollar figures are summed as floats, so ten charges of 0.025 can land a hair under 0.25. Anything within a
 * nano-dollar of the cap counts as at the cap.
 */
const COST_EPSILON_USD = 1e-9;
const costAtCap = (usd: number, cap: number): boolean => usd >= cap - COST_EPSILON_USD;

/**
 * Is a stored meter intact? A value that fails this (a missing field, NaN, a negative, a wrong type) must be treated
 * as no meter at all, which refuses everything, rather than read as "nothing used yet".
 */
export function isSaneMeter(m: unknown): m is Meter {
	if (!m || typeof m !== "object") return false;
	const x = m as Partial<Meter>;
	const l = x.limits as Partial<RunLimits> | undefined;
	if (typeof x.runId !== "string" || typeof x.active !== "boolean") return false;
	if (x.exceeded !== null && typeof x.exceeded !== "string") return false;
	if (![x.modelRequests, x.gitRequests, x.inputTokens, x.outputTokens, x.costUsd].every(isCount)) return false;
	if (!l || ![l.maxModelRequests, l.maxGitRequests, l.maxTotalTokens, l.maxOutputTokens, l.maxCostUsd].every(isCount)) return false;
	if (!x.inflight || typeof x.inflight !== "object" || Array.isArray(x.inflight)) return false;
	if (x.settled !== undefined && (!Array.isArray(x.settled) || !x.settled.every((id) => typeof id === "string"))) return false;
	return Object.values(x.inflight).every((r) => !!r && isCount((r as Reservation).tokens) && isCount((r as Reservation).costUsd));
}

/** Admit or refuse one request. Once any cap is crossed the meter is exceeded for good and everything gets 429. */
export function admit(meter: Meter, req: AdmitRequest): { meter: Meter; admission: Admission } {
	if (!meter.active) return { meter, admission: { ok: false, status: 403, reason: "run is not active" } };
	if (meter.exceeded) return { meter, admission: { ok: false, status: 429, reason: `run budget exceeded: ${meter.exceeded}` } };

	const trip = (reason: string) => ({
		meter: { ...meter, exceeded: reason },
		admission: { ok: false, status: 429, reason: `run budget exceeded: ${reason}` } as Admission,
	});

	if (req.kind === "git") {
		if (meter.gitRequests + 1 > meter.limits.maxGitRequests) return trip("git request cap");
		return { meter: { ...meter, gitRequests: meter.gitRequests + 1 }, admission: { ok: true } };
	}
	// A reservation that isn't a finite non-negative figure can't be held against the budget, so it can't be admitted.
	if (!isCount(req.reserveTokens) || !isCount(req.reserveCostUsd) || req.requestId === "" || Object.hasOwn(meter.inflight, req.requestId) || meter.settled?.includes(req.requestId)) {
		return { meter, admission: { ok: false, status: 403, reason: "request cannot be metered" } };
	}
	if (meter.modelRequests + 1 > meter.limits.maxModelRequests) return trip("model request cap");
	const used = meter.inputTokens + meter.outputTokens;
	if (used + reservedTokens(meter) + req.reserveTokens > meter.limits.maxTotalTokens) return trip("token ceiling");
	if (meter.costUsd + reservedCostUsd(meter) + req.reserveCostUsd > meter.limits.maxCostUsd + COST_EPSILON_USD) return trip("cost ceiling");
	return {
		meter: {
			...meter,
			modelRequests: meter.modelRequests + 1,
			inflight: { ...meter.inflight, [req.requestId]: { tokens: req.reserveTokens, costUsd: req.reserveCostUsd } },
		},
		admission: { ok: true },
	};
}

/**
 * Replace an in-flight request's reservation with what it used. Settling an id that isn't in flight (already settled,
 * or folded in at the end of the run) changes nothing, so a repeated report can't be counted twice. A figure that is
 * not a finite non-negative number is replaced by the reservation's worst case, never by zero. A cost of zero for a
 * call that used tokens is not a cost, so it is replaced the same way (the gateway never sends one: it prices the tokens).
 */
export function recordUsage(meter: Meter, u: { requestId: string; input: number; output: number; cost?: number }): Meter {
	const held = Object.hasOwn(meter.inflight, u.requestId) ? meter.inflight[u.requestId] : undefined;
	if (!held) return meter;
	const { [u.requestId]: _settled, ...inflight } = meter.inflight;
	const usable = isCount(u.input) && isCount(u.output);
	const costUsable = isCount(u.cost) && (u.cost > 0 || (usable && u.input + u.output === 0));
	const next: Meter = {
		...meter,
		inflight,
		settled: [...(meter.settled ?? []), u.requestId],
		inputTokens: meter.inputTokens + (usable ? u.input : held.tokens),
		outputTokens: meter.outputTokens + (usable ? u.output : 0),
		costUsd: meter.costUsd + (costUsable ? u.cost! : held.costUsd),
	};
	return tripIfOver(next);
}

function tripIfOver(m: Meter): Meter {
	if (m.exceeded) return m;
	if (m.inputTokens + m.outputTokens >= m.limits.maxTotalTokens) return { ...m, exceeded: "token ceiling" };
	if (costAtCap(m.costUsd, m.limits.maxCostUsd)) return { ...m, exceeded: "cost ceiling" };
	return m;
}

/**
 * Charge every request still in flight at its reserved worst case, once, and forget it. Used when a run ends: a
 * report that never arrived (an isolate that died after forwarding the call) is paid for, not forgotten.
 */
export function settleOutstanding(meter: Meter): Meter {
	const held = Object.values(meter.inflight);
	if (held.length === 0) return meter;
	return tripIfOver({
		...meter,
		inflight: {},
		settled: [...(meter.settled ?? []), ...Object.keys(meter.inflight)],
		inputTokens: meter.inputTokens + held.reduce((a, r) => a + r.tokens, 0),
		costUsd: meter.costUsd + held.reduce((a, r) => a + r.costUsd, 0),
	});
}

export function deactivate(meter: Meter): Meter {
	return { ...meter, active: false };
}

// ---- Settling a model call ----

/** The dollar cost to reserve for a call: its worst case at the model's top rates. */
export function worstCaseCostUsd(price: ModelPrice, worstInputTokens: number, maxTokens: number): number {
	return priceTokens(price, worstInputTokens, maxTokens);
}

export interface SettleInput {
	/** The upstream answered 2xx. */
	upstreamOk: boolean;
	/** How the response body ended: all the way, or aborted/errored before the end. */
	outcome: "end" | "aborted";
	/** What the tracker read, or null when there was no usage at all. */
	seen: { input: number; output: number; cost?: number; complete: boolean } | null;
	worstInputTokens: number;
	maxTokens: number;
	price: ModelPrice;
}

/**
 * What to charge for one model call. The reported usage is used only when the response was a 2xx that ended
 * cleanly and carried a complete usage block; every other case (a non-2xx, an aborted or truncated stream, a body
 * with no usage or unparseable) is charged the worst case: the whole request body as input and max_tokens as output,
 * at the model's top rates. Whatever was seen can only raise a charge. The dollars charged are the larger of the
 * reported `cost` and the tokens times the price table, so a missing, NaN, zero or negative `cost` is priced from the
 * tokens, and a tiny positive one can't undercut them.
 */
export function settleModelCall(i: SettleInput): { input: number; output: number; cost: number } {
	const worstCost = worstCaseCostUsd(i.price, i.worstInputTokens, i.maxTokens);
	const worst = { input: i.worstInputTokens, output: i.maxTokens, cost: worstCost };
	const seen = i.seen;
	if (!i.upstreamOk || i.outcome !== "end" || !seen || !seen.complete) {
		return {
			input: Math.max(worst.input, seen?.input ?? 0),
			output: Math.max(worst.output, seen?.output ?? 0),
			cost: Math.max(worst.cost, isCount(seen?.cost) ? (seen?.cost ?? 0) : 0),
		};
	}
	const priced = priceTokens(i.price, seen.input, seen.output);
	const cost = Math.max(priced, isCount(seen.cost) ? seen.cost : 0);
	return { input: seen.input, output: seen.output, cost };
}

// ---- Streams ----

/** Pass a body through, erroring the stream if it grows past `maxBytes` (for bodies with no declared length). */
export function limitStream(body: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
	let seen = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > maxBytes) controller.error(new Error("body too large"));
				else controller.enqueue(chunk);
			},
		}),
	);
}

/**
 * Read a request body into memory, but never more than `maxBytes`: the read stops (and the rest is cancelled) as
 * soon as the bytes seen pass the cap, so a body with no declared length, or one whose declared length is a lie,
 * can't be buffered whole before it is checked. Returns null when the body is over the cap.
 */
export async function readBodyLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let seen = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			seen += value.byteLength;
			if (seen > maxBytes) {
				await reader.cancel("body too large").catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(seen);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

const MAX_PLAIN_USAGE_BYTES = 1024 * 1024;

function nested(obj: unknown, key: string): unknown {
	return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

function tokenCount(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null;
}

/**
 * Reads token usage out of an Anthropic-style response: SSE `message_start` (input, cache) and `message_delta`
 * (cumulative output) events, or a plain JSON body's `usage`. Feed it text chunks in any split.
 */
export class UsageTracker {
	private buffer = "";
	private plain = "";
	private input: number | null = null;
	private output: number | null = null;
	private cost: number | null = null;
	/** Saw the stream's closing event (`message_stop`, or a `message_delta` carrying a stop reason). */
	private finished = false;
	/** A plain JSON body parsed as a whole. */
	private parsedWhole = false;
	/** A usage field was present but not a readable token count. */
	private unreadable = false;

	feed(chunk: string): void {
		if (this.plain.length < MAX_PLAIN_USAGE_BYTES) this.plain += chunk;
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.line(line);
	}

	private line(line: string): void {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) return;
		let event: { type?: unknown; message?: { usage?: unknown }; usage?: unknown; delta?: { stop_reason?: unknown } };
		try {
			event = JSON.parse(trimmed.slice(5));
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;
		// OpenRouter reports 0 input tokens in message_start and the real figures (and cost) in message_delta.
		if (event.type === "message_start") this.take(event.message?.usage);
		else if (event.type === "message_delta") {
			this.take(event.usage);
			if (typeof event.delta?.stop_reason === "string") this.finished = true;
		} else if (event.type === "message_stop") this.finished = true;
	}

	private take(usage: unknown): void {
		if (!usage || typeof usage !== "object") return;
		const u = usage as Record<string, unknown>;
		// A field that is there but unreadable (a fraction, a negative, a string, absurdly large) is not zero: the
		// usage can no longer be trusted as complete, so the call is charged its worst case instead.
		const field = (v: unknown): number | null => {
			if (v === undefined || v === null) return null;
			const n = tokenCount(v);
			if (n === null) this.unreadable = true;
			return n;
		};
		const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(field);
		const prompt = field(u.prompt_tokens);
		if (parts.some((p) => p !== null) || prompt !== null) {
			const anthropic = parts.some((p) => p !== null) ? parts.reduce<number>((a, p) => a + (p ?? 0), 0) : 0;
			this.input = Math.max(this.input ?? 0, anthropic, prompt ?? 0);
		}
		// Reasoning tokens are billed as output. Providers include them in the output figure, but some report them only
		// separately, so the larger of the two is charged rather than trusting that they are counted.
		const reasoning = [u.reasoning_tokens, nested(u.output_tokens_details, "reasoning_tokens"), nested(u.completion_tokens_details, "reasoning_tokens")].map(field);
		const outs = [field(u.output_tokens), field(u.completion_tokens), ...reasoning];
		if (outs.some((o) => o !== null)) this.output = Math.max(this.output ?? 0, ...outs.map((o) => o ?? 0));
		// OpenRouter adds the dollar cost of the call to `usage`; keep the highest value seen (it is cumulative per message).
		const cost = u.cost;
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost < 1e6) this.cost = Math.max(this.cost ?? 0, cost);
	}

	/**
	 * Tokens seen, or null when the response carried no usage at all (the caller then charges the worst case).
	 * `complete` is false for a stream that never reached its closing event: its usage is partial.
	 */
	result(): { input: number; output: number; cost?: number; complete: boolean } | null {
		if (this.buffer) this.line(this.buffer);
		this.buffer = "";
		if (this.input === null && this.output === null && this.plain.trimStart().startsWith("{")) {
			try {
				const body = JSON.parse(this.plain) as { usage?: unknown };
				this.take(body.usage);
				this.parsedWhole = true;
			} catch {
				// Not a JSON body.
			}
		}
		if (this.input === null && this.output === null) return null;
		// A call that read a request body always has at least one input token, so zero input is not a usable figure.
		const complete = (this.finished || this.parsedWhole) && this.input !== null && this.output !== null && this.input > 0 && !this.unreadable;
		return { input: this.input ?? 0, output: this.output ?? 0, complete, ...(this.cost !== null ? { cost: this.cost } : {}) };
	}
}

/**
 * Pass a response body through unchanged while a tracker reads it. `onDone` runs exactly once: "end" when the body
 * finished, "aborted" when the reader cancelled it (the container hung up) or the upstream errored mid-stream.
 */
export function tapUsage(
	body: ReadableStream<Uint8Array>,
	tracker: UsageTracker,
	onDone: (outcome: "end" | "aborted") => void,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let done = false;
	const finish = (outcome: "end" | "aborted") => {
		if (done) return;
		done = true;
		onDone(outcome);
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done: eof, value } = await reader.read();
				if (eof) {
					tracker.feed(decoder.decode());
					finish("end");
					controller.close();
					return;
				}
				tracker.feed(decoder.decode(value, { stream: true }));
				controller.enqueue(value);
			} catch (e) {
				finish("aborted");
				controller.error(e);
			}
		},
		async cancel(reason) {
			finish("aborted");
			await reader.cancel(reason).catch(() => undefined);
		},
	});
}
