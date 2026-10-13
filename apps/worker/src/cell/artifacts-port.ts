import { commitFiles, errorCode, getRepo } from "../artifacts/git-write";
import { mergeForkIntoBaseline } from "../artifacts/git-merge";
import { walkTree, type FlatTree } from "../artifacts/tree-diff";
import { PortError, type ArtifactsPort, type CommitFilesRequest, type MergeRequest, type RepoCommit } from "./ports";

const BRANCH = "main";

/** The real port: reads through the Artifacts binding, writes over git with isomorphic-git. Not emulated locally. */
export class BindingArtifactsPort implements ArtifactsPort {
	readonly #env: Env;

	constructor(env: Env) {
		this.#env = env;
	}

	async log(repo: string, options: { limit: number; offset?: number }): Promise<RepoCommit[]> {
		return this.#read(repo, async (handle) => {
			const commits = await handle.log({ ref: BRANCH, limit: options.limit, ...(options.offset ? { offset: options.offset } : {}) });
			return commits.map((c) => ({ sha: c.hash, message: c.message, authorName: c.author.name, committerName: c.committer.name, parents: c.parents, committedAt: c.committedAt }));
		});
	}

	async readFile(repo: string, ref: string, path: string): Promise<string | null> {
		return this.#read(repo, async (handle) => (await handle.readFile({ ref, path }))?.text() ?? null);
	}

	async readBlob(repo: string, oid: string): Promise<string | null> {
		return this.#read(repo, async (handle) => (await handle.readBlob(oid))?.text() ?? null);
	}

	async tree(repo: string, commit: string): Promise<FlatTree> {
		return this.#read(repo, async (handle) => {
			const meta = await handle.readCommit(commit);
			if (!meta) throw new PortError("NOT_FOUND", `commit ${commit} not found in ${repo}`);
			return walkTree(handle, meta.treeHash);
		});
	}

	async commitFiles(request: CommitFilesRequest): Promise<{ commitSha: string }> {
		const head = (await this.log(request.repo, { limit: 1 }))[0];
		if (head?.sha !== request.expectedHead) throw new PortError("STALE_HEAD", `${request.repo} is no longer at ${request.expectedHead}`);
		try {
			const result = await commitFiles(this.#env, request.repo, request.files, request.message, { author: request.author, committer: request.committer });
			return { commitSha: result.oid };
		} catch (error) {
			// The push itself is a compare-and-swap on the branch: losing it means someone else wrote first.
			if (error instanceof Error && /stale ref/i.test(error.message)) throw new PortError("STALE_HEAD", `${request.repo} moved while the change was being pushed`);
			throw error;
		}
	}

	async mergeFork(request: MergeRequest): Promise<{ mergeCommitSha: string }> {
		return mergeForkIntoBaseline(this.#env, request);
	}

	async #read<T>(repo: string, fn: (handle: ArtifactsRepo) => Promise<T>): Promise<T> {
		try {
			using handle = await getRepo(this.#env, repo);
			return await fn(handle);
		} catch (error) {
			if (error instanceof PortError) throw error;
			if (errorCode(error) === "NOT_FOUND") throw new PortError("NOT_FOUND", `${repo} was not found`);
			throw error;
		}
	}
}
