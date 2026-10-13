import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithMock } from "@/test/render";
import { ExceptionForm } from "./inspector-actions";
import { Inspector } from "./inspector";
import { PromoteButton } from "./promote-button";
import { useConsole } from "@/state/console-context";

function Selected({ children }: { children: (id: string) => React.ReactNode }) {
	const { selectedId } = useConsole();
	return selectedId ? children(selectedId) : null;
}

describe("gate preview: the Merge button and its tooltip", () => {
	it("is disabled for stale work, and the tooltip lists the reason codes the gate returned", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<PromoteButton workItemId="WI-2" />, { beats: 5 });
		const gate = await mock.client.api.gate("WI-2");
		expect(gate.pass).toBe(false);
		expect(gate.reasonCodes).toEqual(expect.arrayContaining(["STALE_RECEIPT", "CLAIM_CONFLICT", "TEST_FAILED"]));

		const button = await screen.findByTestId("promote-button");
		await waitFor(() => expect(button).toBeDisabled());

		await user.hover(screen.getByTestId("promote-trigger"));
		const tooltip = await screen.findByRole("tooltip");
		for (const code of gate.reasonCodes) expect(within(tooltip).getByText(code)).toBeInTheDocument();
		expect(tooltip).toHaveTextContent("Merge is blocked");
	});

	it("is enabled for unaffected work that passes the gate, and says so", async () => {
		const user = userEvent.setup();
		await renderWithMock(<PromoteButton workItemId="WI-1" />, { beats: 5 });
		const button = await screen.findByTestId("promote-button");
		await waitFor(() => expect(button).toBeEnabled());
		await user.hover(screen.getByTestId("promote-trigger"));
		expect(await screen.findByRole("tooltip")).toHaveTextContent(/gate passes/i);
	});

	it("updates when conditions change: closed while stale, open after revalidation, then promoted", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<PromoteButton workItemId="WI-2" />, { beats: 5 });
		const button = await screen.findByTestId("promote-button");
		await waitFor(() => expect(button).toBeDisabled());

		await act(async () => {
			await mock.client.controls.jump(8); // revalidate, then the re-run lands
		});
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());

		await user.click(screen.getByTestId("promote-button"));
		await user.click(await screen.findByTestId("merge-confirm"));
		await waitFor(() => expect(screen.getByTestId("promote-button")).toHaveTextContent("Merged"));
		expect(screen.getByTestId("promote-button")).toBeDisabled();
	});

	it("shows the reasons under the button for people who cannot hover", async () => {
		await renderWithMock(<PromoteButton workItemId="WI-2" showReasons />, { beats: 5 });
		await waitFor(() => expect(screen.getByText("Blocked by")).toBeInTheDocument());
		expect(screen.getAllByText("STALE_RECEIPT").length).toBeGreaterThan(0);
	});
});

describe("the Why tab: epistemic chips", () => {
	it("labels a claim agent-asserted, a check test-verified, and an accepted record recorded", async () => {
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { beats: 5, select: "WI-2" });
		const chain = await screen.findByRole("list", { name: "Why chain" });
		const steps = within(chain).getAllByRole("listitem").filter((li) => li.hasAttribute("data-chain-step"));

		const step = (n: string) => steps.find((li) => li.getAttribute("data-chain-step") === n);
		expect(within(step("1") as HTMLElement).getByText("recorded")).toBeInTheDocument(); // accepted record
		expect(within(step("2") as HTMLElement).getByText("recorded")).toBeInTheDocument(); // receipt
		expect(within(step("3") as HTMLElement).getByText("agent-asserted, unverified")).toBeInTheDocument(); // claim
		expect(within(step("4") as HTMLElement).getByText("test-verified")).toBeInTheDocument(); // Evidence
		expect(within(step("5") as HTMLElement).getByText("Awaiting human", { selector: "[data-epistemic]" })).toBeInTheDocument(); // undecided
	});

	it("never shows a success badge on an undecided item", async () => {
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { beats: 5, select: "WI-2" });
		const chain = await screen.findByRole("list", { name: "Why chain" });
		const awaiting = within(chain).getByTestId("awaiting-human");
		expect(awaiting).toHaveTextContent("Awaiting human");
		expect(within(awaiting).queryByText(/promoted|success|approved/i)).toBeNull();
	});

	it("is the default tab, titled as the question, with the chain from decision to condition", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const tab = await screen.findByRole("tab", { name: "Why is this blocked?" });
		expect(tab).toHaveAttribute("aria-selected", "true");
		const panel = await screen.findByTestId("why-tab");
		for (const title of ["Decision", "Receipt", "Claim", "Test", "Condition"]) expect(within(panel).getByRole("heading", { name: title })).toBeInTheDocument();
		expect(within(panel).getAllByText("STALE_RECEIPT").length).toBeGreaterThan(0);
	});

	it("a promoted item reads recorded on its condition, not awaiting", async () => {
		await renderWithMock(<Inspector />, { beats: 9, select: "WI-2" });
		const decided = await screen.findByTestId("decided");
		expect(decided).toHaveTextContent("Merged into the baseline");
		expect(screen.queryByTestId("awaiting-human")).toBeNull();
		const chain = screen.getByRole("list", { name: "Why chain" });
		const last = within(chain).getAllByRole("listitem").find((li) => li.getAttribute("data-chain-step") === "5") as HTMLElement;
		expect(within(last).getByText("recorded")).toBeInTheDocument();
	});

	it("an item left alone shows why, with its reason code", async () => {
		await renderWithMock(<Inspector />, { beats: 4, select: "WI-1" });
		const note = await screen.findByTestId("left-alone");
		expect(within(note).getByText("NO_DEPENDENCY_ON_CHANGED_FACETS")).toBeInTheDocument();
	});
});

