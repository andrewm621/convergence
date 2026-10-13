import { z } from "zod";
import { CommitSha, IsoTimestamp, Sha256 } from "./common";
import { Policy } from "./conditions";
import { ReconciliationEvent } from "./events";
import { RecordHistory, WorkItemState } from "./state";
import { Dependency, WorkItemId } from "./work";

/** What the console renders: the cell state minus internals, plus the ledger tail. */
export const CellSnapshot = z.strictObject({
	scenario: z.string(),
	baselineCommit: CommitSha,
	snapshotHash: Sha256,
	policy: Policy,
	records: z.record(z.string(), RecordHistory),
	workItems: z.array(WorkItemState),
	dependencies: z.array(Dependency),
	ledgerTail: z.array(ReconciliationEvent),
	ledgerHead: z.strictObject({ seq: z.number().int().min(0), hash: Sha256 }),
});
export type CellSnapshot = z.infer<typeof CellSnapshot>;

/** One line of live agent output (stream-json from the sandbox or the local runner). */
export const AgentActivity = z.strictObject({
	type: z.literal("agent-activity"),
	workItemId: WorkItemId,
	runId: z.string().min(1),
	kind: z.enum(["status", "tool", "text", "error"]),
	text: z.string(),
	ts: IsoTimestamp,
});
export type AgentActivity = z.infer<typeof AgentActivity>;

/**
 * Server to console over the WebSocket. The console is built against typed mocks of this union:
 * `snapshot` on connect, then `event` per ledger line (with the work items it touched) and
 * `agent-activity` per stream line.
 */
export const WsMessage = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("snapshot"), snapshot: CellSnapshot }),
	z.strictObject({ type: z.literal("event"), event: ReconciliationEvent, workItems: z.array(WorkItemState) }),
	AgentActivity,
]);
export type WsMessage = z.infer<typeof WsMessage>;
