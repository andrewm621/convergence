import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "@/app";
import type { Runtime } from "@/client/create-client";
import { StatusChip } from "@/components/status";
import { renderWithMock } from "@/test/render";
import { ContextTimeline } from "./context-timeline";
import { ExceptionForm } from "./inspector-actions";
import { Inspector } from "./inspector";

const runtime: Runtime = { mock: true, scenario: "notifications", start: "seeded", drip: false, controls: true };

async function next(user: ReturnType<typeof userEvent.setup>, times: number) {
	for (let i = 0; i < times; i++) {
		const button = await screen.findByRole("button", { name: "Next step" });
		await waitFor(() => expect(button).toBeEnabled());
		await user.click(button);
		await waitFor(() => expect(screen.getByRole("button", { name: "Next step" })).toBeEnabled());
	}
}

describe("the one-reason card on the Why tab", () => {
	it("leads with the stamp, one sentence per changed setting, the not-a-verdict line and the named signer", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const card = await screen.findByTestId("reason-card");
		expect(within(card).getByRole("heading", { name: "Why is this blocked?" })).toBeInTheDocument();
		expect(within(card).getByTestId("built-on-stamps")).toHaveTextContent("Built on notifications v1 · now v2");
		const reasons = within(card).getByTestId("reason-sentences");
		expect(reasons).toHaveTextContent("Built on the old default (on). The decision now says opt-in.");
		expect(reasons).toHaveTextContent("Built on the old cadence (immediate). The decision now says weekly-digest.");
		// Visible text, not a tooltip.
		expect(within(card).getByTestId("not-a-verdict")).toHaveTextContent("A changed decision is not a verdict on the work.");
		expect(within(card).getByTestId("signoff")).toHaveTextContent("Sign-off: Decision owner (demo identity)");
	});

	it("puts the three actions directly under the reason, each with a line on what it does", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const card = await screen.findByTestId("reason-card");
		const actions = within(card).getByTestId("resolve-actions");
		for (const name of ["Revalidate", "Allow with exception", "Reject"]) expect(within(actions).getByRole("button", { name })).toBeInTheDocument();
		expect(actions).toHaveTextContent("Sends the agent back to redo this on the current decisions. Uses 1 of 2 re-runs.");
		expect(actions).toHaveTextContent("Lifts the block from this decision, for a scope you name. Other blocks stay.");
		expect(actions).toHaveTextContent("Ends this work. The reason goes in the audit log.");
		// The card comes before the epistemic chain, and the chain is intact below it.
		const chain = screen.getByRole("list", { name: "Why chain" });
		expect(card.compareDocumentPosition(chain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		for (const title of ["Decision", "What it was given", "Claim", "Test", "Condition"]) expect(within(chain).getByRole("heading", { name: title })).toBeInTheDocument();
	});

	it("keeps the reason codes behind a collapsed Technical details", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const details = (await screen.findByTestId("technical-details")) as HTMLDetailsElement;
		expect(details.open).toBe(false);
		expect(within(details).getByText("STALE_RECEIPT")).toBeInTheDocument();
		expect(within(details).getByText("Technical details")).toBeInTheDocument();
		// Outside the details, the card carries no reason code.
		const card = screen.getByTestId("reason-card");
		for (const chip of card.querySelectorAll("[data-reason]")) expect(details.contains(chip)).toBe(true);
	});

	it("is headed Merge status, with no resolve actions, for work with nothing wrong", async () => {
		// WI-1 has pushed and cleared the gate: ready, and nothing to resolve.
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-1" });
		const card = await screen.findByTestId("reason-card");
		expect(within(card).getByRole("heading", { name: "Merge status" })).toBeInTheDocument();
		expect(screen.queryByTestId("resolve-actions")).toBeNull();
		expect(screen.queryByRole("button", { name: "Revalidate" })).toBeNull();
		expect(screen.getByRole("tab", { name: "Why" })).toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole("tab", { name: "Actions" }));
		expect(await screen.findByTestId("gate-preview")).toBeInTheDocument();
		// Nothing to redo or lift on work that is ready, but a person can still reject it.
		const actions = await screen.findByTestId("resolve-actions");
		expect(within(actions).getByRole("button", { name: "Reject" })).toBeEnabled();
		expect(within(actions).queryByRole("button", { name: "Revalidate" })).toBeNull();
		expect(within(actions).queryByRole("button", { name: /Allow with exception/ })).toBeNull();
	});

	it("is not headed 'Why is this blocked?' for an agent that simply has not pushed yet, and its chip stays green when the change left it alone", async () => {
		await renderWithMock(<Inspector />, { beats: 4, select: "WI-1" });
		const card = await screen.findByTestId("reason-card");
		expect(within(card).getByRole("heading", { name: "Merge status" })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: "Why blocked?" })).toBeNull();
		const inspector = screen.getByTestId("inspector");
		const chip = inspector.querySelector("[data-status]") as HTMLElement;
		expect(chip).toHaveAttribute("data-status", "running");
		expect(chip).toHaveTextContent("Left alone");
		expect(within(screen.getByTestId("left-alone")).getByText("NO_DEPENDENCY_ON_CHANGED_FACETS")).toBeInTheDocument();
	});

	it("does not show 'agent running' next to Blocked: the agent is 'still working'", async () => {
		await renderWithMock(<Inspector />, { beats: 4, select: "WI-2" });
		const inspector = await screen.findByTestId("inspector");
		expect(within(inspector).getByText("Agent still working")).toBeInTheDocument();
		expect(within(inspector).queryByText("agent running")).toBeNull();
	});
});

