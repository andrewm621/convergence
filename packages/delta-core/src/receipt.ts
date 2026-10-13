import { formatNoteRef, hashContextPacket, type CellState, type ContextReceipt, type ReceiptEntry } from "contracts";
import { currentSnapshot } from "./cell-state";

export type ReceiptRequest = {
	baselineCommit: string;
	/** Records delivered to the work item. Default: every record with an accepted head. */
	recordIds?: string[];
	/** Commit on the fork the receipt is written against as a git note; sets `noteRef`. */
	noteCommit?: string;
};

/**
 * Compile a receipt at the cell's current accepted versions (the receipt for a new work item, or
 * the fresh one after a revalidate). Hashing is async (WebCrypto), which is why this sits outside
 * the sync `reconcile`: the adapter builds it and hands it over in a `ReceiptIssued` event.
 */
export async function buildReceipt(state: CellState, request: ReceiptRequest): Promise<ContextReceipt> {
	const ids = request.recordIds ?? Object.keys(state.records).sort();
	const accepted: ReceiptEntry[] = [];
	for (const recordId of [...new Set(ids)].sort()) {
		const snapshot = currentSnapshot(state, recordId);
		if (!snapshot) throw new Error(`buildReceipt: ${recordId} has no accepted version`);
		accepted.push({ recordId, version: snapshot.version, blobHash: snapshot.blobHash, facetHash: snapshot.facetHash });
	}
	return {
		baselineCommit: request.baselineCommit,
		contextPacketHash: await hashContextPacket(accepted),
		accepted,
		proposedVisible: [],
		...(request.noteCommit ? { noteRef: formatNoteRef(request.noteCommit) } : {}),
	};
}
