import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { readUi } from "@/app";
import { renderWithMock } from "@/test/render";
import { CalmShell, existingConsoleHref } from "./calm-shell";

const commonProps = {
  scenario: "notifications" as const,
  onScenario: () => {},
  controls: false,
};

describe("read-only Calm Work Inbox v0.3.1", () => {
  it("is opt-in: the existing new and classic views stay selected unless calm is requested", () => {
    expect(readUi("")).toBe("new");
    expect(readUi("?ui=new")).toBe("new");
    expect(readUi("?ui=classic")).toBe("classic");
    expect(readUi("?ui=calm")).toBe("calm");
    expect(readUi("?ui=unknown")).toBe("new");
    expect(existingConsoleHref("?mock=1&scenario=notifications&ui=calm")).toBe("?mock=1&scenario=notifications&ui=new");
  });

  it("renders the quiet work queue with team review, not invented personalized assignments", async () => {
    await renderWithMock(<CalmShell {...commonProps} />, { beats: 4 });
    expect(await screen.findByTestId("calm-row-WI-2")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    for (const name of ["Work", "Decisions", "Activity"]) {
      expect(within(nav).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByText(/need[s]? team review/i)).toBeInTheDocument();
    expect(screen.getByText(/personal assignments are not available/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|merge|revalidate|accept dependency/i })).toBeNull();
  });

  it("shows real accepted facet changes and a non-mutating explanation inspector", async () => {
    const user = userEvent.setup();
    await renderWithMock(<CalmShell {...commonProps} />, { beats: 4 });
    await user.click(await screen.findByRole("button", { name: /Open .*notification/i }));
    expect(screen.getByTestId("calm-work-detail")).toHaveTextContent("Project decisions changed");
    expect(screen.getByText("Notification default")).toBeInTheDocument();
    expect(screen.getByText("Delivery timing")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Why this matters" }));
    const dialog = screen.getByRole("dialog", { name: "Why this matters" });
    expect(within(dialog).getByRole("tab", { name: "Explanation" })).toHaveAttribute("aria-selected", "true");
    await user.click(within(dialog).getByRole("tab", { name: "Sources" }));
    expect(within(dialog).getByText(/Recorded context at registration or revalidation/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("tab", { name: "Technical details" }));
    expect(within(dialog).getByText(/Context packet hash/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Normative status/i)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("calm-work-detail")).toBeInTheDocument();
  });

  it("preserves the decision and activity projections without adding fake editor controls", async () => {
    const user = userEvent.setup();
    await renderWithMock(<CalmShell {...commonProps} />, { beats: 4 });
    const nav = screen.getByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("button", { name: "Decisions" }));
    expect(screen.getByTestId("calm-decisions")).toHaveTextContent(/notifications/i);
    expect(screen.getByTestId("calm-decisions")).toHaveTextContent(/Accepted version 2/i);
    expect(screen.queryByRole("button", { name: /save|accept|publish/i })).toBeNull();
    await user.click(within(nav).getByRole("button", { name: "Activity" }));
    expect(screen.getByTestId("calm-activity")).toHaveTextContent(/Project decisions updated/i);
  });

  it("keeps the same three destinations and explanation access in a phone-width viewport", async () => {
    const oldWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    try {
      const user = userEvent.setup();
      await renderWithMock(<CalmShell {...commonProps} />, { beats: 4 });
      expect(screen.getByRole("navigation", { name: "Primary" }).querySelectorAll("button")).toHaveLength(3);
      await user.click(await screen.findByRole("button", { name: /Open .*notification/i }));
      await user.click(screen.getByRole("button", { name: "Why this matters" }));
      expect(screen.getByRole("dialog", { name: "Why this matters" })).toBeInTheDocument();
      // jsdom does not implement layout; these are responsive contract checks, not visual screenshots.
      const css = readFileSync(fileURLToPath(new URL("./calm.css", import.meta.url)), "utf8");
      expect(css).toContain("@media (max-width:760px)");
      expect(css).toContain(".calm-inspector {width:100vw");
      expect(css).toContain(".calm-row {display:grid");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: oldWidth });
    }
  });
});
