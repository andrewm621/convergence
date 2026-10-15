import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { whatIf } from "delta-core";
import { baselineFor } from "@/test/baseline-for";
import { renderWithMock } from "@/test/render";
import { useConsole } from "@/state/console-context";
import { toCellState, type ViewState } from "@/state/store";
import { ContextTimeline } from "./context-timeline";

let latest: ViewState | null = null;
function ViewProbe() {
	latest = useConsole().view;
	return null;
}

/** The shelter story with its five drafts running, the editor open, and the story's change typed in (crated pets, no ID requirement). */
async function openEditor() {
	const user = userEvent.setup();
	const mock = await renderWithMock(
		<>
			<ViewProbe />
			<ContextTimeline />
		</>,
		{ scenario: "shelter-intake", beats: 1 },
	);
	const card = (await screen.findByRole("heading", { name: "shelter-intake-policy" })).closest("article") as HTMLElement;
	await user.click(within(card).getByRole("button", { name: /Change this decision/ }));
	await screen.findByRole("form", { name: "Change shelter-intake-policy" });
	await setValue(user, "pets", "crated pets admitted, pet area in Hall B");
	await setValue(user, "id_required", "ID not listed as a requirement");
	return { user, mock };
}

async function hold(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
	await user.click(await screen.findByRole("button", { name: label }));
}

async function setValue(user: ReturnType<typeof userEvent.setup>, setting: string, value: string) {
	const field = screen.getByLabelText(`Value for ${setting}`);
	await user.clear(field);
	await user.type(field, value);
}

