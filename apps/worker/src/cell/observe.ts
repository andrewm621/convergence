import type { DeltaEvent, RecordSnapshot } from "contracts";
import { diffFlatTrees, type FlatTree } from "../artifacts/tree-diff";
import { CONTEXT_FILE, ContextReader, snapshotHashOf } from "./context-tree";
import type { ArtifactsPort, RepoCommit } from "./ports";

// Turns a commit that Artifacts shows us into the DeltaEvent the reconciler understands. The
// poller calls this today; a Queue consumer later calls the same functions, so both paths feed
// one interface (and R9 dedupes on (repo, commitSha) when both fire).

export const CLAIMS_PATH = ".delta/claims.json";
const MAX_CLAIMS_BYTES = 256 * 1024;
/** Shown instead of a path when the fork could not be compared with its base. It fails closed: any entry blocks promotion. */
export const UNVERIFIED_CONTEXT_PATH = "context/(fork could not be compared with its base)";

export type ObserveDeps = {
	port: ArtifactsPort;
	reader: ContextReader;
	/** ISO-8601 instant for events. The reconciler never reads a clock. */
	now: () => string;
	/** Who may accept a change to this record right now: the policy, else the sitting authority, else the file's own claim (first version only). */
	authorityOf: (snapshot: RecordSnapshot) => string;
	/** Trees are immutable per commit sha, so a small cache per cell instance is safe. */
	trees: Map<string, FlatTree>;
};

export type TrackedRepo = {
	repo: string;
	kind: "baseline" | "fork";
	workItemId: string | null;
	/** For a fork: the baseline commit it was forked from, which `contextPaths` is measured against. */
	baseCommit: string | null;
};

const TREE_CACHE_MAX = 32;

async function treeAt(deps: ObserveDeps, repo: string, sha: string): Promise<FlatTree> {
	const key = `${repo}@${sha}`;
	const hit = deps.trees.get(key);
	if (hit) return hit;
	const tree = await deps.port.tree(repo, sha);
	if (deps.trees.size >= TREE_CACHE_MAX) deps.trees.delete(deps.trees.keys().next().value as string);
	deps.trees.set(key, tree);
	return tree;
}

export type BaselineObservation = { event: DeltaEvent; recordPaths: Record<string, string> };

/**
 * A baseline commit as a BaselinePushed event: the context records it changed, parsed and hashed,
 * plus the hash of the whole context snapshot after it.
 *
 * The baseline has one writer, the Worker, which commits as the acting human. So a commit that
 * changes a record but was not authored by that record's authority is not an acceptance: the
 * record is reported `invalid` and the reconciler never sees it as a version.
 */
export async function observeBaselineCommit(deps: ObserveDeps, repo: string, commit: RepoCommit): Promise<BaselineObservation> {
	const { port, reader } = deps;
	const tree = await treeAt(deps, repo, commit.sha);
	const parentSha = commit.parents[0];
	const parentTree: FlatTree = parentSha ? await treeAt(deps, repo, parentSha) : new Map();
	const diff = diffFlatTrees(parentTree, tree);
	const changedPaths = [...diff.added, ...diff.changed].map((entry) => entry.path).filter((path) => CONTEXT_FILE.test(path));

	const records: RecordSnapshot[] = [];
	const invalid: Array<{ path: string; error: string }> = [];
	const recordPaths: Record<string, string> = {};
	for (const file of await reader.read(repo, tree, changedPaths)) {
		if (!file.result.ok) {
			invalid.push({ path: file.path, error: file.result.error });
			continue;
		}
		const snapshot = file.result.snapshot;
		if (snapshot.status === "accepted") {
			const authority = deps.authorityOf(snapshot);
			if (commit.authorName !== authority) {
				invalid.push({ path: file.path, error: `commit author "${commit.authorName}" is not the authority "${authority}" for ${snapshot.recordId}; the baseline only accepts changes made by its authority` });
				continue;
			}
		}
		records.push(snapshot);
		recordPaths[snapshot.recordId] = file.path;
	}

	const snapshotHash = await snapshotHashOf(await reader.readAll(repo, tree));
	return {
		event: { type: "BaselinePushed", ts: deps.now(), repo, commitSha: commit.sha, snapshotHash, records, invalid },
		recordPaths,
	};
}

/**
 * A fork commit as a ForkPushed event. The claims are read at that commit; `contextPaths` comes
 * from a tree diff of the fork against the baseline commit it was forked from (not from anything
 * the agent says), so a fork that edits `context/**` is always seen. If the diff cannot be made
 * and `degraded` is set, the push is delivered with a sentinel path instead: fail closed.
 */
export async function observeForkCommit(deps: ObserveDeps, tracked: TrackedRepo, baselineRepo: string, commit: RepoCommit, options: { degraded?: boolean } = {}): Promise<DeltaEvent> {
	const { port } = deps;
	if (!tracked.workItemId) throw new Error(`${tracked.repo} is not a fork of a work item`);

	const text = await port.readFile(tracked.repo, commit.sha, CLAIMS_PATH);
	let claims: unknown = null;
	if (text !== null) {
		if (text.length > MAX_CLAIMS_BYTES) claims = "claims file is too large";
		else {
			try {
				claims = JSON.parse(text);
			} catch {
				claims = text; // not JSON: the reconciler reads a non-array as MALFORMED_CLAIMS
			}
		}
	}

	let contextPaths: string[];
	try {
		if (!tracked.baseCommit) throw new Error("fork has no base commit");
		const [baseTree, forkTree] = await Promise.all([treeAt(deps, baselineRepo, tracked.baseCommit), treeAt(deps, tracked.repo, commit.sha)]);
		const diff = diffFlatTrees(baseTree, forkTree);
		contextPaths = [...diff.added, ...diff.removed, ...diff.changed].map((entry) => entry.path).filter((path) => path.startsWith("context/"));
	} catch (error) {
		if (!options.degraded) throw error;
		contextPaths = [UNVERIFIED_CONTEXT_PATH];
	}

	return { type: "ForkPushed", ts: deps.now(), repo: tracked.repo, commitSha: commit.sha, workItemId: tracked.workItemId, claims, contextPaths };
}
