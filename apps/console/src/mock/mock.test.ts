import { describe, expect, it } from "vitest";
import { assertContractMessages, startMock } from "@/test/harness";
import { dependencyEdges, exceptionStatus } from "@/state/derive";
import type { WorkItemState } from "contracts";
import type { ViewState } from "@/state/store";

/** Whether WI-2's accepted exception has lapsed, by the same classification the gate uses. */
function lapsedOf(view: ViewState): boolean {
	const wi = view.workItems["WI-2"] as WorkItemState;
	const exception = wi.resolutions.find((r) => r.kind === "accept-exception");
	if (!exception) throw new Error("WI-2 has no accepted exception");
	return exceptionStatus(view, wi, exception)?.lapsed === true;
}

describe("mock replay of Scenario A runs the real reconciler", () => {
	it("walks the PRD beats: typo, v2, conflict, promote, revalidate, promote", async () => {
		const mock = await startMock();
		expect(mock.beats.map((b) => b.title)).toHaveLength(9);
		expect(mock.view.ready).toBe(true);
		expect(Object.keys(mock.view.workItems)).toEqual([]);

		// 1. Two agents running.
		await mock.next();
		expect(mock.status("WI-1")).toBe("running");
		expect(mock.status("WI-2")).toBe("running");

		// 2. The typo beat: PROSE_ONLY, nothing goes red.
		await mock.next();
		const typo = mock.view.ledger.at(-1);
		expect(typo?.type).toBe("BaselinePushed");
		expect(typo?.payload.effects.flatMap((e) => e.reasonCodes)).toContain("PROSE_ONLY");
		expect(mock.view.evaluation?.proseOnly).toBe(true);
		expect(dependencyEdges(mock.view).every((edge) => edge.kind === "ok")).toBe(true);
		expect(mock.status("WI-2")).toBe("running");

		// 3. Draft only: no event yet.
		const before = mock.view.ledgerHead.seq;
		await mock.next();
		expect(mock.view.ledgerHead.seq).toBe(before);

		// 4. v2: WI-2 stale, WI-1 untouched, exactly one edge red.
		await mock.next();
		expect(mock.status("WI-2")).toBe("stale");
		expect(mock.status("WI-1")).toBe("running");
		const red = dependencyEdges(mock.view).filter((edge) => edge.kind === "stale");
		expect(red.map((edge) => edge.id)).toEqual(["WI-2->notifications"]);
		expect(mock.view.evaluation).toMatchObject({ evaluated: 2, stale: 1, untouched: 1, proseOnly: false });
		expect(mock.view.evaluation?.ms).toBeGreaterThanOrEqual(0);
		expect(mock.view.records["notifications"]?.current).toBe(2);

		// 5. Claim conflict plus a failing check.
		await mock.next();
		expect(mock.status("WI-2")).toBe("conflict");
		const wi2 = mock.view.workItems["WI-2"];
		expect(wi2?.conditions.map((c) => c.type)).toEqual(expect.arrayContaining(["Stale", "ClaimConflict", "TestFailed", "Blocked"]));
		const gate = await mock.client.api.gate("WI-2");
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT", "TEST_FAILED"]));

		// 6. WI-1 promotes straight away.
		await mock.next();
		expect(mock.status("WI-1")).toBe("promoted");
		expect(mock.status("WI-2")).toBe("conflict");

		// 7. Revalidate: a fresh receipt at notifications@2, chip revalidating.
		await mock.next();
		expect(mock.status("WI-2")).toBe("revalidating");
		expect(mock.view.workItems["WI-2"]?.receipt.accepted.find((e) => e.recordId === "notifications")?.version).toBe(2);

		// 8. The re-run lands: claims match, the check passes.
		await mock.next();
		expect(mock.status("WI-2")).toBe("ready");
		expect((await mock.client.api.gate("WI-2")).pass).toBe(true);

		// 9. WI-2 promotes.
		await mock.next();
		expect(mock.status("WI-2")).toBe("promoted");

		assertContractMessages(mock.messages);
		mock.stop();
	});

	it("going back replays from the start and sends one fresh snapshot", async () => {
		const mock = await startMock();
		await mock.jump(4);
		expect(mock.status("WI-2")).toBe("stale");
		await mock.prev();
		expect(mock.client.controls.getState().position).toBe(3);
		expect(mock.status("WI-2")).toBe("running");
		expect(mock.view.records["notifications"]?.current).toBe(1);
		await mock.jump(9);
		expect(mock.status("WI-1")).toBe("promoted");
		expect(mock.status("WI-2")).toBe("promoted");
		assertContractMessages(mock.messages);
		mock.stop();
	});

	it("the ledger chain verifies in the browser path", async () => {
		const { verifyChain } = await import("delta-core");
		const mock = await startMock();
		await mock.jump(9);
		const first = mock.view.ledger[0];
		expect(first).toBeDefined();
		const verdict = await verifyChain(mock.view.ledger, { seq: (first?.seq ?? 1) - 1, hash: first?.prevHash ?? "" });
		expect(verdict.ok).toBe(true);
		mock.stop();
	});
});

