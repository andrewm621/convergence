import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
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
