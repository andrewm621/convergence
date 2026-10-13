import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DegradedContext, StatusChip } from "@/components/status";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ConsoleClient, PollerHealth } from "@/client/types";
import { initialViewState, isDegraded, viewReducer } from "@/state/store";
import { startMock } from "@/test/harness";
import { renderWithMock } from "@/test/render";
import { EmptyContext } from "./context-timeline";
import { Header, PollerBadge } from "./header";
import { PromoteButton } from "./promote-button";
import { StartAgents } from "./work-graph";

const DEGRADED: PollerHealth = { healthy: false, degraded: [{ repo: "baseline-demo", kind: "baseline", lastError: "timeout", note: "retrying commit abc1234" }] };
const HEALTHY: PollerHealth = { healthy: true, degraded: [] };

/** The mock, dressed as the live Worker: no seed or start, and a poller health it reports on every frame. */
function liveLike(client: ConsoleClient, health: { current: PollerHealth }): ConsoleClient {
	return {
		...client,
		capabilities: { seed: false, start: false, changes: false },
		connect(handlers) {
			return client.connect({ ...handlers, onMessage: (message) => handlers.onMessage({ ...message, meta: { ...message.meta, poller: health.current } }) });
		},
	} as ConsoleClient;
}

describe("poller health in the view", () => {
	it("takes health from snapshot and event meta, and clears it when the poller recovers", async () => {
		const mock = await startMock();
		const snapshot = mock.messages.find((m) => m.type === "snapshot");
		if (!snapshot) throw new Error("no snapshot");
		expect(isDegraded(mock.view)).toBe(false); // the mock does not report health

		let view = viewReducer(initialViewState, { type: "message", message: { ...snapshot, meta: { poller: DEGRADED } } });
		expect(view.poller).toEqual(DEGRADED);
		expect(isDegraded(view)).toBe(true);

		// A snapshot with no health keeps the last known state; one that says healthy clears it.
		view = viewReducer(view, { type: "message", message: snapshot });
		expect(isDegraded(view)).toBe(true);
		view = viewReducer(view, { type: "message", message: { ...snapshot, meta: { poller: HEALTHY } } });
		expect(isDegraded(view)).toBe(false);
		mock.stop();
	});

	it("applies a live event's meta: records, dependencies and baseline, without a re-read", async () => {
		const mock = await startMock();
		await mock.jump(3);
		const snapshot = mock.messages.filter((m) => m.type === "snapshot").at(-1);
		const before = mock.messages.length;
		await mock.next(); // v2 lands
		const event = mock.messages.slice(before).find((m) => m.type === "event");
		if (!snapshot || !event || event.type !== "event") throw new Error("no event");
		let view = viewReducer(initialViewState, { type: "message", message: snapshot });
		const records = { ...mock.view.records };
		const dependencies = [...mock.view.dependencies];
		view = viewReducer(view, { type: "message", message: { ...event, meta: { seq: event.event.seq, records, dependencies, baselineCommit: mock.view.baselineCommit, snapshotHash: mock.view.snapshotHash, poller: DEGRADED } } });
		expect(view.records).toEqual(records);
		expect(view.dependencies).toEqual(dependencies);
		expect(view.baselineCommit).toBe(mock.view.baselineCommit);
		expect(view.needsResync).toBe(false);
		expect(view.poller).toEqual(DEGRADED);
		mock.stop();
	});
});

