/**
 * The normative projection (docs/PROTOCOL.md section 4): the part of a `{state, effects}` result that two
 * conforming implementations must agree on. Statuses, condition types, effect types and reason codes, plus the
 * ids, versions and hashes that are fixed by the inputs. Not projected: `message` text, `observedAt`, condition
 * `recordRefs`/`facetKeys`, the evidence and claims caches, the order of effects, and the order of reason codes
 * within a condition or an effect.
 *
 * This file has no dependencies, so the runner can project any implementation's output without loading the
 * reference engine. It is written defensively: output from a foreign implementation may be any JSON at all.
 */

export const PROTOCOL = "convergence/0.1";

export type Polarity = "positive" | "negative";

export type Vector = {
	protocol: typeof PROTOCOL;
	id: string;
	description: string;
	/** Rules the vector exercises: "R1" to "R9", or "R3b". */
	rules: string[];
	/** positive: the rule acts (stales, blocks, refuses, dedupes). negative: the rule correctly leaves things alone or lets them through. */
	polarity: Polarity;
	/** Which scenario fixture the starting state comes from. Informative. */
	fixture: string;
	/** Set on the steps of a named sequence, such as the worked example of PROTOCOL.md section 2. */
	sequence?: { name: string; step: number };
	given: { state: unknown; policy: unknown };
	when: { event: unknown };
	then: Projection;
};

export type Projection = { state: ProjectedState; effects: ProjectedEffect[] };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ProjectedState = {
	baselineCommit: Json;
	snapshotHash: Json;
	records: Record<string, { current: Json; versions: number[]; proposed: Json }>;
	workItems: Record<string, ProjectedWorkItem>;
	dependencies: Array<{ workItemId: Json; recordId: Json; facetKeys: Json; basis: Json; status: Json }>;
	/** Rule R9 dedupe keys already processed (section 3.11). */
	processed: string[];
};

export type ProjectedWorkItem = {
	status: Json;
	conditions: Array<{ type: Json; reasonCodes: Json }>;
	headSha: Json;
	/** `contextPacketHash` of the receipt the item holds: changes only through rule R6. */
	receipt: Json;
	revalidating: Json;
	revalidations: Json;
	/** Kinds of the resolutions recorded, in order. */
	resolutions: Json[];
	/** Whether a live promotion approval (rule R7, two-phase) is held. */
	promotionApproved: boolean;
};

export type ProjectedEffect = { [key: string]: Json };

// ---------- canonical JSON (sorted keys), the comparison form ----------

export function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

export function canonicalPretty(value: unknown): string {
	return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) out[key] = sortKeys(child);
		}
		return out;
	}
	return value;
}

// ---------- projection ----------

