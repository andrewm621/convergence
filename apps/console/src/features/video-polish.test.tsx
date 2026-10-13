import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { ConsoleProvider, useConsole } from "@/state/console-context";
import type { ViewState } from "@/state/store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createMockClient, type MockClient } from "@/mock/client";
import { renderWithMock } from "@/test/render";
import { Inspector } from "./inspector";
import { ResultsStrip, WorkGraph } from "./work-graph";
import type { Evaluation } from "@/state/store";

/** Tailwind classes below 14px that must not appear on receipt text. */
const SMALL_TEXT = /(^|\s)(text-xs|text-\[1[0-3](\.\d+)?px\])(\s|$)/;

function smallTextIn(root: HTMLElement): string[] {
	return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter((el) => SMALL_TEXT.test(el.getAttribute("class") ?? "")).map((el) => `${el.tagName}.${el.getAttribute("class")}`);
}

describe("the receipt: named facets, changes marked, readable", () => {
	it("lists record@version, then each facet it was handed with a short hash, and marks the changed ones", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Receipt" }));

		const tab = await screen.findByTestId("receipt-tab");
		expect(within(tab).getByTestId("receipt-ref-notifications")).toHaveTextContent("notifications@1");
		expect(within(tab).getByTestId("receipt-ref-status-model")).toHaveTextContent("status-model@1");

		const list = within(tab).getByTestId("receipt-facets-notifications");
		const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-facet]"));
		expect(rows.map((row) => row.getAttribute("data-facet"))).toEqual(["notifications.cadence", "notifications.channel", "notifications.default"]);
		const status = Object.fromEntries(rows.map((row) => [row.getAttribute("data-facet"), row.getAttribute("data-facet-status")]));
		// v2 moved the default and the cadence; the channel is untouched.
		expect(status).toEqual({ "notifications.cadence": "changed", "notifications.channel": "unchanged", "notifications.default": "changed" });
		const changed = rows.find((row) => row.getAttribute("data-facet") === "notifications.default") as HTMLElement;
		expect(changed).toHaveTextContent("changed in v2");
		expect(changed).toHaveTextContent("opt-in");

		// Each facet carries a short hash, and they differ.
		await waitFor(() => {
			for (const row of rows) expect(within(row).getByTestId(`facet-hash-${row.getAttribute("data-facet")}`).textContent).toMatch(/^#[0-9a-f]{8}$/);
		});
		const hashes = rows.map((row) => within(row).getByTestId(`facet-hash-${row.getAttribute("data-facet")}`).textContent);
		expect(new Set(hashes).size).toBe(rows.length);

		// The record is marked behind against the current version.
		expect(within(tab).getByText(/behind: accepted is v2/)).toBeInTheDocument();
	});

	it("uses nothing smaller than 14px on the receipt", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Receipt" }));
		const tab = await screen.findByTestId("receipt-tab");
		await waitFor(() => expect(within(tab).getByTestId("facet-hash-notifications.default").textContent).toMatch(/^#[0-9a-f]{8}$/));
		expect(smallTextIn(tab).filter((entry) => !entry.includes("lucide"))).toEqual([]);
	});

	it("an item the change left alone shows its facets as unchanged, not behind", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-1" });
		await user.click(await screen.findByRole("tab", { name: "Receipt" }));
		const tab = await screen.findByTestId("receipt-tab");
		expect(within(tab).queryByText(/behind:/)).toBeNull();
		expect(tab.querySelectorAll("[data-facet-status=changed]")).toHaveLength(0);
	});

	it("in the Why chain, the receipt chip expands to the facet list", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { beats: 5, select: "WI-2" });
		const chip = await screen.findByRole("button", { name: /notifications@1 \(now v2\)/ });
		expect(chip).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId("receipt-facets-notifications")).toBeNull();

		await user.click(chip);
		expect(chip).toHaveAttribute("aria-expanded", "true");
		const list = await screen.findByTestId("receipt-facets-notifications");
		expect(within(list).getByText("notifications.default")).toBeInTheDocument();
		expect(list.querySelectorAll("[data-facet-status=changed]")).toHaveLength(2);

		await user.click(chip);
		expect(screen.queryByTestId("receipt-facets-notifications")).toBeNull();
	});
});

/** Reads the view out of the provider so a test can build a follow-up context change. */
function ViewProbe({ into }: { into: { view: ViewState | null } }) {
	const { view } = useConsole();
	useEffect(() => {
		into.view = view;
	}, [into, view]);
	return null;
}

