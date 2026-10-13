import { BindingArtifactsPort } from "./cell/artifacts-port";
import { CellBase } from "./cell/cell-base";
import type { ArtifactsPort } from "./cell/ports";

// One WorkspaceCell per scenario, on SQLite (the `new_sqlite_classes` migration in wrangler.jsonc).
// The reconciler, store, poller, WebSocket fan-out and promotion live in ./cell; this class only
// says which Artifacts to talk to.
export class WorkspaceCell extends CellBase {
	protected createPort(): ArtifactsPort {
		return new BindingArtifactsPort(this.env);
	}
}
