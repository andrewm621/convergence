import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildDogfoodBuildScenario, type DogfoodBuildScenario } from "scenario-delta-convergence-build";
import { beforeAll, describe, expect, it } from "vitest";
import { App } from "@/app";
import type { Runtime } from "@/client/create-client";
import { SCENARIO_META } from "@/features/scenario-meta";
import { ContextTimeline } from "@/features/context-timeline";
import { Inspector } from "@/features/inspector";
import { WorkGraph } from "@/features/work-graph";
import { startMock } from "@/test/harness";
import { renderWithMock } from "@/test/render";
import type { ViewState } from "@/state/store";

const SCENARIO = "delta-convergence-build" as const;
const ALL = ["WI-1", "WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"];
const ZERO_SHA = "0000000000000000000000000000000000000000";

let bundle: DogfoodBuildScenario;
beforeAll(async () => {
	bundle = await buildDogfoodBuildScenario();
});

function staleFacets(view: ViewState, id: string): string[] | undefined {
	return view.workItems[id]?.conditions.find((c) => c.type === "Stale")?.facetKeys;
}

function staleIds(view: ViewState): string[] {
	return ALL.filter((id) => staleFacets(view, id) !== undefined);
}

const runtime: Runtime = { mock: true, scenario: SCENARIO, start: "seeded", drip: false, controls: true };

