// Scripted stand-in for the real agent (AGENT_MODE=stub). Pure: no I/O, so it is unit-tested in Node and
// also runs inside the container (Node 24 strips the types natively). Keep it free of imports and of
// syntax that needs a transform (enums, parameter properties).
//
// It follows the agent protocol (PRD section 5): read the context records, make a deterministic code
// change, and report claims that cite `recordId@version`.

export type FacetScalar = string | number | boolean;
/** A facet value: a scalar, or a flow list of scalars (`[draft, active]`). */
export type FacetValue = FacetScalar | FacetScalar[];

export interface Claim {
	subject: string;
	value: FacetValue;
	basedOn: string;
}

export interface ContextRecord {
	id: string;
	version: number;
	facets: Record<string, FacetValue>;
}

export interface StubInput {
	workItemId: string;
	prompt: string;
	/** Context files by repo-relative path, e.g. `.delta/context/notifications.md`. */
	contextFiles: Record<string, string>;
	/** Current content of `src/index.ts`, or null when the fork has none. */
	indexTs: string | null;
}

export interface StubOutput {
	/** Files to write, by repo-relative path. */
	files: Record<string, string>;
	claims: Claim[];
	summary: string;
}

function parseScalar(raw: string): FacetScalar {
	const text = raw.trim().replace(/\s+#.*$/, "");
	const quoted = /^(['"])(.*)\1$/.exec(text);
	if (quoted) return quoted[2] ?? "";
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
	return text;
}

/** A facet value: a flow list `[a, b]` becomes an array (as the record parser reads it), anything else a scalar. */
function parseValue(raw: string): FacetValue {
	const text = raw.trim().replace(/\s+#.*$/, "");
	const list = /^\[(.*)\]$/.exec(text);
	if (!list) return parseScalar(text);
	const inner = (list[1] ?? "").trim();
	return inner === "" ? [] : inner.split(",").map((item) => parseScalar(item));
}

/** Minimal front-matter reader: `id`, `version` and the flat `facets:` map. Returns null when unusable. */
export function parseContextRecord(markdown: string): ContextRecord | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	if (!match?.[1]) return null;

	let id: string | null = null;
	let version: number | null = null;
	const facets: Record<string, FacetValue> = {};
	let inFacets = false;

	for (const line of match[1].split(/\r?\n/)) {
		if (/^facets:\s*$/.test(line)) {
			inFacets = true;
			continue;
		}
		// The Worker writes facet keys quoted ("notifications.cadence": ...), hand-written records usually don't.
		const indented = /^\s+(["']?)([A-Za-z0-9_.-]+)\1:\s*(.*)$/.exec(line);
		if (inFacets && indented?.[2] !== undefined && indented[3] !== undefined) {
			facets[indented[2]] = parseValue(indented[3]);
			continue;
		}
		if (line.trim() === "" || line.startsWith("#")) continue;
		inFacets = false;
		const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
		if (!top?.[1] || top[2] === undefined) continue;
		if (top[1] === "id") id = String(parseScalar(top[2]));
		if (top[1] === "version") {
			const v = parseScalar(top[2]);
			version = typeof v === "number" ? v : null;
		}
	}
	if (!id || version === null || !Number.isInteger(version) || version < 1) return null;
	return { id, version, facets };
}

/** `notifications.default` -> `NOTIFICATIONS_DEFAULT`. */
function constName(facetKey: string): string {
	return facetKey.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

function firstLine(text: string, max = 80): string {
	const line = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Does the task rely on this record? True when the prompt names it (`status-model`) or its first word in the
 * singular (`status`, `notification`). Like a real agent, the stub cites only what its task is about, so a work
 * item that never touches a record does not claim it (an undeclared dependency would block the work item).
 */
function inScope(record: ContextRecord, prompt: string): boolean {
	const text = prompt.toLowerCase();
	const stem = (record.id.split("-")[0] ?? record.id).replace(/s$/, "");
	return text.includes(record.id) || (stem !== "" && text.includes(stem));
}

/** Deterministic: same input, same output, byte for byte. No clock, no randomness. */
export function runStubAgent(input: StubInput): StubOutput {
	const all = Object.keys(input.contextFiles)
		.sort()
		.map((path) => parseContextRecord(input.contextFiles[path] ?? ""))
		.filter((r): r is ContextRecord => r !== null)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	// A prompt that names none of them gets them all (nothing to narrow by).
	const named = all.filter((r) => inScope(r, input.prompt));
	const records = named.length > 0 ? named : all;

	const claims: Claim[] = [];
	const constants: string[] = [];
	for (const record of records) {
		for (const key of Object.keys(record.facets).sort()) {
			const value = record.facets[key] as FacetValue;
			const ref = `${record.id}@${record.version}`;
			claims.push({ subject: key, value, basedOn: ref });
			constants.push(`export const ${constName(key)} = ${JSON.stringify(value)}; // ${ref}`);
		}
	}

	const modulePath = `src/work/${input.workItemId}.ts`;
	const moduleSource = [
		`// Written by the Delta stub agent for work item ${input.workItemId}. Deterministic.`,
		`// Task: ${firstLine(input.prompt) || "(no prompt)"}`,
		...constants,
		"",
	].join("\n");

	const exportLine = `export * from "./work/${input.workItemId}";`;
	const base = input.indexTs ?? "";
	const indexSource = base.includes(exportLine) ? base : `${base}${base === "" || base.endsWith("\n") ? "" : "\n"}${exportLine}\n`;

	return {
		files: {
			[modulePath]: moduleSource,
			"src/index.ts": indexSource,
			".delta/claims.json": `${JSON.stringify(claims, null, 2)}\n`,
		},
		claims,
		summary: `${input.workItemId}: ${claims.length} claim(s) from ${records.length} record(s)`,
	};
}
