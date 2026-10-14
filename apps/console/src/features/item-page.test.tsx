import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useConsole } from "@/state/console-context";
import { renderWithMock } from "@/test/render";
import { ItemPage } from "./item-page";

/** Words the main surface does not use (the same list as plain-words.test.tsx). */
const JARGON = /\b(stale|receipts?|facets?|records?|reconcil\w*|ledger|gate|prose|beat|promot\w*)\b/i;

/**
 * As in plain-words.test.tsx. The merge check's blocker lines (Actions tab) are the engine's own sentences, written in
 * delta-core, so they are left out here too; for a held item one of them still says "receipt".
 */
function readable(root: HTMLElement): string {
	const copy = root.cloneNode(true) as HTMLElement;
	for (const hidden of copy.querySelectorAll("[data-reason], [data-testid='technical-details'], [data-condition] p, [data-testid='gate-preview'] ul, .sr-only")) hidden.remove();
	return copy.textContent ?? "";
}

function Page({ onBack = () => {} }: { onBack?: () => void }) {
	const { view, selectedId } = useConsole();
	const wi = selectedId ? view.workItems[selectedId] : undefined;
	return wi ? <ItemPage wi={wi} backLabel="Needs you" onBack={onBack} /> : null;
}

describe("the item page for blocked work", () => {
	it("leads with the verdict, Revalidate as the primary action and a closed Merge", async () => {
		await renderWithMock(<Page />, { beats: 5, select: "WI-2" });
		const page = await screen.findByTestId("item-page");
		expect(within(page).getByTestId("item-verdict")).toHaveTextContent("Blocked: it was built on a decision that has since changed.");
		await waitFor(() => expect(within(page).getByTestId("revalidate-button")).toBeEnabled());
		expect(within(page).getAllByTestId("revalidate-button")).toHaveLength(1);
		expect(within(page).getByTestId("promote-button")).toBeDisabled();
		// Allow with exception and Reject sit under More.
		expect(within(page).queryByRole("button", { name: /Allow with exception/ })).toBeNull();
	});

	it("shows the Built-on rows: ✗ notifications built on v1, now v2, with what changed, and ✓ status-model", async () => {
		await renderWithMock(<Page />, { beats: 5, select: "WI-2" });
		const builtOn = await screen.findByTestId("built-on");
		const notifications = builtOn.querySelector("[data-built-on='notifications']") as HTMLElement;
		expect(notifications).toHaveAttribute("data-state", "outdated");
		expect(notifications).toHaveTextContent("built on v1, now v2");
		expect(within(notifications).getByRole("list", { name: "What changed in notifications" })).toHaveTextContent("default");
		expect(builtOn.querySelector("[data-built-on='status-model']")).toHaveAttribute("data-state", "current");
	});

	it("opens on Why blocked?, with the stamp and the not-a-verdict line once, and no second set of actions", async () => {
		await renderWithMock(<Page />, { beats: 5, select: "WI-2" });
		const page = await screen.findByTestId("item-page");
		expect(within(page).getByRole("tab", { name: "Why blocked?" })).toHaveAttribute("aria-selected", "true");
		expect(within(page).getByTestId("built-on-stamps")).toHaveTextContent("Built on notifications v1 · now v2");
		expect(within(page).getAllByText("A changed decision is not a verdict on the work.")).toHaveLength(1);
		expect(within(page).queryByTestId("resolve-actions")).toBeNull();
	});

	it("puts Allow with exception and Reject under More, with the exception form unchanged", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Page />, { beats: 5, select: "WI-2" });
		await user.click(await screen.findByTestId("item-more"));
		const more = screen.getByTestId("resolve-more");
		expect(within(more).getByRole("button", { name: /Reject/ })).toBeInTheDocument();
		await user.click(within(more).getByRole("button", { name: /Allow with exception/ }));
		expect(await screen.findByRole("form", { name: "Allow with exception" })).toBeInTheDocument();
		expect(screen.getByLabelText("What it covers")).toBeInTheDocument();
	});

	it("revalidates from the top of the page through the same confirm sheet", async () => {
		const user = userEvent.setup();
		const harness = await renderWithMock(<Page />, { beats: 5, select: "WI-2" });
		const button = await screen.findByTestId("revalidate-button");
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await user.click(await screen.findByTestId("revalidate-confirm"));
		await waitFor(() => expect(harness.client.controls.getState().busy).toBe(false));
		await waitFor(() => expect(screen.getByTestId("item-verdict")).toHaveTextContent(/Re-running on the current decisions/));
	});

	it("goes back with the back link", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		await renderWithMock(<Page onBack={onBack} />, { beats: 5, select: "WI-2" });
		await user.click(await screen.findByRole("button", { name: /Needs you/ }));
		expect(onBack).toHaveBeenCalledOnce();
	});
});

