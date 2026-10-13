import { describe, expect, it } from "vitest";
import {
	DispatchRequest,
	authorFor,
	buildAgentPrompt,
	claudeEnv,
	commitSubject,
	parseActivity,
	remoteParts,
	IdempotencyKey,
	MAX_ACTIVITY_LINES,
	MAX_ACTIVITY_TEXT_CHARS,
	MAX_EVENT_LINE_CHARS,
	RefName,
	Revalidate,
	buildRevalidationPrompt,
	claimedPushSha,
	dispatchFingerprint,
	parseExitCode,
	readCappedText,
	requestedModel,
	sanitizeText,
	stripControl,
	decideRun,
	verifyPush,
	verifyReceiptText,
	withTimeout,
	ContainerTimeoutError,
	settleWithin,
	withDeadline,
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

	it("keeps Claude Code's own output ceiling at the gateway's, so normal calls are not clamped", () => {
		expect(claudeEnv("a/b", 4096).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("4096");
		expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("8192");
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
		expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("anthropic/claude-sonnet-5.5");
		expect(env.IS_SANDBOX).toBe("1");
	});
});

describe("remote parts", () => {
	const remote = "https://acct.artifacts.cloudflare.net/git/default/notifications-wi-1.git";
	const { host, path } = remoteParts(remote);

	it("splits a remote into host and repo path", () => {
		expect(host).toBe("acct.artifacts.cloudflare.net");
		expect(path).toBe("/git/default/notifications-wi-1.git");
	});

	it("rejects a non-https remote", () => {
		expect(() => remoteParts("http://h/git/a.git")).toThrow();
	});
});

