import { z } from "zod";
import { CommitSha, FacetKey, Policy, ResolutionBinding, Slug, WorkItemId, WsMessage, type Effect, type ReasonCode } from "contracts";

// Request and response shapes for the cell API. Every request body is a strict object: an unknown
// key, such as `actor`, is a 400. Who is acting never comes from a body (see auth.ts).

export const REPO_NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "expected a valid Artifacts repo name");
export const SCENARIO_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:~-]{1,128}$/;

export const InitRequest = z.strictObject({
	baselineRepo: REPO_NAME,
	policy: Policy,
});
export type InitRequest = z.infer<typeof InitRequest>;

export const RegisterRequest = z.strictObject({
	id: WorkItemId,
	title: z.string().trim().min(1).max(200),
	forkRepo: REPO_NAME,
	/** The agent working on it. Its kind is always "agent"; a body cannot make it anything else. */
	agent: z.strictObject({ id: z.string().min(1).max(64), displayName: z.string().min(1).max(100).optional() }).optional(),
	source: z.enum(["live", "seeded"]).default("live"),
	intent: z.enum(["delivery", "exploratory"]).default("delivery"),
	requires: z.array(z.enum(["contract-test", "human-resolution"])).default([]),
	/** The records the work relies on, and which facets of them. They form the receipt. */
	dependencies: z.array(z.strictObject({ recordId: Slug, facetKeys: z.array(FacetKey).default([]) })).default([]),
	/** The baseline commit the fork was made from. Defaults to the baseline as the cell knows it now. */
	baseCommit: CommitSha.optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const ResolveRequest = z.strictObject({
	kind: z.enum(["revalidate", "accept-exception", "reject"]),
	rationale: z.string().trim().min(1).max(2000),
	scope: z.string().trim().min(1).max(500).optional(),
	/** What the human was looking at; the reconciler refuses it if anything has moved since (R7). */
	binding: ResolutionBinding,
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;

export const PromoteRequest = z.strictObject({
	/** Compare-and-swap: the baseline commit the caller saw. */
	expectedBaselineCommit: CommitSha,
	forkHeadSha: CommitSha,
});
export type PromoteRequest = z.infer<typeof PromoteRequest>;

/** What a cell method hands back to the HTTP layer. */
export type CellResult = { status: number; body: unknown; replay?: boolean };

export function failure(status: number, code: string, message: string, extra: Record<string, unknown> = {}): CellResult {
	return { status, body: { error: { code, message, ...extra } } };
}

export function issuesOf(error: z.ZodError): Array<{ path: string; message: string }> {
	return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

export function invalidInput(error: z.ZodError, what: string): CellResult {
	return failure(400, "INVALID_INPUT", `invalid ${what}`, { issues: issuesOf(error) });
}

/** A refusal is a NO_ACTION (or BLOCK_PROMOTION) the reconciler wrote down; these are the codes and the HTTP status they mean. */
const REFUSALS: Partial<Record<ReasonCode, number>> = {
	FORBIDDEN_ACTOR: 403,
	UNKNOWN_WORK_ITEM: 404,
	STALE_BINDING: 409,
	BASELINE_MOVED: 409,
	HEAD_MOVED: 409,
	ALREADY_PROMOTED: 409,
	ALREADY_RESOLVED: 409,
	NOTHING_TO_REVALIDATE: 409,
	REVALIDATION_LIMIT: 409,
	IDEMPOTENCY_CONFLICT: 409,
};

/** The refusal the reconciler recorded for a command, if it refused. */
export function refusalOf(effects: Effect[]): { status: number; code: ReasonCode; message: string } | null {
	for (const effect of effects) {
		if (effect.type !== "NO_ACTION" && effect.type !== "BLOCK_PROMOTION" && effect.type !== "REQUEST_REVIEW") continue;
		for (const code of effect.reasonCodes) {
			const status = REFUSALS[code];
			if (status === undefined) continue;
			// The explanation sits on whichever effect carries one for the same code.
			const explained = effects.find((e) => (e.type === "NO_ACTION" || e.type === "REQUEST_REVIEW") && e.reasonCodes.includes(code) && e.message);
			return { status, code, message: (explained && "message" in explained && explained.message) || code };
		}
	}
	return null;
}

/**
 * One WebSocket text frame. `message` is a contracts `WsMessage`, untouched. The envelope adds
 * `seq` because `agent-activity` has none of its own: for `snapshot` it is the ledger head the
 * snapshot is current at, for `event` the ledger line's seq, and for `agent-activity` the ledger
 * head at the moment it was sent. A client resumes with `?since=<highest seq it saw>`.
 */
export const WsFrame = z.strictObject({
	seq: z.number().int().min(0),
	/** True on events re-sent after a reconnect (`?since=`), so a client can tell them from live ones. */
	replay: z.boolean().optional(),
	/** On a snapshot: more lines were missed than the server replays; rely on the snapshot. */
	gap: z.boolean().optional(),
	message: WsMessage,
});
export type WsFrame = z.infer<typeof WsFrame>;
