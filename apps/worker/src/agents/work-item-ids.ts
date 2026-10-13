import { WORK_ITEM_ID_RE } from "./protocol";

// The control plane and the agent runtime name a work item differently, and this file is the only
// place that translates. The cell keeps the id the fixture and the console use (`WI-2`); the runtime
// needs a lowercase id because it names a Durable Object, a sandbox and the commit author
// (`workitem-wi-2`). The rule is "lowercase", nothing cleverer, so the two ids always agree.

export type RuntimeId = { ok: true; id: string } | { ok: false; error: string };

/** The runtime's id for a cell work item id: lowercase, and valid as a runtime id. */
export function runtimeIdFor(cellId: string): RuntimeId {
	const id = cellId.toLowerCase();
	if (!WORK_ITEM_ID_RE.test(id)) {
		return { ok: false, error: `work item ${cellId} has no valid agent runtime id (need 1-40 lowercase letters, digits or hyphens once lowercased)` };
	}
	return { ok: true, id };
}

/** The cell id behind a runtime id, or null if none (or more than one) of the known ids lowercases to it. */
export function cellIdFor(runtimeId: string, knownCellIds: Iterable<string>): string | null {
	const matches = [...knownCellIds].filter((id) => id.toLowerCase() === runtimeId);
	return matches.length === 1 ? (matches[0] as string) : null;
}

/** Another registered work item that maps to the same runtime id (`WI-2` and `wi-2` would share one sandbox and one author), if any. */
export function runtimeIdCollision(cellId: string, knownCellIds: Iterable<string>): string | null {
	const lowered = cellId.toLowerCase();
	return [...knownCellIds].find((id) => id !== cellId && id.toLowerCase() === lowered) ?? null;
}
