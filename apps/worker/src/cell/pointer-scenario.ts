// Delta Convergence governing its own build (docs/dogfooding.md). The work items of that cell are pointers to real
// pull requests and documents, not forks an agent works in, so the cell must never start an agent or merge one.

/** The scenario id the console's replay uses. A live cell is this id, or this id followed by `-<name>`. */
export const POINTER_SCENARIO = "delta-convergence-build";

/** Is this cell (named by its scenario) one whose work items are pointers? */
export function isPointerScenario(scenario: string | null): boolean {
	return scenario === POINTER_SCENARIO || (scenario !== null && scenario.startsWith(`${POINTER_SCENARIO}-`));
}

export const NOT_PROMOTABLE_MESSAGE = "not promotable: work items here are pointers to real PRs";

/** What the console's activity stream says when a revalidation is recorded and, by design, nothing is dispatched. */
export const HUMAN_RESOLVED_TEXT = "Revalidation recorded. Human-resolved outside the console: no agent is dispatched for this workspace; push the updated claims to this work item's pointer when the real work is done.";
