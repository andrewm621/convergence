import { describe, expect, it } from "vitest";
import { CommitSha, NoteRef, WorkItemState, canonicalJson, compareStrings, dedupeKey, formatNoteRef, type DeltaEvent } from "./index";

describe("freeze fixes (contracts)", () => {
	it("B1: a PromotionMerged key includes the merge commit, so a refused merge cannot poison a later one", () => {
		const merged = (mergeCommitSha: string): DeltaEvent => ({ type: "PromotionMerged", ts: "2026-10-13T16:00:00Z", workItemId: "WI-1", repo: "r", mergeCommitSha });
		const a = "a".repeat(40);
		const b = "b".repeat(40);
		expect(dedupeKey(merged(a))).toBe(`promoted:WI-1:${a}`);
		expect(dedupeKey(merged(a))).not.toBe(dedupeKey(merged(b)));
	});

	it.each(["abc1234", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), "a".repeat(63)])("N2: CommitSha rejects %s", (sha) => {
		expect(CommitSha.safeParse(sha).success).toBe(false);
		expect(NoteRef.safeParse(`refs/notes/delta:${sha}`).success).toBe(false);
	});

	it("N2: CommitSha and NoteRef accept 40 and 64 hex characters", () => {
		for (const sha of ["a".repeat(40), "0".repeat(64)]) {
			expect(CommitSha.safeParse(sha).success).toBe(true);
			expect(NoteRef.safeParse(formatNoteRef(sha)).success).toBe(true);
		}
	});

	it.each([
		["a Date", new Date(0)],
		["a Map", new Map([["a", 1]])],
		["a Set", new Set([1])],
		["a class instance", new (class Foo { x = 1; })()],
		["a typed array", new Uint8Array([1])],
	])("N3: canonicalJson throws on %s instead of hashing it as {}", (_name, value) => {
		expect(() => canonicalJson({ v: value })).toThrow();
	});

	it("N3: canonicalJson still takes plain objects, null-prototype objects and arrays", () => {
		expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
		expect(canonicalJson(Object.assign(Object.create(null), { x: 1 }))).toBe('{"x":1}');
	});

	it("N4: compareStrings is a three-way comparator", () => {
		expect(compareStrings("a", "b")).toBeLessThan(0);
		expect(compareStrings("b", "a")).toBeGreaterThan(0);
		expect(compareStrings("a", "a")).toBe(0);
	});

	it("S3: WorkItemState carries the fork's touched context paths, optionally", () => {
		const shape = WorkItemState.shape.contextPaths;
		expect(shape.safeParse(undefined).success).toBe(true);
		expect(shape.safeParse(["context/notifications.md"]).success).toBe(true);
		expect(shape.safeParse("context/notifications.md").success).toBe(false);
	});
});
