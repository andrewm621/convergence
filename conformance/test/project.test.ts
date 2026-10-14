import { describe, expect, it } from "vitest";
import { canonical, diffProjections, project } from "../lib/project.ts";

const state = { baselineCommit: null, snapshotHash: null, records: {}, workItems: {}, dependencies: [], processed: {} };

describe("effects are compared as a set of (effect type, work item, reason code) entries", () => {
	it("a duplicate of an identical entry is not normative", () => {
		// What the reference emits for a `reject`: the Blocked condition's effect, and one for the rejection itself.
		const twice = project({
			state,
			effects: [
				{ type: "BLOCK_PROMOTION", workItemId: "WI-2", reasonCodes: ["MISSING_EVIDENCE", "RESOLUTION_REJECTED"] },
				{ type: "BLOCK_PROMOTION", workItemId: "WI-2", reasonCodes: ["RESOLUTION_REJECTED"] },
			],
		});
		const once = project({ state, effects: [{ type: "BLOCK_PROMOTION", workItemId: "WI-2", reasonCodes: ["RESOLUTION_REJECTED", "MISSING_EVIDENCE"] }] });
		expect(canonical(twice)).toBe(canonical(once));
		expect(diffProjections(once, twice)).toEqual([]);
	});

	it("a missing reason code, work item or effect is still a difference", () => {
		const expected = project({ state, effects: [{ type: "BLOCK_PROMOTION", workItemId: "WI-2", reasonCodes: ["MISSING_EVIDENCE", "RESOLUTION_REJECTED"] }] });
		const fewerCodes = project({ state, effects: [{ type: "BLOCK_PROMOTION", workItemId: "WI-2", reasonCodes: ["RESOLUTION_REJECTED"] }] });
		const otherItem = project({ state, effects: [{ type: "BLOCK_PROMOTION", workItemId: "WI-1", reasonCodes: ["MISSING_EVIDENCE", "RESOLUTION_REJECTED"] }] });
		expect(diffProjections(expected, fewerCodes)).toHaveLength(1);
		expect(diffProjections(expected, otherItem)).toHaveLength(4);
		expect(diffProjections(expected, project({ state, effects: [] }))).toHaveLength(2);
	});

	it("an effect with no reason codes is one entry", () => {
		const { effects } = project({ state, effects: [{ type: "ALLOW_PROMOTION", workItemId: "WI-2", forkHeadSha: "a", baselineCommit: "b", reasonCodes: [] }] });
		expect(effects).toEqual([{ type: "ALLOW_PROMOTION", workItemId: "WI-2", forkHeadSha: "a", baselineCommit: "b", reasonCode: null }]);
	});
});
