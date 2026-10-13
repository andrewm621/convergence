import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ScenarioName } from "@/client/types";
import { renderWithMock } from "@/test/render";
import { ContextTimeline } from "./context-timeline";
import { ExceptionForm } from "./inspector-actions";
import { Inspector } from "./inspector";
import { DEFAULT_SCOPE_EXAMPLE, SCENARIO_META } from "./scenario-meta";
import { WorkGraph } from "./work-graph";

/** Words the main surface does not use. They stay in tooltips, reason codes, "Technical details", and code. */
const JARGON = /\b(stale|receipts?|facets?|records?|reconcil\w*|ledger|gate|prose|beat|promot\w*)\b/i;

/**
 * What a person reads: the text with reason-code chips, the "Technical details" fold and the engine's own condition messages taken out.
 * Those messages are written in delta-core ("The receipt matches the accepted facets..."), which this pass does not touch. Tooltips are attributes, so they are not text.
 */
function readable(root: HTMLElement): string {
	const copy = root.cloneNode(true) as HTMLElement;
	for (const hidden of copy.querySelectorAll("[data-reason], [data-testid='technical-details'], [data-condition] p, .sr-only")) hidden.remove();
	return copy.textContent ?? "";
}

describe("the inspector's tabs fit a 480 px pane", () => {
	it("names the five tabs in plain words, and none of them is set to stay on one line and clip", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const tabs = await screen.findAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual(["Why blocked?", "What it was given", "Claims vs decision", "Changes", "Actions"]);
		for (const tab of tabs) {
			expect(tab.className).toContain("whitespace-normal");
			expect(tab.className).not.toContain("whitespace-nowrap");
			expect(tab.className).toContain("flex-1");
		}
		expect(tabs[0]?.getAttribute("data-slot")).toBe("tabs-trigger");
	});

	it("says Why, not Why blocked?, for work that is not blocked", async () => {
		await renderWithMock(<Inspector />, { beats: 1, select: "WI-1" });
		expect((await screen.findAllByRole("tab")).map((tab) => tab.textContent)[0]).toBe("Why");
	});

	it("is headed by the selected work's own title, which shortens rather than widening the pane", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const body = await screen.findByTestId("inspector");
		const title = within(body).getByRole("heading", { level: 2 }).textContent ?? "";
		expect(title.length).toBeGreaterThan(0);
		const pane = screen.getByRole("region", { name: "Selected work" });
		const heading = within(pane).getAllByRole("heading", { level: 2 })[0] as HTMLElement;
		expect(heading.textContent).toBe(title);
		expect(heading.className).toContain("truncate");
		expect(heading.getAttribute("title")).toBe(title);
		expect(document.body.textContent).not.toMatch(/nspector/);
	});

	it("is headed Work item, with nothing named Inspector, before anything is selected", async () => {
		await renderWithMock(<Inspector />, { beats: 1 });
		expect(await screen.findByRole("heading", { level: 2, name: "Work item" })).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/inspector/i);
	});
});

describe("what the exception form asks for", () => {
	it.each([
		["notifications", "e.g. src/notifications/delivery.ts"],
		["shelter-intake", "e.g. the printed door signs only"],
		["sales-ops", "e.g. reports/q4-forecast.md"],
	] as const)("gives the %s scenario its own example of what an exception covers", (scenario, example) => {
		expect(SCENARIO_META[scenario as ScenarioName].scopeExample).toBe(example);
	});

	it("uses the scenario's example as the placeholder, and a neutral one when it has none", () => {
		const { rerender } = renderExceptionForm("e.g. the printed door signs only");
		expect(screen.getByLabelText("What it covers")).toHaveAttribute("placeholder", "e.g. the printed door signs only");
		rerender(<ExceptionForm candidates={["a"]} busy={false} onCancel={() => {}} onSubmit={() => {}} />);
		expect(screen.getByLabelText("What it covers")).toHaveAttribute("placeholder", DEFAULT_SCOPE_EXAMPLE);
	});

	it("shows the open scenario's example in the live form on the Actions tab", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario: "shelter-intake", beats: 5, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByRole("button", { name: /Allow with exception/ }));
		expect(await screen.findByLabelText("What it covers")).toHaveAttribute("placeholder", "e.g. the printed door signs only");
	});
});

function renderExceptionForm(scopeExample: string) {
	return render(<ExceptionForm candidates={["a"]} busy={false} scopeExample={scopeExample} onCancel={() => {}} onSubmit={() => {}} />);
}

describe("the main surface keeps the operator's words out of sight", () => {
	const cases: Array<{ scenario: ScenarioName; beats: number; select: string }> = [
		{ scenario: "notifications", beats: 5, select: "WI-2" },
		{ scenario: "notifications", beats: 5, select: "WI-1" },
		{ scenario: "shelter-intake", beats: 9, select: "WI-2" },
		{ scenario: "shelter-intake", beats: 5, select: "WI-1" },
	];

	it.each(cases)("$scenario at step $beats, $select: panes, results strip and every inspector tab read plainly", async ({ scenario, beats, select }) => {
		const user = userEvent.setup();
		await renderWithMock(
			<>
				<ContextTimeline />
				<WorkGraph />
				<Inspector />
			</>,
			{ scenario, beats, select },
		);
		await screen.findByRole("tab", { name: "Actions" });
		const seen: string[] = [];
		for (const name of [/^Why/, "What it was given", "Claims vs decision", "Changes", "Actions"]) {
			await user.click(screen.getByRole("tab", { name }));
			const panel = await screen.findByRole("tabpanel");
			seen.push(readable(panel));
		}
		// The exception form, where it is offered, is read too.
		await user.click(screen.getByRole("tab", { name: "Actions" }));
		const allow = screen.queryByRole("button", { name: /Allow with exception/ });
		if (allow && !(allow as HTMLButtonElement).disabled) {
			await user.click(allow);
			seen.push(readable(await screen.findByRole("form", { name: "Allow with exception" })));
		}
		await user.click(screen.getByRole("tab", { name: /^Why/ }));
		for (const region of ["Decisions", "Work graph"]) seen.push(readable(await screen.findByRole("region", { name: region })));
		seen.push(readable(await screen.findByTestId("inspector")));
		const leaks = seen.flatMap((text) => [...text.matchAll(new RegExp(`.{0,40}${JARGON.source}.{0,30}`, "gi"))].map((m) => m[0]));
		expect(leaks).toEqual([]);
		await waitFor(() => expect(within(screen.getByRole("region", { name: "Work graph" })).getByTestId("results-strip")).toBeInTheDocument());
	}, 60000);
});