describe("the item page for ready work", () => {
	it("makes Merge the primary action, opens the merge sheet, and leaves only Reject under More", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Page />, { beats: 5, select: "WI-1" });
		const page = await screen.findByTestId("item-page");
		expect(within(page).getByTestId("item-verdict")).toHaveTextContent(/^Ready to merge/);
		expect(within(page).queryByTestId("revalidate-button")).toBeNull();
		const merge = within(page).getByTestId("promote-button");
		await waitFor(() => expect(merge).toBeEnabled());
		await user.click(merge);
		expect(await screen.findByTestId("merge-sheet")).toHaveTextContent("Not checked: whether the work is right.");
		await user.click(screen.getByTestId("merge-cancel"));
		await user.click(within(page).getByTestId("item-more"));
		const more = screen.getByTestId("resolve-more");
		expect(within(more).getByRole("button", { name: /Reject/ })).toBeInTheDocument();
		expect(within(more).queryByRole("button", { name: /Allow with exception/ })).toBeNull();
	});

	it("keeps the Actions tab to the merge check and history, without a second Merge button", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Page />, { beats: 5, select: "WI-1" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		expect(await screen.findByTestId("gate-preview")).toBeInTheDocument();
		expect(screen.getAllByTestId("promote-button")).toHaveLength(1);
	});
});

describe("the item page for held work", () => {
	it("points at the dependency question, shows it once, and marks the ? row", async () => {
		await renderWithMock(<Page />, { script: "undeclared", beats: 2, select: "WI-1" });
		const page = await screen.findByTestId("item-page");
		await waitFor(() => expect(within(page).getByTestId("item-verdict")).toHaveTextContent("Held: its claims rely on notifications"));
		expect(within(page).getAllByTestId("dependency-question")).toHaveLength(1);
		expect(within(page).queryByTestId("revalidate-button")).toBeNull();
		expect(page.querySelector("[data-built-on='notifications']")).toHaveAttribute("data-state", "not-given");
	});

	it("moves to Ready when the dependency is rejected", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Page />, { script: "undeclared", beats: 2, select: "WI-1" });
		await user.click(await screen.findByTestId("dependency-reject"));
		await waitFor(() => expect(screen.getByTestId("item-verdict")).toHaveTextContent(/^Ready to merge/));
		expect(screen.getByTestId("dependency-answered")).toHaveAttribute("data-decision", "reject");
	});
});

describe("the item page reads plainly", () => {
	it.each([
		{ script: undefined, beats: 5, select: "WI-2" },
		{ script: undefined, beats: 5, select: "WI-1" },
		{ script: "undeclared", beats: 2, select: "WI-1" },
	])("step $beats, $select ($script): the top and every tab", async ({ script, beats, select }) => {
		const user = userEvent.setup();
		await renderWithMock(<Page />, { script, beats, select });
		const page = await screen.findByTestId("item-page");
		await user.click(within(page).getByTestId("item-more"));
		const seen = [readable(page)];
		for (const name of [/^Why/, "What it was given", "Claims vs decision", "Changes", "Actions"]) {
			await user.click(within(page).getByRole("tab", { name }));
			seen.push(readable(await screen.findByRole("tabpanel")));
		}
		const leaks = seen.flatMap((text) => [...text.matchAll(new RegExp(`.{0,40}${JARGON.source}.{0,30}`, "gi"))].map((m) => m[0]));
		expect(leaks).toEqual([]);
	}, 60000);
});
