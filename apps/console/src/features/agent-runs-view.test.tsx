import { render, screen, waitFor, within } from "@testing-library/react";
import type { AgentActivity } from "contracts";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentRunSummary, ConsoleClient } from "@/client/types";
import { createMockClient } from "@/mock/client";
import { ConsoleProvider, useConsole } from "@/state/console-context";
import { BottomStrip } from "./bottom-strip";
import { Inspector } from "./inspector";

const t = (s: number) => `2026-10-14T15:00:${String(s).padStart(2, "0")}.000Z`;
const line = (workItemId: string, s: number, text: string): AgentActivity => ({ type: "agent-activity", workItemId, runId: `run-${workItemId}`, kind: "tool", text, ts: t(s) });

/** The model is not on the mock's ledger, as on the live Worker: only the run read after the fact names it. */
function withoutModels<T>(message: T): T {
	return JSON.parse(JSON.stringify(message), (key, value) => (key === "model" ? undefined : value)) as T;
}

/** The mock, dressed as the live client: it answers `agentRuns` and never streams a line of its own. */
function liveLike(agentRuns: ConsoleClient["api"]["agentRuns"]): ConsoleClient {
	const mock = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null });
	return {
		...mock,
		kind: "live",
		connect: (handlers) => mock.connect({ ...handlers, onMessage: (message) => message.type !== "agent-activity" && handlers.onMessage(withoutModels(message)) }),
		api: { ...mock.api, agentRuns },
	} as ConsoleClient;
}

function Selected({ id }: { id: string }) {
	const { select, selectedId, view } = useConsole();
	const known = view.workItems[id] !== undefined;
	useEffect(() => {
		if (known) select(id);
	}, [known, id, select]);
	return selectedId ? <Inspector /> : null;
}

describe("a staged cell opened after its agents ran", () => {
	it("shows both agents' stream, interleaved, with each model, and the model on the work item", async () => {
		const agentRuns = vi.fn<ConsoleClient["api"]["agentRuns"]>(async (items): Promise<AgentRunSummary[]> => {
			return items.map((i) =>
				i.id === "WI-1"
					? { workItemId: "WI-1", model: "anthropic/claude-sonnet-5.5", activity: [line("WI-1", 1, "first from one"), line("WI-1", 4, "last from one")] }
					: { workItemId: i.id, model: "openai/gpt-6-luna", activity: [line(i.id, 2, "first from two"), line(i.id, 3, "second from two")] },
			);
		});
		const client = liveLike(agentRuns);
		render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={client} flushMs={1}>
					<Selected id="WI-2" />
					<BottomStrip />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		await waitFor(() => expect(client.kind).toBe("live"));
		const state = (client as unknown as ReturnType<typeof createMockClient>).controls;
		await waitFor(() => expect(state.getState().ready).toBe(true));
		await state.jump(1); // the agents start: work items with forks and heads

		const stream = await screen.findByRole("log");
		await waitFor(() => expect(within(stream).getAllByText(/from (one|two)/)).toHaveLength(4));
		expect(screen.getByText("4 lines")).toBeInTheDocument();
		expect(within(stream).getAllByText(/from (one|two)/).map((el) => el.textContent)).toEqual(["first from one", "first from two", "second from two", "last from one"]);
		expect(within(stream).getAllByText("anthropic/claude-sonnet-5.5").length).toBeGreaterThan(0);
		expect(within(stream).getAllByText("openai/gpt-6-luna").length).toBeGreaterThan(0);
		// The inspector's chip says the model too, not the work item's name.
		const inspector = await screen.findByTestId("inspector");
		expect(within(inspector).getByText("openai/gpt-6-luna")).toBeInTheDocument();
	});

	it("asks about the work items with their forks, and a read that fails leaves the stream empty, not broken", async () => {
		const agentRuns = vi.fn<ConsoleClient["api"]["agentRuns"]>(async () => {
			throw new Error("offline");
		});
		const client = liveLike(agentRuns);
		render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={client} flushMs={1}>
					<BottomStrip />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		const controls = (client as unknown as ReturnType<typeof createMockClient>).controls;
		await waitFor(() => expect(controls.getState().ready).toBe(true));
		await controls.jump(1);
		await waitFor(() => expect(agentRuns).toHaveBeenCalled());
		for (const [items] of agentRuns.mock.calls) expect(items.every((i) => /^WI-\d+$/.test(i.id) && i.forkRepo.length > 0)).toBe(true);
		expect(screen.getByText("0 lines")).toBeInTheDocument();
		expect(screen.getByText(/No agent output yet/)).toBeInTheDocument();
	});
});
