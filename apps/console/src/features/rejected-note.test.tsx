import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { analysisOf, semanticDiff } from "@/state/derive";
import { startMock } from "@/test/harness";
import { renderWithMock } from "@/test/render";
import { Inspector } from "./inspector";
import { RejectedNote } from "./rejected-note";

const rejected = { recordId: "notifications", version: 2, facet: "notifications.default", value: "on" };

describe("RejectedNote", () => {
	it("quotes the rejected value and the recorded rationale", () => {
		render(<RejectedNote rejected={{ ...rejected, why: "Opt-in only, after the consent complaints." }} />);
		const note = screen.getByTestId("rejected-note");
		expect(note).toHaveTextContent('Rejected in v2: "on".');
		expect(note).toHaveTextContent("Why: Opt-in only, after the consent complaints.");
		expect(within(note).queryByText("No rationale recorded.")).toBeNull();
	});

	it("says no rationale was recorded, and invents none, when the decision has no why", () => {
		render(<RejectedNote rejected={rejected} />);
		const note = screen.getByTestId("rejected-note");
		expect(note).toHaveTextContent('Rejected in v2: "on".');
		expect(within(note).getByText("No rationale recorded.")).toBeInTheDocument();
		expect(note).not.toHaveTextContent("Why:");
	});
});

describe("the claim row, derived from the engine's own finding", () => {
	it("carries the rejection (with the record's why) on the rejected claim only, and none on a claim that was not rejected", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const view = mock.view;
		const history = view.records.notifications;
		const head = history?.versions["2"];
		if (!history || !head) throw new Error("no notifications v2");
		const withWhy = { ...view, records: { ...view.records, notifications: { ...history, versions: { ...history.versions, "2": { ...head, why: "Opt-in only.", not: { "notifications.default": head.not["notifications.default"] ?? [] } } } } } };
		const wi = withWhy.workItems["WI-2"];
		const analysis = analysisOf(withWhy, "WI-2");
		if (!wi || !analysis) throw new Error("no WI-2");
		const rows = semanticDiff(withWhy, wi, analysis).rows;
		const byFacet = (key: string) => rows.find((r) => r.claim.subject === key);
		expect(byFacet("notifications.default")?.rejected).toEqual({ recordId: "notifications", version: 2, facet: "notifications.default", value: "on", why: "Opt-in only." });
		// A conflicting claim whose value the decision never rejected (here: cadence's `not` removed) shows nothing extra.
		expect(byFacet("notifications.cadence")?.verdict).toBe("conflict");
		expect(byFacet("notifications.cadence")?.rejected).toBeUndefined();
		mock.stop();
	});
});

describe("the Why tab", () => {
	it("shows the note under each rejected claim, and says no rationale was recorded when the record has none", async () => {
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const claims = await screen.findByRole("list", { name: "Claims" });
		const notes = within(claims).getAllByTestId("rejected-note");
		// The demo decision rejects both old values, so both conflicting claims carry the note.
		expect(notes).toHaveLength(2);
		const onRow = within(claims).getByText("notifications.default").closest("li");
		expect(onRow).toHaveTextContent('Rejected in v2: "on".');
		expect(onRow).toHaveTextContent("No rationale recorded.");
		expect(within(claims).getByText("notifications.cadence").closest("li")).toHaveTextContent('Rejected in v2: "immediate".');
	});

	it("shows no note for work with nothing rejected", async () => {
		await renderWithMock(<Inspector />, { beats: 4, select: "WI-1" });
		await screen.findByTestId("why-tab");
		expect(screen.queryByTestId("rejected-note")).toBeNull();
	});
});
