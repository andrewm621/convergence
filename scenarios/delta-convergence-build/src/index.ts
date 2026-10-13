import {
	fakeSha,
	loadDoc,
	receiptOf,
	snapshotHashOf,
	type Actor,
	type ContextReceipt,
	type DeltaEvent,
	type Dependency,
	type Policy,
	type RecordSnapshot,
	type ScenarioDoc,
	type WorkItem,
} from "contracts";
import * as records from "./records";

export * from "./records";

/**
 * Delta Convergence governs its own build: a replay of real stale events from this repo's git history.
 *
 * Retrofitted from this repo's git history: these decisions were made before Delta Convergence was recording
 * them; the replay reconstructs them. Dependencies are declared by us. No automated evidence: humans resolve.
 *
 * Six records, seven work items. Four changes land: the evidence policy twice, the scenario naming once, and one
 * prose-only edit (the negative control). Work item 7 (the console identity header) never depends on anything that
 * moves, so it stays untouched throughout.
 */

export const REPO = "delta-convergence-build-baseline";

export const RETROFIT_NOTE =
	"Retrofitted from this repo's git history: these decisions were made before Delta Convergence was recording them; the replay reconstructs them. Dependencies are declared by us. No automated evidence: humans resolve.";

export const actors = {
	decisionOwner: { kind: "human", id: "decision-owner", displayName: "Decision owner (demo identity)" },
	buildAgent: { kind: "agent", id: "agent-build", displayName: "Build agent" },
	consoleAgent: { kind: "agent", id: "agent-console", displayName: "Console agent" },
	docsAgent: { kind: "agent", id: "agent-docs", displayName: "Docs agent" },
} satisfies Record<string, Actor>;

const RECORD_IDS = ["evidence-policy", "scenario-naming", "scenario-plan", "product-naming", "positioning", "demo-identity"] as const;

export const policy: Policy = {
	version: 1,
	authority: Object.fromEntries(RECORD_IDS.map((id) => [id, "decision-owner"])),
	staleness: "facet",
	requires: [],
	maxRevalidations: 2,
};

/**
 * Real commits from this repo where one exists. `baselineV1` and the `*V2`/`*V3` entries are the commits where a
 * record changed; `wi*Head` are the heads of the branches that held each piece of work. The README has the PR numbers.
 */
export const commits = {
	/** 61867a9 (PR #3): where "Cedar County" first appears. The earliest commit in the story. */
	baselineV1: "61867a991e187da94a3c3b152ebc2e484f81da65",
	/** 2cf1f2e (PR #6): the commit that first made the claims check count as a test (evidence policy v1). */
	evidenceV1: "2cf1f2e3cdf697371fdfe43b3b6e9aa779da3e26",
	/** 163cb45 (PR #6): evidence policy v2. */
	evidenceV2: "163cb4559c5b21872287f89a1e58796e8ac5818c",
	/** 59d48e4 (PR #4): scenario naming v2 (Cedar County becomes Larkhaven County). */
	namingV2: "59d48e4659fde029f10cc0cf5d70d8640c6b74bc",
	/** Illustrative: the product-naming wording edit has no commit in the repo. */
	productNamingProse: fakeSha("b", 301),
	/** cd31c39 (PR #6): evidence policy v3 (required facets come from the receipt). */
	evidenceV3: "cd31c3910fa83f12bb9238bf5fbde0aceb78a73d",
	wi1Head: "2cf1f2e3cdf697371fdfe43b3b6e9aa779da3e26",
	/** Tip of the console/m4-followups branch (PR #7) when this fixture was written. */
	wi2Head: "f57fb9229977675dc1bd69ed84f92153a60cc045",
	/** faf83a8: the video script revised, and the full product name adopted. */
	wi3Head: "faf83a88754f5e0bf26b458620190e1518532012",
	wi4Head: "61867a991e187da94a3c3b152ebc2e484f81da65",
	/** Placeholder: the shared brief lives in Notion, not in git. */
	wi5Head: fakeSha("f", 305),
	/** Tip of the cloud/t9-readme branch (PR #1) when this fixture was written. */
	wi6Head: "f30e0ca4f98ffcf2826c983aa0b094c07a23eda4",
	/** 2181838 (PR #4): the console merge that introduced the identity header. */
	wi7Head: "21818387ebf79ac6aefafd68a8d0e09123989d49",
} as const;