describe("mock replay of Scenario B (sales-ops) uses the same engine", () => {
	it("two edges go red, the glossary is untouched, one exception and one revalidation resolve", async () => {
		const mock = await startMock({ scenario: "sales-ops" });
		await mock.jump(4); // v2 lands
		expect(mock.status("WI-3")).toBe("stale");
		expect(mock.status("WI-4")).toBe("stale");
		expect(mock.status("WI-5")).toBe("running");
		const red = dependencyEdges(mock.view).filter((edge) => edge.kind === "stale");
		expect(red.map((e) => e.id).sort()).toEqual(["WI-3->qualified-lead", "WI-4->qualified-lead"]);
		expect(mock.view.evaluation).toMatchObject({ evaluated: 3, stale: 2, untouched: 1 });

		await mock.jump(6); // pushes, then the scoped exception
		expect(mock.status("WI-3")).toBe("ready");
		expect(mock.view.workItems["WI-3"]?.resolutions[0]?.scope).toBe("reports/q4-forecast.md");

		await mock.jump(9);
		expect(Object.values(mock.view.workItems).map((wi) => wi.item.status)).toEqual(["promoted", "promoted", "promoted"]);
		assertContractMessages(mock.messages);
		mock.stop();
	});
});

describe("revalidating twice", () => {
	it("refuses a second revalidate while one is under way, naming REVALIDATION_IN_PROGRESS", async () => {
		const mock = await startMock();
		await mock.jump(7); // WI-2 is revalidating
		expect(mock.status("WI-2")).toBe("revalidating");
		const wi = mock.view.workItems["WI-2"] as WorkItemState;
		const record = mock.view.records["notifications"];
		const head = record?.versions[String(record.current)];
		if (!head) throw new Error("no accepted notifications record");
		const result = await mock.client.api.resolve(
			{
				kind: "revalidate",
				workItemId: "WI-2",
				rationale: "again",
				binding: { recordId: "notifications", version: head.version, blobHash: head.blobHash, baseSha: mock.view.baselineCommit, forkHeadSha: wi.headSha as string, contextSnapshotHash: mock.view.snapshotHash },
			},
			"second-revalidate",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("REVALIDATION_IN_PROGRESS");
			expect(result.reasonCodes).toEqual(["REVALIDATION_IN_PROGRESS"]);
			expect(result.message).toMatch(/already under way/);
		}
		mock.stop();
	});
});

