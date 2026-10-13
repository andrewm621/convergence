import { describe, expect, it } from "vitest";
import { createCell, conditionTypes, effectTypes, reasonsOf } from "./testing/harness";
import { forkPush, notifications as n, registerItem, salesOps as s } from "./testing/scenarios";

async function cell() {
	const c = await createCell(n.seed, n.policy);
	await c.send(n.events.registerWi1);
	await c.send(n.events.registerWi2);
	return c;
}

const wi2 = n.workItems.wi2;
const wi1 = n.workItems.wi1;

describe("R3 claim conflict", () => {
	it("[negative] claims that match the accepted facets raise nothing", async () => {
		const c = await cell();
		const result = await c.send(n.events.wi2PushedV1);
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(["Fresh"]);
		expect(effectTypes(result)).not.toContain("BLOCK_PROMOTION");
	});

	it("[positive] after v2, the agent's v1 claims conflict with the accepted facets (the demo beat)", async () => {
		const c = await cell();
		await c.send(n.events.v2);
		const result = await c.send(n.events.wi2PushedV1);
		const conflict = (await c.wi("WI-2")).conditions.find((x) => x.type === "ClaimConflict");
		expect(conflict?.facetKeys).toEqual(n.expected.afterWi2Push["WI-2"].conflictSubjects);
		expect(conflict?.reasonCodes).toEqual(["CLAIM_CONFLICT", "SUPERSEDED_BASIS"]);
		expect(conflict?.message).toContain('Claims notifications.default = "on"; accepted notifications@2 says "opt-in"');
		expect((await c.wi("WI-2")).item.status).toBe("conflict");
		expect(effectTypes(result)).toEqual(expect.arrayContaining(["REQUEST_REVIEW", "BLOCK_PROMOTION"]));
	});

	it("[positive] a conflicting claim is a conflict even before the item is stale (wrong value at the current version)", async () => {
		const c = await cell();
		await c.send(forkPush(wi2, [{ subject: "notifications.default", value: "on", basedOn: "notifications@1" }, { subject: "status.values", value: ["draft", "active", "blocked", "done"], basedOn: "status-model@1" }]));
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("ClaimConflict");
		await c.send(forkPush(wi2, [{ subject: "status.values", value: ["nope"], basedOn: "status-model@1" }]));
		const conflict = (await c.wi("WI-2")).conditions.find((x) => x.type === "ClaimConflict");
		expect(conflict?.reasonCodes).toEqual(["CLAIM_CONFLICT"]);
		expect(conflict?.facetKeys).toEqual(["status.values"]);
	});

	it("[positive] a claim based on a superseded version conflicts even when its value happens to be right", async () => {
		const c = await cell();
		await c.send(n.events.v2);
		await c.send(forkPush(wi2, n.claims.wi2RightValueOldBasis));
		const conflict = (await c.wi("WI-2")).conditions.find((x) => x.type === "ClaimConflict");
		expect(conflict?.reasonCodes).toEqual(["CLAIM_CONFLICT", "SUPERSEDED_BASIS"]);
		expect(conflict?.message).toContain("Built on notifications@1");
	});

	it("[negative] a claim based on a superseded version of a facet that did not change is not a conflict", async () => {
		const c = await cell();
		await c.send(n.events.v2);
		await c.send(forkPush(wi2, n.claims.wi2UnchangedFacetOldBasis));
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("ClaimConflict");
	});

	it("[negative] claims about facets nobody governs are not contradicted", async () => {
		const c = await cell();
		await c.send(forkPush(wi2, [{ subject: "notifications.unrelated", value: "whatever", basedOn: "notifications@1" }]));
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(["Fresh"]);
	});

	it("[positive] a removed facet that the claim still relies on is a conflict", async () => {
		const c = await cell();
		const { variant, baselinePush } = await import("./testing/scenarios");
		const v2 = n.docs.notificationsV2.snapshot;
		const { "notifications.channel": _gone, ...rest } = v2.facets;
		await c.send(baselinePush(n.repo, [variant(v2, { facets: rest })]));
		await c.send(forkPush(wi2, [{ subject: "notifications.channel", value: "in-app", basedOn: "notifications@1" }]));
		expect(conditionTypes(await c.wi("WI-2"))).toContain("ClaimConflict");
	});

	it("[negative] claims matching v2 clear the conflict after revalidation", async () => {
		const c = await cell();
		await c.send(n.events.v2);
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi2ReceiptIssued);
		await c.send(n.events.wi2PushedRevalidated);
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("ClaimConflict");
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("Stale");
	});

	it("[positive] a missing claims file fails closed to Uncertain/NO_CLAIMS", async () => {
		const c = await cell();
		const result = await c.send(forkPush(wi1, null));
		const u = (await c.wi("WI-1")).conditions.find((x) => x.type === "Uncertain");
		expect(u?.reasonCodes).toEqual(["NO_CLAIMS"]);
		expect((await c.wi("WI-1")).item.status).toBe("uncertain");
		expect(effectTypes(result)).toContain("BLOCK_PROMOTION");
	});

	it("[positive] an empty claims list is the same as none", async () => {
		const c = await cell();
		await c.send(forkPush(wi1, []));
		expect((await c.wi("WI-1")).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["NO_CLAIMS"]);
	});

	it.each([
		["not an array", { subject: "x" }],
		["a string", "claims"],
		["missing basedOn", [{ subject: "a.b", value: 1 }]],
		["bad basedOn", [{ subject: "a.b", value: 1, basedOn: "notifications" }]],
		["nested value", [{ subject: "a.b", value: { deep: 1 }, basedOn: "notifications@1" }]],
		["extra key", [{ subject: "a.b", value: 1, basedOn: "notifications@1", confidence: 0.9 }]],
	])("[positive] malformed claims fail closed to Uncertain/MALFORMED_CLAIMS: %s", async (_name, raw) => {
		const c = await cell();
		await c.send(forkPush(wi1, raw));
		const u = (await c.wi("WI-1")).conditions.find((x) => x.type === "Uncertain");
		expect(u?.reasonCodes).toEqual(["MALFORMED_CLAIMS"]);
		expect((await c.wi("WI-1")).claims?.status).toBe("malformed");
	});

	it("[positive] a claim citing a version Delta has never seen is Uncertain, not trusted", async () => {
		const c = await cell();
		await c.send(forkPush(wi2, [{ subject: "notifications.default", value: "on", basedOn: "notifications@9" }]));
		expect((await c.wi("WI-2")).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["UNKNOWN_CONTEXT_VERSION"]);
	});

	it("[negative] a context change pushed from a fork is never an accepted version", async () => {
		const c = await cell();
		const before = (await c.state()).records;
		const result = await c.send(forkPush(wi2, n.claims.wi2V1, { contextPaths: ["context/notifications.md"] }));
		expect(reasonsOf(result)).toContain("FORK_CONTEXT_IGNORED");
		expect((await c.state()).records).toEqual(before);
		expect((await c.wi("WI-1")).item.status).toBe("running");
		expect((await c.wi("WI-2")).conditions.map((x) => x.type)).toEqual(["Fresh"]);
	});

	it("[negative] a push from a repo that is not the item's fork is ignored", async () => {
		const c = await cell();
		const event = forkPush(wi2, n.claims.wi2V1);
		if (event.type !== "ForkPushed") throw new Error("unreachable");
		const result = await c.send({ ...event, repo: "somebody-elses-repo" });
		expect(reasonsOf(result)).toEqual(["UNKNOWN_WORK_ITEM"]);
		expect((await c.wi("WI-2")).headSha).toBeNull();
	});

	it("[positive] sales-ops: WI-3's v1 claims conflict on the criteria after v2, and only on the criteria", async () => {
		const c = await createCell(s.seed, s.policy);
		for (const e of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5]) await c.send(e);
		await c.send(s.events.v2);
		await c.send(s.events.wi3Pushed);
		const conflict = (await c.wi("WI-3")).conditions.find((x) => x.type === "ClaimConflict");
		expect(conflict?.facetKeys).toEqual(["lead.qualified.criteria"]);
	});
});

