import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { NOTIFICATIONS_V1, STATUS_MODEL_V1 } from "scenario-notifications";
import { runStubAgent } from "../../container/stub-agent-lib";
import { PortError } from "../cell/ports";
import { mergeInto } from "./git-merge";
import { MemoryFS } from "./memory-fs";

// The decision logic of a promotion merge, on an in-memory repo: fast-forward, a true merge, a
// conflict. Clone, fetch and push are transport and are checked live.

const DIR = "/r";
const WORKER = { name: "delta-convergence", email: "delta@example.invalid" };
const HUMAN = { name: "decision-owner", email: "decision-owner@delta.invalid" };

async function commit(fs: MemoryFS, files: Record<string, string>, message: string): Promise<string> {
	for (const [path, text] of Object.entries(files)) {
		await fs.promises.mkdir(`${DIR}/${path.split("/").slice(0, -1).join("/") || "."}`, { recursive: true }).catch(() => undefined);
		await fs.promises.writeFile(`${DIR}/${path}`, text);
		await git.add({ fs, dir: DIR, filepath: path });
	}
	return git.commit({ fs, dir: DIR, message, author: WORKER });
}

async function setup() {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR, defaultBranch: "main" });
	const base = await commit(fs, { "a.txt": "a\n", "b.txt": "b\n" }, "base");
	return { fs, base };
}

/** Put a commit on a side ref the way `git fetch` leaves a fork's head. */
async function forkFrom(fs: MemoryFS, base: string, files: Record<string, string>): Promise<string> {
	await git.checkout({ fs, dir: DIR, ref: "main" });
	await git.branch({ fs, dir: DIR, ref: "fork-work", object: base, checkout: true });
	const sha = await commit(fs, files, "fork work");
	await git.writeRef({ fs, dir: DIR, ref: "refs/remotes/fork/main", value: sha, force: true });
	await git.checkout({ fs, dir: DIR, ref: "main" });
	return sha;
}

describe("mergeInto: the heads are re-checked after the fetch", () => {
	it("refuses (STALE_HEAD) when the fork ref is no longer the head the approval was given against", async () => {
		const { fs, base } = await setup();
		await forkFrom(fs, base, { "c.txt": "c\n" });
		await expect(
			mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN, expect: { ours: base, theirs: "d".repeat(40) } }),
		).rejects.toMatchObject({ code: "STALE_HEAD" });
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(base); // nothing merged
	});

	it("refuses (STALE_HEAD) when the cloned baseline is not the head the approval was given against", async () => {
		const { fs, base } = await setup();
		const forkHead = await forkFrom(fs, base, { "c.txt": "c\n" });
		await commit(fs, { "b.txt": "b2\n" }, "baseline moved after the approval");
		await expect(
			mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN, expect: { ours: base, theirs: forkHead } }),
		).rejects.toBeInstanceOf(PortError);
	});

	it("merges when both heads are what was approved", async () => {
		const { fs, base } = await setup();
		const forkHead = await forkFrom(fs, base, { "c.txt": "c\n" });
		const result = await mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN, expect: { ours: base, theirs: forkHead } });
		expect(result.oid).toBe(forkHead);
	});
});

