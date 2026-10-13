import type { ContractCheck, FacetValue } from "contracts";
import { contractChecks as notifications } from "scenario-notifications/src/checks";
import { contractChecks as shelterIntake } from "scenario-shelter-intake/src/check";
import type { FlatTree } from "../artifacts/tree-diff";
import type { ArtifactsPort } from "./ports";

// Rule R8 in the Worker: the contract check of a record's `validation:` path is run by Delta on the file
// contents of a pushed head, never by the agent and never from anything the container reports. The checks
// are pure functions that live beside each scenario's fixtures; this file is the registry that finds one by
// its `validation:` path, and the reader that hands it the files.
//
// What is covered: the notifications and status-model checks (Scenario A) and the shelter-intake check.
// Sales-ops has no check here on purpose: its fixtures record hand-written results and its work products
// have no fixed file layout, so any assertion would be invented. A `validation:` path with no entry gets no
// evidence, and the gate keeps saying MISSING_EVIDENCE.

export const CONTRACT_CHECKS: Readonly<Record<string, ContractCheck>> = { ...notifications, ...shelterIntake };

const MAX_FILES = 40;
const MAX_FILE_CHARS = 200_000;

export type ContractCheckRun = { pass: boolean; output: string };

/**
 * Run the check named by `check` at `sha` of `repo`. Returns null when no check is registered for that path.
 * Reads only the files the check asks for, by the blob ids of the repo's own tree at that sha, so the text is
 * what git has at that commit. A file that cannot be read throws (the caller retries); one that is too large
 * or too many files fail closed.
 */
export async function runContractCheck(
	port: ArtifactsPort,
	input: { repo: string; sha: string; tree: FlatTree; check: string; facets: Record<string, FacetValue> },
	registry: Readonly<Record<string, ContractCheck>> = CONTRACT_CHECKS,
): Promise<ContractCheckRun | null> {
	if (!Object.hasOwn(registry, input.check)) return null;
	const definition = registry[input.check] as ContractCheck;
	const at = input.sha.slice(0, 7);
	const paths = [...input.tree.keys()].filter((path) => definition.reads(path)).sort();
	if (paths.length > MAX_FILES) return { pass: false, output: `Delta-run contract check ${input.check} at ${at} failed closed: ${paths.length} files to read, the limit is ${MAX_FILES}.` };

	const files: Record<string, string> = {};
	for (const path of paths) {
		const entry = input.tree.get(path);
		const text = entry ? await port.readBlob(input.repo, entry.hash) : null;
		if (text === null) throw new Error(`cannot read ${path} at ${at}`);
		if (text.length > MAX_FILE_CHARS) return { pass: false, output: `Delta-run contract check ${input.check} at ${at} failed closed: ${path} is larger than ${MAX_FILE_CHARS} characters.` };
		files[path] = text;
	}
	const result = definition.run(files, input.facets);
	return { pass: result.pass, output: `Delta-run contract check ${input.check} at ${at}, reading ${paths.length === 0 ? "no files" : paths.join(", ")}: ${result.output}` };
}