describe("poller degraded: visible, and never Fresh", () => {
	it("shows a badge naming the failing repos only while degraded", () => {
		const { rerender } = render(<PollerBadge poller={null} />);
		expect(screen.queryByTestId("poller-degraded")).toBeNull();
		rerender(<PollerBadge poller={HEALTHY} />);
		expect(screen.queryByTestId("poller-degraded")).toBeNull();
		rerender(<PollerBadge poller={DEGRADED} />);
		const badge = screen.getByTestId("poller-degraded");
		expect(badge).toHaveTextContent("Poller degraded");
		expect(badge).toHaveTextContent("1 repo");
		expect(badge.getAttribute("title")).toContain("retrying commit abc1234");
	});

	it("puts the badge in the header next to the connection state", () => {
		render(<Header scenario="notifications" onScenario={() => undefined} connection="live" poller={DEGRADED} />);
		expect(screen.getByTestId("poller-degraded")).toBeInTheDocument();
		expect(screen.getByText("Live")).toBeInTheDocument();
	});

	it("shows a fresh or ready work item as unconfirmed, never as fresh or cleared, while degraded", () => {
		const { rerender } = render(<StatusChip status="fresh" />);
		expect(screen.getByText("fresh")).toBeInTheDocument();
		rerender(
			<DegradedContext.Provider value>
				<StatusChip status="fresh" />
			</DegradedContext.Provider>,
		);
		expect(screen.queryByText("fresh")).toBeNull();
		expect(screen.getByText("unconfirmed")).toBeInTheDocument();
		// "Cleared by the gate" is a claim about current decisions too, so ready is downgraded the same way.
		rerender(<StatusChip status="ready" />);
		expect(screen.getByText("ready")).toBeInTheDocument();
		rerender(
			<DegradedContext.Provider value>
				<StatusChip status="ready" />
			</DegradedContext.Provider>,
		);
		expect(screen.queryByText("ready")).toBeNull();
		expect(screen.getByText("unconfirmed")).toBeInTheDocument();
		expect(screen.getByText("unconfirmed").closest("[data-status]")).toHaveAttribute("title", expect.not.stringContaining("Cleared by the gate"));
		// Other statuses are not rewritten.
		rerender(
			<DegradedContext.Provider value>
				<StatusChip status="stale" />
			</DegradedContext.Provider>,
		);
		expect(screen.getByText("needs review")).toBeInTheDocument();
	});

	it("closes Promote while degraded even when the gate passes, and reopens when the poller recovers", async () => {
		const health = { current: HEALTHY };
		const user = userEvent.setup();
		const mock = await renderWithMock(<PromoteButton workItemId="WI-1" />, { beats: 5 });
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
		mock.unmount();

		const live = await renderLive(health, 5);
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
		health.current = DEGRADED;
		await act(async () => {
			await live.client.refresh();
		});
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeDisabled());
		await user.hover(screen.getByTestId("promote-trigger"));
		expect(await screen.findByRole("tooltip")).toHaveTextContent(/poller is degraded/i);
		health.current = HEALTHY;
		await act(async () => {
			await live.client.refresh();
		});
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
	});
});

async function renderLive(health: { current: PollerHealth }, beats: number) {
	const { createMockClient } = await import("@/mock/client");
	const { ConsoleProvider } = await import("@/state/console-context");
	const base = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null });
	const client = liveLike(base, health);
	render(
		<TooltipProvider delayDuration={0}>
			<ConsoleProvider client={client} flushMs={1}>
				<PromoteButton workItemId="WI-1" />
			</ConsoleProvider>
		</TooltipProvider>,
	);
	await waitFor(() => expect(base.controls.getState().ready).toBe(true));
	await base.controls.jump(beats);
	await waitFor(() => expect(base.controls.getState().busy).toBe(false));
	return { client, base };
}

describe("live mode disables what the Worker does not have", () => {
	it("disables Seed with a tooltip, and never calls the seed endpoint", async () => {
		const user = userEvent.setup();
		const { createMockClient } = await import("@/mock/client");
		const { ConsoleProvider } = await import("@/state/console-context");
		const base = createMockClient({ scenario: "notifications", drip: false, start: "empty" });
		const seed = vi.spyOn(base.api, "seedScenario");
		render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={liveLike(base, { current: HEALTHY })} flushMs={1}>
					<EmptyContext />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		const button = await screen.findByRole("button", { name: /Seed the scenario/ });
		expect(button).toBeDisabled();
		await user.hover(screen.getByTestId("unavailable-action"));
		expect(await screen.findByRole("tooltip")).toHaveTextContent(/not available against the live Worker/);
		await user.click(button).catch(() => undefined);
		expect(seed).not.toHaveBeenCalled();
	});

	it("disables Start with a tooltip in live mode, and leaves it enabled in the mock", async () => {
		const { createMockClient } = await import("@/mock/client");
		const { ConsoleProvider } = await import("@/state/console-context");
		const user = userEvent.setup();
		const base = createMockClient({ scenario: "notifications", drip: false });
		const onStart = vi.fn().mockResolvedValue({ ok: true });

		const view = render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={base} flushMs={1}>
					<StartAgents onStart={onStart} />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		expect(await screen.findByRole("button", { name: /Start the scenario/ })).toBeEnabled();
		expect(screen.queryByTestId("unavailable-action")).toBeNull();
		view.unmount();

		render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={liveLike(base, { current: HEALTHY })} flushMs={1}>
					<StartAgents onStart={onStart} />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		const button = await screen.findByRole("button", { name: /Start the scenario/ });
		expect(button).toBeDisabled();
		await user.hover(screen.getByTestId("unavailable-action"));
		expect(await screen.findByRole("tooltip")).toHaveTextContent(/not available against the live Worker/);
		expect(onStart).not.toHaveBeenCalled();
	});
});