describe("the build replay: beats follow the fixture's timeline and the delta-core assertions", () => {
	it("has six beats, each with a plain caption, in commit order", async () => {
		const mock = await startMock({ scenario: SCENARIO });
		expect(mock.beats).toHaveLength(6);
		for (const beat of mock.beats) {
			expect(beat.title.length).toBeGreaterThan(0);
			expect(beat.caption.length).toBeGreaterThan(20);
		}
		expect(mock.beats.map((b) => b.caption)).toEqual(
			expect.arrayContaining([
				"Renamed the fictional county. Three pieces of our own work were built on the old name.",
				"Changed what counts as a contract test. The console PR was built on the old rule.",
			]),
		);
		expect(mock.beats.at(-1)?.caption).toMatch(/^A wording-only edit\. Nothing re-evaluated\./);
		mock.stop();
	});

	it("each beat leaves the stale and untouched sets that delta-core asserts", async () => {
		const mock = await startMock({ scenario: SCENARIO });
		expect(Object.keys(mock.view.workItems)).toEqual([]);

		// 1. Work begins: all seven registered, four have pushed. Nothing is stale.
		await mock.next();
		expect(Object.keys(mock.view.workItems).sort()).toEqual(ALL);
		for (const id of ["WI-3", "WI-4", "WI-5", "WI-6"]) expect(mock.view.workItems[id]?.headSha, id).toBe(bundle.forkHeads[id as "WI-3"]);
		for (const id of ["WI-1", "WI-2", "WI-7"]) expect(mock.view.workItems[id]?.headSha, id).toBeNull();
		expect(staleIds(mock.view)).toEqual([]);

		// 2. The county is renamed: WI-3, WI-4, WI-5 stale, the rest untouched.
		await mock.next();
		expect(staleIds(mock.view)).toEqual(["WI-3", "WI-4", "WI-5"]);
		for (const id of ["WI-3", "WI-4", "WI-5"]) expect(staleFacets(mock.view, id), id).toEqual(bundle.expected.afterNamingV2.stale[id as "WI-3"]);
		expect(mock.view.evaluation).toMatchObject({ evaluated: 7, stale: 3, alreadyStale: 0, untouched: 4, proseOnly: false });

		// 3. More work lands: WI-7, WI-1, WI-2 are pushed, and are clean.
		await mock.next();
		for (const id of ["WI-1", "WI-2", "WI-7"]) {
			expect(mock.view.workItems[id]?.headSha, id).toBe(bundle.forkHeads[id as "WI-1"]);
			expect(staleFacets(mock.view, id), id).toBeUndefined();
		}
		expect(staleIds(mock.view)).toEqual(["WI-3", "WI-4", "WI-5"]);

		// 4. Evidence v2: WI-1, WI-2, WI-3 go stale; WI-4 to WI-7 are untouched.
		await mock.next();
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(staleFacets(mock.view, id), id).toEqual(bundle.expected.afterEvidenceV2.stale[id as "WI-1"]);
		expect(staleIds(mock.view)).toEqual(["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]);
		for (const id of bundle.expected.afterEvidenceV2.untouched) expect(staleFacets(mock.view, id) ?? "untouched", id).toEqual(["WI-4", "WI-5"].includes(id) ? bundle.expected.afterNamingV2.stale[id as "WI-4"] : "untouched");
		// WI-4 and WI-5 are untouched by this change but already red from the rename: they are counted apart, so the strip adds up to the cards.
		expect(mock.view.evaluation).toMatchObject({ evaluated: 7, stale: 3, alreadyStale: 2, untouched: 2 });
		expect((mock.view.evaluation?.stale ?? 0) + (mock.view.evaluation?.alreadyStale ?? 0)).toBe(staleIds(mock.view).length);

		// 5. Evidence v3: WI-1 gains required-facets, and nothing else does.
		await mock.next();
		for (const id of ["WI-1", "WI-2", "WI-3"]) expect(staleFacets(mock.view, id), id).toEqual(bundle.expected.afterEvidenceV3.stale[id as "WI-1"]);
		expect(ALL.filter((id) => staleFacets(mock.view, id)?.includes("evidence.required-facets"))).toEqual(["WI-1"]);

		// 6. The invented wording edit: PROSE_ONLY, nothing re-evaluated.
		const before = structuredClone(mock.view.workItems);
		await mock.next();
		expect(mock.view.ledger.at(-1)?.payload.effects.flatMap((e) => e.reasonCodes)).toEqual(["PROSE_ONLY"]);
		expect(mock.view.evaluation?.proseOnly).toBe(true);
		expect(mock.view.workItems).toEqual(before);

		// 7. WI-7 never went stale, and its record never moved.
		expect(mock.view.workItems["WI-7"]?.conditions.some((c) => c.type === "Stale")).toBe(false);
		expect(mock.view.records["demo-identity"]?.current).toBe(1);
		mock.stop();
	});

	it("keeps the commits' own timestamps in the ledger, in order", async () => {
		const mock = await startMock({ scenario: SCENARIO });
		await mock.next(6);
		const times = mock.view.ledger.map((entry) => entry.payload.event.ts);
		expect(times).toEqual(bundle.timeline.map((step) => step.ts));
		expect([...times].sort()).toEqual(times);
		const rename = mock.view.ledger.find((entry) => entry.payload.event.type === "BaselinePushed");
		expect(rename?.payload.event.ts).toBe("2026-10-13T03:27:43Z");
		mock.stop();
	});

	it("going back replays from the start and lands on the same state", async () => {
		const mock = await startMock({ scenario: SCENARIO });
		await mock.next(4);
		const four = structuredClone((await mock.client.api.gate("WI-1")).reasonCodes);
		await mock.next();
		await mock.prev();
		expect((await mock.client.api.gate("WI-1")).reasonCodes).toEqual(four);
		expect(staleIds(mock.view)).toEqual(["WI-1", "WI-2", "WI-3", "WI-4", "WI-5"]);
		mock.stop();
	});
});

describe("the build replay: labelling", () => {
	it("shows the retrofit banner, the Mock · replay badge, and the scenario in the switcher", async () => {
		render(<App runtime={runtime} />);
		const note = await screen.findByTestId("scenario-note");
		expect(note).toHaveTextContent("Retrofitted from this repo's git history. Decisions made before Convergence was recording them; dependencies declared by us; humans resolve.");
		expect(screen.getByText("Mock · replay")).toBeInTheDocument();
		const switcher = screen.getByRole("radiogroup", { name: "Scenario" });
		expect(within(switcher).getByRole("radio", { name: /Our own build \(replay\)/ })).toBeChecked();
		// Unlike Northwind Sales Ops, it is always offered.
		expect(within(switcher).queryByRole("radio", { name: /Northwind/ })).toBeNull();
		expect(SCENARIO_META[SCENARIO].hidden).toBeUndefined();
	});

	it("is offered while another scenario is open", async () => {
		render(<App runtime={{ ...runtime, scenario: "notifications" }} />);
		const switcher = await screen.findByRole("radiogroup", { name: "Scenario" });
		expect(within(switcher).getByRole("radio", { name: /Our own build \(replay\)/ })).not.toBeChecked();
	});

	it("never uses bare Delta as the product name anywhere a person reads", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		for (let i = 0; i < 6; i++) {
			await waitFor(() => expect(screen.getByRole("button", { name: "Next step" })).toBeEnabled(), { timeout: 8000 });
			await user.click(screen.getByRole("button", { name: "Next step" }));
			// After the last beat the button stays disabled; every earlier one re-enables when the beat has played.
			if (i < 5) await waitFor(() => expect(screen.getByRole("button", { name: "Next step" })).toBeEnabled(), { timeout: 8000 });
		}
		await waitFor(() => expect(screen.getByRole("button", { name: "Next step" })).toBeDisabled(), { timeout: 8000 });
		// The audit log says it in plain words and keeps the code in data-reason.
		await waitFor(() => expect(document.querySelector("[data-reason='PROSE_ONLY']")).toHaveTextContent("Wording only"), { timeout: 8000 });
		// The replayed v1 naming record still says "Delta Convergence": that is history, not the product's current name.
		expect(document.body.textContent ?? "").not.toMatch(/\bDelta\b(?! Convergence)/);
	});

	it("shows the real work labels and 'recorded build session' where a model name would be, never 'stub agent'", async () => {
		const harness = await renderWithMock(<WorkGraph />, { scenario: SCENARIO, beats: 3 });
		const graph = await screen.findByRole("region", { name: "Work graph" });
		await waitFor(() => expect(within(graph).getByText("M4 revalidate loop (PR #6)")).toBeInTheDocument());
		for (const label of ["Console evidence labels (PR #7)", "Video script", "Shelter fixtures (PR #4)", "Shared brief (Notion; not in git)", "README", "Console identity header"]) {
			expect(within(graph).getByText(label)).toBeInTheDocument();
		}
		expect(within(graph).getAllByText("recorded build session").length).toBeGreaterThanOrEqual(7);
		expect(graph.textContent).not.toMatch(/stub agent/i);
		harness.unmount();
	});
});

describe("the build replay: shas and actions", () => {
	it("links real shas to GitHub on the Receipt tab, in short form", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario: SCENARIO, beats: 3, select: "WI-1" });
		await user.click(await screen.findByRole("tab", { name: "What it was given" }));
		const tab = await screen.findByTestId("receipt-tab");
		const links = within(tab).getAllByTestId("commit-link");
		const hrefs = links.map((link) => link.getAttribute("href"));
		expect(hrefs).toContain(`https://github.com/andrewm621/convergence/commit/${bundle.commits.wi1Head}`);
		expect(hrefs).toContain(`https://github.com/andrewm621/convergence/commit/${bundle.commits.baselineV1}`);
		expect(links.some((link) => link.textContent?.startsWith("ce882f2"))).toBe(true);
		expect(links.every((link) => !/[0-9a-f]{20}/.test(link.textContent ?? ""))).toBe(true);
		expect(within(tab).queryByTestId("not-in-git")).toBeNull();
	});

	it("reads 'not in git' for the all-zero sha, on the Receipt and Changes tabs", async () => {
		expect(bundle.forkHeads["WI-5"]).toBe(ZERO_SHA);
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario: SCENARIO, beats: 1, select: "WI-5" });
		await user.click(await screen.findByRole("tab", { name: "What it was given" }));
		const receipt = await screen.findByTestId("receipt-tab");
		expect(within(receipt).getByTestId("not-in-git")).toHaveTextContent("not in git");
		expect(receipt.textContent).not.toContain("0000000");
		expect(within(receipt).queryAllByTestId("commit-link").every((link) => !link.getAttribute("href")?.endsWith(ZERO_SHA))).toBe(true);

		await user.click(await screen.findByRole("tab", { name: "Changes" }));
		const changes = await screen.findByTestId("changes-recorded");
		expect(within(changes).getByTestId("not-in-git")).toHaveTextContent("not in git");
		expect(changes).toHaveTextContent("nothing to open");
	});

	it("shows the commit on the Changes tab for work that is in git", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario: SCENARIO, beats: 1, select: "WI-4" });
		await user.click(await screen.findByRole("tab", { name: "Changes" }));
		const changes = await screen.findByTestId("changes-recorded");
		expect(within(changes).getByTestId("commit-link")).toHaveAttribute("href", `https://github.com/andrewm621/convergence/commit/${bundle.commits.wi4Head}`);
	});

	it("disables Revalidate, Allow with exception, Reject and Promote, and says why", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario: SCENARIO, beats: 4, select: "WI-1" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		const tab = await screen.findByTestId("actions-tab");
		for (const name of [/Revalidate/, /Allow with exception/, /Reject/]) expect(within(tab).getByRole("button", { name })).toBeDisabled();
		expect(within(tab).getByTestId("promote-button")).toBeDisabled();
		// The reason is on the page for anyone who cannot hover, and in the tooltip for anyone who can.
		expect(tab).toHaveTextContent("Resolved by a human outside the console in the real build.");
		await user.hover(within(tab).getAllByTestId("unavailable-action")[0] as HTMLElement);
		expect((await screen.findAllByText("Resolved by a human outside the console in the real build.")).length).toBeGreaterThan(0);
	});

	it("leaves Change this decision disabled on the decision cards", async () => {
		await renderWithMock(<ContextTimeline />, { scenario: SCENARIO, beats: 1 });
		const buttons = await screen.findAllByRole("button", { name: /Change this decision/ });
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) expect(button).toBeDisabled();
	});
});
