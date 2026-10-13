import {
	CellState,
	type Actor,
	type CellState as CellStateType,
	type DeltaEvent,
	type Policy,
	type ResolutionBinding,
	type WorkItemState,
} from "contracts";
import { createCellState, currentSnapshot, type CellStateInit } from "../cell-state";
import { processEvent, type ProcessResult } from "../engine";
import { verifyChain } from "../ledger";
import { InMemoryStore, type CellStore } from "../store";

export type Cell = {
	store: CellStore;
	policy: Policy;
	/** Process an event through the engine and check the persisted state still satisfies the schema. */
	send(event: DeltaEvent): Promise<ProcessResult>;
	state(): Promise<CellStateType>;
	wi(id: string): Promise<WorkItemState>;
	/** The ledger, verified. */
	ledger(): Promise<import("contracts").ReconciliationEvent[]>;
	setPolicy(policy: Policy): void;
};

export async function createCell(seed: CellStateInit, policy: Policy, store: CellStore = new InMemoryStore()): Promise<Cell> {
	await store.init(createCellState(seed));
	const cell: Cell = {
		store,
		policy,
		async send(event) {
			const result = await processEvent(store, event, cell.policy);
			CellState.parse(await store.load());
			return result;
		},
		async state() {
			const state = await store.load();
			if (!state) throw new Error("cell not initialised");
			return state;
		},
		async wi(id) {
			const wi = (await cell.state()).workItems[id];
			if (!wi) throw new Error(`no work item ${id}`);
			return wi;
		},
		async ledger() {
			const entries = await store.ledger();
			const verdict = await verifyChain(entries);
			if (!verdict.ok) throw new Error(`ledger chain broken at ${verdict.brokenAtSeq}: ${verdict.reason}`);
			return entries;
		},
		setPolicy(next) {
			cell.policy = next;
		},
	};
	return cell;
}

/** The binding a console would attach to a resolution made against the state it just showed. */
export function bindingFor(state: CellStateType, workItemId: string, recordId: string): ResolutionBinding {
	const wi = state.workItems[workItemId];
	const record = currentSnapshot(state, recordId);
	if (!wi || !record || wi.headSha === null) throw new Error(`cannot bind ${workItemId}/${recordId}`);
	return {
		recordId,
		version: record.version,
		blobHash: record.blobHash,
		baseSha: state.baselineCommit,
		forkHeadSha: wi.headSha,
		contextSnapshotHash: state.snapshotHash,
	};
}

export function resolutionEvent(
	state: CellStateType,
	o: {
		kind: "revalidate" | "accept-exception" | "reject";
		workItemId: string;
		recordId: string;
		actor: Actor;
		requestId: string;
		ts: string;
		rationale?: string;
		scope?: string;
		binding?: Partial<ResolutionBinding>;
	},
): DeltaEvent {
	return {
		type: "ResolutionRecorded",
		ts: o.ts,
		requestId: o.requestId,
		resolution: {
			kind: o.kind,
			workItemId: o.workItemId,
			actor: o.actor,
			rationale: o.rationale ?? "test rationale",
			...(o.scope ? { scope: o.scope } : {}),
			binding: { ...bindingFor(state, o.workItemId, o.recordId), ...o.binding },
			requestId: o.requestId,
			ts: o.ts,
		},
	};
}

export function promotionEvent(
	state: CellStateType,
	o: { workItemId: string; actor: Actor; requestId: string; ts: string; expectedBaselineCommit?: string; forkHeadSha?: string },
): DeltaEvent {
	const wi = state.workItems[o.workItemId];
	return {
		type: "PromotionRequested",
		ts: o.ts,
		requestId: o.requestId,
		workItemId: o.workItemId,
		actor: o.actor,
		expectedBaselineCommit: o.expectedBaselineCommit ?? state.baselineCommit,
		forkHeadSha: o.forkHeadSha ?? wi?.headSha ?? "0f00000000000000000000000000000000000001",
	};
}

export function effectTypes(result: ProcessResult): string[] {
	return result.effects.map((effect) => effect.type);
}

export function reasonsOf(result: ProcessResult): string[] {
	return [...new Set(result.effects.flatMap((effect) => effect.reasonCodes))];
}

export function conditionTypes(wi: WorkItemState): string[] {
	return wi.conditions.map((c) => c.type);
}