describe("status chip words", () => {
	it("says Blocked for stale and conflict, Ready to merge, Merged, Up to date and Agent working", () => {
		const words: Array<[Parameters<typeof StatusChip>[0]["status"], string]> = [
			["stale", "Blocked"],
			["conflict", "Blocked"],
			["ready", "Ready to merge"],
			["promoted", "Merged"],
			["fresh", "Up to date"],
			["running", "Agent working"],
		];
		for (const [status, word] of words) {
			const { unmount } = render(<StatusChip status={status} />);
			expect(screen.getByText(word).closest("[data-status]")).toHaveAttribute("data-status", status);
			unmount();
		}
	});

	it("shows work the change left alone as green 'Left alone', and keeps the status attribute", () => {
		render(<StatusChip status="running" leftAlone />);
		expect(screen.getByText("Left alone").closest("[data-status]")).toHaveAttribute("data-status", "running");
	});
});

describe("accept exception states the whole of R5", () => {
	it("names the failing check, when it ends, where it is recorded and who can grant it", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		await user.click(await screen.findByRole("button", { name: /Allow with exception/ }));
		const terms = await screen.findByTestId("exception-terms");
		expect(terms).toHaveTextContent("Lifts the block from notifications only.");
		expect(terms).not.toHaveTextContent("Lets this work merge even though");
		expect(terms).toHaveTextContent("built on the old version");
		expect(terms).toHaveTextContent("claims that conflict");
		expect(screen.getByTestId("exception-waived-check")).toHaveTextContent("this decision's own check: notifications.test.ts, currently failing");
		expect(screen.getByTestId("exception-dry-run")).toHaveTextContent("With this exception the merge check would pass.");
		expect(screen.queryByTestId("exception-other-blocks")).toBeNull();
		expect(terms).toHaveTextContent("It never waives unknowns");
		expect(terms).toHaveTextContent("Ends when notifications gets a new version or the agent pushes again.");
		expect(terms).toHaveTextContent("Recorded in the audit log");
		expect(terms).toHaveTextContent("only Decision owner (demo identity) can grant it");
	});

	it("still says it without the check named when the form is given no waiver facts", () => {
		render(<ExceptionForm candidates={["qualified-lead"]} busy={false} onCancel={() => {}} onSubmit={() => {}} />);
		const terms = screen.getByTestId("exception-terms");
		expect(terms).toHaveTextContent("built on the old version");
		expect(terms).toHaveTextContent("Lifts the block from qualified-lead only.");
		expect(terms).toHaveTextContent("Ends when qualified-lead gets a new version");
		expect(terms).toHaveTextContent("Recorded in the audit log");
	});
});

describe("the results strip after a merge", () => {
	it("stops saying 1 blocked once the blocked item is merged, and counts it resolved", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 4);
		const strip = await screen.findByTestId("results-strip");
		expect(strip).toHaveTextContent("1 blocked");
		expect(screen.queryByTestId("results-resolved")).toBeNull();

		await user.click(screen.getByRole("button", { name: /Go to step 9/ })); // conflict, WI-1 merges, revalidate, re-run lands, WI-2 merges
		await waitFor(() => expect(screen.getByTestId("results-strip")).toHaveTextContent("0 blocked"), { timeout: 5000 });
		expect(screen.getByTestId("results-resolved")).toHaveTextContent("1 resolved");
		expect(screen.getByTestId("results-strip").getAttribute("title")).toContain("2 items checked");
	});
});

describe("the first screen", () => {
	it("states the problem in the header, with the no-model line always in view", () => {
		render(<App runtime={runtime} />);
		expect(screen.getByTestId("tagline")).toHaveTextContent("Blocks work built on a decision that changed.");
		expect(screen.getByTestId("no-model-line")).toHaveTextContent("No model makes these calls.");
		expect(screen.queryByText("Console")).toBeNull();
	});

	it("opens on the problem, not on 'No work yet'", async () => {
		render(<App runtime={runtime} />);
		const card = await screen.findByTestId("start-agents");
		expect(card).toHaveTextContent("Agents work in parallel. Then a decision changes.");
		expect(card).toHaveTextContent("Git won't notice: the files don't conflict.");
		expect(card).toHaveTextContent("Start to see what Convergence catches.");
		expect(within(card).getByRole("button", { name: /Start the scenario/ })).toBeInTheDocument();
		expect(card).not.toHaveTextContent("No work yet");
	});
});

describe("the decision editor and the ledger badge", () => {
	it("keeps the effect line and the save button in a sticky footer", async () => {
		const user = userEvent.setup();
		await renderWithMock(<ContextTimeline />, { beats: 1 });
		const card = (await screen.findByRole("heading", { name: "notifications" })).closest("article") as HTMLElement;
		await user.click(within(card).getByRole("button", { name: /Change this decision/ }));
		const footer = await screen.findByTestId("editor-footer");
		expect(footer.className).toContain("sticky");
		expect(footer.className).toContain("bottom-0");
		expect(within(footer).getByTestId("editor-effect")).toBeInTheDocument();
		expect(within(footer).getByRole("button", { name: /Save wording change|Make v\d the decision/ })).toBeInTheDocument();
	});

	it("says the chain was verified in this browser, for the lines in view", async () => {
		const user = userEvent.setup();
		render(<App runtime={runtime} />);
		await next(user, 2);
		const badge = await screen.findByTestId("chain-verified");
		expect(badge).toHaveTextContent(/verified in this browser · \d+ lines in view/);
		expect(badge).not.toHaveTextContent("chain verified");
	});

	it("says '1 work item relies on it', and '2 work items rely on it'", async () => {
		await renderWithMock(<ContextTimeline />, { beats: 1 });
		expect(await screen.findByText("1 work item relies on it")).toBeInTheDocument();
		expect(screen.getByText("2 work items rely on it")).toBeInTheDocument();
	});
});
