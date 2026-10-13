import type { FacetValue } from "./common";
import type { ContextReceipt, RecordSnapshot } from "./context";
import { formatNoteRef } from "./context";
import { hashContextPacket, hashContextSnapshot } from "./receipt-note";
import { toRecordSnapshot } from "./record-parser";

/**
 * Helpers for the plain-data scenario fixtures in `scenarios/*` and for tests. Not used by the
 * reconciler. Fixtures are real Markdown files run through the real parser, so they exercise the
 * same path the Worker will.
 */

/** A context file as it sits in the baseline repo: path, raw text and its parsed, hashed snapshot. */
export type ScenarioDoc = { path: string; text: string; snapshot: RecordSnapshot };

export async function loadDoc(path: string, text: string): Promise<ScenarioDoc> {
	const result = await toRecordSnapshot(text);
	if (!result.ok) throw new Error(`scenario fixture ${path} is malformed: ${result.error}`);
	return { path, text, snapshot: result.snapshot };
}

/** Deterministic fake commit id: a one-letter hex prefix plus a counter, 40 chars like a git sha. */
export function fakeSha(prefix: "a" | "b" | "c" | "d" | "e" | "f", n: number): string {
	return `${prefix}${n.toString(16).padStart(39, "0")}`;
}

/** Hash of the ContextSnapshot for a set of accepted record heads. */
export async function snapshotHashOf(heads: RecordSnapshot[]): Promise<string> {
	return hashContextSnapshot(heads.map(({ recordId, version, blobHash }) => ({ recordId, version, blobHash })));
}

/** A receipt delivering exactly these record versions. */
export async function receiptOf(baselineCommit: string, delivered: RecordSnapshot[], options: { noteCommit?: string } = {}): Promise<ContextReceipt> {
	const accepted = delivered.map(({ recordId, version, blobHash, facetHash }) => ({ recordId, version, blobHash, facetHash }));
	return {
		baselineCommit,
		contextPacketHash: await hashContextPacket(accepted),
		accepted,
		proposedVisible: [],
		...(options.noteCommit ? { noteRef: formatNoteRef(options.noteCommit) } : {}),
	};
}

/**
 * A scenario's contract check (rule R8) as a pure function of the file contents of a pushed head and the
 * accepted facets of the record whose `validation:` names it. The Worker reads the files from the repo at the
 * verified sha, never from the agent, and records the result as Evidence of kind `delta-run-check`.
 * No I/O, no clock, no model.
 */
export type ContractCheckResult = { pass: boolean; output: string };
export type ContractCheck = {
	/** Which files of the pushed tree the check reads (repo-relative paths). The Worker passes only these to `run`. */
	reads(path: string): boolean;
	run(files: Record<string, string>, facets: Record<string, FacetValue>): ContractCheckResult;
};
