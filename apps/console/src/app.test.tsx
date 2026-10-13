import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./app";
import { readRuntime, type Runtime } from "@/client/create-client";
import { ACTING_AS } from "@/config";

const runtime: Runtime = { mock: true, scenario: "notifications", start: "seeded", drip: false, controls: true };

async function next(user: ReturnType<typeof userEvent.setup>, times: number) {
	for (let i = 0; i < times; i++) {
		const button = await screen.findByRole("button", { name: "Next beat" });
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await waitFor(() => expect(screen.getByRole("button", { name: "Next beat" })).toBeEnabled());
	}
}

describe("the console, mock-driven end to end", () => {
	it("always labels the demo identity, and says the data is a replay", async () => {
		render(<App runtime={runtime} />);
		expect(ACTING_AS).toBe("Acting as: Decision owner (demo identity)");
		expect(screen.getByTestId("acting-as")).toHaveTextContent("Acting as: Decision owner (demo identity)");
		expect(screen.getByText("Mock · replay")).toBeInTheDocument();
		expect(screen.getByRole("radiogroup", { name: "Scenario" })).toBeInTheDocument();
	});

	it("shows the one-screen layout: context, graph, inspector, activity and ledger", async () => {
		render(<App runtime={runtime} />);
		for (const name of ["Context timeline", "Work graph", "Inspector", "Agent activity", "Ledger tail"]) {
			expect(await screen.findByRole("region", { name })).toBeInTheDocument();
		}
	});

	it("walks the beats: both agents run, the decision changes, and WI-2 (only) turns stale", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 1);
		const graph = await screen.findByRole("region", { name: "Work graph" });
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-1 .*running/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-2 .*running/ })).toBeInTheDocument();

		await next(user, 3); // typo, draft, commit v2
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-2 .*stale/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-1 .*running/ })).toBeInTheDocument();

		const strip = await screen.findByTestId("results-strip");
		expect(strip).toHaveTextContent("2 items evaluated");
		expect(strip).toHaveTextContent("1 stale");
		expect(strip).toHaveTextContent("1 untouched");
		expect(strip).toHaveTextContent(/ms/);

		// The inspector follows the beat, and its default tab is the question.
		expect(await screen.findByRole("tab", { name: "Why is this blocked?" })).toHaveAttribute("aria-selected", "true");
		expect(await screen.findByTestId("promote-button")).toBeDisabled();
	});

	it("every status chip carries its label as text, not just a colour", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 5);
		await screen.findByRole("button", { name: /WI-2 .*conflict/ });
		const chips = document.querySelectorAll("[data-status]");
		expect(chips.length).toBeGreaterThan(0);
		for (const chip of chips) {
			if (chip.tagName === "BUTTON" || chip.getAttribute("data-slot") === "work-item-node") continue;
			expect((chip.textContent ?? "").trim()).toBe(chip.getAttribute("data-status"));
		}
	});

	it("keeps Northwind Sales Ops out of the switcher, but opens it from ?scenario=sales-ops on the same screen", async () => {
		const user = userEvent.setup();
		const { unmount } = render(<App runtime={runtime} />);
		expect(screen.queryByRole("radio", { name: /Northwind/ })).toBeNull();
		unmount();
		render(<App runtime={{ ...runtime, scenario: "sales-ops" }} />);
		expect(screen.getByRole("radio", { name: /Northwind Sales Ops/ })).toBeInTheDocument();
		expect(await screen.findByRole("heading", { name: "qualified-lead" })).toBeInTheDocument();
		await next(user, 4);
		const graph = await screen.findByRole("region", { name: "Work graph" });
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-3 .*stale/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-4 .*stale/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-5 .*running/ })).toBeInTheDocument();
		expect(screen.getByTestId("results-strip")).toHaveTextContent("3 items evaluated");
	});

	it("switches to the Larkhaven County shelter scenario, and keeps the synthetic note in view", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		expect(screen.queryByTestId("scenario-note")).toBeNull();
		expect(screen.queryByRole("radio", { name: /Northwind/ })).toBeNull();
		await user.click(screen.getByRole("radio", { name: /Larkhaven County Shelter · knowledge work/ }));
		expect(await screen.findByRole("heading", { name: "shelter-intake-policy" })).toBeInTheDocument();
		expect(screen.getByTestId("scenario-note")).toHaveTextContent("Synthetic scenario. Not operational guidance.");
		await next(user, 4);
		const graph = await screen.findByRole("region", { name: "Work graph" });
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-1 .*stale/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-2 .*stale/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-3 .*stale/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-4 .*running/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-5 .*running/ })).toBeInTheDocument();
		expect(screen.getByTestId("results-strip")).toHaveTextContent("5 items evaluated");
		// The negative controls read as deliberate: the reason code is on the node, and stays when their drafts arrive.
		for (const id of ["WI-4", "WI-5"]) expect(within(graph).getByTestId(`left-alone-${id}`)).toHaveTextContent("NO_DEPENDENCY_ON_CHANGED_FACETS");
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(within(graph).queryByTestId(`left-alone-${id}`)).toBeNull();
		await next(user, 1);
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-4 .*ready/ })).toBeInTheDocument());
		expect(within(graph).getByTestId("left-alone-WI-4")).toHaveTextContent("NO_DEPENDENCY_ON_CHANGED_FACETS");
		await user.click(screen.getByRole("radio", { name: /Notifications/ }));
		expect(await screen.findByRole("heading", { name: "notifications" })).toBeInTheDocument();
		expect(screen.queryByTestId("scenario-note")).toBeNull();
	});

	it("starts empty on request, with the first-decision prompt and a one-click seed", async () => {
		render(<App runtime={{ ...runtime, start: "empty" }} />);
		expect(await screen.findByText("No accepted context yet. Declare the first decision.")).toBeInTheDocument();
	});

	it("toggles between light and dark themes", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		const before = document.documentElement.classList.contains("dark");
		await user.click(screen.getByRole("button", { name: /Switch to (dark|light) theme/ }));
		expect(document.documentElement.classList.contains("dark")).toBe(!before);
		await user.click(screen.getByRole("button", { name: /Switch to (dark|light) theme/ }));
		expect(document.documentElement.classList.contains("dark")).toBe(before);
	});
});

