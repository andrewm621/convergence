import { parseContextRecord, type FacetValue, type Policy } from "contracts";
import * as shelter from "scenario-shelter-intake";

// The seed for running the shelter act LIVE: the Larkhaven County shelter policy as the baseline, and two real agents
// that each draft one volunteer document on their own fork. The replay in the console (scenarios/shelter-intake) has five
// drafts and hand-recorded results; the live act needs only two, because that is what two concurrent model runs can
// carry on camera:
//
//   SH-1 front-desk intake script   scripts/front-desk.md           relies on pets, id_required   -> goes stale when v2 lands
//   SH-2 cots and blankets list     supplies/cots-and-blankets.md   relies on capacity_note       -> stays green
//
// Both rely on the same record, so what separates them is the facets, not the record: that is the facet-level claim.
// The stale document is a different file from the record that changed. Synthetic scenario. Not operational guidance.

export const SHELTER_SCENARIO = "shelter-intake";

/** The policy and the roles record sit flat under context/, which is where the agent protocol looks for them. */
export const POLICY_PATH = "context/shelter-intake-policy.md";
export const ROLES_PATH = "context/volunteer-roles.md";

/**
 * The one human the bearer secret stands for is the demo identity (`DEMO_ACTOR_ID`, `decision-owner`), and it must be the
 * authority of every record it changes. The replay's fixtures name a shelter coordinator, so the live records are the
 * same text with that authority swapped.
 */
const asDemoOwner = (text: string): string => text.replaceAll("shelter-coordinator", "decision-owner");

export type ShelterWorkItem = {
	id: string;
	title: string;
	agent: { id: string; displayName: string };
	/** Where the agent writes its document. The contract check reads exactly these paths. */
	path: string;
	/** The first dispatch's prompt. A re-dispatch only has the title, so AGENTS.md carries the path and the facets too. */
	prompt: string;
	requires: Array<"contract-test">;
	dependencies: Array<{ recordId: string; facetKeys: string[] }>;
};

export const SHELTER_WORK_ITEMS: ShelterWorkItem[] = [
	{
		id: "SH-1",
		title: "Front-desk intake script",
		agent: { id: "agent-script", displayName: "Script agent" },
		path: shelter.SCRIPT_PATH,
		prompt:
			"Front-desk intake script. Draft scripts/front-desk.md: the short script a front-desk volunteer follows as each household arrives (greeting, intake, pets, where to send them). State what the intake policy says about pets and about identification.",
		requires: ["contract-test"],
		dependencies: [{ recordId: "shelter-intake-policy", facetKeys: ["pets", "id_required"] }],
	},
	{
		id: "SH-2",
		title: "Cots and blankets supply list",
		agent: { id: "agent-supplies", displayName: "Supplies agent" },
		path: shelter.SUPPLIES_PATH,
		prompt:
			"Cots and blankets supply list. Draft supplies/cots-and-blankets.md: how many cots and blankets to stage and what else the intake desk needs, from the capacity note of the intake policy. Say nothing about pets, identification or opening hours.",
		requires: [],
		dependencies: [{ recordId: "shelter-intake-policy", facetKeys: ["capacity_note"] }],
	},
];

export const SHELTER_POLICY: Policy = {
	version: 1,
	authority: { "shelter-intake-policy": "decision-owner", "volunteer-roles": "decision-owner" },
	staleness: "facet",
	requires: [],
	maxRevalidations: 2,
};

/** The agent protocol for this baseline. The task table is generated from the work items, so the two cannot drift apart. */
export function shelterAgentsMd(items: ShelterWorkItem[] = SHELTER_WORK_ITEMS): string {
	const rows = items.map((w) => `| ${w.title} | \`${w.path}\` | ${w.dependencies.map((d) => `\`${d.recordId}\`: ${d.facetKeys.map((k) => `\`${k}\``).join(", ")}`).join("; ")} |`);
	return `# Agent protocol: Larkhaven shelter volunteer materials

Synthetic scenario. Not operational guidance. Larkhaven County, its river flood and the Larkhaven Mutual Aid Network are fictional.

You draft one volunteer document from the accepted policy records. There is no code in this repo.

1. Read every file under \`context/\`, and under \`.delta/context/\` when it exists (a file there replaces the same-named file in \`context/\`). Each is an accepted decision, and its front-matter \`facets\` are binding.
2. Write your document at the path for your task, and change no other file except \`.delta/claims.json\`. Your task is the title you were given.

| Task | Write to | Relies on |
| --- | --- | --- |
${rows.join("\n")}

3. Keep the document short: a title line, the line "Synthetic scenario. Not operational guidance.", then at most 15 lines of plain Markdown. Use only the facts your task relies on. Do not add facts from other facets.
4. Delta Convergence runs a plain-text contract check on your document. It cannot tell a quotation from a statement. So say each fact the way the current record says it (if a facet reads "ID not listed as a requirement", write "ID is not listed as a requirement"), and never repeat a value from a record's \`not:\` list, even to say that it changed.
5. Write \`.delta/claims.json\`: a JSON array with one entry for each facet your document states and no others, \`{"subject": "<facet key>", "value": <facet value, copied exactly>, "basedOn": "<recordId>@<version>"}\`. Cite only the records your task relies on, at the version you read.
`;
}

/** The files of the live baseline: the protocol and the two accepted records at v1. */
export function shelterBaselineFiles(): Record<string, string> {
	return {
		"AGENTS.md": shelterAgentsMd(),
		[POLICY_PATH]: asDemoOwner(shelter.SHELTER_POLICY_V1_TYPO_FIXED),
		[ROLES_PATH]: asDemoOwner(shelter.VOLUNTEER_ROLES_V1),
	};
}

export type ShelterContextChange = {
	recordId: string;
	facets: Record<string, FacetValue>;
	not: Record<string, FacetValue>;
	prose: string;
	rationale: string;
	decisionSlug: string;
};

/** The mid-run decision: crated pets are admitted (pet area in Hall B) and ID is no longer listed. Body of POST .../context-changes. */
export function shelterContextChange(): ShelterContextChange {
	const parsed = parseContextRecord(shelter.SHELTER_POLICY_V2);
	if (!parsed.ok) throw new Error(`the shelter v2 record does not parse: ${parsed.error}`);
	const fm = parsed.record.frontMatter;
	const facets = fm.facets;
	return {
		recordId: "shelter-intake-policy",
		facets,
		not: (fm.not ?? {}) as Record<string, FacetValue>,
		prose: `# Shelter intake policy (Larkhaven Mutual Aid Network)

> Synthetic scenario. Not operational guidance. Larkhaven County and its river flood are fictional.

Decision: crated pets are now admitted, and ID is no longer listed as a requirement at intake.

- Pets: ${facets["pets"]}.
- Identification: ${facets["id_required"]}.
- Capacity: ${facets["capacity_note"]}.
- Hours: ${facets["hours"]}.
`,
		rationale: "Admit crated pets with a pet area in Hall B, and stop listing ID as an intake requirement.",
		decisionSlug: "crated-pets-no-id",
	};
}

export type ShelterSeed = {
	baselineFiles: Record<string, string>;
	policy: Policy;
	workItems: ShelterWorkItem[];
	contextChange: ShelterContextChange;
};

export function buildShelterSeed(): ShelterSeed {
	return { baselineFiles: shelterBaselineFiles(), policy: SHELTER_POLICY, workItems: SHELTER_WORK_ITEMS, contextChange: shelterContextChange() };
}