describe("a failed revalidation releases the item", () => {
	/** Scenario A up to the Revalidate click (WI-2 revalidating), run on a bare cell so a test can fail the run by hand. */
	async function revalidating() {
		const { buildNotificationsScenario } = await import("scenario-notifications");
		const { notificationsScript } = await import("./script-notifications");
		const { MockCell } = await import("./cell");
		const { MockSession } = await import("./session");
		const bundle = await buildNotificationsScenario();
		const cell = new MockCell(bundle, () => {});
		await cell.init("seeded");
		const session = new MockSession(cell, { promoteDelayMs: 0 });
		for (const beat of notificationsScript(bundle).beats.slice(0, 7)) await beat.run({ session, cell, drip: () => {} });
		expect((await cell.state()).workItems["WI-2"]?.revalidating).toBe(true);
		return { cell, session };
	}

	it("a failed re-run clears revalidating, and Revalidate can be requested again", async () => {
		const { cell, session } = await revalidating();
		const runId = (await cell.state()).workItems["WI-2"]?.revalidationRun;
		expect(runId).toBeDefined();
		await session.finishRun("WI-2", runId as string, "failure");
		const wi = (await cell.state()).workItems["WI-2"] as WorkItemState;
		expect(wi.revalidating).toBe(false);
		expect(wi.item.status).not.toBe("revalidating"); // still blocked by its old claims, not "revalidating"
		const again = await session.resolveNow("revalidate", "WI-2", "notifications", "Try again.");
		expect(again.ok).toBe(true);
		expect((await cell.state()).workItems["WI-2"]?.revalidating).toBe(true);
	});

	it("a dispatch that failed before any run releases it too, and the ledger line says so in plain words", async () => {
		const { dispatchFailedRunId } = await import("contracts");
		const { summarizeLedgerLine } = await import("@/state/derive");
		const { cell, session } = await revalidating();
		const wi = (await cell.state()).workItems["WI-2"] as WorkItemState;
		const requestId = wi.resolutions.filter((r) => r.kind === "revalidate").at(-1)?.requestId as string;
		await session.finishRun("WI-2", dispatchFailedRunId(requestId), "failure");
		expect((await cell.state()).workItems["WI-2"]?.revalidating).toBe(false);

		const entry = (await cell.store.ledger()).filter((e) => e.payload.event.type === "AgentRunFinished").at(-1);
		if (!entry) throw new Error("no AgentRunFinished on the ledger");
		const line = summarizeLedgerLine(entry);
		expect(line.label).toBe("Agent dispatch failed before the run started");
		expect(line.detail).toBe("revalidation released");
		expect(`${line.label} ${line.detail}`).not.toMatch(/dispatch-failed:|Agent run/);
	});
});

