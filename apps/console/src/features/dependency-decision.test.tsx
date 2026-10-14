import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithMock } from "@/test/render";
import { startMock } from "@/test/harness";
import { DependencyDecision } from "./dependency-decision";

// The "undeclared" script: after two beats WI-1 has pushed claims citing notifications@1, which it was never given.
const HELD = { script: "undeclared", beats: 2 } as const;

describe("DependencyDecision", () => {
	it("replays the undeclared script: WI-1 is held, WI-2 is not", async () => {
		const mock = await startMock({ script: "undeclared" });
		await mock.jump(2);
		await mock.client.refresh(); // an inferred dependency arrives with the next snapshot, as the console's provider does
		expect(mock.status("WI-1")).toBe("uncertain");
		expect(mock.view.dependencies.find((d) => d.workItemId === "WI-1" && d.recordId === "notifications")).toMatchObject({ basis: "inferred", status: "proposed" });
		expect(mock.status("WI-2")).not.toBe("uncertain");
		mock.stop();
	});

	it("says what is held and offers both choices", async () => {
		await renderWithMock(<DependencyDecision workItemId="WI-1" />, HELD);
		expect(await screen.findByText("Claims rely on Notifications, which it wasn't given.")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reject this dependency" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Accept this dependency" })).toBeEnabled();
	});

	it("uses plain words on the card and in the answers", async () => {
		const jargon = /\b(stale|receipts?|facets?|records?|reconcil\w*|ledger|gate|prose|beat|promot\w*)\b/i;
		await renderWithMock(<DependencyDecision workItemId="WI-1" />, HELD);
		const card = await screen.findByTestId("dependency-decision");
		expect(card.textContent).not.toMatch(jargon);
		await userEvent.click(screen.getByRole("button", { name: "Accept this dependency" }));
		expect((await screen.findByTestId("dependency-answered")).textContent).not.toMatch(jargon);
	});

	it("renders nothing for work that is not held on an undeclared dependency", async () => {
		const { container } = await renderWithMock(<DependencyDecision workItemId="WI-2" />, HELD);
		expect(container.querySelector("[data-testid='dependency-decision']")).toBeNull();
		const unknown = await renderWithMock(<DependencyDecision workItemId="WI-9" />, HELD);
		expect(unknown.container.querySelector("[data-testid='dependency-decision']")).toBeNull();
		const before = await renderWithMock(<DependencyDecision workItemId="WI-1" />, { script: "undeclared", beats: 1 });
		expect(before.container.querySelector("[data-testid='dependency-decision']")).toBeNull();
	});

	it("reject: WI-1 is no longer held, the question goes, and the answer is stated", async () => {
		const harness = await renderWithMock(<DependencyDecision workItemId="WI-1" />, HELD);
		await userEvent.click(await screen.findByRole("button", { name: "Reject this dependency" }));
		expect(await screen.findByTestId("dependency-answered")).toHaveTextContent("Rejected. This work no longer counts on Notifications.");
		expect(screen.queryByRole("button", { name: "Reject this dependency" })).toBeNull();
		const snapshot = await harness.client.api.gate("WI-1");
		expect(snapshot.reasonCodes).not.toContain("UNDECLARED_DEP");
	});

	it("reject then v2 then merge: WI-1 merges and WI-2 stays blocked", async () => {
		const mock = await startMock({ script: "undeclared" });
		await mock.jump(3);
		await mock.client.refresh();
		expect(mock.status("WI-1")).toBe("ready");
		expect(mock.view.dependencies.find((d) => d.workItemId === "WI-1" && d.recordId === "notifications")?.status).toBe("rejected");
		await mock.jump(5);
		expect(mock.status("WI-1")).toBe("promoted");
		expect(mock.status("WI-2")).toBe("conflict");
		mock.stop();
	});

	it("accept: the dependency counts, so the work is behind on it and still not mergeable", async () => {
		const harness = await renderWithMock(<DependencyDecision workItemId="WI-1" />, HELD);
		await userEvent.click(await screen.findByRole("button", { name: "Accept this dependency" }));
		expect(await screen.findByTestId("dependency-answered")).toHaveAttribute("data-decision", "accept");
		await waitFor(async () => expect((await harness.client.api.gate("WI-1")).pass).toBe(false));
		expect((await harness.client.api.gate("WI-1")).reasonCodes).toContain("STALE_RECEIPT");
	});

	it("shows the engine's refusal instead of an answer when the question is already settled", async () => {
		const harness = await renderWithMock(<DependencyDecision workItemId="WI-1" />, HELD);
		const first = await harness.client.api.decideDependency({ workItemId: "WI-1", recordId: "notifications", decision: "reject" }, "k-1");
		expect(first.ok).toBe(true);
		const again = await harness.client.api.decideDependency({ workItemId: "WI-1", recordId: "notifications", decision: "accept" }, "k-2");
		expect(again).toMatchObject({ ok: false, code: "ALREADY_RESOLVED" });
		const unknown = await harness.client.api.decideDependency({ workItemId: "WI-9", recordId: "notifications", decision: "reject" }, "k-3");
		expect(unknown).toMatchObject({ ok: false, code: "UNKNOWN_WORK_ITEM" });
	});
});
