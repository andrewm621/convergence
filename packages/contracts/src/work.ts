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
 * What produced a piece of Evidence. Absent means the check's own result, as before (a contract test
 * run by Delta, as the fixtures record it).
 *
 * - `executed-test`: a test suite was executed.
 * - `delta-run-check`: a pure, deterministic assertion the Worker ran on the file contents of a verified
 *   push (rule R8). This is what satisfies a record's `validation:` check.
 * - `delta-claims-check`: the Worker's comparison of the push's claims with the issued receipt. It is derived
 *   from agent-written claims, so it is informational only: the reconciler never counts it as a test result
 *   for any check, passing or failing, so it cannot satisfy or overwrite a validation check. It is NOT a
 *   test, and a console must not present it as one.
 */
export const EvidenceKind = z.enum(["executed-test", "delta-run-check", "delta-claims-check"]);
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
