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

/** The protocol preamble Claude is given ahead of the task (the stub follows the same steps in code). */
export function buildAgentPrompt(workItemId: string, prompt: string): string {
	return [
		`You are the agent for work item ${workItemId}. Work only inside this repository clone.`,
		"1. Read AGENTS.md and every file under .delta/context/ (or context/ if that directory is absent).",
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

/** One line of agent activity, ready for the console's bottom strip. */
export const ActivityLine = z.object({
	workItemId: z.string(),
	ts: z.string(),
	kind: z.string(),
	text: z.string(),
});
export type ActivityLine = z.infer<typeof ActivityLine>;

/** Parse JSON-lines activity, dropping anything malformed (the file comes from the sandbox: untrusted). */
export function parseActivity(raw: string, limit = 200): ActivityLine[] {
	const lines: ActivityLine[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = ActivityLine.safeParse(JSON.parse(line));
			if (parsed.success) lines.push(parsed.data);
		} catch {
			// Skip a torn or non-JSON line.
		}
	}
	return lines.slice(-limit);
}

/** The pushed commit, from the runner's `push` event (`pushed <sha>`). */
export function pushedCommit(activity: ActivityLine[]): string | null {
	for (const a of [...activity].reverse()) {
		const m = a.kind === "push" ? /^pushed ([0-9a-f]{40})$/.exec(a.text) : null;
		if (m?.[1]) return m[1];
	}
	return null;
}
