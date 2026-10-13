import type { DeltaEvent, RecordSnapshot } from "contracts";
import { diffFlatTrees, type FlatTree } from "../artifacts/tree-diff";
import { CONTEXT_FILE, ContextReader, snapshotHashOf } from "./context-tree";
import type { ArtifactsPort, RepoCommit } from "./ports";

// Turns a commit that Artifacts shows us into the DeltaEvent the reconciler understands. The
// poller calls this today; a Queue consumer later calls the same functions, so both paths feed
// one interface (and R9 dedupes on (repo, commitSha) when both fire).

/** The identity the Worker commits under. The commit's author is the acting human; its committer is always this. */
export const WORKER_COMMITTER = "delta-convergence";

/** A baseline commit the Worker itself pushed, as recorded by the cell at the moment it pushed it. */
export type WrittenCommit = {
	/** `context`: a context change made for `actor`. `merge`: a promotion; it can never accept context. */
	kind: "context" | "merge";
	/** The authenticated human the Worker acted for. */
	actor: string;
};

export const CLAIMS_PATH = ".delta/claims.json";
const MAX_CLAIMS_BYTES = 256 * 1024;
/** Shown instead of a path when the fork could not be compared with its base. It fails closed: any entry blocks promotion. */
export const UNVERIFIED_CONTEXT_PATH = "context/(fork could not be compared with its base)";
/** Delivered as the claims when the claims file could not be read. Not an array, so it fails closed. */
export const UNREADABLE_CLAIMS = "claims file could not be read";

export type ObserveDeps = {
	port: ArtifactsPort;
	reader: ContextReader;
	/** ISO-8601 instant for events. The reconciler never reads a clock. */
	now: () => string;
	/** Who may accept a change to this record right now: the policy, else the sitting authority, else null (a record's first version). */
	authorityOf: (snapshot: RecordSnapshot) => string | null;
	/** What the cell recorded about a baseline commit the Worker pushed, or null for any other commit. */
	written: (sha: string) => WrittenCommit | null;
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
 * The baseline has one writer, the Worker. A commit may become an accepted context version only if
 * ALL of these hold; otherwise the record is reported `invalid` and the reconciler never sees it:
 *   1. the cell recorded the commit's sha when the Worker pushed it (author and committer names
 *      are text anyone holding a write token can set, so they prove nothing alone);
 *   2. it was a context change, never a promotion merge (a merge carries a fork's files);
 *   3. its committer is the Worker and its author is the record's authority, which comes from the
 *      policy or the sitting version, never from the record file's own `authority` text. Only a
 *      record's first version has no sitting authority, and then it must be the human the Worker
 *      wrote it for.
 * A record file's `accepted_by` is still checked by the reconciler on top of this.
 */
export async function observeBaselineCommit(deps: ObserveDeps, repo: string, commit: RepoCommit): Promise<BaselineObservation> {
	const { reader } = deps;
	const written = deps.written(commit.sha);
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
			const refusal = refuseAcceptance(deps, commit, written, snapshot);
			if (refusal) {
				invalid.push({ path: file.path, error: refusal });
				continue;
			}
			// Only an accepted, authorised file may name where a record lives.
			recordPaths[snapshot.recordId] = file.path;
		}
		records.push(snapshot);
	}

	const snapshotHash = await snapshotHashOf(await reader.readAll(repo, tree));
	return {
		event: { type: "BaselinePushed", ts: deps.now(), repo, commitSha: commit.sha, snapshotHash, records, invalid },
		recordPaths,
	};
}

/** Why this commit cannot make `snapshot` an accepted version, or null if it can. */
function refuseAcceptance(deps: ObserveDeps, commit: RepoCommit, written: WrittenCommit | null, snapshot: RecordSnapshot): string | null {
	const id = snapshot.recordId;
	if (!written) return `${id}: commit ${commit.sha.slice(0, 7)} was not written by the Worker, so it cannot accept context; the baseline has a single writer`;
	if (written.kind !== "context") return `${id}: a ${written.kind} commit never accepts context; context changes go through the context-change endpoint`;
	if (commit.committerName !== WORKER_COMMITTER) return `${id}: committer "${commit.committerName}" is not the Worker`;
	const authority = deps.authorityOf(snapshot) ?? written.actor;
	if (commit.authorName !== authority || written.actor !== authority) {
		return `${id}: commit author "${commit.authorName}" is not the authority "${authority}"; the baseline only accepts changes made by its authority`;
	}
	return null;
}

/**
 * A fork commit as a ForkPushed event. The claims are read at that commit; `contextPaths` comes
 * from a tree diff of the fork against the baseline commit it was forked from (not from anything
 * the agent says), so a fork that edits `context/**` is always seen. If the claims cannot be read,
 * or the diff cannot be made, and `degraded` is set, the push is delivered with a marker instead
 * (malformed claims, a sentinel context path): fail closed.
 */
export async function observeForkCommit(deps: ObserveDeps, tracked: TrackedRepo, baselineRepo: string, commit: RepoCommit, options: { degraded?: boolean } = {}): Promise<DeltaEvent> {
	const { port } = deps;
	if (!tracked.workItemId) throw new Error(`${tracked.repo} is not a fork of a work item`);

	let text: string | null = null;
	let claims: unknown = null;
	try {
		text = await port.readFile(tracked.repo, commit.sha, CLAIMS_PATH);
	} catch (error) {
		if (!options.degraded) throw error;
		claims = UNREADABLE_CLAIMS; // a non-array: the reconciler reads it as MALFORMED_CLAIMS and blocks
	}
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
