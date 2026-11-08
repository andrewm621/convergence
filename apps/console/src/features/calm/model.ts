import type { FacetValue, WorkItemState } from "contracts";
import type { ViewState } from "@/state/store";

/**
 * Calm v0.3.1 is a read-only interpretation of the existing v0.1 snapshot.
 * No candidate suggestions, review assignments or new governance statuses live here.
 */
export type CalmGroup = "review" | "moving" | "finished";
export type CalmTone = "attention" | "neutral" | "success" | "unknown";

export type DecisionChange = {
  recordId: string;
  fromVersion: number;
  toVersion: number;
  facetKey: string;
  before: FacetValue | undefined;
  after: FacetValue | undefined;
};

export type CalmWork = {
  wi: WorkItemState;
  group: CalmGroup;
  label: string;
  explanation: string;
  tone: CalmTone;
  changes: DecisionChange[];
};

export function isOutOfDate(view: Pick<ViewState, "poller" | "needsResync">): boolean {
  return view.needsResync || view.poller?.healthy === false;
}

function changed(a: FacetValue | undefined, b: FacetValue | undefined): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Only explain changes for accepted, declared/verified/inferred dependencies, not proposed relationships. */
export function acceptedDecisionChanges(view: ViewState, wi: WorkItemState): DecisionChange[] {
  const receipt = new Map(wi.receipt.accepted.map((entry) => [entry.recordId, entry.version]));
  const found = new Map<string, DecisionChange>();
  for (const dep of view.dependencies) {
    if (dep.workItemId !== wi.item.id || dep.status !== "accepted") continue;
    const oldVersion = receipt.get(dep.recordId);
    const history = view.records[dep.recordId];
    if (!oldVersion || history?.current === null || !history) continue;
    const before = history.versions[String(oldVersion)];
    const after = history.versions[String(history.current)];
    if (!before || !after || after.version <= before.version) continue;
    const keys = dep.facetKeys.length > 0
      ? dep.facetKeys
      : [...new Set([...Object.keys(before.facets), ...Object.keys(after.facets)])];
    for (const key of keys) {
      const fromValue = before.facets[key];
      const toValue = after.facets[key];
      if (changed(fromValue, toValue)) {
        found.set(`${dep.recordId}:${key}`, {
          recordId: dep.recordId, fromVersion: before.version, toVersion: after.version,
          facetKey: key, before: fromValue, after: toValue,
        });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.recordId.localeCompare(b.recordId) || a.facetKey.localeCompare(b.facetKey));
}

function statusPresentation(wi: WorkItemState, outdated: boolean): Pick<CalmWork, "group" | "label" | "explanation" | "tone"> {
  const status = wi.item.status;
  if (status === "promoted") return { group: "finished", label: "Merged", explanation: "This work was merged after the recorded review process.", tone: "success" };
  if (status === "rejected") return { group: "finished", label: "Stopped", explanation: "A person rejected this work. It was not merged.", tone: "neutral" };
  if (status === "stale") return { group: "review", label: "Project decisions changed", explanation: "This work relies on an earlier version of a project decision. A person needs to resolve it.", tone: "attention" };
  if (status === "conflict") return { group: "review", label: "Conflicting information", explanation: "A claim from this work conflicts with an accepted project decision. A person needs to review it.", tone: "attention" };
  if (status === "uncertain") return { group: "review", label: "More information needed", explanation: "The recorded information is incomplete or uncertain. Do not treat this work as approved.", tone: "unknown" };
  if (status === "ready") return outdated
    ? { group: "moving", label: "Checking for updates", explanation: "The monitor is behind. This work cannot be confirmed current yet.", tone: "unknown" }
    : { group: "review", label: "Waiting for a human", explanation: "The last recorded checks allow a merge review, but promotion must recheck current heads and needs a person.", tone: "neutral" };
  if (status === "revalidating") return { group: "moving", label: "Updating for new decisions", explanation: "The work is being checked again against current project decisions.", tone: "neutral" };
  if (status === "fresh") return outdated
    ? { group: "moving", label: "Checking for updates", explanation: "The monitor is behind. Convergence cannot confirm that the work is current.", tone: "unknown" }
    : { group: "moving", label: "No recorded decision change", explanation: "No recorded changes affected the decisions this work declared. This is not a blanket safety check.", tone: "neutral" };
  return { group: "moving", label: outdated ? "Updates may be delayed" : "In progress", explanation: outdated ? "The monitor is behind; the latest work status may not be visible." : "The work is in progress. Convergence has not made a final decision.", tone: "neutral" };
}

export function calmWorkItem(view: ViewState, wi: WorkItemState): CalmWork {
  const presentation = statusPresentation(wi, isOutOfDate(view));
  return { wi, ...presentation, changes: acceptedDecisionChanges(view, wi) };
}

export function calmWorkGroups(view: ViewState): Record<CalmGroup, CalmWork[]> {
  const result: Record<CalmGroup, CalmWork[]> = { review: [], moving: [], finished: [] };
  const items = Object.values(view.workItems).sort((a, b) =>
    a.item.id.localeCompare(b.item.id, undefined, { numeric: true }));
  for (const wi of items) {
    const item = calmWorkItem(view, wi);
    result[item.group].push(item);
  }
  return result;
}

export function humanFacet(key: string): string {
  const known: Record<string, string> = {
    "notifications.default": "Notification default",
    "notifications.cadence": "Delivery timing",
    "notifications.channel": "Notification channel",
  };
  return known[key] ?? key.split(".").at(-1)!.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function humanValue(value: FacetValue | undefined): string {
  if (value === undefined) return "Not specified";
  if (value === null) return "None";
  if (typeof value === "string") {
    const known: Record<string, string> = { on: "On automatically", "opt-in": "Opt in", immediate: "Immediately", "weekly-digest": "Weekly digest" };
    return known[value] ?? value.replace(/-/g, " ");
  }
  if (Array.isArray(value)) return value.map((part) => String(part)).join(", ");
  return String(value);
}
