import { canonicalJson, type FacetChange, type FacetValue, type RecordSnapshot } from "contracts";

/** Structural equality of two facet values (scalars or flat lists). */
export function facetValuesEqual(a: FacetValue | undefined, b: FacetValue | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return canonicalJson(a) === canonicalJson(b);
}

type Governed = Pick<RecordSnapshot, "facets">;

/**
 * The facet diff between two versions of a record: which governed keys were added, removed or
 * changed. Sorted by key so the result is deterministic. Prose is not an input, so a prose-only
 * edit produces an empty diff by construction.
 */
export function diffFacets(prev: Governed | null, next: Governed): FacetChange[] {
	const before = prev?.facets ?? {};
	const after = next.facets;
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const changes: FacetChange[] = [];
	for (const key of keys) {
		const from = before[key];
		const to = after[key];
		if (from === undefined && to !== undefined) changes.push({ key, kind: "added", to });
		else if (from !== undefined && to === undefined) changes.push({ key, kind: "removed", from });
		else if (!facetValuesEqual(from, to)) changes.push({ key, kind: "changed", from, to });
	}
	return changes;
}

/** Keys whose governed value differs between two versions. */
export function changedFacetKeys(prev: Governed | null, next: Governed): string[] {
	return diffFacets(prev, next).map((change) => change.key);
}