function obj(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** A JSON value, with `undefined` (absent) turned into null so a missing field shows up as a difference. */
function json(value: unknown): Json {
	return value === undefined ? null : (value as Json);
}

function sortedStrings(value: unknown): Json {
	return Array.isArray(value) ? [...value].map(String).sort() : json(value);
}

function byCanonical<T>(items: T[]): T[] {
	return items.map((item) => [canonical(item), item] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
}

export function projectState(raw: unknown): ProjectedState {
	const state = obj(raw);
	const records: ProjectedState["records"] = {};
	for (const [recordId, history] of Object.entries(obj(state["records"]))) {
		const h = obj(history);
		records[recordId] = {
			current: json(h["current"]),
			versions: Object.keys(obj(h["versions"])).map(Number).sort((a, b) => a - b),
			proposed: h["proposed"] === null || h["proposed"] === undefined ? null : json(obj(h["proposed"])["version"]),
		};
	}
	const workItems: ProjectedState["workItems"] = {};
	for (const [id, value] of Object.entries(obj(state["workItems"]))) {
		const wi = obj(value);
		workItems[id] = {
			status: json(obj(wi["item"])["status"]),
			conditions: byCanonical(arr(wi["conditions"]).map((c) => ({ type: json(obj(c)["type"]), reasonCodes: sortedStrings(obj(c)["reasonCodes"]) }))),
			headSha: json(wi["headSha"]),
			receipt: json(obj(wi["receipt"])["contextPacketHash"]),
			revalidating: json(wi["revalidating"]),
			revalidations: json(wi["revalidations"]),
			resolutions: arr(wi["resolutions"]).map((r) => json(obj(r)["kind"])),
			promotionApproved: wi["promotionApproval"] !== null && wi["promotionApproval"] !== undefined,
		};
	}
	const dependencies = byCanonical(
		arr(state["dependencies"]).map((d) => {
			const dep = obj(d);
			return { workItemId: json(dep["workItemId"]), recordId: json(dep["recordId"]), facetKeys: sortedStrings(dep["facetKeys"]), basis: json(dep["basis"]), status: json(dep["status"]) };
		}),
	);
	return {
		baselineCommit: json(state["baselineCommit"]),
		snapshotHash: json(state["snapshotHash"]),
		records,
		workItems,
		dependencies,
		processed: Object.keys(obj(state["processed"])).sort(),
	};
}

export function projectEffect(raw: unknown): ProjectedEffect {
	const effect = obj(raw);
	const type = json(effect["type"]);
	const out: ProjectedEffect = { type, reasonCodes: sortedStrings(effect["reasonCodes"]) };
	if (effect["workItemId"] !== undefined) out["workItemId"] = json(effect["workItemId"]);
	if (effect["recordId"] !== undefined) out["recordId"] = json(effect["recordId"]);
	switch (type) {
		case "RECORD_CONDITION":
			out["condition"] = json(obj(effect["condition"])["type"]);
			break;
		case "ALLOW_PROMOTION":
			out["forkHeadSha"] = json(effect["forkHeadSha"]);
			out["baselineCommit"] = json(effect["baselineCommit"]);
			break;
		case "DISPATCH_WORK":
		case "REQUEST_REVALIDATION":
			if (type === "DISPATCH_WORK") out["mode"] = json(effect["mode"]);
			out["diff"] = byCanonical(
				arr(effect["diff"]).map((d) => {
					const diff = obj(d);
					return {
						recordId: json(diff["recordId"]),
						fromVersion: json(diff["fromVersion"]),
						toVersion: json(diff["toVersion"]),
						changes: byCanonical(arr(diff["changes"]).map((c) => sortKeys(c) as Json)),
					};
				}),
			);
			break;
		default:
			break;
	}
	return out;
}

/** Project a `{state, effects}` result. Effects are compared as a multiset, so they are sorted here. */
export function project(result: unknown): Projection {
	const r = obj(result);
	return { state: projectState(r["state"]), effects: byCanonical(arr(r["effects"]).map(projectEffect)) };
}

// ---------- diff ----------

/** Human-readable differences between the expected and the actual projection, most specific path first. */
export function diffProjections(expected: Projection, actual: Projection, limit = 12): string[] {
	const lines: string[] = [];
	diffValue("state", expected.state, actual.state, lines);
	const want = expected.effects.map(canonical);
	const got = actual.effects.map(canonical);
	const remaining = [...got];
	for (const e of want) {
		const at = remaining.indexOf(e);
		if (at >= 0) remaining.splice(at, 1);
		else lines.push(`effects: missing ${e}`);
	}
	for (const e of remaining) lines.push(`effects: unexpected ${e}`);
	return lines.length > limit ? [...lines.slice(0, limit), `... and ${lines.length - limit} more`] : lines;
}

function diffValue(path: string, expected: unknown, actual: unknown, out: string[]): void {
	if (canonical(expected) === canonical(actual)) return;
	const bothObjects = expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual);
	if (bothObjects) {
		const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
		for (const key of keys) diffValue(`${path}.${key}`, (expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], out);
		return;
	}
	out.push(`${path}: expected ${canonical(expected) ?? "(absent)"}, got ${canonical(actual) ?? "(absent)"}`);
}
