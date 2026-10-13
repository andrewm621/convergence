import { describe, expect, it } from "vitest";
import { createCell, conditionTypes, effectTypes, reasonsOf } from "./testing/harness";
import { baselinePush, nextSha, notifications as n, registerItem, salesOps as s, variant } from "./testing/scenarios";

async function notificationsCell(policy = n.policy) {
	const cell = await createCell(n.seed, policy);
	await cell.send(n.events.registerWi1);
	await cell.send(n.events.registerWi2);
	return cell;
}

async function salesOpsCell() {
	const cell = await createCell(s.seed, s.policy);
	for (const e of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5]) await cell.send(e);
	return cell;
}

describe("R1 staleness is facet-level", () => {
	it("[positive] a changed facet the work depends on makes it Stale, blocks promotion and asks for review", async () => {
		const cell = await notificationsCell();
		const result = await cell.send(n.events.v2);

		const wi2 = await cell.wi("WI-2");
		const stale = wi2.conditions.find((c) => c.type === "Stale");
		expect(stale?.reasonCodes).toEqual(["STALE_RECEIPT", "FACET_CHANGED"]);
		expect(stale?.facetKeys).toEqual(n.expected.afterV2["WI-2"].staleFacets);
		expect(stale?.recordRefs).toEqual(["notifications@1"]);
		expect(wi2.item.status).toBe("stale");
		expect(result.effects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "BLOCK_PROMOTION", workItemId: "WI-2" }),
				expect.objectContaining({ type: "REQUEST_REVIEW", workItemId: "WI-2", reasonCodes: ["STALE_RECEIPT", "FACET_CHANGED"] }),
				expect.objectContaining({ type: "RECORD_CONDITION", workItemId: "WI-2" }),
			]),
		);
	});

	it("[positive] sales-ops: qualified-lead v2 stales WI-3 and WI-4 on the one declared facet that changed", async () => {
		const cell = await salesOpsCell();
		await cell.send(s.events.v2);
		for (const id of ["WI-3", "WI-4"]) {
			const wi = await cell.wi(id);
			expect(wi.item.status).toBe("stale");
			expect(wi.conditions.find((c) => c.type === "Stale")?.facetKeys).toEqual(["lead.qualified.criteria"]);
		}
	});

	it("[negative] depending on a record, but only on facets that did not change, leaves the work alone", async () => {
		const cell = await notificationsCell();
		await cell.send(registerItem("WI-X", n.receipts.wi2, [{ recordId: "notifications", facetKeys: ["notifications.channel"] }]));
		const before = structuredClone(await cell.wi("WI-X"));
		const result = await cell.send(n.events.v2);
		expect(await cell.wi("WI-X")).toEqual(before);
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-X", reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] }));
		expect(result.effects.find((e) => e.type === "NO_ACTION" && e.workItemId === "WI-X")).toMatchObject({ message: expect.stringContaining("none of the facets it relies on changed") });
	});

	it("[positive] an empty facet list means the whole record, so an added facet stales it", async () => {
		const cell = await salesOpsCell();
		await cell.send(registerItem("WI-W", s.receipts.wi3, [{ recordId: "qualified-lead", facetKeys: [] }]));
		await cell.send(s.events.v2);
		expect((await cell.wi("WI-W")).conditions.find((c) => c.type === "Stale")?.facetKeys).toContain("lead.qualified.verified-budget-signal");
	});

	it("[negative] a facet added to a record does not stale work that named other facets", async () => {
		const cell = await salesOpsCell();
		await cell.send(registerItem("WI-V", s.receipts.wi3, [{ recordId: "qualified-lead", facetKeys: ["lead.qualified.min-employees"] }]));
		await cell.send(s.events.v2);
		expect((await cell.wi("WI-V")).item.status).toBe("running");
	});

	it("[negative] a new version whose facets are identical is still prose-only", async () => {
		const cell = await notificationsCell();
		await cell.send(n.events.v2);
		const before = (await cell.state()).workItems;
		const result = await cell.send(n.events.v3ProseBump);
		expect(reasonsOf(result)).toEqual(["PROSE_ONLY"]);
		expect((await cell.state()).workItems).toEqual(before);
		expect((await cell.state()).records.notifications?.current).toBe(3);
	});

	it("[positive] a typo fix does not hide the real change that follows it", async () => {
		const cell = await notificationsCell();
		await cell.send(n.events.typoFix);
		expect((await cell.wi("WI-2")).item.status).toBe("running");
		await cell.send(n.events.v2);
		expect((await cell.wi("WI-2")).item.status).toBe("stale");
	});

	it("[positive] staleness: record mode treats any new blob as a change", async () => {
		const cell = await notificationsCell({ ...n.policy, staleness: "record" });
		const result = await cell.send(n.events.typoFix);
		const stale = (await cell.wi("WI-2")).conditions.find((c) => c.type === "Stale");
		expect(stale?.reasonCodes).toEqual(["STALE_RECEIPT"]);
		expect(reasonsOf(result)).not.toContain("PROSE_ONLY");
	});

	it("[positive] work stays stale, and the condition follows the record, when a later version lands", async () => {
		const cell = await notificationsCell();
		await cell.send(n.events.v2);
		const v3 = variant(n.docs.notificationsV2.snapshot, { version: 3, facets: { ...n.docs.notificationsV2.snapshot.facets, "notifications.cadence": "daily-digest" } });
		await cell.send(baselinePush(n.repo, [v3]));
		const stale = (await cell.wi("WI-2")).conditions.find((c) => c.type === "Stale");
		expect(stale?.message).toContain("accepted is v3");
		expect(stale?.recordRefs).toEqual(["notifications@1"]);
	});

	it("[negative] promoted work is never re-staled", async () => {
		const cell = await createCell(n.seed, n.policy);
		await cell.send(n.events.registerWi1);
		await cell.send(n.events.wi1Pushed);
		await cell.send(n.events.wi1Evidence);
		const { promotionEvent } = await import("./testing/harness");
		const allowed = await cell.send(promotionEvent(await cell.state(), { workItemId: "WI-1", actor: n.actors.andrew, requestId: "p1", ts: "2026-10-13T17:00:00Z" }));
		expect(effectTypes(allowed)).toContain("ALLOW_PROMOTION");
		await cell.send({ type: "PromotionMerged", ts: "2026-10-13T17:01:00Z", workItemId: "WI-1", repo: n.repo, mergeCommitSha: nextSha("b") });
		const sm = variant(n.docs.statusModelV1.snapshot, { version: 2, facets: { ...n.docs.statusModelV1.snapshot.facets, "status.transitions": "any" } });
		const before = structuredClone(await cell.wi("WI-1"));
		await cell.send(baselinePush(n.repo, [sm]));
		expect(await cell.wi("WI-1")).toEqual(before);
		expect((await cell.wi("WI-1")).item.status).toBe("promoted");
	});
});

