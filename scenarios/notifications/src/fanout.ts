import { fakeSha, receiptOf, type DeltaEvent, type Dependency, type RecordSnapshot, type WorkItem } from "contracts";
import { actors } from "./actors";

/**
 * The fan-out beat: N synthetic work items (`source: "seeded"`, always labelled "seeded" in the
 * UI) hold receipts against the same records. One decision change is evaluated across all of
 * them. By `index % 10`:
 *
 *   0   depends on notifications.default (+ the unchanged channel)  -> stale on v2
 *   1   depends on notifications.cadence                            -> stale on v2
 *   2   depends on notifications.channel, which v2 leaves alone     -> untouched (same record, unchanged facet)
 *   3,4 depend on status-model                                      -> untouched (different record)
 *   5-9 depend on nothing                                           -> untouched
 *
 * So 2 in 10 go stale and 8 in 10 are left alone, each with a reason code.
 */
export function seededId(index: number): string {
	return `SEED-${String(index + 1).padStart(3, "0")}`;
}

export function seededRepo(index: number): string {
	return `notifications-seed-${String(index + 1).padStart(3, "0")}`;
}

/** Index of seeded items that must go stale when notifications moves v1 -> v2. */
export function expectedStaleIndexes(count: number): number[] {
	return Array.from({ length: count }, (_, i) => i).filter((i) => i % 10 === 0 || i % 10 === 1);
}

export async function buildFanOut(
	count: number,
	baselineCommit: string,
	heads: { notifications: RecordSnapshot; statusModel: RecordSnapshot },
	ts: string,
) {
	const receipt = await receiptOf(baselineCommit, [heads.notifications, heads.statusModel]);
	const registrations: DeltaEvent[] = [];
	for (let i = 0; i < count; i++) {
		const id = seededId(i);
		const item: WorkItem = {
			id,
			title: `Seeded work item ${i + 1}`,
			actor: actors.seeded,
			forkRepo: seededRepo(i),
			source: "seeded",
			intent: "delivery",
			requires: [],
			status: "running",
		};
		const dep = (recordId: string, facetKeys: string[]): Dependency => ({ workItemId: id, recordId, facetKeys, basis: "declared", status: "accepted", evidenceRefs: [] });
		const slot = i % 10;
		const dependencies: Dependency[] =
			slot === 0
				? [dep("notifications", ["notifications.channel", "notifications.default"])]
				: slot === 1
					? [dep("notifications", ["notifications.cadence"])]
					: slot === 2
						? [dep("notifications", ["notifications.channel"])]
						: slot === 3 || slot === 4
							? [dep("status-model", ["status.values"])]
							: [];
		registrations.push({ type: "WorkItemRegistered", ts, item, receipt, dependencies });
	}
	return { registrations, expectedStale: expectedStaleIndexes(count).map(seededId), seedHeadSha: fakeSha("f", 9000) };
}
