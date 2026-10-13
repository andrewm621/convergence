// Tree diff over the read-only Artifacts binding: readCommit -> readTree (recursive) -> compare blob hashes.
// readTree returns direct children only, so every sub-tree is a further call.

export interface TreeReader {
	readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
}

export interface CommitReader extends TreeReader {
	readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
}

export interface FlatEntry {
	hash: string;
	mode: string;
}

export type FlatTree = Map<string, FlatEntry>;

export interface TreeDiff {
	added: { path: string; hash: string }[];
	removed: { path: string; hash: string }[];
	changed: { path: string; before: string; after: string }[];
}

/** Walk a tree recursively into a map of file path -> blob hash and mode. */
export async function walkTree(reader: TreeReader, treeHash: string, prefix = ""): Promise<FlatTree> {
	const entries = await reader.readTree(treeHash);
	if (!entries) throw new Error(`tree ${treeHash} not found`);

	const flat: FlatTree = new Map();
	const subtrees: Promise<FlatTree>[] = [];
	for (const entry of entries) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.type === "tree") {
			subtrees.push(walkTree(reader, entry.hash, path));
		} else {
			flat.set(path, { hash: entry.hash, mode: entry.mode });
		}
	}
	for (const sub of await Promise.all(subtrees)) {
		for (const [path, entry] of sub) flat.set(path, entry);
	}
	return flat;
}

/** Compare two flattened trees. Paths in each bucket are sorted. */
export function diffFlatTrees(from: FlatTree, to: FlatTree): TreeDiff {
	const diff: TreeDiff = { added: [], removed: [], changed: [] };
	for (const [path, after] of to) {
		const before = from.get(path);
		if (!before) diff.added.push({ path, hash: after.hash });
		else if (before.hash !== after.hash || before.mode !== after.mode) {
			diff.changed.push({ path, before: before.hash, after: after.hash });
		}
	}
	for (const [path, before] of from) {
		if (!to.has(path)) diff.removed.push({ path, hash: before.hash });
	}
	const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
	diff.added.sort(byPath);
	diff.removed.sort(byPath);
	diff.changed.sort(byPath);
	return diff;
}

export interface CommitRef {
	reader: CommitReader;
	commit: string;
}

/** Diff the trees of two commits (from -> to). Each side reads through its own repo handle. */
export async function diffCommits(from: CommitRef, to: CommitRef): Promise<TreeDiff> {
	const [fromMeta, toMeta] = await Promise.all([from.reader.readCommit(from.commit), to.reader.readCommit(to.commit)]);
	if (!fromMeta) throw new Error(`commit ${from.commit} not found`);
	if (!toMeta) throw new Error(`commit ${to.commit} not found`);
	const [fromTree, toTree] = await Promise.all([
		walkTree(from.reader, fromMeta.treeHash),
		walkTree(to.reader, toMeta.treeHash),
	]);
	return diffFlatTrees(fromTree, toTree);
}