/** Replay time, in the order the story is told. The real commit dates are in the README table. */
export const ts = {
	seed: "2026-10-13T15:00:00Z",
	push: "2026-10-13T15:15:00Z",
	evidenceV2: "2026-10-13T15:30:00Z",
	namingV2: "2026-10-13T16:00:00Z",
	productNamingProse: "2026-10-13T16:30:00Z",
	resolved: "2026-10-13T17:00:00Z",
	evidenceV3: "2026-10-13T18:00:00Z",
} as const;

const workItem = (id: string, title: string, actor: Actor): WorkItem => ({
	id,
	title,
	actor,
	forkRepo: `delta-convergence-build-${id.toLowerCase()}`,
	source: "live",
	intent: "delivery",
	requires: ["human-resolution"],
	status: "running",
});

export const workItems = {
	wi1: workItem("WI-1", "M4 revalidate loop (PR #6)", actors.buildAgent),
	wi2: workItem("WI-2", "Console evidence labels (PR #7)", actors.consoleAgent),
	wi3: workItem("WI-3", "Video script", actors.docsAgent),
	wi4: workItem("WI-4", "Shelter fixtures (PRs #3 and #4)", actors.buildAgent),
	wi5: workItem("WI-5", "Shared brief (Notion)", actors.docsAgent),
	wi6: workItem("WI-6", "README", actors.docsAgent),
	wi7: workItem("WI-7", "Console identity header", actors.consoleAgent),
} satisfies Record<string, WorkItem>;

const declared = (workItemId: string, recordId: string, facetKeys: string[]): Dependency => ({
	workItemId,
	recordId,
	facetKeys,
	basis: "declared",
	status: "accepted",
	evidenceRefs: [],
});

export const facetKeys = {
	countsAsTest: "evidence.counts-as-test",
	claimsCheckRole: "evidence.claims-check-role",
	requiredFacets: "evidence.required-facets",
	county: "scenario.county",
	network: "scenario.network",
	secondActMode: "scenario.second-act-mode",
	publicName: "naming.public-name",
	llmClaim: "positioning.llm-claim",
	tagline: "positioning.tagline",
	identityLabel: "identity.label",
} as const;

const k = facetKeys;

export const dependencies = {
	wi1: [declared("WI-1", "evidence-policy", [k.claimsCheckRole, k.countsAsTest, k.requiredFacets])],
	wi2: [declared("WI-2", "evidence-policy", [k.claimsCheckRole, k.countsAsTest]), declared("WI-2", "product-naming", [k.publicName])],
	wi3: [declared("WI-3", "evidence-policy", [k.countsAsTest]), declared("WI-3", "scenario-naming", [k.county]), declared("WI-3", "scenario-plan", [k.secondActMode])],
	wi4: [declared("WI-4", "scenario-naming", [k.county])],
	wi5: [declared("WI-5", "scenario-naming", [k.county]), declared("WI-5", "scenario-plan", [k.secondActMode])],
	wi6: [declared("WI-6", "positioning", [k.llmClaim, k.tagline]), declared("WI-6", "scenario-plan", [k.secondActMode])],
	wi7: [declared("WI-7", "demo-identity", [k.identityLabel])],
} satisfies Record<string, Dependency[]>;

export type DogfoodBuildScenario = Awaited<ReturnType<typeof buildDogfoodBuildScenario>>;

type ItemId = "WI-1" | "WI-2" | "WI-3" | "WI-4" | "WI-5" | "WI-6" | "WI-7";

