import { claims } from "scenario-notifications";
import type { WorkItemState } from "contracts";
import { describe, expect, it } from "vitest";
import { startMock } from "@/test/harness";
import { builtOnRows } from "./built-on";
import type { ViewState } from "./store";
import { groupByTray, rowReason, trayOf, type Tray } from "./trays";

function item(view: ViewState, id: string): WorkItemState {
	const wi = view.workItems[id];
	if (!wi) throw new Error(`no ${id}`);
	return wi;
}

function ids(groups: Record<Tray, WorkItemState[]>): Record<Tray, string[]> {
	return {
		"needs-you": groups["needs-you"].map((wi) => wi.item.id),
		working: groups.working.map((wi) => wi.item.id),
		ready: groups.ready.map((wi) => wi.item.id),
		merged: groups.merged.map((wi) => wi.item.id),
	};
}

/** The same view, with one work item's status swapped: for the statuses the scripts do not reach. */
function withStatus(view: ViewState, id: string, status: WorkItemState["item"]["status"]): WorkItemState {
	const wi = item(view, id);
	return { ...wi, item: { ...wi.item, status } };
}

describe("trayOf", () => {
	it("sorts blocked and held work into Needs you", async () => {
		const mock = await startMock();
		await mock.jump(4);
		for (const status of ["stale", "conflict", "uncertain"] as const) expect(trayOf(mock.view, withStatus(mock.view, "WI-2", status), false)).toBe("needs-you");
		mock.stop();
	});

	it("keeps running, re-running and up-to-date work in Working", async () => {
		const mock = await startMock();
		await mock.jump(1);
		for (const status of ["running", "revalidating", "fresh"] as const) expect(trayOf(mock.view, withStatus(mock.view, "WI-1", status), false)).toBe("working");
		mock.stop();
	});

	it("puts ready work in Ready, and merged or rejected work in Merged", async () => {
		const mock = await startMock();
		await mock.jump(1);
		expect(trayOf(mock.view, withStatus(mock.view, "WI-1", "ready"), false)).toBe("ready");
		expect(trayOf(mock.view, withStatus(mock.view, "WI-1", "promoted"), false)).toBe("merged");
		expect(trayOf(mock.view, withStatus(mock.view, "WI-1", "rejected"), false)).toBe("merged");
		mock.stop();
	});

	it("keeps ready work in Working while the poller is degraded: nothing is shown as mergeable", async () => {
		const mock = await startMock();
		await mock.jump(1);
		expect(trayOf(mock.view, withStatus(mock.view, "WI-1", "ready"), true)).toBe("working");
		expect(trayOf(mock.view, withStatus(mock.view, "WI-1", "fresh"), true)).toBe("working");
		expect(rowReason(mock.view, withStatus(mock.view, "WI-1", "ready"), true)).toMatch(/^Unconfirmed/);
		mock.stop();
	});
});

describe("groupByTray across the notifications story", () => {
	it("moves WI-2 from Working to Needs you when v2 lands, and leaves WI-1 working", async () => {
		const mock = await startMock();
		await mock.jump(1);
		expect(ids(groupByTray(mock.view, false))).toEqual({ "needs-you": [], working: ["WI-1", "WI-2"], ready: [], merged: [] });
		await mock.jump(4);
		const groups = ids(groupByTray(mock.view, false));
		expect(groups["needs-you"]).toEqual(["WI-2"]);
		expect([...groups.working, ...groups.ready]).toContain("WI-1");
		mock.stop();
	});

	it("ends with both merged", async () => {
		const mock = await startMock();
		await mock.jump(mock.beats.length);
		expect(ids(groupByTray(mock.view, false))).toEqual({ "needs-you": [], working: [], ready: [], merged: ["WI-1", "WI-2"] });
		expect(rowReason(mock.view, item(mock.view, "WI-1"), false)).toMatch(/^Merged/);
		mock.stop();
	});

	it("puts every seeded fan-out item in a tray, and counts add up", async () => {
		const mock = await startMock({ script: "fanout" });
		await mock.jump(mock.beats.length);
		const groups = groupByTray(mock.view, false);
		const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
		expect(total).toBe(Object.keys(mock.view.workItems).length);
		expect(groups["needs-you"].length).toBeGreaterThan(0);
		mock.stop();
	});
});

