/**
 * The conformance vectors, defined as event sequences over the scenario fixtures and run through the reference
 * engine to produce the expected projections. `generateVectors()` is deterministic: fixed fixtures, fixed
 * timestamps, fixed commit ids, no clock and no randomness, so re-running it gives byte-identical files.
 *
 * Each definition replays `setup` from the fixture's seed state, then applies `when`. The state just before
 * `when` is the vector's `given.state`; the reference engine's result, projected, is its `then`.
 */
import {
	CellState,
	DeltaEvent,
	Policy,
	canonicalJsonPretty,
	fakeSha,
	hashFacets,
	sha256Hex,
	canonicalJson,
	snapshotHashOf,
	type Actor,
	type CellState as CellStateType,
	type ContextReceipt,
	type Dependency,
	type RecordSnapshot,
	type ResolutionBinding,
	type WorkItem,
} from "contracts";
import { createCellState, currentSnapshot, reconcile, type CellStateInit } from "delta-core";
import { buildDogfoodBuildScenario } from "scenario-delta-convergence-build";
import { buildNotificationsScenario } from "scenario-notifications";
import { buildSalesOpsScenario } from "scenario-sales-ops";
import { buildShelterIntakeScenario } from "scenario-shelter-intake";
import { PROTOCOL, project, type Polarity, type Vector } from "../lib/project.ts";

type Fixture = { name: string; seed: CellStateInit; policy: Policy };
type Step = DeltaEvent | ((state: CellStateType) => DeltaEvent | Promise<DeltaEvent>);
type Definition = {
	id: string;
	description: string;
	rules: string[];
	polarity: Polarity;
	fixture: Fixture;
	policy?: Policy;
	setup: Step[];
	when: Step;
	sequence?: { name: string; step: number };
};

const T = "2026-10-13T17:00:00Z";
const T2 = "2026-10-13T17:05:00Z";

// ---------- small, deterministic event builders ----------

/** A record version that is not one of the fixture files: real facet hash, and a blob hash derived from the content (the engine treats it as opaque). */
async function variantOf(base: RecordSnapshot, patch: Partial<RecordSnapshot>): Promise<RecordSnapshot> {
	const { blobHash: _b, facetHash: _f, ...content } = { ...base, ...patch };
	return { ...content, blobHash: await sha256Hex(canonicalJson(content)), facetHash: await hashFacets(content.facets) };
}

/** A baseline push of `records`. The snapshot hash is computed over the accepted heads the push would leave. */
function baselinePush(repo: string, commitSha: string, records: RecordSnapshot[], ts = T): Step {
	return async (state) => {
		const heads = new Map<string, RecordSnapshot>();
		for (const recordId of Object.keys(state.records).sort()) {
			const head = currentSnapshot(state, recordId);
			if (head) heads.set(recordId, head);
		}
		for (const record of records) {
			const head = heads.get(record.recordId);
			if (record.status === "accepted" && (!head || record.version >= head.version)) heads.set(record.recordId, record);
		}
		return { type: "BaselinePushed", ts, repo, commitSha, snapshotHash: await snapshotHashOf([...heads.values()]), records, invalid: [] };
	};
}

function forkPush(item: { id: string; forkRepo: string }, commitSha: string, claims: unknown, options: { ts?: string; contextPaths?: string[] } = {}): DeltaEvent {
	return { type: "ForkPushed", ts: options.ts ?? T, repo: item.forkRepo, commitSha, workItemId: item.id, claims, contextPaths: options.contextPaths ?? [] };
}

function register(id: string, actor: Actor, receipt: ContextReceipt, dependencies: Array<Pick<Dependency, "recordId" | "facetKeys">>, requires: WorkItem["requires"] = []): DeltaEvent {
	return {
		type: "WorkItemRegistered",
		ts: "2026-10-13T15:00:00Z",
		item: { id, title: `Conformance item ${id}`, actor, forkRepo: `conformance-${id.toLowerCase()}`, source: "seeded", intent: "delivery", requires, status: "running" },
		receipt,
		dependencies: dependencies.map((d) => ({ workItemId: id, basis: "declared", status: "accepted", evidenceRefs: [], ...d })),
	};
}

function fork(id: string): { id: string; forkRepo: string } {
	return { id, forkRepo: `conformance-${id.toLowerCase()}` };
}

/** The binding a console would attach to a resolution made against the state it shows. */
function bindingFor(state: CellStateType, workItemId: string, recordId: string): ResolutionBinding {
	const wi = state.workItems[workItemId];
	const record = currentSnapshot(state, recordId);
	if (!wi || !record || wi.headSha === null) throw new Error(`cannot bind ${workItemId}/${recordId}`);
	return { recordId, version: record.version, blobHash: record.blobHash, baseSha: state.baselineCommit, forkHeadSha: wi.headSha, contextSnapshotHash: state.snapshotHash };
}

type ResolveOptions = { scope?: string; rationale?: string; ts?: string; binding?: Partial<ResolutionBinding> };

function resolve(kind: "revalidate" | "accept-exception" | "reject", workItemId: string, recordId: string, actor: Actor, requestId: string, options: ResolveOptions = {}): Step {
	return (state) => {
		const ts = options.ts ?? T;
		return {
			type: "ResolutionRecorded",
			ts,
			requestId,
			resolution: {
				kind,
				workItemId,
				actor,
				rationale: options.rationale ?? "Conformance vector rationale.",
				...(options.scope ? { scope: options.scope } : {}),
				binding: { ...bindingFor(state, workItemId, recordId), ...options.binding },
				requestId,
				ts,
			},
		};
	};
}

