import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReconciliationEvent } from "contracts";
import { describe, expect, it } from "vitest";
import { ActorChip } from "@/components/status";
import { CLAIMS_CHECK_HINT, CLAIMS_CHECK_LABEL, RUN_CHECK_HINT } from "@/lib/evidence";
import { agentModelOf, summarizeLedgerLine } from "@/state/derive";
import { startMock } from "@/test/harness";
import { renderWithMock } from "@/test/render";
import { useConsole } from "@/state/console-context";
import { BottomStrip } from "./bottom-strip";
import { Inspector } from "./inspector";

function Selected({ children }: { children: () => React.ReactNode }) {
	const { selectedId } = useConsole();
	return selectedId ? children() : null;
}

/** An EvidenceRecorded ledger line from the replay, with the evidence's `kind` set (or removed). */
function evidenceLine(entries: readonly ReconciliationEvent[], kind: "executed-test" | "delta-run-check" | "delta-claims-check" | undefined): ReconciliationEvent {
	const base = entries.find((entry) => entry.payload.event.type === "EvidenceRecorded");
	if (!base || base.payload.event.type !== "EvidenceRecorded") throw new Error("no evidence on the ledger");
	const { kind: _kind, ...evidence } = base.payload.event.evidence;
	void _kind;
	return { ...base, payload: { ...base.payload, event: { ...base.payload.event, evidence: (kind ? { ...evidence, kind } : evidence) } } };
}

describe("the model on a work item", () => {
	it("reads the model from the latest AgentRunStarted, and null when the event names none", async () => {
		const mock = await startMock();
		await mock.next(); // two agents running
		expect(agentModelOf(mock.view.ledger, "WI-1")).toBe("stub agent");
		expect(agentModelOf(mock.view.ledger, "WI-2")).toBe("openai/gpt-6-luna");
		expect(agentModelOf(mock.view.ledger, "WI-9")).toBeNull();

		const started = mock.view.ledger.find((entry) => entry.payload.event.type === "AgentRunStarted");
		if (!started || started.payload.event.type !== "AgentRunStarted") throw new Error("no run on the ledger");
		const { model: _model, ...bare } = started.payload.event;
		void _model;
		const withoutModel = { ...started, payload: { ...started.payload, event: bare } } as ReconciliationEvent;
		expect(agentModelOf([withoutModel], bare.workItemId)).toBeNull();
		mock.stop();
	});

	it("shows the model in the inspector header instead of Agent A/B, and a bare Agent (never a letter) when nothing names one", async () => {
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { beats: 1, select: "WI-2" });
		const header = await screen.findByTestId("inspector");
		expect(within(header).getByText("openai/gpt-6-luna")).toBeInTheDocument();
		expect(within(header).queryByText("Agent B")).toBeNull();

		render(<ActorChip actor={{ kind: "agent", displayName: "Agent B" }} />);
		expect(screen.queryByText("Agent B")).toBeNull();
		expect(screen.getByText("Agent")).toBeInTheDocument();
	});
});

describe("honest evidence labels", () => {
	it("each kind reads as what it is on the ledger, with its tooltip; executed and absent keep 'Check passed'", async () => {
		const mock = await startMock();
		await mock.jump(5);
		const claims = summarizeLedgerLine(evidenceLine(mock.view.ledger, "delta-claims-check"));
		expect(claims.label).toBe(CLAIMS_CHECK_LABEL);
		expect(claims.hint).toBe("The Worker verified that the agent's claims at the pushed commit cite the current decision versions. It did not run the test suite.");

		const run = summarizeLedgerLine(evidenceLine(mock.view.ledger, "delta-run-check"));
		expect(run.label).toBe("Convergence contract check");
		expect(run.hint).toBe("Convergence ran its own deterministic check on the pushed files at this commit. Not the project's test suite.");

		for (const kind of ["executed-test", undefined] as const) {
			const line = summarizeLedgerLine(evidenceLine(mock.view.ledger, kind));
			expect(line.label).toMatch(/^Check (passed|failed)$/);
			expect(line.hint).toBeUndefined();
		}
		mock.stop();
	});

	it("the ledger strip shows both Delta checks for the replayed re-run", async () => {
		await renderWithMock(<BottomStrip />, { beats: 8 });
		const lines = await screen.findByRole("list", { name: "Audit log lines" });
		const claims = within(lines).getAllByText(CLAIMS_CHECK_LABEL);
		expect(claims[0]).toHaveAttribute("title", CLAIMS_CHECK_HINT);
		expect(within(lines).getAllByText("Convergence contract check")[0]).toHaveAttribute("title", RUN_CHECK_HINT);
	});

	it("the Why chain shows the claims check on its own row, apart from the contract checks that satisfy the gate", async () => {
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { beats: 8, select: "WI-2" });
		const checks = await screen.findByRole("list", { name: "Checks" });
		const claims = await screen.findByRole("list", { name: "Claims checks" });
		for (const badge of within(claims).getAllByText(CLAIMS_CHECK_LABEL)) expect(badge).toHaveAttribute("title", CLAIMS_CHECK_HINT);
		for (const badge of within(checks).getAllByText("Convergence contract check")) expect(badge).toHaveAttribute("title", RUN_CHECK_HINT);
		expect(within(checks).queryByText(CLAIMS_CHECK_LABEL)).toBeNull();
		expect(within(claims).queryByText("Convergence contract check")).toBeNull();
	});

	it("a failing contract check reads as failed, in the contract-check wording", async () => {
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { beats: 5, select: "WI-2" });
		const checks = await screen.findByRole("list", { name: "Checks" });
		const failed = within(checks).getAllByText(/Convergence contract check/).filter((el) => /: failed/.test(el.textContent ?? ""));
		expect(failed.length).toBeGreaterThan(0);
		expect(within(checks).queryByText(CLAIMS_CHECK_LABEL)).toBeNull();
		expect(screen.getByText("test-verified")).toBeInTheDocument();
	});
});

describe("the exception-lapse beat", () => {
	async function onRecord(beats: number) {
		const user = userEvent.setup();
		await renderWithMock(<Selected>{() => <Inspector />}</Selected>, { scenario: "shelter-intake", beats, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		return within(await screen.findByRole("region", { name: "Sign-offs" }));
	}

	it("flips the signage exception card to Lapsed with EXCEPTION_LAPSED once the policy is v3, with the item blocked again", async () => {
		const record = await onRecord(10);
		expect(record.getAllByText("Lapsed").length).toBeGreaterThan(0);
		expect(record.getAllByText("EXCEPTION_LAPSED").length).toBeGreaterThan(0);
		expect(record.getByText(/shelter-intake-policy moved from v2 to v3/)).toBeInTheDocument();
		expect(await screen.findByText("Merge would be blocked")).toBeInTheDocument();
	});

	it("leaves the exception standing before then", async () => {
		const record = await onRecord(9);
		expect(record.getByText("Allow with exception")).toBeInTheDocument();
		expect(record.queryByText("Lapsed")).toBeNull();
		expect(record.queryByText("EXCEPTION_LAPSED")).toBeNull();
		expect(record.getByText(/Valid while shelter-intake-policy is at v2/)).toBeInTheDocument();
	});
});
