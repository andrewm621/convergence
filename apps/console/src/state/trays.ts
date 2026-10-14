import { parseRecordRef, type WorkItemState } from "contracts";
import { diffFacets } from "delta-core";
import { analysisOf, builtOnStamps, mergeRecord, quietOf, readyByException, reasonSentences, settingLabel, validExceptions, workItemsSorted } from "./derive";
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

/** Working work the last decision change left alone: shown muted under "Not affected" on the home, so it stays in view. */
export function notAffected(view: ViewState, degraded: boolean): WorkItemState[] {
	if (degraded) return [];
	return workItemsSorted(view).filter((wi) => trayOf(view, wi, degraded) === "working" && quietOf(view, wi) !== null);
}

/**
 * The home's one-line summary of the last decision change, e.g. "notifications v2 landed · 2 settings changed".
 * Null before any change (the seeded first versions are not a change).
 */
export function changeSummary(view: ViewState): { lead: string; detail: string | null } | null {
	const evaluation = view.evaluation;
	const ref = evaluation?.recordRef ? parseRecordRef(evaluation.recordRef) : null;
	if (!evaluation || !ref) return null;
	if (evaluation.proseOnly) return { lead: `${ref.recordId}: wording only`, detail: "no setting changed" };
	if (ref.version <= 1) return null;
	const before = view.records[ref.recordId]?.versions[String(ref.version - 1)];
	const after = view.records[ref.recordId]?.versions[String(ref.version)];
	const changes = before && after ? diffFacets(before, after) : [];
	const names = changes.map((change) => settingLabel(change.key));
	return {
		lead: `${ref.recordId} v${ref.version} landed`,
		detail: changes.length === 0 ? null : `${changes.length === 1 ? "1 setting" : `${changes.length} settings`} changed: ${names.join(", ")}`,
	};
}

/**
 * What happened to a finished work item, in order, read from the audit log: "blocked, revalidated, merged".
 * Each step appears once. Empty when the log in view says nothing about it.
 */
export function historyOf(view: ViewState, workItemId: string): string[] {
	const steps: string[] = [];
	const add = (step: string) => {
		if (!steps.includes(step)) steps.push(step);
	};
	for (const entry of view.ledger) {
		const event = entry.payload.event;
		for (const effect of entry.payload.effects) {
			if (effect.type !== "RECORD_CONDITION" || !("workItemId" in effect) || effect.workItemId !== workItemId) continue;
			if (["Stale", "ClaimConflict", "TestFailed"].includes(effect.condition.type)) add("blocked");
			else if (effect.condition.type === "Uncertain") add("held");
		}
		if (event.type === "DependencyDecided" && event.workItemId === workItemId) add(`dependency ${event.decision}`);
		if (event.type === "ResolutionRecorded" && event.resolution.workItemId === workItemId) {
			const kind = event.resolution.kind;
			add(kind === "revalidate" ? "revalidated" : kind === "accept-exception" ? "allowed with an exception" : "rejected");
		}
		if (event.type === "PromotionMerged" && event.workItemId === workItemId) add("merged");
	}
	return steps;
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
