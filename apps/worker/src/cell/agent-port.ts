import type { Revalidate } from "../agents/protocol";

// Everything the cell needs from the agent runtime, behind one narrow interface, like ports.ts for
// Artifacts. The real one (agents/runtime-port.ts) drives the AgentSandbox containers; tests use a
// scripted runtime that pushes to the in-memory Artifacts (testing/fake-agent.ts).
//
// Ids here are the RUNTIME's (lowercase `wi-2`); agents/work-item-ids.ts is the only translation.
//
// Trust: a run view is built by the runtime from the fork's real history, not from what the
// container said (see "Trust model" in docs/agent-runtime.md), but the cell still re-checks the one
// thing it acts on, the pushed commit, against the repo before it records anything from it.

export type AgentRunState = "running" | "succeeded" | "failed" | "lost";

export interface AgentRunView {
	runId: string;
	/** The runtime's id for the work item. */
	workItemId: string;
	state: AgentRunState;
	/** ISO instants. `finishedAt` is null while the run is in flight. */
	startedAt: string;
	finishedAt: string | null;
	/** The fork head the run produced, set only when the fork's history agreed. */
	commit: string | null;
	pushVerified: boolean | null;
	/** Fork head before the run. */
	baseHead: string | null;
	/** What runs the work, for display: the model slug, or "stub agent" in stub mode. */
	model: string;
	/** Commit author the run's pushes carry (`workitem-wi-2`). */
	author: string;
	error: string | null;
}

export interface AgentDispatch {
	/** The runtime's id for the work item. */
	workItemId: string;
	forkRepo: string;
	prompt: string;
	/** The new context packet and what changed, for the diff-aware re-run. */
	revalidate: Revalidate;
	/** Same key, same request: the runtime returns the run it already started and mints nothing. */
	idempotencyKey: string;
}

/** A dispatch problem. `retryable` is true for conditions that can clear on their own (a run still in flight, a transient failure). */
export class AgentRuntimeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "AgentRuntimeError";
	}
}

export interface AgentRuntimePort {
	/** Start the run and return as soon as it is started (never wait for it to finish). */
	dispatch(request: AgentDispatch): Promise<AgentRunView>;
	/** The latest run for a work item, or null if there never was one. */
	status(workItemId: string): Promise<AgentRunView | null>;
}
