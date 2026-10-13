import { describe, expect, it } from "vitest";
import { Claim, ClaimsFile, Resolution, WorkItem, WsMessage, parseRecordRef, formatRecordRef } from "./index";

const human = { kind: "human", id: "decision-owner", displayName: "Decision owner (demo identity)" } as const;
const sha = "a".repeat(64);

const binding = {
	recordId: "notifications",
	version: 2,
	blobHash: sha,
	baseSha: "a100000000000000000000000000000000000001",
	forkHeadSha: "d500000000000000000000000000000000000001",
	contextSnapshotHash: sha,
};

describe("schemas", () => {
	it("Resolution requires a rationale", () => {
		const base = { kind: "reject", workItemId: "WI-2", actor: human, binding, ts: "2026-10-13T16:00:00Z" };
		expect(Resolution.safeParse({ ...base, rationale: "" }).success).toBe(false);
		expect(Resolution.safeParse({ ...base, rationale: "  " }).success).toBe(false);
		expect(Resolution.safeParse({ ...base, rationale: "built on a dead decision" }).success).toBe(true);
	});

	it("Resolution requires a scope for exceptions only", () => {
		const base = { workItemId: "WI-3", actor: human, binding, rationale: "grandfathered", ts: "2026-10-13T16:00:00Z" };
		expect(Resolution.safeParse({ ...base, kind: "accept-exception" }).success).toBe(false);
		expect(Resolution.safeParse({ ...base, kind: "accept-exception", scope: "reports/q4-forecast.md" }).success).toBe(true);
		expect(Resolution.safeParse({ ...base, kind: "revalidate" }).success).toBe(true);
	});

	it("Resolution binding is mandatory", () => {
		const { binding: _b, ...noBinding } = { kind: "revalidate", workItemId: "WI-2", actor: human, rationale: "r", binding, ts: "2026-10-13T16:00:00Z" };
		expect(Resolution.safeParse(noBinding).success).toBe(false);
	});

	it("WorkItem carries source and rejects unknown keys", () => {
		const item = {
			id: "WI-1",
			title: "Status badges",
			actor: { kind: "agent", id: "agent-a", displayName: "Agent A" },
			forkRepo: "notifications-wi-1",
			source: "live",
			intent: "delivery",
			requires: ["contract-test"],
			status: "running",
		};
		expect(WorkItem.safeParse(item).success).toBe(true);
		expect(WorkItem.safeParse({ ...item, source: "imaginary" }).success).toBe(false);
		expect(WorkItem.safeParse({ ...item, extra: 1 }).success).toBe(false);
		const { source: _s, ...noSource } = item;
		expect(WorkItem.safeParse(noSource).success).toBe(false);
	});

	it("Claim basedOn must be recordId@version", () => {
		expect(Claim.safeParse({ subject: "notifications.default", value: "on", basedOn: "notifications@1" }).success).toBe(true);
		expect(Claim.safeParse({ subject: "notifications.default", value: "on", basedOn: "notifications" }).success).toBe(false);
		expect(ClaimsFile.safeParse({ not: "an array" }).success).toBe(false);
	});

	it("record refs round-trip", () => {
		expect(parseRecordRef(formatRecordRef("qualified-lead", 12))).toEqual({ recordId: "qualified-lead", version: 12 });
		expect(parseRecordRef("bad")).toBeNull();
	});

	it("WsMessage accepts the three message kinds and rejects others", () => {
		expect(
			WsMessage.safeParse({
				type: "agent-activity",
				workItemId: "WI-2",
				runId: "run-1",
				kind: "tool",
				text: "Edit src/notify.ts",
				ts: "2026-10-13T16:00:00Z",
			}).success,
		).toBe(true);
		expect(WsMessage.safeParse({ type: "nope" }).success).toBe(false);
	});
});
