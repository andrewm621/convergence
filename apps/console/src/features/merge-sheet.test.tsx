import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StatusChip } from "@/components/status";
import { readyByException, mergeChecks, mergeRecord } from "@/state/derive";
import { renderWithMock } from "@/test/render";
import { startMock } from "@/test/harness";
import { Inspector } from "./inspector";
import { PromoteButton } from "./promote-button";
import { WorkGraph } from "./work-graph";

describe("Merge opens a sheet; only the sheet's Merge promotes", () => {
	it("opens on click without merging, says what was and was not checked, and Cancel leaves the work unmerged", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<PromoteButton workItemId="WI-1" />, { beats: 5 });
		const button = await screen.findByTestId("promote-button");
		await waitFor(() => expect(button).toBeEnabled());
		expect(button).toHaveTextContent("Merge");

		await user.click(button);
		const sheet = await screen.findByTestId("merge-sheet");
		expect(sheet).toHaveAttribute("role", "dialog");
		expect(within(sheet).getByRole("heading")).toHaveTextContent(/^Merging /);
		expect(within(sheet).getByTestId("merge-checked")).toHaveTextContent("Checked just now: built on current decisions");
		expect(within(sheet).getByTestId("merge-checked")).toHaveTextContent("claims match.");
		expect(within(sheet).getByTestId("merge-not-checked")).toHaveTextContent("Not checked: whether the work is right.");
		expect(sheet).toHaveTextContent("Checked again at merge.");
		expect(within(sheet).getByTestId("merge-audit")).toHaveTextContent("Recorded in the audit log under Decision owner (demo identity).");
		expect(within(sheet).queryByTestId("merge-exception")).toBeNull();
		// Focus moved into the sheet, onto the safe choice.
		await waitFor(() => expect(within(sheet).getByTestId("merge-cancel")).toHaveFocus());

		await user.click(within(sheet).getByTestId("merge-cancel"));
		await waitFor(() => expect(screen.queryByTestId("merge-sheet")).toBeNull());
		expect(screen.getByTestId("promote-button")).toHaveFocus();
		expect(screen.getByTestId("promote-button")).toHaveTextContent("Merge");
		const state = await mock.client.api.gate("WI-1");
		expect(state.pass).toBe(true); // still there to merge: nothing was promoted
	});

	it("Escape and a click outside close it, and focus goes back to the button", async () => {
		const user = userEvent.setup();
		await renderWithMock(
			<div>
				<button type="button">elsewhere</button>
				<PromoteButton workItemId="WI-1" />
			</div>,
			{ beats: 5 },
		);
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());

		await user.click(screen.getByTestId("promote-button"));
		await screen.findByTestId("merge-sheet");
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByTestId("merge-sheet")).toBeNull());
		expect(screen.getByTestId("promote-button")).toHaveFocus();

		await user.click(screen.getByTestId("promote-button"));
		await screen.findByTestId("merge-sheet");
		await user.click(screen.getByRole("button", { name: "elsewhere" }));
		await waitFor(() => expect(screen.queryByTestId("merge-sheet")).toBeNull());
		expect(screen.getByText("Merge", { selector: "button" })).toBeEnabled();
	});

	it("Merge in the sheet promotes, and the item reads Merged by the actor who asked", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-1" });
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
		await user.click(screen.getByTestId("promote-button"));
		await user.click(await screen.findByTestId("merge-confirm"));
		await waitFor(() => expect(screen.getByTestId("promote-button")).toHaveTextContent("Merged"));
		expect(screen.getByTestId("promote-button")).toBeDisabled();
		expect(screen.queryByTestId("merge-sheet")).toBeNull();
		expect(await screen.findByTestId("merged-by")).toHaveTextContent(/^Merged by Decision owner \(demo identity\) at /);
	});

	it("says Re-checking before merge while the merge is in flight", async () => {
		const user = userEvent.setup();
		await renderWithMock(<PromoteButton workItemId="WI-1" />, { beats: 5, promoteDelayMs: 400 });
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
		await user.click(screen.getByTestId("promote-button"));
		await user.click(await screen.findByTestId("merge-confirm"));
		expect(screen.getByTestId("promote-button")).toHaveTextContent("Re-checking before merge");
		expect(screen.getByTestId("promote-button")).not.toHaveTextContent("current heads");
		await waitFor(() => expect(screen.getByTestId("promote-button")).toHaveTextContent("Merged"));
	});
});

describe("the tooltip stays down after the sheet closes", () => {
	it("does not pop back up on the Merge button after Escape", async () => {
		const user = userEvent.setup();
		await renderWithMock(<PromoteButton workItemId="WI-1" />, { beats: 5 });
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
		// By keyboard: focus alone opens the tooltip, and closing the sheet hands focus straight back.
		await user.tab();
		expect(screen.getByTestId("promote-button")).toHaveFocus();
		await user.keyboard("{Enter}");
		await screen.findByTestId("merge-sheet");
		expect(screen.queryByRole("tooltip")).toBeNull();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByTestId("merge-sheet")).toBeNull());
		expect(screen.getByTestId("promote-button")).toHaveFocus();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(screen.queryByRole("tooltip")).toBeNull();
	});
});

