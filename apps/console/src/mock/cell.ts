import {
	CellSnapshot,
	DeltaEvent,
	fakeSha,
	snapshotHashOf,
	type Actor,
	type AgentActivity,
	type CellState,
	type Dependency,
	type Policy,
	type RecordSnapshot,
	type ScenarioDoc,
	type WorkItem,
	type WorkItemState,
} from "contracts";
import { InMemoryStore, createCellState, currentSnapshot, processEvent, reconcile, type ProcessResult } from "delta-core";
import type { ConsoleMessage } from "@/client/types";

/**
 * The mock runs the real engine in the browser: events go through delta-core's `processEvent`,
 * so every status, edge, reason code and hash-chained ledger line is produced by the same rules
 * the Worker will use. Only the world around it (agents, git, time) is scripted.
 */

/** The parts of a scenario fixture the mock needs. Both fixtures satisfy it structurally. */
export type MockScenario = {
	name: "notifications" | "sales-ops" | "shelter-intake";
	repo: string;
	seed: { baselineCommit: string; snapshotHash: string; records: RecordSnapshot[] };
	policy: Policy;
	actors: Record<string, Actor>;
	workItems: Record<string, WorkItem>;
	dependencies: Record<string, Dependency[]>;
	docs: Record<string, ScenarioDoc>;
	events: Record<string, DeltaEvent>;
	evidence: Record<string, { workItemId?: string; check: string; pass: boolean; output: string }>;
};

export type Emit = (message: ConsoleMessage) => void;

const LEDGER_TAIL = 250;

/** The virtual clock starts here, at the fixtures' own time, so replayed timestamps read consistently. */
export const MOCK_EPOCH = "2026-10-13T15:00:00Z";

/** Virtual wall clock: starts at the fixture's time and moves a few seconds per event. */
export class MockClock {
	#ms: number;
	constructor(startIso: string) {
		this.#ms = Date.parse(startIso);
	}
	next(stepSeconds = 4): string {
		this.#ms += stepSeconds * 1000;
		return new Date(this.#ms).toISOString();
	}
}

export type SentResult = ProcessResult & { ms: number };

export class MockCell {
	readonly scenario: MockScenario;
	readonly store = new InMemoryStore();
	readonly clock: MockClock;
	/** Full file text by blob hash, so the editor can prefill prose. */
	readonly texts = new Map<string, string>();
	readonly activityLog: AgentActivity[] = [];
	readonly evalMs: Record<number, number> = {};
	#shaCounter = 0;
	#muted = false;
	#emit: Emit;

	constructor(scenario: MockScenario, emit: Emit) {
		this.scenario = scenario;
		this.#emit = emit;
		this.clock = new MockClock(MOCK_EPOCH);
		for (const doc of Object.values(scenario.docs)) this.texts.set(doc.snapshot.blobHash, doc.text);
	}

	/** Start from the seeded baseline (records v1, no work) or from an empty workspace. */
	async init(mode: "seeded" | "empty"): Promise<void> {
		const records = mode === "seeded" ? this.scenario.seed.records : [];
		await this.store.init(
			createCellState({
				baselineCommit: mode === "seeded" ? this.scenario.seed.baselineCommit : this.nextSha("b"),
				snapshotHash: mode === "seeded" ? this.scenario.seed.snapshotHash : await snapshotHashOf([]),
				records,
			}),
		);
	}

	nextSha(prefix: "a" | "b" | "c" | "d" | "e" | "f"): string {
		this.#shaCounter += 1;
		return fakeSha(prefix, 700 + this.#shaCounter);
	}

	/** While muted, nothing is emitted: used to replay beats before a single fresh snapshot. */
	mute(value: boolean): void {
		this.#muted = value;
	}

	emit(message: ConsoleMessage): void {
		if (!this.#muted) this.#emit(message);
	}

	async state(): Promise<CellState> {
		const state = await this.store.load();
		if (!state) throw new Error("mock cell is not initialised");
		return state;
	}

	/** Run one event through the real engine, stamp it with the virtual clock, and emit the ledger line. */
	async send(input: DeltaEvent, options: { stepSeconds?: number } = {}): Promise<SentResult> {
		const event = DeltaEvent.parse({ ...input, ts: this.clock.next(options.stepSeconds) });
		const before = await this.state();

		// Time the pure evaluation on its own; the ledger append is not part of "how fast is the referee".
		const started = performance.now();
		reconcile(before, event, this.scenario.policy);
		const ms = performance.now() - started;

		const result = await processEvent(this.store, event, this.scenario.policy);
		if (result.outcome !== "applied") return { ...result, ms };

		const after = await this.state();
		const touched: WorkItemState[] = [];
		for (const [id, wi] of Object.entries(after.workItems)) {
			if (JSON.stringify(before.workItems[id]) !== JSON.stringify(wi)) touched.push(wi);
		}
		if (event.type === "BaselinePushed") this.evalMs[result.entry.seq] = ms;
		this.emit({ type: "event", event: result.entry, workItems: touched, meta: event.type === "BaselinePushed" ? { evaluationMs: ms } : undefined });
		return { ...result, ms };
	}

	async snapshot(): Promise<ConsoleMessage> {
		const state = await this.state();
		const ledger = await this.store.ledger();
		const head = await this.store.head();
		const snapshot: CellSnapshot = {
			scenario: this.scenario.name,
			baselineCommit: state.baselineCommit,
			snapshotHash: state.snapshotHash,
			policy: this.scenario.policy,
			records: state.records,
			workItems: Object.values(state.workItems),
			dependencies: state.dependencies,
			ledgerTail: ledger.slice(-LEDGER_TAIL),
			ledgerHead: head,
		};
		return { type: "snapshot", snapshot, meta: { evaluationMsBySeq: { ...this.evalMs } } };
	}

	async emitSnapshot(): Promise<void> {
		this.#emit(await this.snapshot());
	}

	/** Log (and emit) one line of agent output. */
	say(workItemId: string, kind: AgentActivity["kind"], text: string, runId?: string): void {
		const line: AgentActivity = {
			type: "agent-activity",
			workItemId,
			runId: runId ?? `run-${workItemId.toLowerCase()}`,
			kind,
			text,
			ts: this.clock.next(1),
		};
		this.activityLog.push(line);
		this.emit(line);
	}

	/** The Markdown body (prose, no front-matter) of a record's accepted head. */
	async bodyOf(recordId: string): Promise<string> {
		const head = currentSnapshot(await this.state(), recordId);
		const text = (head && this.texts.get(head.blobHash)) ?? "";
		const lines = text.split("\n");
		const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		return close === -1 ? text : lines.slice(close + 1).join("\n").trim();
	}
}