function promote(workItemId: string, actor: Actor, requestId: string, overrides: { expectedBaselineCommit?: string; forkHeadSha?: string } = {}): Step {
	return (state) => ({
		type: "PromotionRequested",
		ts: T2,
		requestId,
		workItemId,
		actor,
		expectedBaselineCommit: overrides.expectedBaselineCommit ?? state.baselineCommit,
		forkHeadSha: overrides.forkHeadSha ?? state.workItems[workItemId]?.headSha ?? fakeSha("e", 0),
	});
}

function merged(workItemId: string, repo: string, mergeCommitSha: string): DeltaEvent {
	return { type: "PromotionMerged", ts: "2026-10-13T17:10:00Z", workItemId, repo, mergeCommitSha };
}

// ---------- the definitions ----------

async function definitions(): Promise<Definition[]> {
	const n = await buildNotificationsScenario();
	const s = await buildSalesOpsScenario();
	const sh = await buildShelterIntakeScenario();
	const d = await buildDogfoodBuildScenario();
	const N: Fixture = { name: n.name, seed: n.seed, policy: n.policy };
	const S: Fixture = { name: s.name, seed: s.seed, policy: s.policy };
	const SH: Fixture = { name: sh.name, seed: sh.seed, policy: sh.policy };
	const D: Fixture = { name: d.name, seed: d.seed, policy: d.policy };

	const owner = n.actors.decisionOwner;
	const casey: Actor = { kind: "human", id: "casey", displayName: "Casey (not the authority)" };
	const coordinator = sh.actors.coordinator;
	const nBase = [n.events.registerWi1, n.events.registerWi2];
	const sBase = [s.events.registerWi3, s.events.registerWi4, s.events.registerWi5];
	const shBase = [sh.events.registerWi1, sh.events.registerWi2, sh.events.registerWi3, sh.events.registerWi4, sh.events.registerWi5];
	const nv2 = n.docs.notificationsV2.snapshot;
	const sm1 = n.docs.statusModelV1.snapshot;
	const ql2 = s.docs.qualifiedLeadV2.snapshot;

	/** WI-2 after notifications v2 and its v1-built push: stale and conflicting, a fork head to bind to. */
	const wi2Conflicted = [...nBase, n.events.v2, n.events.wi2PushedV1];
	/** The revalidate command for that state, fixed so that a retry can repeat it byte for byte. */
	const revalidateWi2: DeltaEvent = {
		type: "ResolutionRecorded",
		ts: T,
		requestId: "rv-wi2",
		resolution: {
			kind: "revalidate",
			workItemId: "WI-2",
			actor: owner,
			rationale: "The notifications decision changed; rebuild against v2.",
			binding: { recordId: "notifications", version: 2, blobHash: nv2.blobHash, baseSha: n.commits.baselineV2, forkHeadSha: n.commits.wi2HeadV1, contextSnapshotHash: n.snapshotHashes.v2 },
			requestId: "rv-wi2",
			ts: T,
		},
	};
	const wi1Ready = [...nBase, n.events.wi1Pushed, n.events.wi1Evidence];
	const salesException = (requestId: string) => resolve("accept-exception", "WI-3", "qualified-lead", owner, requestId, { scope: "reports/q4-forecast.md", rationale: "Grandfathered on v1 for the board deck." });
	const wi3Excepted = [...sBase, s.events.v2, s.events.wi3Pushed, salesException("exc-wi3")];
	const statusModelV2 = await variantOf(sm1, { version: 2, acceptedAt: "2026-10-13T17:02:00Z", facets: { ...sm1.facets, "status.values": ["draft", "active", "done"] } });
	const dogfoodBefore = d.timeline.slice(0, d.timeline.findIndex((step) => step.key === "evidenceV2")).map((step) => step.event);

	const we = (step: number, slug: string, def: Omit<Definition, "id" | "fixture" | "sequence">): Definition => ({
		id: `we-${String(step).padStart(2, "0")}-${slug}`,
		fixture: N,
		sequence: { name: "worked-example", step },
		...def,
	});
	// The worked example of PROTOCOL.md section 2, one vector per step, each starting where the previous one ended.
	const workedExample: Definition[] = [
		we(1, "decision-changes-mid-flight", {
			description: "notifications@2 is accepted. WI-2 relied on the two facets that changed, so it is Stale and blocked. WI-1 relies only on status-model and is left alone with NO_ACTION.",
			rules: ["R1", "R2"],
			polarity: "positive",
			setup: [...nBase],
			when: n.events.v2,
		}),
		we(2, "agent-pushes-v1-claims", {
			description: "WI-2's agent pushes claims built on notifications@1. They conflict with the accepted v2 (CLAIM_CONFLICT, SUPERSEDED_BASIS).",
			rules: ["R3"],
			polarity: "positive",
			setup: [...nBase, n.events.v2],
			when: n.events.wi2PushedV1,
		}),
		we(3, "contract-check-fails", {
			description: "The adapter runs the notifications contract check at WI-2's head against v2; it fails (TestFailed).",
			rules: ["R8"],
			polarity: "positive",
			setup: [...wi2Conflicted],
			when: n.events.wi2FailsV2,
		}),
		we(4, "promotion-blocked", {
			description: "A human asks to promote WI-2. The branch would merge cleanly, but the gate refuses: stale receipt, claim conflict, failing check.",
			rules: ["R5", "R7"],
			polarity: "positive",
			setup: [...wi2Conflicted, n.events.wi2FailsV2],
			when: promote("WI-2", owner, "promote-wi2-early"),
		}),
		we(5, "human-revalidates", {
			description: "The decision owner revalidates WI-2, bound to the current state. The engine asks for a diff-aware re-run (REQUEST_REVALIDATION, DISPATCH_WORK).",
			rules: ["R6", "R7"],
			polarity: "positive",
			setup: [...wi2Conflicted, n.events.wi2FailsV2, promote("WI-2", owner, "promote-wi2-early")],
			when: revalidateWi2,
		}),
		we(6, "receipt-at-v2", {
			description: "The adapter issues WI-2 a new receipt at notifications@2. It matches the current versions, so it is taken and Stale clears.",
			rules: ["R6"],
			polarity: "positive",
			setup: [...wi2Conflicted, n.events.wi2FailsV2, promote("WI-2", owner, "promote-wi2-early"), revalidateWi2],
			when: n.events.wi2ReceiptIssued,
		}),
		we(7, "agent-pushes-v2-claims", {
			description: "The agent reruns and pushes claims built on v2. No conflict remains and the revalidation ends.",
			rules: ["R3", "R6"],
			polarity: "negative",
			setup: [...wi2Conflicted, n.events.wi2FailsV2, promote("WI-2", owner, "promote-wi2-early"), revalidateWi2, n.events.wi2ReceiptIssued],
			when: n.events.wi2PushedRevalidated,
		}),
		we(8, "notifications-check-passes", {
			description: "The notifications contract check passes at the new head. One required check still has no evidence.",
			rules: ["R8"],
			polarity: "negative",
			setup: [...wi2Conflicted, n.events.wi2FailsV2, promote("WI-2", owner, "promote-wi2-early"), revalidateWi2, n.events.wi2ReceiptIssued, n.events.wi2PushedRevalidated],
			when: n.events.wi2RevalidatedNotifications,
		}),
		we(9, "status-check-passes", {
			description: "The status-model check passes too. WI-2 is Ready.",
			rules: ["R5", "R8"],
			polarity: "negative",
			setup: [...wi2Conflicted, n.events.wi2FailsV2, promote("WI-2", owner, "promote-wi2-early"), revalidateWi2, n.events.wi2ReceiptIssued, n.events.wi2PushedRevalidated, n.events.wi2RevalidatedNotifications],
			when: n.events.wi2RevalidatedStatus,
		}),
		we(10, "promotion-allowed", {
			description: "A human asks to promote WI-2 at the current heads. The gate clears: ALLOW_PROMOTION for the fork head.",
			rules: ["R5", "R7"],
			polarity: "negative",
			setup: [...wi2Conflicted, n.events.wi2FailsV2, promote("WI-2", owner, "promote-wi2-early"), revalidateWi2, n.events.wi2ReceiptIssued, n.events.wi2PushedRevalidated, n.events.wi2RevalidatedNotifications, n.events.wi2RevalidatedStatus],
			when: promote("WI-2", owner, "promote-wi2"),
		}),
		we(11, "merge-recorded", {
			description: "The adapter merges and reports it. The gate still passes and an approval exists, so WI-2 is Promoted and the baseline moves to the merge commit.",
			rules: ["R7"],
			polarity: "negative",
			setup: [
				...wi2Conflicted,
				n.events.wi2FailsV2,
				promote("WI-2", owner, "promote-wi2-early"),
				revalidateWi2,
				n.events.wi2ReceiptIssued,
				n.events.wi2PushedRevalidated,
				n.events.wi2RevalidatedNotifications,
				n.events.wi2RevalidatedStatus,
				promote("WI-2", owner, "promote-wi2"),
			],
			when: merged("WI-2", n.repo, fakeSha("b", 0x7e1)),
		}),
	];

	const rules: Array<Omit<Definition, "fixture"> & { fixture: Fixture }> = [
		// ---------- R1 ----------
		{
			id: "r1-01-record-mode-any-new-blob-stales",
			description: "With staleness: record, a prose-only edit is a change: WI-2 (which depends on notifications) is Stale with STALE_RECEIPT and no FACET_CHANGED.",
			rules: ["R1"],
			polarity: "positive",
			fixture: N,
			policy: { ...n.policy, staleness: "record" },
			setup: [...nBase],
			when: n.events.typoFix,
		},
		{
			id: "r1-02-whole-record-dependency-sees-added-facet",
			description: "A dependency with an empty facet list covers the whole record, so a facet added in qualified-lead@2 stales it.",
			rules: ["R1"],
			polarity: "positive",
			fixture: S,
			setup: [...sBase, register("WI-W", s.actors.agentC, s.receipts.wi3, [{ recordId: "qualified-lead", facetKeys: [] }])],
			when: s.events.v2,
		},
		{
			id: "r1-03-prose-only-edit",
			description: "A typo fix in notifications@1 changes no governed facet: one NO_ACTION with PROSE_ONLY, no work item changes.",
			rules: ["R1", "R2"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase],
			when: n.events.typoFix,
		},
		{
			id: "r1-04-new-version-same-facets",
			description: "notifications@3 has the same facets as v2. It becomes the head, but in facet mode it is prose-only and stales nothing.",
			rules: ["R1"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: n.events.v3ProseBump,
		},
		{
			id: "r1-05-acceptor-is-not-the-authority",
			description: "A v2 file marked accepted by an agent, not the record's authority, is refused (FORBIDDEN_ACTOR, RECORD_NOT_ACCEPTED). It is kept as a proposal and governs nothing.",
			rules: ["R1"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase],
			when: n.events.v2Forged,
		},
		{
			id: "r1-06-older-version-refused",
			description: "Re-sending notifications@1 after v2 is accepted is refused with VERSION_NOT_NEWER; the head stays at 2.",
			rules: ["R1"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: baselinePush(n.repo, fakeSha("b", 0x101), [n.docs.notificationsV1.snapshot]),
		},
		{
			id: "r1-07-accepted-version-immutable",
			description: "A file that keeps version 2 but changes a facet is refused with IMMUTABLE_VERSION.",
			rules: ["R1"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: baselinePush(n.repo, fakeSha("b", 0x102), [await variantOf(nv2, { facets: { ...nv2.facets, "notifications.default": "on" } })]),
		},
		{
			id: "r1-08-proposed-record-governs-nothing",
			description: "A proposed v2 is visible as the record's proposal but does not govern: RECORD_NOT_ACCEPTED, no work item changes.",
			rules: ["R1"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase],
			when: baselinePush(n.repo, fakeSha("b", 0x103), [await variantOf(nv2, { status: "proposed", acceptedBy: null, acceptedAt: null })]),
		},
		{
			id: "r1-09-shelter-intake-policy-v2",
			description: "Shelter intake (synthetic): policy v2 changes pets and id_required. WI-1, WI-2 and WI-3 relied on them and are Stale; WI-4 and WI-5 are left alone with the reason.",
			rules: ["R1", "R2"],
			polarity: "positive",
			fixture: SH,
			setup: [...shBase],
			when: sh.events.v2,
		},
		{
			id: "r1-10-build-history-evidence-policy-v2",
			description: "This repository's own build history, replayed: evidence-policy v2 stales the items that relied on its changed facets and leaves the rest alone.",
			rules: ["R1", "R2"],
			polarity: "positive",
			fixture: D,
			setup: dogfoodBefore,
			when: d.events.evidenceV2,
		},
		// ---------- R2 ----------
		{
			id: "r2-01-depends-only-on-unchanged-facets",
			description: "WI-X depends on notifications, but only on notifications.channel, which v2 did not change. It is left alone with NO_DEPENDENCY_ON_CHANGED_FACETS.",
			rules: ["R2"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, register("WI-X", n.actors.agentA, n.receipts.wi2, [{ recordId: "notifications", facetKeys: ["notifications.channel"] }])],
			when: n.events.v2,
		},
		{
			id: "r2-02-claims-citing-changed-record-are-refreshed",
			description: "WI-X depends only on notifications.channel, which v2 did not change, but its claims cite notifications@1 for notifications.default. It is not left alone: its claims are re-checked and now conflict (SUPERSEDED_BASIS).",
			rules: ["R2", "R3"],
			polarity: "negative",
			fixture: N,
			setup: [
				...nBase,
				register("WI-X", n.actors.agentA, n.receipts.wi2, [{ recordId: "notifications", facetKeys: ["notifications.channel"] }]),
				forkPush(fork("WI-X"), fakeSha("f", 0x202), [{ subject: "notifications.default", value: "on", basedOn: "notifications@1" }]),
			],
			when: n.events.v2,
		},
		// ---------- R3 ----------
		{
			id: "r3-01-right-value-superseded-basis",
			description: "A claim with the value v2 holds, but based on notifications@1 where that facet differed, is still a conflict (SUPERSEDED_BASIS).",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x301), n.claims.wi2RightValueOldBasis),
		},
		{
			id: "r3-02-wrong-record-wrong-value",
			description: "A claim on notifications.default citing status-model@1 is checked against notifications, which governs it, and conflicts.",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x302), [{ subject: "notifications.default", value: "opt-in", basedOn: "status-model@1" }]),
		},
		{
			id: "r3-03-wrong-record-right-value",
			description: "The same claim with the governing record's value is Uncertain (WRONG_RECORD), never a pass.",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x303), [{ subject: "notifications.default", value: "on", basedOn: "status-model@1" }]),
		},
		{
			id: "r3-04-missing-claims-fail-closed",
			description: "A push with no claims file is unknown, so the item is Uncertain (NO_CLAIMS).",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi1, fakeSha("f", 0x304), null),
		},
		{
			id: "r3-05-malformed-claims-fail-closed",
			description: "A claims file with an unknown key is malformed, so the item is Uncertain (MALFORMED_CLAIMS).",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi1, fakeSha("f", 0x305), [{ subject: "status.values", value: "draft", basedOn: "status-model@1", confidence: 0.9 }]),
		},
		{
			id: "r3-06-unknown-cited-version",
			description: "A claim citing notifications@9, which the cell has never seen, is Uncertain (UNKNOWN_CONTEXT_VERSION).",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x306), [{ subject: "notifications.default", value: "on", basedOn: "notifications@9" }]),
		},
		{
			id: "r3-07-claims-match-accepted-facets",
			description: "Claims that match the accepted facets, citing records in the receipt, raise nothing and propose no dependency.",
			rules: ["R3", "R4"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase],
			when: n.events.wi2PushedV1,
		},
		{
			id: "r3-08-superseded-basis-unchanged-facet",
			description: "A claim based on notifications@1 for a facet that v2 did not change is not a conflict.",
			rules: ["R3"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x308), n.claims.wi2UnchangedFacetOldBasis),
		},
		{
			id: "r3-09-ungoverned-subject",
			description: "A claim on a subject no accepted record governs is not contradicted.",
			rules: ["R3"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x309), [{ subject: "notifications.unrelated", value: "whatever", basedOn: "notifications@1" }]),
		},
		{
			id: "r3-10-claim-equals-rejected-value",
			description: "A claim for notifications.default = on, which notifications@2 declares in its `not` list, is still a conflict and also carries REJECTED_ALTERNATIVE. The reason is additive: the gate still blocks exactly as it would without it.",
			rules: ["R3"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x30a), [{ subject: "notifications.default", value: "on", basedOn: "notifications@2" }]),
		},
		{
			id: "r3-11-wrong-value-not-declared-rejected",
			description: "A claim for notifications.default = off conflicts with notifications@2, but off is not in its `not` list, so there is no REJECTED_ALTERNATIVE. Only declared values match.",
			rules: ["R3"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x30b), [{ subject: "notifications.default", value: "off", basedOn: "notifications@2" }]),
		},
		// ---------- R3b ----------
		{
			id: "r3b-01-cross-claim-conflict",
			description: "WI-2 claims profile.phone is required; WI-1 then claims it is optional. No record governs it, so both are Uncertain (CROSS_CLAIM_CONFLICT) with a review request.",
			rules: ["R3b"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi2, fakeSha("f", 0x311), n.claims.wi2PhoneRequired)],
			when: forkPush(n.workItems.wi1, fakeSha("f", 0x312), n.claims.wi1PhoneOptional),
		},
		{
			id: "r3b-02-items-that-agree",
			description: "Two items that claim the same value for a shared subject are not in conflict.",
			rules: ["R3b"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.wi2PushedV1],
			when: n.events.wi1Pushed,
		},
		{
			id: "r3b-03-governed-subject-is-r3",
			description: "Sales ops (synthetic): WI-3 (v1 criteria) and WI-4 (v2 criteria) disagree on a governed subject. R3 arbitrates against the record; it is not a cross-claim conflict.",
			rules: ["R3b", "R3"],
			polarity: "negative",
			fixture: S,
			setup: [...sBase, s.events.v2, s.events.wi3Pushed],
			when: s.events.wi4PushedRevalidated,
		},
		{
			id: "r3b-04-rejecting-one-side-clears-the-other",
			description: "Rejecting WI-2 takes it out of cross-claim comparison, so WI-1's CROSS_CLAIM_CONFLICT clears.",
			rules: ["R3b", "R7"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi2, fakeSha("f", 0x311), n.claims.wi2PhoneRequired), forkPush(n.workItems.wi1, fakeSha("f", 0x312), n.claims.wi1PhoneOptional)],
			when: resolve("reject", "WI-2", "notifications", owner, "reject-wi2"),
		},
		// ---------- R4 ----------
		{
			id: "r4-01-undeclared-reliance",
			description: "WI-1's claims cite notifications, which is not in its receipt. A proposed, inferred dependency is created and the item is Uncertain (UNDECLARED_DEP).",
			rules: ["R4"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi1, n.commits.wi1Head, n.claims.wi1Undeclared),
		},
		{
			id: "r4-02-human-accepts-inferred-dependency",
			description: "A human accepts the inferred dependency. The receipt never delivered notifications, so WI-1 is Stale (STALE_RECEIPT).",
			rules: ["R4", "R1"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi1, n.commits.wi1Head, n.claims.wi1Undeclared)],
			when: { type: "DependencyDecided", ts: T, requestId: "dep-accept", workItemId: "WI-1", recordId: "notifications", decision: "accepted", actor: owner },
		},
		{
			id: "r4-03-human-rejects-inferred-dependency",
			description: "A human rejects the inferred dependency; the uncertainty clears.",
			rules: ["R4"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi1, n.commits.wi1Head, n.claims.wi1Undeclared)],
			when: { type: "DependencyDecided", ts: T, requestId: "dep-reject", workItemId: "WI-1", recordId: "notifications", decision: "rejected", actor: owner },
		},
		{
			id: "r4-04-agent-cannot-decide-dependency",
			description: "An agent accepting its own inferred dependency is refused (FORBIDDEN_ACTOR); the dependency stays proposed.",
			rules: ["R4"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi1, n.commits.wi1Head, n.claims.wi1Undeclared)],
			when: { type: "DependencyDecided", ts: T, requestId: "dep-agent", workItemId: "WI-1", recordId: "notifications", decision: "accepted", actor: n.actors.agentA },
		},
		{
			id: "r4-05-repeated-push-extends-proposal",
			description: "A second push citing another notifications facet extends the one proposed dependency instead of adding a second.",
			rules: ["R4"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi1, n.commits.wi1Head, n.claims.wi1Undeclared)],
			when: forkPush(n.workItems.wi1, fakeSha("f", 0x405), [...n.claims.wi1Undeclared, { subject: "notifications.cadence", value: "immediate", basedOn: "notifications@1" }]),
		},
		{
			id: "r4-06-proposed-dependency-does-not-gate",
			description: "WI-1's claims cite notifications@1, but the inferred dependency is only proposed. notifications v2 does not stale WI-1: it stays Uncertain (UNDECLARED_DEP) and is otherwise unchanged.",
			rules: ["R4"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, forkPush(n.workItems.wi1, n.commits.wi1Head, n.claims.wi1Undeclared)],
			when: n.events.v2,
		},
		// ---------- R5 ----------
		{
			id: "r5-01-ready-work-is-allowed",
			description: "WI-1 is Fresh with its required check passing at the head. A human's promotion request is allowed.",
			rules: ["R5", "R7"],
			polarity: "negative",
			fixture: N,
			setup: [...wi1Ready],
			when: promote("WI-1", owner, "promote-wi1"),
		},
		{
			id: "r5-02-failing-check-blocks",
			description: "WI-2 is otherwise fresh, but a check fails at its head: promotion is blocked with TEST_FAILED.",
			rules: ["R5"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.wi2PushedV1, n.events.wi2FailsV2, n.events.wi2StatusPass],
			when: promote("WI-2", owner, "promote-wi2-failing"),
		},
		{
			id: "r5-03-missing-evidence-blocks",
			description: "WI-1 requires a contract test and has no evidence at its head: promotion is blocked with MISSING_EVIDENCE.",
			rules: ["R5"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.wi1Pushed],
			when: promote("WI-1", owner, "promote-wi1-no-evidence"),
		},
		{
			id: "r5-04-fork-edits-context",
			description: "A fork push that changes context/notifications.md is not an accepted version (FORK_CONTEXT_IGNORED) and blocks the item (FORK_EDITS_CONTEXT).",
			rules: ["R5"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: forkPush(n.workItems.wi2, fakeSha("f", 0x504), n.claims.wi2V1, { contextPaths: ["context/notifications.md"] }),
		},
		{
			id: "r5-05-human-resolution-required",
			description: "An item that requires human-resolution and has none is blocked with HUMAN_RESOLUTION_MISSING.",
			rules: ["R5"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, register("WI-H", n.actors.agentA, n.receipts.wi1, [{ recordId: "status-model", facetKeys: ["status.values"] }], ["human-resolution"]), forkPush(fork("WI-H"), fakeSha("f", 0x505), n.claims.wi1)],
			when: promote("WI-H", owner, "promote-wi-h"),
		},
		{
			id: "r5-06-policy-requires-contract-test",
			description: "The policy requires a contract test for every item. WI-P requires nothing itself, has no evidence, and is blocked with MISSING_EVIDENCE.",
			rules: ["R5"],
			polarity: "positive",
			fixture: N,
			policy: { ...n.policy, requires: ["contract-test"] },
			setup: [...nBase, register("WI-P", n.actors.agentA, n.receipts.wi1, [{ recordId: "status-model", facetKeys: ["status.values"] }]), forkPush(fork("WI-P"), fakeSha("f", 0x506), n.claims.wi1)],
			when: promote("WI-P", owner, "promote-wi-p"),
		},
		{
			id: "r5-09-stale-work-cannot-be-promoted",
			description: "WI-S needs no checks and its claims agree with the accepted records, but notifications v2 changed a facet it relied on. Promotion is blocked on staleness alone (STALE_RECEIPT, FACET_CHANGED).",
			rules: ["R5", "R1"],
			polarity: "positive",
			fixture: N,
			setup: [
				...nBase,
				register("WI-S", n.actors.agentA, n.receipts.wi2, [{ recordId: "notifications", facetKeys: ["notifications.default"] }]),
				forkPush(fork("WI-S"), fakeSha("f", 0x509), n.claims.wi1),
				n.events.v2,
			],
			when: promote("WI-S", owner, "promote-wi-s"),
		},
		{
			id: "r5-07-exception-permits-stale-work",
			description: "Sales ops (synthetic): WI-3 is stale and conflicting on qualified-lead, and the authority granted a bound, scoped exception. Promotion is allowed, marked EXCEPTION_APPLIED.",
			rules: ["R5", "R7"],
			polarity: "negative",
			fixture: S,
			setup: [...wi3Excepted],
			when: promote("WI-3", owner, "promote-wi3"),
		},
		{
			id: "r5-08-exception-cannot-waive-unknown",
			description: "An exception on a stale item with no claims file does not waive the unknown: promotion is blocked with NO_CLAIMS.",
			rules: ["R5"],
			polarity: "positive",
			fixture: S,
			setup: [...sBase, s.events.v2, forkPush(s.workItems.wi3, fakeSha("f", 0x508), null), salesException("exc-noclaims")],
			when: promote("WI-3", owner, "promote-wi3-noclaims"),
		},
		// ---------- R6 ----------
		{
			id: "r6-01-receipt-mismatch",
			description: "During a revalidation, a receipt that is not at the current accepted versions is refused (RECEIPT_MISMATCH); WI-2 stays Stale.",
			rules: ["R6"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2],
			when: { type: "ReceiptIssued", ts: T2, workItemId: "WI-2", receipt: n.receipts.wi2 },
		},
		{
			id: "r6-02-receipt-without-revalidation",
			description: "A new receipt with no revalidation under way is refused (REVALIDATION_NOT_REQUESTED).",
			rules: ["R6"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: n.events.wi2ReceiptIssued,
		},
		{
			id: "r6-03-revalidation-limit",
			description: "With maxRevalidations 1, a second revalidate after the agent got it wrong again is answered with REQUEST_REVIEW and BLOCK_PROMOTION (REVALIDATION_LIMIT), not another run.",
			rules: ["R6"],
			polarity: "positive",
			fixture: N,
			policy: { ...n.policy, maxRevalidations: 1 },
			setup: [...wi2Conflicted, revalidateWi2, n.events.wi2ReceiptIssued, forkPush(n.workItems.wi2, fakeSha("f", 0x603), n.claims.wi2V1)],
			when: resolve("revalidate", "WI-2", "notifications", owner, "rv-wi2-again"),
		},
		{
			id: "r6-04-nothing-to-revalidate",
			description: "Revalidating WI-1, which is fresh, is refused (NOTHING_TO_REVALIDATE); no run is dispatched.",
			rules: ["R6"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.wi1Pushed],
			when: resolve("revalidate", "WI-1", "status-model", owner, "rv-wi1"),
		},
		{
			id: "r6-05-one-revalidation-at-a-time",
			description: "A second revalidate while the first is under way is refused (REVALIDATION_IN_PROGRESS).",
			rules: ["R6"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2],
			when: resolve("revalidate", "WI-2", "notifications", owner, "rv-wi2-twice"),
		},
		{
			id: "r6-06-failed-run-ends-revalidation",
			description: "The agent run tied to the revalidation fails, so no push is coming: the revalidation ends and the item can be revalidated again.",
			rules: ["R6"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2, { type: "AgentRunStarted", ts: T, workItemId: "WI-2", runId: "run-rv-1" }],
			when: { type: "AgentRunFinished", ts: T2, workItemId: "WI-2", runId: "run-rv-1", outcome: "failure" },
		},
		{
			id: "r6-07-successful-run-waits-for-push",
			description: "A successful finish of the tied run does not end the revalidation; the agent's push does.",
			rules: ["R6"],
			polarity: "negative",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2, { type: "AgentRunStarted", ts: T, workItemId: "WI-2", runId: "run-rv-1" }],
			when: { type: "AgentRunFinished", ts: T2, workItemId: "WI-2", runId: "run-rv-1", outcome: "success" },
		},
		// ---------- R7 ----------
		{
			id: "r7-01-binding-to-moved-context",
			description: "A revalidate prepared against notifications@2 arrives after v3 landed. The binding no longer matches the current state: STALE_BINDING, nothing recorded.",
			rules: ["R7"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, n.events.v3ProseBump],
			when: revalidateWi2,
		},
		{
			id: "r7-02-agent-cannot-resolve",
			description: "An agent's resolution is refused (FORBIDDEN_ACTOR).",
			rules: ["R7"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted],
			when: resolve("revalidate", "WI-2", "notifications", n.actors.agentB, "rv-by-agent"),
		},
		{
			id: "r7-03-exception-needs-the-authority",
			description: "Sales ops (synthetic): an exception from a human who is not qualified-lead's authority is refused (FORBIDDEN_ACTOR).",
			rules: ["R7"],
			polarity: "positive",
			fixture: S,
			setup: [...sBase, s.events.v2, s.events.wi3Pushed],
			when: resolve("accept-exception", "WI-3", "qualified-lead", casey, "exc-casey", { scope: "reports/q4-forecast.md" }),
		},
		{
			id: "r7-04-promotion-baseline-moved",
			description: "Promotion is a compare-and-swap: a request that expects an older baseline commit is refused (BASELINE_MOVED).",
			rules: ["R7"],
			polarity: "positive",
			fixture: N,
			setup: [...wi1Ready],
			when: promote("WI-1", owner, "promote-wi1-old-base", { expectedBaselineCommit: n.commits.baselineTypo }),
		},
		{
			id: "r7-05-promotion-head-moved",
			description: "A promotion request for a fork head that is not the current one is refused (HEAD_MOVED).",
			rules: ["R7"],
			polarity: "positive",
			fixture: N,
			setup: [...wi1Ready],
			when: promote("WI-1", owner, "promote-wi1-old-head", { forkHeadSha: fakeSha("f", 0x705) }),
		},
		{
			id: "r7-06-agent-cannot-promote",
			description: "An agent's promotion request is refused (FORBIDDEN_ACTOR) and no approval is recorded.",
			rules: ["R7"],
			polarity: "positive",
			fixture: N,
			setup: [...wi1Ready],
			when: promote("WI-1", n.actors.agentA, "promote-by-agent"),
		},
		{
			id: "r7-07-merge-without-approval",
			description: "A merge nobody approved is not recorded as a promotion (PROMOTION_NOT_APPROVED).",
			rules: ["R7"],
			polarity: "positive",
			fixture: N,
			setup: [...wi1Ready],
			when: merged("WI-1", n.repo, fakeSha("b", 0x707)),
		},
		{
			id: "r7-08-context-change-between-approve-and-merge",
			description: "WI-1 was approved, then status-model@2 changed a facet it relies on. The approval is gone, so the merge is not recorded as a promotion.",
			rules: ["R7", "R1"],
			polarity: "positive",
			fixture: N,
			setup: [...wi1Ready, promote("WI-1", owner, "promote-wi1"), baselinePush(n.repo, fakeSha("b", 0x708), [statusModelV2])],
			when: merged("WI-1", n.repo, fakeSha("b", 0x709)),
		},
		{
			id: "r7-09-exception-lapses-on-new-version",
			description: "Shelter intake (synthetic): the door signage (WI-2) holds a scoped exception on policy v2. Policy v3 is accepted, so the exception lapses (EXCEPTION_LAPSED) and WI-2 is blocked again.",
			rules: ["R7"],
			polarity: "positive",
			fixture: SH,
			setup: [
				...shBase,
				sh.events.v2,
				sh.events.wi2Pushed,
				resolve("accept-exception", "WI-2", "shelter-intake-policy", coordinator, "exc-signage", {
					scope: "signs/door.md",
					rationale: "Existing printed signs stay posted until replacements arrive.",
				}),
			],
			when: sh.events.v3,
		},
		{
			id: "r7-10-exception-survives-prose-edit",
			description: "Sales ops (synthetic): a reworded qualified-lead@2 (same version, same facets) is prose-only; WI-3's exception does not lapse.",
			rules: ["R7"],
			polarity: "negative",
			fixture: S,
			setup: [...wi3Excepted],
			when: baselinePush(s.repo, fakeSha("b", 0x710), [await variantOf(ql2, {})]),
		},
		// ---------- R8 ----------
		{
			id: "r8-01-evidence-at-head-counts",
			description: "Passing evidence for WI-1's current head counts: TestsPassed, and WI-1 is Ready.",
			rules: ["R8", "R5"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, n.events.wi1Pushed],
			when: n.events.wi1Evidence,
		},
		{
			id: "r8-02-evidence-for-another-head",
			description: "Evidence for a head that is not WI-1's current one does not count (STALE_EVIDENCE).",
			rules: ["R8"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.wi1Pushed],
			when: { type: "EvidenceRecorded", ts: T, repo: n.workItems.wi1.forkRepo, commitSha: fakeSha("f", 0x802), runId: "run-old-head", evidence: { ...n.evidence.wi1Pass, headSha: fakeSha("f", 0x802) } },
		},
		{
			id: "r8-03-new-push-invalidates-evidence",
			description: "WI-1 was Ready. A new push moves the head, so the earlier evidence no longer counts and TestsPassed and Ready go away.",
			rules: ["R8"],
			polarity: "positive",
			fixture: N,
			setup: [...wi1Ready],
			when: forkPush(n.workItems.wi1, fakeSha("f", 0x803), n.claims.wi1),
		},
		{
			id: "r8-04-evidence-from-another-repo",
			description: "Evidence reported from a repository that is not WI-1's fork is ignored (UNKNOWN_WORK_ITEM).",
			rules: ["R8"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.wi1Pushed],
			when: { type: "EvidenceRecorded", ts: T, repo: "not-this-fork", commitSha: n.commits.wi1Head, runId: "run-elsewhere", evidence: n.evidence.wi1Pass },
		},
		{
			id: "r8-05-claims-check-is-not-a-test",
			description: "A passing delta-claims-check under the name of WI-1's validation check does not satisfy it: still no TestsPassed.",
			rules: ["R8"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.wi1Pushed],
			when: { type: "EvidenceRecorded", ts: T, repo: n.workItems.wi1.forkRepo, commitSha: n.commits.wi1Head, runId: "run-claims-check", evidence: { ...n.evidence.wi1Pass, kind: "delta-claims-check" } },
		},
		// ---------- R9 ----------
		{
			id: "r9-01-replayed-push",
			description: "notifications v2 delivered again with a different timestamp is a duplicate: NO_ACTION with DUPLICATE_EVENT, state unchanged.",
			rules: ["R9"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase, n.events.v2],
			when: { ...n.events.v2, ts: "2031-01-01T00:00:00Z" },
		},
		{
			id: "r9-02-command-retried",
			description: "The same revalidate command, byte for byte, is a duplicate: applied once.",
			rules: ["R9"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2],
			when: revalidateWi2,
		},
		{
			id: "r9-03-key-reused-for-another-request",
			description: "The same Idempotency-Key with a different body (reject instead of revalidate) is IDEMPOTENCY_CONFLICT and changes nothing.",
			rules: ["R9"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2],
			when: { ...revalidateWi2, resolution: { ...(revalidateWi2 as Extract<DeltaEvent, { type: "ResolutionRecorded" }>).resolution, kind: "reject" } },
		},
		{
			id: "r9-04-command-with-another-timestamp",
			description: "A command is a duplicate only if identical including ts. The same key and body at another time is IDEMPOTENCY_CONFLICT.",
			rules: ["R9"],
			polarity: "positive",
			fixture: N,
			setup: [...wi2Conflicted, revalidateWi2],
			when: { ...revalidateWi2, ts: T2 },
		},
		{
			id: "r9-05-same-commit-other-repo",
			description: "The same commit id pushed to a different repository is a different event and is applied.",
			rules: ["R9"],
			polarity: "negative",
			fixture: N,
			setup: [...nBase, baselinePush(n.repo, fakeSha("e", 0x905), [])],
			when: baselinePush("another-baseline", fakeSha("e", 0x905), []),
		},
		{
			id: "r9-06-register-twice",
			description: "Registering WI-1 a second time is a duplicate.",
			rules: ["R9"],
			polarity: "positive",
			fixture: N,
			setup: [...nBase],
			when: n.events.registerWi1,
		},
	];

	return [...workedExample, ...rules];
}

