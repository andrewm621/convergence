import type { CellState, Dependency, RecordHistory, RecordSnapshot, WorkItemState } from "contracts";

export type CellStateInit = {
	baselineCommit: string;
	snapshotHash: string;
	/** Accepted records at the baseline, e.g. context v1. */
	records: RecordSnapshot[];
};

/** A fresh cell: the baseline and its accepted records, no work yet, nothing processed. */
export function createCellState(init: CellStateInit): CellState {
	const records: CellState["records"] = {};
	for (const snapshot of init.records) {
		const history: RecordHistory = records[snapshot.recordId] ?? { current: null, versions: {}, proposed: null };
		history.versions[String(snapshot.version)] = snapshot;
		if (snapshot.status === "accepted" && (history.current === null || snapshot.version > history.current)) history.current = snapshot.version;
		records[snapshot.recordId] = history;
	}
	return {
		schemaVersion: 1,
		baselineCommit: init.baselineCommit,
		snapshotHash: init.snapshotHash,
		records,
		workItems: {},
		dependencies: [],
		processed: {},
	};
}

/** Work item ids in a stable order, so effects and ledger lines are reproducible. */
export function workItemIds(state: CellState): string[] {
	return Object.keys(state.workItems).sort();
}

export function currentSnapshot(state: CellState, recordId: string): RecordSnapshot | null {
	const history = state.records[recordId];
	if (!history || history.current === null) return null;
	return history.versions[String(history.current)] ?? null;
}

export function snapshotAt(state: CellState, recordId: string, version: number): RecordSnapshot | null {
	return state.records[recordId]?.versions[String(version)] ?? null;
}

export function dependenciesOf(state: CellState, workItemId: string): Dependency[] {
	return state.dependencies.filter((dep) => dep.workItemId === workItemId);
}

export function acceptedDependenciesOf(state: CellState, workItemId: string): Dependency[] {
	return dependenciesOf(state, workItemId).filter((dep) => dep.status === "accepted");
}

/** The last disposition wins: a later `revalidate` clears an earlier `reject`. */
export function isRejected(wi: WorkItemState): boolean {
	return wi.resolutions.at(-1)?.kind === "reject";
}

export function isPromoted(wi: WorkItemState): boolean {
	return wi.item.status === "promoted";
}