describe("requestedModel", () => {
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
		const mid = "d".repeat(40);
		const author = "workitem-wi-1";
		// Newest first; each commit's parent is the next one in the list, like a real linear history.
		const history = (...c: [string, string][]) =>
			c.map(([hash, a], i) => ({ hash, author: a, parents: c[i + 1] ? [c[i + 1]![0]] : [] }));
		const verify = (over: Partial<Parameters<typeof verifyPush>[0]> = {}) =>
			verifyPush({ baseHead: base, recent: history([real, author], [base, "seed"]), expectedAuthor: author, claimedSha: real, ...over });

		it("accepts a real push by the right author and reports the real head", () => {
			expect(verify()).toEqual({ ok: true, commit: real });
		});

		it("accepts a real push even when the runner reported nothing", () => {
			expect(verify({ claimedSha: null }).ok).toBe(true);
		});

		it("accepts several linear commits by the right author", () => {
			expect(verify({ recent: history([real, author], [mid, author], [base, "seed"]) })).toEqual({ ok: true, commit: real });
		});

		it("rejects a forged push SHA that does not match the fork head", () => {
			expect(verify({ claimedSha: sha }).ok).toBe(false);
		});

		it("rejects a claimed push when the fork head never moved", () => {
			expect(verify({ recent: history([base, "seed"]), claimedSha: sha })).toMatchObject({ ok: false });
		});

		it("accepts a run that changed nothing and claimed nothing", () => {
			expect(verify({ recent: history([base, "seed"]), claimedSha: null })).toEqual({ ok: true, commit: null });
		});

		it("rejects a head commit authored by someone else", () => {
			expect(verify({ recent: history([real, "workitem-wi-2"], [base, "seed"]) }).ok).toBe(false);
		});

		it("rejects when any new commit has a foreign author", () => {
			expect(verify({ recent: history([real, author], [mid, "intruder"], [base, "seed"]) }).ok).toBe(false);
		});

		it("fails closed when the fork history could not be read", () => {
			expect(verify({ recent: [] }).ok).toBe(false);
		});

		it("fails closed when the base head is unknown", () => {
			expect(verify({ baseHead: null }).ok).toBe(false);
			expect(verify({ baseHead: null, recent: history([real, author]) }).ok).toBe(false);
		});

		it("fails closed when the base head is not in the recent history (truncated or rewritten)", () => {
			// Ten agent-authored commits and no sight of the base: the history is cut off or was replaced.
			const many = Array.from({ length: 10 }, (_, i) => [`${i}`.repeat(40), author] as [string, string]);
			expect(verify({ recent: history(...many), claimedSha: many[0]![0] }).ok).toBe(false);
			expect(verify({ recent: history([real, author], ["e".repeat(40), "seed"]) }).ok).toBe(false);
		});

		it("fails closed on a merge commit among the new commits", () => {
			const merge = { hash: real, author, parents: [mid, "f".repeat(40)] };
			expect(verify({ recent: [merge, { hash: mid, author, parents: [base] }, { hash: base, author: "seed", parents: [] }] }).ok).toBe(false);
		});

		it("fails closed when the new commits do not chain down to the base", () => {
			const broken = [
				{ hash: real, author, parents: ["9".repeat(40)] },
				{ hash: base, author: "seed", parents: [] },
			];
			expect(verify({ recent: broken }).ok).toBe(false);
		});

		it("fails closed on a missing or malformed field", () => {
			const good = history([real, author], [base, "seed"]);
			const bad = (patch: object) => [{ ...good[0]!, ...patch }, good[1]!];
			expect(verify({ recent: bad({ author: undefined }) }).ok).toBe(false);
			expect(verify({ recent: bad({ author: 5 }) }).ok).toBe(false);
			expect(verify({ recent: bad({ parents: undefined }) }).ok).toBe(false);
			expect(verify({ recent: bad({ parents: "x" }) }).ok).toBe(false);
			expect(verify({ recent: bad({ hash: "not-a-sha" }) }).ok).toBe(false);
			expect(verify({ recent: bad({ hash: undefined }) }).ok).toBe(false);
			expect(verify({ recent: [undefined as never] }).ok).toBe(false);
			expect(verify({ claimedSha: "NOT-A-SHA" }).ok).toBe(false);
		});

		it("fails closed on a malformed base head or expected author", () => {
			expect(verify({ baseHead: "xyz" }).ok).toBe(false);
			expect(verify({ expectedAuthor: "" }).ok).toBe(false);
		});
	});

	describe("receipt verification (revalidation runs)", () => {
		const expected = {
			kind: "revalidation" as const,
			workItemId: "wi-2",
			baseCommit: "a".repeat(40),
			changes: [{ recordId: "notifications", fromVersion: 1, toVersion: 2 }],
			delivered: [{ file: "notifications.md", recordId: "notifications", version: 2, sha256: "9".repeat(64) }],
		};
		const text = (patch: object = {}) => JSON.stringify({ ...expected, ...patch });

		it("accepts the receipt the Worker expects, whatever the key order", () => {
			expect(verifyReceiptText(text(), expected)).toEqual({ ok: true });
			expect(verifyReceiptText(JSON.stringify({ delivered: expected.delivered, changes: expected.changes, baseCommit: expected.baseCommit, workItemId: "wi-2", kind: "revalidation" }), expected).ok).toBe(true);
		});

		it.each([
			["missing", null],
			["undefined", undefined],
			["empty", ""],
			["not JSON", "{nope"],
			["an array", "[]"],
			["the wrong kind", text({ kind: "other" })],
			["another work item", text({ workItemId: "wi-3" })],
			["another base commit", text({ baseCommit: "b".repeat(40) })],
			["different changes", text({ changes: [{ recordId: "notifications", fromVersion: 1, toVersion: 3 }] })],
			["no delivered records", text({ delivered: [] })],
			["a wrong version", text({ delivered: [{ ...expected.delivered[0], version: 1 }] })],
			["a wrong hash", text({ delivered: [{ ...expected.delivered[0], sha256: "0".repeat(64) }] })],
			["an extra delivered record", text({ delivered: [...expected.delivered, { file: "x.md", recordId: "x", version: 1, sha256: "1".repeat(64) }] })],
			["an unknown field", text({ extra: true })],
			["oversized junk", `${text()}${" ".repeat(100_000)}`],
		])("fails closed on a receipt that is %s", (_n, body) => {
			expect(verifyReceiptText(body as string | null | undefined, expected).ok).toBe(false);
		});
	});

	describe("decideRun", () => {
		const verdictOk = { ok: true as const, commit: "c".repeat(40) };
		const noReceipt = { required: false, result: undefined };

		it("succeeds only when the runner succeeded and the fork history verified", () => {
			expect(decideRun({ runner: "succeeded", runnerError: null, verification: verdictOk, receipt: noReceipt })).toEqual({
				state: "succeeded",
				error: null,
				commit: "c".repeat(40),
				pushVerified: true,
			});
		});

		it("fails closed when verification threw, timed out or never ran", () => {
			const r = decideRun({ runner: "succeeded", runnerError: null, verification: undefined, receipt: noReceipt });
			expect(r).toMatchObject({ state: "failed", pushVerified: false, commit: null });
			expect(r.error).toBeTruthy();
		});

		it("fails when verification says the push is not real", () => {
			expect(decideRun({ runner: "succeeded", runnerError: null, verification: { ok: false, error: "forged" }, receipt: noReceipt })).toMatchObject({
				state: "failed",
				error: "forged",
				pushVerified: false,
				commit: null,
			});
		});

		it("never turns a failed or lost runner into success, and does not claim a commit", () => {
			for (const runner of ["failed", "lost"] as const) {
				expect(decideRun({ runner, runnerError: "boom", verification: verdictOk, receipt: noReceipt })).toEqual({
					state: runner,
					error: "boom",
					commit: null,
					pushVerified: null,
				});
			}
		});

		it("requires a verified commit and a matching receipt for a revalidation", () => {
			const base = { runner: "succeeded" as const, runnerError: null };
			expect(decideRun({ ...base, verification: verdictOk, receipt: { required: true, result: { ok: true } } }).state).toBe("succeeded");
			expect(decideRun({ ...base, verification: verdictOk, receipt: { required: true, result: undefined } })).toMatchObject({ state: "failed", pushVerified: false });
			expect(decideRun({ ...base, verification: verdictOk, receipt: { required: true, result: { ok: false, error: "bad receipt" } } })).toMatchObject({ state: "failed", error: "bad receipt", pushVerified: false });
			expect(decideRun({ ...base, verification: { ok: true, commit: null }, receipt: { required: true, result: { ok: true } } })).toMatchObject({ state: "failed", pushVerified: false });
		});
	});

	describe("withDeadline and settleWithin", () => {
		it("withDeadline aborts the operation and rejects with a ContainerTimeoutError when it never settles", async () => {
			let signal: AbortSignal | undefined;
			await expect(
				withDeadline("a read", 20, (s) => {
					signal = s;
					return new Promise(() => {});
				}),
			).rejects.toBeInstanceOf(ContainerTimeoutError);
			expect(signal?.aborted).toBe(true);
		});

		it("withDeadline passes a result and an error through, and leaves the signal alone", async () => {
			let signal: AbortSignal | undefined;
			await expect(withDeadline("a read", 1000, async (s) => ((signal = s), 7))).resolves.toBe(7);
			expect(signal?.aborted).toBe(false);
			await expect(withDeadline("a read", 1000, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		});

		it("settleWithin gives the value, or null on a timeout or a failure, and never rejects", async () => {
			await expect(settleWithin(Promise.resolve(3), 1000)).resolves.toBe(3);
			await expect(settleWithin(new Promise(() => {}), 20)).resolves.toBeNull();
			await expect(settleWithin(Promise.reject(new Error("x")), 1000)).resolves.toBeNull();
		});
	});

	describe("withTimeout", () => {
		it("rejects when the work is slower than the limit and passes through when it is not", async () => {
			await expect(withTimeout(new Promise(() => {}), 20, "log")).rejects.toThrow(/log timed out/);
			await expect(withTimeout(Promise.resolve(7), 1000, "log")).resolves.toBe(7);
			await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "log")).rejects.toThrow("boom");
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

	it("accepts a conflict with no version change, and a record the work never had (from v0)", () => {
		expect(Revalidate.safeParse({ changes: [], context }).success).toBe(true);
		expect(Revalidate.safeParse({ changes: [{ recordId: "notifications", fromVersion: 0, toVersion: 1 }], context }).success).toBe(true);
		expect(buildRevalidationPrompt([])).toContain("your claims conflict with the accepted decisions, although no decision version changed");
		expect(buildRevalidationPrompt([{ recordId: "notifications", fromVersion: 0, toVersion: 1 }])).toContain("Decision notifications (v1) was not in your context before.");
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
