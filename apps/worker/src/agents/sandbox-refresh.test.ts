import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A container read that never answers must not wedge the run endpoint. The sandbox Durable Object is run under Node with
// a fake container: its file reads and execs are whatever each test says, including promises that never settle.

const io = vi.hoisted(() => ({
	readFile: undefined as unknown as (path: string, options?: { signal?: AbortSignal }) => Promise<Response>,
	remove: (async () => undefined) as (path: string, options?: { signal?: AbortSignal }) => Promise<void>,
	removed: [] as string[],
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
		remove(path: string, options?: { signal?: AbortSignal }) {
			io.removed.push(path);
			return io.remove(path, options);
		}
		mkdir = async () => undefined;
		writeFile = async () => undefined;
	}
	return { Files, SandboxFileError };
});
vi.mock("../artifacts/git-write", () => ({ errorCode: () => undefined, getRepo: async () => ({}), sleep: async () => undefined }));

import { SandboxFileError } from "@cloudflare/sandbox";
import { DEFAULT_LIMITS, newMeter } from "./gateway-logic";
import { AgentSandbox, type RunRecord } from "./sandbox";

const RUN_ID = "run-1";
// The mocked SandboxFileError (the real class is not constructable under its type).
const enoent = () => new (SandboxFileError as unknown as new (message: string) => Error)("no such file");
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

function makeSandbox(exec: (cmd: string[], options?: { signal?: AbortSignal }) => Promise<unknown>, { running = true, fresh = false }: { running?: boolean; fresh?: boolean } = {}) {
	const kv = new Map<string, unknown>([
		["run", runningRun()],
		["meter", newMeter(RUN_ID, DEFAULT_LIMITS)],
	]);
	// `fresh`: nothing has run on this cell yet (the default is a run that is already in flight).
	if (fresh) kv.clear();
	const setAlarm = vi.fn(async () => undefined);
	const container = {
		running,
		images: { agent: "agent" },
		exec: vi.fn(exec),
		destroy: vi.fn(async () => {
			container.running = false;
		}),
		start: vi.fn(() => {
			container.running = true;
		}),
		setInactivityTimeout: vi.fn(async () => undefined),
		interceptOutboundHttps: vi.fn(async (_host: string, _gateway: unknown) => undefined),
	};
	const ctx = {
		container,
		// A gateway stand-in that keeps the props it was made with, so a test can see whose run it belongs to.
		exports: {
			ArtifactsGateway: (a: { props: unknown }) => ({ gateway: "git", props: a.props }),
			ModelGateway: (a: { props: unknown }) => ({ gateway: "model", props: a.props }),
		},
		storage: { kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => void kv.set(k, v) }, setAlarm },
		blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
	};
	const repo = { log: async () => [{ hash: "a".repeat(40) }], revokeToken: vi.fn(async () => true), [Symbol.dispose]: () => undefined };
	const env = { ARTIFACTS: { get: async () => repo } };
	const sandbox = new AgentSandbox(ctx as never, env as never);
	return { sandbox, kv, setAlarm, container, repo };
}

/** Container files: the runner is alive (pid file present, no exit code yet) and has written two event lines. */
function aliveFiles(overrides: Record<string, () => Promise<Response>> = {}) {
	const calls: string[] = [];
	io.readFile = async (path, options) => {
		calls.push(path.split("/").pop() as string);
		const key = path.split("/").pop() as string;
		if (overrides[key]) return overrides[key]!();
		if (key === "exit-code") throw enoent();
		if (key === "pid") throw enoent();
		if (key === "events.jsonl") return text(eventLine("clone") + eventLine("working"));
		void options;
		throw enoent();
	};
	return calls;
}