describe("ready under an exception looks different from ready", () => {
	it("carries into the pick-a-work-item list", async () => {
		await renderWithMock(<Inspector />, { scenario: "shelter-intake", beats: 6 });
		const list = await screen.findByRole("list", { name: "Work items" });
		const chip = list.querySelector('[data-status="ready"][data-excepted]') as HTMLElement;
		expect(chip).toHaveTextContent("Ready · exception");
	});

	it("is an amber Ready · exception chip with data-status still ready, in the inspector and on the graph card", async () => {
		await renderWithMock(
			<>
				<WorkGraph />
				<Inspector />
			</>,
			{ scenario: "shelter-intake", beats: 6, select: "WI-2" },
		);
		const inspector = await screen.findByTestId("inspector");
		const chip = inspector.querySelector("[data-status]") as HTMLElement;
		expect(chip).toHaveAttribute("data-status", "ready");
		expect(chip).toHaveAttribute("data-excepted");
		expect(chip).toHaveTextContent("Ready · exception");
		expect(chip.className).toContain("text-warning");
		expect(chip.className).not.toContain("accent");

		const graph = await screen.findByRole("region", { name: "Work graph" });
		const card = graph.querySelector('[data-slot="work-item-node"][data-work-item="WI-2"]') as HTMLElement;
		expect(card).toHaveAttribute("data-status", "ready");
		const cardChip = card.querySelector("[data-excepted]") as HTMLElement;
		expect(cardChip).toHaveTextContent("Ready · exception");
		expect(card).toHaveAttribute("aria-label", expect.stringContaining("Ready · exception"));
	}, 20000);

	it("keeps cleanly ready work green-ish: plain Ready to merge, no exception marker", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-1" });
		const inspector = await screen.findByTestId("inspector");
		await waitFor(() => expect(inspector.querySelector("[data-status]")).toHaveAttribute("data-status", "ready"));
		const chip = inspector.querySelector("[data-status]") as HTMLElement;
		expect(chip).toHaveTextContent("Ready to merge");
		expect(chip).not.toHaveAttribute("data-excepted");
	});

	it("is only an exception chip for ready work", () => {
		render(
			<>
				<StatusChip status="ready" excepted />
				<StatusChip status="stale" excepted />
			</>,
		);
		expect(screen.getByText("Ready · exception")).toBeInTheDocument();
		expect(screen.getByText("Blocked")).toBeInTheDocument();
	});

	it("the sheet names the exception, its signer and its scope, and still lists what was found", async () => {
		const user = userEvent.setup();
		await renderWithMock(<PromoteButton workItemId="WI-2" />, { scenario: "shelter-intake", beats: 6 });
		await waitFor(() => expect(screen.getByTestId("promote-button")).toBeEnabled());
		await user.click(screen.getByTestId("promote-button"));
		const sheet = await screen.findByTestId("merge-sheet");
		expect(within(sheet).getByTestId("merge-exception")).toHaveTextContent("Passes with an accepted exception from Decision owner (demo identity): signs/door.md.");
		// The lines come from the facts, so a block the exception covers is not worded as a pass.
		expect(within(sheet).getByTestId("merge-checked")).toHaveTextContent("built on an older decision");
		expect(within(sheet).getByTestId("merge-checked")).not.toHaveTextContent("built on current decisions");
		expect(within(sheet).getByTestId("merge-checked")).not.toHaveTextContent("check passed");
		expect(within(sheet).getByTestId("merge-not-checked")).toHaveTextContent("Not checked: whether the work is right.");
	});

	it("derives the same answer without React: exception only where the gate passes through one", async () => {
		const mock = await startMock({ scenario: "shelter-intake" });
		await mock.jump(6);
		expect(readyByException(mock.view, mock.view.workItems["WI-2"]!)).toBe(true);
		expect(readyByException(mock.view, mock.view.workItems["WI-4"]!)).toBe(false);
		mock.stop();
	});
});

describe("the sheet's checked line follows the facts", () => {
	it("says there is no check for work that has none, and never says check passed then", async () => {
		const mock = await startMock({ scenario: "notifications" });
		await mock.jump(5);
		const wi = mock.view.workItems["WI-1"]!;
		const checks = mergeChecks(mock.view, wi)!;
		expect(checks.map((c) => c.key)).toEqual(["decisions", "check", "claims"]);
		// Strip the evidence and the requirement the way a record with no validation would: the line must change.
		const bare = { ...wi, evidence: [] };
		const view = { ...mock.view, workItems: { ...mock.view.workItems, "WI-1": bare }, records: Object.fromEntries(Object.entries(mock.view.records).map(([id, r]) => [id, { ...r, versions: Object.fromEntries(Object.entries(r.versions).map(([v, s]) => [v, { ...s, validation: null }])) }])) };
		const none = mergeChecks(view, bare)!;
		expect(none.find((c) => c.key === "check")?.text).toBe("no check for this work");
		mock.stop();
	});
});

