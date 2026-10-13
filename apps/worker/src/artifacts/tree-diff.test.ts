import { describe, expect, it } from "vitest";
import { diffCommits, diffFlatTrees, walkTree, type CommitReader } from "./tree-diff";

type Node = { name: string; type: "blob" | "tree"; hash: string };

/** In-memory stand-in for the binding: tree hash -> entries, commit hash -> tree hash. */
function mockReader(trees: Record<string, Node[]>, commits: Record<string, string> = {}): CommitReader & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async readTree(hash) {
			calls.push(hash);
			const entries = trees[hash];
			return entries ? entries.map((e) => ({ ...e, mode: e.type === "tree" ? "40000" : "100644" })) : null;
		},
		async readCommit(hash) {
			const treeHash = commits[hash];
			return treeHash ? ({ hash, treeHash } as ArtifactsCommitMetadata) : null;
		},
	};
}

const v1: Record<string, Node[]> = {
	root1: [
		{ name: "AGENTS.md", type: "blob", hash: "a1" },
		{ name: "context", type: "tree", hash: "ctx1" },
		{ name: "src", type: "tree", hash: "src1" },
	],
	ctx1: [{ name: "notifications.md", type: "blob", hash: "n1" }],
	src1: [{ name: "index.ts", type: "blob", hash: "i1" }],
};

const v2: Record<string, Node[]> = {
	...v1,
	root2: [
		{ name: "AGENTS.md", type: "blob", hash: "a1" },
		{ name: "context", type: "tree", hash: "ctx2" },
		{ name: "src", type: "tree", hash: "src1" },
	],
	ctx2: [{ name: "notifications.md", type: "blob", hash: "n2" }],
};

describe("walkTree", () => {
	it("flattens nested trees into full paths", async () => {
		const flat = await walkTree(mockReader(v1), "root1");
		expect([...flat.keys()].sort()).toEqual(["AGENTS.md", "context/notifications.md", "src/index.ts"]);
		expect(flat.get("context/notifications.md")?.hash).toBe("n1");
	});

	it("throws when a tree is missing", async () => {
		await expect(walkTree(mockReader({}), "nope")).rejects.toThrow(/not found/);
	});
});

describe("diffCommits", () => {
	it("reports only the changed blob, not unchanged siblings or untouched subtrees", async () => {
		const reader = mockReader(v2, { c1: "root1", c2: "root2" });
		const diff = await diffCommits({ reader, commit: "c1" }, { reader, commit: "c2" });
		expect(diff).toEqual({
			added: [],
			removed: [],
			changed: [{ path: "context/notifications.md", before: "n1", after: "n2" }],
		});
	});

	it("diffs across two repo handles", async () => {
		const fork = mockReader(v1, { f1: "root1" });
		const base = mockReader(v2, { c2: "root2" });
		const diff = await diffCommits({ reader: fork, commit: "f1" }, { reader: base, commit: "c2" });
		expect(diff.changed.map((c) => c.path)).toEqual(["context/notifications.md"]);
	});

	it("returns an empty diff for identical trees", async () => {
		const reader = mockReader(v1, { c1: "root1", c1b: "root1" });
		const diff = await diffCommits({ reader, commit: "c1" }, { reader, commit: "c1b" });
		expect(diff).toEqual({ added: [], removed: [], changed: [] });
	});
});

describe("diffFlatTrees", () => {
	it("classifies added, removed and mode-only changes, sorted by path", () => {
		const from = new Map([
			["b.md", { hash: "1", mode: "100644" }],
			["gone.md", { hash: "2", mode: "100644" }],
			["run.sh", { hash: "3", mode: "100644" }],
		]);
		const to = new Map([
			["b.md", { hash: "1", mode: "100644" }],
			["new/z.md", { hash: "4", mode: "100644" }],
			["a.md", { hash: "5", mode: "100644" }],
			["run.sh", { hash: "3", mode: "100755" }],
		]);
		const diff = diffFlatTrees(from, to);
		expect(diff.added.map((e) => e.path)).toEqual(["a.md", "new/z.md"]);
		expect(diff.removed.map((e) => e.path)).toEqual(["gone.md"]);
		expect(diff.changed.map((e) => e.path)).toEqual(["run.sh"]);
	});
});

describe("diffFlatTrees ordering", () => {
	it("sorts by code unit, independent of locale", () => {
		const entry = (hash: string) => ({ hash, mode: "100644" });
		const to = new Map([
			["b.ts", entry("1")],
			["B.ts", entry("2")],
			["a.ts", entry("3")],
			["_x.ts", entry("4")],
		]);
		// localeCompare would interleave cases (a, b, B or similar); code-unit order puts "B" < "_" < "a" < "b".
		expect(diffFlatTrees(new Map(), to).added.map((e) => e.path)).toEqual(["B.ts", "_x.ts", "a.ts", "b.ts"]);
	});
});
