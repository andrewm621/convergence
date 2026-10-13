import { buildNotificationsScenario } from "scenario-notifications";
import { describe, expect, it } from "vitest";
import type { ConsoleMessage } from "@/client/types";
import { MockCell } from "@/mock/cell";
import { MockSession } from "@/mock/session";
import { initialViewState, viewReducer, type ViewState } from "./store";

async function world() {
	const bundle = await buildNotificationsScenario();
	const messages: ConsoleMessage[] = [];
	const cell = new MockCell(bundle, (m) => messages.push(m));
	await cell.init("seeded");
	const session = new MockSession(cell, { promoteDelayMs: 0 });
	const apply = (state: ViewState, list: ConsoleMessage[]) => list.reduce((s, message) => viewReducer(s, { type: "message", message }), state);
	return { bundle, cell, session, messages, apply };
}

describe("view reducer", () => {
	it("ignores events until a snapshot has arrived", async () => {
		const { cell, session, messages, apply } = await world();
		await session.startAgents(["wi1"]);
		const state = apply(initialViewState, messages);
		expect(state.ready).toBe(false);
		expect(Object.keys(state.workItems)).toHaveLength(0);
		await cell.emitSnapshot();
	});

	it("builds the same state from a snapshot as from the events that led to it", async () => {
		const { cell, session, messages, apply } = await world();
		const start = apply(initialViewState, [await cell.snapshot()]);
		await session.startAgents(["wi1", "wi2"]);
		await session.fixture("typoFix");
		await session.fixture("v2");
		const streamed = apply(start, messages);
		const fresh = apply(initialViewState, [await cell.snapshot()]);

		expect(streamed.records["notifications"]?.current).toBe(2);
		expect(streamed.records).toEqual(fresh.records);
		expect(streamed.workItems).toEqual(fresh.workItems);
		expect(streamed.dependencies).toEqual(fresh.dependencies);
		expect(streamed.baselineCommit).toBe(fresh.baselineCommit);
		expect(streamed.ledgerHead).toEqual(fresh.ledgerHead);
		expect(streamed.needsResync).toBe(false);
	});

	it("keeps the agent activity pane across a second snapshot, and clears it only on reset", async () => {
		const { cell, apply } = await world();
		const first = apply(initialViewState, [await cell.snapshot()]);
		const activity: ConsoleMessage = { type: "agent-activity", runId: "run-1", workItemId: "wi1", kind: "status", text: "reading the spec", ts: "2026-10-12T00:00:00.000Z" } as unknown as ConsoleMessage;
		const withActivity = apply(first, [activity]);
		expect(withActivity.activity).toHaveLength(1);

		const again = apply(withActivity, [await cell.snapshot()]);
		expect(again.activity).toEqual(withActivity.activity);
		expect(viewReducer(again, { type: "reset" }).activity).toEqual([]);
	});

	it("skips a replayed line and asks for a fresh snapshot when the ledger has a hole", async () => {
		const { cell, session, messages, apply } = await world();
		const start = apply(initialViewState, [await cell.snapshot()]);
		await session.startAgents(["wi1", "wi2"]);
		const events = messages.filter((m) => m.type === "event");
		expect(events.length).toBeGreaterThan(3);

		const replayed = apply(start, [events[0] as ConsoleMessage, events[0] as ConsoleMessage]);
		expect(replayed.ledger).toHaveLength(1);

		const holey = apply(start, [events[0] as ConsoleMessage, events[2] as ConsoleMessage]);
		expect(holey.needsResync).toBe(true);
	});

	it("files a context version accepted by someone other than the authority as proposed, not accepted", async () => {
		const { cell, session, messages, apply } = await world();
		const start = apply(initialViewState, [await cell.snapshot()]);
		await session.fixture("v2Forged");
		const state = apply(start, messages);
		expect(state.records["notifications"]?.current).toBe(1);
		expect(state.records["notifications"]?.proposed?.version).toBe(2);
	});

	it("derives the results strip from a baseline push's effects", async () => {
		const { cell, session, messages, apply } = await world();
		const start = apply(initialViewState, [await cell.snapshot()]);
		await session.startAgents(["wi1", "wi2"]);
		await session.fixture("v2");
		const state = apply(start, messages);
		expect(state.evaluation).toMatchObject({ evaluated: 2, stale: 1, untouched: 1, proseOnly: false, recordRef: "notifications@2" });
		expect(state.evaluation?.ms).toBeGreaterThanOrEqual(0);
	});

	it("keeps the results strip when a baseline push carries no record (the merge commit of a promotion)", async () => {
		const { cell, session, messages, apply } = await world();
		const start = apply(initialViewState, [await cell.snapshot()]);
		await session.startAgents(["wi1", "wi2"]);
		await session.fixture("v2");
		const state = apply(start, messages);
		const last = [...messages].reverse().find((m) => m.type === "event");
		if (!last || last.type !== "event") throw new Error("no event");
		const pushed = last.event.payload.event;
		if (pushed.type !== "BaselinePushed") throw new Error("expected the v2 push last");
		const mergeLine = {
			...last,
			event: { ...last.event, seq: last.event.seq + 1, payload: { ...last.event.payload, event: { ...pushed, records: [] }, effects: [] } },
			workItems: [],
		} as ConsoleMessage;
		const after = apply(state, [mergeLine]);
		expect(after.ledgerHead.seq).toBe(state.ledgerHead.seq + 1);
		expect(after.evaluation).toEqual(state.evaluation);
	});
});