describe("claims match only when something was compared", () => {
	async function ready() {
		const mock = await startMock({ scenario: "notifications" });
		await mock.jump(5);
		const wi = mock.view.workItems["WI-1"]!;
		return { mock, wi, claims: wi.claims! };
	}
	const claimsLine = (view: Parameters<typeof mergeChecks>[0], wi: Parameters<typeof mergeChecks>[1]) => mergeChecks(view, wi)!.find((c) => c.key === "claims")!;

	it("says claims match when every claim was held against a governing decision", async () => {
		const { mock, wi } = await ready();
		expect(claimsLine(mock.view, wi).text).toBe("claims match");
		mock.stop();
	});

	it("says so plainly when a claim has no decision governing it", async () => {
		const { mock, wi, claims } = await ready();
		const extra = { subject: "nothing.governs.this", value: true, basedOn: claims.claims[0]!.basedOn };
		const mixed = { ...wi, claims: { ...claims, claims: [...claims.claims, extra] } };
		expect(claimsLine(mock.view, mixed).text).toBe("claims match where a decision governs them");
		const onlyUngoverned = { ...wi, claims: { ...claims, claims: [extra] } };
		expect(claimsLine(mock.view, onlyUngoverned).text).toBe("no claims to compare");
		mock.stop();
	});

	it("does not count a claim built on a reliance a human rejected", async () => {
		const { mock, wi, claims } = await ready();
		const recordId = claims.claims[0]!.basedOn.split("@")[0]!;
		const view = { ...mock.view, dependencies: mock.view.dependencies.map((d) => (d.workItemId === "WI-1" && d.recordId === recordId ? { ...d, status: "rejected" as const } : d)) };
		const unreceipted = { ...wi, receipt: { ...wi.receipt, accepted: wi.receipt.accepted.filter((e) => e.recordId !== recordId) } };
		expect(claimsLine(view, unreceipted).text).toBe("no claims to compare");
		mock.stop();
	});
});

describe("Merged by", () => {
	it("falls back to Merged at when the ledger names nobody", async () => {
		const mock = await startMock({ scenario: "notifications" });
		await mock.jump(9);
		const merged = mergeRecord(mock.view, "WI-2");
		expect(merged?.by).toBe("Decision owner (demo identity)");
		const withoutRequests = { ...mock.view, ledger: mock.view.ledger.filter((e) => e.payload.event.type !== "PromotionRequested") };
		const fallback = mergeRecord(withoutRequests, "WI-2");
		expect(fallback).toEqual({ ts: merged?.ts, by: null });
		expect(mergeRecord(mock.view, "WI-404")).toBeNull(); // never merged

		// A refused request sitting after the allowed one is not who merged it.
		const allowed = mock.view.ledger.findIndex((e) => e.payload.event.type === "PromotionRequested" && e.payload.event.workItemId === "WI-2" && e.payload.effects.some((x) => x.type === "ALLOW_PROMOTION"));
		const entry = mock.view.ledger[allowed]!;
		const refused = { ...entry, payload: { event: { ...entry.payload.event, actor: { kind: "human" as const, id: "someone-else", displayName: "Someone Else" } }, effects: [] } } as typeof entry;
		const ledger = [...mock.view.ledger.slice(0, allowed + 1), refused, ...mock.view.ledger.slice(allowed + 1)];
		expect(mergeRecord({ ...mock.view, ledger }, "WI-2")?.by).toBe("Decision owner (demo identity)");
		mock.stop();
	});
});

describe("Revalidate asks first, with the real counts", () => {
	it("opens a sheet naming the version and how many re-runs this uses; Cancel does not re-run", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<Inspector />, { beats: 6, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByTestId("revalidate-button"));
		const sheet = await screen.findByTestId("revalidate-sheet");
		expect(sheet).toHaveTextContent("Re-run the agent on Notifications v2? Uses 1 of 2 re-runs.");
		await waitFor(() => expect(within(sheet).getByTestId("revalidate-cancel")).toHaveFocus());

		await user.click(within(sheet).getByTestId("revalidate-cancel"));
		await waitFor(() => expect(screen.queryByTestId("revalidate-sheet")).toBeNull());
		expect(screen.getByTestId("revalidate-button")).toHaveFocus();
		expect(screen.queryAllByText("revalidating")).toHaveLength(0);
		expect(mock.client.controls.getState().position).toBe(6);
	});

	it("closes if the agent starts re-running while it is open", async () => {
		const user = userEvent.setup();
		const mock = await renderWithMock(<Inspector />, { beats: 6, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByTestId("revalidate-button"));
		await screen.findByTestId("revalidate-sheet");
		await act(async () => {
			await mock.client.controls.jump(7); // the beat where Revalidate is clicked
		});
		await waitFor(() => expect(screen.queryByTestId("revalidate-sheet")).toBeNull());
	});

	it("Re-run in the sheet sends the agent back", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 6, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await user.click(await screen.findByTestId("revalidate-button"));
		await user.click(await screen.findByTestId("revalidate-confirm"));
		await waitFor(() => expect(screen.getAllByText("revalidating").length).toBeGreaterThan(0));
	});
});
