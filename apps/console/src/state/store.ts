import type {
	AgentActivity,
	CellSnapshot,
	CellState,
	Dependency,
	Policy,
	ReconciliationEvent,
	RecordHistory,
	RecordSnapshot,
	WorkItemState,
} from "contracts";
import { summarizeEffects } from "delta-core";
import type { ConsoleMessage, PollerHealth } from "@/client/types";

/**
 * Everything the console renders, built only from the WS contract: a `snapshot`, then `event`
 * lines (each with the work items it touched) and `agent-activity` lines.
 */

export type Evaluation = {
	seq: number;
	ts: string;
	/** `recordId@version` of the pushed record, when there is one. */
	recordRef: string | null;
	/** Only prose changed: nothing was evaluated against work, nobody was paged. */
	proseOnly: boolean;
	/** Work items the change was evaluated against. */
	evaluated: number;
	/** Went Stale on this change (some of these may have been stale for an earlier one as well). */
	stale: number;
	/** Left alone by this change, but Stale already from an earlier one. */
	alreadyStale: number;
	/** Left alone by this change and not stale. */
	untouched: number;
	/** Which work items those counts are about, so the strip can be recomputed as they are merged, revalidated or ruled on. */
	staleIds: string[];
	alreadyStaleIds: string[];
	/** Reconciler time for the whole evaluation. Null when the server did not report it. */
	ms: number | null;
};

export type ViewState = {
	ready: boolean;
	scenario: string;
	baselineCommit: string;
	snapshotHash: string;
	policy: Policy | null;
	records: Record<string, RecordHistory>;
	workItems: Record<string, WorkItemState>;
	dependencies: Dependency[];
	ledger: ReconciliationEvent[];
	ledgerHead: { seq: number; hash: string };
	activity: AgentActivity[];
	evaluation: Evaluation | null;
	/** Evaluation time by ledger seq, from the optional `meta` on messages. */
	evalMs: Record<number, number>;
	/** The stream has a gap or a change the event does not describe fully: ask for a fresh snapshot. */
	needsResync: boolean;
	/** Whether the poller that watches the repos is keeping up. Null: the source does not say (the mock). */
	poller: PollerHealth | null;
	/** Bumps on every applied message; lets dependants (the gate preview) re-run. */
	revision: number;
};

export type ViewAction = { type: "message"; message: ConsoleMessage } | { type: "reset" };

const LEDGER_CAP = 400;
const ACTIVITY_CAP = 300;
const GENESIS = "0".repeat(64);

export const initialViewState: ViewState = {
	ready: false,
	scenario: "",
	baselineCommit: "",
	snapshotHash: "",
	policy: null,
	records: {},
	workItems: {},
	dependencies: [],
	ledger: [],
	ledgerHead: { seq: 0, hash: GENESIS },
	activity: [],
	evaluation: null,
	evalMs: {},
	needsResync: false,
	poller: null,
	revision: 0,
};

/** True while the poller reports trouble. Nothing may be shown as Fresh then: a baseline change could be sitting unread. */
export function isDegraded(view: Pick<ViewState, "poller">): boolean {
	return view.poller?.healthy === false;
}

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
	if (action.type === "reset") return initialViewState;
	const { message } = action;
	switch (message.type) {
		case "snapshot":
			return fromSnapshot(state, message.snapshot, message.meta);
		case "agent-activity": {
			const { meta: _meta, ...activity } = message;
			void _meta;
			return { ...state, activity: [...state.activity, activity as AgentActivity].slice(-ACTIVITY_CAP) };
		}
		case "event":
			return fromEvent(state, message.event, message.workItems, message.meta);
	}
}

