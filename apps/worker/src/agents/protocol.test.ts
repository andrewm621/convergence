import { describe, expect, it } from "vitest";
import {
	DispatchRequest,
	authorFor,
	buildAgentPrompt,
	claudeEnv,
	commitSubject,
	isRepoGitRequest,
	parseActivity,
	remoteParts,
	IdempotencyKey,
	MAX_ACTIVITY_LINES,
	MAX_ACTIVITY_TEXT_CHARS,
	MAX_EVENT_LINE_CHARS,
	RefName,
	Revalidate,
	allowGitCredential,
	allowModelCredential,
	buildRevalidationPrompt,
	claimedPushSha,
	dispatchFingerprint,
	parseExitCode,
	readCappedText,
	requestedModel,
	sanitizeText,
	stripControl,
	verifyPush,
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

describe("gateway credential rules", () => {
	const host = "acct.artifacts.cloudflare.net";
	const path = "/git/default/wi-1.git";
	const git = (method: string, rest: string) => allowGitCredential(method, new URL(`https://${host}${rest}`), host, path);

	it("adds the Artifacts token only for this repo's smart-HTTP endpoints", () => {
		expect(git("POST", `${path}/git-receive-pack`)).toBe(true);
		expect(git("GET", `${path}/info/refs?service=git-upload-pack`)).toBe(true);
	});

	it("refuses a plain-http, wrong-host, wrong-port or credentialed URL even for the right path", () => {
		const ok = `${path}/git-receive-pack`;
		expect(allowGitCredential("POST", new URL(`http://${host}${ok}`), host, path)).toBe(false);
		expect(allowGitCredential("POST", new URL(`https://evil.example${ok}`), host, path)).toBe(false);
		expect(allowGitCredential("POST", new URL(`https://${host}:8443${ok}`), host, path)).toBe(false);
		expect(allowGitCredential("POST", new URL(`https://u:p@${host}${ok}`), host, path)).toBe(false);
	});

	it("refuses encoded or dotted paths that are not exactly this repo", () => {
		expect(git("POST", "/git/default/wi-1.git/%2e%2e/other.git/git-receive-pack")).toBe(false);
		expect(git("POST", "/git/default/wi-2.git/git-receive-pack")).toBe(false);
		expect(git("POST", `${path}/git-receive-pack/extra`)).toBe(false);
	});

	it("adds the model key only for POST https://openrouter.ai/api/v1/messages", () => {
		const m = (method: string, u: string) => allowModelCredential(method, new URL(u));
		expect(m("POST", "https://openrouter.ai/api/v1/messages")).toBe(true);
		expect(m("POST", "https://openrouter.ai/api/v1/messages?beta=true")).toBe(true);
		expect(m("GET", "https://openrouter.ai/api/v1/messages")).toBe(false);
		expect(m("GET", "https://openrouter.ai/api/v1/models")).toBe(false);
		expect(m("POST", "https://openrouter.ai/api/v1/chat/completions")).toBe(false);
		expect(m("POST", "https://openrouter.ai/api/v1/messages/count_tokens")).toBe(false);
		expect(m("POST", "https://openrouter.ai/api/v1/credits")).toBe(false);
		expect(m("POST", "http://openrouter.ai/api/v1/messages")).toBe(false);
		expect(m("POST", "https://openrouter.ai.evil.example/api/v1/messages")).toBe(false);
		expect(m("POST", "https://openrouter.ai:444/api/v1/messages")).toBe(false);
		expect(m("POST", "https://x:y@openrouter.ai/api/v1/messages")).toBe(false);
	});

	it("reads the requested model out of a body, or null", () => {
		expect(requestedModel('{"model":"anthropic/claude-sonnet-5.5","messages":[]}')).toBe("anthropic/claude-sonnet-5.5");
		expect(requestedModel('{"messages":[]}')).toBeNull();
		expect(requestedModel('{"model":5}')).toBeNull();
		expect(requestedModel("not json")).toBeNull();
		expect(requestedModel("[]")).toBeNull();
	});
});

describe("untrusted container output", () => {
	const sha = "a".repeat(40);
	const line = (o: object) => JSON.stringify({ workItemId: "wi-1", ts: "2026-10-13T10:00:00.000Z", kind: "note", text: "x", ...o });
	const parse = (raw: string, limit?: number) => parseActivity(raw, { workItemId: "wi-1", limit });

	it("keeps well-formed lines and drops the rest", () => {
		const raw = [line({ kind: "clone", text: "cloning" }), "not json", JSON.stringify({ kind: "missing-fields" }), line({ kind: "push" })].join("\n");
		expect(parse(raw).map((l) => l.kind)).toEqual(["clone", "push"]);
	});

	it("takes the work item id from the run, not from the file", () => {
		expect(parse(line({ workItemId: "wi-999" }))[0]?.workItemId).toBe("wi-1");
	});

	it("rejects bad kinds and bad timestamps", () => {
		const raw = [line({ kind: "Bad Kind" }), line({ kind: "x".repeat(40) }), line({ ts: "yesterday" }), line({ ts: 12345 })].join("\n");
		expect(parse(raw)).toEqual([]);
	});

	it("strips control characters, ANSI escapes and line separators from text", () => {
		const out = parse(line({ text: "ok\u001b[31m red\u0007\u0000\u2028forged" }))[0]?.text ?? "";
		expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028]/);
		expect(out).toContain("ok");
		expect(stripControl("a\u0085b\u202ec")).toBe("a b c");
	});

	it("cuts long text, drops lines over the length cap and caps the number of lines", () => {
		const long = parse(line({ text: "y".repeat(3000) }));
		expect(long[0]?.text.length).toBeLessThanOrEqual(MAX_ACTIVITY_TEXT_CHARS);
		expect(parse(line({ text: "z".repeat(MAX_EVENT_LINE_CHARS) }))).toEqual([]);
		const many = Array.from({ length: 5000 }, (_, i) => line({ text: `n${i}` })).join("\n");
		expect(parse(many).length).toBeLessThanOrEqual(MAX_ACTIVITY_LINES);
		expect(parse(many, 1).length).toBe(1);
	});

	it("ignores everything past the byte cap", () => {
		const filler = `${"q".repeat(MAX_EVENT_LINE_CHARS + 10)}\n`.repeat(100);
		expect(parse(`${filler}${line({ text: "late" })}`)).toEqual([]);
	});

	it("parses a strict exit code only", () => {
		expect(parseExitCode("0\n")).toBe(0);
		expect(parseExitCode("137")).toBe(137);
		for (const bad of [undefined, "", "abc", "1; rm -rf /", "-1", "0x10", "99999", "0\nforged"]) expect(parseExitCode(bad)).toBeNull();
	});

	it("reads a capped amount of a huge or endless stream, then stops", async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new TextEncoder().encode("A".repeat(1024)));
			},
		});
		const text = await readCappedText(endless, 4096);
		expect(text.length).toBe(4096);
		expect(pulled).toBeLessThan(20);
		expect(await readCappedText(null, 10)).toBe("");
	});

	it("sanitizes free text", () => {
		expect(sanitizeText("  a\n\nb  ")).toBe("a b");
	});

	describe("claimed push SHA", () => {
		it("is read from a push event but only as a claim", () => {
			const act = parse([line({ kind: "push", text: `pushed ${sha}` })].join("\n"));
			expect(claimedPushSha(act)).toBe(sha);
			expect(claimedPushSha([])).toBeNull();
			expect(claimedPushSha(parse(line({ kind: "push", text: "pushed nothing" })))).toBeNull();
		});
	});

	describe("verifyPush", () => {
		const base = "b".repeat(40);
		const real = "c".repeat(40);
		const author = "workitem-wi-1";
		const recent = (...c: [string, string][]) => c.map(([hash, a]) => ({ hash, author: a }));

		it("accepts a real push by the right author and reports the real head", () => {
			expect(verifyPush({ baseHead: base, recent: recent([real, author], [base, "seed"]), expectedAuthor: author, claimedSha: real })).toEqual({
				ok: true,
				commit: real,
			});
		});

		it("accepts a real push even when the runner reported nothing", () => {
			expect(verifyPush({ baseHead: base, recent: recent([real, author], [base, "seed"]), expectedAuthor: author, claimedSha: null }).ok).toBe(true);
		});

		it("rejects a forged push SHA that does not match the fork head", () => {
			const v = verifyPush({ baseHead: base, recent: recent([real, author], [base, "seed"]), expectedAuthor: author, claimedSha: sha });
			expect(v.ok).toBe(false);
		});

		it("rejects a claimed push when the fork head never moved", () => {
			const v = verifyPush({ baseHead: base, recent: recent([base, "seed"]), expectedAuthor: author, claimedSha: sha });
			expect(v).toMatchObject({ ok: false });
		});

		it("accepts a run that changed nothing and claimed nothing", () => {
			expect(verifyPush({ baseHead: base, recent: recent([base, "seed"]), expectedAuthor: author, claimedSha: null })).toEqual({ ok: true, commit: null });
		});

		it("rejects a head commit authored by someone else", () => {
			const v = verifyPush({ baseHead: base, recent: recent([real, "workitem-wi-2"], [base, "seed"]), expectedAuthor: author, claimedSha: real });
			expect(v.ok).toBe(false);
		});

		it("rejects when any new commit has a foreign author", () => {
			const v = verifyPush({ baseHead: base, recent: recent([real, author], ["d".repeat(40), "intruder"], [base, "seed"]), expectedAuthor: author, claimedSha: real });
			expect(v.ok).toBe(false);
		});

		it("fails closed when the fork history could not be read", () => {
			expect(verifyPush({ baseHead: base, recent: [], expectedAuthor: author, claimedSha: real }).ok).toBe(false);
		});
	});
});

