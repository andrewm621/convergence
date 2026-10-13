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
		rule: "Work is blocked when the decision it was handed has changed since.",
		next: "Revalidate it on the new version, or allow it with a scoped exception.",
	},
	FACET_CHANGED: {
		summary: "A setting this work relies on changed.",
		rule: "Only changes to settings the work actually uses block it.",
		next: "Check what the setting says now, then revalidate.",
	},
	PROSE_ONLY: {
		summary: "Only the wording changed, so no setting moved.",
		rule: "A wording-only edit never blocks work.",
		next: "Nothing to do.",
	},
	NO_DEPENDENCY_ON_CHANGED_FACETS: {
		summary: "This work doesn't use anything that changed.",
		rule: "Work that doesn't rely on a changed setting is left alone.",
		next: "Nothing to do. It keeps going.",
	},
	NO_CLAIMS: {
		summary: "The agent said nothing about what it built.",
		rule: "No claims means Delta Convergence can't tell, so it blocks rather than guesses.",
		next: "Have the agent push its claims again.",
	},
	MALFORMED_CLAIMS: {
		summary: "The agent's claims couldn't be read.",
		rule: "Claims that can't be read count as unknown, and unknowns are never waived.",
		next: "Have the agent push readable claims.",
	},
	CLAIM_CONFLICT: {
		summary: "The agent says something the decision doesn't.",
		rule: "A claim that contradicts an accepted decision blocks the work.",
		next: "Revalidate so the agent redoes it, or allow it with a scoped exception.",
	},
	SUPERSEDED_BASIS: {
		summary: "The agent's claim rests on an older version of the decision.",
		rule: "A claim that cites a replaced version is not trusted, even when the value still matches.",
		next: "Revalidate so the claim cites the current version.",
	},
	UNDECLARED_DEP: {
		summary: "The agent relied on a decision it was never given.",
		rule: "Work may only rely on decisions it was handed or a person accepted.",
		next: "Accept or reject that dependency, or revalidate.",
	},
	TEST_FAILED: {
		summary: "A check on this work is failing.",
		rule: "Merge stays closed while a required check fails at the current version.",
		next: "Fix it and push again, or allow it with an exception if a person decides it's safe.",
	},
	TESTS_PASSED: {
		summary: "The checks for this work passed.",
		rule: "Passing checks at the current version count toward the merge check.",
		next: "Nothing to do.",
	},
	MISSING_EVIDENCE: {
		summary: "No passing check has run on this version yet.",
		rule: "Merge needs a passing check at the agent's current version.",
		next: "Wait for the check, or push again.",
	},
	HUMAN_RESOLUTION_MISSING: {
		summary: "Nobody has decided what to do about this yet.",
		rule: "Only a named person can lift a block or end the work.",
		next: "Revalidate, allow with an exception, or reject.",
	},
	NOT_FRESH: {
		summary: "This work isn't confirmed up to date.",
		rule: "Merge needs the work to be up to date with every decision it uses.",
		next: "Wait for the next check, or revalidate.",
	},
	REVALIDATION_PENDING: {
		summary: "The agent is redoing this work on the current decisions.",
		rule: "Merge stays closed until the re-run pushes.",
		next: "Wait for the agent.",
	},
	REVALIDATION_STARTED: {
		summary: "A person sent the agent back to redo this work.",
		rule: "A revalidation re-hands the current decisions and uses up one re-run.",
		next: "Wait for the agent's next push.",
	},
	REVALIDATION_LIMIT: {
		summary: "The agent has used all its re-runs.",
		rule: "Re-runs are capped, so a person has to look at why it keeps failing.",
		next: "Review the work by hand, or reject it.",
	},
	EXCEPTION_APPLIED: {
		summary: "A person allowed this work through with an exception.",
		rule: "An exception lifts one decision's block, for a scope they named.",
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
		summary: "The agent cited a version Delta Convergence has never seen.",
		rule: "Unknown versions count as unknown, and unknowns are never waived.",
		next: "Have the agent cite a real version.",
	},
	ALREADY_PROMOTED: {
		summary: "This work was already merged.",
		rule: "Merged work isn't touched by later changes.",
		next: "Nothing to do.",
	},
	OBSERVATION_ONLY: {
		summary: "Delta Convergence noted this and changed nothing.",
		rule: "Observations are recorded in the audit log without any action.",
		next: "Nothing to do.",
	},
};

/** Said for a code with no entry above. */
export const GENERIC_REASON: ReasonMeta = {
	summary: "Delta Convergence recorded this reason.",
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
