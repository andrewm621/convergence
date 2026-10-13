import type { FacetValue } from "contracts";
import { BRIEFING_PATH, SCHEDULE_PATH, SCRIPT_PATH } from "./documents";

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
