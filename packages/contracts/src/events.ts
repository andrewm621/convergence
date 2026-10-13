import { z } from "zod";
import { Actor, CommitSha, FacetKey, FacetValue, IsoTimestamp, Sha256, Slug } from "./common";
import { Condition, ReasonCode, Resolution } from "./conditions";
import { ContextReceipt, RecordSnapshot } from "./context";
import { Dependency, Evidence, WorkItem, WorkItemId } from "./work";

// ---------- facet diffs (shared by effects and the console) ----------

export const FacetChange = z.strictObject({
	key: FacetKey,
	kind: z.enum(["added", "removed", "changed"]),
	from: FacetValue.optional(),
	to: FacetValue.optional(),
});
export type FacetChange = z.infer<typeof FacetChange>;

/** "decision X changed from v1 to v2": drives the diff-aware revalidation prompt. */
export const RecordDiff = z.strictObject({
	recordId: Slug,
	fromVersion: z.number().int().min(1),
	toVersion: z.number().int().min(1),
	changes: z.array(FacetChange),
});
export type RecordDiff = z.infer<typeof RecordDiff>;

// ---------- DeltaEvent: everything the reconciler can be told ----------

const base = { ts: IsoTimestamp };

/** A baseline push. `records` are the context records changed by it (empty if only code moved). */
export const BaselinePushed = z.strictObject({
	type: z.literal("BaselinePushed"),
	...base,
	repo: z.string().min(1),
	commitSha: CommitSha,
	/** Hash of the ContextSnapshot after this push (all accepted heads). Computed by the adapter. */
	snapshotHash: Sha256,
	records: z.array(RecordSnapshot),
	/** Context files in the push that failed to parse. They are never accepted (fail closed). */
	invalid: z.array(z.strictObject({ path: z.string(), error: z.string() })),
});

/** A push to a work item's fork. `claims` is the parsed `.delta/claims.json`, or null if the file is missing. */
export const ForkPushed = z.strictObject({
	type: z.literal("ForkPushed"),
	...base,
	repo: z.string().min(1),
	commitSha: CommitSha,
	workItemId: WorkItemId,
	claims: z.unknown().nullable(),
	/** Paths under `context/` touched in the fork. Never treated as an accepted version. */
	contextPaths: z.array(z.string()),
});

export const EvidenceRecorded = z.strictObject({
	type: z.literal("EvidenceRecorded"),
	...base,
	repo: z.string().min(1),
	commitSha: CommitSha,
	/** One id per execution of the check, so a re-run at the same head (e.g. again at promote) is not dropped as a replay. */
	runId: z.string().min(1),
	evidence: Evidence,
});

export const WorkItemRegistered = z.strictObject({
	type: z.literal("WorkItemRegistered"),
	...base,
	item: WorkItem,
	receipt: ContextReceipt,
	dependencies: z.array(Dependency),
});

export const DependencyDecided = z.strictObject({
	type: z.literal("DependencyDecided"),
	...base,
	requestId: z.string().min(1),
	workItemId: WorkItemId,
	recordId: Slug,
	decision: z.enum(["accepted", "rejected"]),
	actor: Actor,
});

/** A new receipt at current versions, hashed and noted by the adapter after a revalidate (R6). */
export const ReceiptIssued = z.strictObject({
	type: z.literal("ReceiptIssued"),
	...base,
	workItemId: WorkItemId,
	receipt: ContextReceipt,
});

/** A human's Resolution. Recorded in the ledger even when refused, so refusals are auditable. */
export const ResolutionRecorded = z.strictObject({
	type: z.literal("ResolutionRecorded"),
	...base,
	requestId: z.string().min(1),
	resolution: Resolution,
});

export const PromotionRequested = z.strictObject({
	type: z.literal("PromotionRequested"),
	...base,
	requestId: z.string().min(1),
	workItemId: WorkItemId,
	actor: Actor,
	/** Compare-and-swap: the baseline commit the caller believes is current. */
	expectedBaselineCommit: CommitSha,
	forkHeadSha: CommitSha,
});

/** The adapter merged the approved fork into the baseline. */
export const PromotionMerged = z.strictObject({
	type: z.literal("PromotionMerged"),
	...base,
	workItemId: WorkItemId,
	repo: z.string().min(1),
	mergeCommitSha: CommitSha,
});

export const AgentRunStarted = z.strictObject({
	type: z.literal("AgentRunStarted"),
	...base,
	workItemId: WorkItemId,
	runId: z.string().min(1),
	/** Additive and optional: what runs the work, for the console ("openai/gpt-6-luna", or "stub agent"). Display only; nothing decides on it. */
	model: z.string().min(1).max(100).optional(),
});

export const AgentRunFinished = z.strictObject({
	type: z.literal("AgentRunFinished"),
	...base,
	workItemId: WorkItemId,
	runId: z.string().min(1),
	outcome: z.enum(["success", "failure", "cancelled"]),
});

