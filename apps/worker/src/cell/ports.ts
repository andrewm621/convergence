import type { FlatTree } from "../artifacts/tree-diff";

// Everything the cell needs from Artifacts, behind one narrow interface. Artifacts has no local
// emulation, so tests run the whole control loop against an in-memory implementation of this
// (testing/fake-artifacts.ts); the real one (artifacts-port.ts) is verified live.

export interface RepoCommit {
	sha: string;
	message: string;
	/** Author name. For baseline commits the Worker sets it to the acting human's id. */
	authorName: string;
	/** Committer name. The Worker commits as itself (see WORKER_COMMITTER in observe.ts). */
	committerName: string;
	/** First parent first. */
	parents: string[];
	/** Unix seconds. */
	committedAt: number;
}

export type PortErrorCode =
	| "NOT_FOUND"
	/** The repo's head is not the one the caller expected (compare-and-swap lost). */
	| "STALE_HEAD"
	| "MERGE_CONFLICT"
	| "UNAVAILABLE";

export class PortError extends Error {
	constructor(
		readonly code: PortErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PortError";
	}
}

export interface CommitFilesRequest {
	repo: string;
	files: Record<string, string>;
	message: string;
	author: { name: string; email: string };
	/** Who the commit is committed by; the Worker passes its own identity, apart from the acting human. */
	committer: { name: string; email: string };
	/** The head the caller read. The write fails with STALE_HEAD if the repo moved. */
	expectedHead: string;
}

export interface MergeRequest {
	baselineRepo: string;
	forkRepo: string;
	/** The baseline head the approval was given against (compare-and-swap). */
	expectedBaselineCommit: string;
	/** The fork head the approval was given against. */
	forkHeadSha: string;
	message: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
}

export interface ArtifactsPort {
	/** Newest first along the first-parent chain of the default branch. Empty when the repo has no commits. */
	log(repo: string, options: { limit: number }): Promise<RepoCommit[]>;
	/** Text of a file at a ref (branch or commit sha), or null. */
	readFile(repo: string, ref: string, path: string): Promise<string | null>;
	/** Text of a blob by object id, or null. */
	readBlob(repo: string, oid: string): Promise<string | null>;
	/** Every file at a commit, recursively: path to blob oid and mode. */
	tree(repo: string, commit: string): Promise<FlatTree>;
	/** The Worker commits to a repo's default branch. Returns the new commit sha. */
	commitFiles(request: CommitFilesRequest): Promise<{ commitSha: string }>;
	/** Merge a fork head into the baseline default branch and push. Throws MERGE_CONFLICT or STALE_HEAD. */
	mergeFork(request: MergeRequest): Promise<{ mergeCommitSha: string }>;
}
