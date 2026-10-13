import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { PortError, type MergeRequest } from "../cell/ports";
import { getRepo } from "./git-write";
import { MemoryFS } from "./memory-fs";
import { stripExpiry } from "./tokens";

// Promotion merge, done in the Worker: clone the baseline, fetch the fork, merge, push. Artifacts
// has no merge API, and this path is unverified against the live service (see docs/control-loop.md).
// Everything that decides the outcome is in `mergeInto`, which runs on any fs and is unit-tested;
// the rest is transport.

const DIR = "/m";
const BRANCH = "main";
const FORK_REF = "refs/remotes/fork/main";

type Identity = { name: string; email: string };

/**
 * Merge `theirs` into `ours` (a branch) in an already-cloned repo. Fast-forwards when it can;
 * otherwise makes a merge commit. A real conflict is MERGE_CONFLICT; the repo is left untouched.
 */
export async function mergeInto(fs: MemoryFS, dir: string, options: { ours: string; theirs: string; message: string; author: Identity }): Promise<{ oid: string; fastForward: boolean }> {
	try {
		const result = await git.merge({
			fs,
			dir,
			ours: options.ours,
			theirs: options.theirs,
			message: options.message,
			author: options.author,
			committer: options.author,
			fastForward: true,
			abortOnConflict: true,
		});
		if (!result.oid) throw new Error("merge produced no commit");
		return { oid: result.oid, fastForward: !result.mergeCommit };
	} catch (error) {
		const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
		const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
		if (name === "MergeConflictError" || code === "MergeConflictError") throw new PortError("MERGE_CONFLICT", "the fork conflicts with the baseline; resolve it on the fork and promote again");
		throw error;
	}
}

/** Merge a fork's head into the baseline's default branch and push. Fails (STALE_HEAD) rather than rebasing if either head moved. */
export async function mergeForkIntoBaseline(env: Env, request: MergeRequest): Promise<{ mergeCommitSha: string }> {
	using baseline = await getRepo(env, request.baselineRepo);
	using fork = await getRepo(env, request.forkRepo);

	// Compare-and-swap on both heads, before anything is cloned.
	const [baselineHead, forkHead] = await Promise.all([baseline.log({ ref: BRANCH, limit: 1 }), fork.log({ ref: BRANCH, limit: 1 })]);
	if (baselineHead[0]?.hash !== request.expectedBaselineCommit) throw new PortError("STALE_HEAD", "the baseline is no longer at the commit the approval was given against");
	if (forkHead[0]?.hash !== request.forkHeadSha) throw new PortError("STALE_HEAD", "the fork is no longer at the commit the approval was given against");

	const [baselineInfo, forkInfo] = await Promise.all([baseline.info(), fork.info()]);
	const writeToken = await baseline.createToken("write", 300);
	const readToken = await fork.createToken("read", 300);
	const onAuth = (url: string) => {
		const token = url.startsWith(forkInfo.remote) ? readToken : writeToken;
		return { username: "x", password: stripExpiry(token.plaintext) };
	};

	try {
		const fs = new MemoryFS();
		// Full history on both sides: the merge needs their common ancestor.
		await git.clone({ fs, http, dir: DIR, url: baselineInfo.remote, ref: BRANCH, singleBranch: true, onAuth });
		await git.addRemote({ fs, dir: DIR, remote: "fork", url: forkInfo.remote });
		await git.fetch({ fs, http, dir: DIR, remote: "fork", ref: BRANCH, singleBranch: true, onAuth });

		const merged = await mergeInto(fs, DIR, { ours: BRANCH, theirs: FORK_REF, message: request.message, author: request.author });
		const push = await git.push({ fs, http, dir: DIR, url: baselineInfo.remote, ref: BRANCH, remoteRef: BRANCH, onAuth });
		if (!push.ok) {
			if (/stale ref/i.test(push.error ?? "")) throw new PortError("STALE_HEAD", "the baseline moved during the merge");
			throw new Error(`push rejected: ${push.error ?? "unknown"}`);
		}
		return { mergeCommitSha: merged.oid };
	} catch (error) {
		if (error instanceof PortError) throw error;
		if (error instanceof Error && /stale ref/i.test(error.message)) throw new PortError("STALE_HEAD", "the baseline moved during the merge");
		throw error;
	} finally {
		await Promise.all([baseline.revokeToken(writeToken.id), fork.revokeToken(readToken.id)]).catch(() => undefined);
	}
}
