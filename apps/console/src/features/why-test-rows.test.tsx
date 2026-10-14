import { render, screen, waitFor, within } from "@testing-library/react";
import type { Evidence, WorkItemState } from "contracts";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import type { ConsoleClient, ConsoleMessage } from "@/client/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CLAIMS_CHECK_LABEL } from "@/lib/evidence";
import { createMockClient } from "@/mock/client";
import { ConsoleProvider, useConsole } from "@/state/console-context";
import { Inspector } from "./inspector";

/** The mock client, with the evidence of every work item it sends rewritten by `edit`. */
function withEvidence(edit: (evidence: Evidence[]) => Evidence[]): ConsoleClient {
	const client = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null });
	const rewrite = (wi: WorkItemState): WorkItemState => ({ ...wi, evidence: edit(wi.evidence) });
	const rewriteMessage = (message: ConsoleMessage): ConsoleMessage => {
		if (message.type === "snapshot") return { ...message, snapshot: { ...message.snapshot, workItems: message.snapshot.workItems.map(rewrite) } };
		if (message.type === "event") return { ...message, workItems: message.workItems.map(rewrite) };
		return message;
	};
	return { ...client, connect: (handlers) => client.connect({ ...handlers, onMessage: (message) => handlers.onMessage(rewriteMessage(message)) }) };
}

function SelectWi2() {
	const { select, selectedId, view } = useConsole();
	useEffect(() => {
		if (selectedId !== "WI-2" && view.workItems["WI-2"]) select("WI-2");
	}, [selectedId, view.workItems, select]);
	return null;
}

/** WI-2 after its revalidation lands (the replay's eighth beat): passing contract checks plus a passing claims check at the head. */
async function renderChain(edit: (evidence: Evidence[]) => Evidence[]) {
	const client = withEvidence(edit);
	render(
		<TooltipProvider delayDuration={0}>
			<ConsoleProvider client={client} flushMs={1}>
				<SelectWi2 />
				<Inspector />
			</ConsoleProvider>
		</TooltipProvider>,
	);
	await waitFor(() => expect((client as ReturnType<typeof createMockClient>).controls.getState().ready).toBe(true));
	await (client as ReturnType<typeof createMockClient>).controls.jump(8);
	await waitFor(() => expect((client as ReturnType<typeof createMockClient>).controls.getState().busy).toBe(false));
	return await screen.findByRole("list", { name: "Why chain" });
}

const isClaims = (e: Evidence) => e.kind === "delta-claims-check";

describe("the Why chain separates the Worker's claims check from the tests", () => {
	it("a failed claims check beside passing run checks: the Test row lists only the run checks, the Claims check row shows the failure", async () => {
		const chain = await renderChain((evidence) => evidence.map((e) => (isClaims(e) ? { ...e, pass: false, output: "claims cite notifications@1, the current version is v2" } : e)));

		const tests = within(chain).getByRole("list", { name: "Checks" });
		expect(within(tests).getAllByText("Convergence contract check").length).toBeGreaterThan(0);
		expect(within(tests).queryByText(/Claims check/)).toBeNull();
		expect(within(tests).queryByText(/failed/)).toBeNull();
		expect(within(tests).queryByText(/delta:claims-vs-receipt/)).toBeNull();
		const testRow = chain.querySelector('[data-chain-step="4"]') as HTMLElement;
		expect(within(testRow).getByText("test-verified")).toBeInTheDocument();

		const claims = within(chain).getByRole("list", { name: "Claims checks" });
		expect(within(claims).getByText(/Claims check \(not an executed test\)/)).toHaveTextContent(": failed");
		expect(within(claims).getByText(/claims cite notifications@1/)).toBeInTheDocument();
		const claimsRow = chain.querySelector('[data-chain-step="3b"]') as HTMLElement;
		expect(within(claimsRow).getByText("claims-checked, not tested")).toBeInTheDocument();
		expect(chain.querySelector('[data-chain-step="3b"] [data-evidence-kind="delta-claims-check"]')).toHaveAttribute("data-evidence-kind", "delta-claims-check");
	});

	it("only a claims check at the head: the Test row says there is no contract check yet, with no verified chip", async () => {
		const chain = await renderChain((evidence) => evidence.filter(isClaims));

		const testRow = chain.querySelector('[data-chain-step="4"]') as HTMLElement;
		expect(within(testRow).getByText("No Convergence contract check at this commit yet.")).toBeInTheDocument();
		expect(within(testRow).queryByRole("list", { name: "Checks" })).toBeNull();
		expect(within(testRow).queryByText("test-verified")).toBeNull();

		const claims = within(chain).getByRole("list", { name: "Claims checks" });
		expect(within(claims).getByText(CLAIMS_CHECK_LABEL)).toBeInTheDocument();
	});

	it("evidence with no kind (the fixtures' recorded results) counts as a test, as in the engine, and keeps the plain display", async () => {
		const chain = await renderChain((evidence) => evidence.map((e) => (e.kind === "delta-run-check" ? { ...e, kind: undefined } : e)));
		const tests = within(chain).getByRole("list", { name: "Checks" });
		expect(within(tests).getAllByText("passed").length).toBeGreaterThan(0);
		expect(within(tests).queryByText(CLAIMS_CHECK_LABEL)).toBeNull();
		expect(within(chain.querySelector('[data-chain-step="4"]') as HTMLElement).getByText("test-verified")).toBeInTheDocument();
	});

	it("long check output folds behind a toggle, and short output stays inline", async () => {
		const long = `status-model contract failed on 3 files under src/. ${"x is not declared in the code. ".repeat(40)}… (truncated)`;
		const chain = await renderChain((evidence) => evidence.map((e) => (e.kind === "delta-run-check" ? { ...e, output: long } : e)));
		const folded = within(chain).getAllByTestId("check-output")[0] as HTMLElement;
		expect(within(folded).getByText("Show full output")).toBeInTheDocument();
		expect(folded).not.toHaveAttribute("open");
		expect(within(folded).getByText(long)).toBeInTheDocument();
	});

	it("the re-run shows both of WI-2's contract checks and the status.values claim", async () => {
		const chain = await renderChain((evidence) => evidence);
		const tests = within(chain).getByRole("list", { name: "Checks" });
		const rows = within(tests).getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.getAttribute("data-check")).sort()).toEqual(["tests/contract/notifications.test.ts", "tests/contract/status-model.test.ts"]);
		expect(within(tests).getByText(/asserting status\.values/)).toBeInTheDocument();
		expect(within(tests).getByText(/asserting notifications\.cadence, notifications\.default/)).toBeInTheDocument();
		expect(within(within(chain).getByRole("list", { name: "Claims" })).getByText("status.values")).toBeInTheDocument();
	});

	it("no claims check: there is no Claims check row", async () => {
		const chain = await renderChain((evidence) => evidence.filter((e) => !isClaims(e)));
		expect(chain.querySelector('[data-chain-step="3b"]')).toBeNull();
		expect(within(chain).getByRole("list", { name: "Checks" })).toBeInTheDocument();
	});
});
