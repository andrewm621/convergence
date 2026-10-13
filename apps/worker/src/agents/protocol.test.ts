import { describe, expect, it } from "vitest";
import {
	DispatchRequest,
	authorFor,
	buildAgentPrompt,
	claudeEnv,
	commitSubject,
	isRepoGitRequest,
	parseActivity,
	pushedCommit,
	remoteParts,
} from "./protocol";

const valid = { forkRepo: "notifications-wi-1", workItemId: "wi-1", prompt: "Add status badges" };

describe("DispatchRequest", () => {
	it("accepts a valid request and defaults wait to false", () => {
		const parsed = DispatchRequest.parse(valid);
		expect(parsed).toEqual({ ...valid, wait: false });
	});

	it("accepts wait: true", () => {
		expect(DispatchRequest.parse({ ...valid, wait: true }).wait).toBe(true);
	});

	it("trims the prompt", () => {
		expect(DispatchRequest.parse({ ...valid, prompt: "  do it \n" }).prompt).toBe("do it");
	});

	it.each([
		["missing forkRepo", { workItemId: "wi-1", prompt: "x" }],
		["missing workItemId", { forkRepo: "r", prompt: "x" }],
		["missing prompt", { forkRepo: "r", workItemId: "wi-1" }],
		["empty prompt", { ...valid, prompt: "   " }],
		["oversized prompt", { ...valid, prompt: "x".repeat(16_001) }],
		["repo name with a slash", { ...valid, forkRepo: "a/b" }],
		["repo name with a leading dot", { ...valid, forkRepo: ".git" }],
		["a baseline repo", { ...valid, forkRepo: "notifications-baseline" }],
		["uppercase work item id", { ...valid, workItemId: "WI-1" }],
		["work item id with an underscore", { ...valid, workItemId: "wi_1" }],
		["work item id with a trailing hyphen", { ...valid, workItemId: "wi-" }],
		["work item id over 40 chars", { ...valid, workItemId: "a".repeat(41) }],
		["non-boolean wait", { ...valid, wait: "yes" }],
		["an unknown field", { ...valid, token: "nope" }],
		["a non-object body", "wi-1"],
		["null", null],
	])("rejects %s", (_name, body) => {
		expect(DispatchRequest.safeParse(body).success).toBe(false);
	});
});

describe("identity and prompt", () => {
	it("derives the commit author from the work item id", () => {
		expect(authorFor("wi-1")).toEqual({ name: "workitem-wi-1", email: "workitem-wi-1@delta.invalid" });
	});

	it("builds a one-line commit subject, capped at 72 chars", () => {
		expect(commitSubject("wi-2", "Implement delivery\nsecond line")).toBe("wi-2: Implement delivery");
		expect(commitSubject("wi-2", "x".repeat(200)).length).toBeLessThanOrEqual(72);
	});

	it("tells the agent to cite recordId@version and not to commit", () => {
		const prompt = buildAgentPrompt("wi-1", "Add badges");
		expect(prompt).toContain(".delta/claims.json");
		expect(prompt).toContain("<recordId>@<version>");
		expect(prompt).toContain("Do not run git commit");
		expect(prompt.endsWith("Add badges")).toBe(true);
	});
});

describe("claudeEnv", () => {
	const env = claudeEnv("anthropic/claude-sonnet-5.5");

	it("points Claude Code at OpenRouter with an empty ANTHROPIC_API_KEY", () => {
		expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
		expect(env.ANTHROPIC_API_KEY).toBe("");
	});

	it("carries only a placeholder credential; the real key is added by the Worker", () => {
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("provided-by-worker");
		expect(Object.keys(env).some((k) => k.includes("OPENROUTER"))).toBe(false);
	});

	it("pins every model class to the configured model", () => {
		for (const key of [
			"ANTHROPIC_DEFAULT_FABLE_MODEL",
			"ANTHROPIC_DEFAULT_OPUS_MODEL",
			"ANTHROPIC_DEFAULT_SONNET_MODEL",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"CLAUDE_CODE_SUBAGENT_MODEL",
		]) {
			expect(env[key]).toBe("anthropic/claude-sonnet-5.5");
		}
		expect(env.IS_SANDBOX).toBe("1");
	});
});

describe("git egress rules", () => {
	const remote = "https://acct.artifacts.cloudflare.net/git/default/notifications-wi-1.git";
	const { host, path } = remoteParts(remote);
	const u = (p: string) => new URL(`https://${host}${p}`);

	it("splits a remote into host and repo path", () => {
		expect(host).toBe("acct.artifacts.cloudflare.net");
		expect(path).toBe("/git/default/notifications-wi-1.git");
	});

	it("rejects a non-https remote", () => {
		expect(() => remoteParts("http://h/git/a.git")).toThrow();
	});

	it("allows clone and push for exactly this repo", () => {
		expect(isRepoGitRequest("GET", u(`${path}/info/refs?service=git-upload-pack`), path)).toBe(true);
		expect(isRepoGitRequest("GET", u(`${path}/info/refs?service=git-receive-pack`), path)).toBe(true);
		expect(isRepoGitRequest("POST", u(`${path}/git-upload-pack`), path)).toBe(true);
		expect(isRepoGitRequest("POST", u(`${path}/git-receive-pack`), path)).toBe(true);
	});

	it("refuses other repos, paths, services and methods", () => {
		expect(isRepoGitRequest("GET", u("/git/default/other.git/info/refs?service=git-upload-pack"), path)).toBe(false);
		expect(isRepoGitRequest("GET", u(`${path}/info/refs?service=other`), path)).toBe(false);
		expect(isRepoGitRequest("GET", u(`${path}/info/refs`), path)).toBe(false);
		expect(isRepoGitRequest("POST", u(`${path}/info/refs`), path)).toBe(false);
		expect(isRepoGitRequest("DELETE", u(`${path}/git-receive-pack`), path)).toBe(false);
		expect(isRepoGitRequest("POST", u(`${path}x/git-receive-pack`), path)).toBe(false);
		expect(isRepoGitRequest("GET", u(`${path}/../other/info/refs?service=git-upload-pack`), path)).toBe(false);
	});
});

describe("activity", () => {
	const sha = "a".repeat(40);
	const raw = [
		JSON.stringify({ workItemId: "wi-1", ts: "2026-10-13T10:00:00.000Z", kind: "clone", text: "cloning" }),
		"not json",
		JSON.stringify({ kind: "missing-fields" }),
		JSON.stringify({ workItemId: "wi-1", ts: "2026-10-13T10:00:03.000Z", kind: "push", text: `pushed ${sha}` }),
		"",
	].join("\n");

	it("keeps well-formed lines and drops the rest", () => {
		const lines = parseActivity(raw);
		expect(lines.map((l) => l.kind)).toEqual(["clone", "push"]);
	});

	it("keeps only the last `limit` lines", () => {
		expect(parseActivity(raw, 1).map((l) => l.kind)).toEqual(["push"]);
	});

	it("reads the pushed commit from the push event", () => {
		expect(pushedCommit(parseActivity(raw))).toBe(sha);
		expect(pushedCommit([])).toBeNull();
	});
});