describe("mergeInto", () => {
	it("fast-forwards when the baseline has not moved", async () => {
		const { fs, base } = await setup();
		const forkHead = await forkFrom(fs, base, { "c.txt": "c\n" });
		const result = await mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN, committer: WORKER });
		expect(result).toEqual({ oid: forkHead, fastForward: true });
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(forkHead);
	});

	it("makes a merge commit with both parents when both sides moved on different files", async () => {
		const { fs, base } = await setup();
		const forkHead = await forkFrom(fs, base, { "c.txt": "c\n" });
		const baselineHead = await commit(fs, { "b.txt": "b2\n" }, "baseline moves");
		const result = await mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote WI-1", author: HUMAN, committer: WORKER });
		expect(result.fastForward).toBe(false);
		const merged = await git.readCommit({ fs, dir: DIR, oid: result.oid });
		expect(merged.commit.parent).toEqual([baselineHead, forkHead]);
		expect(merged.commit.author.name).toBe("decision-owner");
		expect(merged.commit.committer.name).toBe("delta-convergence");
		const files = await git.listFiles({ fs, dir: DIR, ref: result.oid });
		expect(files).toEqual(["a.txt", "b.txt", "c.txt"]);
	});

	it("reports a conflict as MERGE_CONFLICT and leaves the baseline where it was", async () => {
		const { fs, base } = await setup();
		await forkFrom(fs, base, { "a.txt": "fork edit\n" });
		const baselineHead = await commit(fs, { "a.txt": "baseline edit\n" }, "baseline edits the same file");
		await expect(mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN })).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
		await expect(mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN })).rejects.toBeInstanceOf(PortError);
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(baselineHead);
	});
});

