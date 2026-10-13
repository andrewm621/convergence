import { describe, expect, it } from "vitest";
import { DEMO_IDENTITY } from "@/config";
import { startMock, waitFor } from "@/test/harness";
import { analysisOf, builtOnStamps, changedSettings, currentEvaluation, exceptionWaiver, hasProblem, leftAlone, quietOf, reasonSentences, settingLabel, signOffFor, signerFor, signerRecordId, stillBlocked, validExceptions } from "./derive";

describe("settingLabel", () => {
	it("reads a facet key as words: the last dotted segment, with separators as spaces", () => {
		expect(settingLabel("notifications.default")).toBe("default");
		expect(settingLabel("id_required")).toBe("id required");
		expect(settingLabel("status.max-wip")).toBe("max wip");
	});
});

describe("the one-reason card, derived from the engine's own findings", () => {
	it("names one plain sentence per changed setting, and the failing check", async () => {
		const mock = await startMock();
		await mock.jump(5); // v2 lands, WI-2 pushes claims on v1 and its check fails
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis) throw new Error("no analysis");

		expect(changedSettings(mock.view, analysis).map((s) => [s.key, s.kind, s.from, s.to])).toEqual([
			["notifications.cadence", "changed", "immediate", "weekly-digest"],
			["notifications.default", "changed", "on", "opt-in"],
		]);
		expect(reasonSentences(mock.view, analysis)).toEqual([
			"Built on the old cadence (immediate). The decision now says weekly-digest.",
			"Built on the old default (on). The decision now says opt-in.",
			"A check on this work is failing: notifications.test.ts.",
		]);
		expect(builtOnStamps(analysis)).toEqual(["Built on notifications v1 · now v2"]);
		expect(hasProblem(analysis)).toBe(true);
		mock.stop();
	});

	it("says nothing is wrong for work the change left alone", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const analysis = analysisOf(mock.view, "WI-1");
		if (!analysis) throw new Error("no analysis");
		expect(hasProblem(analysis)).toBe(false);
		expect(reasonSentences(mock.view, analysis)).toEqual([]);
		expect(builtOnStamps(analysis)).toEqual([]);
		mock.stop();
	});

	it("names the authority who signs off, by display label, for the record the work is stale against", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis) throw new Error("no analysis");
		const record = signerRecordId(mock.view, "WI-2", analysis);
		expect(record).toBe("notifications");
		expect(signerFor(mock.view, "notifications")).toBe(DEMO_IDENTITY.label);
		// Work with no change against it still has a signer: the first record it relies on.
		const quiet = analysisOf(mock.view, "WI-1");
		if (!quiet) throw new Error("no analysis");
		expect(signerRecordId(mock.view, "WI-1", quiet)).toBe("status-model");
		expect(signerFor(mock.view, "no-such-record")).toBeNull();
		mock.stop();
	});

	it("reads shelter settings as words and keeps long values to one line", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(4);
		const analysis = analysisOf(mock.view, "WI-1");
		if (!analysis) throw new Error("no analysis");
		const sentences = reasonSentences(mock.view, analysis);
		expect(sentences.some((line) => line.startsWith("Built on the old id required ("))).toBe(true);
		expect(sentences.every((line) => line.length < 200)).toBe(true);
		mock.stop();
	});
});

