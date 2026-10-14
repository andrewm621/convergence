import { parseContextRecord, type Claim, type FacetValue, type Policy } from "contracts";
import * as build from "scenario-delta-convergence-build";
import { POINTER_SCENARIO } from "./cell/pointer-scenario";

// The seed for Convergence governing its own build (docs/dogfooding.md): the replay's end state, written as repos.
// The baseline holds the six records at their latest versions. Each of the seven work items gets a fork whose only
// content is a pointer to the real work and the claims the work holds as of seeding. Nothing is replayed; the replay is
// the console's mock.

/** The six records at their latest versions, as the replay ends. */
const LATEST: Array<[path: string, text: string]> = [
	[build.EVIDENCE_POLICY_PATH, build.EVIDENCE_POLICY_V3],
	[build.SCENARIO_NAMING_PATH, build.SCENARIO_NAMING_V2],
	[build.SCENARIO_PLAN_PATH, build.SCENARIO_PLAN_V1],
	[build.PRODUCT_NAMING_PATH, build.PRODUCT_NAMING_V2],
	[build.POSITIONING_PATH, build.POSITIONING_V1],
	[build.DEMO_IDENTITY_PATH, build.DEMO_IDENTITY_V1],
];

export const CLAIMS_FILE = ".delta/claims.json";
export const POINTER_FILE = ".delta/pointer.json";

export type Pointer = {
	workItem: string;
	/** The real commit the work stands at, or null when it is not in git (the shared brief). */
	head: string | null;
	note: string;
};

export type PointerWorkItem = {
	id: string;
	title: string;
	agent: { id: string; displayName: string };
	requires: Array<"human-resolution">;
	dependencies: Array<{ recordId: string; facetKeys: string[] }>;
	/** Written to the work item's fork: its claims and the pointer to the real work. */
	forkFiles: Record<string, string>;
	commitMessage: string;
};

export type PointerSeed = {
	baselineFiles: Record<string, string>;
	policy: Policy;
	workItems: PointerWorkItem[];
};

/** The sha shown to people, or "not in git". */
const shown = (head: string | null) => (head === null ? "not in git" : head.slice(0, 7));

export function pointerFiles(claims: Claim[], pointer: Pointer): Record<string, string> {
	return { [CLAIMS_FILE]: `${JSON.stringify(claims, null, 2)}\n`, [POINTER_FILE]: `${JSON.stringify(pointer, null, 2)}\n` };
}

export function pointerCommitMessage(pointer: Pointer): string {
	return `pointer: ${pointer.workItem} at ${shown(pointer.head)}\n\n${pointer.note}\n`;
}

/** The records' current versions and facet values, by record id. */
export function latestFacets(): Record<string, { version: number; facets: Record<string, FacetValue> }> {
	const out: Record<string, { version: number; facets: Record<string, FacetValue> }> = {};
	for (const [path, text] of LATEST) {
		const parsed = parseContextRecord(text);
		if (!parsed.ok) throw new Error(`${path} does not parse: ${parsed.error}`);
		const fm = parsed.record.frontMatter;
		out[fm.id] = { version: fm.version, facets: fm.facets };
	}
	return out;
}

/** The claims a work item makes at the latest versions: one per facet it declared a dependency on. */
export function claimsAtLatest(dependencies: Array<{ recordId: string; facetKeys: string[] }>): Claim[] {
	const latest = latestFacets();
	return dependencies.flatMap((dep) =>
		dep.facetKeys.map((subject) => {
			const record = latest[dep.recordId];
			const value = record?.facets[subject];
			if (!record || value === undefined) throw new Error(`${dep.recordId} has no facet ${subject}`);
			return { subject, value, basedOn: `${dep.recordId}@${record.version}` } as Claim;
		}),
	);
}

export function buildPointerSeed(): PointerSeed {
	const items = [
		[build.workItems.wi1, build.dependencies.wi1, build.commits.wi1Head, "Where the M4 revalidate loop lives on main (PR #6)."],
		[build.workItems.wi2, build.dependencies.wi2, build.commits.wi2Head, "Where the console evidence labels live on main (PR #7)."],
		[build.workItems.wi3, build.dependencies.wi3, build.commits.wi3Head, "The video script."],
		[build.workItems.wi4, build.dependencies.wi4, build.commits.wi4Head, "The shelter fixtures (PRs #3 and #4)."],
		[build.workItems.wi5, build.dependencies.wi5, build.commits.wi5Head, "The shared brief. It lives outside git."],
		[build.workItems.wi6, build.dependencies.wi6, build.commits.wi6Head, "The README (PR #1, unmerged)."],
		[build.workItems.wi7, build.dependencies.wi7, build.commits.wi7Head, "The console identity header."],
	] as const;

	const workItems = items.map(([item, deps, head, what]): PointerWorkItem => {
		const dependencies = deps.map((d) => ({ recordId: d.recordId, facetKeys: [...d.facetKeys] }));
		const pointer: Pointer = {
			workItem: item.id,
			head: head === build.NOT_IN_GIT ? null : head,
			note: `${what} This fork is a pointer to the real work, not the work itself. The claims are what we declare it holds as of seeding.`,
		};
		return {
			id: item.id,
			title: item.title,
			agent: { id: item.actor.id, displayName: item.actor.displayName },
			requires: ["human-resolution"],
			dependencies,
			forkFiles: pointerFiles(claimsAtLatest(dependencies), pointer),
			commitMessage: pointerCommitMessage(pointer),
		};
	});

	return {
		baselineFiles: {
			"README.md": `# ${POINTER_SCENARIO}\n\nThe accepted decisions that govern this repo's own build, at their latest versions. See docs/dogfooding.md in the main repo.\n`,
			...Object.fromEntries(LATEST),
		},
		policy: build.policy,
		workItems,
	};
}