describe("rowReason", () => {
	it("leads a blocked row with the stamp the video names", async () => {
		const mock = await startMock();
		await mock.jump(4);
		expect(rowReason(mock.view, item(mock.view, "WI-2"), false)).toBe("Built on notifications v1 · now v2");
		mock.stop();
	});

	it("says WI-1 was left alone by the change, in plain words", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const reason = rowReason(mock.view, item(mock.view, "WI-1"), false);
		expect(reason).toContain("Left alone");
		expect(reason).toContain("notifications v2");
		expect(reason).not.toMatch(/@/);
		mock.stop();
	});

	it("names the exception that lets ready work through", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(6);
		const wi = item(mock.view, "WI-2");
		expect(trayOf(mock.view, wi, false)).toBe("ready");
		expect(rowReason(mock.view, wi, false)).toMatch(/^Ready with an exception from .*signs\/door\.md/);
		mock.stop();
	});

	it("names the decision a held item's claims rely on but was not given", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const wi = undeclared(mock.view);
		expect(rowReason(mock.view, wi, false)).toBe("Claims rely on notifications, which it wasn't given.");
		mock.stop();
	});
});

/** WI-1 with claims that also cite notifications, which it was not given (rule R4), held for a person. */
function undeclared(view: ViewState): WorkItemState {
	const wi = item(view, "WI-1");
	const headSha = wi.headSha ?? "1".repeat(40);
	const held: WorkItemState = { ...wi, headSha, item: { ...wi.item, status: "uncertain" }, claims: { headSha, status: "ok", claims: claims.wi1Undeclared, error: null } };
	view.workItems["WI-1"] = held;
	return held;
}

describe("builtOnRows", () => {
	it("marks WI-2's notifications row ✗ built on v1, now v2, with the settings that changed", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const rows = builtOnRows(mock.view, item(mock.view, "WI-2"));
		expect(rows.map((r) => [r.recordId, r.state])).toEqual([
			["notifications", "outdated"],
			["status-model", "current"],
		]);
		const [notifications] = rows;
		expect(notifications).toMatchObject({ builtOnVersion: 1, currentVersion: 2, detail: "built on v1, now v2" });
		expect(notifications?.changedSettings.map((s) => s.key)).toEqual(["notifications.cadence", "notifications.default"]);
		mock.stop();
	});

	it("marks every row current before anything changes", async () => {
		const mock = await startMock();
		await mock.jump(1);
		expect(builtOnRows(mock.view, item(mock.view, "WI-2")).every((r) => r.state === "current")).toBe(true);
		expect(builtOnRows(mock.view, item(mock.view, "WI-1")).map((r) => [r.recordId, r.state, r.builtOnVersion])).toEqual([["status-model", "current", 1]]);
		mock.stop();
	});

	it("shows WI-1 left alone by the notifications change it was never given", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const rows = builtOnRows(mock.view, item(mock.view, "WI-1"));
		expect(rows.map((r) => [r.recordId, r.state])).toEqual([
			["notifications", "left-alone"],
			["status-model", "current"],
		]);
		expect(rows[0]?.detail).toContain("doesn't rely on it");
		mock.stop();
	});

	it("marks a decision the claims rely on but the work was not given with ?", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const rows = builtOnRows(mock.view, undeclared(mock.view));
		expect(rows.map((r) => [r.recordId, r.state, r.builtOnVersion])).toEqual([
			["notifications", "not-given", 1],
			["status-model", "current", 1],
		]);
		mock.stop();
	});

	it("goes back to current once WI-2 is re-run on v2", async () => {
		const mock = await startMock();
		await mock.jump(8);
		const rows = builtOnRows(mock.view, item(mock.view, "WI-2"));
		expect(rows.find((r) => r.recordId === "notifications")).toMatchObject({ state: "current", builtOnVersion: 2, currentVersion: 2 });
		mock.stop();
	});

	it("covers the knowledge-work scenario: three outdated, two left alone", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(4);
		const states = ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"].map((id) => builtOnRows(mock.view, item(mock.view, id))[0]?.state);
		expect(states).toEqual(["outdated", "outdated", "outdated", expect.stringMatching(/left-alone|current/), expect.stringMatching(/left-alone|current/)]);
		mock.stop();
	});

	it("covers the sales scenario", async () => {
		const mock = await startMock({ scenario: "sales-ops" });
		await mock.jump(4);
		for (const id of ["WI-3", "WI-4"]) expect(builtOnRows(mock.view, item(mock.view, id))[0]?.state).toBe("outdated");
		expect(builtOnRows(mock.view, item(mock.view, "WI-5")).some((r) => r.state === "outdated")).toBe(false);
		mock.stop();
	});
});
