import { describe, expect, it } from "vitest";
import { startMock } from "@/test/harness";
import { acceptedDecisionChanges, calmWorkGroups, calmWorkItem, humanFacet, isOutOfDate } from "./model";

describe("calm read-only model on the normative v0.1 mock", () => {
  it("keeps the unaffected item separate after accepted notification facets change", async () => {
    const run = await startMock();
    try {
      await run.jump(4);
      const review = calmWorkGroups(run.view).review;
      expect(review.map((w) => w.wi.item.id)).toContain("WI-2");
      const changed = acceptedDecisionChanges(run.view, run.view.workItems["WI-2"]!);
      expect(changed.map((c) => c.facetKey)).toContain("notifications.default");
      expect(changed.map((c) => c.facetKey)).toContain("notifications.cadence");
      expect(calmWorkItem(run.view, run.view.workItems["WI-1"]!).group).toBe("moving");
    } finally { run.stop(); }
  });

  it("never treats a proposed relationship as a recorded dependency", async () => {
    const run = await startMock();
    try {
      await run.jump(4);
      const work = run.view.workItems["WI-2"]!;
      const withProposal = { ...run.view, dependencies: [
        ...run.view.dependencies,
        { workItemId: work.item.id, recordId: "status-model", facetKeys: [], basis: "inferred" as const, status: "proposed" as const, evidenceRefs: [] },
      ] };
      expect(acceptedDecisionChanges(withProposal, work)).toEqual(acceptedDecisionChanges(run.view, work));
    } finally { run.stop(); }
  });

  it("does not call Ready current when the poller is behind", async () => {
    const run = await startMock();
    try {
      await run.jump(5);
      const wi = run.view.workItems["WI-1"]!;
      expect(wi.item.status).toBe("ready");
      const staleView = { ...run.view, poller: { healthy: false, degraded: [{ repo: "baseline", kind: "baseline" as const, lastError: "offline", note: null }] } };
      expect(isOutOfDate(staleView)).toBe(true);
      expect(calmWorkItem(staleView, wi)).toMatchObject({ group: "moving", label: "Checking for updates" });
    } finally { run.stop(); }
  });

  it("puts recorded Ready work under review rather than Finished", async () => {
    const run = await startMock();
    try {
      await run.jump(5);
      const item = calmWorkItem(run.view, run.view.workItems["WI-1"]!);
      expect(item.group).toBe("review");
      expect(item.label).toBe("Waiting for a human");
    } finally { run.stop(); }
  });

  it("uses accessible plain-language facet labels", () => {
    expect(humanFacet("notifications.default")).toBe("Notification default");
    expect(humanFacet("payments.authorization")).toBe("Authorization");
  });
});
