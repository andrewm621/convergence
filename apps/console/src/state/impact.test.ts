import type { FacetValue, RecordSnapshot, WorkItemState } from "contracts";
import { findStale } from "delta-core";
import { buildShelterIntakeScenario } from "scenario-shelter-intake";
import { describe, expect, it } from "vitest";
import type { UiHint } from "@/mock/beats";
import { startMock } from "@/test/harness";
import { currentRecord, exceptionStatus, impactSentence, impactSummary, previewImpact, validExceptions, type Impact } from "./derive";
import { stillBlocked, toCellState, type ViewState } from "./store";

type Mock = Awaited<ReturnType<typeof startMock>>;
type Scenario = "notifications" | "shelter-intake" | "sales-ops";

/** Play the script until a beat opens the editor, and return what it prefilled: the decision change the story makes. */
async function playToDraft(mock: Mock): Promise<NonNullable<UiHint["editor"]>> {
	let draft: UiHint["editor"] | undefined;
	const stop = mock.client.controls.onUi((hint) => {
		if (hint.editor) draft = hint.editor;
	});
	for (let i = 0; i < mock.beats.length && !draft; i++) await mock.next();
	stop();
	if (!draft) throw new Error("the script never opens the editor");
	return draft;
}

/** Commit through the same call the editor's Commit button makes, so the real mock engine does the work. */
async function commit(mock: Mock, recordId: string, facets: Record<string, FacetValue>) {
	const prose = await mock.client.api.readRecordText(recordId);
	const result = await mock.client.api.proposeContextChange({ recordId, facets, prose, rationale: "impact preview test" }, `impact-${Math.random()}`);
	expect(result).toMatchObject({ ok: true });
}

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id).sort();
/** Work the preview speaks about: not merged, and not rejected (the rest of the console counts rejected work as not blocked). */
const isLive = (wi: WorkItemState) => wi.item.status !== "promoted" && wi.item.status !== "rejected";
const liveIds = (view: ViewState) => Object.values(view.workItems).filter(isLive).map((wi) => wi.item.id).sort();

/** What the engine did: live work that now carries a Stale or ClaimConflict condition on this decision (the conditions are the engine's own state). */
function blockedByEngine(view: ViewState, recordId: string): string[] {
	return Object.values(view.workItems)
		.filter(isLive)
		.filter((wi) => wi.conditions.some((c) => (c.type === "Stale" || c.type === "ClaimConflict") && c.recordRefs.some((ref) => ref.startsWith(`${recordId}@`))))
		.map((wi) => wi.item.id)
		.sort();
}

/** Live work the commit did not block on this decision that the engine's state still has blocked (stale, in conflict, unknown or re-running): what the results strip calls "already blocked". */
function blockedElsewhereByEngine(view: ViewState, recordId: string): string[] {
	const here = blockedByEngine(view, recordId);
	return Object.values(view.workItems)
		.filter(isLive)
		.filter((wi) => !here.includes(wi.item.id))
		.filter((wi) => stillBlocked(wi))
		.map((wi) => wi.item.id)
		.sort();
}

/** Exceptions on this decision that were valid before the commit and are not after, on work that is not merged. */
function exceptionsEnded(before: ViewState, after: ViewState, recordId: string): string[] {
	return Object.values(before.workItems)
		.filter(isLive)
		.filter((wi) => validExceptions(before, wi).some((e) => e.recordId === recordId))
		.filter((wi) => {
			const now = after.workItems[wi.item.id];
			return !now || !validExceptions(after, now).some((e) => e.recordId === recordId);
		})
		.map((wi) => wi.item.id)
		.sort();
}

/**
 * The property: the preview, taken from the view before the commit, names exactly the work the engine blocks and the work it
 * leaves alone, and the exceptions it ends. Returns the preview so a caller can also check its wording.
 */
