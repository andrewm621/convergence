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
import * as records from "./records";

export * from "./records";

export const REPO = "sales-ops-baseline";

export const actors = {
	decisionOwner: { kind: "human", id: "decision-owner", displayName: "Decision owner (demo identity)" },
	agentC: { kind: "agent", id: "agent-c", displayName: "Agent C" },
	agentD: { kind: "agent", id: "agent-d", displayName: "Agent D" },
	agentE: { kind: "agent", id: "agent-e", displayName: "Agent E" },
} satisfies Record<string, Actor>;

export const policy: Policy = {
	version: 1,
	authority: { "qualified-lead": "decision-owner", "sales-activity": "decision-owner" },
	staleness: "facet",
	requires: [],
	maxRevalidations: 2,
};

export const commits = {
	baselineV1: fakeSha("b", 101),
	baselineV2: fakeSha("b", 102),
	baselineReworded: fakeSha("b", 103),
	wi3Head: fakeSha("f", 103),
	wi4Head: fakeSha("f", 104),
	wi4HeadRevalidated: fakeSha("f", 114),
	wi5Head: fakeSha("f", 105),
} as const;

export const ts = {
	seed: "2026-10-13T15:00:00Z",
	push: "2026-10-13T15:30:00Z",
	v2: "2026-10-13T16:00:00Z",
	revalidated: "2026-10-13T16:30:00Z",
} as const;

export const workItems = {
	wi3: {
		id: "WI-3",
		title: "Q4 pipeline forecast",
		actor: actors.agentC,
		forkRepo: "sales-ops-wi-3",
		source: "live",
		intent: "delivery",
		requires: ["human-resolution"],
		status: "running",
	},
	wi4: {
		id: "WI-4",
		title: "SDR weekly priorities",
		actor: actors.agentD,
		forkRepo: "sales-ops-wi-4",
		source: "live",
		intent: "delivery",
		requires: ["contract-test", "human-resolution"],
		status: "running",
	},
	wi5: {
		id: "WI-5",
		title: "Activity glossary",
		actor: actors.agentE,
		forkRepo: "sales-ops-wi-5",
		source: "live",
		intent: "delivery",
		requires: ["contract-test"],
		status: "running",
	},
} satisfies Record<string, WorkItem>;

const TOUCH_TYPES = ["call", "email", "meeting"];

export const claims = {
	/** WI-3's forecast counts leads by the v1 criteria. */
	wi3V1: [
		{ subject: "lead.qualified.criteria", value: "form-fill-and-50-plus-employees", basedOn: "qualified-lead@1" },
		{ subject: "lead.qualified.min-employees", value: 50, basedOn: "qualified-lead@1" },
	],
	wi4V1: [
		{ subject: "lead.qualified.criteria", value: "form-fill-and-50-plus-employees", basedOn: "qualified-lead@1" },
		{ subject: "activity.touch.types", value: TOUCH_TYPES, basedOn: "sales-activity@1" },
	],
	wi4V2: [
		{ subject: "lead.qualified.criteria", value: "form-fill-50-plus-employees-and-verified-budget", basedOn: "qualified-lead@2" },
		{ subject: "activity.touch.types", value: TOUCH_TYPES, basedOn: "sales-activity@1" },
	],
	wi5: [{ subject: "activity.touch.types", value: TOUCH_TYPES, basedOn: "sales-activity@1" }],
} satisfies Record<string, Claim[]>;

export const evidence = {
	wi4RevalidatedCriteria: {
		workItemId: "WI-4",
		headSha: commits.wi4HeadRevalidated,
		check: records.QUALIFIED_LEAD_CHECK,
		pass: true,
		output: "priorities use the verified-budget criteria: ok",
	},
	wi4RevalidatedActivity: {
		workItemId: "WI-4",
		headSha: commits.wi4HeadRevalidated,
		check: records.SALES_ACTIVITY_CHECK,
		pass: true,
		output: "touch types match the glossary: ok",
	},
	wi5Pass: { workItemId: "WI-5", headSha: commits.wi5Head, check: records.SALES_ACTIVITY_CHECK, pass: true, output: "glossary matches sales-activity: ok" },
} satisfies Record<string, Evidence>;

const accepted = (workItemId: string, recordId: string, facetKeys: string[]): Dependency => ({
	workItemId,
	recordId,
	facetKeys,
	basis: "declared",
	status: "accepted",
	evidenceRefs: [],
});

export const dependencies = {
	wi3: [accepted("WI-3", "qualified-lead", ["lead.qualified.criteria", "lead.qualified.min-employees"])],
	wi4: [accepted("WI-4", "qualified-lead", ["lead.qualified.criteria"]), accepted("WI-4", "sales-activity", ["activity.touch.types"])],
	wi5: [accepted("WI-5", "sales-activity", ["activity.counts-as-touch", "activity.touch.types"])],
} satisfies Record<string, Dependency[]>;

export type SalesOpsScenario = Awaited<ReturnType<typeof buildSalesOpsScenario>>;

