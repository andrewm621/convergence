
/**
 * Every URL the live client uses, in one place. They match the Worker's control loop
 * (docs/control-loop.md): everything is under `/api`, and everything about a work item is
 * scoped to its scenario, because a work item id means nothing without its cell.
 */
const API = "/api";
/** A cell is named after its scenario (`notifications`) or, for a demo, `<scenario>-<suffix>` (`notifications-demo`). */
type Cell = string;
const scoped = (scenario: Cell) => `${API}/scenarios/${scenario}`;
const item = (scenario: Cell, workItemId: string) => `${scoped(scenario)}/work-items/${encodeURIComponent(workItemId)}`;

export const endpoints = {
	/** WebSocket: `snapshot` first, then `event` and `agent-activity`. Resume with `?since=<seq>`. */
	socket: (scenario: Cell) => `${scoped(scenario)}/ws`,
	/** REST state read (a `CellSnapshot`, with `X-Delta-Poller` for health). The polling fallback and the gap-recovery read. */
	state: (scenario: Cell) => `${scoped(scenario)}/state`,
	gate: (scenario: Cell, workItemId: string) => `${item(scenario, workItemId)}/gate`,
	resolutions: (scenario: Cell, workItemId: string) => `${item(scenario, workItemId)}/resolutions`,
	dependencies: (scenario: Cell, workItemId: string) => `${item(scenario, workItemId)}/dependencies`,
	promote: (scenario: Cell, workItemId: string) => `${item(scenario, workItemId)}/promote`,
	context: (scenario: Cell, recordId: string) => `${scoped(scenario)}/context/${encodeURIComponent(recordId)}`,
	/** Not scoped to a cell: the latest run of the agent with this id (the lowercase work item id), whichever cell it ran for. */
	agentRun: (agentId: string) => `${API}/agents/runs/${encodeURIComponent(agentId)}`,
	contextChanges: (scenario: Cell) => `${scoped(scenario)}/context-changes`,
} as const;

/**
 * Not implemented by the Worker yet (see "Not implemented" in docs/control-loop.md): per-file diffs,
 * and the one-click seed and start. The live client reports them as unavailable (`capabilities`)
 * and the console disables the actions with a tooltip instead of calling a route that does not exist.
 */
export const NOT_IMPLEMENTED = {
	changes: "GET /api/scenarios/:s/work-items/:id/changes",
	seed: "POST /api/scenarios/:s/seed",
	start: "POST /api/scenarios/:s/start",
} as const;