async function expectPreviewToMatchEngine(mock: Mock, recordId: string, facets: Record<string, FacetValue>): Promise<Impact> {
	const before = mock.view;
	const impact = previewImpact(before, recordId, facets);
	if (!impact) throw new Error("no preview");
	await commit(mock, recordId, facets);
	const after = mock.view;

	const blocked = blockedByEngine(after, recordId);
	const elsewhere = blockedElsewhereByEngine(after, recordId);
	const blockedBefore = blockedByEngine(before, recordId);
	expect(ids(impact.blocked), "blocked").toEqual(blocked);
	expect(ids(impact.alreadyBlocked), "already blocked").toEqual(blocked.filter((id) => blockedBefore.includes(id)));
	expect(ids(impact.blockedElsewhere), "blocked elsewhere").toEqual(elsewhere);
	expect(ids(impact.leftAlone), "left alone").toEqual(liveIds(before).filter((id) => !blocked.includes(id) && !elsewhere.includes(id)));
	expect(ids(impact.endsExceptions), "ends exceptions").toEqual(exceptionsEnded(before, after, recordId));
	expect(after.records[recordId]?.current).toBe(impact.toVersion);
	return impact;
}

describe("the impact preview equals what the engine does on commit", () => {
	it.each<[Scenario, string]>([
		["notifications", "Notification preferences and delivery"],
		["shelter-intake", "Front-desk intake script, Door signage text, Volunteer briefing one-pager"],
		["sales-ops", "Q4 pipeline forecast, SDR weekly priorities"],
	])("the %s decision change: the work it blocks is the work the engine marks stale", async (scenario, names) => {
		const mock = await startMock({ scenario });
		const draft = await playToDraft(mock);
		const before = mock.view;
		const impact = await expectPreviewToMatchEngine(mock, draft.recordId, draft.facets);
		expect(impact.blocked.map((b) => b.title).join(", ")).toBe(names);
		expect(impact.blocked.length).toBeGreaterThan(0);
		expect(impact.leftAlone.length).toBeGreaterThan(0);
		expect(impact.saves).toBe("version");

		// The engine's own ledger line for that commit says the same thing: these went stale, the rest were left alone.
		const evaluation = mock.view.evaluation;
		expect(evaluation).not.toBeNull();
		expect([...ids(impact.blocked), ...ids(impact.blockedElsewhere)]).toEqual([...(evaluation?.staleIds ?? []), ...(evaluation?.alreadyStaleIds ?? [])].sort());
		expect(evaluation?.untouched).toBe(impact.leftAlone.length);
		expect(liveIds(before)).toEqual([...ids(impact.blocked), ...ids(impact.leftAlone)].sort());
		mock.stop();
	});

	it("says it in plain words for the shelter and notifications changes", async () => {
		const shelter = await startMock({ scenario: "shelter-intake" });
		const sd = await playToDraft(shelter);
		const sImpact = previewImpact(shelter.view, sd.recordId, sd.facets);
		expect(sImpact && impactSentence(sImpact)).toBe(
			"This makes v2 the decision. Blocks 3 built on v1: Front-desk intake script, Door signage text, Volunteer briefing one-pager. Leaves 2 alone: Cots and blankets supply list, Shift schedule.",
		);
		shelter.stop();

		const notifications = await startMock({ scenario: "notifications" });
		const nd = await playToDraft(notifications);
		const nImpact = previewImpact(notifications.view, nd.recordId, nd.facets);
		expect(nImpact && impactSentence(nImpact)).toBe(
			"This makes v2 the decision. Blocks 1 built on v1: Notification preferences and delivery. Leaves 1 alone: Status badges and the status-change API.",
		);
		notifications.stop();
	});

	it("the shelter policy moving to v3 ends the door signage exception, and the preview says so", async () => {
		const bundle = await buildShelterIntakeScenario();
		const v3 = bundle.events.v3;
		if (v3?.type !== "BaselinePushed") throw new Error("v3 is not a baseline push");
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(mock.beats.length - 1); // everything but the lapse beat has played
		const signage = mock.view.workItems["WI-2"];
		if (!signage) throw new Error("no WI-2");
		expect(validExceptions(mock.view, signage)).toHaveLength(1);

		const impact = await expectPreviewToMatchEngine(mock, "shelter-intake-policy", v3.records[0]?.facets ?? {});
		expect(impactSentence(impact)).toBe("This makes v3 the decision. Blocks nothing new. Keeps 1 blocked: Door signage text. Ends 1 exception: Door signage text.");
		// Merged work is not touched, so it is in neither list.
		expect([...ids(impact.blocked), ...ids(impact.leftAlone)]).toEqual(["WI-2"]);
		const after = mock.view.workItems["WI-2"];
		const exception = after?.resolutions.find((r) => r.kind === "accept-exception");
		if (!after || !exception) throw new Error("exception missing");
		expect(exceptionStatus(mock.view, after, exception)).toMatchObject({ lapsed: true, reasonCode: "EXCEPTION_LAPSED" });
		mock.stop();
	}, 30_000);

	it("a one-setting edit to any decision, at every point in each story, matches the engine", async () => {
		const edit = (value: FacetValue): FacetValue => (typeof value === "boolean" ? !value : typeof value === "number" ? value + 1 : Array.isArray(value) ? [...value, "extra"] : `${value} (edited)`);
		let cases = 0;
		let blockedCases = 0;
		for (const scenario of ["notifications", "shelter-intake", "sales-ops"] as const) {
			const mock = await startMock({ scenario });
			for (let position = 0; position <= mock.beats.length; position++) {
				const recordFacets = Object.entries(mock.view.records).flatMap(([recordId, history]) => {
					const head = history.current === null ? null : history.versions[String(history.current)];
					return head ? Object.keys(head.facets).map((key) => ({ recordId, key })) : [];
				});
				for (const { recordId, key } of recordFacets) {
					const current = currentRecord(mock.view, recordId) as RecordSnapshot;
					const impact = await expectPreviewToMatchEngine(mock, recordId, { ...current.facets, [key]: edit(current.facets[key] as FacetValue) });
					cases += 1;
					if (impact.blocked.length > 0) blockedCases += 1;
					// Rewind to where this case started.
					await mock.client.controls.reset();
					await mock.jump(position);
				}
				if (position < mock.beats.length) await mock.next();
			}
			mock.stop();
		}
		expect(cases).toBeGreaterThan(100);
		expect(blockedCases).toBeGreaterThan(20);
	}, 240_000);
});

