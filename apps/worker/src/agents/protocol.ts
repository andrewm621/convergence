import { z } from "zod";

// Shared, pure pieces of the agent runtime: request validation, identity, prompt, env and event parsing.
// Nothing here touches Cloudflare APIs, so it is unit-tested directly.

export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Lowercase on purpose: the id names a Durable Object, a sandbox and the commit author. */
export const WORK_ITEM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const SandboxInstance = z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]);
export type SandboxInstance = z.infer<typeof SandboxInstance>;

export const MAX_PROMPT_CHARS = 16_000;

export const AgentMode = z.enum(["stub", "claude"]);
export type AgentMode = z.infer<typeof AgentMode>;

const RecordSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "record id must be a lowercase slug");

/** A context file name inside `.delta/context/`. */
const ContextFileName = z.string().regex(/^[a-z0-9][a-z0-9_-]*\.md$/, "context file must be <slug>.md");

/**
 * Re-run on the same fork after accepted decisions changed ("decision X changed from v1 to v2; reconcile").
 * `context` is the new context packet: files that replace the matching ones under `.delta/context/`.
 * `changes` may be empty (a claim conflict on a current receipt: no version moved) and `fromVersion` may be 0
 * (a record the work was never given, e.g. an undeclared dependency a human accepted).
 */
export const Revalidate = z.strictObject({
	changes: z
		.array(
			z
				.strictObject({
					recordId: RecordSlug,
					fromVersion: z.number().int().min(0),
					toVersion: z.number().int().min(1),
				})
				.refine((c) => c.toVersion > c.fromVersion, "toVersion must be greater than fromVersion"),
		)
		.max(20),
	context: z
		.record(ContextFileName, z.string().min(1).max(64_000))
		.refine((files) => Object.keys(files).length >= 1 && Object.keys(files).length <= 20, "1-20 context files"),
});
export type Revalidate = z.infer<typeof Revalidate>;

/** Caller-chosen key that makes a dispatch retry-safe. */
export const IdempotencyKey = z
	.string()
	.regex(/^[A-Za-z0-9._:-]{1,128}$/, "Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ : -");

/** A git ref name a caller may ask to read: no traversal, no control characters. */
export const RefName = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/, "invalid ref")
	.refine((r) => !r.includes("..") && !r.endsWith("/") && !r.endsWith(".lock"), "invalid ref");

/** An OpenRouter model slug: `vendor/name`, optionally `:variant` (or a `~vendor/name-latest` alias). */
export const ModelSlug = z
	.string()
	// Exact slugs only: no `:variant` suffix (:online, :nitro, :floor, :thinking...) and no `~alias`, either of which
	// can make OpenRouter serve a different model or add features than the one that was priced and approved.
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/, "model must be an exact OpenRouter slug like vendor/name (no :suffix, no ~alias)");

