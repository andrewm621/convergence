import { describe, expect, it } from "vitest";
import { DEMO_IDENTITY } from "@/config";
import { startMock } from "@/test/harness";
import { analysisOf, builtOnStamps, changedSettings, currentEvaluation, exceptionWaiver, hasProblem, reasonSentences, settingLabel, signerFor, signerRecordId, stillBlocked } from "./derive";

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
	it("names the excepted record's own check and says it is failing right now", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis) throw new Error("no analysis");
		expect(exceptionWaiver(mock.view, analysis, "notifications")).toEqual({
			recordId: "notifications",
			check: "tests/contract/notifications.test.ts",
			failing: true,
			signer: DEMO_IDENTITY.label,
		});
		mock.stop();
	});

	it("does not call the check failing while it is passing", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const analysis = analysisOf(mock.view, "WI-2");
		if (!analysis) throw new Error("no analysis");
		expect(exceptionWaiver(mock.view, analysis, "notifications").failing).toBe(false);
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
