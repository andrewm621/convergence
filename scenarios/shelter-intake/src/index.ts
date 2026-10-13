import {
	fakeSha,
	loadDoc,
	receiptOf,
	snapshotHashOf,
	type Actor,
	type Claim,
	type DeltaEvent,
	type Dependency,
	type Evidence,
	type Policy,
	type ScenarioDoc,
	type WorkItem,
} from "contracts";
import { runShelterIntakeCheck } from "./check";
import * as documents from "./documents";
import * as records from "./records";

export * from "./records";
export * from "./documents";
export * from "./check";

/**
 * Larkhaven County shelter rules after a flood: the knowledge-work scenario.
 *
 * Synthetic scenario. Not operational guidance. Larkhaven County, its river flood and the Larkhaven Mutual Aid
 * Network are invented. Five agents draft volunteer materials from one intake policy. The policy
 * changes mid-flight; three drafts depend on what changed, two do not.
 */

export const REPO = "shelter-intake-baseline";

export const SYNTHETIC_NOTE = "Synthetic scenario. Not operational guidance.";

export const actors = {
	coordinator: { kind: "human", id: "shelter-coordinator", displayName: "Shelter coordinator (demo identity)" },
	scriptAgent: { kind: "agent", id: "agent-script", displayName: "Script agent" },
	signageAgent: { kind: "agent", id: "agent-signage", displayName: "Signage agent" },
	briefingAgent: { kind: "agent", id: "agent-briefing", displayName: "Briefing agent" },
	suppliesAgent: { kind: "agent", id: "agent-supplies", displayName: "Supplies agent" },
	scheduleAgent: { kind: "agent", id: "agent-schedule", displayName: "Schedule agent" },
} satisfies Record<string, Actor>;

export const policy: Policy = {
	version: 1,
	authority: { "shelter-intake-policy": "shelter-coordinator", "volunteer-roles": "shelter-coordinator" },
	staleness: "facet",
	requires: [],
	maxRevalidations: 2,
};

export const commits = {
	baselineV1: fakeSha("b", 201),
	baselineTypoFixed: fakeSha("b", 202),
	baselineV2: fakeSha("b", 203),
	baselineV3: fakeSha("b", 204),
	wi1Head: fakeSha("f", 201),
	wi1HeadRevalidated: fakeSha("f", 211),
	wi2Head: fakeSha("f", 202),
	wi3Head: fakeSha("f", 203),
	wi3HeadRevalidated: fakeSha("f", 213),
	wi4Head: fakeSha("f", 204),
	wi5Head: fakeSha("f", 205),
} as const;

export const ts = {
	seed: "2026-10-13T15:00:00Z",
	push: "2026-10-13T15:30:00Z",
	v2: "2026-10-13T16:00:00Z",
	revalidated: "2026-10-13T16:30:00Z",
	v3: "2026-10-14T09:00:00Z",
} as const;

const workItem = (id: string, title: string, actor: Actor, requires: WorkItem["requires"]): WorkItem => ({
	id,
	title,
	actor,
	forkRepo: `shelter-intake-${id.toLowerCase()}`,
	source: "live",
	intent: "delivery",
	requires,
	status: "running",
});

export const workItems = {
	wi1: workItem("WI-1", "Front-desk intake script", actors.scriptAgent, ["contract-test", "human-resolution"]),
	wi2: workItem("WI-2", "Door signage text", actors.signageAgent, ["human-resolution"]),
	wi3: workItem("WI-3", "Volunteer briefing one-pager", actors.briefingAgent, ["contract-test", "human-resolution"]),
	wi4: workItem("WI-4", "Cots and blankets supply list", actors.suppliesAgent, ["contract-test"]),
	wi5: workItem("WI-5", "Shift schedule", actors.scheduleAgent, ["contract-test"]),
} satisfies Record<string, WorkItem>;

const POLICY_V1 = "shelter-intake-policy@1";
const POLICY_V2 = "shelter-intake-policy@2";
const ROLES_V1 = "volunteer-roles@1";

