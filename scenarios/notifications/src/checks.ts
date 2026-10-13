import type { ContractCheck, ContractCheckResult, FacetValue } from "contracts";
import { NOTIFICATIONS_CHECK, STATUS_MODEL_CHECK } from "./records";

/**
 * Scenario A's contract checks (rule R8), keyed by the `validation:` path of the records that name them.
 * Delta Convergence runs them on the file contents of a pushed head, so a conflict never depends on an
 * agent reporting on itself. Plain text matching, deterministic, no model.
 *
 * The convention they test: code states a governed facet as a declaration named after the facet key, with a
 * literal value, for example `export const NOTIFICATIONS_DEFAULT = "opt-in";` or `status.values: [draft, active]`.
 * A declaration is a name that is the facet key with `.`, `_` or `-` between its words (or none, any case),
 * then `=` or `:`, then a string, number, boolean or list literal.
 */

type Declaration = { path: string; value: string | string[] };

const LITERAL = String.raw`("[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]|-?\d+(?:\.\d+)?|true|false)`;

function parseLiteral(raw: string): string | string[] {
	if (raw.startsWith("[")) {
		const inner = raw.slice(1, -1).trim();
		return inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim()));
	}
	return unquote(raw);
}

function unquote(text: string): string {
	const quoted = /^(["'])(.*)\1$/.exec(text);
	return quoted ? (quoted[2] as string) : text;
}

/** Every declaration of `facetKey` in the files, in path order. */
export function declarationsOf(files: Record<string, string>, facetKey: string): Declaration[] {
	const words = facetKey.split(/[._-]/).filter(Boolean).map((word) => word.replace(/[^A-Za-z0-9]/g, ""));
	const name = words.join(String.raw`[._\s-]?`);
	const pattern = new RegExp(String.raw`(?<![A-Za-z0-9])${name}["']?\s*[:=]\s*${LITERAL}`, "gi");
	const found: Declaration[] = [];
	for (const path of Object.keys(files).sort()) {
		for (const match of (files[path] as string).matchAll(pattern)) found.push({ path, value: parseLiteral(match[1] as string) });
	}
	return found;
}

function sameValue(declared: string | string[], expected: FacetValue): boolean {
	if (Array.isArray(expected)) return Array.isArray(declared) && declared.length === expected.length && declared.every((item, i) => item === String(expected[i]));
	return !Array.isArray(declared) && declared === String(expected);
}

const show = (value: string | string[] | FacetValue): string => JSON.stringify(value);

/**
 * Assert the accepted facets against the declarations in the code. A declaration whose value differs is a
 * failure; a facet in `required` that is not declared anywhere is a failure; a facet not in `required` that
 * is not declared is simply not asserted (the check says so in its output).
 */
function assertFacets(name: string, files: Record<string, string>, facets: Record<string, FacetValue>, required: string[]): ContractCheckResult {
	const lines: string[] = [];
	const failures: string[] = [];
	for (const key of Object.keys(facets).sort()) {
		const expected = facets[key] as FacetValue;
		const declarations = declarationsOf(files, key);
		if (declarations.length === 0) {
			if (required.includes(key)) failures.push(`${key} is not declared in the code (expected ${show(expected)})`);
			else lines.push(`${key}: not declared, not asserted`);
			continue;
		}
		for (const d of declarations) {
			if (sameValue(d.value, expected)) lines.push(`${d.path}: ${key} = ${show(d.value)} as accepted`);
			else failures.push(`${d.path}: ${key} = ${show(d.value)}, accepted is ${show(expected)}`);
		}
	}
	const scanned = `${Object.keys(files).length} file${Object.keys(files).length === 1 ? "" : "s"} under src/`;
	return failures.length === 0
		? { pass: true, output: `${name} passed on ${scanned}. ${lines.join("; ")}.` }
		: { pass: false, output: `${name} failed on ${scanned}. ${failures.join("; ")}.${lines.length > 0 ? ` Matching: ${lines.join("; ")}.` : ""}` };
}

const SOURCE = (path: string): boolean => /^src\/.+\.(?:ts|tsx|js|mjs|json)$/.test(path);

export const contractChecks: Record<string, ContractCheck> = {
	[NOTIFICATIONS_CHECK]: {
		reads: SOURCE,
		run: (files, facets) => assertFacets("notifications contract", files, facets, ["notifications.default", "notifications.cadence"]),
	},
	[STATUS_MODEL_CHECK]: {
		reads: SOURCE,
		run: (files, facets) => assertFacets("status-model contract", files, facets, []),
	},
};
