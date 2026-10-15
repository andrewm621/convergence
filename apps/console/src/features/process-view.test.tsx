import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "@/app";
import type { Runtime } from "@/client/create-client";

const runtime: Runtime = { mock: true, scenario: "notifications", start: "seeded", drip: false, controls: true };

async function next(user: ReturnType<typeof userEvent.setup>, times: number) {
	for (let i = 0; i < times; i++) {
		const button = await screen.findByRole("button", { name: "Next step" });
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await waitFor(() => expect(screen.getByRole("button", { name: "Next step" })).toBeEnabled());
	}
}

describe("the Process view", () => {
	it("is offered next to Work and Map, and the console still opens on Work", async () => {
		render(<App runtime={runtime} />);
		const views = await screen.findByRole("radiogroup", { name: "View" });
		expect(within(views).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Work", "Map", "Process"]);
		expect(within(views).getByRole("radio", { name: "Work" })).toBeChecked();
		expect(await screen.findByRole("region", { name: "Home" })).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Process" })).toBeNull();
	});

	it("says so plainly before any agent has run", async () => {
		const user = userEvent.setup();
		render(<App runtime={{ ...runtime, start: "empty" }} />);
		await user.click(await screen.findByRole("radio", { name: "Process" }));
		expect(await screen.findByTestId("process-empty")).toHaveTextContent("No agent activity yet.");
	});

	it("draws the lanes, follows the replay, and leaves Work and Map as they were", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 1);
		await user.click(screen.getByRole("radio", { name: "Process" }));
		const view = await screen.findByRole("region", { name: "Process" });
		expect(view).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Process" })).toBeChecked();
		// The Work view's panes and the graph are not mounted behind it.
		expect(screen.queryByRole("region", { name: "Home" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Work graph" })).toBeNull();
		expect(within(view).getAllByTestId("process-lane")).toHaveLength(2);
		expect(screen.queryByTestId("decision-line")).toBeNull();

		// Typo, draft, then the decision lands: one line across the lanes, and only WI-2 goes red.
		await next(user, 3);
		await waitFor(() => expect(screen.getByTestId("decision-line")).toBeInTheDocument());
		expect(screen.getByTestId("decision-label")).toHaveTextContent("notifications v1 → v2");
		const lane = (id: string) => within(view).getAllByTestId("process-lane").find((l) => l.getAttribute("data-work-item") === id) as HTMLElement;
		expect(within(lane("WI-2")).getByRole("button", { name: /went stale/ })).toHaveAttribute("data-tone", "danger");
		expect(within(lane("WI-1")).getByRole("button", { name: /not affected/ })).toHaveAttribute("data-tone", "muted");
		expect(within(lane("WI-1")).queryByRole("button", { name: /stale|conflict/ })).toBeNull();

		// A mark is a button: focusable, and it names the ledger line behind it.
		const stale = within(lane("WI-2")).getByRole("button", { name: /went stale/ });
		expect(stale).toHaveAccessibleName(/Ledger line \d+, BaselinePushed/);
		stale.focus();
		expect(await screen.findByRole("tooltip")).toHaveTextContent(/BaselinePushed · #\d+ · [0-9a-f]{7}/);

		await user.click(screen.getByRole("radio", { name: "Map" }));
		expect(await screen.findByRole("region", { name: "Work graph" })).toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "Process" })).toBeNull();
		await user.click(screen.getByRole("radio", { name: "Work" }));
		expect(await screen.findByRole("region", { name: "Agents at work" })).toBeInTheDocument();
	});
});
