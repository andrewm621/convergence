import type { WorkItemState } from "contracts";
import { analysisOf, builtOnStamps, mergeRecord, quietOf, readyByException, reasonSentences, validExceptions, workItemsSorted } from "./derive";
import type { ViewState } from "./store";

/**
 * The home screen sorts work into four trays. Only "Needs you" asks anything of a person; the other three are counts
 * behind tabs. A tray is read from the work item's status alone, so the home agrees with every chip in the console.
 */
export type Tray = "needs-you" | "working" | "ready" | "merged";

export const TRAYS: readonly Tray[] = ["needs-you", "working", "ready", "merged"];

export const TRAY_LABEL: Record<Tray, string> = { "needs-you": "Needs you", working: "Working", ready: "Ready", merged: "Merged" };

/**
 * Blocked or held work needs a person. Running, re-running and up-to-date work is still working. Ready work waits to be
 * merged; merged and rejected work is done. While the poller is degraded nothing can be confirmed current, so work that
 * reads up to date or ready stays in Working (shown as unconfirmed) rather than offering a merge.
 */
export function trayOf(_view: ViewState, wi: WorkItemState, degraded: boolean): Tray {
	switch (wi.item.status) {
		case "stale":
		case "conflict":
		case "uncertain":
			return "needs-you";
		case "running":
		case "revalidating":
		case "fresh":
			return "working";
		case "ready":
			return degraded ? "working" : "ready";
		case "promoted":
		case "rejected":
			return "merged";
	}
}

/** Every work item by tray, in id order. */
export function groupByTray(view: ViewState, degraded: boolean): Record<Tray, WorkItemState[]> {
	const out: Record<Tray, WorkItemState[]> = { "needs-you": [], working: [], ready: [], merged: [] };
	for (const wi of workItemsSorted(view)) out[trayOf(view, wi, degraded)].push(wi);
	return out;
}

/**
 * The one reason line under a tray row. Blocked work leads with the stamp the video names ("Built on notifications v1 · now v2"),
 * held work with the decision its claims rely on but it was not given, everything else with where it stands.
 */
export function rowReason(view: ViewState, wi: WorkItemState, degraded: boolean): string {
	const tray = trayOf(view, wi, degraded);
	if (tray === "needs-you") {
		const analysis = analysisOf(view, wi.item.id);
		if (analysis) {
			const stamps = builtOnStamps(analysis);
			if (stamps.length > 0) return stamps.join("; ");
			const outside = analysis.outsideReceipt[0];
			if (outside) return `Claims rely on ${outside.recordId}, which it wasn't given.`;
			const first = reasonSentences(view, analysis)[0];
			if (first) return first;
		}
		return wi.item.status === "uncertain" ? "Convergence can't tell whether this is built on the current decisions." : "Blocked. Open it to see why.";
	}
	if (tray === "merged") {
		if (wi.item.status === "rejected") return "Rejected by a person.";
		const merged = mergeRecord(view, wi.item.id);
		return merged?.by ? `Merged by ${merged.by}.` : "Merged.";
	}
	if (degraded && (wi.item.status === "fresh" || wi.item.status === "ready")) return "Unconfirmed: the poller is behind, so this can't be shown as current.";
	if (wi.item.status === "revalidating") return "Re-running on the current decisions.";
	if (tray === "ready") {
		if (readyByException(view, wi)) {
			const exception = validExceptions(view, wi)[0];
			return `Ready with an exception from ${exception?.signer ?? "a person"}${exception?.scope ? `: ${exception.scope}` : ""}.`;
		}
		return "Passed the merge check. Waiting for a person to merge it.";
	}
	const quiet = quietOf(view, wi);
	if (quiet) return quiet.recordRef ? `Left alone by the change to ${quiet.recordRef.replace("@", " v")}: nothing it relies on changed.` : "Left alone: nothing it relies on changed.";
	if (wi.item.status === "fresh") return "Up to date. Not ready to merge yet.";
	return wi.headSha === null ? "Agent working. Nothing pushed yet." : "Agent working.";
}
