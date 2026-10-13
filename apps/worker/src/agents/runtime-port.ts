import { AgentRuntimeError, type AgentDispatch, type AgentRunView, type AgentRuntimePort } from "../cell/agent-port";
import { DispatchError, dispatchAgent } from "./dispatch";
import type { RunRecord } from "./sandbox";

/** What the cell sees of a run: the fields it acts on, from the sandbox's own record (built from the fork's real history). */
export function toRunView(run: RunRecord): AgentRunView | null {
	if (run.state === "none") return null;
	return {
		runId: run.runId,
		workItemId: run.workItemId,
		state: run.state,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		commit: run.commit,
		pushVerified: run.pushVerified,
		baseHead: run.baseHead,
		author: run.author,
		model: run.mode === "stub" ? "stub agent" : run.model,
		error: run.error,
	};
}

/** Statuses that can clear without anyone changing the request: a run already in flight, the service busy. */
const RETRYABLE = new Set([409, 500, 503]);

/** The real agent runtime: `dispatchAgent` (token, container, outbound handler) and the sandbox's run record. */
export class SandboxAgentRuntime implements AgentRuntimePort {
	readonly #env: Env;

	constructor(env: Env) {
		this.#env = env;
	}

	async dispatch(request: AgentDispatch): Promise<AgentRunView> {
		try {
			const { run } = await dispatchAgent(
				this.#env,
				{ forkRepo: request.forkRepo, workItemId: request.workItemId, prompt: request.prompt, wait: false, revalidate: request.revalidate },
				request.idempotencyKey,
			);
			const view = toRunView(run);
			if (!view) throw new AgentRuntimeError("RUN_MISSING", "the runtime started a run but returned no record of it", true);
			return view;
		} catch (error) {
			if (error instanceof DispatchError) throw new AgentRuntimeError(error.code, error.message, RETRYABLE.has(error.status));
			throw error;
		}
	}

	async status(workItemId: string): Promise<AgentRunView | null> {
		const run = await this.#env.AGENT_SANDBOX.getByName(workItemId).readRun();
		return run ? toRunView(run) : null;
	}
}
