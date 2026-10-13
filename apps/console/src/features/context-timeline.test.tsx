import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithMock } from "@/test/render";
import { useConsole } from "@/state/console-context";
import { ContextTimeline } from "./context-timeline";

function Toasts() {
	const { toasts } = useConsole();
	return <ul aria-label="Toasts">{toasts.map((t) => <li key={t.id}>{t.text}</li>)}</ul>;
}

describe("empty state", () => {
	it("says there is no accepted context and offers a one-click scenario seed", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<ContextTimeline />, { start: "empty" });
		const empty = await screen.findByTestId("empty-state");
		expect(empty).toHaveTextContent("No accepted context yet. Declare the first decision.");

		await user.click(within(empty).getByRole("button", { name: /Seed the scenario/ }));
		await waitFor(() => expect(screen.queryByTestId("empty-state")).toBeNull());
		expect(await screen.findByRole("heading", { name: "notifications" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "status-model" })).toBeInTheDocument();
		expect(mock.client.controls.getState().position).toBe(0);
	});
});

describe("context timeline", () => {
	it("shows each record's version history, v1 to v2, with who accepted it", async () => {
		await renderWithMock(<ContextTimeline />, { beats: 4 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		const history = within(card).getByRole("list", { name: "notifications version history" });
		const versions = within(history).getAllByRole("listitem").map((li) => li.getAttribute("data-version"));
		expect(versions).toEqual(["2", "1"]);
		expect(card).toHaveTextContent("Accepted by Decision owner (demo identity)");
		expect(within(card).getByText("current")).toBeInTheDocument();
		expect(within(card).getByText("superseded")).toBeInTheDocument();
		// v2 changed two facets, and the card says which.
		expect(card.querySelectorAll('[data-changed="true"]')).toHaveLength(2);
	});

	it("notes the typo beat as a prose edit that re-evaluated nothing", async () => {
		await renderWithMock(<ContextTimeline />, { beats: 2 });
		const note = await screen.findByTestId("prose-edit-note");
		expect(note).toHaveTextContent(/No facet changed/);
	});
});

describe("propose change", () => {
	it("a prose-only edit is saved as a prose edit of the same version and nothing goes stale", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Propose change/ }));

		const prose = await screen.findByLabelText("Prose");
		await waitFor(() => expect((prose as HTMLTextAreaElement).value).toContain("Users receive"));
		await user.type(prose, " (reviewed)");
		expect(screen.getByTestId("editor-effect")).toHaveTextContent(/prose edit of v1/);
		expect(screen.getByTestId("editor-effect")).toHaveTextContent(/nobody is paged/);

		await user.click(screen.getByRole("button", { name: "Save prose edit" }));
		await waitFor(() => expect(screen.queryByRole("form", { name: /Propose a change/ })).toBeNull());
		const state = await mock.client.api.gate("WI-2");
		expect(state.reasonCodes).not.toContain("STALE_RECEIPT");
	});

	it("changing a facet commits a new version, requires a reason, and turns the dependent item stale", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Propose change/ }));

		const value = await screen.findByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		expect(screen.getByTestId("editor-effect")).toHaveTextContent(/1 facet changed: this commits v2/);

		// A decision change must say why.
		await user.click(screen.getByRole("button", { name: "Commit v2" }));
		expect(await screen.findByText("Say why the decision changed.")).toBeInTheDocument();

		await user.type(screen.getByLabelText("Why this change"), "Opt-in only.");
		await user.click(screen.getByRole("button", { name: "Commit v2" }));
		await waitFor(async () => expect((await mock.client.api.gate("WI-2")).reasonCodes).toContain("STALE_RECEIPT"));
		expect(await screen.findByText("v2", { selector: "[data-slot=badge]" })).toBeInTheDocument();
	});

	it("sends the baseline commit it opened on, and says so when another tab moved the decisions first", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(
			<>
				<ContextTimeline />
				<Toasts />
			</>,
			{ beats: 1 },
		);
		const propose = vi.spyOn(mock.client.api, "proposeContextChange");
		const shown = (await screen.findByText(/^baseline [0-9a-f]+$/)).textContent?.replace("baseline ", "") ?? "";
		expect(shown).not.toBe("");
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Propose change/ }));
		const value = await screen.findByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		await user.type(screen.getByLabelText("Why this change"), "Opt-in only.");

		// Another tab commits to the baseline first (a different record, so this editor stays open and only the compare-and-swap can catch it).
		const other = await mock.client.api.proposeContextChange({ recordId: "status-model", facets: { "status.values": ["draft", "active", "blocked", "done", "archived"], "status.transitions": "forward-only" }, prose: "", rationale: "other tab" }, "other-tab");
		expect(other).toEqual({ ok: true, message: expect.anything() });
		propose.mockClear();

		await user.click(screen.getByRole("button", { name: "Commit v2" }));
		await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
		expect(propose.mock.calls[0]?.[0]).toMatchObject({ recordId: "notifications", expectedBaselineCommit: expect.stringMatching(new RegExp(`^${shown}`)) });
		expect(await screen.findByText(/The decisions changed after you opened this editor/)).toBeInTheDocument();
		// The Worker's refusal is what the console is told, and nothing was committed on top of the other tab's change.
		await expect(propose.mock.results[0]?.value).resolves.toMatchObject({ ok: false, code: "BASELINE_MOVED" });
	});
});
