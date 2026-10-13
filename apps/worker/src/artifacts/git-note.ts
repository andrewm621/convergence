import git, { type AuthCallback, type HttpClient } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { WriteNoteRequest } from "../cell/ports";
import { getRepo, withStaleRefRetry } from "./git-write";
import { MemoryFS } from "./memory-fs";
import { stripExpiry } from "./tokens";

// Receipt notes: a note on a commit of the work item's fork, in its own ref (refs/notes/delta), so the
// receipt travels with the repo and `git notes --ref=delta show <sha>` reads it. The Worker writes it;
// the agent never does. A note is a commit on the notes ref whose tree maps "annotated sha" to a blob.
//
// No clone of the branch is needed: init an empty repo, fetch the notes ref if the remote has one (so
// the new note commit is a fast-forward of it), add the note, push that one ref by an explicit
// refspec. Only the notes ref moves; the branch the poller watches is never touched. Unverified against
// the live Artifacts service (does it accept a push to a non-branch ref?): the note is best effort.

const DIR = "/n";

type Identity = { name: string; email: string };

function isNotFound(error: unknown): boolean {
	const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
	const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
	return name === "NotFoundError" || code === "NotFoundError";
}

/**
 * Add `text` as the note on `commitSha` and push `ref`. A note already on that commit is replaced.
 * One attempt: the caller retries a `stale ref` (another writer moved the notes ref) from scratch.
 */
export async function pushNote(options: {
	fs: MemoryFS;
	http: HttpClient;
	remote: string;
	onAuth: AuthCallback;
	commitSha: string;
	ref: string;
	text: string;
	author: Identity;
	committer?: Identity;
}): Promise<{ noteCommit: string }> {
	const { fs, remote, onAuth, ref } = options;
	await git.init({ fs, dir: DIR, defaultBranch: "main" });
	// fetch() wants a configured remote (it records remote-tracking refs by its refspec) even when it is given the url.
	await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote });
	try {
		const fetched = await git.fetch({ fs, http: options.http, dir: DIR, remote: "origin", ref, remoteRef: ref, singleBranch: true, onAuth });
		if (fetched.fetchHead) await git.writeRef({ fs, dir: DIR, ref, value: fetched.fetchHead, force: true });
	} catch (error) {
		// The remote has no notes yet: this note is the first commit on the ref.
		if (!isNotFound(error)) throw error;
	}
	const noteCommit = await git.addNote({
		fs,
		dir: DIR,
		ref,
		oid: options.commitSha,
		note: options.text,
		force: true,
		author: options.author,
		committer: options.committer ?? options.author,
	});
	const push = await git.push({ fs, http: options.http, dir: DIR, url: remote, ref, remoteRef: ref, onAuth });
	if (!push.ok) throw new Error(`note push rejected: ${push.error ?? "unknown"}`);
	return { noteCommit };
}

/** The note text on a commit as the notes ref sees it in this repo, or null. For tests and diagnostics. */
export async function readNote(fs: MemoryFS, ref: string, commitSha: string): Promise<string | null> {
	try {
		const bytes = await git.readNote({ fs, dir: DIR, ref, oid: commitSha });
		return new TextDecoder().decode(bytes);
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

/** Write a receipt note to a fork through the Artifacts binding: a short-lived write token, revoked on every path. */
export async function writeReceiptNote(env: Env, request: WriteNoteRequest): Promise<void> {
	using repo = await getRepo(env, request.repo);
	const { remote } = await repo.info();
	const token = await repo.createToken("write", 300);
	const onAuth: AuthCallback = () => ({ username: "x", password: stripExpiry(token.plaintext) });
	try {
		await withStaleRefRetry(() =>
			pushNote({ fs: new MemoryFS(), http, remote, onAuth, commitSha: request.commitSha, ref: request.ref, text: request.text, author: request.author, committer: request.committer }),
		);
	} finally {
		await repo.revokeToken(token.id).catch(() => false);
	}
}
