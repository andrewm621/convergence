import { SandboxAgentRuntime } from "./agents/runtime-port";
import { BindingArtifactsPort } from "./cell/artifacts-port";
import type { AgentRuntimePort } from "./cell/agent-port";
import { CellBase } from "./cell/cell-base";
import type { ArtifactsPort } from "./cell/ports";

// One WorkspaceCell per scenario, on SQLite (the `new_sqlite_classes` migration in wrangler.jsonc).
// The reconciler, store, poller, WebSocket fan-out and promotion live in ./cell; this class only
// says which Artifacts, and which agent runtime, to talk to.
export class WorkspaceCell extends CellBase {
	protected createPort(): ArtifactsPort {
		return new BindingArtifactsPort(this.env);
	}

	/** A revalidation re-dispatches into the AgentSandbox containers (stub or claude, per AGENT_MODE). */
	protected override createAgentRuntime(): AgentRuntimePort | null {
		return this.env.AGENT_SANDBOX ? new SandboxAgentRuntime(this.env) : null;
	}
}