describe("previewImpact", () => {
	it("after v2, work built on v1 stays blocked, and an edit that puts the settings back as v1 had them frees it", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(4); // v2 has landed: the script, signage and briefing are stale
		const v1 = mock.view.records["shelter-intake-policy"]?.versions["1"];
		if (!v1) throw new Error("no v1");
		const v2 = currentRecord(mock.view, "shelter-intake-policy") as RecordSnapshot;

		const again = previewImpact(mock.view, "shelter-intake-policy", { ...v2.facets, hours: "doors open 8:00 to 20:00 daily" });
		expect(again?.blocked.map((b) => [b.id, b.heldVersion])).toEqual([
			["WI-1", 1],
			["WI-2", 1],
			["WI-3", 1],
			["WI-5", 1],
		]);
		// Three of those are blocked on v2 already, so the line says one more, and counts the others as kept.
		expect(ids(again?.alreadyBlocked ?? [])).toEqual(["WI-1", "WI-2", "WI-3"]);
		expect(again && impactSentence(again)).toBe(
			"This makes v3 the decision. Blocks 1 more built on v1: Shift schedule. Keeps 3 blocked: Front-desk intake script, Door signage text, Volunteer briefing one-pager. Leaves 1 alone: Cots and blankets supply list.",
		);

		const back = previewImpact(mock.view, "shelter-intake-policy", v1.facets);
		expect(back?.blocked).toEqual([]);
		expect(back?.leftAlone.map((b) => b.id)).toEqual(["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]);
		mock.stop();
	});

	it("leaves out rejected work, as the rest of the console treats it as not blocked, and still matches the engine", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(5); // v2 landed and the drafts are in: the script is stale and has a head to bind to
		const wi = mock.view.workItems["WI-1"];
		const record = currentRecord(mock.view, "shelter-intake-policy") as RecordSnapshot;
		if (!wi?.headSha) throw new Error("WI-1 has no head");
		const rejected = await mock.client.api.resolve(
			{
				kind: "reject",
				workItemId: "WI-1",
				rationale: "Not needed any more.",
				binding: { recordId: record.recordId, version: record.version, blobHash: record.blobHash, baseSha: mock.view.baselineCommit, forkHeadSha: wi.headSha, contextSnapshotHash: mock.view.snapshotHash },
			},
			"reject-wi-1",
		);
		expect(rejected).toMatchObject({ ok: true });
		expect(mock.view.workItems["WI-1"]?.item.status).toBe("rejected");

		const impact = await expectPreviewToMatchEngine(mock, "shelter-intake-policy", { ...record.facets, hours: "doors open 8:00 to 20:00 daily" });
		const named = [...impact.blocked, ...impact.leftAlone, ...impact.blockedElsewhere, ...impact.endsExceptions].map((i) => i.id);
		expect(named).not.toContain("WI-1");
		expect(impactSentence(impact)).not.toContain("Front-desk intake script");
		expect(mock.view.workItems["WI-1"]?.item.status).toBe("rejected");
		mock.stop();
	});

	it("does not call work blocked on another decision 'left alone', and the results strip agrees", async () => {
		const mock = await startMock({ scenario: "notifications" });
		await mock.jump(1); // both agents run; the status badges and the notification work both rely on status-model
		const status = currentRecord(mock.view, "status-model") as RecordSnapshot;
		await commit(mock, "status-model", { ...status.facets, "status.values": ["draft", "active", "blocked", "done", "archived"] });
		expect(mock.view.workItems["WI-1"]?.item.status).toBe("stale");

		const notifications = currentRecord(mock.view, "notifications") as RecordSnapshot;
		const impact = await expectPreviewToMatchEngine(mock, "notifications", { ...notifications.facets, "notifications.default": "opt-in" });
		expect(ids(impact.blocked)).toEqual(["WI-2"]);
		expect(ids(impact.blockedElsewhere)).toEqual(["WI-1"]);
		expect(impact.leftAlone).toEqual([]);
		expect(impactSentence(impact)).toBe(
			"This makes v2 the decision. Blocks 1 built on v1: Notification preferences and delivery. 1 already blocked on another decision: Status badges and the status-change API.",
		);
		// The strip, after the commit, counts WI-1 as already stale rather than as untouched.
		expect(mock.view.evaluation?.alreadyStaleIds).toContain("WI-1");
		mock.stop();
	});

	it("leaves out merged work entirely", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(9); // four drafts are merged
		const current = currentRecord(mock.view, "shelter-intake-policy") as RecordSnapshot;
		const impact = previewImpact(mock.view, "shelter-intake-policy", { ...current.facets, hours: "closed" });
		expect(ids([...(impact?.blocked ?? []), ...(impact?.leftAlone ?? [])])).toEqual(["WI-2"]);
		mock.stop();
	});

	it("says nothing is blocked when nothing changed, and when only the wording did", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(1);
		const current = currentRecord(mock.view, "shelter-intake-policy") as RecordSnapshot;

		const none = previewImpact(mock.view, "shelter-intake-policy", current.facets);
		expect(none).toMatchObject({ saves: "nothing", blocked: [], endsExceptions: [], changedKeys: [], toVersion: 1 });
		expect(none && impactSentence(none)).toBe("Nothing changed yet, so nothing is blocked.");

		const wording = previewImpact(mock.view, "shelter-intake-policy", current.facets, { proseChanged: true });
		expect(wording).toMatchObject({ saves: "prose-edit", blocked: [], toVersion: 1 });
		expect(wording && impactSentence(wording)).toBe("This saves a wording change to v1. No setting changed, so nothing is blocked.");
		mock.stop();
	});

	it("blocks only work that relies on a changed setting, unless the policy counts any change", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(3);
		const current = currentRecord(mock.view, "shelter-intake-policy") as RecordSnapshot;
		const facets = { ...current.facets, hours: "doors open 8:00 to 20:00 daily" };

		const byFacet = previewImpact(mock.view, "shelter-intake-policy", facets);
		const relying = mock.view.dependencies.filter((d) => d.recordId === "shelter-intake-policy" && (d.facetKeys.length === 0 || d.facetKeys.includes("hours"))).map((d) => d.workItemId);
		expect(byFacet?.staleness).toBe("facet");
		expect(ids(byFacet?.blocked ?? [])).toEqual([...new Set(relying)].sort());
		expect(byFacet?.blocked.length).toBeLessThan(5);

		// Under a policy where any change counts, every dependent is blocked, and a wording edit is a change too.
		const record = { ...mock.view, policy: mock.view.policy && { ...mock.view.policy, staleness: "record" as const } };
		const byRecord = previewImpact(record, "shelter-intake-policy", facets);
		const wording = previewImpact(record, "shelter-intake-policy", current.facets, { proseChanged: true });
		const dependents = [...new Set(mock.view.dependencies.filter((d) => d.recordId === "shelter-intake-policy" && d.status === "accepted").map((d) => d.workItemId))].sort();
		expect(ids(byRecord?.blocked ?? [])).toEqual(dependents);
		expect(ids(wording?.blocked ?? [])).toEqual(dependents);
		expect(wording?.toVersion).toBe(1);
		expect(wording && impactSentence(wording)).toContain("This saves a wording change to v1, and this decision counts any change.");

		// And the engine's own staleness rule agrees, taking the new version as given.
		for (const [mode, impact] of [["facet", byFacet], ["record", byRecord]] as const) {
			const next: RecordSnapshot = { ...current, version: current.version + 1, blobHash: "e".repeat(40), facets };
			const state = toCellState(record);
			state.records["shelter-intake-policy"] = { current: next.version, versions: { ...state.records["shelter-intake-policy"]?.versions, [String(next.version)]: next }, proposed: null };
			const policy = { ...(record.policy as NonNullable<typeof record.policy>), staleness: mode };
			const stale = Object.values(state.workItems).filter((wi) => findStale(state, wi, policy).some((f) => f.recordId === "shelter-intake-policy")).map((wi) => wi.item.id);
			expect(ids(impact?.blocked ?? []), mode).toEqual(stale.sort());
		}
		mock.stop();
	});

	it("names the exception a new version ends, and not for a wording edit", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(6); // the door signage holds a scoped exception
		const current = currentRecord(mock.view, "shelter-intake-policy") as RecordSnapshot;

		const changed = previewImpact(mock.view, "shelter-intake-policy", { ...current.facets, hours: "closed" });
		expect(changed?.endsExceptions).toHaveLength(1);
		expect(changed?.endsExceptions[0]).toMatchObject({ id: "WI-2", title: "Door signage text" });
		expect(changed && impactSentence(changed)).toMatch(/ Ends 1 exception: Door signage text\.$/);

		const wording = previewImpact(mock.view, "shelter-intake-policy", current.facets, { proseChanged: true });
		expect(wording?.endsExceptions).toEqual([]);
		mock.stop();
	});

	it("is null for a decision with no accepted version", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		expect(previewImpact(mock.view, "no-such-decision", {})).toBeNull();
		mock.stop();
	});
});

