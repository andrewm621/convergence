import type { ContractCheck, FacetValue } from "contracts";
import { BRIEFING_PATH, SCHEDULE_PATH, SCRIPT_PATH, SIGNAGE_PATH, SUPPLIES_PATH } from "./documents";
import { SHELTER_INTAKE_CHECK } from "./records";

/**
 * The scenario's contract check (rule R8). Delta Convergence runs it at a fork head and records
 * the result as Evidence, so a conflict never depends on an agent reporting on itself.
 *
 * It is plain text matching against the accepted policy facets. No model decides anything here.
 *
 * Synthetic scenario. Not operational guidance.
 */

export type CheckResult = { pass: boolean; output: string; failures: string[] };

type Facets = Record<string, FacetValue>;

type Rule = {
	id: string;
	/** Which documents the rule applies to. */
	appliesTo: (path: string) => boolean;
	/** Returns a failure message, or null when the document is fine. */
	run: (text: string, facets: Facets) => string | null;
};

const text = (value: FacetValue | undefined): string => (typeof value === "string" ? value : "");

/** The hall named in a "pet area in Hall X" facet value, if the policy admits pets there. */
export function petAreaOf(facets: Facets): string | null {
	const pets = text(facets["pets"]);
	if (!/crated pets admitted/i.test(pets)) return null;
	return /pet area in (Hall [A-Z])/i.exec(pets)?.[1] ?? null;
}

const FRONT_LINE = (path: string) => path === SCRIPT_PATH || path === BRIEFING_PATH;
const ANY = () => true;

const RULES: Rule[] = [
	{
		id: "pet-area-mentioned",
		appliesTo: FRONT_LINE,
		run(doc, facets) {
			const area = petAreaOf(facets);
			return area && !doc.includes(area) ? `the policy admits crated pets with a pet area in ${area}, but the document never mentions ${area}` : null;
		},
	},
	{
		id: "no-outdated-pet-line",
		appliesTo: ANY,
		run(doc, facets) {
			return petAreaOf(facets) && /service animals only/i.test(doc) ? 'the policy admits crated pets, but the document still says "service animals only"' : null;
		},
	},
	{
		id: "no-outdated-id-line",
		appliesTo: FRONT_LINE,
		run(doc, facets) {
			return /not listed as a requirement/i.test(text(facets["id_required"])) && /\bID required\b/i.test(doc) ? 'the policy no longer lists ID as a requirement, but the document still says "ID required"' : null;
		},
	},
	{
		id: "hours-stated",
		appliesTo: (path) => path === BRIEFING_PATH || path === SCHEDULE_PATH,
		run(doc, facets) {
			const times = text(facets["hours"]).match(/\d{1,2}:\d{2}/g) ?? [];
			const missing = times.filter((time) => !doc.includes(time));
			return missing.length > 0 ? `the hours are ${text(facets["hours"])}, but the document does not state ${missing.join(" and ")}` : null;
		},
	},
];

/** Run the check on one document against the accepted facets. */
export function runShelterIntakeCheck(path: string, doc: string, facets: Facets): CheckResult {
	const applied = RULES.filter((rule) => rule.appliesTo(path));
	const failures = applied.flatMap((rule) => {
		const failure = rule.run(doc, facets);
		return failure ? [`${rule.id}: ${failure}`] : [];
	});
	const pass = failures.length === 0;
	const head = `${path}: ${applied.length} assertion${applied.length === 1 ? "" : "s"}`;
	return { pass, failures, output: pass ? `${head} passed` : `${head}, ${failures.length} failed. ${failures.join("; ")}` };
}

const DOCUMENT_PATHS = new Set([SCRIPT_PATH, SIGNAGE_PATH, BRIEFING_PATH, SUPPLIES_PATH, SCHEDULE_PATH]);

/**
 * The same check as a registry entry the Worker can run on a pushed head: every document of the scenario that
 * the push contains, against the accepted facets. A push with none of them has nothing to assert and fails
 * closed (the check cannot tell it is fine).
 */
export const contractChecks: Record<string, ContractCheck> = {
	[SHELTER_INTAKE_CHECK]: {
		reads: (path) => DOCUMENT_PATHS.has(path),
		run(files, facets) {
			const paths = Object.keys(files).sort();
			if (paths.length === 0) return { pass: false, output: "none of the scenario documents is in the push, so nothing could be asserted" };
			const results = paths.map((path) => runShelterIntakeCheck(path, files[path] as string, facets));
			return { pass: results.every((r) => r.pass), output: results.map((r) => r.output).join(" | ") };
		},
	},
};