beforeEach(() => {
	io.removed.length = 0;
	io.remove = async () => undefined;
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
				if (!hang) return Promise.reject(enoent());
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

describe("the run timeout still fires", () => {
	it("fails a run that is past its limit even though the container never answered the polls before it", async () => {
		aliveFiles({ "exit-code": NEVER });
		const { sandbox, kv } = makeSandbox(async () => NEVER());
		// 29 minutes in: every poll so far has been stuck on the container.
		kv.set("run", { ...(kv.get("run") as RunRecord), startedAt: new Date(Date.now() - 29 * 60_000).toISOString() });
		const first = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(5_000);
		expect((await first)?.state).toBe("running");
		await vi.advanceTimersByTimeAsync(12_000);
		// Two minutes later the limit has passed; the next poll gets as far as the check and ends the run.
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		const last = sandbox.readRun();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await last).toMatchObject({ state: "failed", error: "run exceeded the time limit" });
	});
});

const input = {
	workItemId: "wi-1",
	forkRepo: "smoke-x-wi-1",
	remote: "https://acct.artifacts.cloudflare.net/git/default/smoke-x-wi-1.git",
	token: "t",
	tokenId: "id",
	mode: "claude" as const,
	model: "z-ai/glm-5.3-flash",
	prompt: "Do it",
	stubStepMs: 0,
	instance: "standard-1" as const,
	maxTurns: 5,
	maxBudgetUsd: 1,
	timeoutS: 60,
	limits: DEFAULT_LIMITS,
	idempotencyKey: "k1",
	fingerprint: "f1",
};

describe("a launch that hangs", () => {
	it("fails the run and frees the dispatch lock instead of staying busy forever", async () => {
		io.remove = () => NEVER();
		const { sandbox, kv } = makeSandbox(async () => NEVER());
		kv.delete("run");
		const started = sandbox.startRun(input as never);
		const settled = started.then(
			() => "resolved",
			(e: Error) => e.message,
		);
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await settled).toMatch(/launching the run timed out/);
		expect((kv.get("run") as RunRecord).state).toBe("failed");
		// The lock is released: another dispatch is judged on its own merits (and fails the same way), not answered "busy".
		io.remove = () => NEVER();
		const again = sandbox.startRun({ ...input, idempotencyKey: "k2", fingerprint: "f2" } as never).then(
			(o) => o.status,
			(e: Error) => e.message,
		);
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await again).toMatch(/timed out/);
		io.remove = async () => undefined;
	});
});

/** What the fake exec answers for the short commands (the clock read, the liveness probe). */
const answered = () => ({ output: async () => ({ stdout: new TextEncoder().encode("0"), exitCode: 0 }) });
const isAgentExec = (cmd: string[]) => cmd.includes("/opt/delta/run-agent.sh");
const gatewayRunIds = (container: { interceptOutboundHttps: { mock: { calls: unknown[][] } } }) =>
	container.interceptOutboundHttps.mock.calls.map((c) => ((c[1] as { props: { runId: string } }).props.runId));

describe("an abandoned launch that wakes up after a retry", () => {
	const settle = (p: Promise<unknown>) =>
		p.then(
			() => "resolved",
			(e: Error) => e.message,
		);

	it("registers no gateway, touches no workspace and stops no container when it was stuck in set-up", async () => {
		let releaseSetUp: () => void = () => undefined;
		const { sandbox, kv, container } = makeSandbox(async () => answered(), { running: false, fresh: true });
		container.setInactivityTimeout.mockImplementationOnce(() => new Promise<undefined>((resolve) => (releaseSetUp = () => resolve(undefined))));

		const first = settle(sandbox.startRun(input as never));
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await first).toMatch(/launching the run timed out/);
		const run1 = (kv.get("run") as RunRecord).runId;
		expect(container.destroy).toHaveBeenCalledTimes(1);

		// The cell retries; the new run launches on the same container.
		const retry = await sandbox.startRun({ ...input, idempotencyKey: "k2", fingerprint: "f2" } as never);
		expect(retry.status).toBe("started");
		const run2 = (kv.get("run") as RunRecord).runId;
		expect(run2).not.toBe(run1);
		const interceptsBefore = container.interceptOutboundHttps.mock.calls.length;
		const removedBefore = io.removed.length;
		expect(gatewayRunIds(container)).toEqual([run2, run2]); // git, then the model

		// Now the first launch's set-up finally answers.
		releaseSetUp();
		await vi.advanceTimersByTimeAsync(1_000);

		// It leaves everything of run 2 alone: its gateways, its workspace, its container, its record.
		expect(container.interceptOutboundHttps.mock.calls.length).toBe(interceptsBefore);
		expect(io.removed.length).toBe(removedBefore);
		expect(io.removed).toHaveLength(2); // run 2's own clean-up of the repo and task directories, nothing more
		expect(container.destroy).toHaveBeenCalledTimes(1);
		expect(container.running).toBe(true);
		expect(kv.get("run")).toMatchObject({ runId: run2, state: "running" });
		expect(kv.get("meter")).toMatchObject({ runId: run2 });
	});

	it("does not stop run 2's container when its agent exec returns late", async () => {
		let releaseExec: () => void = () => undefined;
		let agentExecs = 0;
		const { sandbox, kv, container } = makeSandbox(
			async (cmd) => {
				if (!isAgentExec(cmd)) return answered();
				agentExecs++;
				if (agentExecs === 1) return new Promise((resolve) => (releaseExec = () => resolve(answered())));
				return answered();
			},
			{ running: false, fresh: true },
		);
		const first = settle(sandbox.startRun(input as never));
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await first).toMatch(/timed out/);
		expect(container.destroy).toHaveBeenCalledTimes(1);

		await sandbox.startRun({ ...input, idempotencyKey: "k2", fingerprint: "f2" } as never);
		const run2 = (kv.get("run") as RunRecord).runId;
		expect(container.running).toBe(true);

		releaseExec();
		await vi.advanceTimersByTimeAsync(1_000);
		// The late return does not kill the container run 2 is using, nor replace its record.
		expect(container.destroy).toHaveBeenCalledTimes(1);
		expect(container.running).toBe(true);
		expect(kv.get("run")).toMatchObject({ runId: run2, state: "running" });
	});

	it("aborts the file operations and the exec it started when it is given up on", async () => {
		const signals: Record<string, AbortSignal | undefined> = {};
		io.remove = (_path, options) => {
			signals.remove = options?.signal;
			return NEVER();
		};
		const { sandbox } = makeSandbox(async () => answered(), { fresh: true });
		const removeStuck = settle(sandbox.startRun(input as never));
		await vi.advanceTimersByTimeAsync(119_000);
		expect(signals.remove?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1_001);
		expect(await removeStuck).toMatch(/timed out/);
		expect(signals.remove?.aborted).toBe(true);

		io.remove = async () => undefined;
		const execStuck = makeSandbox(
			async (cmd, options) => {
				if (!isAgentExec(cmd)) return answered();
				signals.exec = options?.signal;
				return NEVER();
			},
			{ fresh: true },
		);
		const second = settle(execStuck.sandbox.startRun({ ...input, idempotencyKey: "k3", fingerprint: "f3" } as never));
		await vi.advanceTimersByTimeAsync(120_001);
		expect(await second).toMatch(/timed out/);
		expect(signals.exec?.aborted).toBe(true);
	});
});

