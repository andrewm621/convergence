import { describe, expect, it, vi } from "vitest";
import { assertSafePath, getRepo, withStaleRefRetry } from "./git-write";

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

describe("getRepo", () => {
	const coded = (code: string) => Object.assign(new Error(code), { code });
	const envWith = (get: () => Promise<unknown>) => ({ ARTIFACTS: { get } }) as unknown as Env;

	it("surfaces NOT_FOUND immediately unless the caller opts in", async () => {
		const get = vi.fn(async () => {
			throw coded("NOT_FOUND");
		});
		await expect(getRepo(envWith(get), "r")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("retries NOT_FOUND after create/fork when asked to, then succeeds", async () => {
		vi.useFakeTimers();
		try {
			const repo = { name: "r" };
			const get = vi.fn()
				.mockRejectedValueOnce(coded("NOT_FOUND"))
				.mockRejectedValueOnce(coded("NOT_FOUND"))
				.mockResolvedValueOnce(repo);
			const p = getRepo(envWith(get), "r", { retryNotFound: true });
			await vi.advanceTimersByTimeAsync(250 + 500);
			await expect(p).resolves.toBe(repo);
			expect(get).toHaveBeenCalledTimes(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("always retries the in-progress codes", async () => {
		vi.useFakeTimers();
		try {
			const repo = { name: "r" };
			const get = vi.fn().mockRejectedValueOnce(coded("FORK_IN_PROGRESS")).mockResolvedValueOnce(repo);
			const p = getRepo(envWith(get), "r");
			await vi.advanceTimersByTimeAsync(250);
			await expect(p).resolves.toBe(repo);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not sleep after the final attempt", async () => {
		vi.useFakeTimers();
		try {
			const get = vi.fn(async () => {
				throw coded("CREATE_IN_PROGRESS");
			});
			let settled = false;
			const p = getRepo(envWith(get), "r", { attempts: 3 }).catch((e) => {
				settled = true;
				return e;
			});
			// Sleeps happen only between attempts: 250 + 500 ms. A third sleep (750 ms) would leave this unsettled.
			await vi.advanceTimersByTimeAsync(250 + 500);
			expect(settled).toBe(true);
			expect(get).toHaveBeenCalledTimes(3);
			expect(await p).toMatchObject({ code: "CREATE_IN_PROGRESS" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("rethrows other errors without retrying", async () => {
		const get = vi.fn(async () => {
			throw coded("INTERNAL_ERROR");
		});
		await expect(getRepo(envWith(get), "r", { retryNotFound: true })).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(get).toHaveBeenCalledTimes(1);
	});
});
