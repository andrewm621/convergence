import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { stripExpiry } from "./tokens";

// Worker-side git writes. The Artifacts binding is read-only, so writes go over git smart-HTTP.
// The token travels in the Authorization header built by onAuth, never in the URL.

const DIR = "/w";
const BRANCH = "main";
const AUTHOR = { name: "delta-convergence", email: "delta@example.invalid" };

export interface CommitResult {
	oid: string;
	attempts: number;
	started: "init" | "clone";
	timingsMs: Record<string, number>;
}

export function errorCode(e: unknown): string | undefined {
	return e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GetRepoOptions {
	/** Total tries, including the first. */
	attempts?: number;
	/**
	 * Treat NOT_FOUND as transient. Opt in only straight after create/fork, when the new repo can
	 * briefly read as missing. Everywhere else NOT_FOUND is a real answer and must surface at once.
	 */
	retryNotFound?: boolean;
}

/** get() throws while a repo is still being created or forked; retry those with backoff. */
export async function getRepo(env: Env, name: string, opts: GetRepoOptions = {}): Promise<ArtifactsRepo> {
	const { attempts = 12, retryNotFound = false } = opts;
	const transient = new Set(["CREATE_IN_PROGRESS", "FORK_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);
	for (let attempt = 1; ; attempt++) {
		try {
			return await env.ARTIFACTS.get(name);
		} catch (e) {
			const code = errorCode(e);
			const retriable = code !== undefined && (transient.has(code) || (retryNotFound && code === "NOT_FOUND"));
			// No sleep after the final attempt: surface the error straight away.
			if (!retriable || attempt >= attempts) throw e;
			await sleep(250 * attempt);
		}
	}
}

/** Reject anything that could escape the work tree or touch git internals. */
export function assertSafePath(path: string): void {
	const segments = path.split("/");
	const bad =
		!path ||
		path.startsWith("/") ||
		segments.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git");
	if (bad) throw new Error(`unsafe path: ${path}`);
}

function isStaleRef(e: unknown): boolean {
	return e instanceof Error && /stale ref/i.test(e.message);
}

/** Run `fn`, retrying only on a single-writer `stale ref` rejection: 3 tries with jitter. */
export async function withStaleRefRetry<T>(fn: (attempt: number) => Promise<T>, tries = 3): Promise<T> {
	let last: unknown;
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			return await fn(attempt);
		} catch (e) {
			last = e;
			if (!isStaleRef(e) || attempt === tries) throw e;
			await sleep(100 * attempt + Math.floor(Math.random() * 250));
		}
	}
	throw last;
}

/**
 * Commit `files` to the repo's main branch: init when empty, shallow clone otherwise, then push.
 * Each retry re-clones, re-applies and pushes so a lost race never builds on a stale head.
 * Pass `retryNotFound` only for a repo created or forked moments ago. `author` defaults to the
 * Worker's own identity; the cell passes the acting human so the baseline records who decided.
 */
export async function commitFiles(
	env: Env,
	repoName: string,
	files: Record<string, string>,
	message: string,
	opts: { retryNotFound?: boolean; author?: { name: string; email: string }; committer?: { name: string; email: string } } = {},
): Promise<CommitResult> {
	for (const path of Object.keys(files)) assertSafePath(path);

	using repo = await getRepo(env, repoName, { retryNotFound: opts.retryNotFound });
	const { remote } = await repo.info();
	const token = await repo.createToken("write", 300);
	const onAuth = () => ({ username: "x", password: stripExpiry(token.plaintext) });

	try {
		return await withStaleRefRetry(async (attempt) => {
			const timingsMs: Record<string, number> = {};
			const timed = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
				const t0 = Date.now();
				try {
					return await fn();
				} finally {
					timingsMs[key] = Date.now() - t0;
				}
			};

			const fs = new MemoryFS();
			const empty = (await repo.log({ ref: BRANCH, limit: 1 })).length === 0;
			if (empty) {
				await timed("init", () => git.init({ fs, dir: DIR, defaultBranch: BRANCH }));
			} else {
				await timed("clone", () =>
					git.clone({ fs, http, dir: DIR, url: remote, ref: BRANCH, singleBranch: true, depth: 1, onAuth }),
				);
			}

			for (const [path, content] of Object.entries(files)) {
				await fs.promises.writeFile(`${DIR}/${path}`, content);
				await git.add({ fs, dir: DIR, filepath: path });
			}
			const oid = await git.commit({ fs, dir: DIR, message, author: opts.author ?? AUTHOR, committer: opts.committer ?? opts.author ?? AUTHOR });
			const push = await timed("push", () =>
				git.push({ fs, http, dir: DIR, url: remote, ref: BRANCH, remoteRef: BRANCH, onAuth }),
			);
			if (!push.ok) throw new Error(`push rejected: ${push.error ?? "unknown"}`);
			return { oid, attempts: attempt, started: empty ? "init" : "clone", timingsMs } as CommitResult;
		});
	} finally {
		// Short-lived write tokens are revoked on every path, not just the happy one.
		await repo.revokeToken(token.id).catch(() => false);
	}
}
