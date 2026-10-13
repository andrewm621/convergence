import { parseContextRecord, runStubAgent } from "../../../container/stub-agent-lib";
import { AgentRuntimeError, type AgentDispatch, type AgentRunView, type AgentRuntimePort } from "../agent-port";
import type { FakeWorld } from "./fake-artifacts";

// A scripted agent runtime for the cell tests. It does what the real runtime does where the cell can
// tell: a run starts and is "running" until it is settled, then it pushes to the fork through the
// in-memory Artifacts as author `workitem-<id>`, with the stub agent's deterministic output (claims that
// cite the context it was handed), and reports the verified commit. Behaviour knobs let a test hold a
// run open or make it end the ways the real runtime can: no push, a failure, claims that were not
// updated.
//
// What it does not prove: the container, the token and gateway handling, and push verification. Those
// are the runtime's own tests and the live checks (docs/agent-runtime.md).

export type FakeAgentBehavior = {
	/** A run stays "running" this long after it starts (ms). */
	delayMs: number;
	/** Keep every run open until `release()`. */
	hold: boolean;
	/** What the run does when it settles. */
	outcome: "push" | "no-push" | "fail" | "keep-old-claims" | "wrong-code" | "missing-facet";
	/** Make this many dispatch calls throw a retryable runtime error first. */
	failDispatches: number;
	/** The error code those throws carry (`RUN_IN_PROGRESS` is the busy runtime). */
	failCode: string;
	/** Whether those throws are retryable (a refusal the runtime will never accept is not). */
	failRetryable: boolean;
	/** The model the run reports. */
	model: string;
};

type Run = { view: AgentRunView; dueMs: number; request: AgentDispatch };

export class FakeAgentRuntime implements AgentRuntimePort {
	readonly calls: AgentDispatch[] = [];
	behavior: FakeAgentBehavior = { delayMs: 0, hold: false, outcome: "push", failDispatches: 0, failCode: "UNAVAILABLE", failRetryable: true, model: "stub agent" };
	readonly #world: FakeWorld;
	readonly #runs = new Map<string, Run>();
	readonly #keys = new Map<string, string>();
	#counter = 0;

	constructor(world: FakeWorld) {
		this.#world = world;
	}

	setBehavior(patch: Partial<FakeAgentBehavior>): void {
		this.behavior = { ...this.behavior, ...patch };
	}

	release(): void {
		this.behavior = { ...this.behavior, hold: false };
	}

	async dispatch(request: AgentDispatch): Promise<AgentRunView> {
		this.calls.push(request);
		const replay = this.#keys.get(request.idempotencyKey);
		if (replay) return { ...(this.#runs.get(replay) as Run).view };
		if (this.behavior.failDispatches > 0) {
			this.behavior = { ...this.behavior, failDispatches: this.behavior.failDispatches - 1 };
			throw new AgentRuntimeError(this.behavior.failCode, "the runtime is busy", this.behavior.failRetryable);
		}
		if (this.#runs.get(request.workItemId)?.view.state === "running") {
			throw new AgentRuntimeError("RUN_IN_PROGRESS", `work item ${request.workItemId} already has a run in flight`, true);
		}
		const baseHead = this.#world.headOf(request.forkRepo);
		const view: AgentRunView = {
			runId: `run-${request.workItemId}-${++this.#counter}`,
			workItemId: request.workItemId,
			state: "running",
			startedAt: new Date().toISOString(),
			finishedAt: null,
			commit: null,
			pushVerified: null,
			baseHead,
			author: `workitem-${request.workItemId}`,
			model: this.behavior.model,
			error: null,
		};
		this.#runs.set(request.workItemId, { view, dueMs: Date.now() + this.behavior.delayMs, request });
		this.#keys.set(request.idempotencyKey, request.workItemId);
		return { ...view };
	}

	async status(workItemId: string): Promise<AgentRunView | null> {
		const run = this.#runs.get(workItemId);
		if (!run) return null;
		if (run.view.state === "running" && !this.behavior.hold && Date.now() >= run.dueMs) await this.#settle(run);
		return { ...run.view };
	}

	async #settle(run: Run): Promise<void> {
		const { request, view } = run;
		const finish = (patch: Partial<AgentRunView>) => Object.assign(view, { finishedAt: new Date().toISOString() }, patch);
		const outcome = this.behavior.outcome;
		if (outcome === "fail") {
			finish({ state: "failed", error: "the agent exited with code 3", pushVerified: null });
			return;
		}
		if (outcome === "no-push") {
			finish({ state: "failed", error: "revalidation produced no commit", pushVerified: false });
			return;
		}
		const contextFiles = Object.fromEntries(Object.entries(request.revalidate.context).map(([name, text]) => [`.delta/context/${name}`, text]));
		// The dispatcher delivers exactly the receipt's records, so the delivered ids are the context's.
		const deliveredIds = Object.values(request.revalidate.context).flatMap((text) => parseContextRecord(text)?.id ?? []);
		const out = runStubAgent({ workItemId: request.workItemId, prompt: request.prompt, contextFiles, deliveredIds, indexTs: this.#world.filesAt(request.forkRepo)["src/index.ts"] ?? null });
		const files: Record<string, string> = { ...out.files, ...contextFiles };
		// An agent that changed the code but never touched its claims leaves the old claims file in the tree.
		if (outcome === "keep-old-claims") delete files[".delta/claims.json"];
		// An agent whose claims cite the new versions while its code still holds other values: only a check on the code can tell.
		if (outcome === "wrong-code") {
			for (const [path, text] of Object.entries(files)) {
				if (path.startsWith("src/work/")) files[path] = text.replace(/^(export const \w+ = ).*?;/gm, '$1"previous";');
			}
		}
		// An agent that writes code for some of the facets it relies on and leaves one undeclared (the status facets).
		if (outcome === "missing-facet") {
			for (const [path, text] of Object.entries(files)) {
				if (path.startsWith("src/work/")) files[path] = text.replace(/^export const STATUS_.*\n/gm, "");
			}
		}
		const commit = await this.#world.push(request.forkRepo, files, { author: view.author, message: `revalidate: ${request.prompt}` });
		finish({ state: "succeeded", commit, pushVerified: true });
	}
}