describe("impactSentence", () => {
	const item = (id: string, title: string, heldVersion: number | null = 1) => ({ id, title, heldVersion });
	const impact = (over: Partial<Impact>): Impact => ({ recordId: "r", fromVersion: 1, toVersion: 2, saves: "version", changedKeys: ["k"], blocked: [], alreadyBlocked: [], leftAlone: [], blockedElsewhere: [], endsExceptions: [], staleness: "facet", ...over });

	it("uses the singular for one item", () => {
		expect(impactSentence(impact({ blocked: [item("WI-1", "Front-desk script")], leftAlone: [item("WI-2", "Supply list")], endsExceptions: [{ id: "WI-1", title: "Front-desk script", scope: null }] }))).toBe(
			"This makes v2 the decision. Blocks 1 built on v1: Front-desk script. Leaves 1 alone: Supply list. Ends 1 exception: Front-desk script.",
		);
	});

	it("uses the plural for several", () => {
		expect(
			impactSentence(
				impact({
					blocked: [item("WI-1", "Front-desk script"), item("WI-3", "Volunteer briefing")],
					leftAlone: [item("WI-4", "Supply list"), item("WI-5", "Shift schedule")],
					endsExceptions: [
						{ id: "WI-1", title: "Front-desk script", scope: null },
						{ id: "WI-3", title: "Volunteer briefing", scope: null },
					],
				}),
			),
		).toBe("This makes v2 the decision. Blocks 2 built on v1: Front-desk script, Volunteer briefing. Leaves 2 alone: Supply list, Shift schedule. Ends 2 exceptions: Front-desk script, Volunteer briefing.");
	});

	it("says so when the work was built on different versions, and when there is none to block", () => {
		expect(impactSentence(impact({ toVersion: 3, blocked: [item("A", "A", 1), item("B", "B", 2)] }))).toBe("This makes v3 the decision. Blocks 2 built on an older version: A, B.");
		expect(impactSentence(impact({ leftAlone: [item("A", "Only one")] }))).toBe("This makes v2 the decision. Blocks nothing. Leaves 1 alone: Only one.");
		expect(impactSentence(impact({}))).toBe("This makes v2 the decision. No work is built on it yet, so nothing is blocked.");
	});

	it("separates work that stays blocked from work newly blocked, and work blocked on another decision from work left alone", () => {
		const kept = [item("WI-1", "Front-desk script"), item("WI-2", "Door signage")];
		expect(impactSentence(impact({ blocked: [...kept, item("WI-5", "Shift schedule")], alreadyBlocked: kept }))).toBe(
			"This makes v2 the decision. Blocks 1 more built on v1: Shift schedule. Keeps 2 blocked: Front-desk script, Door signage.",
		);
		expect(impactSentence(impact({ blocked: kept, alreadyBlocked: kept, leftAlone: [item("WI-4", "Supply list")] }))).toBe(
			"This makes v2 the decision. Blocks nothing new. Keeps 2 blocked: Front-desk script, Door signage. Leaves 1 alone: Supply list.",
		);
		expect(impactSentence(impact({ leftAlone: [item("WI-4", "Supply list")], blockedElsewhere: [item("WI-6", "Menu"), item("WI-7", "Rota")] }))).toBe(
			"This makes v2 the decision. Blocks nothing. Leaves 1 alone: Supply list. 2 already blocked on another decision: Menu, Rota.",
		);
		expect(impactSentence(impact({ blockedElsewhere: [item("WI-6", "Menu")] }))).toBe("This makes v2 the decision. Blocks nothing. 1 already blocked on another decision: Menu.");
	});

	it("keeps the screen-reader summary to counts", () => {
		expect(impactSummary(impact({ blocked: [item("A", "A"), item("B", "B"), item("C", "C")], leftAlone: [item("D", "D"), item("E", "E")] }))).toBe("Blocks 3, leaves 2 alone.");
		expect(impactSummary(impact({ saves: "nothing" }))).toBe("Nothing changed yet.");
	});

	it("shortens a long list", () => {
		const many = Array.from({ length: 9 }, (_, i) => item(`WI-${i}`, `Item ${i}`));
		expect(impactSentence(impact({ leftAlone: many }))).toContain("Leaves 9 alone: Item 0, Item 1, Item 2, Item 3, Item 4, Item 5 and 3 more.");
	});
});