// ---------- generation ----------

async function materialize(step: Step, state: CellStateType): Promise<DeltaEvent> {
	return DeltaEvent.parse(typeof step === "function" ? await step(state) : step);
}

async function build(def: Definition): Promise<Vector> {
	const policy = Policy.parse(def.policy ?? def.fixture.policy);
	let state = createCellState(def.fixture.seed);
	for (const step of def.setup) state = reconcile(state, await materialize(step, state), policy).state;
	const event = await materialize(def.when, state);
	const given = { state: CellState.parse(state), policy };
	const result = reconcile(state, event, policy);
	return {
		protocol: PROTOCOL,
		id: def.id,
		description: def.description,
		rules: def.rules,
		polarity: def.polarity,
		fixture: def.fixture.name,
		...(def.sequence ? { sequence: def.sequence } : {}),
		given,
		when: { event },
		then: project(result),
	};
}

/** Every vector, built from the reference engine. */
export async function buildVectors(): Promise<Vector[]> {
	const defs = await definitions();
	const ids = new Set<string>();
	for (const def of defs) {
		if (ids.has(def.id)) throw new Error(`duplicate vector id ${def.id}`);
		ids.add(def.id);
	}
	const vectors: Vector[] = [];
	for (const def of defs) vectors.push(await build(def));
	return vectors;
}

/** The vector files, by file name: canonical JSON (sorted keys), indented, with a trailing newline. */
export async function generateVectorFiles(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const vector of await buildVectors()) files[`${vector.id}.json`] = `${canonicalJsonPretty(vector)}\n`;
	return files;
}
