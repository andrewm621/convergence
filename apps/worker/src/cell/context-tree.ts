import { compareStrings, hashContextSnapshot, toRecordSnapshot, type RecordSnapshot } from "contracts";
import type { FlatTree } from "../artifacts/tree-diff";
import type { ArtifactsPort } from "./ports";

/** Context records live at `context/**.md` in the baseline. */
export const CONTEXT_FILE = /^context\/.+\.md$/;

export type ContextFile = {
	path: string;
	/** Git blob oid; it doubles as the record's `blobHash`. */
	oid: string;
	result: { ok: true; snapshot: RecordSnapshot; body: string } | { ok: false; error: string };
};

const MAX_RECORD_BYTES = 256 * 1024;

/**
 * Reads and parses context records through the port. Parsing is a pure function of the blob, so
 * results are cached by oid: a record that did not change is never read twice.
 */
export class ContextReader {
	readonly #port: ArtifactsPort;
	readonly #cache = new Map<string, ContextFile["result"]>();

	constructor(port: ArtifactsPort) {
		this.#port = port;
	}

	/** Parse the given paths of a tree. Unparseable files come back with `ok: false`; they never throw. */
	async read(repo: string, tree: FlatTree, paths: string[]): Promise<ContextFile[]> {
		const out: ContextFile[] = [];
		for (const path of [...paths].sort(compareStrings)) {
			const entry = tree.get(path);
			if (!entry) continue;
			out.push({ path, oid: entry.hash, result: await this.#parse(repo, entry.hash) });
		}
		return out;
	}

	/** Every context record in a tree. */
	async readAll(repo: string, tree: FlatTree): Promise<ContextFile[]> {
		return this.read(
			repo,
			tree,
			[...tree.keys()].filter((path) => CONTEXT_FILE.test(path)),
		);
	}

	async #parse(repo: string, oid: string): Promise<ContextFile["result"]> {
		const cached = this.#cache.get(oid);
		if (cached) return cached;
		const text = await this.#port.readBlob(repo, oid);
		let result: ContextFile["result"];
		if (text === null) result = { ok: false, error: "blob could not be read" };
		else if (text.length > MAX_RECORD_BYTES) result = { ok: false, error: "context record is too large" };
		else result = await toRecordSnapshot(text, { blobHash: oid });
		this.#cache.set(oid, result);
		return result;
	}
}

/**
 * Hash of the ContextSnapshot at a commit: the highest accepted version of each record, as
 * `{recordId, version, blobHash}`. The cell compares it when it checks a Resolution's binding.
 * It is computed from the tree, not from what the reconciler decided to accept.
 */
export async function snapshotHashOf(files: ContextFile[]): Promise<string> {
	const heads = new Map<string, RecordSnapshot>();
	for (const file of files) {
		if (!file.result.ok || file.result.snapshot.status !== "accepted") continue;
		const snap = file.result.snapshot;
		const best = heads.get(snap.recordId);
		if (!best || snap.version > best.version) heads.set(snap.recordId, snap);
	}
	return hashContextSnapshot([...heads.values()].map(({ recordId, version, blobHash }) => ({ recordId, version, blobHash })));
}