describe("the exception card states its lapse rule", () => {
	it("says it is valid while the record is at its version and lapses at the next one", async () => {
		const user = userEvent.setup();
		await renderWithMock(<Inspector />, { scenario: "shelter-intake", beats: 6, select: "WI-2" });
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		const card = (await screen.findAllByTestId("exception-rule"))[0] as HTMLElement;
		expect(card).toHaveTextContent("Valid while shelter-intake-policy is at v2 · lapses at the next version");
		expect(card.closest("[data-exception]")).toHaveAttribute("data-exception", "valid");
		expect(screen.queryByText("Lapsed")).toBeNull();
	});

	it("shows Lapsed with EXCEPTION_LAPSED once the record moves to the next version", async () => {
		const user = userEvent.setup();
		const probe: { view: ViewState | null } = { view: null };
		const mock = await renderWithMock(
			<>
				<ViewProbe into={probe} />
				<Inspector />
			</>,
			{ scenario: "shelter-intake", beats: 6, select: "WI-2" },
		);
		await user.click(await screen.findByRole("tab", { name: "Actions" }));
		await screen.findAllByTestId("exception-rule");

		const record = probe.view?.records["shelter-intake-policy"];
		const head = record?.versions[String(record.current)];
		if (!head) throw new Error("no policy record");
		const [key, value] = Object.entries(head.facets)[0] ?? [];
		if (!key) throw new Error("no facet to change");
		const changed = typeof value === "string" ? `${value} (revised)` : "revised";
		await act(async () => {
			const result = await mock.client.api.proposeContextChange({ recordId: "shelter-intake-policy", facets: { ...head.facets, [key]: changed }, prose: "", rationale: "v3" }, "key-v3");
			expect(result.ok).toBe(true);
		});

		await waitFor(() => expect(document.querySelector("[data-exception=lapsed]")).not.toBeNull());
		const card = document.querySelector("[data-exception=lapsed]") as HTMLElement;
		expect(within(card).getAllByText("Lapsed").length).toBeGreaterThan(0);
		expect(within(card).getByText("EXCEPTION_LAPSED")).toBeInTheDocument();
		expect(card).toHaveTextContent("shelter-intake-policy moved from v2 to v3");
		expect(card).not.toHaveTextContent("lapses at the next version");
	});
});

describe("the evaluation strip's timing", () => {
	const evaluation: Evaluation = { seq: 7, ts: "2026-10-12T16:00:00Z", recordRef: "notifications@2", proseOnly: false, evaluated: 2, stale: 1, untouched: 1, ms: 0.004 };

	it("keeps the engine time when it is not told otherwise (mock mode)", () => {
		render(<ResultsStrip evaluation={evaluation} />);
		expect(screen.getByTestId("results-time")).toHaveTextContent("<0.01 ms");
	});

	it("shows a browser-measured time, labelled as such", () => {
		render(<ResultsStrip evaluation={evaluation} ms={3210} measuredHere />);
		const time = screen.getByTestId("results-time");
		expect(time).toHaveTextContent("3.21 s");
		expect(time.getAttribute("title")).toContain("Measured in this browser");
	});

	it("shows no time at all when there is no honest number", () => {
		render(<ResultsStrip evaluation={evaluation} ms={null} measuredHere />);
		expect(screen.queryByTestId("results-time")).toBeNull();
		expect(screen.getByText("1 stale")).toBeInTheDocument();
	});
});

/** The mock dressed as the live client: it reports `evaluationMs`, which must not reach the strip. */
function liveLike(): MockClient {
	const client = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null });
	return { ...client, kind: "live" } as unknown as MockClient;
}

function Sender() {
	const { markChangeSent } = useConsole();
	return (
		<button type="button" onClick={markChangeSent}>
			send change
		</button>
	);
}

describe("live mode: the strip shows only a time this browser measured", () => {
	async function renderLive() {
		const client = liveLike();
		render(
			<TooltipProvider delayDuration={0}>
				<ConsoleProvider client={client} flushMs={1}>
					<Sender />
					<WorkGraph />
				</ConsoleProvider>
			</TooltipProvider>,
		);
		await waitFor(() => expect(client.controls.getState().ready).toBe(true));
		return client;
	}

	it("hides the reconciler's evaluationMs for a change this browser did not send", async () => {
		const client = await renderLive();
		await act(async () => {
			await client.controls.jump(4); // v2 lands, with an evaluationMs from the engine
		});
		await waitFor(() => expect(client.controls.getState().busy).toBe(false));
		await screen.findByTestId("results-strip");
		expect(screen.getByTestId("results-strip")).toHaveTextContent("evaluated");
		expect(screen.queryByTestId("results-time")).toBeNull();
	});

	it("shows the time from sending the change to the verdict arriving, once this browser sent one", async () => {
		const user = userEvent.setup();
		const client = await renderLive();
		await act(async () => {
			await client.controls.jump(3);
		});
		await user.click(screen.getByRole("button", { name: "send change" }));
		await act(async () => {
			await client.controls.jump(4);
		});
		const time = await screen.findByTestId("results-time");
		expect(time.textContent).toMatch(/ms|s$/);
		expect(time.getAttribute("title")).toContain("Measured in this browser");
	});
});
