import { compareStrings } from "contracts";
import type { FlatTree } from "../../artifacts/tree-diff";
import { PortError, type ArtifactsPort, type CommitFilesRequest, type MergeRequest, type RepoCommit } from "../ports";

// An in-memory Artifacts: repos of full-tree commits with real git object ids (sha-1 of the git
// blob and of a commit-shaped string), forks that share history with their base, a path-level
// three-way merge, and fault injection. It implements the same `ArtifactsPort` the real binding
// adapter does, so the whole control loop runs against it with no network.
//
// What it does not prove: the real binding's behaviour, isomorphic-git pushes and merges, and
// timing. Those are checked live (see docs/control-loop.md).

type FakeCommit = { sha: string; parents: string[]; authorName: string; committerName: string; message: string; committedAt: number; files: Map<string, string> };

class FakeRepo {
	readonly commits = new Map<string, FakeCommit>();
	head: string | null = null;
	readonly blobs = new Map<string, string>();
}

const encoder = new TextEncoder();

async function sha1(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", encoder.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The git blob object id of some text. */
export async function blobOid(text: string): Promise<string> {
	return sha1(`blob ${encoder.encode(text).byteLength}\0${text}`);
}

export type PortMethod = "log" | "readFile" | "readBlob" | "tree" | "commitFiles" | "mergeFork";

export class FakeWorld {
	readonly repos = new Map<string, FakeRepo>();
	#clock = 1_760_000_000;
	readonly #failures = new Map<PortMethod, { times: number; error: Error }>();
	/** Every call the cell made, for tests that count reads. */
	readonly calls: PortMethod[] = [];

	#repo(name: string): FakeRepo {
		const repo = this.repos.get(name);
		if (!repo) throw new PortError("NOT_FOUND", `${name} was not found`);
		return repo;
	}

	/** Make the next `times` calls to `method` throw. */
	failNext(method: PortMethod, times = 1, error: Error = new PortError("UNAVAILABLE", `injected ${method} failure`)): void {
		this.#failures.set(method, { times, error });
	}

	#enter(method: PortMethod): void {
		this.calls.push(method);
		const failure = this.#failures.get(method);
		if (failure && failure.times > 0) {
			failure.times -= 1;
			throw failure.error;
		}
	}

	// ---------- the world a test builds ----------

	/** A new repo with one commit holding `files`. */
	async create(name: string, files: Record<string, string>, author = "delta-convergence"): Promise<string> {
		if (this.repos.has(name)) throw new Error(`${name} already exists`);
		this.repos.set(name, new FakeRepo());
		return this.push(name, files, { author, message: `seed ${name}` });
	}

	/** A fork shares every commit of its base, then goes its own way. */
	fork(base: string, name: string): string {
		const source = this.#repo(base);
		const repo = new FakeRepo();
		for (const [sha, commit] of source.commits) repo.commits.set(sha, commit);
		for (const [oid, text] of source.blobs) repo.blobs.set(oid, text);
		repo.head = source.head;
		this.repos.set(name, repo);
		return repo.head ?? "";
	}

	/** Commit changes on top of the head. A value of `null` deletes the path. Returns the new sha. */
	async push(name: string, changes: Record<string, string | null>, options: { author?: string; committer?: string; message?: string } = {}): Promise<string> {
		const repo = this.#repo(name);
		const parent = repo.head ? repo.commits.get(repo.head) : undefined;
		const files = new Map(parent?.files ?? []);
		for (const [path, text] of Object.entries(changes)) {
			if (text === null) files.delete(path);
			else files.set(path, text);
		}
		return this.#commit(repo, files, repo.head ? [repo.head] : [], options.author ?? "agent", options.committer ?? options.author ?? "agent", options.message ?? "update");
	}

	async #commit(repo: FakeRepo, files: Map<string, string>, parents: string[], authorName: string, committerName: string, message: string): Promise<string> {
		this.#clock += 1;
		for (const text of files.values()) repo.blobs.set(await blobOid(text), text);
		const listing = await Promise.all([...files.entries()].sort(([a], [b]) => compareStrings(a, b)).map(async ([path, text]) => `${path} ${await blobOid(text)}`));
		const sha = await sha1(`commit\n${parents.join(",")}\n${authorName}\n${committerName}\n${this.#clock}\n${message}\n${listing.join("\n")}`);
		repo.commits.set(sha, { sha, parents, authorName, committerName, message, committedAt: this.#clock, files });
		repo.head = sha;
		return sha;
	}

	headOf(name: string): string | null {
		return this.#repo(name).head;
	}

	filesAt(name: string, ref = "main"): Record<string, string> {
		const repo = this.#repo(name);
		const sha = ref === "main" ? repo.head : ref;
		const commit = sha ? repo.commits.get(sha) : undefined;
		return Object.fromEntries(commit?.files ?? []);
	}

	// ---------- the port ----------

	port(): ArtifactsPort {
		return {
			log: async (repo, { limit }) => {
				this.#enter("log");
				const r = this.#repo(repo);
				const out: RepoCommit[] = [];
				for (let sha = r.head; sha && out.length < limit; ) {
					const c = r.commits.get(sha);
					if (!c) break;
					out.push({ sha: c.sha, message: c.message, authorName: c.authorName, committerName: c.committerName, parents: c.parents, committedAt: c.committedAt });
					sha = c.parents[0] ?? null;
				}
				return out;
			},
			readFile: async (repo, ref, path) => {
				this.#enter("readFile");
				const r = this.#repo(repo);
				const sha = ref === "main" ? r.head : ref;
				return (sha ? r.commits.get(sha)?.files.get(path) : undefined) ?? null;
			},
			readBlob: async (repo, oid) => {
				this.#enter("readBlob");
				return this.#repo(repo).blobs.get(oid) ?? null;
			},
			tree: async (repo, commit) => {
				this.#enter("tree");
				const c = this.#repo(repo).commits.get(commit);
				if (!c) throw new PortError("NOT_FOUND", `commit ${commit} not found in ${repo}`);
				const tree: FlatTree = new Map();
				for (const [path, text] of c.files) tree.set(path, { hash: await blobOid(text), mode: "100644" });
				return tree;
			},
			commitFiles: async (request: CommitFilesRequest) => {
				this.#enter("commitFiles");
				const repo = this.#repo(request.repo);
				if (repo.head !== request.expectedHead) throw new PortError("STALE_HEAD", `${request.repo} is no longer at ${request.expectedHead}`);
				return { commitSha: await this.push(request.repo, request.files, { author: request.author.name, committer: request.committer.name, message: request.message }) };
			},
			mergeFork: async (request: MergeRequest) => {
				this.#enter("mergeFork");
				return { mergeCommitSha: await this.#merge(request) };
			},
		};
	}

	async #merge(request: MergeRequest): Promise<string> {
		const baseline = this.#repo(request.baselineRepo);
		const fork = this.#repo(request.forkRepo);
		if (baseline.head !== request.expectedBaselineCommit) throw new PortError("STALE_HEAD", "the baseline is no longer at the commit the approval was given against");
		if (fork.head !== request.forkHeadSha) throw new PortError("STALE_HEAD", "the fork is no longer at the commit the approval was given against");
		const ours = baseline.commits.get(baseline.head ?? "");
		const theirs = fork.commits.get(fork.head ?? "");
		if (!ours || !theirs) throw new PortError("NOT_FOUND", "a head commit is missing");

		const ancestors = (repo: FakeRepo, from: string): Set<string> => {
			const seen = new Set<string>();
			const queue = [from];
			for (let sha = queue.shift(); sha; sha = queue.shift()) {
				if (seen.has(sha)) continue;
				seen.add(sha);
				queue.push(...(repo.commits.get(sha)?.parents ?? []));
			}
			return seen;
		};
		const mine = ancestors(baseline, ours.sha);
		// Nearest common ancestor: breadth-first from the fork head, first one the baseline also has.
		let base: FakeCommit | undefined;
		const queue = [theirs.sha];
		const visited = new Set<string>();
		for (let sha = queue.shift(); sha && !base; sha = queue.shift()) {
			if (visited.has(sha)) continue;
			visited.add(sha);
			if (mine.has(sha)) base = fork.commits.get(sha);
			else queue.push(...(fork.commits.get(sha)?.parents ?? []));
		}
		if (!base) throw new PortError("MERGE_CONFLICT", "the fork shares no history with the baseline");

		for (const [sha, commit] of fork.commits) baseline.commits.set(sha, commit);
		for (const [oid, text] of fork.blobs) baseline.blobs.set(oid, text);
		if (base.sha === ours.sha) {
			baseline.head = theirs.sha; // fast-forward
			return theirs.sha;
		}
		const merged = new Map<string, string>();
		for (const path of new Set([...base.files.keys(), ...ours.files.keys(), ...theirs.files.keys()])) {
			const [b, o, t] = [base.files.get(path), ours.files.get(path), theirs.files.get(path)];
			let pick: string | undefined;
			if (o === t) pick = o;
			else if (o === b) pick = t;
			else if (t === b) pick = o;
			else throw new PortError("MERGE_CONFLICT", `both sides changed ${path}`);
			if (pick !== undefined) merged.set(path, pick);
		}
		return this.#commit(baseline, merged, [ours.sha, theirs.sha], request.author.name, request.committer.name, request.message);
	}
}
