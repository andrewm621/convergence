import type { Evidence } from "contracts";

/**
 * Evidence that is not an executed test says so wherever the console shows it. An absent `kind`
 * (contracts v1) and `executed-test` keep the plain check wording.
 */
export const CLAIMS_CHECK_LABEL = "Claims check (not an executed test)";
export const CLAIMS_CHECK_HINT = "The Worker verified that the agent's claims at the pushed commit cite the current decision versions. It did not run the test suite.";
export const RUN_CHECK_LABEL = "Delta Convergence contract check";
export const RUN_CHECK_HINT = "Delta Convergence ran its own deterministic check on the pushed files at this commit. Not the project's test suite.";

export type CheckDescriptor = { kind: "delta-claims-check" | "delta-run-check"; label: string; hint: string };

/** The label and tooltip for the checks Delta Convergence runs itself; null for `executed-test` and for an absent kind. */
export function describeCheck(evidence: Pick<Evidence, "kind">): CheckDescriptor | null {
	switch (evidence.kind) {
		case "delta-claims-check":
			return { kind: "delta-claims-check", label: CLAIMS_CHECK_LABEL, hint: CLAIMS_CHECK_HINT };
		case "delta-run-check":
			return { kind: "delta-run-check", label: RUN_CHECK_LABEL, hint: RUN_CHECK_HINT };
		default:
			return null;
	}
}

/** The check name the Worker records its claims check under. */
export const CLAIMS_CHECK_NAME = "delta:claims-vs-receipt";
