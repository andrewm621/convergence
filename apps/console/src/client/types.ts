import type { AgentActivity, Dependency, FacetValue, ReasonCode, RecordHistory, ResolutionBinding, WsMessage } from "contracts";

/**
 * The seam between the console and its data. The mock (`src/mock`) and the live client
 * (`src/client/live.ts`) both implement `ConsoleClient`, so switching is one line in `create-client.ts`.
 */

export const SCENARIOS = ["notifications", "shelter-intake", "delta-convergence-build", "sales-ops"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export function isScenarioName(value: string | null | undefined): value is ScenarioName {
	return value === "notifications" || value === "sales-ops" || value === "shelter-intake" || value === "delta-convergence-build";
}

/** The scenarios the Worker can hold a cell for, each as the prefix of a cell name. */
const CELL_PREFIXES = [
	["notifications-", "notifications"],
	["shelter-intake-", "shelter-intake"],
	["sales-ops-", "sales-ops"],
	// Our own build, live: the mock replays it as `delta-convergence-build`; the Worker holds it as a named cell.
	["delta-convergence-build-", "delta-convergence-build"],
] as const;

/** What the Worker accepts as a cell name: 1-40 lowercase letters, digits or dashes (`SCENARIO_NAME` in apps/worker/src/cell/api.ts). */
const CELL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The scenario a named cell shows, read from its name (`notifications-demo` is a notifications cell), or null when the
 * name is not a valid cell name of a known scenario. `?cell=` is only a choice of which cell to display: the bearer
 * token still decides what any request may do, so this keeps the address bar from sending odd paths, nothing more.
 */
export function scenarioOfCell(value: string | null | undefined): ScenarioName | null {
	if (typeof value !== "string" || !CELL_NAME.test(value)) return null;
	for (const [prefix, scenario] of CELL_PREFIXES) if (value.startsWith(prefix) && value.length > prefix.length) return scenario;
	return null;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "polling" | "offline" | "unauthorized" | "mock";

/** Whether the poller that watches the Artifacts repos is keeping up. While it is not, nothing can be called Fresh. */
export type PollerHealth = {
	healthy: boolean;
	degraded: Array<{ repo: string; kind: "baseline" | "fork"; lastError: string | null; note: string | null }>;
};

/** What each data source can do. The mock can do everything; the Worker does not seed, start or diff yet. */
export type Capabilities = {
	/** `POST /scenarios/:s/seed`. */
	seed: boolean;
	/** `POST /scenarios/:s/start`. */
	start: boolean;
	/** `GET /scenarios/:s/work-items/:id/changes`. */
	changes: boolean;
};

/**
 * The side-channel the Worker sends next to every contract `WsMessage` (a top-level `meta` key the
 * strict contract schemas do not know). The live client splits it off before parsing. Every field
 * is optional here: the mock sends only `evaluationMs`.
 */
export type MessageMeta = {
	/** `snapshot`: the ledger head it is current at. `event`: the line's seq. `agent-activity`: the ledger head when it was sent. */
	seq?: number;
	/** `event`: re-sent after a reconnect. */
	replay?: boolean;
	/** `snapshot`: more lines were missed than are replayed. Trust the snapshot, not the replay. */
	gap?: boolean;
	/** On an `event`: reconciler time for that ledger line. */
	evaluationMs?: number;
	/** On a `snapshot`: the same, for the ledger lines it carries. */
	evaluationMsBySeq?: Record<number, number>;
	poller?: PollerHealth;
	/** Live `event` only: what the event cannot say for itself. */
	baselineCommit?: string;
	snapshotHash?: string;
	dependencies?: Dependency[];
	records?: Record<string, RecordHistory>;
};

export type ConsoleMessage = WsMessage & { meta?: MessageMeta };

export type ClientHandlers = {
	onMessage(message: ConsoleMessage): void;
	onConnection(state: ConnectionState): void;
};

/** The dry run behind `GET /scenarios/:s/work-items/:id/gate`. */
export type GateResult = {
	pass: boolean;
	reasonCodes: ReasonCode[];
	/** Human-readable lines, when the server provides them. */
	blockers: string[];
	/** The accepted exceptions (Resolutions) the gate let through. */
	waivedBy: Array<{ kind?: string; scope?: string; rationale?: string; actor?: string }>;
	/** The heads the verdict was computed at, when the server says so. */
	baselineCommit?: string;
	forkHeadSha?: string;
};

export type FileChange = {
	path: string;
	status: "added" | "modified" | "deleted";
	additions: number;
	deletions: number;
	/** Unified diff text for the file. */
	patch: string;
};

export type ContextChangeInput = {
	recordId: string;
	facets: Record<string, FacetValue>;
	prose: string;
	rationale: string;
	/** Compare-and-swap: the baseline commit the editor opened on. The Worker refuses with BASELINE_MOVED if it has moved since. */
	expectedBaselineCommit?: string;
};

export type ResolveInput = {
	kind: "revalidate" | "accept-exception" | "reject";
	workItemId: string;
	rationale: string;
	scope?: string;
	/** What the console showed when the human decided. The server refuses it if the world has moved (R7). */
	binding: ResolutionBinding;
};

/** A human's call on a dependency the engine inferred from an agent's claims (rule R4). Who decides comes from the session. */
export type DecideDependencyInput = {
	workItemId: string;
	/** The record the claims rely on without having been given it. */
	recordId: string;
	decision: "accept" | "reject";
};

export type PromoteInput = {
	workItemId: string;
	/** Compare-and-swap inputs: the baseline and fork head the human was looking at. */
	expectedBaselineCommit: string;
	forkHeadSha: string;
};

/**
 * What the Worker remembers of the latest run of one work item's agent (`GET /api/agents/runs/:agentId`), already checked
 * against the cell: `workItemId` is the cell's id ("WI-1"), and `activity` is in the console's own line shape.
 */
export type AgentRunSummary = {
	workItemId: string;
	/** What ran it ("anthropic/claude-sonnet-5.5", or "stub agent"). Null when the run names none. */
	model: string | null;
	activity: AgentActivity[];
};

export type CommandResult = { ok: true; message?: string } | { ok: false; code: string; message: string; reasonCodes?: ReasonCode[] };

/** Every mutating call carries an Idempotency-Key. */
export type ConsoleApi = {
	gate(workItemId: string): Promise<GateResult>;
	changes(workItemId: string): Promise<FileChange[]>;
	/** The Markdown body (prose) of a record's accepted head, used to prefill the editor. */
	readRecordText(recordId: string): Promise<string>;
	proposeContextChange(input: ContextChangeInput, idempotencyKey: string): Promise<CommandResult>;
	resolve(input: ResolveInput, idempotencyKey: string): Promise<CommandResult>;
	promote(input: PromoteInput, idempotencyKey: string): Promise<CommandResult>;
	/** Accept or reject a dependency the engine inferred (`POST /work-items/:id/dependencies`). Reject clears the hold on the work item. */
	decideDependency(input: DecideDependencyInput, idempotencyKey: string): Promise<CommandResult>;
	/**
	 * The latest run of each work item's agent, for work that ran before the console opened. Runs are keyed by agent id
	 * across every cell, so a run counts only if it ran on that work item's own fork. Never rejects: no run is an empty list.
	 */
	agentRuns(workItems: ReadonlyArray<{ id: string; forkRepo: string }>): Promise<AgentRunSummary[]>;
	/** Empty state: declare the scenario's first decisions. */
	seedScenario(idempotencyKey: string): Promise<CommandResult>;
	/** Create the scenario's work items and start their agents. */
	startScenario(idempotencyKey: string): Promise<CommandResult>;
};

/**
 * One interface for both data sources. It is named for what the T-5 task calls `WsClient`
 * (see the `WsClient` alias below); it also carries the REST commands the console issues.
 */
export type ConsoleClient = {
	readonly kind: "mock" | "live";
	readonly scenario: ScenarioName;
	/** What this data source supports. The UI disables, with a tooltip, whatever it does not. */
	readonly capabilities: Capabilities;
	/** Open the stream: a `snapshot` first, then `event` and `agent-activity` messages. Returns a disposer. */
	connect(handlers: ClientHandlers): () => void;
	/** Ask for a fresh snapshot (REST read in live mode). Used when the stream has a gap. */
	refresh(): Promise<void>;
	api: ConsoleApi;
};

/** The name the T-5 task uses for the interface the mock and the live client share. */
export type WsClient = ConsoleClient;

export function newIdempotencyKey(): string {
	return globalThis.crypto?.randomUUID?.() ?? `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