describe("finishing a run", () => {
	/** A run whose runner exited 0 and whose container still answers. */
	function exited(overrides: Record<string, () => Promise<Response>> = {}) {
		aliveFiles({ "exit-code": async () => text("0"), ...overrides });
	}

	it("is single-flight: two refreshes that both see the exit finish once (one revoke, one destroy)", async () => {
		exited();
		const { sandbox, container, repo, kv } = makeSandbox(async () => answered());
		const finishes = [(sandbox as never as { finish: (r: RunRecord, o: object) => Promise<RunRecord> }).finish];
		const call = () => finishes[0]!.call(sandbox, kv.get("run") as RunRecord, { state: "failed", exitCode: 1, error: "boom" });
		const [a, b] = await Promise.all([call(), call()]);
		expect(a).toBe(b);
		expect(repo.revokeToken).toHaveBeenCalledTimes(1);
		expect(container.destroy).toHaveBeenCalledTimes(1);
		// A finish arriving after the record is final answers with it and revokes nothing again.
		const later = await call();
		expect(later).toMatchObject({ runId: RUN_ID, state: "failed" });
		expect(repo.revokeToken).toHaveBeenCalledTimes(1);
		expect(container.destroy).toHaveBeenCalledTimes(1);
	});

	it("is single-flight across a poll and the alarm reading the same exit", async () => {
		exited({ "events.jsonl": async () => text(eventLine("done")) });
		const { sandbox, repo } = makeSandbox(async () => answered());
		await Promise.all([sandbox.readRun(), sandbox.alarm(), sandbox.waitForRun(1_000)]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(repo.revokeToken).toHaveBeenCalledTimes(1);
	});

	it("reads the last activity lines again once when the first read fails, before the container is destroyed", async () => {
		let reads = 0;
		exited({
			"events.jsonl": async () => {
				if (++reads === 1) throw new Error("read stalled");
				return text(eventLine("clone") + eventLine("pushed"));
			},
		});
		const { sandbox, kv } = makeSandbox(async () => answered());
		const run = await sandbox.readRun();
		expect(reads).toBe(2);
		expect(run?.activity.map((a) => a.text)).toEqual(["clone", "pushed"]);
		expect((kv.get("run") as RunRecord).activity.map((a) => a.text)).toEqual(["clone", "pushed"]);
	});
});

describe("a run whose container cannot be read", () => {
	it("says so on the record instead of reading as healthy, and clears it once reads work again", async () => {
		let broken = true;
		aliveFiles({
			"exit-code": () => (broken ? Promise.reject(new Error("container went away")) : Promise.reject(enoent())),
		});
		const { sandbox } = makeSandbox(async () => answered());
		const first = await sandbox.readRun();
		expect(first).toMatchObject({ state: "running", refreshError: expect.stringMatching(/container went away/) });
		const again = await sandbox.readRun();
		expect(again?.refreshError).toMatch(/container went away/);

		broken = false;
		aliveFiles({ pid: async () => text("1 2") });
		const healthy = await sandbox.readRun();
		expect(healthy?.state).toBe("running");
		expect(healthy?.refreshError).toBeUndefined();
	});
});
