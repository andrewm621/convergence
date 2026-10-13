import { buildNotificationsScenario } from "scenario-notifications";
import { buildSalesOpsScenario } from "scenario-sales-ops";
import { InMemoryStore, type CellStore } from "../store";
import { SerializingStore } from "./serializing-store";
import type { InvariantScenario } from "./invariants";

export const notifications = await buildNotificationsScenario();
export const salesOps = await buildSalesOpsScenario();

export const stores: Array<[string, () => CellStore]> = [
	["in-memory store", () => new InMemoryStore()],
	["serialized store (Durable Object stand-in)", () => new SerializingStore()],
];

export const invariantScenarios: InvariantScenario[] = [
	{
		label: "notifications (coding)",
		seed: notifications.seed,
		policy: notifications.policy,
		human: notifications.actors.decisionOwner,
		agent: notifications.actors.agentB,
		recordId: "notifications",
		setup: [notifications.events.registerWi1, notifications.events.registerWi2],
		affectedId: "WI-2",
		controlId: "WI-1",
		controlPrep: [notifications.events.wi1Pushed, notifications.events.wi1Evidence],
		affectedPrep: [notifications.events.wi2PushedV1],
		contextChange: notifications.events.v2,
		proseOnly: notifications.events.typoFix,
	},
	{
		label: "sales-ops (knowledge work)",
		seed: salesOps.seed,
		policy: salesOps.policy,
		human: salesOps.actors.decisionOwner,
		agent: salesOps.actors.agentC,
		recordId: "qualified-lead",
		setup: [salesOps.events.registerWi3, salesOps.events.registerWi4, salesOps.events.registerWi5],
		affectedId: "WI-3",
		controlId: "WI-5",
		controlPrep: [salesOps.events.wi5Pushed, salesOps.events.wi5Evidence],
		affectedPrep: [salesOps.events.wi3Pushed],
		contextChange: salesOps.events.v2,
		proseOnly: salesOps.events.proseOnly,
	},
];

// ---------- small builders for ad-hoc events in rule tests ----------

import { fakeSha, type DeltaEvent, type Dependency, type RecordSnapshot, type WorkItem } from "contracts";
import { actors as notificationActors } from "scenario-notifications";

let counter = 1000;
/** A unique, valid commit sha for ad-hoc events. */
export function nextSha(prefix: "a" | "b" | "c" | "d" | "e" | "f" = "e"): string {
	counter += 1;
	return fakeSha(prefix, counter);
}

export function variant(snapshot: RecordSnapshot, patch: Partial<RecordSnapshot>): RecordSnapshot {
	return { ...snapshot, blobHash: "c".repeat(64), facetHash: "d".repeat(64), ...patch };
}

export function baselinePush(repo: string, records: RecordSnapshot[], options: { commitSha?: string; ts?: string; snapshotHash?: string } = {}): DeltaEvent {
	return {
		type: "BaselinePushed",
		ts: options.ts ?? "2026-10-13T16:00:00Z",
		repo,
		commitSha: options.commitSha ?? nextSha("b"),
		snapshotHash: options.snapshotHash ?? "5".repeat(64),
		records,
		invalid: [],
	};
}

export function forkPush(item: { id: string; forkRepo: string }, claims: unknown, options: { commitSha?: string; ts?: string; contextPaths?: string[] } = {}): DeltaEvent {
	return {
		type: "ForkPushed",
		ts: options.ts ?? "2026-10-13T16:10:00Z",
		repo: item.forkRepo,
		commitSha: options.commitSha ?? nextSha("f"),
		workItemId: item.id,
		claims,
		contextPaths: options.contextPaths ?? [],
	};
}

export function registerItem(
	id: string,
	receipt: import("contracts").ContextReceipt,
	dependencies: Array<Pick<Dependency, "recordId" | "facetKeys"> & Partial<Dependency>>,
	options: { requires?: WorkItem["requires"]; actor?: WorkItem["actor"]; source?: WorkItem["source"] } = {},
): DeltaEvent {
	return {
		type: "WorkItemRegistered",
		ts: "2026-10-13T15:00:00Z",
		item: {
			id,
			title: `Test item ${id}`,
			actor: options.actor ?? notificationActors.agentA,
			forkRepo: `test-${id.toLowerCase()}`,
			source: options.source ?? "live",
			intent: "delivery",
			requires: options.requires ?? [],
			status: "running",
		},
		receipt,
		dependencies: dependencies.map((d) => ({ workItemId: id, basis: "declared", status: "accepted", evidenceRefs: [], ...d })),
	};
}
