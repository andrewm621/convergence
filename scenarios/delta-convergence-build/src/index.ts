import {
	loadDoc,
	receiptOf,
	snapshotHashOf,
	type Actor,
	type Claim,
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
 * Six records, seven work items. Events are in the order the commits were made and carry the commits' own
 * timestamps. Exactly one event is invented: a wording-only edit to the product naming record (the negative
 * control), which has no commit and says so.
 */

export const REPO = "delta-convergence-build-baseline";

export const RETROFIT_NOTE =
	"Retrofitted from this repo's git history: these decisions were made before Delta Convergence was recording them; the replay reconstructs them. Dependencies are declared by us. No automated evidence: humans resolve.";

/** The all-zero sha reads as "none": this thing is not in git. It is never a real commit. */
export const NOT_IN_GIT = "0000000000000000000000000000000000000000";

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
 * Real commits from this repo. Short shas in the comments; the README has the PR numbers.
 *
 * Record changes: `baselineV1` (the commit the starting state is read from), `namingV2`, `evidenceV2`, `evidenceV3`.
 * `evidenceV1` is where the claims check first counted as a test; it is the seed's evidence rule, not a replayed event.
 * Work heads: where the work now lives on main (merge commits for PRs #6 and #7), or the commit it was built in.
 * `productNamingProse` and `wi5Head` are `NOT_IN_GIT`: the wording edit is invented, and the shared brief lives in Notion.
 */
export const commits = {
	/** 61867a9 (PR #3): where "Cedar County" first appears. */
	baselineV1: "61867a991e187da94a3c3b152ebc2e484f81da65",
	/** 7d7fa09 (PR #6): the claims check first counts as a test (evidence policy v1). */
	evidenceV1: "7d7fa09fcb5c7deb442302412e7747e3f132e916",
	/** 59d48e4 (PR #4): scenario naming v2 (Cedar County becomes Larkhaven County). */
	namingV2: "59d48e4659fde029f10cc0cf5d70d8640c6b74bc",
	/** 8350830 (PR #6): evidence policy v2. */
	evidenceV2: "835083048a2807f22e5ba40959b13f82a3b9345a",
	/** 2f3d2c8 (PR #6): evidence policy v3 (required facets come from the receipt). */
	evidenceV3: "2f3d2c86a205b7031b4c34ee4691657297d25840",
	/** Not in git. The one invented event in the replay. */
	productNamingProse: NOT_IN_GIT,
	/** ce882f2: the merge of PR #6, where the M4 revalidate loop now lives on main. */
	wi1Head: "ce882f2ecdd1b6f66f3d0804fa2eb169cc093dd4",
	/** 6689702: the merge of PR #7, where the console evidence labels now live on main. */
	wi2Head: "668970268c10adb56035a6a9721a3dd8e2eb4b81",
	/** f29ac84: the video script revised, with the shelter act. */
	wi3Head: "f29ac84485004d933a5c3d1db1b74b55e99352cf",
	/** 61867a9 (PR #3): the shelter fixtures. */
	wi4Head: "61867a991e187da94a3c3b152ebc2e484f81da65",
	/** Not in git: the shared brief lives in Notion. */
	wi5Head: NOT_IN_GIT,
	/** e0710e6: tip of the cloud/t9-readme branch (PR #1, unmerged) as of Oct 13. */
	wi6Head: "e0710e60d29e193f5724116e91d2388097544ba4",
	/** 3036894 (PR #4): the commit that introduced the console identity header. */
	wi7Head: "30368947b30fc5f4ee8f6d34a9e7721e9c2d9529",
} as const;

/**
 * Event times. Where a commit exists, the timestamp is that commit's author time in UTC. Three are not:
 * `setup` (the replay registering work items, not history), `notInGit` (the shared brief, no commit) and
 * `productNamingProse` (the invented wording edit).
 * PR #6 and PR #7 were pushed first as commits 7d7fa09 (Oct 12 23:47 ET) and a first version of PR #7
 * (Oct 12 23:54 ET, since rewritten when the branch was rebased, so its sha is not cited). Their heads in the
 * fixture are the merge commits, which is where the work lives now; the claims are what the first versions assumed.
 */
export const ts = {
	setup: "2026-10-13T02:00:00Z",
	notInGit: "2026-10-13T02:00:01Z",
	wi6Pushed: "2026-10-13T02:16:42Z",
	wi4Pushed: "2026-10-13T02:57:39Z",
	wi3Pushed: "2026-10-13T02:58:20Z",
	namingV2: "2026-10-13T03:11:59Z",
	wi7Pushed: "2026-10-13T03:27:43Z",
	wi1Pushed: "2026-10-13T03:47:01Z",
	wi2Pushed: "2026-10-13T03:54:55Z",
	evidenceV2: "2026-10-13T04:04:23Z",
	evidenceV3: "2026-10-13T04:18:34Z",
	productNamingProse: "2026-10-13T04:30:00Z",
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
	wi5: workItem("WI-5", "Shared brief (Notion; not in git)", actors.docsAgent),
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

const claim = (subject: string, value: string, basedOn: string): Claim => ({ subject, value, basedOn });

/**
 * What each piece of work was built against, as the values the records held then. Self-reported by the work, so
 * the console labels them "agent-asserted". WI-3 makes no claim about the evidence rule: the script was written
 * before it existed, and we declare that dependency afterwards.
 */
export const claims = {
	wi1: [
		claim(k.countsAsTest, "claims-check", "evidence-policy@1"),
		claim(k.claimsCheckRole, "test", "evidence-policy@1"),
		claim(k.requiredFacets, "none", "evidence-policy@1"),
	],
	wi2: [claim(k.countsAsTest, "claims-check", "evidence-policy@1"), claim(k.claimsCheckRole, "test", "evidence-policy@1"), claim(k.publicName, "Delta Convergence", "product-naming@1")],
	wi3: [claim(k.county, "Cedar County", "scenario-naming@1"), claim(k.secondActMode, "replay", "scenario-plan@1")],
	wi4: [claim(k.county, "Cedar County", "scenario-naming@1")],
	wi5: [claim(k.county, "Cedar County", "scenario-naming@1"), claim(k.secondActMode, "replay", "scenario-plan@1")],
	wi6: [
		claim(k.llmClaim, "control loop makes no model calls", "positioning@1"),
		claim(k.tagline, "a control plane that keeps concurrent humans and agents working from the same meaning", "positioning@1"),
		claim(k.secondActMode, "replay", "scenario-plan@1"),
	],
	wi7: [claim(k.identityLabel, "Decision owner (demo identity)", "demo-identity@1")],
} satisfies Record<string, Claim[]>;

export type DogfoodBuildScenario = Awaited<ReturnType<typeof buildDogfoodBuildScenario>>;

type ItemId = "WI-1" | "WI-2" | "WI-3" | "WI-4" | "WI-5" | "WI-6" | "WI-7";

/** One step of the replay, in commit order. */
export type TimelineStep = { key: string; label: string; ts: string; event: DeltaEvent };

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
	const { evidenceV1, evidenceV2, evidenceV3, namingV1, namingV2, planV1, productNamingV1, productNamingV2, positioningV1, demoIdentityV1 } = docs;
	const atSeed = heads([evidenceV1, namingV1, planV1, productNamingV1, positioningV1, demoIdentityV1]);

	const seed = { baselineCommit: commits.baselineV1, snapshotHash: await snapshotHashOf(atSeed), records: atSeed };
	/** The accepted heads after each change, in replay order. */
	const snapshotHashes = {
		v1: seed.snapshotHash,
		namingV2: await snapshotHashOf(heads([evidenceV1, namingV2, planV1, productNamingV1, positioningV1, demoIdentityV1])),
		evidenceV2: await snapshotHashOf(heads([evidenceV2, namingV2, planV1, productNamingV1, positioningV1, demoIdentityV1])),
		evidenceV3: await snapshotHashOf(heads([evidenceV3, namingV2, planV1, productNamingV1, positioningV1, demoIdentityV1])),
		productNamingProse: await snapshotHashOf(heads([evidenceV3, namingV2, planV1, productNamingV2, positioningV1, demoIdentityV1])),
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
	const itemClaims: Record<ItemId, Claim[]> = { "WI-1": claims.wi1, "WI-2": claims.wi2, "WI-3": claims.wi3, "WI-4": claims.wi4, "WI-5": claims.wi5, "WI-6": claims.wi6, "WI-7": claims.wi7 };
	const pushedAt: Record<ItemId, string> = {
		"WI-1": ts.wi1Pushed,
		"WI-2": ts.wi2Pushed,
		"WI-3": ts.wi3Pushed,
		"WI-4": ts.wi4Pushed,
		"WI-5": ts.notInGit,
		"WI-6": ts.wi6Pushed,
		"WI-7": ts.wi7Pushed,
	};
	const items: WorkItem[] = [workItems.wi1, workItems.wi2, workItems.wi3, workItems.wi4, workItems.wi5, workItems.wi6, workItems.wi7];
	const itemIds = items.map((item) => item.id as ItemId);

	/** A receipt delivering the accepted version of just the records this item declared a dependency on. */
	const receipts = {} as Record<ItemId, ContextReceipt>;
	for (const id of itemIds) {
		const wanted = new Set(itemDeps[id].map((d) => d.recordId));
		receipts[id] = await receiptOf(commits.baselineV1, atSeed.filter((r) => wanted.has(r.recordId)), id === "WI-5" ? {} : { noteCommit: forkHeads[id] });
	}

	const register: Record<string, DeltaEvent> = {};
	const push: Record<string, DeltaEvent> = {};
	for (const item of items) {
		const id = item.id as ItemId;
		register[id] = { type: "WorkItemRegistered", ts: ts.setup, item, receipt: receipts[id], dependencies: itemDeps[id] };
		push[id] = { type: "ForkPushed", ts: pushedAt[id], repo: item.forkRepo, commitSha: forkHeads[id], workItemId: item.id, claims: itemClaims[id], contextPaths: [] };
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
		/** Cedar County becomes Larkhaven County (59d48e4). */
		namingV2: baseline(commits.namingV2, ts.namingV2, snapshotHashes.namingV2, [namingV2]),
		/** The claims check becomes informational; only a check Delta Convergence runs counts (8350830). */
		evidenceV2: baseline(commits.evidenceV2, ts.evidenceV2, snapshotHashes.evidenceV2, [evidenceV2]),
		/** The run check takes its facets from the receipt (2f3d2c8). */
		evidenceV3: baseline(commits.evidenceV3, ts.evidenceV3, snapshotHashes.evidenceV3, [evidenceV3]),
		/** Invented: wording only, no facet moves, no commit. The negative control. */
		productNamingProse: baseline(commits.productNamingProse, ts.productNamingProse, snapshotHashes.productNamingProse, [productNamingV2]),
	};

	/** The replay in commit order: the work items register (setup), then every push and record change as the commits landed. */
	const timeline: TimelineStep[] = [
		...items.map((item) => ({ key: `register-${item.id}`, label: `${item.id} registered (replay setup, not history)`, ts: ts.setup, event: register[item.id]! })),
		{ key: "push-WI-5", label: "WI-5 pushed (not in git)", ts: ts.notInGit, event: push["WI-5"]! },
		{ key: "push-WI-6", label: "WI-6 pushed (e0710e6)", ts: ts.wi6Pushed, event: push["WI-6"]! },
		{ key: "push-WI-4", label: "WI-4 pushed (61867a9)", ts: ts.wi4Pushed, event: push["WI-4"]! },
		{ key: "push-WI-3", label: "WI-3 pushed (f29ac84)", ts: ts.wi3Pushed, event: push["WI-3"]! },
		{ key: "namingV2", label: "Scenario naming v2 (59d48e4)", ts: ts.namingV2, event: events.namingV2 },
		{ key: "push-WI-7", label: "WI-7 pushed (3036894)", ts: ts.wi7Pushed, event: push["WI-7"]! },
		{ key: "push-WI-1", label: "WI-1 pushed (first version of PR #6)", ts: ts.wi1Pushed, event: push["WI-1"]! },
		{ key: "push-WI-2", label: "WI-2 pushed (first version of PR #7)", ts: ts.wi2Pushed, event: push["WI-2"]! },
		{ key: "evidenceV2", label: "Evidence policy v2 (8350830)", ts: ts.evidenceV2, event: events.evidenceV2 },
		{ key: "evidenceV3", label: "Evidence policy v3 (2f3d2c8)", ts: ts.evidenceV3, event: events.evidenceV3 },
		{ key: "productNamingProse", label: "Product naming wording edit (invented, not in git)", ts: ts.productNamingProse, event: events.productNamingProse },
	];

	const expected = {
		afterNamingV2: {
			stale: { "WI-3": [k.county], "WI-4": [k.county], "WI-5": [k.county] },
			untouched: ["WI-1", "WI-2", "WI-6", "WI-7"],
		},
		afterEvidenceV2: {
			stale: { "WI-1": [k.claimsCheckRole, k.countsAsTest], "WI-2": [k.claimsCheckRole, k.countsAsTest], "WI-3": [k.countsAsTest, k.county] },
			untouched: ["WI-4", "WI-5", "WI-6", "WI-7"],
		},
		/** WI-2 and WI-3 are looked at again but stay stale on the same facets; only WI-1 gains `evidence.required-facets`. */
		afterEvidenceV3: {
			stale: {
				"WI-1": [k.claimsCheckRole, k.countsAsTest, k.requiredFacets],
				"WI-2": [k.claimsCheckRole, k.countsAsTest],
				"WI-3": [k.countsAsTest, k.county],
			},
			untouched: ["WI-4", "WI-5", "WI-6", "WI-7"],
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
		claims,
		receipts,
		snapshotHashes,
		events,
		timeline,
		expected,
		repo: REPO,
	};
}