function fromSnapshot(state: ViewState, snapshot: CellSnapshot, meta: ConsoleMessage["meta"] | undefined): ViewState {
	const workItems: Record<string, WorkItemState> = {};
	for (const wi of snapshot.workItems) workItems[wi.item.id] = wi;
	const evalMs = { ...meta?.evaluationMsBySeq };
	const lastBaseline = [...snapshot.ledgerTail].reverse().find((entry) => entry.payload.event.type === "BaselinePushed" && entry.payload.event.records.length > 0);
	return {
		...state,
		ready: true,
		scenario: snapshot.scenario,
		baselineCommit: snapshot.baselineCommit,
		snapshotHash: snapshot.snapshotHash,
		policy: snapshot.policy,
		records: snapshot.records,
		workItems,
		dependencies: snapshot.dependencies,
		ledger: snapshot.ledgerTail.slice(-LEDGER_CAP),
		ledgerHead: snapshot.ledgerHead,
		// Activity is live-only: a snapshot (poller health change, seq-gap re-read) must not wipe it. "reset" does.
		activity: state.activity,
		evalMs,
		evaluation: lastBaseline ? evaluationOf(lastBaseline, evalMs[lastBaseline.seq] ?? null, workItems) : null,
		needsResync: false,
		poller: meta?.poller ?? state.poller,
		revision: state.revision + 1,
	};
}

function fromEvent(state: ViewState, entry: ReconciliationEvent, touched: WorkItemState[], meta: ConsoleMessage["meta"] | undefined): ViewState {
	if (!state.ready) return state; // a snapshot always comes first
	if (entry.seq <= state.ledgerHead.seq) return state; // replayed line: already applied
	const gap = state.ledgerHead.seq > 0 && entry.seq !== state.ledgerHead.seq + 1;

	const workItems = { ...state.workItems };
	for (const wi of touched) workItems[wi.item.id] = wi;

	let records = state.records;
	let dependencies = state.dependencies;
	let needsResync = state.needsResync || gap;
	const event = entry.payload.event;

	switch (event.type) {
		case "BaselinePushed":
			// The Worker sends the histories of the records it touched; trust them over our own reading of the line.
			records = meta?.records ? { ...state.records, ...meta.records } : applyRecords(state, event.records, entry);
			break;
		case "WorkItemRegistered":
			dependencies = [...dependencies.filter((d) => d.workItemId !== event.item.id), ...event.dependencies.filter((d) => d.workItemId === event.item.id)];
			break;
		case "DependencyDecided":
			dependencies = dependencies.map((d) =>
				d.workItemId === event.workItemId && d.recordId === event.recordId ? { ...d, status: event.decision } : d,
			);
			break;
		default:
			break;
	}
	// The Worker sends the full dependency list whenever an event can change it.
	if (meta?.dependencies) dependencies = meta.dependencies;
	// Otherwise a fork push can add an inferred dependency (R4) that the event does not describe.
	else if (entry.payload.effects.some((effect) => effect.reasonCodes.includes("UNDECLARED_DEP"))) needsResync = true;

	const evalMs = meta?.evaluationMs !== undefined ? { ...state.evalMs, [entry.seq]: meta.evaluationMs } : state.evalMs;
	return {
		...state,
		baselineCommit: meta?.baselineCommit ?? entry.baselineSha,
		snapshotHash: meta?.snapshotHash ?? (event.type === "BaselinePushed" ? event.snapshotHash : state.snapshotHash),
		records,
		workItems,
		dependencies,
		ledger: [...state.ledger, entry].slice(-LEDGER_CAP),
		ledgerHead: { seq: entry.seq, hash: entry.hash },
		evalMs,
		// A baseline push that carries no record (the merge commit of a promotion) evaluated nothing: keep the last real result on the strip.
		evaluation: event.type === "BaselinePushed" ? (evaluationOf(entry, evalMs[entry.seq] ?? null, state.workItems) ?? state.evaluation) : state.evaluation,
		needsResync,
		poller: meta?.poller ?? state.poller,
		revision: state.revision + 1,
	};
}

