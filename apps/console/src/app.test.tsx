import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./app";
import { readRuntime, type Runtime } from "@/client/create-client";
import { STATUS_META } from "@/components/status";
import { ACTING_AS } from "@/config";

const runtime: Runtime = { mock: true, scenario: "notifications", start: "seeded", drip: false, controls: true };

async function next(user: ReturnType<typeof userEvent.setup>, times: number) {
	for (let i = 0; i < times; i++) {
		const button = await screen.findByRole("button", { name: "Next step" });
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await waitFor(() => expect(screen.getByRole("button", { name: "Next step" })).toBeEnabled());
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
		for (const name of ["Decisions", "Work graph", "Selected work", "Agents at work", "Audit log"]) {
			expect(await screen.findByRole("region", { name })).toBeInTheDocument();
		}
	});

	it("walks the beats: both agents run, the decision changes, and WI-2 (only) turns stale", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 1);
		const graph = await screen.findByRole("region", { name: "Work graph" });
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-1 .*Agent working/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-2 .*Agent working/ })).toBeInTheDocument();

		await next(user, 3); // typo, draft, commit v2
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-2 .*Blocked/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-1 .*Left alone/ })).toBeInTheDocument();

		const strip = await screen.findByTestId("results-strip");
		expect(strip).toHaveAttribute("title", expect.stringContaining("2 items checked"));
		expect(strip).toHaveTextContent("1 blocked");
		expect(strip).toHaveTextContent("1 left alone");
		expect(strip.getAttribute("title")).toMatch(/ ms\./);

		// The inspector follows the beat, and its default tab is the question.
		expect(await screen.findByRole("tab", { name: "Why blocked?" })).toHaveAttribute("aria-selected", "true");
		expect(await screen.findByTestId("promote-button")).toBeDisabled();
	});

	it("every status chip carries its label as text, not just a colour", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 5);
		await screen.findByRole("button", { name: /WI-2 .*Blocked/ });
		const chips = document.querySelectorAll("[data-status]");
		expect(chips.length).toBeGreaterThan(0);
		for (const chip of chips) {
			if (chip.tagName === "BUTTON" || chip.getAttribute("data-slot") === "work-item-node") continue;
			// The word on the chip: the status's own label, or "Left alone" for work the last change did not touch.
			const status = chip.getAttribute("data-status") as keyof typeof STATUS_META;
			const text = (chip.textContent ?? "").trim();
			// "Left alone" is only ever on a running item.
			// "Ready · exception" is only ever on a ready item, marked data-excepted.
			if (chip.hasAttribute("data-excepted")) {
				expect(status).toBe("ready");
				expect(text).toBe("Ready · exception");
				continue;
			}
			expect(text === "Left alone" ? status : text).toBe(text === "Left alone" ? "running" : STATUS_META[status].label);
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
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-3 .*Blocked/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-4 .*Blocked/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-5 .*Left alone/ })).toBeInTheDocument();
		expect(screen.getByTestId("results-strip")).toHaveAttribute("title", expect.stringContaining("3 items checked"));
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
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-1 .*Blocked/ })).toBeInTheDocument());
		expect(within(graph).getByRole("button", { name: /WI-2 .*Blocked/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-3 .*Blocked/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-4 .*Left alone/ })).toBeInTheDocument();
		expect(within(graph).getByRole("button", { name: /WI-5 .*Left alone/ })).toBeInTheDocument();
		expect(screen.getByTestId("results-strip")).toHaveAttribute("title", expect.stringContaining("5 items checked"));
		// The negative controls read as deliberate: "Left alone" is on the node (the reason code is its tooltip), and stays when their drafts arrive.
		for (const id of ["WI-4", "WI-5"]) {
			expect(within(graph).getByTestId(`left-alone-${id}`)).toHaveTextContent("Left alone: no recorded dependency on what changed");
			expect(within(graph).getByTestId(`left-alone-${id}`).getAttribute("title")).toContain("NO_DEPENDENCY_ON_CHANGED_FACETS");
		}
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(within(graph).queryByTestId(`left-alone-${id}`)).toBeNull();
		await next(user, 1);
		await waitFor(() => expect(within(graph).getByRole("button", { name: /WI-4 .*Ready/ })).toBeInTheDocument());
		expect(within(graph).getByTestId("left-alone-WI-4")).toHaveTextContent("Left alone");
		await user.click(screen.getByRole("radio", { name: /Notifications/ }));
		expect(await screen.findByRole("heading", { name: "notifications" })).toBeInTheDocument();
		expect(screen.queryByTestId("scenario-note")).toBeNull();
	});

	it("starts empty on request, with the first-decision prompt and a one-click seed", async () => {
		render(<App runtime={{ ...runtime, start: "empty" }} />);
		expect(await screen.findByText("No decisions yet. Declare the first one.")).toBeInTheDocument();
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
		// Our own build, live. In the mock the same scenario is the replay and takes no cell.
		expect(readRuntime("?cell=delta-convergence-build-live", {})).toMatchObject({ mock: false, scenario: "delta-convergence-build", cell: "delta-convergence-build-live" });
		expect(readRuntime("?scenario=delta-convergence-build", {}).scenario).toBe("notifications");
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
			"delta-convergence-build", // no suffix: that is the replay's name, not a named cell
			"delta-convergence-build-", // nothing after the prefix
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