describe("R3b cross-claim conflict (P1)", () => {
	it("[positive] two live items claiming different values for one subject are both Uncertain", async () => {
		const c = await cell();
		await c.send(forkPush(wi2, n.claims.wi2PhoneRequired));
		const result = await c.send(forkPush(wi1, n.claims.wi1PhoneOptional));
		for (const id of ["WI-1", "WI-2"]) {
			const u = (await c.wi(id)).conditions.find((x) => x.type === "Uncertain");
			expect(u?.reasonCodes).toEqual(["CROSS_CLAIM_CONFLICT"]);
			expect(u?.facetKeys).toEqual(["profile.phone"]);
			expect(conditionTypes(await c.wi(id))).not.toContain("ClaimConflict");
		}
		expect(result.effects.filter((e) => e.type === "REQUEST_REVIEW").map((e) => (e as { workItemId: string }).workItemId).sort()).toEqual(["WI-1", "WI-2"]);
	});

	it("[negative] items that agree on a subject are not in conflict", async () => {
		const c = await cell();
		await c.send(n.events.wi2PushedV1);
		await c.send(n.events.wi1Pushed);
		expect(conditionTypes(await c.wi("WI-1"))).toEqual(["Fresh"]);
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(["Fresh"]);
	});

	it("[negative] a subject an accepted facet governs is arbitrated by R3, not by R3b", async () => {
		const c = await createCell(s.seed, s.policy);
		for (const e of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5, s.events.v2, s.events.wi3Pushed, s.events.wi4PushedRevalidated]) await c.send(e);
		// WI-3 (v1 criteria) and WI-4 (v2 criteria) disagree, but only WI-3 contradicts the accepted facet.
		expect(conditionTypes(await c.wi("WI-3"))).toContain("ClaimConflict");
		expect(conditionTypes(await c.wi("WI-3"))).not.toContain("Uncertain");
		expect(conditionTypes(await c.wi("WI-4"))).not.toContain("ClaimConflict");
		expect(conditionTypes(await c.wi("WI-4"))).not.toContain("Uncertain");
	});

	it("[positive] the conflict clears on both sides once one item stops disagreeing", async () => {
		const c = await cell();
		await c.send(forkPush(wi2, n.claims.wi2PhoneRequired));
		await c.send(forkPush(wi1, n.claims.wi1PhoneOptional));
		await c.send(n.events.wi1Pushed);
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("Uncertain");
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("Uncertain");
	});
});