/** Mirrors how the reconciler files a pushed record: accepted by its authority, or only proposed. */
function applyRecords(state: ViewState, pushed: RecordSnapshot[], entry: ReconciliationEvent): Record<string, RecordHistory> {
	const records: Record<string, RecordHistory> = { ...state.records };
	for (const snap of pushed) {
		const prior = records[snap.recordId];
		const history: RecordHistory = prior
			? { current: prior.current, versions: { ...prior.versions }, proposed: prior.proposed }
			: { current: null, versions: {}, proposed: null };
		records[snap.recordId] = history;

		const refusal = entry.payload.effects.find((effect) => effect.type === "NO_ACTION" && effect.recordId === snap.recordId && effect.reasonCodes.some(isRefusal));
		if (snap.status !== "accepted") {
			if (snap.status === "proposed" && snap.version > (history.current ?? 0)) history.proposed = snap;
			continue;
		}
		if (refusal) {
			if (refusal.reasonCodes.includes("FORBIDDEN_ACTOR")) history.proposed = snap;
			continue;
		}
		history.versions[String(snap.version)] = snap;
		history.current = snap.version;
		if (history.proposed && history.proposed.version <= snap.version) history.proposed = null;
	}
	return records;
}

function isRefusal(code: string): boolean {
	return code === "FORBIDDEN_ACTOR" || code === "IMMUTABLE_VERSION" || code === "VERSION_NOT_NEWER" || code === "RECORD_NOT_ACCEPTED";
}

/**
 * What a baseline push did. `workItems` are the work items as they stood before the push (for a snapshot, as they stand
 * in it), which is how the items it left alone are split into the ones that were already Stale and the ones that are
 * clean: all of them are "untouched" to delta-core, but only one kind is a card that is not red.
 */
/**
 * Work that is still blocked: stale, in conflict, unknown, or being re-run. Merged, ready, up to date and rejected work is not.
 * Lives here (derive re-exports it) so the strip's "already blocked" count and the card's Blocked chip use one definition.
 */
export function stillBlocked(wi: WorkItemState | undefined): boolean {
	return wi !== undefined && ["stale", "conflict", "uncertain", "revalidating"].includes(wi.item.status);
}

export function evaluationOf(entry: ReconciliationEvent, ms: number | null, workItems: Record<string, WorkItemState>): Evaluation | null {
	const event = entry.payload.event;
	if (event.type !== "BaselinePushed" || event.records.length === 0) return null;
	const summary = summarizeEffects(entry.payload.effects);
	const proseOnly = summary.evaluated === 0 && entry.payload.effects.some((effect) => effect.reasonCodes.includes("PROSE_ONLY"));
	const first = event.records[0];
	const staleIds = new Set<string>();
	const leftAlone = new Set<string>();
	for (const effect of entry.payload.effects) {
		if (!("workItemId" in effect) || effect.workItemId === undefined) continue;
		if (effect.type === "RECORD_CONDITION" && effect.condition.type === "Stale") staleIds.add(effect.workItemId);
		if (effect.type === "NO_ACTION" && effect.reasonCodes.includes("NO_DEPENDENCY_ON_CHANGED_FACETS")) leftAlone.add(effect.workItemId);
	}
	// Left alone by this change but blocked all the same (by an earlier change, a claim conflict, an unknown): the card says Blocked, so the strip must not say left alone.
	const alreadyStaleIds = [...leftAlone].filter((id) => !staleIds.has(id) && stillBlocked(workItems[id]));
	const alreadyStale = alreadyStaleIds.length;
	return {
		seq: entry.seq,
		ts: entry.ts,
		recordRef: first ? `${first.recordId}@${first.version}` : null,
		proseOnly,
		evaluated: summary.evaluated,
		stale: summary.stale,
		alreadyStale,
		untouched: summary.untouched - alreadyStale,
		staleIds: [...staleIds].sort(),
		alreadyStaleIds: alreadyStaleIds.sort(),
		ms,
	};
}

/** The shape delta-core's pure analyses expect, rebuilt from what the console holds. */
export function toCellState(view: ViewState): CellState {
	return {
		schemaVersion: 1,
		baselineCommit: view.baselineCommit,
		snapshotHash: view.snapshotHash,
		records: view.records,
		workItems: view.workItems,
		dependencies: view.dependencies,
		processed: {},
	};
}