describe("revalidation and idempotency inputs", () => {
	const context = { "notifications.md": "---\nid: notifications\nversion: 2\n---\n# n\n" };
	const changes = [{ recordId: "notifications", fromVersion: 1, toVersion: 2 }];

	it("accepts a well-formed revalidate block on a dispatch", () => {
		const parsed = DispatchRequest.parse({ ...valid, revalidate: { changes, context } });
		expect(parsed.revalidate?.changes[0]?.toVersion).toBe(2);
	});

	it.each([
		["no changes", { changes: [], context }],
		["no context", { changes, context: {} }],
		["downgrade", { changes: [{ recordId: "notifications", fromVersion: 2, toVersion: 2 }], context }],
		["bad record id", { changes: [{ recordId: "Not A Slug", fromVersion: 1, toVersion: 2 }], context }],
		["context path escape", { changes, context: { "../x.md": "text" } }],
		["context not markdown", { changes, context: { "x.sh": "text" } }],
		["oversized context file", { changes, context: { "n.md": "x".repeat(64_001) } }],
		["unknown field", { changes, context, extra: 1 }],
	])("rejects revalidate with %s", (_n, body) => {
		expect(Revalidate.safeParse(body).success).toBe(false);
	});

	it("writes the diff-aware prompt", () => {
		expect(buildRevalidationPrompt(changes)).toContain("Decision notifications changed from v1 to v2.");
	});

	it("validates Idempotency-Key and ref names", () => {
		expect(IdempotencyKey.safeParse("run-123:abc").success).toBe(true);
		for (const bad of [undefined, "", "a b", "x".repeat(129), "a/b"]) expect(IdempotencyKey.safeParse(bad).success).toBe(false);
		for (const ok of ["main", "refs/notes/delta", "a".repeat(40)]) expect(RefName.safeParse(ok).success).toBe(true);
		for (const bad of ["", "../x", "a..b", "-rf", "a b", "x/", "main.lock", "a\nb"]) expect(RefName.safeParse(bad).success).toBe(false);
	});

	it("fingerprints a dispatch stably and tells different requests apart", async () => {
		const a = await dispatchFingerprint(valid);
		expect(await dispatchFingerprint({ ...valid })).toBe(a);
		expect(await dispatchFingerprint({ ...valid, prompt: "other" })).not.toBe(a);
		expect(await dispatchFingerprint({ ...valid, revalidate: { changes, context } })).not.toBe(a);
	});
});