describe("what an exception waives", () => {
	it("names the excepted record's own check, says it is failing right now, and dry-runs the gate with the exception", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const wi = mock.view.workItems["WI-2"];
		const analysis = analysisOf(mock.view, "WI-2");
		if (!wi || !analysis) throw new Error("no work item");
		expect(exceptionWaiver(mock.view, wi, analysis, "notifications")).toEqual({
			recordId: "notifications",
			lifts: true,
			check: "tests/contract/notifications.test.ts",
			checkState: "failing",
			signer: DEMO_IDENTITY.label,
			otherBlocks: [],
			wouldPass: true,
		});
		mock.stop();
	});

	it("says the check has not run yet when nothing has been pushed to run it on", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const wi = mock.view.workItems["WI-2"];
		const analysis = analysisOf(mock.view, "WI-2");
		if (!wi || !analysis) throw new Error("no work item");
		expect(exceptionWaiver(mock.view, wi, analysis, "notifications")).toMatchObject({ lifts: true, checkState: "not-run", wouldPass: null });
		mock.stop();
	});

	it("says the check is passing when there is passing evidence for it at the current head", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const wi = mock.view.workItems["WI-2"];
		const analysis = analysisOf(mock.view, "WI-2");
		if (!wi || !analysis) throw new Error("no work item");
		const evidence = analysis.testEvidence.find((e) => e.check === "tests/contract/notifications.test.ts");
		if (!evidence) throw new Error("no evidence");
		const passing = { ...analysis, failedChecks: [], testEvidence: [{ ...evidence, pass: true }] };
		expect(exceptionWaiver(mock.view, wi, passing, "notifications").checkState).toBe("passing");
		mock.stop();
	});

	it("waives nothing, and names no check, on a record this work is not stale or in conflict against", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const wi = mock.view.workItems["WI-2"];
		const analysis = analysisOf(mock.view, "WI-2");
		if (!wi || !analysis) throw new Error("no work item");
		const other = exceptionWaiver(mock.view, wi, analysis, "status-model");
		expect(other).toMatchObject({ lifts: false, check: null, checkState: null });
		mock.stop();
	});

	it("lists what would still block the work, and says the gate would stay closed", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const wi = mock.view.workItems["WI-2"];
		const analysis = analysisOf(mock.view, "WI-2");
		if (!wi || !analysis) throw new Error("no work item");
		// A fork that also edits accepted context is never promotable (FORK_EDITS_CONTEXT), exception or not.
		const editsContext = { ...wi, contextPaths: ["context/notifications.md"] };
		const waiver = exceptionWaiver(mock.view, editsContext, analysis, "notifications");
		expect(waiver.wouldPass).toBe(false);
		expect(waiver.otherBlocks.join(" ")).toContain("accepted context");
		mock.stop();
	});

	it("lists the exceptions that still hold, with who granted them and their scope", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(6);
		const wi = mock.view.workItems["WI-2"];
		if (!wi) throw new Error("no work item");
		expect(wi.item.status).toBe("ready");
		expect(validExceptions(mock.view, wi)).toEqual([{ recordId: "shelter-intake-policy", scope: expect.stringContaining("signs/door.md"), signer: DEMO_IDENTITY.label }]);
		const clean = mock.view.workItems["WI-4"];
		if (!clean) throw new Error("no work item");
		expect(validExceptions(mock.view, clean)).toEqual([]);
		mock.stop();
	});
});

describe("who signs off", () => {
	it("names every authority when the work is stale on records with different authorities", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis || !mock.view.policy) throw new Error("no analysis");
		expect(signOffFor(mock.view, analysis)).toEqual([DEMO_IDENTITY.label]);
		// status-model is signed off by someone else: no policy entry, and its own record names another actor.
		const actorId = mock.view.workItems["WI-1"]?.item.actor.id ?? "";
		const { "status-model": _drop, ...authority } = mock.view.policy.authority;
		void _drop;
		const history = mock.view.records["status-model"];
		if (!history || history.current === null) throw new Error("no record");
		const snapshot = history.versions[String(history.current)];
		if (!snapshot) throw new Error("no snapshot");
		const view = {
			...mock.view,
			policy: { ...mock.view.policy, authority },
			records: { ...mock.view.records, "status-model": { ...history, versions: { ...history.versions, [String(history.current)]: { ...snapshot, authority: actorId } } } },
		};
		const twoRecords = { ...analysis, stale: [...analysis.stale, { recordId: "status-model", fromVersion: 1, toVersion: 2, facetKeys: [], reasonCodes: [] }] };
		expect(signOffFor(view, twoRecords)).toEqual([DEMO_IDENTITY.label, mock.view.workItems["WI-1"]?.item.actor.displayName]);
		mock.stop();
	});

	it("names no one when no exception can lift what blocks the work", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis) throw new Error("no analysis");
		const unknownOnly = { ...analysis, stale: [], conflicts: [], uncertain: [{ reasonCodes: ["NO_CLAIMS" as const], recordId: null, subjects: [], message: "No claims." }] };
		expect(signOffFor(mock.view, unknownOnly)).toEqual([]);
		mock.stop();
	});
});