describe("mergeInto: two work items promoted one after the other", () => {
	// Each fork is cut from the same baseline, as the stub agents' forks are.
	const contextFiles = { "context/notifications.md": NOTIFICATIONS_V1, "context/status-model.md": STATUS_MODEL_V1 };
	const stub = (workItemId: string, prompt: string) => runStubAgent({ workItemId, prompt, contextFiles }).files;

	async function setupMain(baseFiles: Record<string, string>) {
		const fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: "main" });
		const base = await commit(fs, baseFiles, "base");
		const cut = async (name: string, files: Record<string, string>) => {
			await git.branch({ fs, dir: DIR, ref: name, object: base, checkout: true });
			const sha = await commit(fs, files, name);
			await git.checkout({ fs, dir: DIR, ref: "main" });
			return sha;
		};
		const promote = async (sha: string) => {
			await git.writeRef({ fs, dir: DIR, ref: "refs/remotes/fork/main", value: sha, force: true });
			return mergeInto(fs, DIR, { ours: "main", theirs: "refs/remotes/fork/main", message: "promote", author: HUMAN, committer: WORKER });
		};
		const filesAt = (oid: string) => git.listFiles({ fs, dir: DIR, ref: oid });
		const textOf = async (oid: string, filepath: string) => Buffer.from((await git.readBlob({ fs, dir: DIR, oid, filepath })).blob).toString("utf8");
		return { fs, base, cut, promote, filesAt, textOf };
	}

	const APP = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((w) => `${w}\n`).join("");
	const edit = (text: string, line: string, to: string) => text.replace(`${line}\n`, `${to}\n`);

	it("merges the second stub agent's fork cleanly after the first (live run: 409 MERGE_CONFLICT), and the baseline never carries .delta/", async () => {
		const out1 = stub("wi-1", "Add status badges and the status-change API");
		const out2 = stub("wi-2", "Implement notification preferences and delivery");
		const { fs, base, cut, promote, filesAt } = await setupMain({ "AGENTS.md": "# agents\n", "src/index.ts": "export {};\n" });
		const [wi1, wi2] = [await cut("wi-1", out1), await cut("wi-2", out2)];
		const first = await promote(wi1);
		// A fork that has .delta/ is not fast-forwarded: the merge commit is the fork's tree without it.
		expect(first.fastForward).toBe(false);
		expect((await git.readCommit({ fs, dir: DIR, oid: first.oid })).commit.parent).toEqual([base, wi1]);
		expect(await filesAt(first.oid)).toEqual(["AGENTS.md", "src/index.ts", "src/work/wi-1.ts"]);
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(first.oid);
		const second = await promote(wi2);
		expect(await filesAt(second.oid)).toEqual(["AGENTS.md", "src/index.ts", "src/work/wi-1.ts", "src/work/wi-2.ts"]);
	});

	it("still reports a MERGE_CONFLICT when both forks append to the same barrel, even beside colliding claims", async () => {
		// What the stub did before: each fork appended its own export at the end of the shared src/index.ts.
		const barrel = (id: string) => ({ ...stub(id, "x"), "src/index.ts": `export {};\nexport * from "./work/${id}";\n` });
		const { fs, cut, promote } = await setupMain({ "AGENTS.md": "# agents\n", "src/index.ts": "export {};\n" });
		const [wi1, wi2] = [await cut("wi-1", barrel("wi-1")), await cut("wi-2", barrel("wi-2"))];
		await promote(wi1);
		const head = await git.resolveRef({ fs, dir: DIR, ref: "main" });
		await expect(promote(wi2)).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(head);
	});

	it("keeps a conflict on a source file a conflict, whatever else collides under .delta/", async () => {
		const { cut, promote } = await setupMain({ "AGENTS.md": "# agents\n" });
		const [wi1, wi2] = [await cut("wi-1", { "src/a.ts": "one\n", ".delta/receipt.json": "{1}\n" }), await cut("wi-2", { "src/a.ts": "two\n", ".delta/receipt.json": "{2}\n" })];
		await promote(wi1);
		await expect(promote(wi2)).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
	});

	// A baseline that already holds another work item's .delta/ (it did, before the baseline stopped carrying it).
	async function legacyBaseline() {
		const main = await setupMain({ "src/app.ts": APP, ".delta/claims.json": "[]\n" });
		const fork = (files: Record<string, string>) => main.cut("fork", { ".delta/claims.json": '[{"subject":"fork"}]\n', ...files });
		return { ...main, fork };
	}

	it("merges two separate hunks of a source file when .delta/ also collides (real agents editing the same file)", async () => {
		const { fs, fork, promote, filesAt, textOf } = await legacyBaseline();
		const sha = await fork({ "src/app.ts": edit(APP, "two", "TWO (fork)") });
		// The baseline moved on: another item's work in a different hunk of the same file, and its own claims.
		await git.checkout({ fs, dir: DIR, ref: "main" });
		await commit(fs, { "src/app.ts": edit(APP, "nine", "NINE (baseline)"), ".delta/claims.json": '[{"subject":"baseline"}]\n' }, "baseline moves");
		const merged = await promote(sha);
		expect(merged.fastForward).toBe(false);
		const app = await textOf(merged.oid, "src/app.ts");
		expect(app).toContain("TWO (fork)\n");
		expect(app).toContain("NINE (baseline)\n");
		expect(app).not.toMatch(/<<<<<<<|>>>>>>>/);
		expect(await filesAt(merged.oid)).toEqual(["src/app.ts"]);
	});

	it("a real overlap in a source file is still a conflict when .delta/ collides too", async () => {
		const { fs, fork, promote } = await legacyBaseline();
		const sha = await fork({ "src/app.ts": edit(APP, "five", "FIVE (fork)") });
		await git.checkout({ fs, dir: DIR, ref: "main" });
		const head = await commit(fs, { "src/app.ts": edit(APP, "five", "FIVE (baseline)"), ".delta/claims.json": '[{"subject":"baseline"}]\n' }, "baseline moves");
		await expect(promote(sha)).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(head);
	});

	it("a .delta/ file one side deleted and the other changed is still a conflict", async () => {
		const { fs, fork, promote } = await legacyBaseline();
		const sha = await fork({ ".delta/claims.json": '[{"subject":"fork"}]\n' });
		await git.checkout({ fs, dir: DIR, ref: "main" });
		await fs.promises.unlink(`${DIR}/.delta/claims.json`);
		await git.remove({ fs, dir: DIR, filepath: ".delta/claims.json" });
		const head = await git.commit({ fs, dir: DIR, message: "baseline drops the claims", author: WORKER });
		await expect(promote(sha)).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
		expect(await git.resolveRef({ fs, dir: DIR, ref: "main" })).toBe(head);
	});

	it("a path that only looks like .delta/ is not metadata", async () => {
		const main = await setupMain({ "AGENTS.md": "# agents\n" });
		const [a, b] = [await main.cut("a", { "src/.delta/x.json": "1\n" }), await main.cut("b", { "src/.delta/x.json": "2\n" })];
		await main.promote(a);
		await expect(main.promote(b)).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
	});
});