export async function buildDogfoodBuildScenario() {
	const docs = {
		evidenceV1: await loadDoc(records.EVIDENCE_POLICY_PATH, records.EVIDENCE_POLICY_V1),
		evidenceV2: await loadDoc(records.EVIDENCE_POLICY_PATH, records.EVIDENCE_POLICY_V2),
		evidenceV3: await loadDoc(records.EVIDENCE_POLICY_PATH, records.EVIDENCE_POLICY_V3),
		namingV1: await loadDoc(records.SCENARIO_NAMING_PATH, records.SCENARIO_NAMING_V1),
		namingV2: await loadDoc(records.SCENARIO_NAMING_PATH, records.SCENARIO_NAMING_V2),
		planV1: await loadDoc(records.SCENARIO_PLAN_PATH, records.SCENARIO_PLAN_V1),
		productNamingV1: await loadDoc(records.PRODUCT_NAMING_PATH, records.PRODUCT_NAMING_V1),
		productNamingV2: await loadDoc(records.PRODUCT_NAMING_PATH, records.PRODUCT_NAMING_V2),
		positioningV1: await loadDoc(records.POSITIONING_PATH, records.POSITIONING_V1),
		demoIdentityV1: await loadDoc(records.DEMO_IDENTITY_PATH, records.DEMO_IDENTITY_V1),
	} satisfies Record<string, ScenarioDoc>;

	const heads = (picked: ScenarioDoc[]): RecordSnapshot[] => picked.map((d) => d.snapshot);
	const atSeed = heads([docs.evidenceV1, docs.namingV1, docs.planV1, docs.productNamingV1, docs.positioningV1, docs.demoIdentityV1]);
	/** What is accepted once the evidence, naming and prose changes have landed (before evidence v3). */
	const afterProseEdit = heads([docs.evidenceV2, docs.namingV2, docs.planV1, docs.productNamingV2, docs.positioningV1, docs.demoIdentityV1]);

	const seed = { baselineCommit: commits.baselineV1, snapshotHash: await snapshotHashOf(atSeed), records: atSeed };
	const snapshotHashes = {
		v1: seed.snapshotHash,
		evidenceV2: await snapshotHashOf(heads([docs.evidenceV2, docs.namingV1, docs.planV1, docs.productNamingV1, docs.positioningV1, docs.demoIdentityV1])),
		namingV2: await snapshotHashOf(heads([docs.evidenceV2, docs.namingV2, docs.planV1, docs.productNamingV1, docs.positioningV1, docs.demoIdentityV1])),
		productNamingProse: await snapshotHashOf(afterProseEdit),
		evidenceV3: await snapshotHashOf(heads([docs.evidenceV3, docs.namingV2, docs.planV1, docs.productNamingV2, docs.positioningV1, docs.demoIdentityV1])),
	};

	const forkHeads: Record<ItemId, string> = {
		"WI-1": commits.wi1Head,
		"WI-2": commits.wi2Head,
		"WI-3": commits.wi3Head,
		"WI-4": commits.wi4Head,
		"WI-5": commits.wi5Head,
		"WI-6": commits.wi6Head,
		"WI-7": commits.wi7Head,
	};
	const itemDeps: Record<ItemId, Dependency[]> = {
		"WI-1": dependencies.wi1,
		"WI-2": dependencies.wi2,
		"WI-3": dependencies.wi3,
		"WI-4": dependencies.wi4,
		"WI-5": dependencies.wi5,
		"WI-6": dependencies.wi6,
		"WI-7": dependencies.wi7,
	};
	const items: WorkItem[] = [workItems.wi1, workItems.wi2, workItems.wi3, workItems.wi4, workItems.wi5, workItems.wi6, workItems.wi7];
	const itemIds = items.map((item) => item.id as ItemId);

	/** A receipt delivering the accepted version of just the records this item declared a dependency on. */
	const receiptFor = (id: ItemId, accepted: RecordSnapshot[], baselineCommit: string): Promise<ContextReceipt> => {
		const wanted = new Set(itemDeps[id].map((d) => d.recordId));
		return receiptOf(baselineCommit, accepted.filter((r) => wanted.has(r.recordId)), { noteCommit: forkHeads[id] });
	};
	const receipts = {} as Record<ItemId, ContextReceipt>;
	const reissuedReceipts = {} as Record<ItemId, ContextReceipt>;
	for (const id of itemIds) {
		receipts[id] = await receiptFor(id, atSeed, commits.baselineV1);
		reissuedReceipts[id] = await receiptFor(id, afterProseEdit, commits.productNamingProse);
	}

	const register: Record<string, DeltaEvent> = {};
	const push: Record<string, DeltaEvent> = {};
	const reissue: Record<string, DeltaEvent> = {};
	for (const item of items) {
		const id = item.id as ItemId;
		register[id] = { type: "WorkItemRegistered", ts: ts.seed, item, receipt: receipts[id], dependencies: itemDeps[id] };
		/** Each branch has a head. No claims and no evidence are recorded: humans resolve. */
		push[id] = { type: "ForkPushed", ts: ts.push, repo: item.forkRepo, commitSha: forkHeads[id], workItemId: item.id, claims: [], contextPaths: [] };
		/** After a human revalidates a stale item, it gets a fresh receipt at what is accepted now. */
		reissue[id] = { type: "ReceiptIssued", ts: ts.resolved, workItemId: item.id, receipt: reissuedReceipts[id] };
	}

	const baseline = (commitSha: string, at: string, snapshotHash: string, changed: ScenarioDoc[]): DeltaEvent => ({
		type: "BaselinePushed",
		ts: at,
		repo: REPO,
		commitSha,
		snapshotHash,
		records: heads(changed),
		invalid: [],
	});

	const events = {
		register,
		push,
		reissue,
		/** Step 1: what counts as a contract test changes (the claims check becomes informational). */
		evidenceV2: baseline(commits.evidenceV2, ts.evidenceV2, snapshotHashes.evidenceV2, [docs.evidenceV2]),
		/** Step 2: Cedar County becomes Larkhaven County. */
		namingV2: baseline(commits.namingV2, ts.namingV2, snapshotHashes.namingV2, [docs.namingV2]),
		/** Step 3: the negative control. Wording only, no facet moves. */
		productNamingProse: baseline(commits.productNamingProse, ts.productNamingProse, snapshotHashes.productNamingProse, [docs.productNamingV2]),
		/** Step 4: the run check now takes its facets from the receipt. */
		evidenceV3: baseline(commits.evidenceV3, ts.evidenceV3, snapshotHashes.evidenceV3, [docs.evidenceV3]),
	};

	const expected = {
		afterEvidenceV2: {
			stale: { "WI-1": [k.claimsCheckRole, k.countsAsTest], "WI-2": [k.claimsCheckRole, k.countsAsTest], "WI-3": [k.countsAsTest] },
			untouched: ["WI-4", "WI-5", "WI-6", "WI-7"],
		},
		afterNamingV2: {
			stale: { "WI-3": [k.county], "WI-4": [k.county], "WI-5": [k.county] },
			untouched: ["WI-6", "WI-7"],
		},
		afterEvidenceV3: {
			stale: { "WI-1": [k.requiredFacets] },
			untouched: ["WI-2", "WI-3", "WI-4", "WI-5", "WI-6", "WI-7"],
		},
		/** The negative control: depends only on the demo identity label, which never moves. */
		controlId: "WI-7",
	};

	return {
		name: "delta-convergence-build" as const,
		docs,
		seed,
		policy,
		actors,
		commits,
		forkHeads,
		workItems,
		dependencies,
		receipts,
		reissuedReceipts,
		snapshotHashes,
		events,
		expected,
		repo: REPO,
	};
}