/** Comma-separated slugs -> the allowlist, with the default first and duplicates removed. Throws on a bad slug. */
export function parseModelAllowlist(csv: string | undefined, defaultModel: string): string[] {
	const parts = [defaultModel, ...(csv ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
	return [...new Set(parts.map((m) => ModelSlug.parse(m)))];
}

/** The model for a run: the requested one if it is allowlisted, the default when none is requested. */
export function resolveModel(requested: string | undefined, defaultModel: string, allowlist: string[]): { ok: true; model: string } | { ok: false; error: string } {
	const model = requested ?? defaultModel;
	return allowlist.includes(model) ? { ok: true, model } : { ok: false, error: `model ${model} is not in the allowlist (${allowlist.join(", ")})` };
}

export const DispatchRequest = z.strictObject({
	forkRepo: z
		.string()
		.regex(REPO_NAME_RE, "forkRepo must be a valid Artifacts repo name")
		// Cheap guard against pointing an agent at the baseline; dispatch also checks that the repo is a fork.
		.refine((name) => !name.endsWith("-baseline"), "forkRepo must be a fork, not a baseline"),
	workItemId: z.string().regex(WORK_ITEM_ID_RE, "workItemId must be 1-40 lowercase letters, digits or hyphens"),
	prompt: z.string().trim().min(1, "prompt is required").max(MAX_PROMPT_CHARS),
	/** Hold the response until the run finishes (fine for the stub). Otherwise it returns 202 and the caller polls. */
	wait: z.boolean().default(false),
	revalidate: Revalidate.optional(),
	/** Which allowlisted model runs this work item. Defaults to AGENT_MODEL. */
	model: ModelSlug.optional(),
});
export type DispatchRequest = z.infer<typeof DispatchRequest>;

/** The commit author for a work item. Change this one function if the naming convention moves. */
export function authorFor(workItemId: string): { name: string; email: string } {
	const name = `workitem-${workItemId}`;
	return { name, email: `${name}@delta.invalid` };
}

/** First line of the prompt, capped, as the commit subject. */
export function commitSubject(workItemId: string, prompt: string): string {
	const line = (prompt.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
	const subject = `${workItemId}: ${line}`;
	return subject.length > 72 ? `${subject.slice(0, 71)}…` : subject;
}

/** The diff-aware lead-in for a revalidation run: which decisions changed, and what to do about it. */
export function buildRevalidationPrompt(changes: Revalidate["changes"]): string {
	const lines = changes.map((c) => (c.fromVersion === 0 ? `- Decision ${c.recordId} (v${c.toVersion}) was not in your context before.` : `- Decision ${c.recordId} changed from v${c.fromVersion} to v${c.toVersion}.`));
	return [
		changes.length > 0
			? "REVALIDATION: accepted decisions changed while you worked. Reconcile your work."
			: "REVALIDATION: your claims conflict with the accepted decisions, although no decision version changed. Reconcile your work.",
		...lines,
		"The new versions are in .delta/context/ (see .delta/receipt.json for what was delivered). Update the code and .delta/claims.json",
		"so they follow the new versions, and cite the new recordId@version on every claim.",
	].join("\n");
}

/** The protocol preamble Claude is given ahead of the task (the stub follows the same steps in code). */
export function buildAgentPrompt(workItemId: string, prompt: string): string {
	return [
		`You are the agent for work item ${workItemId}. Work only inside this repository clone.`,
		"1. Read AGENTS.md and every file under .delta/context/ and context/ (a file in .delta/context/ replaces the same name in context/).",
		"2. Do the task below. Build from the context you were given.",
		'3. Write .delta/claims.json: a JSON array of {"subject": "<facet key>", "value": <value>, "basedOn": "<recordId>@<version>"}',
		"   with one entry for every decision you relied on. Cite the exact record version you read.",
		"4. Do not run git commit or git push. The runner commits and pushes for you.",
		"",
		"Task:",
		prompt,
	].join("\n");
}

/** Claude Code through OpenRouter's Anthropic-compatible endpoint. The key itself never enters the container. */
export function claudeEnv(model: string, maxOutputTokens = 8192): Record<string, string> {
	return {
		ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
		// Claude Code needs a credential to start; ModelGateway replaces this header with the real key.
		ANTHROPIC_AUTH_TOKEN: "provided-by-worker",
		// OpenRouter requires this to be explicitly empty so Claude Code does not try Anthropic directly.
		ANTHROPIC_API_KEY: "",
		// Pin every model class so no sub-agent or background call picks a model we did not choose.
		ANTHROPIC_DEFAULT_FABLE_MODEL: model,
		ANTHROPIC_DEFAULT_OPUS_MODEL: model,
		ANTHROPIC_DEFAULT_SONNET_MODEL: model,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
		ANTHROPIC_SMALL_FAST_MODEL: model,
		CLAUDE_CODE_SUBAGENT_MODEL: model,
		// Keep Claude Code under the gateway's own ceiling so normal requests are never clamped.
		CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		IS_SANDBOX: "1",
	};
}

/** The `model` a request body asks for, or null when the body is not a JSON object with a string model. */
export function requestedModel(bodyText: string): string | null {
	try {
		const body: unknown = JSON.parse(bodyText);
		const model = body && typeof body === "object" ? (body as { model?: unknown }).model : undefined;
		return typeof model === "string" ? model : null;
	} catch {
		return null;
	}
}

/** Stable SHA-256 over the parts of a dispatch that define it, so a replayed key can be told from a reused one. */
export async function dispatchFingerprint(
	req: Pick<DispatchRequest, "forkRepo" | "workItemId" | "prompt" | "revalidate" | "model">,
): Promise<string> {
	const canonical = JSON.stringify([
		req.forkRepo,
		req.workItemId,
		req.prompt,
		req.model ?? null,
		req.revalidate
			? [req.revalidate.changes, Object.entries(req.revalidate.context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]
			: null,
	]);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Repo path on the git host, from the repo's remote URL: `https://host/git/ns/name.git` -> `/git/ns/name.git`. */
export function remoteParts(remote: string): { host: string; path: string } {
	const url = new URL(remote);
	if (url.protocol !== "https:") throw new Error("remote must be https");
	return { host: url.hostname, path: url.pathname.replace(/\/+$/, "") };
}

// ---- Everything the container writes is untrusted: validate, cap, strip, and never let it decide state. ----

export const MAX_EVENTS_BYTES = 256 * 1024;
export const MAX_EVENT_LINE_CHARS = 4_000;
export const MAX_ACTIVITY_LINES = 200;
export const MAX_ACTIVITY_TEXT_CHARS = 500;

/** Replace control characters (C0, DEL, C1, line/paragraph separators, bidi controls) so output can't forge lines or escape sequences. */
export function stripControl(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}

export function sanitizeText(text: string, max = MAX_ACTIVITY_TEXT_CHARS): string {
	const flat = stripControl(text).replace(/ {2,}/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line of agent activity, ready for the console's bottom strip. Agent-reported, so display only. */
export const ActivityLine = z.object({
	workItemId: z.string(),
	ts: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "ts must be a date"),
	kind: z.string().regex(/^[a-z][a-z_-]{0,23}$/),
	text: z.string(),
});
export type ActivityLine = z.infer<typeof ActivityLine>;

/**
 * Parse JSON-lines activity from the sandbox. Oversized input is cut, malformed or oversized lines are dropped,
 * and only the fields we define survive. `workItemId` is set from the trusted run, never from the file.
 */
export function parseActivity(raw: string, opts: { workItemId: string; limit?: number }): ActivityLine[] {
	const limit = Math.min(opts.limit ?? MAX_ACTIVITY_LINES, MAX_ACTIVITY_LINES);
	const lines: ActivityLine[] = [];
	for (const line of raw.slice(0, MAX_EVENTS_BYTES).split("\n")) {
		if (!line.trim() || line.length > MAX_EVENT_LINE_CHARS) continue;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			continue; // a torn or non-JSON line
		}
		const parsed = ActivityLine.safeParse(json);
		if (!parsed.success) continue;
		const text = sanitizeText(parsed.data.text);
		if (!text) continue;
		lines.push({
			workItemId: opts.workItemId,
			ts: new Date(parsed.data.ts).toISOString(),
			kind: parsed.data.kind,
			text,
		});
	}
	return lines.slice(-limit);
}

/** The push SHA the runner says it made (`pushed <sha>`). A claim only: see verifyPush. */
export function claimedPushSha(activity: ActivityLine[]): string | null {
	for (const a of [...activity].reverse()) {
		const m = a.kind === "push" ? /^pushed ([0-9a-f]{40})$/.exec(a.text) : null;
		if (m?.[1]) return m[1];
	}
	return null;
}

/** Strict exit-code file: one to three digits. Anything else is not an exit code. */
export function parseExitCode(text: string | undefined): number | null {
	const m = text === undefined ? null : /^(\d{1,3})\s*$/.exec(text);
	return m?.[1] ? Number(m[1]) : null;
}

/** Read at most `maxBytes` of a stream as text, then cancel it. A huge or endless file can't fill the Durable Object's memory. */
export async function readCappedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			const room = maxBytes - size;
			const piece = value.byteLength > room ? value.subarray(0, room) : value;
			chunks.push(piece);
			size += piece.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const all = new Uint8Array(size);
	let offset = 0;
	for (const c of chunks) {
		all.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(all);
}

const SHA_RE = /^[0-9a-f]{40}$/;
const isSha = (v: unknown): v is string => typeof v === "string" && SHA_RE.test(v);

export interface HeadCommit {
	hash: string;
	author: string;
	parents: string[];
}

export type PushVerdict = { ok: true; commit: string | null } | { ok: false; error: string };

/**
 * Decide what a run actually did from the fork's real history (read through the Artifacts binding), using the
 * container's claim only as something to check. `recent` is newest first; `baseHead` was read before the run.
 *
 * Fails closed: every input must be present and well-formed, the base head must be visible in `recent` (so a
 * truncated or rewritten history can't pass), and the new commits must be a plain linear chain from the head
 * down to the base, all authored by the work item. Anything else is a failure, never a pass.
 */
export function verifyPush(input: {
	baseHead: string | null;
	recent: HeadCommit[];
	expectedAuthor: string;
	claimedSha: string | null;
}): PushVerdict {
	const fail = (error: string): PushVerdict => ({ ok: false, error });
	if (typeof input.expectedAuthor !== "string" || input.expectedAuthor === "") return fail("no expected author to verify against");
	if (!isSha(input.baseHead)) return fail("the fork head before the run is unknown");
	if (input.claimedSha !== null && !isSha(input.claimedSha)) return fail("runner reported a malformed push");
	const recent = input.recent;
	if (!Array.isArray(recent) || recent.length === 0) return fail("could not read the fork history to verify the push");
	for (const c of recent) {
		const ok =
			c !== null &&
			typeof c === "object" &&
			isSha(c.hash) &&
			typeof c.author === "string" &&
			Array.isArray(c.parents) &&
			c.parents.every(isSha);
		if (!ok) return fail("the fork history is malformed");
	}

	const head = recent[0] as HeadCommit;
	if (head.hash === input.baseHead) {
		return input.claimedSha ? fail("runner reported a push but the fork head did not move") : { ok: true, commit: null };
	}

	const baseIndex = recent.findIndex((c) => c.hash === input.baseHead);
	if (baseIndex < 0) return fail("the fork head before the run is not in its recent history (truncated or rewritten)");
	for (let i = 0; i < baseIndex; i++) {
		const c = recent[i] as HeadCommit;
		if (c.author !== input.expectedAuthor) return fail(`fork head moved with a commit not authored by ${input.expectedAuthor}`);
		if (c.parents.length !== 1 || c.parents[0] !== (recent[i + 1] as HeadCommit).hash) {
			return fail("the new commits are not a plain linear chain from the base");
		}
	}
	if (input.claimedSha && input.claimedSha !== head.hash) return fail("runner reported a push that does not match the fork head");
	return { ok: true, commit: head.hash };
}

export type ReceiptVerdict = { ok: true } | { ok: false; error: string };

const MAX_RECEIPT_BYTES = 64 * 1024;

const ReceiptSchema = z.strictObject({
	kind: z.literal("revalidation"),
	workItemId: z.string(),
	baseCommit: z.string().regex(SHA_RE),
	changes: z.array(z.strictObject({ recordId: z.string(), fromVersion: z.number().int(), toVersion: z.number().int() })),
	delivered: z.array(
		z.strictObject({ file: z.string(), recordId: z.string(), version: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
	),
});

/**
 * Check the `.delta/receipt.json` found at the pushed commit against the receipt the Worker computed from what it
 * sent. They must be identical: a missing, malformed, oversized or altered receipt fails.
 */
export function verifyReceiptText(text: string | null | undefined, expected: z.input<typeof ReceiptSchema>): ReceiptVerdict {
	const fail = (error: string): ReceiptVerdict => ({ ok: false, error });
	if (typeof text !== "string" || text === "") return fail("the revalidation receipt is missing from the pushed commit");
	if (text.length > MAX_RECEIPT_BYTES) return fail("the revalidation receipt is too large");
	let actual: z.infer<typeof ReceiptSchema>;
	let want: z.infer<typeof ReceiptSchema>;
	try {
		const a = ReceiptSchema.safeParse(JSON.parse(text));
		const w = ReceiptSchema.safeParse(expected);
		if (!a.success) return fail("the revalidation receipt is malformed");
		if (!w.success) return fail("no valid expected receipt to check against");
		actual = a.data;
		want = w.data;
	} catch {
		return fail("the revalidation receipt is not valid JSON");
	}
	return JSON.stringify(actual) === JSON.stringify(want) ? { ok: true } : fail("the revalidation receipt does not match what was delivered");
}

export type RunOutcome = { state: "succeeded" | "failed" | "lost"; error: string | null; commit: string | null; pushVerified: boolean | null };

/**
 * The single place a run can become `succeeded`: the runner said so, the fork history verified, and (for a
 * revalidation) the receipt matched. A verification that threw, timed out or never ran (`undefined`) is a failure.
 */
export function decideRun(input: {
	runner: "succeeded" | "failed" | "lost";
	runnerError: string | null;
	verification: PushVerdict | undefined;
	receipt: { required: boolean; result: ReceiptVerdict | undefined };
}): RunOutcome {
	if (input.runner !== "succeeded") return { state: input.runner, error: input.runnerError, commit: null, pushVerified: null };
	const failed = (error: string): RunOutcome => ({ state: "failed", error, commit: null, pushVerified: false });
	const v = input.verification;
	if (!v) return failed("could not verify the push against the fork history");
	if (!v.ok) return failed(v.error);
	if (input.receipt.required) {
		if (v.commit === null) return failed("revalidation produced no commit");
		const r = input.receipt.result;
		if (!r) return failed("could not verify the revalidation receipt");
		if (!r.ok) return failed(r.error);
	}
	return { state: "succeeded", error: null, commit: v.commit, pushVerified: true };
}

/** Reject if `work` doesn't settle in time. The timer is cleared either way. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
