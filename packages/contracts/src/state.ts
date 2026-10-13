import { z } from "zod";
import { CommitSha, Sha256, Slug } from "./common";
import { Condition, Resolution } from "./conditions";
import { ContextReceipt, RecordSnapshot } from "./context";
import { Claim, Dependency, Evidence, WorkItem } from "./work";

/** Every version of a record the cell has seen. `current` is the accepted head (null until one is accepted). */
export const RecordHistory = z.strictObject({
	current: z.number().int().min(1).nullable(),
	/** Keyed by version number as a string (JSON object keys). */
	versions: z.record(z.string(), RecordSnapshot),
	/** The latest proposed (not yet accepted) version, if any. Visible, never governing. */
	proposed: RecordSnapshot.nullable(),
});
export type RecordHistory = z.infer<typeof RecordHistory>;

/** What the last fork push said about claims. Tied to the head it was pushed at. */
export const ClaimsState = z.strictObject({
	headSha: CommitSha,
	status: z.enum(["ok", "missing", "malformed"]),
	claims: z.array(Claim),
	error: z.string().nullable(),
});
export type ClaimsState = z.infer<typeof ClaimsState>;

export const PromotionApproval = z.strictObject({
	forkHeadSha: CommitSha,
	baselineCommit: CommitSha,
	requestId: z.string(),
});
export type PromotionApproval = z.infer<typeof PromotionApproval>;

export const WorkItemState = z.strictObject({
	item: WorkItem,
	receipt: ContextReceipt,
	headSha: CommitSha.nullable(),
	claims: ClaimsState.nullable(),
	evidence: z.array(Evidence),
	conditions: z.array(Condition),
	revalidations: z.number().int().min(0),
	/** True from a `revalidate` Resolution until the agent's next push. */
	revalidating: z.boolean(),
	/** Additive and optional: the run that started while `revalidating` was true. A failed or cancelled finish of this run ends the revalidation (the item can be revalidated again). */
	revalidationRun: z.string().min(1).optional(),
	resolutions: z.array(Resolution),
	promotionApproval: PromotionApproval.nullable(),
	/**
	 * Paths under `context/` the fork changed, from the adapter's tree diff of the fork against its
	 * base, replaced on every push. Non-empty blocks promotion (FORK_EDITS_CONTEXT): agents propose
	 * context changes, they never carry them in through a merge.
	 */
	contextPaths: z.array(z.string()).optional(),
});
export type WorkItemState = z.infer<typeof WorkItemState>;

/**
 * The whole state of one workspace cell. Plain JSON, so any store can persist it. `reconcile`
 * is a pure function of this, an event and a policy.
 */
export const CellState = z.strictObject({
	schemaVersion: z.literal(1),
	baselineCommit: CommitSha,
	/** Hash of the ContextSnapshot of all accepted heads, as supplied by the adapter. */
	snapshotHash: Sha256,
	records: z.record(Slug, RecordHistory),
	workItems: z.record(z.string(), WorkItemState),
	dependencies: z.array(Dependency),
	/** R9: dedupe keys already processed. Value is a fingerprint for commands (else empty). */
	processed: z.record(z.string(), z.string()),
});
export type CellState = z.infer<typeof CellState>;
