import { toRecordSnapshot, snapshotHashOf, type DeltaEvent, type FacetValue, type RecordSnapshot } from "contracts";
import { currentSnapshot } from "delta-core";
import { renderRecord } from "@/mock/session";
import { toCellState, type ViewState } from "@/state/store";

/**
 * The BaselinePushed for an edit, built the way the mock's own "commit" builds it: render the record file, parse it, hash it.
 * It shares no code with the adapter under test, so agreement between the two is evidence, not an echo.
 */
export async function baselineFor(view: ViewState, recordId: string, facets: Record<string, FacetValue>, sha: string): Promise<Extract<DeltaEvent, { type: "BaselinePushed" }>> {
	const state = toCellState(view);
	const prev = currentSnapshot(state, recordId);
	if (!prev) throw new Error("no such record");
	const text = renderRecord({
		id: recordId,
		version: prev.version + 1,
		authority: prev.authority,
		actor: prev.authority,
		acceptedAt: "2026-10-14T09:00:00Z",
		supersedes: `${recordId}@${prev.version}`,
		validation: prev.validation,
		facets,
		not: [],
		prose: "Candidate wording.",
	});
	const parsed = await toRecordSnapshot(text);
	if (!parsed.ok) throw new Error(parsed.error);
	const heads: RecordSnapshot[] = Object.keys(state.records).map((id) => (id === recordId ? parsed.snapshot : currentSnapshot(state, id))).filter((h): h is RecordSnapshot => h !== null);
	return { type: "BaselinePushed", ts: "2026-10-14T09:00:00Z", repo: "independent-check", commitSha: sha, snapshotHash: await snapshotHashOf(heads), records: [parsed.snapshot], invalid: [] };
}