describe("compare alternatives", () => {
	it("shows the engine's own numbers for two shelter candidates", async () => {
		const { user } = await openEditor();
		await user.click(screen.getByRole("button", { name: "Compare alternatives" }));
		const panel = screen.getByTestId("compare-panel");
		expect(panel).toHaveTextContent("Preview only: nothing is saved or sent.");
		expect(panel).toHaveTextContent("known dependent work");
		expect(panel).toHaveTextContent("recorded dependencies");
		expect(panel).not.toHaveTextContent(/all affected work/i);

		// Option A: the story's change, as the editor was prefilled.
		await hold(user, /Hold this edit as Option A/);
		// Option B: put the two settings back and change the capacity note only.
		await setValue(user, "pets", "service animals only");
		await setValue(user, "id_required", "ID required");
		await setValue(user, "capacity_note", "Hall A holds 100 cots; the shift lead decides on overflow");
		await hold(user, /Hold this edit as Option B/);

		const options = await waitFor(() => {
			const found = screen.getAllByTestId("compare-option");
			expect(found).toHaveLength(2);
			found.forEach((el) => expect(el).toHaveAttribute("data-blocked"));
			return found;
		});

		// What the engine says, asked directly on events built a different way.
		const view = latest!;
		const state = toCellState(view);
		const v1 = state.records["shelter-intake-policy"]!.versions["1"]!.facets;
		const draftA = { ...v1, pets: "crated pets admitted, pet area in Hall B", id_required: "ID not listed as a requirement" };
		const draftB = { ...v1, capacity_note: "Hall A holds 100 cots; the shift lead decides on overflow" };
		const truth = whatIf(state, view.policy!, [
			{ id: "a", change: await baselineFor(view, "shelter-intake-policy", draftA, "e".repeat(40)) },
			{ id: "b", change: await baselineFor(view, "shelter-intake-policy", draftB, "d".repeat(40)) },
		]);

		expect(truth.map((o) => o.blockedCount)).toEqual([3, 1]);
		truth.forEach((outcome, i) => {
			const column = options[i]!;
			expect(column.getAttribute("data-blocked")).toBe(outcome.blockedIds.join(","));
			expect(within(column).getByText(`Blocks ${outcome.blockedCount} ${outcome.blockedCount === 1 ? "item" : "items"}`)).toBeInTheDocument();
			for (const id of outcome.blockedIds) expect(within(column).getByText(view.workItems[id]!.item.title)).toBeInTheDocument();
		});
		// A plain-words reason for each blocked item, not a code.
		expect(within(options[0]!).getAllByText(/Built on an old version/)).toHaveLength(3);
	});

	it("is a preview: nothing is saved or sent while comparing, and the existing flow is untouched", async () => {
		const { user, mock } = await openEditor();
		const api = mock.client.api;
		const spies = (["proposeContextChange", "resolve", "promote", "decideDependency", "seedScenario", "startScenario"] as const).map((name) => vi.spyOn(api, name));
		const ledgerBefore = latest!.ledgerHead;
		const effectBefore = screen.getByTestId("editor-effect").textContent;

		await user.click(screen.getByRole("button", { name: "Compare alternatives" }));
		await hold(user, /Hold this edit as Option A/);
		await screen.findByTestId("compare-option");
		await user.click(screen.getByRole("button", { name: "Edit this one" }));
		await user.click(screen.getByRole("button", { name: "Remove" }));
		await user.click(screen.getByRole("button", { name: "Hide comparison" }));

		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(latest!.ledgerHead).toEqual(ledgerBefore);
		// The one-line impact preview and the save button read as they did.
		expect(screen.getByTestId("editor-effect").textContent).toBe(effectBefore);
		// And the typed-reason jump still works, with nothing saved.
		await user.click(screen.getByRole("button", { name: "Make v2 the decision" }));
		expect(await screen.findByText("Say why the decision changed.")).toBeInTheDocument();
		expect(screen.getByLabelText("Why this change")).toHaveFocus();
		expect(spies[0]).not.toHaveBeenCalled();
	});

	it("opens as a dialog over the main pane; Escape and Close shut it, and held edits survive", async () => {
		const { user } = await openEditor();
		const link = screen.getByRole("button", { name: "Compare alternatives" });
		expect(screen.queryByTestId("compare-panel")).toBeNull();

		await user.click(link);
		const sheet = screen.getByTestId("compare-panel");
		expect(sheet).toHaveAttribute("role", "dialog");
		expect(within(sheet).getByRole("heading", { name: "Compare alternatives" })).toBeInTheDocument();
		// The editor is not inside it, and stays live beside it.
		expect(within(sheet).queryByLabelText("Why this change")).toBeNull();
		await waitFor(() => expect(within(sheet).getByRole("button", { name: "Close" })).toHaveFocus());

		await hold(user, /Hold this edit as Option A/);
		await screen.findByTestId("compare-option");

		await user.keyboard("{Escape}");
		expect(screen.queryByTestId("compare-panel")).toBeNull();
		expect(screen.getByRole("button", { name: "Compare alternatives" })).toHaveFocus();
		expect(screen.getByText("1 held")).toBeInTheDocument();

		// Reopened, the held edit is still there; Close shuts it too.
		await user.click(screen.getByRole("button", { name: "Compare alternatives" }));
		expect(await screen.findByTestId("compare-option")).toBeInTheDocument();
		await user.click(within(screen.getByTestId("compare-panel")).getByRole("button", { name: "Close" }));
		expect(screen.queryByTestId("compare-panel")).toBeNull();
	});

	it("holds at most three edits", async () => {
		const { user } = await openEditor();
		await user.click(screen.getByRole("button", { name: "Compare alternatives" }));
		await hold(user, /Hold this edit as Option A/);
		await setValue(user, "capacity_note", "Hall A holds 90 cots");
		await hold(user, /Hold this edit as Option B/);
		await setValue(user, "capacity_note", "Hall A holds 80 cots");
		await hold(user, /Hold this edit as Option C/);
		expect(await screen.findAllByTestId("compare-option")).toHaveLength(3);
		expect(screen.getByTestId("compare-panel")).toHaveTextContent("Three options held. Remove one to hold another.");
		expect(screen.queryByRole("button", { name: /Hold this edit/ })).toBeNull();
	});
});