describe("R4 undeclared reliance", () => {
	it("[positive] a claim citing a record outside the receipt proposes an inferred dependency and makes the item Uncertain", async () => {
		const c = await cell();
		const result = await c.send(forkPush(wi1, n.claims.wi1Undeclared));
		const dep = (await c.state()).dependencies.find((d) => d.workItemId === "WI-1" && d.recordId === "notifications");
		expect(dep).toMatchObject({ basis: "inferred", status: "proposed", facetKeys: ["notifications.default"] });
		expect(dep?.evidenceRefs[0]).toContain(".delta/claims.json");
		expect((await c.wi("WI-1")).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["UNDECLARED_DEP"]);
		expect(effectTypes(result)).toContain("REQUEST_REVIEW");
	});

	it("[negative] only accepted dependencies gate: a proposed one does not stale the item when the record changes", async () => {
		const c = await cell();
		await c.send(forkPush(wi1, n.claims.wi1Undeclared));
		await c.send(n.events.v2);
		expect(conditionTypes(await c.wi("WI-1"))).not.toContain("Stale");
	});

	it("[positive] a human accepting the dependency makes it gate (the receipt never delivered it, so the item is Stale)", async () => {
		const c = await cell();
		await c.send(forkPush(wi1, n.claims.wi1Undeclared));
		await c.send({ type: "DependencyDecided", ts: "2026-10-13T17:00:00Z", requestId: "dep-1", workItemId: "WI-1", recordId: "notifications", decision: "accepted", actor: n.actors.andrew });
		const stale = (await c.wi("WI-1")).conditions.find((x) => x.type === "Stale");
		expect(stale?.reasonCodes).toEqual(["STALE_RECEIPT"]);
		expect((await c.state()).dependencies.find((d) => d.recordId === "notifications" && d.workItemId === "WI-1")?.status).toBe("accepted");
	});

	it("[positive] a human rejecting the dependency clears the uncertainty", async () => {
		const c = await cell();
		await c.send(forkPush(wi1, n.claims.wi1Undeclared));
		await c.send({ type: "DependencyDecided", ts: "2026-10-13T17:00:00Z", requestId: "dep-2", workItemId: "WI-1", recordId: "notifications", decision: "rejected", actor: n.actors.andrew });
		expect(conditionTypes(await c.wi("WI-1"))).toEqual(["Fresh"]);
	});

	it("[negative] an agent cannot accept its own inferred dependency", async () => {
		const c = await cell();
		await c.send(forkPush(wi1, n.claims.wi1Undeclared));
		const result = await c.send({ type: "DependencyDecided", ts: "2026-10-13T17:00:00Z", requestId: "dep-3", workItemId: "WI-1", recordId: "notifications", decision: "accepted", actor: n.actors.agentA });
		expect(reasonsOf(result)).toEqual(["FORBIDDEN_ACTOR"]);
		expect((await c.state()).dependencies.find((d) => d.recordId === "notifications" && d.workItemId === "WI-1")?.status).toBe("proposed");
	});

	it("[negative] a claim about a record that is in the receipt declares nothing new", async () => {
		const c = await cell();
		await c.send(n.events.wi2PushedV1);
		expect((await c.state()).dependencies.filter((d) => d.status === "proposed")).toEqual([]);
	});

	it("[positive] repeated pushes extend one proposed dependency instead of duplicating it", async () => {
		const c = await cell();
		await c.send(forkPush(wi1, n.claims.wi1Undeclared));
		await c.send(forkPush(wi1, [...n.claims.wi1Undeclared, { subject: "notifications.cadence", value: "immediate", basedOn: "notifications@1" }]));
		const deps = (await c.state()).dependencies.filter((d) => d.workItemId === "WI-1" && d.recordId === "notifications");
		expect(deps).toHaveLength(1);
		expect(deps[0]?.facetKeys).toEqual(["notifications.cadence", "notifications.default"]);
		expect(deps[0]?.evidenceRefs).toHaveLength(2);
	});

	it("[negative] unknown-record claims on an item without that record in its receipt use the same path", async () => {
		const c = await cell();
		await c.send(registerItem("WI-Q", n.receipts.wi1, []));
		await c.send(forkPush({ id: "WI-Q", forkRepo: "test-wi-q" }, [{ subject: "x.y", value: 1, basedOn: "ghost@1" }]));
		expect((await c.wi("WI-Q")).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["UNDECLARED_DEP"]);
	});
});

