import { canonicalJson, hashFacets, sha256Hex, snapshotHashOf, type DeltaEvent, type FacetValue, type RecordSnapshot } from "contracts";
import { currentSnapshot, diffFacets, whatIf, type WhatIfOutcome } from "delta-core";
import { toCellState, type ViewState } from "./store";

/**
 * Compare alternatives: hold two or three candidate edits of one decision against the same cell and read what the engine
 * would do with each. Nothing is decided here. Each option becomes the `BaselinePushed` the Worker would build for that
 * edit (see apps/worker/src/cell/context-change.ts), and `whatIf` runs it through the real `reconcile` on a copy of the
 * console's state. Nothing is committed, saved or sent, and no client call is made.
 */

/** A candidate edit: the settings the decision would hold. `id` is the caller's key and comes back on the outcome. */
export type CompareOption = { id: string; facets: Record<string, FacetValue> };

/**
 * The engine's verdict for each option, in the order given, or null when this view cannot answer (no policy yet, or the
 * decision has no accepted version). An option whose settings equal the accepted version is pushed as that version
 * itself, so the engine answers that nothing changed rather than inventing a v+1 out of nothing.
 */
export async function compareOptions(view: ViewState, recordId: string, options: readonly CompareOption[], now: Date = new Date()): Promise<WhatIfOutcome[] | null> {
	const state = toCellState(view);
	const current = currentSnapshot(state, recordId);
	if (!view.policy || !current) return null;
	const others = Object.keys(state.records)
		.filter((id) => id !== recordId)
		.map((id) => currentSnapshot(state, id))
		.filter((head): head is RecordSnapshot => head !== null);

	const candidates = await Promise.all(
		options.map(async (option) => {
			const changed = diffFacets(current, { facets: option.facets }).length > 0;
			const version = changed ? current.version + 1 : current.version;
			const next: RecordSnapshot = changed
				? {
						...current,
						version,
						facets: option.facets,
						not: {},
						// Stands in for the git blob of the file the Worker would write: distinct per candidate, never shared with a real one.
						blobHash: await sha256Hex(`whatif\n${recordId}@${version}\n${canonicalJson(option.facets)}`),
						facetHash: await hashFacets(option.facets),
					}
				: current;
			const change: Extract<DeltaEvent, { type: "BaselinePushed" }> = {
				type: "BaselinePushed",
				ts: now.toISOString(),
				repo: "whatif-preview",
				// A sha the cell has never processed, or reconcile answers DUPLICATE_EVENT and nothing blocks.
				commitSha: await sha256Hex(`whatif\n${view.baselineCommit}\n${option.id}\n${canonicalJson(option.facets)}`),
				snapshotHash: await snapshotHashOf([...others, next]),
				records: [next],
				invalid: [],
			};
			return { id: option.id, change };
		}),
	);
	return whatIf(state, view.policy, candidates);
}
