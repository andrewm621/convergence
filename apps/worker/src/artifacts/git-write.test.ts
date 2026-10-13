import { describe, expect, it } from "vitest";
import { assertSafePath, withStaleRefRetry } from "./git-write";

describe("withStaleRefRetry", () => {
	it("retries a stale ref and succeeds on a later attempt", async () => {
		const seen: number[] = [];
		const result = await withStaleRefRetry(async (attempt) => {
			seen.push(attempt);
			if (attempt < 3) throw new Error("refs/heads/main: stale ref");
			return "ok";
		});
		expect(result).toBe("ok");
		expect(seen).toEqual([1, 2, 3]);
	});

	it("gives up after three tries", async () => {
		let calls = 0;
		await expect(
			withStaleRefRetry(async () => {
				calls++;
				throw new Error("stale ref");
			}),
		).rejects.toThrow(/stale ref/);
		expect(calls).toBe(3);
	});

	it("does not retry other errors", async () => {
		let calls = 0;
		await expect(
			withStaleRefRetry(async () => {
				calls++;
				throw new Error("403 Insufficient permissions");
			}),
		).rejects.toThrow(/403/);
		expect(calls).toBe(1);
	});
});

describe("assertSafePath", () => {
	it("accepts normal repo paths", () => {
		expect(() => assertSafePath("context/notifications.md")).not.toThrow();
	});

	it.each(["../x", "/abs", "a//b", ".git/config", "a/.git/x", ""])("rejects %j", (p) => {
		expect(() => assertSafePath(p)).toThrow(/unsafe path/);
	});
});
