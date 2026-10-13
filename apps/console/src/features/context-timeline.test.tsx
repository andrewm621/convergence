import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithMock } from "@/test/render";
import { useConsole } from "@/state/console-context";
import { ChangeEditor, ContextTimeline } from "./context-timeline";

/** The editor opened on v1, while the view can move on underneath it: what a second tab committing would do. */
function EditorOnV1() {
	const { view } = useConsole();
	const v1 = view.records["notifications"]?.versions["1"];
	return v1 ? <ChangeEditor recordId="notifications" snapshot={v1} onClose={() => {}} /> : null;
}

function Toasts() {
	const { toasts } = useConsole();
	return <ul aria-label="Toasts">{toasts.map((t) => <li key={t.id}>{t.text}</li>)}</ul>;
}

describe("empty state", () => {
	it("says there is no accepted context and offers a one-click scenario seed", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<ContextTimeline />, { start: "empty" });
		const empty = await screen.findByTestId("empty-state");
		expect(empty).toHaveTextContent("No decisions yet. Declare the first one.");

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
		expect(note).toHaveTextContent(/No setting changed/);
	});
});

describe("propose change", () => {
	it("a prose-only edit is saved as a prose edit of the same version and nothing goes stale", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Change this decision/ }));

		const prose = await screen.findByLabelText("Full wording");
		await waitFor(() => expect((prose as HTMLTextAreaElement).value).toContain("Users receive"));
		await user.type(prose, " (reviewed)");
		expect(screen.getByTestId("editor-effect")).toHaveTextContent(/wording change to v1/);
		expect(screen.getByTestId("editor-effect")).toHaveTextContent(/nothing is blocked/);

		await user.click(screen.getByRole("button", { name: "Save wording change" }));
		await waitFor(() => expect(screen.queryByRole("form", { name: /^Change / })).toBeNull());
		const state = await mock.client.api.gate("WI-2");
		expect(state.reasonCodes).not.toContain("STALE_RECEIPT");
	});

	it("changing a facet commits a new version, requires a reason, and turns the dependent item stale", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Change this decision/ }));

		const value = await screen.findByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		expect(screen.getByTestId("editor-effect")).toHaveTextContent(/This makes v2 the decision\. Blocks 1 built on v1: Notification preferences and delivery\./);

		// A decision change must say why.
		await user.click(screen.getByRole("button", { name: "Make v2 the decision" }));
		expect(await screen.findByText("Say why the decision changed.")).toBeInTheDocument();

		await user.type(screen.getByLabelText("Why this change"), "Opt-in only.");
		await user.click(screen.getByRole("button", { name: "Make v2 the decision" }));
		await waitFor(async () => expect((await mock.client.api.gate("WI-2")).reasonCodes).toContain("STALE_RECEIPT"));
		expect(await screen.findByText("v2", { selector: "[data-slot=badge]" })).toBeInTheDocument();
	});

	it("names the work a change will block and the work it leaves alone, and follows the edit as it is typed", async () => {
		const user = userEvent.setup();
		await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Change this decision/ }));
		const effect = await screen.findByTestId("editor-effect");
		expect(effect).toHaveTextContent("Nothing changed yet, so nothing is blocked.");

		// WI-2 relies on the default and the cadence, not on the channel.
		const channel = screen.getByLabelText("Value for notifications.channel");
		await user.clear(channel);
		await user.type(channel, "email");
		expect(effect).toHaveTextContent("This makes v2 the decision. Blocks nothing. Leaves 2 alone: Status badges and the status-change API, Notification preferences and delivery.");
		expect(effect).toHaveAttribute("data-blocked", "");

		const value = screen.getByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		expect(effect).toHaveTextContent("This makes v2 the decision. Blocks 1 built on v1: Notification preferences and delivery. Leaves 1 alone: Status badges and the status-change API.");
		expect(effect).toHaveAttribute("data-blocked", "WI-2");
		expect(effect).toHaveAttribute("data-left-alone", "WI-1");
		expect(effect).not.toHaveTextContent(/facet|record|receipt|stale/i);

		// Put it back and the line goes back to saying nothing changed.
		await user.clear(value);
		await user.type(value, "on");
		await user.clear(channel);
		await user.type(channel, "in-app");
		expect(effect).toHaveTextContent("Nothing changed yet, so nothing is blocked.");
	});

	it("shows long values and long keys in full: they wrap and grow instead of being cut off", async () => {
		const user = userEvent.setup();
		const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(84);
		try {
			await renderWithMock(<ContextTimeline />, { beats: 1 });
			const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
			await user.click(within(card).getByRole("button", { name: /Change this decision/ }));

			// The three keys that share a prefix are all there in full, so the part that tells them apart is visible.
			const keys = screen.getAllByLabelText("Setting").map((el) => (el as HTMLTextAreaElement).value);
			expect(keys).toEqual(["notifications.default", "notifications.cadence", "notifications.channel"]);
			for (const field of [...screen.getAllByLabelText("Setting"), screen.getByLabelText("Value for notifications.default")]) {
				expect(field.tagName).toBe("TEXTAREA");
				expect(field.className).not.toMatch(/truncate|text-ellipsis|whitespace-nowrap/);
				expect(field).toHaveStyle({ height: "84px" });
			}

			const long = "weekly digest on Monday mornings, except in the first week of the month, when it goes out on the Friday before";
			const value = screen.getByLabelText("Value for notifications.cadence");
			await user.clear(value);
			await user.type(value, long);
			expect((value as HTMLTextAreaElement).value).toBe(long);
			// Enter does not add a line to a setting.
			await user.type(value, "{Enter}");
			expect((value as HTMLTextAreaElement).value).toBe(long);
		} finally {
			scrollHeight.mockRestore();
		}
	});

	it("does not show a save button for one version next to a preview for another when the decision moves under the editor", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<EditorOnV1 />, { beats: 1 });
		const value = await screen.findByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		expect(screen.getByRole("button", { name: "Make v2 the decision" })).toBeEnabled();
		expect(screen.getByTestId("editor-effect")).toHaveTextContent("This makes v2 the decision.");

		// Another tab commits a different change to the same decision, so it is now v2 and the draft was written against v1.
		const other = await mock.client.api.proposeContextChange({ recordId: "notifications", facets: { "notifications.default": "off", "notifications.cadence": "daily", "notifications.channel": "in-app" }, prose: "", rationale: "other tab" }, "other-tab");
		expect(other).toMatchObject({ ok: true });
		await waitFor(() => expect(screen.getByTestId("editor-effect")).toHaveTextContent("The decision changed while you were editing. Close this and reopen it to see the effect."));
		expect(screen.getByTestId("editor-effect")).not.toHaveTextContent(/This makes v/);
		const commit = screen.getByRole("button", { name: "Make it the decision" });
		expect(commit).toBeDisabled();
		expect(screen.queryByRole("button", { name: /Make v\d the decision/ })).toBeNull();
	});

	it("announces a short count to screen readers once typing settles, not the whole line on every keystroke", async () => {
		const user = userEvent.setup();
		await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Change this decision/ }));
		const effect = await screen.findByTestId("editor-effect");
		expect(effect).not.toHaveAttribute("aria-live");
		const live = screen.getByTestId("editor-effect-summary");
		expect(live).toHaveAttribute("aria-live", "polite");
		expect(live).toHaveTextContent("Nothing changed yet.");

		const value = screen.getByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		expect(effect).toHaveTextContent("Blocks 1 built on v1");
		await waitFor(() => expect(live).toHaveTextContent("Blocks 1, leaves 1 alone."), { timeout: 4000 });
		expect(live).not.toHaveTextContent("Notification preferences");
	});

	it("re-measures a field when the card changes width, and lets Enter confirm an input-method composition", async () => {
		const user = userEvent.setup();
		const observers: Array<() => void> = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					observers.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		let width = 300;
		let height = 40;
		const clientWidth = vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(() => width);
		const scrollHeight = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
		try {
			await renderWithMock(<ContextTimeline />, { beats: 1 });
			const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
			await user.click(within(card).getByRole("button", { name: /Change this decision/ }));
			const value = await screen.findByLabelText("Value for notifications.default");
			expect(value).toHaveStyle({ height: "40px" });

			// Narrower card: the same text wraps onto more lines.
			width = 150;
			height = 96;
			for (const callback of observers) callback();
			expect(value).toHaveStyle({ height: "96px" });

			expect(fireEvent.keyDown(value, { key: "Enter" })).toBe(false); // a new line is refused
			expect(fireEvent.keyDown(value, { key: "Enter", isComposing: true })).toBe(true); // confirming a composition is not
		} finally {
			clientWidth.mockRestore();
			scrollHeight.mockRestore();
			vi.unstubAllGlobals();
		}
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
		await user.click(within(card).getByRole("button", { name: /Change this decision/ }));
		const value = await screen.findByLabelText("Value for notifications.default");
		await user.clear(value);
		await user.type(value, "opt-in");
		await user.type(screen.getByLabelText("Why this change"), "Opt-in only.");

		// Another tab commits to the baseline first (a different record, so this editor stays open and only the compare-and-swap can catch it).
		const other = await mock.client.api.proposeContextChange({ recordId: "status-model", facets: { "status.values": ["draft", "active", "blocked", "done", "archived"], "status.transitions": "forward-only" }, prose: "", rationale: "other tab" }, "other-tab");
		expect(other).toEqual({ ok: true, message: expect.anything() });
		propose.mockClear();

		await user.click(screen.getByRole("button", { name: "Make v2 the decision" }));
		await waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
		expect(propose.mock.calls[0]?.[0]).toMatchObject({ recordId: "notifications", expectedBaselineCommit: expect.stringMatching(new RegExp(`^${shown}`)) });
		expect(await screen.findByText(/The decisions changed after you opened this editor/)).toBeInTheDocument();
		// The Worker's refusal is what the console is told, and nothing was committed on top of the other tab's change.
		await expect(propose.mock.results[0]?.value).resolves.toMatchObject({ ok: false, code: "BASELINE_MOVED" });
	});
});
