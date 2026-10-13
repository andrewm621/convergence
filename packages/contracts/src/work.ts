import { z } from "zod";
import { Actor, CommitSha, FacetKey, FacetValue, RecordRefString, Slug } from "./common";

export const WorkItemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "invalid work item id");
export type WorkItemId = z.infer<typeof WorkItemId>;

/** What must hold before a work item may be promoted (in addition to being Fresh). */
export const Requirement = z.enum(["contract-test", "human-resolution"]);
export type Requirement = z.infer<typeof Requirement>;

export const WorkItemStatus = z.enum([
	"running",
	"fresh",
	"stale",
	"uncertain",
	"conflict",
	"revalidating",
	"ready",
	"promoted",
	"rejected",
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatus>;

/**
 * A task for one agent on its own fork. `source: seeded` items are synthetic (the fan-out beat)
 * and the UI must always label them "seeded".
 */
export const WorkItem = z.strictObject({
	id: WorkItemId,
	title: z.string().min(1),
	actor: Actor,
	forkRepo: z.string().min(1),
	source: z.enum(["live", "seeded"]),
	intent: z.enum(["delivery", "exploratory"]),
	requires: z.array(Requirement),
	status: WorkItemStatus,
	participants: z.array(Actor).optional(),
});
export type WorkItem = z.infer<typeof WorkItem>;

/** Only `accepted` dependencies gate work. `proposed` ones are a human's to accept or reject. */
export const Dependency = z.strictObject({
	workItemId: WorkItemId,
	recordId: Slug,
	/** Facets relied on. Empty means "the whole record". */
	facetKeys: z.array(FacetKey),
	basis: z.enum(["declared", "verified", "inferred"]),
	status: z.enum(["proposed", "accepted", "rejected"]),
	evidenceRefs: z.array(z.string()),
});
export type Dependency = z.infer<typeof Dependency>;

/** A structured assertion by the agent. Self-reported, so the UI labels it "agent-asserted, unverified". */
export const Claim = z.strictObject({
	subject: FacetKey,
	value: FacetValue,
	basedOn: RecordRefString,
});
export type Claim = z.infer<typeof Claim>;

/** Shape of `.delta/claims.json` in a fork. */
export const ClaimsFile = z.array(Claim);
export type ClaimsFile = z.infer<typeof ClaimsFile>;

/**
 * What produced a piece of Evidence. Absent means the check's own result, as before (a Delta-run
 * contract test). `delta-claims-check` is the Worker's own deterministic check that a verified push's
 * claims cite the issued receipt and agree with the accepted facets; it is NOT an executed test, and a
 * console must not present it as one.
 */
export const EvidenceKind = z.enum(["executed-test", "delta-claims-check"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** Result of a Delta-run check at a specific head (rule R8). */
export const Evidence = z.strictObject({
	workItemId: WorkItemId,
	headSha: CommitSha,
	check: z.string().min(1),
	pass: z.boolean(),
	output: z.string(),
	/** Additive and optional: contracts-v1 stays valid without it. */
	kind: EvidenceKind.optional(),
});
export type Evidence = z.infer<typeof Evidence>;
