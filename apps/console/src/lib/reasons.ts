import type { ReasonCode } from "contracts";

/** What a reason code means, in one plain line each: what happened, the rule behind it, and what a person can do. */
export type ReasonMeta = { summary: string; rule: string; next: string };

/**
 * The codes the three scenarios emit, plus the few that follow from them. A chip shows the code (so it stays searchable);
 * this is what its tooltip says. Anything not listed gets `reasonMeta`'s generic line.
 */
export const REASON_META: Partial<Record<ReasonCode, ReasonMeta>> = {
	STALE_RECEIPT: {
		summary: "This work was built on an older version of a decision.",
		rule: "Work is blocked when a setting it depends on has changed since it was handed that decision.",
		next: "Revalidate it on the new version, or allow it with a scoped exception.",
	},
	FACET_CHANGED: {
		summary: "A setting this work depends on changed.",
		rule: "Only changes to settings its recorded dependency names block it.",
		next: "Check what the setting says now, then revalidate.",
	},
	PROSE_ONLY: {
		summary: "Only the wording changed, so no setting moved.",
		rule: "Under this policy, a wording-only edit doesn't block work.",
		next: "Nothing to do.",
	},
	NO_DEPENDENCY_ON_CHANGED_FACETS: {
		summary: "No recorded dependency of this work changed.",
		rule: "Work with no recorded dependency on a changed setting is left alone.",
		next: "Nothing to do for this change.",
	},
	NO_CLAIMS: {
		summary: "The agent said nothing about what it built.",
		rule: "No claims means Convergence can't tell, so it blocks rather than guesses.",
		next: "Have the agent push its claims again.",
	},
	MALFORMED_CLAIMS: {
		summary: "The agent's claims couldn't be read.",
		rule: "Claims that can't be read count as unknown, and unknowns are never waived.",
		next: "Have the agent push readable claims.",
	},
	CLAIM_CONFLICT: {
		summary: "The agent claims a different value than the decision.",
		rule: "A claim that contradicts an accepted decision blocks the work.",
		next: "Revalidate so the agent redoes it, or allow it with a scoped exception.",
	},
	SUPERSEDED_BASIS: {
		summary: "The agent's claim rests on an older version of the decision.",
		rule: "A claim that cites a replaced version conflicts if that setting has changed since, even when the value now matches.",
		next: "Revalidate so the claim cites the current version.",
	},
	UNDECLARED_DEP: {
		summary: "The agent's claims cite a decision it wasn't given.",
		rule: "Work may only depend on decisions it was handed or a person accepted.",
		next: "Accept or reject that dependency, or revalidate.",
	},
	TEST_FAILED: {
		summary: "A check on this work is failing.",
		rule: "Merge stays closed while a required check fails at the current version.",
		next: "Fix it and push again. An exception covers only the excepted decision's own check.",
	},
	TESTS_PASSED: {
		summary: "The checks for this work passed.",
		rule: "Passing checks at the current version count toward the merge check.",
		next: "Nothing to do.",
	},
	MISSING_EVIDENCE: {
		summary: "No passing check has run on its latest push yet.",
		rule: "Merge needs a passing check at the agent's latest push.",
		next: "Wait for the check, or push again.",
	},
	HUMAN_RESOLUTION_MISSING: {
		summary: "Nobody has decided what to do about this yet.",
		rule: "Only a named person can lift a block or end the work.",
		next: "Revalidate, allow with an exception, or reject.",
	},
	NOT_FRESH: {
		summary: "This work isn't confirmed up to date.",
		rule: "Merge needs the work to be up to date with every decision it depends on.",
		next: "Wait for the next check, or revalidate.",
	},
	REVALIDATION_PENDING: {
		summary: "The agent is redoing this work on the current decisions.",
		rule: "Merge stays closed until the re-run pushes.",
		next: "Wait for the agent.",
	},
	REVALIDATION_STARTED: {
		summary: "A person sent the agent back to redo this work.",
		rule: "A revalidation re-hands the current decisions and counts as one re-run.",
		next: "Wait for the agent's next push.",
	},
	REVALIDATION_LIMIT: {
		summary: "The agent has used all its re-runs.",
		rule: "Re-runs are capped, so a person has to look at why it keeps failing.",
		next: "Review the work by hand, or reject it.",
	},
	EXCEPTION_APPLIED: {
		summary: "A person allowed this work through with an exception.",
		rule: "An exception lifts one decision's block. The scope is recorded, not enforced.",
		next: "A person still has to press Merge.",
	},
	EXCEPTION_LAPSED: {
		summary: "The exception no longer applies.",
		rule: "An exception ends when the decision gets a new version or the agent pushes again.",
		next: "Revalidate, or allow a new exception.",
	},
	FORK_CONTEXT_IGNORED: {
		summary: "The agent tried to change a decision from its own copy.",
		rule: "Only the main line can change accepted decisions.",
		next: "Move that change to a decision change.",
	},
	UNKNOWN_CONTEXT_VERSION: {
		summary: "A version Convergence has never seen (in a claim, or in what the work was handed).",
		rule: "It fails closed and blocks.",
		next: "Have the agent cite a real version, or revalidate.",
	},
	ALREADY_PROMOTED: {
		summary: "This work was already merged.",
		rule: "Merged work isn't touched by later changes.",
		next: "Nothing to do.",
	},
	OBSERVATION_ONLY: {
		summary: "Convergence noted this and changed nothing.",
		rule: "Observations are recorded in the audit log without any action.",
		next: "Nothing to do.",
	},
};

/**
 * The "?" row under "Built on": a decision the agent's claims cite that it was never handed (UNDECLARED_DEP).
 * The agent said it relied on it; nobody has confirmed that, so it is not shown as a dependency.
 */
export const NOT_GIVEN_TEXT = {
	label: "Not given",
	detail: "Not given — the agent says it relied on this",
} as const;

/** Said for a code with no entry above. */
export const GENERIC_REASON: ReasonMeta = {
	summary: "Convergence recorded this reason.",
	rule: "Every decision it makes carries a reason code, and no model chooses it.",
	next: "Open Technical details or the audit log for the full line.",
};

/** One line for a tooltip: what happened, the rule, and what to do next. */
export function reasonMeta(code: string): ReasonMeta {
	return REASON_META[code as ReasonCode] ?? GENERIC_REASON;
}

export function reasonText(code: string): string {
	const { summary, rule, next } = reasonMeta(code);
	return `${summary} ${rule} Next: ${next}`;
}
