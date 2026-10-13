import {
	fakeSha,
	loadDoc,
	receiptOf,
	snapshotHashOf,
		type Claim,
	type ContextReceipt,
	type DeltaEvent,
	type Dependency,
	type Evidence,
	type Policy,
	type RecordSnapshot,
	type ScenarioDoc,
	type WorkItem,
} from "contracts";
import { actors } from "./actors";
import * as records from "./records";

export * from "./records";
export * from "./fanout";
export { actors } from "./actors";

export const REPO = "notifications-baseline";
export const WI1_REPO = "notifications-wi-1";
export const WI2_REPO = "notifications-wi-2";

export const policy: Policy = {
	version: 1,
	authority: { notifications: "decision-owner", "status-model": "decision-owner" },
	staleness: "facet",
	requires: [],
	maxRevalidations: 2,
};

/** Commits on the timeline. Baseline commits are `b…`, fork heads `f…`. */
export const commits = {
	baselineV1: fakeSha("b", 1),
	baselineTypo: fakeSha("b", 2),
	baselineV2: fakeSha("b", 3),
	baselineV3: fakeSha("b", 4),
	baselineForged: fakeSha("b", 5),
	wi1Head: fakeSha("f", 1),
	wi2HeadV1: fakeSha("f", 2),
	wi2HeadRevalidated: fakeSha("f", 3),
	wi1MergeV2: fakeSha("b", 6),
} as const;

export const ts = {
	seed: "2026-10-13T15:00:00Z",
	typo: "2026-10-13T15:30:00Z",
	v2: "2026-10-13T16:00:00Z",
	push: "2026-10-13T16:10:00Z",
	resolve: "2026-10-13T16:20:00Z",
	revalidated: "2026-10-13T16:30:00Z",
	promote: "2026-10-13T16:40:00Z",
} as const;

export const workItems = {
	wi1: {
		id: "WI-1",
		title: "Status badges and the status-change API",
		actor: actors.agentA,
		forkRepo: WI1_REPO,
		source: "live",
		intent: "delivery",
		requires: ["contract-test"],
		status: "running",
	},
	wi2: {
		id: "WI-2",
		title: "Notification preferences and delivery",
		actor: actors.agentB,
		forkRepo: WI2_REPO,
		source: "live",
		intent: "delivery",
		requires: ["contract-test"],
		status: "running",
	},
} satisfies Record<string, WorkItem>;

const STATUS_VALUES = ["draft", "active", "blocked", "done"];

