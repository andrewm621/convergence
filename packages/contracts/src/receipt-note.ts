import { canonicalJsonPretty } from "./canonical";
import { ContextReceipt, type ContextSnapshot, type ReceiptEntry } from "./context";
import { hashCanonical } from "./hash";

export const RECEIPT_NOTE_HEADER = "delta-receipt/v1";

function byRecord<T extends { recordId: string; version: number }>(a: T, b: T): number {
	return a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : a.version - b.version;
}

/** Order-independent hash of what was delivered: same records at the same hashes, same packet hash. */
export async function hashContextPacket(accepted: ReceiptEntry[]): Promise<string> {
	return hashCanonical([...accepted].sort(byRecord));
}

/** Hash of a ContextSnapshot, used to bind Resolutions to the exact context they were made against. */
export async function hashContextSnapshot(snapshot: ContextSnapshot): Promise<string> {
	return hashCanonical([...snapshot].sort(byRecord));
}

/**
 * Deterministic text for the git note at `refs/notes/delta`. The same receipt always yields the
 * same bytes (sorted keys and lists, fixed header, trailing newline). `noteRef` is left out: it
 * says where the note lives, so putting it inside the note would be circular.
 */
export function serializeReceiptNote(receipt: ContextReceipt): string {
	const { noteRef: _noteRef, ...rest } = ContextReceipt.parse(receipt);
	const body = {
		...rest,
		accepted: [...rest.accepted].sort(byRecord),
		proposedVisible: [...rest.proposedVisible].sort(byRecord),
	};
	return `${RECEIPT_NOTE_HEADER}\n${canonicalJsonPretty(body)}\n`;
}

export type ParseReceiptNoteResult = { ok: true; receipt: ContextReceipt } | { ok: false; error: string };

/** Read a receipt back out of a git note. Fails closed on a wrong header, bad JSON or a bad shape. */
export function parseReceiptNote(text: string): ParseReceiptNoteResult {
	const newline = text.indexOf("\n");
	if (newline === -1 || text.slice(0, newline) !== RECEIPT_NOTE_HEADER) return { ok: false, error: "not a delta receipt note" };
	let json: unknown;
	try {
		json = JSON.parse(text.slice(newline + 1));
	} catch {
		return { ok: false, error: "receipt note body is not valid JSON" };
	}
	const parsed = ContextReceipt.safeParse(json);
	return parsed.success ? { ok: true, receipt: parsed.data } : { ok: false, error: `invalid receipt: ${parsed.error.issues[0]?.message ?? "unknown"}` };
}
