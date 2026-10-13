// Pure logic behind the outbound gateways: URL allowlisting in one canonical form, request-body checks, the
// per-run meter, and stream helpers. No Workers APIs, so every rule here is unit-tested under Node.
//
// None of this trusts the container. It controls Claude Code's flags, its environment and every byte of every
// request, so the caps below are enforced by the gateways, not requested of the agent.

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

export type ModelPrep =
	| { ok: true; body: string; maxTokens: number; estInputTokens: number }
	| { ok: false; status: 400 | 403; reason: string };

/**
 * Check a model request body against the run's pin and output ceiling: the model must be exactly the pinned one,
 * `max_tokens` must be a positive integer and is clamped to the ceiling (with any extended-thinking budget kept
 * below it). Returns the body to forward, which is rewritten only when something was clamped.
 */
export function prepareModelBody(bodyText: string, bodyBytes: number, pinnedModel: string, maxOutputTokens: number): ModelPrep {
	let json: unknown;
	try {
		json = JSON.parse(bodyText);
	} catch {
		return { ok: false, status: 400, reason: "request body is not valid JSON" };
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, status: 400, reason: "request body must be a JSON object" };
	const body = json as Record<string, unknown>;

	if (typeof body.model !== "string" || body.model !== pinnedModel) return { ok: false, status: 403, reason: "model not allowed for this run" };
	const requested = body.max_tokens;
	if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
		return { ok: false, status: 400, reason: "max_tokens must be a positive integer" };
	}

	const maxTokens = Math.min(requested, maxOutputTokens);
	let text = bodyText;
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
		text = JSON.stringify(body);
	}
	return { ok: true, body: text, maxTokens, estInputTokens: Math.ceil(bodyBytes / 3) };
}

// ---- Per-run meter ----

export interface RunLimits {
	maxModelRequests: number;
	maxGitRequests: number;
	/** Input plus output tokens, across the run. */
	maxTotalTokens: number;
	/** Ceiling on a single request's max_tokens. */
	maxOutputTokens: number;
	/** Dollars, summed from the `usage.cost` OpenRouter reports. */
	maxCostUsd: number;
}

export const DEFAULT_LIMITS: RunLimits = {
	maxModelRequests: 40,
	maxGitRequests: 60,
	maxTotalTokens: 1_000_000,
	maxOutputTokens: 8192,
	maxCostUsd: 0.25,
};

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
	/** Dollars reported by the upstream so far. */
	costUsd: number;
	/** Worst-case tokens held for requests that have been admitted but not yet reported. */
	reserved: number;
	limits: RunLimits;
}

export type Admission = { ok: true } | { ok: false; status: 403 | 429; reason: string };

export type AdmitRequest = { kind: "model"; reserve: number } | { kind: "git" };

export function newMeter(runId: string, limits: RunLimits): Meter {
	return { runId, active: true, exceeded: null, modelRequests: 0, gitRequests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, reserved: 0, limits };
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
	if (meter.modelRequests + 1 > meter.limits.maxModelRequests) return trip("model request cap");
	const used = meter.inputTokens + meter.outputTokens;
	if (used + meter.reserved + req.reserve > meter.limits.maxTotalTokens) return trip("token ceiling");
	return {
		meter: { ...meter, modelRequests: meter.modelRequests + 1, reserved: meter.reserved + req.reserve },
		admission: { ok: true },
	};
}

/** Replace a request's reservation with what it really used (or the conservative count when none was reported). */
export function recordUsage(meter: Meter, u: { reserved: number; input: number; output: number; cost?: number }): Meter {
	const next: Meter = {
		...meter,
		reserved: Math.max(0, meter.reserved - u.reserved),
		inputTokens: meter.inputTokens + Math.max(0, u.input),
		outputTokens: meter.outputTokens + Math.max(0, u.output),
		costUsd: meter.costUsd + (Number.isFinite(u.cost) ? Math.max(0, u.cost ?? 0) : 0),
	};
	if (!next.exceeded && next.inputTokens + next.outputTokens >= next.limits.maxTotalTokens) next.exceeded = "token ceiling";
	if (!next.exceeded && next.costUsd >= next.limits.maxCostUsd) next.exceeded = "cost ceiling";
	return next;
}

export function deactivate(meter: Meter): Meter {
	return { ...meter, active: false };
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

const MAX_PLAIN_USAGE_BYTES = 1024 * 1024;

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
		let event: { type?: unknown; message?: { usage?: unknown }; usage?: unknown };
		try {
			event = JSON.parse(trimmed.slice(5));
		} catch {
			return;
		}
		if (!event || typeof event !== "object") return;
		// OpenRouter reports 0 input tokens in message_start and the real figures (and cost) in message_delta.
		if (event.type === "message_start") this.take(event.message?.usage);
		else if (event.type === "message_delta") this.take(event.usage);
	}

	private take(usage: unknown): void {
		if (!usage || typeof usage !== "object") return;
		const u = usage as Record<string, unknown>;
		const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(tokenCount);
		if (parts.some((p) => p !== null)) this.input = Math.max(this.input ?? 0, parts.reduce<number>((a, p) => a + (p ?? 0), 0));
		const out = tokenCount(u.output_tokens);
		if (out !== null) this.output = Math.max(this.output ?? 0, out);
		// OpenRouter adds the dollar cost of the call to `usage`; keep the highest value seen (it is cumulative per message).
		const cost = u.cost;
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost < 1e6) this.cost = Math.max(this.cost ?? 0, cost);
	}

	/** Tokens seen, or null when the response carried no usage at all (the caller then counts conservatively). */
	result(): { input: number; output: number; cost?: number } | null {
		if (this.buffer) this.line(this.buffer);
		this.buffer = "";
		if (this.input === null && this.output === null && this.plain.trimStart().startsWith("{")) {
			try {
				const body = JSON.parse(this.plain) as { usage?: unknown };
				this.take(body.usage);
			} catch {
				// Not a JSON body.
			}
		}
		if (this.input === null && this.output === null) return null;
		return { input: this.input ?? 0, output: this.output ?? 0, ...(this.cost !== null ? { cost: this.cost } : {}) };
	}
}

/** Pass a response body through unchanged while a tracker reads it; `onDone` runs once the stream ends. */
export function tapUsage(body: ReadableStream<Uint8Array>, tracker: UsageTracker, onDone: () => void): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				tracker.feed(decoder.decode(chunk, { stream: true }));
				controller.enqueue(chunk);
			},
			flush() {
				tracker.feed(decoder.decode());
				onDone();
			},
		}),
	);
}