/** What each agent says it built, as `.delta/claims.json`. */
export const claims = {
	wi1: [{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" }],
	/** WI-1 also leans on notifications, which is not in its receipt (R4). */
	wi1Undeclared: [
		{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" },
		{ subject: "notifications.default", value: "on", basedOn: "notifications@1" },
	],
	/** The phone-number case (R3b): one agent makes the field optional, the other requires it. */
	wi1PhoneOptional: [{ subject: "profile.phone", value: "optional", basedOn: "status-model@1" }],
	wi2PhoneRequired: [{ subject: "profile.phone", value: "required", basedOn: "notifications@1" }],
	/** WI-2 built from notifications v1: default-on, immediate. */
	wi2V1: [
		{ subject: "notifications.default", value: "on", basedOn: "notifications@1" },
		{ subject: "notifications.cadence", value: "immediate", basedOn: "notifications@1" },
		{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" },
	],
	/** WI-2 after revalidation: built from notifications v2. */
	wi2V2: [
		{ subject: "notifications.default", value: "opt-in", basedOn: "notifications@2" },
		{ subject: "notifications.cadence", value: "weekly-digest", basedOn: "notifications@2" },
		{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" },
	],
	/** Right values, but cites a superseded version of a facet that changed. */
	wi2RightValueOldBasis: [
		{ subject: "notifications.default", value: "opt-in", basedOn: "notifications@1" },
		{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" },
	],
	/** Cites a superseded version, but of a facet that did not change: not a conflict. */
	wi2UnchangedFacetOldBasis: [
		{ subject: "notifications.channel", value: "in-app", basedOn: "notifications@1" },
		{ subject: "status.values", value: STATUS_VALUES, basedOn: "status-model@1" },
	],
} satisfies Record<string, Claim[]>;

export const evidence = {
	wi1Pass: { workItemId: "WI-1", headSha: commits.wi1Head, check: records.STATUS_MODEL_CHECK, pass: true, output: "status-model: ok" },
	/** The contract test, run by Delta at WI-2's head, asserts the code's real default against v2 and fails. */
	wi2FailsV2: {
		workItemId: "WI-2",
		headSha: commits.wi2HeadV1,
		check: records.NOTIFICATIONS_CHECK,
		pass: false,
		output: "expected notifications.default == opt-in, code default is on",
	},
	wi2StatusPass: { workItemId: "WI-2", headSha: commits.wi2HeadV1, check: records.STATUS_MODEL_CHECK, pass: true, output: "status-model: ok" },
	wi2RevalidatedNotifications: {
		workItemId: "WI-2",
		headSha: commits.wi2HeadRevalidated,
		check: records.NOTIFICATIONS_CHECK,
		pass: true,
		output: "notifications.default == opt-in: ok",
	},
	wi2RevalidatedStatus: { workItemId: "WI-2", headSha: commits.wi2HeadRevalidated, check: records.STATUS_MODEL_CHECK, pass: true, output: "status-model: ok" },
} satisfies Record<string, Evidence>;

/** Declared dependencies. WI-1 never touches notifications; WI-2 relies on two of its three facets. */
export const dependencies = {
	wi1: [
		{
			workItemId: "WI-1",
			recordId: "status-model",
			facetKeys: ["status.transitions", "status.values"],
			basis: "declared",
			status: "accepted",
			evidenceRefs: [],
		},
	],
	wi2: [
		{
			workItemId: "WI-2",
			recordId: "notifications",
			facetKeys: ["notifications.cadence", "notifications.default"],
			basis: "declared",
			status: "accepted",
			evidenceRefs: [],
		},
		{ workItemId: "WI-2", recordId: "status-model", facetKeys: ["status.values"], basis: "declared", status: "accepted", evidenceRefs: [] },
	],
} satisfies Record<string, Dependency[]>;

export type NotificationsScenario = Awaited<ReturnType<typeof buildNotificationsScenario>>;

/** Build the scenario: parse and hash the record files, compile receipts, and pre-build events. */
export async function buildNotificationsScenario() {
	const docs = {
		notificationsV1: await loadDoc(records.NOTIFICATIONS_PATH, records.NOTIFICATIONS_V1),
		notificationsV1Typo: await loadDoc(records.NOTIFICATIONS_PATH, records.NOTIFICATIONS_V1_TYPO_FIX),
		notificationsV2: await loadDoc(records.NOTIFICATIONS_PATH, records.NOTIFICATIONS_V2),
		notificationsV3: await loadDoc(records.NOTIFICATIONS_PATH, records.NOTIFICATIONS_V3_PROSE_BUMP),
		notificationsForged: await loadDoc(records.NOTIFICATIONS_PATH, records.NOTIFICATIONS_V2_FORGED),
		statusModelV1: await loadDoc(records.STATUS_MODEL_PATH, records.STATUS_MODEL_V1),
	} satisfies Record<string, ScenarioDoc>;
	const snap = (key: keyof typeof docs): RecordSnapshot => docs[key].snapshot;

	/** Cell seed: the baseline at v1 with both records accepted. */
	const seed = {
		baselineCommit: commits.baselineV1,
		snapshotHash: await snapshotHashOf([snap("notificationsV1"), snap("statusModelV1")]),
		records: [snap("notificationsV1"), snap("statusModelV1")],
	};

	const receipts = {
		wi1: await receiptOf(commits.baselineV1, [snap("statusModelV1")], { noteCommit: commits.baselineV1 }),
		wi2: await receiptOf(commits.baselineV1, [snap("notificationsV1"), snap("statusModelV1")], { noteCommit: commits.baselineV1 }),
		/** What revalidating WI-2 issues: notifications v2 plus status-model v1. */
		wi2Revalidated: await receiptOf(commits.baselineV2, [snap("notificationsV2"), snap("statusModelV1")], { noteCommit: commits.wi2HeadV1 }),
	} satisfies Record<string, ContextReceipt>;

	const snapshotHashes = {
		v1: seed.snapshotHash,
		typo: await snapshotHashOf([snap("notificationsV1Typo"), snap("statusModelV1")]),
		v2: await snapshotHashOf([snap("notificationsV2"), snap("statusModelV1")]),
		v3: await snapshotHashOf([snap("notificationsV3"), snap("statusModelV1")]),
		forged: await snapshotHashOf([snap("notificationsForged"), snap("statusModelV1")]),
	};

	const baselinePush = (commitSha: string, at: string, snapshotHash: string, changed: RecordSnapshot[]): DeltaEvent => ({
		type: "BaselinePushed",
		ts: at,
		repo: REPO,
		commitSha,
		snapshotHash,
		records: changed,
		invalid: [],
	});

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
		registerWi1: { type: "WorkItemRegistered", ts: ts.seed, item: workItems.wi1, receipt: receipts.wi1, dependencies: dependencies.wi1 } satisfies DeltaEvent,
		registerWi2: { type: "WorkItemRegistered", ts: ts.seed, item: workItems.wi2, receipt: receipts.wi2, dependencies: dependencies.wi2 } satisfies DeltaEvent,
		/** The typo beat: prose-only edit to notifications v1. */
		typoFix: baselinePush(commits.baselineTypo, ts.typo, snapshotHashes.typo, [snap("notificationsV1Typo")]),
		/** The mid-flight decision change: notifications v2. */
		v2: baselinePush(commits.baselineV2, ts.v2, snapshotHashes.v2, [snap("notificationsV2")]),
		/** Version bump with the same facets as v2. */
		v3ProseBump: baselinePush(commits.baselineV3, ts.v2, snapshotHashes.v3, [snap("notificationsV3")]),
		/** A v2 "accepted" by someone who is not the authority. */
		v2Forged: baselinePush(commits.baselineForged, ts.v2, snapshotHashes.forged, [snap("notificationsForged")]),
		wi1Pushed: forkPush("WI-1", WI1_REPO, commits.wi1Head, ts.push, claims.wi1),
		wi2PushedV1: forkPush("WI-2", WI2_REPO, commits.wi2HeadV1, ts.push, claims.wi2V1),
		wi2PushedRevalidated: forkPush("WI-2", WI2_REPO, commits.wi2HeadRevalidated, ts.revalidated, claims.wi2V2),
		wi1Evidence: evidenceEvent(evidence.wi1Pass, WI1_REPO, ts.push),
		wi2FailsV2: evidenceEvent(evidence.wi2FailsV2, WI2_REPO, ts.push),
		wi2StatusPass: evidenceEvent(evidence.wi2StatusPass, WI2_REPO, ts.push),
		wi2RevalidatedNotifications: evidenceEvent(evidence.wi2RevalidatedNotifications, WI2_REPO, ts.revalidated),
		wi2RevalidatedStatus: evidenceEvent(evidence.wi2RevalidatedStatus, WI2_REPO, ts.revalidated),
		wi2ReceiptIssued: { type: "ReceiptIssued", ts: ts.revalidated, workItemId: "WI-2", receipt: receipts.wi2Revalidated } satisfies DeltaEvent,
	};

	/** What the scenario promises, step by step (PRD section 6). */
	const expected = {
		afterTypoFix: {
			effects: [{ type: "NO_ACTION", reasonCodes: ["PROSE_ONLY"] }],
			statuses: { "WI-1": "running", "WI-2": "running" },
		},
		afterV2: {
			"WI-1": { status: "running", conditions: ["Fresh"], noAction: "NO_DEPENDENCY_ON_CHANGED_FACETS" },
			"WI-2": {
				status: "stale",
				conditions: ["Stale", "Blocked"],
				staleFacets: ["notifications.cadence", "notifications.default"],
				recordRefs: ["notifications@1"],
				effects: ["RECORD_CONDITION", "REQUEST_REVIEW", "BLOCK_PROMOTION"],
			},
		},
		afterWi2Push: { "WI-2": { status: "conflict", conditions: ["Stale", "ClaimConflict", "Blocked"], conflictSubjects: ["notifications.cadence", "notifications.default"] } },
		afterWi2Tests: { "WI-2": { status: "conflict", conditions: ["Stale", "ClaimConflict", "TestFailed", "Blocked"] } },
		afterRevalidation: { "WI-2": { status: "ready", conditions: ["Fresh", "TestsPassed", "Ready"] } },
	};

	return { name: "notifications" as const, docs, seed, policy, actors, commits, workItems, dependencies, claims, evidence, receipts, snapshotHashes, events, expected, repo: REPO };
}