describe("actions: accept exception needs a scope and a rationale", () => {
	it("validates both fields in the form before submitting", async () => {
		const user = userEvent.setup();
		const calls: Array<[string | null, string, string]> = [];
		render(<ExceptionForm candidates={["qualified-lead"]} busy={false} onCancel={() => {}} onSubmit={(record, scope, rationale) => void calls.push([record, scope, rationale])} />);

		await user.click(screen.getByRole("button", { name: "Record exception" }));
		expect(calls).toHaveLength(0);
		expect(screen.getByText(/Scope is required/)).toBeInTheDocument();
		expect(screen.getByText(/Rationale is required/)).toBeInTheDocument();

		await user.type(screen.getByLabelText("Scope"), "reports/q4-forecast.md");
		await user.click(screen.getByRole("button", { name: "Record exception" }));
		expect(calls).toHaveLength(0);
		expect(screen.queryByText(/Scope is required/)).toBeNull();
		expect(screen.getByText(/Rationale is required/)).toBeInTheDocument();

		await user.type(screen.getByLabelText("Rationale"), "Grandfathered for the board deck.");
		await user.click(screen.getByRole("button", { name: "Record exception" }));
		expect(calls).toEqual([["qualified-lead", "reports/q4-forecast.md", "Grandfathered for the board deck."]]);
	});

	it("records a scoped exception through the engine and clears the block", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<Inspector />, { scenario: "sales-ops", beats: 5, select: "WI-3" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByRole("button", { name: /Accept exception/ }));
		await user.type(await screen.findByLabelText("Scope"), "reports/q4-forecast.md");
		await user.type(screen.getByLabelText("Rationale"), "Q4 forecast is grandfathered on v1 for the board deck.");
		await user.click(screen.getByRole("button", { name: "Record exception" }));

		await waitFor(() => expect(mock.client.controls.getState().busy).toBe(false));
		await waitFor(async () => expect((await mock.client.api.gate("WI-3")).pass).toBe(true));
		expect(await screen.findByText("Scope: reports/q4-forecast.md")).toBeInTheDocument();
	});

	it("revalidate goes through the engine with a default rationale and shows the revalidating chip", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<Inspector />, { beats: 6, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByRole("button", { name: "Revalidate" }));
		await user.click(await screen.findByTestId("revalidate-confirm"));
		await waitFor(() => expect(screen.getAllByText("revalidating").length).toBeGreaterThan(0));
		expect(mock.client.controls.getState().position).toBe(6);
	});

	it("the actions tab renders the gate preview with a dry-run verdict", async () => {
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { beats: 5, select: "WI-2" });
		const user = userEvent.setup();
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		const preview = await screen.findByTestId("gate-preview");
		await waitFor(() => expect(within(preview).getByText("Merge would be blocked")).toBeInTheDocument());
		expect(within(preview).getByText("CLAIM_CONFLICT")).toBeInTheDocument();
	});
});
