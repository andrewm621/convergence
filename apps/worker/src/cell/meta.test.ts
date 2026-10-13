import { describe, expect, it } from "vitest";
import { CellMeta } from "./meta";
import { nodeSqlite } from "./testing/node-sqlite";

const A = "a".repeat(40);
const B = "b".repeat(40);
const AT = "2026-10-13T16:00:00Z";

function tracked() {
	const meta = new CellMeta(nodeSqlite());
	meta.track({ repo: "base", kind: "baseline", workItemId: null, baseCommit: null, cursor: null });
	return meta;
}

describe("poller bookkeeping", () => {
	it("counts failures per (repo, commit), not per repo", () => {
		const meta = tracked();
		expect(meta.failCommit("base", A, "boom", AT, 0)).toBe(1);
		expect(meta.failCommit("base", A, "boom", AT, 0)).toBe(2);
		// A different commit starts its own count.
		expect(meta.failCommit("base", B, "boom", AT, 0)).toBe(1);
		expect(meta.failCommit("base", B, "boom", AT, 0)).toBe(2);
	});

	it("a repo-level error (the head could not be read) does not count against any commit", () => {
		const meta = tracked();
		meta.failCommit("base", A, "boom", AT, 0);
		meta.repoError("base", "log failed", AT, 0);
		meta.repoError("base", "log failed", AT, 0);
		expect(meta.failCommit("base", A, "boom", AT, 0)).toBe(2);
	});

	it("success resets the count, the error and the backoff", () => {
		const meta = tracked();
		meta.failCommit("base", A, "boom", AT, Date.now() + 60_000);
		meta.advance("base", A, AT);
		expect(meta.trackedRepo("base")).toMatchObject({ cursor: A, failures: 0, failingSha: null, lastError: null, retryAt: null, streak: 0 });
		expect(meta.failCommit("base", A, "again", AT, 0)).toBe(1);
	});

	it("an idle head check clears a repo-level error", () => {
		const meta = tracked();
		meta.repoError("base", "log failed", AT, Date.now() + 1000);
		meta.touchOk("base", AT);
		expect(meta.trackedRepo("base")).toMatchObject({ lastError: null, retryAt: null, streak: 0 });
	});

	it("will not track a repo twice", () => {
		const meta = tracked();
		expect(() => meta.track({ repo: "base", kind: "fork", workItemId: "WI-1", baseCommit: A, cursor: A })).toThrow();
	});

	it("a skipped commit leaves a note that stays until the next success", () => {
		const meta = tracked();
		meta.track({ repo: "fork", kind: "fork", workItemId: "WI-1", baseCommit: A, cursor: A });
		meta.skip("fork", B, "skipped bbbbbbb", AT);
		expect(meta.trackedRepo("fork")).toMatchObject({ cursor: B, degradedNote: "skipped bbbbbbb" });
		expect(meta.health().healthy).toBe(false);
		meta.advance("fork", A, AT);
		expect(meta.health().healthy).toBe(true);
	});
});