describe("R1 context acceptance (authority and shape)", () => {
	it("[negative] an accepted version from someone who is not the record's authority is not accepted", async () => {
		const cell = await notificationsCell();
		const result = await cell.send(n.events.v2Forged);
		expect(reasonsOf(result)).toEqual(expect.arrayContaining(["FORBIDDEN_ACTOR", "RECORD_NOT_ACCEPTED"]));
		const state = await cell.state();
		expect(state.records.notifications?.current).toBe(1);
		expect(state.records.notifications?.proposed?.version).toBe(2);
		expect((await cell.wi("WI-2")).item.status).toBe("running");
	});

	it("[negative] an older version never replaces a newer accepted one", async () => {
		const cell = await notificationsCell();
		await cell.send(n.events.v2);
		const result = await cell.send(baselinePush(n.repo, [n.docs.notificationsV1.snapshot]));
		expect(reasonsOf(result)).toEqual(["VERSION_NOT_NEWER"]);
		expect((await cell.state()).records.notifications?.current).toBe(2);
	});

	it("[negative] an accepted version is immutable: changing its facets needs a new version", async () => {
		const cell = await notificationsCell();
		await cell.send(n.events.v2);
		const tampered = variant(n.docs.notificationsV2.snapshot, { facets: { ...n.docs.notificationsV2.snapshot.facets, "notifications.default": "on" } });
		const result = await cell.send(baselinePush(n.repo, [tampered]));
		expect(reasonsOf(result)).toEqual(["IMMUTABLE_VERSION"]);
		expect((await cell.state()).records.notifications?.versions["2"]).toEqual(n.docs.notificationsV2.snapshot);
	});

	it("[negative] a proposed record is visible but governs nothing", async () => {
		const cell = await notificationsCell();
		const result = await cell.send(baselinePush(n.repo, [variant(n.docs.notificationsV2.snapshot, { status: "proposed", acceptedBy: null, acceptedAt: null })]));
		expect(reasonsOf(result)).toEqual(["RECORD_NOT_ACCEPTED"]);
		const state = await cell.state();
		expect(state.records.notifications?.current).toBe(1);
		expect(state.records.notifications?.proposed?.version).toBe(2);
		expect((await cell.wi("WI-2")).item.status).toBe("running");
	});

	it("[negative] a malformed context file in a push is reported and never accepted", async () => {
		const cell = await notificationsCell();
		const event = baselinePush(n.repo, []);
		if (event.type !== "BaselinePushed") throw new Error("unreachable");
		const result = await cell.send({ ...event, invalid: [{ path: "context/notifications.md", error: "missing closing --- front-matter fence" }] });
		expect(reasonsOf(result)).toEqual(["RECORD_NOT_ACCEPTED"]);
		expect((await cell.state()).records.notifications?.current).toBe(1);
	});

	it("[negative] a push with no context change only moves the baseline", async () => {
		const cell = await notificationsCell();
		const sha = nextSha("b");
		const result = await cell.send(baselinePush(n.repo, [], { commitSha: sha }));
		expect(reasonsOf(result)).toEqual(["NO_CONTEXT_CHANGE"]);
		expect((await cell.state()).baselineCommit).toBe(sha);
	});

	it("[negative] re-sending the same content under a new commit is no change", async () => {
		const cell = await notificationsCell();
		const result = await cell.send(baselinePush(n.repo, [n.docs.notificationsV1.snapshot]));
		expect(reasonsOf(result)).toEqual(["NO_CONTEXT_CHANGE"]);
	});
});