describe("choosing the mock or the live client", () => {
	it("?mock=1 selects the mock; otherwise the live client", () => {
		expect(readRuntime("?mock=1", {}).mock).toBe(true);
		expect(readRuntime("", { VITE_MOCK: "1" }).mock).toBe(true);
		expect(readRuntime("", {}).mock).toBe(false);
		expect(readRuntime("?mock=1&scenario=sales-ops&start=empty", {})).toMatchObject({ scenario: "sales-ops", start: "empty" });
		expect(readRuntime("?mock=1&scenario=shelter-intake", {})).toMatchObject({ scenario: "shelter-intake" });
		expect(readRuntime("?scenario=nope", {}).scenario).toBe("notifications");
	});

	it("live mode opens a named cell with ?cell=, and the scenario is read from its prefix", () => {
		expect(readRuntime("?cell=notifications-demo", {})).toMatchObject({ mock: false, scenario: "notifications", cell: "notifications-demo" });
		expect(readRuntime("?cell=shelter-intake-take-2", {})).toMatchObject({ scenario: "shelter-intake", cell: "shelter-intake-take-2" });
		expect(readRuntime("?cell=sales-ops-1", {})).toMatchObject({ scenario: "sales-ops", cell: "sales-ops-1" });
		// The name decides the scenario, whatever ?scenario= says.
		expect(readRuntime("?cell=notifications-demo&scenario=sales-ops", {})).toMatchObject({ scenario: "notifications", cell: "notifications-demo" });
		expect(readRuntime("?cell=notifications-" + "a".repeat(26), {}).cell).toHaveLength(40);
	});

	it("?cell= is checked strictly; anything else is ignored and the default cell opens", () => {
		const rejected = [
			"notifications", // the scenario's own name is the default, not a named cell
			"notifications-", // nothing after the prefix
			"demo", // no known scenario prefix
			"my-notifications-demo",
			"Notifications-Demo", // uppercase
			"notifications-de_mo",
			"notifications-de.mo",
			"notifications-demo/../x",
			"notifications-demo%2F..",
			"notifications-demo?x=1",
			" notifications-demo",
			"notifications-" + "a".repeat(27), // 41 characters
			"delta-convergence-build-1", // the build replay is mock only
			"-notifications-demo",
			"",
		];
		for (const cell of rejected) {
			const runtime = readRuntime(`?cell=${encodeURIComponent(cell)}`, {});
			expect(runtime.cell, JSON.stringify(cell)).toBeUndefined();
			expect(runtime.scenario, JSON.stringify(cell)).toBe("notifications");
		}
		// The mock has no cells.
		expect(readRuntime("?mock=1&cell=notifications-demo", {})).toMatchObject({ mock: true, scenario: "notifications" });
		expect(readRuntime("?mock=1&cell=notifications-demo", {}).cell).toBeUndefined();
	});
});
