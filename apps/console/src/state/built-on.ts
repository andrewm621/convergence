import { parseRecordRef, type WorkItemState } from "contracts";
import { analysisOf, changedSettings, currentRecord, quietOf, type ChangedSetting } from "./derive";
import type { ViewState } from "./store";

/**
 * The "Built on" rows of an item page, one per decision the work touches, like the checks on a pull request:
 * ✓ `current`, ✗ `outdated` (built on v1, now v2), ? `not-given` (its claims rely on a decision it was not handed and
 * nobody has ruled on), – `left-alone` (the decision moved, but nothing this work relies on changed). Read-only, from
 * the same analysis the engine runs.
 */
export type BuiltOnState = "current" | "outdated" | "not-given" | "left-alone";

export type BuiltOnRow = {
	recordId: string;
	state: BuiltOnState;
	/** The version this work was built on: its receipt, else the version its claims cite. Null when neither says. */
	builtOnVersion: number | null;
	currentVersion: number | null;
	/** For `outdated`: the settings it relies on that changed since. */
	changedSettings: ChangedSetting[];
	/** One plain line for the row. */
	detail: string;
};

const ORDER: Record<BuiltOnState, number> = { outdated: 0, "not-given": 1, "left-alone": 2, current: 3 };

/** The version a work item's claims cite for one decision, when they cite one. */
function citedVersion(wi: WorkItemState, recordId: string): number | null {
	const claims = wi.claims;
	if (!claims || claims.status !== "ok") return null;
	for (const claim of claims.claims) {
		const ref = parseRecordRef(claim.basedOn);
		if (ref?.recordId === recordId) return ref.version;
	}
	return null;
}

export function builtOnRows(view: ViewState, wi: WorkItemState): BuiltOnRow[] {
	const analysis = analysisOf(view, wi.item.id);
	if (!analysis) return [];
	const rows = new Map<string, BuiltOnRow>();
	const settings = changedSettings(view, analysis);

	for (const finding of analysis.stale) {
		const from = finding.fromVersion === 0 ? null : finding.fromVersion;
		rows.set(finding.recordId, {
			recordId: finding.recordId,
			state: "outdated",
			builtOnVersion: from,
			currentVersion: finding.toVersion,
			changedSettings: settings.filter((s) => s.recordId === finding.recordId),
			detail: from === null ? `built without it, now v${finding.toVersion}` : `built on v${from}, now v${finding.toVersion}`,
		});
	}

	for (const outside of analysis.outsideReceipt) {
		if (rows.has(outside.recordId)) continue;
		rows.set(outside.recordId, {
			recordId: outside.recordId,
			state: "not-given",
			builtOnVersion: citedVersion(wi, outside.recordId),
			currentVersion: currentRecord(view, outside.recordId)?.version ?? null,
			changedSettings: [],
			detail: "its claims rely on this, but it wasn't given it",
		});
	}

	for (const entry of wi.receipt.accepted) {
		if (rows.has(entry.recordId)) continue;
		const now = currentRecord(view, entry.recordId)?.version ?? null;
		const moved = now !== null && now !== entry.version;
		rows.set(entry.recordId, {
			recordId: entry.recordId,
			state: moved ? "left-alone" : "current",
			builtOnVersion: entry.version,
			currentVersion: now,
			changedSettings: [],
			detail: moved ? `built on v${entry.version}, now v${now}; nothing it relies on changed` : `built on v${entry.version}, the current version`,
		});
	}

	// The decision the last change left this work alone on, when the work was never handed it.
	const quiet = quietOf(view, wi);
	const quietRef = quiet?.recordRef ? parseRecordRef(quiet.recordRef) : null;
	if (quietRef && !rows.has(quietRef.recordId)) {
		rows.set(quietRef.recordId, {
			recordId: quietRef.recordId,
			state: "left-alone",
			builtOnVersion: null,
			currentVersion: currentRecord(view, quietRef.recordId)?.version ?? quietRef.version,
			changedSettings: [],
			detail: `changed to v${quietRef.version}; this work doesn't rely on it`,
		});
	}

	return [...rows.values()].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.recordId.localeCompare(b.recordId));
}
