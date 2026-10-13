import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A container read that never answers must not wedge the run endpoint. The sandbox Durable Object is run under Node with
// a fake container: its file reads and execs are whatever each test says, including promises that never settle.

const io = vi.hoisted(() => ({
	readFile: undefined as unknown as (path: string, options?: { signal?: AbortSignal }) => Promise<Response>,
}));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("@cloudflare/sandbox", () => {
	class SandboxFileError extends Error {
		code = "ENOENT";
		static is(e: unknown): e is SandboxFileError {
			return e instanceof SandboxFileError;
		}
	}
	class Files {
		readFile(path: string, options?: { signal?: AbortSignal }) {
			return io.readFile(path, options);
		}
	}
	return { Files, SandboxFileError };
});
vi.mock("../artifacts/git-write", () => ({ errorCode: () => undefined, getRepo: async () => ({}), sleep: async () => undefined }));

import { SandboxFileError } from "@cloudflare/sandbox";
import { DEFAULT_LIMITS, newMeter } from "./gateway-logic";
import { AgentSandbox, type RunRecord } from "./sandbox";

const RUN_ID = "run-1";
const NEVER = () => new Promise<never>(() => undefined);
const text = (body: string) => new Response(body);
const eventLine = (what: string) => `${JSON.stringify({ workItemId: "wi-1", ts: new Date().toISOString(), kind: "agent", text: what })}\n`;

function runningRun(): RunRecord {
	return {
		runId: RUN_ID,
		workItemId: "wi-1",
		forkRepo: "smoke-x-wi-1",
		mode: "claude",
		model: "z-ai/glm-5.3-flash",
		author: "workitem-wi-1",
		tokenId: "tok",
		state: "running",
		startedAt: new Date().toISOString(),
		finishedAt: null,
		exitCode: null,
		error: null,
		commit: null,
		pushVerified: null,
		baseHead: "a".repeat(40),
		tokenRevoked: null,
		revalidation: null,
		expectedReceipt: null,
		clockSkewMs: 0,
		usage: null,
		activity: [],
	} as RunRecord;
}

function makeSandbox(exec: (cmd: string[], options?: { signal?: AbortSignal }) => Promise<unknown>) {
	const kv = new Map<string, unknown>([
		["run", runningRun()],
		["meter", newMeter(RUN_ID, DEFAULT_LIMITS)],
	]);
	const setAlarm = vi.fn(async () => undefined);
	const container = { running: true, exec: vi.fn(exec), destroy: vi.fn(async () => undefined), setInactivityTimeout: vi.fn(async () => undefined) };
	const ctx = {
		container,
		storage: { kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => void kv.set(k, v) }, setAlarm },
		blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
	};
	const sandbox = new AgentSandbox(ctx as never, {} as never);
	return { sandbox, kv, setAlarm, container };
}

/** Container files: the runner is alive (pid file present, no exit code yet) and has written two event lines. */
function aliveFiles(overrides: Record<string, () => Promise<Response>> = {}) {
	const calls: string[] = [];
	io.readFile = async (path, options) => {
		calls.push(path.split("/").pop() as string);
		const key = path.split("/").pop() as string;
		if (overrides[key]) return overrides[key]!();
		if (key === "exit-code") throw new SandboxFileError("no such file");
		if (key === "pid") throw new SandboxFileError("no such file");
		if (key === "events.jsonl") return text(eventLine("clone") + eventLine("working"));
		void options;
		throw new SandboxFileError("no such file");
	};
	return calls;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("a container read that never settles", () => {
	it("does not stop readRun answering: the stored record comes back after a few seconds", async () => {
		aliveFiles({ "exit-code": NEVER });
		const { sandbox } = makeSandbox(async () => NEVER());
		const answer = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(5_000);
		const run = await answer;
		expect(run).toMatchObject({ runId: RUN_ID, state: "running" });
		expect(run?.usage).toMatchObject({ modelRequests: 0 }); // live usage still comes from the meter
	});

	it("aborts the read at its deadline, clears the single-flight promise and retries on the next poll", async () => {
		let signal: AbortSignal | undefined;
		let hang = true;
		const calls = aliveFiles({
			"exit-code": () => {
				if (!hang) return Promise.reject(new SandboxFileError("no such file"));
				return NEVER();
			},
		});
		const original = io.readFile;
		io.readFile = (path, options) => {
			if (path.endsWith("exit-code") && hang) signal = options?.signal;
			return original(path, options);
		};
		const { sandbox, kv } = makeSandbox(async () => NEVER());

		const first = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await first)?.state).toBe("running");
		// The native process is told to stop once the read's deadline passes, and the refresh gives up without failing the run.
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(5_001);
		expect(signal?.aborted).toBe(true);
		expect((kv.get("run") as RunRecord).state).toBe("running");

		// The next poll starts a fresh refresh (the stuck one did not stay as the shared promise) and reads again.
		hang = false;
		const before = calls.filter((c) => c === "exit-code").length;
		const second = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(1_000);
		const run = await second;
		expect(calls.filter((c) => c === "exit-code").length).toBeGreaterThan(before);
		expect(run?.activity.map((a) => a.text)).toEqual(["clone", "working"]);
	});

	it("bounds a probe exec that never returns the same way", async () => {
		let probeSignal: AbortSignal | undefined;
		aliveFiles({ pid: async () => text("123 456") });
		const { sandbox, container } = makeSandbox(async (_cmd, options) => {
			probeSignal = options?.signal;
			return NEVER();
		});
		const answer = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await answer)?.state).toBe("running");
		await vi.advanceTimersByTimeAsync(5_001);
		expect(container.exec).toHaveBeenCalled();
		expect(probeSignal?.aborted).toBe(true);
	});

	it("keeps the alarm going: a refresh that times out still re-arms it and never throws", async () => {
		aliveFiles({ "exit-code": NEVER });
		const { sandbox, setAlarm } = makeSandbox(async () => NEVER());
		const alarm = sandbox.alarm();
		await vi.advanceTimersByTimeAsync(10_001);
		await expect(alarm).resolves.toBeUndefined();
		expect(setAlarm).toHaveBeenCalledTimes(1);
	});

	it("lets waitForRun return at its own deadline instead of waiting on the stuck refresh", async () => {
		aliveFiles({ "exit-code": NEVER });
		const { sandbox } = makeSandbox(async () => NEVER());
		const waited = sandbox.waitForRun(12_000);
		await vi.advanceTimersByTimeAsync(20_000);
		expect((await waited)?.state).toBe("running");
	});
});

describe("an abandoned refresh that wakes up late", () => {
	it("does not put a stale running record over a finished one", async () => {
		let release: (r: Response) => void = () => undefined;
		aliveFiles({ "events.jsonl": () => new Promise<Response>((resolve) => (release = resolve)) });
		const { sandbox, kv } = makeSandbox(async () => NEVER());
		const answer = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(5_000);
		await answer;
		// Meanwhile the run is finished by something else.
		kv.set("run", { ...(kv.get("run") as RunRecord), state: "succeeded", finishedAt: new Date().toISOString() });
		release(text(eventLine("late")));
		await vi.advanceTimersByTimeAsync(1_000);
		expect((kv.get("run") as RunRecord).state).toBe("succeeded");
	});
});