/**
 * The run id the Worker uses to close a revalidation whose dispatch failed without (or after) any real run:
 * an `AgentRunFinished` with outcome `failure` and this id for the revalidate resolution's request key. The
 * reducer treats it as the end of that revalidation, so a job that dies before a run starts cannot leave the
 * item stuck. (An existing event, so older readers need no new case.)
 */
export function dispatchFailedRunId(requestId: string): string {
	return `dispatch-failed:${requestId}`;
}

export const DeltaEvent = z.discriminatedUnion("type", [
	BaselinePushed,
	ForkPushed,
	EvidenceRecorded,
	WorkItemRegistered,
	DependencyDecided,
	ReceiptIssued,
	ResolutionRecorded,
	PromotionRequested,
	PromotionMerged,
	AgentRunStarted,
	AgentRunFinished,
]);
export type DeltaEvent = z.infer<typeof DeltaEvent>;
export type DeltaEventInput = z.input<typeof DeltaEvent>;
export type DeltaEventType = DeltaEvent["type"];

/**
 * R9: events are deduplicated on `(repo, commitSha)` because Queues deliver at least once and the
 * poller can double-fire. Push events use exactly that pair. Events that are not a push (and so
 * have no commit of their own, or share one with a push) are keyed by what makes them unique:
 * Evidence by check and run, a merge by work item and merge commit, commands by their Idempotency-Key.
 */
export function dedupeKey(event: DeltaEvent): string {
	switch (event.type) {
		case "BaselinePushed":
		case "ForkPushed":
			return `${event.repo}@${event.commitSha}`;
		case "EvidenceRecorded":
			return `${event.repo}@${event.commitSha}#evidence:${event.evidence.check}:${event.runId}`;
		case "WorkItemRegistered":
			return `register:${event.item.id}`;
		case "DependencyDecided":
		case "ResolutionRecorded":
		case "PromotionRequested":
			return `cmd:${event.requestId}`;
		case "ReceiptIssued":
			return `receipt:${event.workItemId}:${event.receipt.baselineCommit}:${event.receipt.contextPacketHash}`;
		case "PromotionMerged":
			return `promoted:${event.workItemId}:${event.mergeCommitSha}`;
		case "AgentRunStarted":
			return `run:${event.workItemId}:${event.runId}:started`;
		case "AgentRunFinished":
			return `run:${event.workItemId}:${event.runId}:finished`;
	}
}

/** Commands carry an Idempotency-Key, so a reused key with a different body is a conflict, not a replay. */
export function isCommand(event: DeltaEvent): boolean {
	return event.type === "DependencyDecided" || event.type === "ResolutionRecorded" || event.type === "PromotionRequested";
}

// ---------- Effect: what the reconciler asks the world to do ----------

const effectBase = { reasonCodes: z.array(ReasonCode) };

export const Effect = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("REQUEST_REVALIDATION"),
		workItemId: WorkItemId,
		diff: z.array(RecordDiff),
		...effectBase,
	}),
	z.strictObject({ type: z.literal("BLOCK_PROMOTION"), workItemId: WorkItemId, ...effectBase }),
	z.strictObject({ type: z.literal("REQUEST_REVIEW"), workItemId: WorkItemId, message: z.string(), ...effectBase }),
	z.strictObject({
		type: z.literal("DISPATCH_WORK"),
		workItemId: WorkItemId,
		mode: z.literal("revalidate"),
		diff: z.array(RecordDiff),
		...effectBase,
	}),
	z.strictObject({ type: z.literal("RECORD_CONDITION"), workItemId: WorkItemId, condition: Condition, ...effectBase }),
	/** The promotion gate cleared; the adapter may now merge `forkHeadSha` into the baseline. */
	z.strictObject({
		type: z.literal("ALLOW_PROMOTION"),
		workItemId: WorkItemId,
		forkHeadSha: CommitSha,
		baselineCommit: CommitSha,
		...effectBase,
	}),
	z.strictObject({
		type: z.literal("NO_ACTION"),
		workItemId: WorkItemId.optional(),
		recordId: Slug.optional(),
		message: z.string().optional(),
		...effectBase,
	}),
]);
export type Effect = z.infer<typeof Effect>;
export type EffectType = Effect["type"];

// ---------- ReconciliationEvent: the hash-chained ledger line ----------

export const ReconciliationEvent = z.strictObject({
	seq: z.number().int().min(1),
	prevHash: Sha256,
	hash: Sha256,
	/** The DeltaEvent type this line records (AgentRunStarted, ResolutionRecorded, PromotionMerged, ...). */
	type: z.enum([
		"BaselinePushed",
		"ForkPushed",
		"EvidenceRecorded",
		"WorkItemRegistered",
		"DependencyDecided",
		"ReceiptIssued",
		"ResolutionRecorded",
		"PromotionRequested",
		"PromotionMerged",
		"AgentRunStarted",
		"AgentRunFinished",
	]),
	payload: z.strictObject({ event: DeltaEvent, effects: z.array(Effect) }),
	policyVersion: z.number().int().min(1),
	baselineSha: CommitSha,
	ts: IsoTimestamp,
});
export type ReconciliationEvent = z.infer<typeof ReconciliationEvent>;