describe("R2 unaffected work is left alone, with the reason recorded", () => {
	it("[positive] notifications: WI-1 is the named negative control", async () => {
		const cell = await notificationsCell();
		const before = structuredClone(await cell.wi("WI-1"));
		const result = await cell.send(n.events.v2);
		expect(await cell.wi("WI-1")).toEqual(before);
		expect(conditionTypes(await cell.wi("WI-1"))).toEqual(["Fresh"]);
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-1", reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] }));
	});

	it("[positive] sales-ops: WI-5 is the named negative control", async () => {
		const cell = await salesOpsCell();
		const before = structuredClone(await cell.wi("WI-5"));
		const result = await cell.send(s.events.v2);
		expect(await cell.wi("WI-5")).toEqual(before);
		expect(result.effects).toContainEqual(expect.objectContaining({ type: "NO_ACTION", workItemId: "WI-5", reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] }));
	});

	it("[negative] affected work gets conditions and blocks, never a NO_ACTION", async () => {
		const cell = await notificationsCell();
		const result = await cell.send(n.events.v2);
		expect(result.effects.filter((e) => e.type === "NO_ACTION" && e.workItemId === "WI-2")).toEqual([]);
		expect(effectTypes(result)).toEqual(expect.arrayContaining(["BLOCK_PROMOTION", "REQUEST_REVIEW"]));
	});
});