describe("claim conflicts in the card", () => {
	it("gives a conflict-only item a sentence, and does not repeat a conflict the changed setting already says", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis) throw new Error("no analysis");
		const conflictOnly = {
			...analysis,
			stale: [],
			failedChecks: [],
			conflicts: [{ recordId: "notifications", subject: "notifications.channel", basedOn: "notifications@2", reasonCodes: ["CLAIM_CONFLICT" as const], message: 'Claims notifications.channel = "sms"; accepted notifications@2 says "in-app".' }],
		};
		expect(reasonSentences(mock.view, conflictOnly)).toEqual(['Claims notifications.channel = "sms"; accepted notifications@2 says "in-app".']);
		// With the real findings the two conflicts are about settings that changed, and say nothing twice.
		expect(reasonSentences(mock.view, analysis)).toHaveLength(3);
		mock.stop();
	});
});

describe("Left alone is only for work the rules find nothing wrong with", () => {
	it("is set for unaffected running and ready work, never for blocked work", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const quiet = mock.view.workItems["WI-1"];
		const blocked = mock.view.workItems["WI-2"];
		if (!quiet || !blocked) throw new Error("no work item");
		expect(quietOf(mock.view, quiet)?.reasonCodes).toContain("NO_DEPENDENCY_ON_CHANGED_FACETS");
		expect(quietOf(mock.view, blocked)).toBeNull();
		await mock.jump(5);
		const ready = mock.view.workItems["WI-1"];
		if (!ready) throw new Error("no work item");
		expect(ready.item.status).toBe("ready");
		expect(quietOf(mock.view, ready)).not.toBeNull();
		mock.stop();
	});

	it("does not surface an old note on work that a later change made stale", async () => {
		const mock = await startMock();
		await mock.jump(5);
		expect(leftAlone(mock.view, "WI-1", { sticky: true })).not.toBeNull();
		// status-model changes after v2 of notifications: WI-1, which relies on it, goes stale.
		const result = await mock.client.api.proposeContextChange({ recordId: "status-model", facets: { "status.values": ["draft", "active", "blocked", "done", "archived"], "status.transitions": "forward-only" }, prose: "", rationale: "later change" }, "later-change");
		expect(result.ok).toBe(true);
		await waitFor(() => ["stale", "conflict"].includes(mock.status("WI-1") ?? ""));
		const wi = mock.view.workItems["WI-1"];
		if (!wi) throw new Error("no work item");
		expect(leftAlone(mock.view, "WI-1", { sticky: true })).toBeNull();
		expect(quietOf(mock.view, wi)).toBeNull();
		mock.stop();
	});
});

describe("the results strip follows the work", () => {
	it("counts what the change made stale, then counts it resolved once it is merged", async () => {
		const mock = await startMock();
		await mock.jump(4);
		expect(currentEvaluation(mock.view)).toMatchObject({ evaluated: 2, stale: 1, resolved: 0, untouched: 1 });

		await mock.jump(9); // WI-1 merges, WI-2 is revalidated and merges
		expect(mock.status("WI-2")).toBe("promoted");
		// The recorded evaluation is history and does not change; the counts the strip shows do.
		expect(mock.view.evaluation?.stale).toBe(1);
		expect(currentEvaluation(mock.view)).toMatchObject({ evaluated: 2, stale: 0, resolved: 1, untouched: 1 });
		mock.stop();
	});

	it("keeps counting an item as stale while it is still blocked, in conflict or being re-run", async () => {
		const mock = await startMock();
		await mock.jump(5);
		expect(stillBlocked(mock.view.workItems["WI-2"])).toBe(true); // conflict
		expect(currentEvaluation(mock.view)).toMatchObject({ stale: 1, resolved: 0 });
		await mock.jump(7); // revalidating
		expect(mock.status("WI-2")).toBe("revalidating");
		expect(currentEvaluation(mock.view)).toMatchObject({ stale: 1, resolved: 0 });
		expect(stillBlocked(undefined)).toBe(false);
		mock.stop();
	});
});
