import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import type { ConsoleClient, ConsoleMessage } from "@/client/types";
import { DegradedContext, StatusChip } from "@/components/status";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createMockClient } from "@/mock/client";
import { ConsoleProvider, useConsole } from "@/state/console-context";
import { renderWithMock } from "@/test/render";
import { ExceptionForm } from "./inspector-actions";
import { Inspector } from "./inspector";

describe("work that is ready to merge under an accepted exception", () => {
	it.each([
		["shelter-intake", "WI-2", "signs/door.md"],
		["sales-ops", "WI-3", "reports/q4-forecast.md"],
	] as const)("is not told it is blocked: %s %s shows a neutral line naming the signer and scope, and no Revalidate or exception", async (scenario, id, scope) => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario, beats: 6, select: id });
		const line = await screen.findByTestId("passes-with-exception");
		const card = screen.getByTestId("reason-card");
		expect(screen.getByTestId("inspector").querySelector("[data-status]")).toHaveAttribute("data-status", "ready");
		expect(within(card).queryByRole("heading", { name: "Why is this blocked?" })).toBeNull();
		expect(within(card).getByRole("heading", { name: "Merge status" })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "Why is this blocked?" })).toBeNull();
		expect(line).toHaveTextContent("Passes with an accepted exception from Decision owner (demo identity)");
		expect(line).toHaveTextContent(scope);
		expect(within(card).queryByTestId("not-a-verdict")).toBeNull();
		expect(within(card).queryByTestId("signoff")).toBeNull();
		expect(screen.queryByTestId("resolve-actions")).toBeNull();

		// The Actions tab keeps Reject, and drops what has no job on ready work.
		await user.click(screen.getByRole("tab", { name: "Actions" }));
		const actions = await screen.findByTestId("resolve-actions");
		expect(within(actions).getByRole("button", { name: "Reject" })).toBeInTheDocument();
		expect(within(actions).queryByRole("button", { name: "Revalidate" })).toBeNull();
		expect(within(actions).queryByRole("button", { name: /Accept exception/ })).toBeNull();
	});

	it("still reads Blocked, with the card and the actions, before the exception is granted", async () => {
		await renderWithMock(<Inspector />, { scenario: "shelter-intake", beats: 5, select: "WI-2" });
		const card = await screen.findByTestId("reason-card");
		expect(within(card).getByRole("heading", { name: "Why is this blocked?" })).toBeInTheDocument();
		expect(within(card).getByTestId("resolve-actions")).toBeInTheDocument();
		expect(screen.queryByTestId("passes-with-exception")).toBeNull();
	});
});

describe("the exception form says what stays blocked", () => {
	const base = { recordId: "notifications", lifts: true, check: "tests/contract/notifications.test.ts", checkState: "failing" as const, signer: "Decision owner (demo identity)", otherBlocks: [], wouldPass: true };

	it("lifts nothing on a record the work is not stale or in conflict against", () => {
		render(<ExceptionForm candidates={["status-model"]} waivers={{ "status-model": { ...base, recordId: "status-model", lifts: false, check: null, checkState: null, otherBlocks: ["No passing evidence at the current head for: x."], wouldPass: false } }} busy={false} onCancel={() => {}} onSubmit={() => {}} />);
		const terms = screen.getByTestId("exception-terms");
		expect(terms).toHaveTextContent("Lifts the block from status-model only.");
		expect(terms).toHaveTextContent("so an exception on it lifts nothing");
		expect(screen.queryByTestId("exception-waived-check")).toBeNull();
		expect(screen.getByTestId("exception-other-blocks")).toHaveTextContent("Other blocks stay:");
		expect(screen.getByTestId("exception-dry-run")).toHaveTextContent("would still be closed");
	});

	it.each([
		["failing", "currently failing"],
		["passing", "passing now"],
		["not-run", "not run at this head yet"],
	] as const)("names the check as %s", (checkState, words) => {
		render(<ExceptionForm candidates={["notifications"]} waivers={{ notifications: { ...base, checkState } }} busy={false} onCancel={() => {}} onSubmit={() => {}} />);
		expect(screen.getByTestId("exception-waived-check")).toHaveTextContent(`notifications.test.ts, ${words}`);
		expect(screen.getByTestId("exception-waived-check")).toHaveAttribute("data-check-state", checkState);
	});

	it("lists the other blocks that stay", () => {
		render(
			<ExceptionForm
				candidates={["notifications"]}
				waivers={{ notifications: { ...base, otherBlocks: ["This fork changes accepted context (context/x.md). Propose that change on the baseline instead."], wouldPass: false } }}
				busy={false}
				onCancel={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(screen.getByTestId("exception-other-blocks")).toHaveTextContent("This fork changes accepted context");
		expect(screen.getByTestId("exception-dry-run")).toHaveTextContent("With this exception the gate would still be closed.");
	});
});

describe("when the re-runs are used up", () => {
	function withMaxRevalidations(max: number): ConsoleClient {
		const client = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null });
		const rewrite = (message: ConsoleMessage): ConsoleMessage => (message.type === "snapshot" ? { ...message, snapshot: { ...message.snapshot, policy: { ...message.snapshot.policy, maxRevalidations: max } } } : message);
		return { ...client, connect: (handlers) => client.connect({ ...handlers, onMessage: (message) => handlers.onMessage(rewrite(message)) }) };
	}

	function Select({ id }: { id: string }) {
		const { select, selectedId, view } = useConsole();
		useEffect(() => {
			if (selectedId !== id && view.workItems[id]) select(id);
		}, [id, selectedId, view.workItems, select]);
		return null;
	}

	it("says a reviewer has to decide, not that the agent will be sent back", async () => {
		const user = userEvent.setup();
		const client = withMaxRevalidations(1) as ReturnType<typeof createMockClient>;
		render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={client} flushMs={1}>
					<Select id="WI-2" />
					<Inspector />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		await waitFor(() => expect(client.controls.getState().ready).toBe(true));
		await client.controls.jump(5);
		await waitFor(() => expect(client.controls.getState().busy).toBe(false));
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		expect(await screen.findByTestId("resolve-actions")).toHaveTextContent("Uses 1 of 1 re-runs.");

		await user.click(await screen.findByTestId("revalidate-button"));
		await user.click(await screen.findByTestId("revalidate-confirm"));
		await waitFor(() => expect(screen.getByTestId("resolve-actions")).toHaveTextContent("All 1 re-runs are used. A reviewer has to decide what happens to this work (REVALIDATION_LIMIT)."));
		expect(screen.getByTestId("resolve-actions")).not.toHaveTextContent("Sends the agent back");
	});
});

describe("Left alone is not claimed while the poller is degraded", () => {
	it("shows a running item that the change left alone as Agent working, since unknown is not unaffected", () => {
		const { rerender } = render(<StatusChip status="running" leftAlone />);
		expect(screen.getByText("Left alone")).toBeInTheDocument();
		rerender(
			<DegradedContext.Provider value>
				<StatusChip status="running" leftAlone />
			</DegradedContext.Provider>,
		);
		expect(screen.queryByText("Left alone")).toBeNull();
		expect(screen.getByText("Agent working")).toBeInTheDocument();
	});
});
