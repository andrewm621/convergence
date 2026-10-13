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
type MergeDriver = NonNullable<Parameters<typeof git.merge>[0]["mergeDriver"]>;

/** Files the control plane keeps in a fork (claims, receipt, delivered context), not part of the work being promoted. */
const FORK_METADATA_DIR = ".delta/";
const isForkMetadata = (path: string): boolean => path.startsWith(FORK_METADATA_DIR);

/** The paths of a MergeConflictError, or none for any other error. */
function conflictPaths(error: unknown): string[] {
	if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "MergeConflictError") return [];
	const filepaths = (error as { data?: { filepaths?: unknown } }).data?.filepaths;
	return Array.isArray(filepaths) ? filepaths.filter((p): p is string => typeof p === "string") : [];
}

/** A file's text at a commit, or "" when the commit has no such file (the base of an add/add). */
async function textAt(fs: MemoryFS, dir: string, oid: string, filepath: string): Promise<string> {
	try {
		return Buffer.from((await git.readBlob({ fs, dir, oid, filepath })).blob).toString("utf8");
	} catch {
		return "";
	}
}

/**
 * A merge driver that takes the fork's (theirs) text for exactly the metadata conflicts `paths` named. The driver is
 * handed a file's base name, not its path, so a file is recognised by its three texts (base, ours, theirs): the default
 * merge conflicted on that triple, so no other path can carry it and merge cleanly. Anything else a driver is asked
 * about is a file both sides changed that the default merge would have combined line by line; it stays a conflict
 * here rather than being guessed at.
 */
async function forkMetadataDriver(fs: MemoryFS, dir: string, ours: string, theirs: string, paths: string[]): Promise<MergeDriver> {
	const [oursOid, theirsOid] = await Promise.all([git.resolveRef({ fs, dir, ref: ours }), git.resolveRef({ fs, dir, ref: theirs })]);
	const [baseOid] = await git.findMergeBase({ fs, dir, oids: [oursOid, theirsOid] });
	const known = new Set<string>();
	for (const path of paths) {
		const texts = await Promise.all([baseOid ? textAt(fs, dir, baseOid, path) : "", textAt(fs, dir, oursOid, path), textAt(fs, dir, theirsOid, path)]);
		known.add(JSON.stringify(texts));
	}
	return ({ contents }) =>
		known.has(JSON.stringify([contents[0], contents[1], contents[2]]))
			? { cleanMerge: true, mergedText: contents[2] ?? "" }
			: { cleanMerge: false, mergedText: contents[1] ?? "" };
}

/**
 * Merge `theirs` into `ours` (a branch) in an already-cloned repo. Fast-forwards when it can;
 * otherwise makes a merge commit. A real conflict is MERGE_CONFLICT; the repo is left untouched.
 *
 * `expect` pins what was actually cloned and fetched: the heads are resolved after the transfer and
 * must be the commits the approval was given against, else STALE_HEAD. The check that ran before the
 * clone cannot cover a push that lands between it and the fetch.
 */
export async function mergeInto(
	fs: MemoryFS,
	dir: string,
	options: { ours: string; theirs: string; message: string; author: Identity; committer?: Identity; expect?: { ours: string; theirs: string } },
): Promise<{ oid: string; fastForward: boolean }> {
	if (options.expect) {
		const [ours, theirs] = await Promise.all([git.resolveRef({ fs, dir, ref: options.ours }), git.resolveRef({ fs, dir, ref: options.theirs })]);
		if (ours !== options.expect.ours) throw new PortError("STALE_HEAD", "the baseline moved between the approval and the clone");
		if (theirs !== options.expect.theirs) throw new PortError("STALE_HEAD", "the fork moved between the approval and the fetch");
	}
	const merge = (mergeDriver?: MergeDriver) =>
		git.merge({
			fs,
			dir,
			ours: options.ours,
			theirs: options.theirs,
			message: options.message,
			author: options.author,
			committer: options.committer ?? options.author,
			fastForward: true,
			abortOnConflict: true,
			mergeDriver,
		});
	try {
		let result;
		try {
			result = await merge();
		} catch (error) {
			// Every fork carries its own `.delta/claims.json` (and, once revalidated, `.delta/receipt.json`), so the second
			// work item promoted into a baseline that already holds the first one's is an add/add conflict on a file that
			// is control-plane metadata, not work. When those are the only conflicts, the fork being promoted wins them.
			const paths = conflictPaths(error);
			if (paths.length === 0 || !paths.every(isForkMetadata)) throw error;
			result = await merge(await forkMetadataDriver(fs, dir, options.ours, options.theirs, paths));
		}
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

		const merged = await mergeInto(fs, DIR, {
			ours: BRANCH,
			theirs: FORK_REF,
			message: request.message,
			author: request.author,
			committer: request.committer,
			expect: { ours: request.expectedBaselineCommit, theirs: request.forkHeadSha },
		});
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