describe("R3b and R4 on the sales-ops fixture", () => {
	async function sCell() {
		const c = await createCell(s.seed, s.policy);
		for (const e of [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5]) await c.send(e);
		return c;
	}

	it("[positive] R4: WI-5 citing qualified-lead, which it was never given, proposes an inferred dependency", async () => {
		const c = await sCell();
		await c.send(forkPush(s.workItems.wi5, [...s.claims.wi5, { subject: "lead.qualified.criteria", value: "form-fill-and-50-plus-employees", basedOn: "qualified-lead@1" }]));
		expect((await c.state()).dependencies.find((d) => d.workItemId === "WI-5" && d.recordId === "qualified-lead")).toMatchObject({ basis: "inferred", status: "proposed" });
		expect((await c.wi("WI-5")).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["UNDECLARED_DEP"]);
		// Only accepted dependencies gate: qualified-lead v2 does not stale WI-5 while the dependency is merely proposed.
		await c.send(s.events.v2);
		expect(conditionTypes(await c.wi("WI-5"))).not.toContain("Stale");
	});

	it("[positive] R3: missing claims fail closed for WI-3", async () => {
		const c = await sCell();
		await c.send(forkPush(s.workItems.wi3, null));
		expect((await c.wi("WI-3")).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["NO_CLAIMS"]);
	});

	it("[positive] R3b: two forecasts that disagree on an ungoverned subject are both Uncertain", async () => {
		const c = await sCell();
		await c.send(forkPush(s.workItems.wi3, [{ subject: "forecast.horizon", value: "quarter", basedOn: "qualified-lead@1" }]));
		await c.send(forkPush(s.workItems.wi4, [{ subject: "forecast.horizon", value: "month", basedOn: "qualified-lead@1" }]));
		for (const id of ["WI-3", "WI-4"]) expect((await c.wi(id)).conditions.find((x) => x.type === "Uncertain")?.reasonCodes).toEqual(["CROSS_CLAIM_CONFLICT"]);
		expect(conditionTypes(await c.wi("WI-5"))).toEqual(["Fresh"]);
	});

	it("[negative] R3: claims that match v1 raise nothing before the change", async () => {
		const c = await sCell();
		await c.send(s.events.wi3Pushed);
		await c.send(s.events.wi4Pushed);
		for (const id of ["WI-3", "WI-4"]) expect(conditionTypes(await c.wi(id))).toEqual(["Fresh"]);
	});
});
