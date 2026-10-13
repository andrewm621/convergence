import type { Effect } from "contracts";

export type EffectSummary = {
	/** Work items the change was evaluated against (each one has at least one effect). */
	evaluated: number;
	/** Work items that went Stale. */
	stale: number;
	/** Work items deliberately left alone (NO_ACTION with a reason). */
	untouched: number;
};

/**
 * The fan-out results strip: `N evaluated · K stale · rest untouched`. Counts distinct work
 * items in an effect list; the Worker adds the elapsed time it measured around `reconcile`.
 */
export function summarizeEffects(effects: Effect[]): EffectSummary {
	const evaluated = new Set<string>();
	const stale = new Set<string>();
	const untouched = new Set<string>();
	for (const effect of effects) {
		if (!("workItemId" in effect) || effect.workItemId === undefined) continue;
		evaluated.add(effect.workItemId);
		if (effect.type === "RECORD_CONDITION" && effect.condition.type === "Stale") stale.add(effect.workItemId);
		if (effect.type === "NO_ACTION" && effect.reasonCodes.includes("NO_DEPENDENCY_ON_CHANGED_FACETS")) untouched.add(effect.workItemId);
	}
	return { evaluated: evaluated.size, stale: stale.size, untouched: untouched.size };
}
