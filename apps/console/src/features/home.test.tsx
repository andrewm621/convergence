import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useConsole } from "@/state/console-context";
import type { Tray } from "@/state/trays";
import { renderWithMock } from "@/test/render";
import { Home } from "./home";

/** Words the main surface does not use (the same list as plain-words.test.tsx). */
const JARGON = /\b(stale|receipts?|facets?|records?|reconcil\w*|ledger|gate|prose|beat|promot\w*)\b/i;

function HomeHarness() {
	const [tray, setTray] = useState<Tray>("needs-you");
	const { selectedId } = useConsole();
	return (
		<>
			<Home tray={tray} onTray={setTray} />
			<output data-testid="selected">{selectedId ?? ""}</output>
		</>
	);
}

function readable(root: HTMLElement): string {
	const copy = root.cloneNode(true) as HTMLElement;
	for (const hidden of copy.querySelectorAll("[data-reason], .sr-only")) hidden.remove();
	return copy.textContent ?? "";
}

describe("the home trays", () => {
	it("says nothing needs you while both agents are working, and counts them", async () => {
		await renderWithMock(<HomeHarness />, { beats: 1 });
		await waitFor(() => expect(screen.getByTestId("tray-count-working")).toHaveTextContent("2"));
		expect(screen.getByTestId("tray-count-needs-you")).toHaveTextContent("0");
		expect(screen.getByTestId("empty-needs-you")).toHaveTextContent("Nothing needs you right now.");
	});

	it("moves WI-2 into Needs you when v2 lands, with the stamp as its reason line", async () => {
		await renderWithMock(<HomeHarness />, { beats: 4 });
		await waitFor(() => expect(screen.getByTestId("tray-count-needs-you")).toHaveTextContent("1"));
		const list = screen.getByRole("list", { name: "Needs you" });
		const row = within(list).getByRole("button", { name: /WI-2/ });
		expect(within(row).getByText("Blocked")).toBeInTheDocument();
		expect(screen.getByTestId("row-reason-WI-2")).toHaveTextContent("Built on notifications v1 · now v2");
	});

	it("keeps the results strip in the header", async () => {
		await renderWithMock(<HomeHarness />, { beats: 4 });
		await waitFor(() => expect(screen.getByTestId("results-strip")).toHaveTextContent("1 blocked"));
		expect(screen.getByTestId("results-strip")).toHaveTextContent("1 left alone");
	});

	it("shows WI-1 under Working as left alone", async () => {
		const user = userEvent.setup();
		await renderWithMock(<HomeHarness />, { beats: 4 });
		await user.click(screen.getByRole("tab", { name: /Working/ }));
		const list = await screen.findByRole("list", { name: "Working" });
		const row = within(list).getByRole("button", { name: /WI-1/ });
		expect(within(row).getByText("Left alone")).toBeInTheDocument();
		expect(screen.getByTestId("row-reason-WI-1")).toHaveTextContent("nothing it relies on changed");
	});

	it("opens a work item when its row is clicked", async () => {
		const user = userEvent.setup();
		await renderWithMock(<HomeHarness />, { beats: 4 });
		await user.click(within(await screen.findByRole("list", { name: "Needs you" })).getByRole("button", { name: /WI-2/ }));
		expect(screen.getByTestId("selected")).toHaveTextContent("WI-2");
	});

	it("ends with both in Merged, each saying who merged it", async () => {
		const user = userEvent.setup();
		const harness = await renderWithMock(<HomeHarness />, { beats: 0 });
		await harness.client.controls.jump(harness.client.controls.getState().beats.length);
		await waitFor(() => expect(screen.getByTestId("tray-count-merged")).toHaveTextContent("2"));
		await user.click(screen.getByRole("tab", { name: /Merged/ }));
		expect(await screen.findByTestId("row-reason-WI-1")).toHaveTextContent(/^Merged/);
	});

	it("labels synthetic fan-out work, and puts every item in a tray", async () => {
		const harness = await renderWithMock(<HomeHarness />, { script: "fanout" });
		await harness.client.controls.jump(harness.client.controls.getState().beats.length);
		expect(await screen.findByTestId("seeded-banner")).toHaveTextContent("Synthetic work items. No model is behind them.");
		expect(document.querySelectorAll("[data-tray]")).toHaveLength(4);
		const counts = ["needs-you", "working", "ready", "merged"].map((tray) => Number(screen.getByTestId(`tray-count-${tray}`).textContent));
		expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
	});

	it("offers to start the scenario when there are decisions but no work yet", async () => {
		await renderWithMock(<HomeHarness />);
		expect(await screen.findByTestId("start-agents")).toHaveTextContent("Agents work in parallel. Then a decision changes.");
	});

	it.each([
		{ scenario: "notifications" as const, beats: 5 },
		{ scenario: "shelter-intake" as const, beats: 6 },
	])("reads plainly: $scenario at step $beats, every tray", async ({ scenario, beats }) => {
		const user = userEvent.setup();
		await renderWithMock(<HomeHarness />, { scenario, beats });
		const seen: string[] = [];
		for (const name of [/Needs you/, /Working/, /Ready/, /Merged/]) {
			await user.click(screen.getByRole("tab", { name }));
			seen.push(readable(screen.getByTestId("home")));
		}
		const leaks = seen.flatMap((text) => [...text.matchAll(new RegExp(`.{0,40}${JARGON.source}.{0,30}`, "gi"))].map((m) => m[0]));
		expect(leaks).toEqual([]);
	});
});
