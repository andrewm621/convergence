import { z } from "zod";
import { Actor, CommitSha, FacetKey, IsoTimestamp, Sha256, Slug } from "./common";
import { ObjectHash } from "./context";
import { Requirement, WorkItemId } from "./work";

/**
 * Frozen vocabulary of reasons. Every Condition and every Effect carries a list of these, so the
 * console can say why a thing was blocked or left alone. Additions are allowed; renames are not.
 */
export const ReasonCode = z.enum([
	// R1 / R2
	"STALE_RECEIPT",
	"FACET_CHANGED",
	"PROSE_ONLY",
	"NO_DEPENDENCY_ON_CHANGED_FACETS",
	"ALREADY_PROMOTED",
	"NO_CONTEXT_CHANGE",
	"VERSION_NOT_NEWER",
	"IMMUTABLE_VERSION",
	"RECORD_NOT_ACCEPTED",
	"UNKNOWN_CONTEXT_VERSION",
	// R3 / R3b / R4
	"NO_CLAIMS",
	"MALFORMED_CLAIMS",
	"CLAIM_CONFLICT",
	"SUPERSEDED_BASIS",
	"CROSS_CLAIM_CONFLICT",
	"UNDECLARED_DEP",
	"FORK_CONTEXT_IGNORED",
	"FORK_EDITS_CONTEXT",
	"WRONG_RECORD",
	/** Additive on a `CLAIM_CONFLICT`: the claimed value is one the governing record declares in its `not` list for that facet. Changes no verdict. */
	"REJECTED_ALTERNATIVE",
	// R5 gate
	"TEST_FAILED",
	"MISSING_EVIDENCE",
	"HUMAN_RESOLUTION_MISSING",
	"UNRESOLVED_DEPENDENCY",
	"REVALIDATION_PENDING",
	"UNKNOWN_WORK_ITEM",
	"NOT_FRESH",
	// R6
	"REVALIDATION_LIMIT",
	"REVALIDATION_STARTED",
	"RECEIPT_MISMATCH",
	"REVALIDATION_NOT_REQUESTED",
	"NOTHING_TO_REVALIDATE",
	/** A revalidate command refused because one is already under way. (`REVALIDATION_PENDING` is the gate's reason and appears on effects of accepted commands, so it cannot double as a refusal.) */
	"REVALIDATION_IN_PROGRESS",
	// R7
	"FORBIDDEN_ACTOR",
	"STALE_BINDING",
	"BASELINE_MOVED",
	"HEAD_MOVED",
	"EXCEPTION_LAPSED",
	"EXCEPTION_APPLIED",
	"PROMOTION_NOT_APPROVED",
	// R8
	"STALE_EVIDENCE",
	"TESTS_PASSED",
	// R9
	"DUPLICATE_EVENT",
	"IDEMPOTENCY_CONFLICT",
	// misc
	"OBSERVATION_ONLY",
	"DEPENDENCY_DECIDED",
	"ALREADY_RESOLVED",
	"RESOLUTION_REJECTED",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const ConditionType = z.enum([
	"Fresh",
	"Stale",
	"Uncertain",
	"ClaimConflict",
	"TestFailed",
	"TestsPassed",
	"Blocked",
	"Ready",
	"Promoted",
]);
export type ConditionType = z.infer<typeof ConditionType>;

/** An evaluated state on a work item. Presence means the condition holds. */
export const Condition = z.strictObject({
	type: ConditionType,
	workItemId: WorkItemId,
	reasonCodes: z.array(ReasonCode),
	/** Records involved, as `recordId@version` (the version the item holds, or the one that superseded it). */
	recordRefs: z.array(z.string()),
	/** Facets involved. */
	facetKeys: z.array(FacetKey),
	message: z.string(),
	observedAt: IsoTimestamp,
});
export type Condition = z.infer<typeof Condition>;

export const Policy = z.strictObject({
	/** Bumped whenever the policy changes; stamped on every ledger line. */
	version: z.number().int().min(1),
	/** Who may accept changes to each record, and who may grant exceptions against it. */
	authority: z.record(Slug, z.string().min(1)),
	staleness: z.enum(["facet", "record"]),
	/** Global requirements; unioned with each work item's own `requires`. */
	requires: z.array(Requirement),
	maxRevalidations: z.number().int().min(0),
});
export type Policy = z.infer<typeof Policy>;

/** What a Resolution was made against. A context push that lands later cannot slip past it (R7). */
export const ResolutionBinding = z.strictObject({
	recordId: Slug,
	version: z.number().int().min(1),
	blobHash: ObjectHash,
	baseSha: CommitSha,
	forkHeadSha: CommitSha,
	contextSnapshotHash: Sha256,
});
export type ResolutionBinding = z.infer<typeof ResolutionBinding>;

/** A human disposition. Rationale is always required; scope is required for exceptions. */
export const Resolution = z
	.strictObject({
		kind: z.enum(["revalidate", "accept-exception", "reject"]),
		workItemId: WorkItemId,
		actor: Actor,
		rationale: z.string().trim().min(1, "rationale is required"),
		scope: z.string().trim().min(1).optional(),
		binding: ResolutionBinding,
		requestId: z.string().min(1).optional(),
		ts: IsoTimestamp,
	})
	.superRefine((r, ctx) => {
		if (r.kind === "accept-exception" && !r.scope) {
			ctx.addIssue({ code: "custom", path: ["scope"], message: "scope is required for accept-exception" });
		}
	});
export type Resolution = z.infer<typeof Resolution>;
