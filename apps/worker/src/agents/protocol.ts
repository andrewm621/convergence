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
 */
export const Revalidate = z.strictObject({
	changes: z
		.array(
			z
				.strictObject({
					recordId: RecordSlug,
					fromVersion: z.number().int().min(1),
					toVersion: z.number().int().min(2),
				})
				.refine((c) => c.toVersion > c.fromVersion, "toVersion must be greater than fromVersion"),
		)
		.min(1)
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
	const lines = changes.map((c) => `- Decision ${c.recordId} changed from v${c.fromVersion} to v${c.toVersion}.`);
	return [
		"REVALIDATION: accepted decisions changed while you worked. Reconcile your work.",
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
export function claudeEnv(model: string): Record<string, string> {
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
		CLAUDE_CODE_SUBAGENT_MODEL: model,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		IS_SANDBOX: "1",
	};
}

/** The only model call Claude Code makes through ModelGateway: the Anthropic Messages endpoint (`?beta=true` is allowed). */
export function isModelRequest(method: string, url: URL): boolean {
	return method === "POST" && url.pathname === "/api/v1/messages";
}

/** Plain https on the default port, with no embedded credentials: the only URL shape a credential may be added to. */
function isPlainHttps(url: URL, host: string): boolean {
	return url.protocol === "https:" && url.hostname === host && url.port === "" && url.username === "" && url.password === "";
}

/** May the Artifacts token be added to this request? Exact host, exact repo, git smart-HTTP endpoints only. */
export function allowGitCredential(method: string, url: URL, host: string, repoPath: string): boolean {
	return isPlainHttps(url, host) && isRepoGitRequest(method, url, repoPath);
}

/** May the model key be added to this request? Exact host, the Messages endpoint only. */
export function allowModelCredential(method: string, url: URL): boolean {
	return isPlainHttps(url, "openrouter.ai") && isModelRequest(method, url);
}

/** Largest model request body ModelGateway will buffer to check the model. */
export const MAX_MODEL_BODY_BYTES = 8 * 1024 * 1024;

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
export async function dispatchFingerprint(req: Pick<DispatchRequest, "forkRepo" | "workItemId" | "prompt" | "revalidate">): Promise<string> {
	const canonical = JSON.stringify([
		req.forkRepo,
		req.workItemId,
		req.prompt,
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

/**
 * Is this request a git smart-HTTP call against exactly this repo? Anything else (other repos, other
 * paths, other methods) is refused, so a sandbox cannot use the injected token elsewhere.
 */
export function isRepoGitRequest(method: string, url: URL, repoPath: string): boolean {
	if (method === "GET" && url.pathname === `${repoPath}/info/refs`) {
		const service = url.searchParams.get("service");
		return service === "git-upload-pack" || service === "git-receive-pack";
	}
	return (
		method === "POST" && (url.pathname === `${repoPath}/git-upload-pack` || url.pathname === `${repoPath}/git-receive-pack`)
	);
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

export interface HeadCommit {
	hash: string;
	author: string;
}

export type PushVerdict = { ok: true; commit: string | null } | { ok: false; error: string };

/**
 * Decide what a run actually did from the fork's real history (read through the Artifacts binding), using the
 * container's claim only as something to check. `recent` is newest first; `baseHead` was read before the run.
 */
export function verifyPush(input: {
	baseHead: string | null;
	recent: HeadCommit[];
	expectedAuthor: string;
	claimedSha: string | null;
}): PushVerdict {
	const head = input.recent[0];
	if (!head) return { ok: false, error: "could not read the fork history to verify the push" };

	if (head.hash === input.baseHead) {
		return input.claimedSha
			? { ok: false, error: "runner reported a push but the fork head did not move" }
			: { ok: true, commit: null };
	}

	const baseIndex = input.baseHead ? input.recent.findIndex((c) => c.hash === input.baseHead) : -1;
	const added = baseIndex >= 0 ? input.recent.slice(0, baseIndex) : input.recent;
	if (added.some((c) => c.author !== input.expectedAuthor)) {
		return { ok: false, error: `fork head moved with a commit not authored by ${input.expectedAuthor}` };
	}
	if (input.claimedSha && input.claimedSha !== head.hash) {
		return { ok: false, error: "runner reported a push that does not match the fork head" };
	}
	return { ok: true, commit: head.hash };
}
