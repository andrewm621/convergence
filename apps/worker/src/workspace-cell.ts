import { DurableObject } from "cloudflare:workers";

// Skeleton only (M0a). State, ledger and reconcile land in later milestones.
// SQLite-backed via the `new_sqlite_classes` migration in wrangler.jsonc.
export class WorkspaceCell extends DurableObject<Env> {
	async getId(): Promise<string> {
		return this.ctx.id.toString();
	}
}