export async function buildSalesOpsScenario() {
	const docs = {
		qualifiedLeadV1: await loadDoc(records.QUALIFIED_LEAD_PATH, records.QUALIFIED_LEAD_V1),
		qualifiedLeadV1Reworded: await loadDoc(records.QUALIFIED_LEAD_PATH, records.QUALIFIED_LEAD_V1_REWORDED),
		qualifiedLeadV2: await loadDoc(records.QUALIFIED_LEAD_PATH, records.QUALIFIED_LEAD_V2),
		salesActivityV1: await loadDoc(records.SALES_ACTIVITY_PATH, records.SALES_ACTIVITY_V1),
	} satisfies Record<string, ScenarioDoc>;
	const qlV1 = docs.qualifiedLeadV1.snapshot;
	const qlV2 = docs.qualifiedLeadV2.snapshot;
	const saV1 = docs.salesActivityV1.snapshot;

	const seed = { baselineCommit: commits.baselineV1, snapshotHash: await snapshotHashOf([qlV1, saV1]), records: [qlV1, saV1] };
	const qlReworded = docs.qualifiedLeadV1Reworded.snapshot;
	const snapshotHashes = { v1: seed.snapshotHash, reworded: await snapshotHashOf([qlReworded, saV1]), v2: await snapshotHashOf([qlV2, saV1]) };

	const receipts = {
		wi3: await receiptOf(commits.baselineV1, [qlV1], { noteCommit: commits.baselineV1 }),
		wi4: await receiptOf(commits.baselineV1, [qlV1, saV1], { noteCommit: commits.baselineV1 }),
		wi5: await receiptOf(commits.baselineV1, [saV1], { noteCommit: commits.baselineV1 }),
		wi4Revalidated: await receiptOf(commits.baselineV2, [qlV2, saV1], { noteCommit: commits.wi4Head }),
	};

	const forkPush = (workItemId: string, repo: string, commitSha: string, at: string, claimsJson: unknown): DeltaEvent => ({
		type: "ForkPushed",
		ts: at,
		repo,
		commitSha,
		workItemId,
		claims: claimsJson,
		contextPaths: [],
	});
	const evidenceEvent = (e: Evidence, repo: string, at: string): DeltaEvent => ({ type: "EvidenceRecorded", ts: at, repo, commitSha: e.headSha, runId: `run-${e.check}-${e.headSha.slice(0, 7)}`, evidence: e });

	const events = {
		registerWi3: { type: "WorkItemRegistered", ts: ts.seed, item: workItems.wi3, receipt: receipts.wi3, dependencies: dependencies.wi3 } satisfies DeltaEvent,
		registerWi4: { type: "WorkItemRegistered", ts: ts.seed, item: workItems.wi4, receipt: receipts.wi4, dependencies: dependencies.wi4 } satisfies DeltaEvent,
		registerWi5: { type: "WorkItemRegistered", ts: ts.seed, item: workItems.wi5, receipt: receipts.wi5, dependencies: dependencies.wi5 } satisfies DeltaEvent,
		/** A prose-only edit to qualified-lead v1. */
		proseOnly: { type: "BaselinePushed", ts: ts.v2, repo: REPO, commitSha: commits.baselineReworded, snapshotHash: snapshotHashes.reworded, records: [qlReworded], invalid: [] } satisfies DeltaEvent,
		/** Mid-flight: qualified-lead v2 adds the verified budget signal. */
		v2: { type: "BaselinePushed", ts: ts.v2, repo: REPO, commitSha: commits.baselineV2, snapshotHash: snapshotHashes.v2, records: [qlV2], invalid: [] } satisfies DeltaEvent,
		wi3Pushed: forkPush("WI-3", workItems.wi3.forkRepo, commits.wi3Head, ts.push, claims.wi3V1),
		wi4Pushed: forkPush("WI-4", workItems.wi4.forkRepo, commits.wi4Head, ts.push, claims.wi4V1),
		wi4PushedRevalidated: forkPush("WI-4", workItems.wi4.forkRepo, commits.wi4HeadRevalidated, ts.revalidated, claims.wi4V2),
		wi5Pushed: forkPush("WI-5", workItems.wi5.forkRepo, commits.wi5Head, ts.push, claims.wi5),
		wi5Evidence: evidenceEvent(evidence.wi5Pass, workItems.wi5.forkRepo, ts.push),
		wi4RevalidatedCriteria: evidenceEvent(evidence.wi4RevalidatedCriteria, workItems.wi4.forkRepo, ts.revalidated),
		wi4RevalidatedActivity: evidenceEvent(evidence.wi4RevalidatedActivity, workItems.wi4.forkRepo, ts.revalidated),
		wi4ReceiptIssued: { type: "ReceiptIssued", ts: ts.revalidated, workItemId: "WI-4", receipt: receipts.wi4Revalidated } satisfies DeltaEvent,
	};

	const expected = {
		afterV2: {
			"WI-3": { status: "stale", staleFacets: ["lead.qualified.criteria"] },
			"WI-4": { status: "stale", staleFacets: ["lead.qualified.criteria"] },
			"WI-5": { status: "running", noAction: "NO_DEPENDENCY_ON_CHANGED_FACETS" },
		},
		/** WI-3 takes a scoped exception (grandfathered for the board deck); WI-4 is revalidated. */
		resolutions: {
			"WI-3": { kind: "accept-exception", scope: "reports/q4-forecast.md" },
			"WI-4": { kind: "revalidate" },
		},
	};

	return { name: "sales-ops" as const, docs, seed, policy, actors, commits, workItems, dependencies, claims, evidence, receipts, snapshotHashes, events, expected, repo: REPO };
}