describe("mock replay of the shelter scenario (knowledge work) uses the same engine", () => {
	it("three drafts go stale, two are untouched, then one exception and two revalidations clear the way", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		expect(mock.beats).toHaveLength(10);

		await mock.jump(2); // the typo beat: nothing goes red
		expect(mock.view.evaluation?.proseOnly).toBe(true);
		expect(dependencyEdges(mock.view).every((edge) => edge.kind === "ok")).toBe(true);

		await mock.jump(4); // v2 lands
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(mock.status(id), id).toBe("stale");
		for (const id of ["WI-4", "WI-5"]) expect(mock.status(id), id).toBe("running");
		const red = dependencyEdges(mock.view).filter((edge) => edge.kind === "stale");
		expect(red.map((e) => e.id).sort()).toEqual(["WI-1->shelter-intake-policy", "WI-2->shelter-intake-policy", "WI-3->shelter-intake-policy"]);
		expect(mock.view.evaluation).toMatchObject({ evaluated: 5, stale: 3, untouched: 2 });

		await mock.jump(5); // drafts come in
		expect(mock.status("WI-1")).toBe("conflict");
		expect(mock.view.workItems["WI-1"]?.conditions.map((c) => c.type)).toEqual(expect.arrayContaining(["ClaimConflict", "TestFailed"]));
		expect(mock.status("WI-4")).toBe("ready");
		expect(mock.status("WI-5")).toBe("ready");

		await mock.jump(6); // the scoped exception
		expect(mock.status("WI-2")).toBe("ready");
		expect(mock.view.workItems["WI-2"]?.resolutions[0]?.scope).toBe("signs/door.md");
		expect(mock.view.workItems["WI-2"]?.resolutions[0]?.rationale).toContain("Existing printed signs stay posted until replacements arrive");

		await mock.jump(7);
		expect(mock.status("WI-1")).toBe("revalidating");
		expect(mock.status("WI-3")).toBe("revalidating");
		await mock.jump(8);
		expect(mock.status("WI-1")).toBe("ready");
		expect(mock.status("WI-3")).toBe("ready");

		await mock.jump(9); // four promote; the signage is cleared by its exception but waits
		expect(mock.view.workItems["WI-2"]?.item.status).toBe("ready");
		for (const id of ["WI-1", "WI-3", "WI-4", "WI-5"]) expect(mock.status(id), id).toBe("promoted");
		expect(mock.view.records["shelter-intake-policy"]?.current).toBe(2);
		expect(lapsedOf(mock.view)).toBe(false);
		expect((await mock.client.api.gate("WI-2")).pass).toBe(true);

		await mock.jump(10); // the policy moves to v3 before the signage is promoted: its exception lapses and it is blocked again
		expect(mock.view.records["shelter-intake-policy"]?.current).toBe(3);
		expect(mock.beats[9]?.caption).toBe("A new version ends the exception automatically.");
		expect(lapsedOf(mock.view)).toBe(true);
		expect(mock.status("WI-2")).toBe("conflict");
		const gate = await mock.client.api.gate("WI-2");
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toContain("EXCEPTION_LAPSED");
		for (const id of ["WI-1", "WI-3", "WI-4", "WI-5"]) expect(mock.status(id), id).toBe("promoted");
		assertContractMessages(mock.messages);
		mock.stop();
	});

	it("its user-facing words are domain-neutral and never say Delta alone", async () => {
		const { buildShelterIntakeScenario } = await import("scenario-shelter-intake");
		const { shelterIntakeScript } = await import("./script-shelter-intake");
		const { SCENARIO_META } = await import("@/features/scenario-meta");
		const script = shelterIntakeScript(await buildShelterIntakeScenario());
		const words = [...script.beats.flatMap((beat) => [beat.title, beat.caption]), script.label, SCENARIO_META["shelter-intake"].label, SCENARIO_META["shelter-intake"].note ?? ""].join("\n");
		expect(words).not.toMatch(/\bcode\b|\bcommit|\bmerge|\brepo\b|\bPR\b|\bdeploy|\bpush/i);
		expect(words.replace(/Delta Convergence/g, "")).not.toMatch(/\bDelta\b/);
		expect(words).toContain("Synthetic scenario. Not operational guidance.");
	});
});

describe("fan-out", () => {
	it("evaluates forty seeded items at once: a few stale, the rest untouched", async () => {
		const mock = await startMock({ script: "fanout" });
		await mock.next(); // seed 40 items
		const items = Object.values(mock.view.workItems);
		expect(items).toHaveLength(40);
		expect(items.every((wi) => wi.item.source === "seeded")).toBe(true);

		await mock.next(); // one decision changes
		expect(mock.view.evaluation).toMatchObject({ evaluated: 40, stale: 8, untouched: 32 });
		expect(items.length).toBe(40);
		expect(Object.values(mock.view.workItems).filter((wi) => wi.item.status === "stale")).toHaveLength(8);
		expect(mock.view.evaluation?.ms).not.toBeNull();
		mock.stop();
	});
});

describe("empty workspace", () => {
	it("starts with no accepted context, and one click seeds the scenario", async () => {
		const mock = await startMock({ start: "empty" });
		expect(Object.keys(mock.view.records)).toHaveLength(0);
		const result = await mock.client.api.seedScenario("key-1");
		expect(result.ok).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(Object.keys(mock.view.records).sort()).toEqual(["notifications", "status-model"]);
		mock.stop();
	});
});
