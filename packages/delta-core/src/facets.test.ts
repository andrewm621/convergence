import { describe, expect, it } from "vitest";
import { changedFacetKeys, diffFacets, facetValuesEqual } from "./facets";

const snap = (facets: Record<string, string | number | boolean | null | Array<string | number | boolean | null>>) => ({ facets });

describe("diffFacets", () => {
	it("reports added, removed and changed keys, sorted by key", () => {
		const diff = diffFacets(snap({ b: 1, a: "x", gone: true }), snap({ a: "y", b: 1, new: "n" }));
		expect(diff).toEqual([
			{ key: "a", kind: "changed", from: "x", to: "y" },
			{ key: "gone", kind: "removed", from: true },
			{ key: "new", kind: "added", to: "n" },
		]);
	});

	it("is empty when only prose changed, because prose is not an input", () => {
		expect(diffFacets(snap({ a: 1 }), snap({ a: 1 }))).toEqual([]);
	});

	it("treats lists as values: same items same order are equal, different order is a change", () => {
		expect(diffFacets(snap({ l: [1, 2] }), snap({ l: [1, 2] }))).toEqual([]);
		expect(changedFacetKeys(snap({ l: [1, 2] }), snap({ l: [2, 1] }))).toEqual(["l"]);
	});

	it("does not confuse types: 1, '1', true and null are all different", () => {
		for (const [a, b] of [[1, "1"], [true, "true"], [null, "null"], [0, false]] as const) {
			expect(facetValuesEqual(a, b)).toBe(false);
		}
	});

	it("diffs against nothing as all-added", () => {
		expect(diffFacets(null, snap({ a: 1 }))).toEqual([{ key: "a", kind: "added", to: 1 }]);
	});

	it("is not affected by key order", () => {
		expect(diffFacets(snap({ a: 1, b: 2 }), snap({ b: 2, a: 1 }))).toEqual([]);
	});
});