const V1_PETS = "service animals only";
const V1_ID = "ID required";
const V1_HOURS = "doors open 7:00 to 21:00 daily";
const V1_CAPACITY = "Hall A holds 120 cots; the shift lead decides on overflow";
const V2_PETS = "crated pets admitted, pet area in Hall B";
const V2_ID = "ID not listed as a requirement";

export const claims = {
	/** Built on v1: the script says ID required and service animals only. */
	wi1V1: [
		{ subject: "pets", value: V1_PETS, basedOn: POLICY_V1 },
		{ subject: "id_required", value: V1_ID, basedOn: POLICY_V1 },
	],
	wi1V2: [
		{ subject: "pets", value: V2_PETS, basedOn: POLICY_V2 },
		{ subject: "id_required", value: V2_ID, basedOn: POLICY_V2 },
	],
	wi2V1: [{ subject: "pets", value: V1_PETS, basedOn: POLICY_V1 }],
	wi3V1: [
		{ subject: "pets", value: V1_PETS, basedOn: POLICY_V1 },
		{ subject: "id_required", value: V1_ID, basedOn: POLICY_V1 },
		{ subject: "hours", value: V1_HOURS, basedOn: POLICY_V1 },
	],
	wi3V2: [
		{ subject: "pets", value: V2_PETS, basedOn: POLICY_V2 },
		{ subject: "id_required", value: V2_ID, basedOn: POLICY_V2 },
		{ subject: "hours", value: V1_HOURS, basedOn: POLICY_V2 },
	],
	/** Unchanged facets only: citing v1 is fine because capacity_note did not move. */
	wi4: [{ subject: "capacity_note", value: V1_CAPACITY, basedOn: POLICY_V1 }],
	wi5: [
		{ subject: "hours", value: V1_HOURS, basedOn: POLICY_V1 },
		{ subject: "greeter", value: "welcomes each household at the main door and points them to the intake desk", basedOn: ROLES_V1 },
	],
} satisfies Record<string, Claim[]>;

const accepted = (workItemId: string, recordId: string, facetKeys: string[]): Dependency => ({
	workItemId,
	recordId,
	facetKeys,
	basis: "declared",
	status: "accepted",
	evidenceRefs: [],
});

export const dependencies = {
	wi1: [accepted("WI-1", "shelter-intake-policy", ["pets", "id_required"])],
	wi2: [accepted("WI-2", "shelter-intake-policy", ["pets"])],
	wi3: [accepted("WI-3", "shelter-intake-policy", ["pets", "id_required", "hours"])],
	wi4: [accepted("WI-4", "shelter-intake-policy", ["capacity_note"])],
	wi5: [accepted("WI-5", "volunteer-roles", ["greeter", "intake_desk"]), accepted("WI-5", "shelter-intake-policy", ["hours"])],
} satisfies Record<string, Dependency[]>;

export type ShelterIntakeScenario = Awaited<ReturnType<typeof buildShelterIntakeScenario>>;

