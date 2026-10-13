import type { ScenarioName } from "./types";

/**
 * Every URL the live client uses, in one place. They match the Worker's control loop
 * (docs/control-loop.md): everything is under `/api`, and everything about a work item is
 * scoped to its scenario, because a work item id means nothing without its cell.
 */
const API = "/api";
const scoped = (scenario: ScenarioName) => `${API}/scenarios/${scenario}`;
const item = (scenario: ScenarioName, workItemId: string) => `${scoped(scenario)}/work-items/${encodeURIComponent(workItemId)}`;

export const endpoints = {
	/** WebSocket: `snapshot` first, then `event` and `agent-activity`. Resume with `?since=<seq>`. */
	socket: (scenario: ScenarioName) => `${scoped(scenario)}/ws`,
	/** REST state read (a `CellSnapshot`, with `X-Delta-Poller` for health). The polling fallback and the gap-recovery read. */
	state: (scenario: ScenarioName) => `${scoped(scenario)}/state`,
	gate: (scenario: ScenarioName, workItemId: string) => `${item(scenario, workItemId)}/gate`,
	resolutions: (scenario: ScenarioName, workItemId: string) => `${item(scenario, workItemId)}/resolutions`,
	promote: (scenario: ScenarioName, workItemId: string) => `${item(scenario, workItemId)}/promote`,
	context: (scenario: ScenarioName, recordId: string) => `${scoped(scenario)}/context/${encodeURIComponent(recordId)}`,
	contextChanges: (scenario: ScenarioName) => `${scoped(scenario)}/context-changes`,
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
