// Receipt for a revalidation run: what context the agent was handed this time. Pure (WebCrypto only), so it
// is unit-tested in Node and also runs in the container. No imports besides the record parser.
// This is the runner-level record written to `.delta/receipt.json` and a git note; the control plane's own
// ContextReceipt (packages/contracts) is computed from the same facts by the DO.
import { parseContextRecord } from "./stub-agent-lib.ts";

export interface RevalidationChange {
	recordId: string;
	fromVersion: number;
	toVersion: number;
}

export interface Receipt {
	kind: "revalidation";
	workItemId: string;
	/** Fork head the re-run started from. */
	baseCommit: string;
	changes: RevalidationChange[];
	delivered: { file: string; recordId: string; version: number; sha256: string }[];
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic: delivered files are listed in name order. Files that are not valid records are skipped. */
export async function buildRevalidationReceipt(input: {
	workItemId: string;
	baseCommit: string;
	changes: RevalidationChange[];
	contextFiles: Record<string, string>;
}): Promise<Receipt> {
	const delivered: Receipt["delivered"] = [];
	for (const file of Object.keys(input.contextFiles).sort()) {
		const text = input.contextFiles[file] ?? "";
		const record = parseContextRecord(text);
		if (record) delivered.push({ file, recordId: record.id, version: record.version, sha256: await sha256Hex(text) });
	}
	return { kind: "revalidation", workItemId: input.workItemId, baseCommit: input.baseCommit, changes: input.changes, delivered };
}