export async function buildShelterIntakeScenario() {
	const docs = {
		policyV1: await loadDoc(records.SHELTER_POLICY_PATH, records.SHELTER_POLICY_V1),
		policyV1TypoFixed: await loadDoc(records.SHELTER_POLICY_PATH, records.SHELTER_POLICY_V1_TYPO_FIXED),
		policyV2: await loadDoc(records.SHELTER_POLICY_PATH, records.SHELTER_POLICY_V2),
		policyV3: await loadDoc(records.SHELTER_POLICY_PATH, records.SHELTER_POLICY_V3),
		rolesV1: await loadDoc(records.VOLUNTEER_ROLES_PATH, records.VOLUNTEER_ROLES_V1),
	} satisfies Record<string, ScenarioDoc>;
	const policyV1 = docs.policyV1.snapshot;
	const policyTypo = docs.policyV1TypoFixed.snapshot;
	const policyV2 = docs.policyV2.snapshot;
	const policyV3 = docs.policyV3.snapshot;
	const rolesV1 = docs.rolesV1.snapshot;

	const seed = { baselineCommit: commits.baselineV1, snapshotHash: await snapshotHashOf([policyV1, rolesV1]), records: [policyV1, rolesV1] };
	const snapshotHashes = {
		v1: seed.snapshotHash,
		typoFixed: await snapshotHashOf([policyTypo, rolesV1]),
		v2: await snapshotHashOf([policyV2, rolesV1]),
		v3: await snapshotHashOf([policyV3, rolesV1]),
	};

	const receipts = {
		wi1: await receiptOf(commits.baselineV1, [policyV1], { noteCommit: commits.baselineV1 }),
		wi2: await receiptOf(commits.baselineV1, [policyV1], { noteCommit: commits.baselineV1 }),
		wi3: await receiptOf(commits.baselineV1, [policyV1], { noteCommit: commits.baselineV1 }),
		wi4: await receiptOf(commits.baselineV1, [policyV1], { noteCommit: commits.baselineV1 }),
		wi5: await receiptOf(commits.baselineV1, [policyV1, rolesV1], { noteCommit: commits.baselineV1 }),
		wi1Revalidated: await receiptOf(commits.baselineV2, [policyV2], { noteCommit: commits.wi1Head }),
		wi3Revalidated: await receiptOf(commits.baselineV2, [policyV2], { noteCommit: commits.wi3Head }),
	};

	// R8: the check really runs, here against the facets accepted at v2. Nothing below is hand-written as pass or fail.
	const facetsV2 = policyV2.facets;
	const run = (workItemId: string, headSha: string, path: string, body: string, facets = facetsV2): Evidence => {
		const result = runShelterIntakeCheck(path, body, facets);
		return { workItemId, headSha, check: records.SHELTER_INTAKE_CHECK, pass: result.pass, output: result.output };
	};
	const evidence = {
		wi1: run("WI-1", commits.wi1Head, documents.SCRIPT_PATH, documents.SCRIPT_V1),
		wi1Revalidated: run("WI-1", commits.wi1HeadRevalidated, documents.SCRIPT_PATH, documents.SCRIPT_V2),
		wi3: run("WI-3", commits.wi3Head, documents.BRIEFING_PATH, documents.BRIEFING_V1),
		wi3Revalidated: run("WI-3", commits.wi3HeadRevalidated, documents.BRIEFING_PATH, documents.BRIEFING_V2),
		wi4: run("WI-4", commits.wi4Head, documents.SUPPLIES_PATH, documents.SUPPLIES_V1),
		wi5: run("WI-5", commits.wi5Head, documents.SCHEDULE_PATH, documents.SCHEDULE_V1),
	} satisfies Record<string, Evidence>;

	const forkPush = (item: WorkItem, commitSha: string, at: string, claimsJson: unknown): DeltaEvent => ({
		type: "ForkPushed",
		ts: at,
		repo: item.forkRepo,
		commitSha,
		workItemId: item.id,
		claims: claimsJson,
		contextPaths: [],
	});
	const evidenceEvent = (e: Evidence, item: WorkItem, at: string): DeltaEvent => ({
		type: "EvidenceRecorded",
		ts: at,
		repo: item.forkRepo,
		commitSha: e.headSha,
		runId: `run-${e.check}-${e.headSha.slice(0, 7)}`,
		evidence: e,
	});
	const register = (item: WorkItem, receipt: (typeof receipts)["wi1"], deps: Dependency[]): DeltaEvent => ({
		type: "WorkItemRegistered",
		ts: ts.seed,
		item,
		receipt,
		dependencies: deps,
	});
	const baseline = (commitSha: string, at: string, snapshotHash: string, changed: ScenarioDoc[]): DeltaEvent => ({
		type: "BaselinePushed",
		ts: at,
		repo: REPO,
		commitSha,
		snapshotHash,
		records: changed.map((doc) => doc.snapshot),
		invalid: [],
	});

	const events = {
		registerWi1: register(workItems.wi1, receipts.wi1, dependencies.wi1),
		registerWi2: register(workItems.wi2, receipts.wi2, dependencies.wi2),
		registerWi3: register(workItems.wi3, receipts.wi3, dependencies.wi3),
		registerWi4: register(workItems.wi4, receipts.wi4, dependencies.wi4),
		registerWi5: register(workItems.wi5, receipts.wi5, dependencies.wi5),
		/** A typo fixed in the welcome text of v1. Prose only. */
		proseOnly: baseline(commits.baselineTypoFixed, ts.v2, snapshotHashes.typoFixed, [docs.policyV1TypoFixed]),
		/** Mid-flight: shelter-intake-policy v2 admits crated pets and drops the ID requirement. */
		v2: baseline(commits.baselineV2, ts.v2, snapshotHashes.v2, [docs.policyV2]),
		/** Later: v3 changes capacity only. Any new version ends a scoped exception. */
		v3: baseline(commits.baselineV3, ts.v3, snapshotHashes.v3, [docs.policyV3]),
		wi1Pushed: forkPush(workItems.wi1, commits.wi1Head, ts.push, claims.wi1V1),
		wi1Evidence: evidenceEvent(evidence.wi1, workItems.wi1, ts.push),
		wi1PushedRevalidated: forkPush(workItems.wi1, commits.wi1HeadRevalidated, ts.revalidated, claims.wi1V2),
		wi1RevalidatedEvidence: evidenceEvent(evidence.wi1Revalidated, workItems.wi1, ts.revalidated),
		wi1ReceiptIssued: { type: "ReceiptIssued", ts: ts.revalidated, workItemId: "WI-1", receipt: receipts.wi1Revalidated } satisfies DeltaEvent,
		wi2Pushed: forkPush(workItems.wi2, commits.wi2Head, ts.push, claims.wi2V1),
		wi3Pushed: forkPush(workItems.wi3, commits.wi3Head, ts.push, claims.wi3V1),
		wi3Evidence: evidenceEvent(evidence.wi3, workItems.wi3, ts.push),
		wi3PushedRevalidated: forkPush(workItems.wi3, commits.wi3HeadRevalidated, ts.revalidated, claims.wi3V2),
		wi3RevalidatedEvidence: evidenceEvent(evidence.wi3Revalidated, workItems.wi3, ts.revalidated),
		wi3ReceiptIssued: { type: "ReceiptIssued", ts: ts.revalidated, workItemId: "WI-3", receipt: receipts.wi3Revalidated } satisfies DeltaEvent,
		wi4Pushed: forkPush(workItems.wi4, commits.wi4Head, ts.push, claims.wi4),
		wi4Evidence: evidenceEvent(evidence.wi4, workItems.wi4, ts.push),
		wi5Pushed: forkPush(workItems.wi5, commits.wi5Head, ts.push, claims.wi5),
		wi5Evidence: evidenceEvent(evidence.wi5, workItems.wi5, ts.push),
	};

	const expected = {
		afterV2: {
			"WI-1": { status: "stale", staleFacets: ["id_required", "pets"] },
			"WI-2": { status: "stale", staleFacets: ["pets"] },
			"WI-3": { status: "stale", staleFacets: ["id_required", "pets"] },
			"WI-4": { status: "running", noAction: "NO_DEPENDENCY_ON_CHANGED_FACETS" },
			"WI-5": { status: "running", noAction: "NO_DEPENDENCY_ON_CHANGED_FACETS" },
		},
		/** The signage takes a scoped exception; the script and the briefing are revalidated. */
		resolutions: {
			"WI-1": { kind: "revalidate" },
			"WI-2": {
				kind: "accept-exception",
				scope: "signs/door.md",
				rationale: "Existing printed signs stay posted until replacements arrive; the exception expires on the next policy version.",
			},
			"WI-3": { kind: "revalidate" },
		},
	};

	return {
		name: "shelter-intake" as const,
		docs,
		seed,
		policy,
		actors,
		commits,
		workItems,
		dependencies,
		claims,
		evidence,
		receipts,
		snapshotHashes,
		events,
		expected,
		repo: REPO,
	};
}
