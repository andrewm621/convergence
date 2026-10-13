import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { buildRevalidationReceipt, type Receipt } from "../../container/receipt-lib";
import { errorCode } from "../artifacts/git-write";
import { redactText } from "../artifacts/tokens";
import {
	admit,
	deactivate,
	isSaneMeter,
	newMeter,
	recordUsage,
	settleOutstanding,
	type Admission,
	type AdmitRequest,
	type Meter,
	type RunLimits,
} from "./gateway-logic";
import {
	authorFor,
	buildAgentPrompt,
	buildRevalidationPrompt,
	claimedPushSha,
	claudeEnv,
	commitSubject,
	ContainerTimeoutError,
	decideRun,
	parseActivity,
	parseExitCode,
	readCappedText,
	remoteParts,
	sanitizeText,
	settleWithin,
	verifyPush,
	verifyReceiptText,
	withDeadline,
	withTimeout,
	MAX_EVENTS_BYTES,
	type ActivityLine,
	type AgentMode,
	type PushVerdict,
	type ReceiptVerdict,
	type Revalidate,
	type SandboxInstance,
} from "./protocol";

// One Durable Object per work item, each owning one container. It clones the work item's fork, runs the
// agent, and the in-container runner commits as the work item and pushes. Pattern follows Cloudflare's
// "Build a coding agent runner" tutorial: no direct internet, outbound handlers for the hosts the run
// needs, and the task runs in the background with its state in files so a request can end safely.
//
// Trust boundary: everything the container writes (events, exit code, stderr, "pushed <sha>" lines) is
// untrusted. It is read with size caps, validated, stripped of control characters and redacted, and it never
// decides the outcome alone: a push is accepted only if the fork's real history, read through the Artifacts
// binding, agrees (see verifyPush).

const REPO_DIR = "/workspace/repo";
const TASK_DIR = "/workspace/task";
const INBOX_DIR = `${TASK_DIR}/inbox`;
const EVENTS_PATH = `${TASK_DIR}/events.jsonl`;
const STDERR_PATH = `${TASK_DIR}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIR}/exit-code`;
const PID_PATH = `${TASK_DIR}/pid`;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
/** A run that has not exited by then is failed and its container destroyed. */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const ALARM_INTERVAL_MS = 3_000;
/**
 * A container read or exec that has not answered by then is abandoned (its native process is aborted) and the run is left as it
 * was until the next poll. Without it, one read that never returns would hold every refresh, and so every run read, forever.
 */
const CONTAINER_IO_TIMEOUT_MS = 10_000;
/** Safety net for a whole refresh, finishing a run included (its verification reads have their own limits). */
const REFRESH_TIMEOUT_MS = 120_000;
/** Everything startRun does between recording the run and the agent process being started. */
const LAUNCH_TIMEOUT_MS = 120_000;
/** Stopping the container and revoking the token while finishing a run. */
const TEARDOWN_TIMEOUT_MS = 15_000;
/** The run endpoint answers from the stored record after this long, even while a refresh is still in flight. */
const READ_RUN_WAIT_MS = 5_000;
const STDERR_READ_BYTES = 64 * 1024;
const RUN_KEY = "run";
const METER_KEY = "meter";
/** How long to wait on each Artifacts read while verifying a run. A read that hangs fails the run. */
const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_LOG_LIMIT = 10;
const IDEMPOTENCY_KEY = "idempotency";
const IDEMPOTENCY_KEEP = 20;

const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// Containers re-signs intercepted HTTPS with its own CA; point git and Node at it.
const TRUST_ENV = {
	NODE_EXTRA_CA_CERTS: CA_PATH,
	GIT_SSL_CAINFO: CA_PATH,
	CURL_CA_BUNDLE: CA_PATH,
	SSL_CERT_FILE: CA_PATH,
};

// Runs the command in its own process group; records the pid at start and the exit code at the end.
const TASK_SCRIPT = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

// Succeeds while the process in the pid file is alive and started in this container instance.
const TASK_RUNNING_SCRIPT = `read -r pid boot <"$1" &&
	[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
	kill -0 "$pid"`;

export interface StartRunInput {
	workItemId: string;
	forkRepo: string;
	/** Credential-free git remote of the fork. */
	remote: string;
	/** Short-lived write token. Held in memory and handed to the outbound handler; never stored or logged. */
	token: string;
	/** Id of that token, so it can be revoked when the run ends. Not a secret. */
	tokenId: string;
	mode: AgentMode;
	model: string;
	prompt: string;
	stubStepMs: number;
	instance: SandboxInstance;
	maxTurns: number;
	maxBudgetUsd: number;
	timeoutS: number;
	/** Enforced by the gateways, not by the agent: request counts, token ceiling, output ceiling. */
	limits: RunLimits;
	/** Caller's Idempotency-Key and the fingerprint of the request it was first used with. */
	idempotencyKey: string;
	fingerprint: string;
	/** Diff-aware re-run on the same fork. */
	revalidate?: Revalidate;
}

export type RunState = "running" | "succeeded" | "failed" | "lost" | "none";

export interface RunRecord {
	/** Identifies this run to the gateways; a stale registration from an earlier run is refused. */
	runId: string;
	workItemId: string;
	forkRepo: string;
	mode: AgentMode;
	/** The model this run is pinned to at the gateway. */
	model: string;
	author: string;
	tokenId: string;
	state: RunState;
	/** AgentRunStarted: when the Durable Object launched the runner. */
	startedAt: string;
	/** AgentRunFinished: when the Durable Object first observed the runner had exited. */
	finishedAt: string | null;
	exitCode: number | null;
	error: string | null;
	/** The fork head this run produced, only ever set from the fork's real history. */
	commit: string | null;
	/** True when the fork's history agreed with the run's outcome; false when it contradicted it; null when not checked. */
	pushVerified: boolean | null;
	/** Fork head before the run started (read through the binding). */
	baseHead: string | null;
	tokenRevoked: boolean | null;
	/** Present on a revalidation run: which decisions changed. */
	revalidation: Revalidate["changes"] | null;
	/** The receipt the pushed commit must carry, computed here from what was sent. Null unless revalidating. */
	expectedReceipt: Receipt | null;
	/** DO clock minus container clock when the run started. The container clock can run seconds behind. */
	clockSkewMs: number;
	/** What the gateways metered for this run (requests, tokens, dollars as reported by the upstream). Null before it ends. */
	usage: RunUsage | null;
	/** Agent-reported activity: display only, never evidence. */
	activity: ActivityLine[];
}

export interface RunUsage {
	modelRequests: number;
	gitRequests: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	/** Set when a gateway budget ended the run. */
	budgetExceeded: string | null;
}

export type StartOutcome =
	| { status: "started" | "replay"; run: RunRecord }
	| { status: "busy" | "key_reused"; run: RunRecord | null };

interface IdempotencyEntry {
	key: string;
	fingerprint: string;
}

export class AgentSandbox extends DurableObject<Env> {
	private readonly container: Container;
	private readonly files: Files;
	private setup: Promise<void> | undefined;
	private refreshing: Promise<RunRecord | null> | undefined;
	private readonly finishing = new Map<string, Promise<RunRecord>>();
	/** Set synchronously on entry to startRun, so two overlapping dispatches can't both launch. */
	private starting = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (!ctx.container) throw new Error("The container binding is not configured");
		this.container = ctx.container;
		this.files = new Files(ctx.container);
		if (this.container.running) {
			void ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
		}
	}

	/** Cheap pre-check so the Worker doesn't mint a token for a retry it already served. Authoritative check is in startRun. */
	peekIdempotency(key: string, fingerprint: string): "new" | "replay" | "reused" {
		const entry = this.idempotencyEntries().find((e) => e.key === key);
		if (!entry) return "new";
		return entry.fingerprint === fingerprint ? "replay" : "reused";
	}

	/**
	 * Start a run in the background. `replay` returns the run an earlier call with the same Idempotency-Key started;
	 * `busy` means a different dispatch for this work item is already in flight.
	 */
	async startRun(input: StartRunInput): Promise<StartOutcome> {
		// Everything up to `this.starting = true` is synchronous: no other dispatch can interleave.
		const seen = this.peekIdempotency(input.idempotencyKey, input.fingerprint);
		if (seen === "reused") return { status: "key_reused", run: this.storedRun() };
		if (seen === "replay") {
			const run = this.storedRun();
			if (run) return { status: "replay", run: (await this.refreshOrStored()) ?? run };
		}
		if (this.starting) return { status: "busy", run: this.storedRun() };
		this.starting = true;
		try {
			const current = await this.refreshOrStored();
			if (current?.state === "running") return { status: "busy", run: current };
			return { status: "started", run: await this.launch(input) };
		} finally {
			this.starting = false;
		}
	}

	/**
	 * Current record, refreshed from the container while a run is in flight. It never waits long on the container: when the
	 * refresh is slow or failing, the stored record answers (the activity lines may be a poll or two behind).
	 */
	async readRun(): Promise<RunRecord | null> {
		const stored = this.storedRun();
		if (!stored || stored.state !== "running") return this.withLiveUsage(stored);
		return this.withLiveUsage((await settleWithin(this.refresh(), READ_RUN_WAIT_MS)) ?? this.storedRun());
	}

	/** Hold until the run ends (or `timeoutMs`), then return the record. */
	async waitForRun(timeoutMs: number): Promise<RunRecord | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const run = (await settleWithin(this.refresh(), READ_RUN_WAIT_MS)) ?? this.storedRun();
			if (!run || run.state !== "running" || Date.now() >= deadline) return this.withLiveUsage(run);
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}

	override async alarm(): Promise<void> {
		// A refresh that fails or times out must not stop the polling: the alarm is set again whenever the run is still going.
		const run = await this.refreshOrStored();
		if (run?.state === "running") await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
	}

	// ---- gateway metering (called by ArtifactsGateway / ModelGateway, never by the container) ----

	/** Admit or refuse one outbound request against this run's meter. A call from a stale or ended run is refused. */
	admitRequest(runId: string, req: AdmitRequest): Admission {
		const meter = this.storedMeter();
		if (!meter || meter.runId !== runId) return { ok: false, status: 403, reason: "unknown run" };
		const was = meter.exceeded;
		const { meter: next, admission } = admit(meter, req);
		this.ctx.storage.kv.put(METER_KEY, next);
		if (!was && next.exceeded) this.failFast();
		return admission;
	}

	/** Replace a model request's reservation with what it was charged. Settling a request twice, or after the run's end, does nothing. */
	recordModelUsage(runId: string, usage: { requestId: string; input: number; output: number; cost?: number }): void {
		const meter = this.storedMeter();
		if (!meter || meter.runId !== runId) return;
		const was = meter.exceeded;
		const next = recordUsage(meter, usage);
		this.ctx.storage.kv.put(METER_KEY, next);
		if (!was && next.exceeded) this.failFast();
	}

	/** The persisted meter, or null when there is none or it is not intact (an unreadable meter refuses everything, it never reads as "unused"). */
	private storedMeter(): Meter | null {
		const stored = this.ctx.storage.kv.get(METER_KEY);
		return isSaneMeter(stored) ? stored : null;
	}

	/** A budget was exceeded: have the alarm fail the run right away instead of waiting for the next poll. */
	private failFast(): void {
		void this.ctx.storage.setAlarm(Date.now());
	}

	/** Usage reports can land just after a run ends (they are sent after the response streams); show the latest meter. */
	private withLiveUsage(run: RunRecord | null): RunRecord | null {
		const meter = this.storedMeter();
		if (!run || !meter || meter.runId !== run.runId) return run;
		return {
			...run,
			usage: {
				modelRequests: meter.modelRequests,
				gitRequests: meter.gitRequests,
				inputTokens: meter.inputTokens,
				outputTokens: meter.outputTokens,
				costUsd: meter.costUsd,
				budgetExceeded: meter.exceeded,
			},
		};
	}

	// ---- launching ----

	private async launch(input: StartRunInput): Promise<RunRecord> {
		const author = authorFor(input.workItemId);
		const { host, path } = remoteParts(input.remote);

		// Record the run as `running` and the key as used before touching the container.
		const runId = crypto.randomUUID();
		const provisional: RunRecord = {
			runId,
			workItemId: input.workItemId,
			forkRepo: input.forkRepo,
			mode: input.mode,
			model: input.model,
			author: author.name,
			tokenId: input.tokenId,
			state: "running",
			startedAt: new Date().toISOString(),
			finishedAt: null,
			exitCode: null,
			error: null,
			commit: null,
			pushVerified: null,
			baseHead: null,
			tokenRevoked: null,
			revalidation: input.revalidate?.changes ?? null,
			expectedReceipt: null,
			clockSkewMs: 0,
			usage: null,
			activity: [],
		};
		this.ctx.storage.kv.put(RUN_KEY, provisional);
		this.ctx.storage.kv.put(METER_KEY, newMeter(runId, input.limits));
		this.rememberKey({ key: input.idempotencyKey, fingerprint: input.fingerprint });

		const launching = { abandoned: false };
		try {
			// Bounded as a whole: every container call in here (start, intercepts, file writes, the agent exec) can wait on the container.
			return await withTimeout(this.launchSteps(input, provisional, host, path, launching), LAUNCH_TIMEOUT_MS, "launching the run");
		} catch (e) {
			launching.abandoned = true;
			// The run never launched: close the record, free the key so the caller can retry, and let the caller revoke the token.
			this.forgetKey(input.idempotencyKey);
			this.deactivateMeter();
			this.ctx.storage.kv.put(RUN_KEY, {
				...provisional,
				state: "failed",
				finishedAt: new Date().toISOString(),
				error: redactText(e instanceof Error ? e.message : String(e)).slice(0, 500),
			} satisfies RunRecord);
			if (this.container.running) await withTimeout(this.container.destroy(), TEARDOWN_TIMEOUT_MS, "stopping the container").catch(() => undefined);
			this.setup = undefined;
			throw e;
		}
	}

	private async launchSteps(
		input: StartRunInput,
		provisional: RunRecord,
		host: string,
		path: string,
		launching: { abandoned: boolean },
	): Promise<RunRecord> {
		const author = authorFor(input.workItemId);
		const runId = provisional.runId;
		const baseHead = await this.readForkHead(input.forkRepo);
		// Verification needs a known starting point; a fork with no history can't be verified, so don't run.
		if (!baseHead) throw new Error("the fork has no commits to start from");
		const expectedReceipt = input.revalidate
			? await buildRevalidationReceipt({
					workItemId: input.workItemId,
					baseCommit: baseHead,
					changes: input.revalidate.changes,
					contextFiles: input.revalidate.context,
				})
			: null;
		await this.startContainer(input, runId, host, path);
		await this.files.remove(REPO_DIR, { recursive: true, force: true });
		await this.files.remove(TASK_DIR, { recursive: true, force: true });
		await this.files.mkdir(INBOX_DIR, { recursive: true });
		if (input.revalidate) {
			for (const [name, text] of Object.entries(input.revalidate.context)) {
				await this.files.writeFile(`${INBOX_DIR}/${name}`, text);
			}
			await this.files.writeFile(`${TASK_DIR}/revalidate.json`, JSON.stringify(input.revalidate.changes));
		}

		const taskPrompt = input.revalidate
			? `${buildRevalidationPrompt(input.revalidate.changes)}\n\nOriginal task:\n${input.prompt}`
			: input.prompt;
		const subjectText = input.revalidate
			? `revalidate ${input.revalidate.changes.map((c) => `${c.recordId} v${c.fromVersion}->v${c.toVersion}`).join(", ") || "claims"}`
			: input.prompt;

		const env: Record<string, string> = {
			...TRUST_ENV,
			HOME: "/root",
			WORK_ITEM_ID: input.workItemId,
			AGENT_MODE: input.mode,
			AGENT_MODEL: input.model,
			// The credential-free remote. The token is added to the request by ArtifactsGateway.
			ARTIFACTS_GIT_REMOTE: input.remote,
			GIT_AUTHOR_NAME: author.name,
			GIT_AUTHOR_EMAIL: author.email,
			GIT_COMMITTER_NAME: author.name,
			GIT_COMMITTER_EMAIL: author.email,
			COMMIT_SUBJECT: commitSubject(input.workItemId, subjectText),
			AGENT_PROMPT: input.mode === "claude" ? buildAgentPrompt(input.workItemId, taskPrompt) : taskPrompt,
			STUB_STEP_MS: String(input.stubStepMs),
			AGENT_MAX_TURNS: String(input.maxTurns),
			AGENT_MAX_BUDGET_USD: String(input.maxBudgetUsd),
			AGENT_TIMEOUT_S: String(input.timeoutS),
			REPO_DIR,
			TASK_DIR,
			EVENTS_FILE: EVENTS_PATH,
			...(input.mode === "claude" ? claudeEnv(input.model, input.limits.maxOutputTokens) : {}),
		};

		const clockSkewMs = await this.measureClockSkew();
		if (launching.abandoned) throw new Error("the launch was given up on");
		const startedAt = new Date().toISOString();
		await this.container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", TASK_DIR, "/opt/delta/run-agent.sh"], {
			cwd: "/workspace",
			env,
			stdout: "ignore",
			stderr: "ignore",
		});

		if (launching.abandoned) {
			this.container.destroy().catch(() => undefined);
			throw new Error("the launch was given up on");
		}
		const run: RunRecord = { ...provisional, startedAt, baseHead, clockSkewMs, expectedReceipt };
		this.ctx.storage.kv.put(RUN_KEY, run);
		await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
		return run;
	}

	// ---- idempotency ----

	private idempotencyEntries(): IdempotencyEntry[] {
		return (this.ctx.storage.kv.get(IDEMPOTENCY_KEY) as IdempotencyEntry[] | undefined) ?? [];
	}

	private rememberKey(entry: IdempotencyEntry): void {
		const rest = this.idempotencyEntries().filter((e) => e.key !== entry.key);
		this.ctx.storage.kv.put(IDEMPOTENCY_KEY, [...rest, entry].slice(-IDEMPOTENCY_KEEP));
	}

	private forgetKey(key: string): void {
		this.ctx.storage.kv.put(
			IDEMPOTENCY_KEY,
			this.idempotencyEntries().filter((e) => e.key !== key),
		);
	}

	// ---- refreshing and finishing ----

	private storedRun(): RunRecord | null {
		return (this.ctx.storage.kv.get(RUN_KEY) as RunRecord | undefined) ?? null;
	}

	/**
	 * Single-flight: the alarm and a waiting request must not both finalize the same run. The shared promise always settles
	 * (it is bounded by REFRESH_TIMEOUT_MS), so `refreshing` is always cleared and the next call starts a fresh refresh.
	 */
	private refresh(): Promise<RunRecord | null> {
		this.refreshing ??= withTimeout(this.doRefresh(), REFRESH_TIMEOUT_MS, "refreshing the run").finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	/** A refresh, or the stored record when the refresh failed or timed out (the failure is logged, not thrown). */
	private async refreshOrStored(): Promise<RunRecord | null> {
		try {
			return await this.refresh();
		} catch (e) {
			console.error(`run refresh failed: ${redactText(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
			return this.storedRun();
		}
	}

	private async doRefresh(): Promise<RunRecord | null> {
		const run = this.storedRun();
		if (!run || run.state !== "running") return run;
		// Still launching: the container isn't ready to be inspected yet.
		if (this.starting) return run;

		// The gateways tripped a budget (requests, tokens): fail the run now and cut the container off.
		const meter = this.storedMeter();
		if (!meter || meter.runId !== run.runId) {
			return this.finish(run, { state: "failed", exitCode: null, error: "run budget could not be read (the run's meter is missing or damaged)" });
		}
		if (meter.exceeded) {
			return this.finish(run, { state: "failed", exitCode: null, error: `run budget exceeded: ${meter.exceeded}` });
		}
		if (Date.now() - Date.parse(run.startedAt) > RUN_TIMEOUT_MS) {
			return this.finish(run, { state: "failed", exitCode: null, error: "run exceeded the time limit" });
		}
		if (!this.container.running) {
			return this.finish(run, { state: "lost", exitCode: null, error: "container stopped before the runner recorded an exit code" });
		}

		let exitCode: number | null;
		try {
			exitCode = parseExitCode(await this.readCapped(EXIT_CODE_PATH, 32));
			if (exitCode === null) {
				if (await this.runnerAlive()) {
					// Keep the live tail fresh, and persisted in case the container disappears. An abandoned refresh that wakes up
					// late must not put a stale `running` record over one that has since finished.
					const live = { ...run, activity: await this.readActivity(run) };
					const now = this.storedRun();
					if (now?.runId === run.runId && now.state === "running") this.ctx.storage.kv.put(RUN_KEY, live);
					return live;
				}
				// It may have exited between the two reads.
				exitCode = parseExitCode(await this.readCapped(EXIT_CODE_PATH, 32));
			}
		} catch (e) {
			// The container did not answer. That says nothing about the run: leave it running and ask again on the next poll.
			if (e instanceof ContainerTimeoutError) {
				console.error(`container probe gave no answer: ${e.message}`);
				return run;
			}
			throw e;
		}
		if (exitCode === null) {
			return this.finish(run, { state: "lost", exitCode: null, error: "runner exited without a valid exit code" });
		}
		if (exitCode === 0) return this.finish(run, { state: "succeeded", exitCode, error: null });
		const stderr = (await this.readCapped(STDERR_PATH, STDERR_READ_BYTES)) ?? "";
		return this.finish(run, {
			state: "failed",
			exitCode,
			error: redactText(sanitizeText(stderr.slice(-1500), 1500)) || `runner exited ${exitCode}`,
		});
	}

	/** Finishing is single-flight per run too: an abandoned refresh that wakes up late joins the finish already under way. */
	private finish(
		run: RunRecord,
		runnerOutcome: { state: Exclude<RunState, "running" | "none">; exitCode: number | null; error: string | null },
	): Promise<RunRecord> {
		const under = this.finishing.get(run.runId);
		if (under) return under;
		const work = this.finishRun(run, runnerOutcome).finally(() => this.finishing.delete(run.runId));
		this.finishing.set(run.runId, work);
		return work;
	}

	private async finishRun(
		run: RunRecord,
		runnerOutcome: { state: Exclude<RunState, "running" | "none">; exitCode: number | null; error: string | null },
	): Promise<RunRecord> {
		// Already finished (or replaced by a newer run) while this call was waiting: the stored record stands.
		const current = this.storedRun();
		if (!current || current.runId !== run.runId || current.state !== "running") return current ?? run;
		const finishedAt = new Date().toISOString();
		const activity = await this.readActivitySafely(run);

		// Charge any call whose report never arrived at its reserved worst case, then freeze the meter.
		const stored = this.storedMeter();
		const meter = stored && stored.runId === run.runId ? settleOutstanding(stored) : stored;
		if (meter && meter !== stored) this.ctx.storage.kv.put(METER_KEY, meter);
		const usage: RunUsage | null =
			meter && meter.runId === run.runId
				? {
						modelRequests: meter.modelRequests,
						gitRequests: meter.gitRequests,
						inputTokens: meter.inputTokens,
						outputTokens: meter.outputTokens,
						costUsd: meter.costUsd,
						budgetExceeded: meter.exceeded,
					}
				: null;

		// A budget crossed on the last calls (or by the worst-case charge for a report that never came) fails the run too.
		const outcome =
			runnerOutcome.state === "succeeded" && meter?.exceeded
				? { ...runnerOutcome, state: "failed" as const, error: `run budget exceeded: ${meter.exceeded}` }
				: runnerOutcome;

		// Cut the container off before judging it: clear the gateway registration (nothing more is admitted), stop the
		// container, and revoke the write token. The fork history is then frozen while it is verified.
		this.deactivateMeter();
		if (this.container.running) await withTimeout(this.container.destroy(), TEARDOWN_TIMEOUT_MS, "stopping the container").catch(() => undefined);
		this.setup = undefined;
		const tokenRevoked = await this.revokeToken(run.forkRepo, run.tokenId);

		// The runner's word is never enough: the outcome comes from the fork's real history (and receipt).
		const { verification, receipt } =
			outcome.state === "succeeded" ? await this.verifyOutcome(run, claimedPushSha(activity)) : { verification: undefined, receipt: { required: false, result: undefined } };
		const decided = decideRun({ runner: outcome.state, runnerError: outcome.error, verification, receipt });

		const done: RunRecord = {
			...run,
			state: decided.state,
			error: decided.error,
			exitCode: outcome.exitCode,
			finishedAt,
			commit: decided.commit,
			pushVerified: decided.pushVerified,
			tokenRevoked,
			usage,
			activity,
		};
		this.ctx.storage.kv.put(RUN_KEY, done);
		return done;
	}

	private deactivateMeter(): void {
		const meter = this.storedMeter();
		if (meter) this.ctx.storage.kv.put(METER_KEY, deactivate(meter));
	}

	private async readActivitySafely(run: RunRecord): Promise<ActivityLine[]> {
		if (!this.container.running) return run.activity;
		try {
			return await this.readActivity(run);
		} catch {
			return run.activity;
		}
	}

	/**
	 * Read the fork's history (and, for a revalidation, the receipt at the pushed commit) through the Artifacts
	 * binding. Any read that throws, hangs or comes back short leaves the result `undefined`, which decideRun fails.
	 */
	private async verifyOutcome(
		run: RunRecord,
		claimedSha: string | null,
	): Promise<{ verification: PushVerdict | undefined; receipt: { required: boolean; result: ReceiptVerdict | undefined } }> {
		const required = run.expectedReceipt !== null;
		let verification: PushVerdict | undefined;
		let result: ReceiptVerdict | undefined;
		try {
			using repo = await withTimeout(this.env.ARTIFACTS.get(run.forkRepo), VERIFY_TIMEOUT_MS, "opening the fork");
			const log = await withTimeout(repo.log({ ref: "main", limit: VERIFY_LOG_LIMIT }), VERIFY_TIMEOUT_MS, "reading the fork log");
			verification = verifyPush({
				baseHead: run.baseHead,
				recent: log.map((m) => ({ hash: m.hash, author: m.author?.name as string, parents: m.parents as string[] })),
				expectedAuthor: run.author,
				claimedSha,
			});
			if (required && verification.ok && verification.commit && run.expectedReceipt) {
				try {
					const blob = await withTimeout(
						repo.readFile({ ref: verification.commit, path: ".delta/receipt.json" }),
						VERIFY_TIMEOUT_MS,
						"reading the receipt",
					);
					const text = blob ? await withTimeout(blob.text(), VERIFY_TIMEOUT_MS, "reading the receipt") : null;
					result = verifyReceiptText(text, run.expectedReceipt);
				} catch {
					result = undefined;
				}
			}
		} catch (e) {
			console.error(`push verification failed for ${run.forkRepo}: ${errorCode(e) ?? "error"}`);
			verification = undefined;
		}
		return { verification, receipt: { required, result } };
	}

	private async readForkHead(forkRepo: string): Promise<string | null> {
		using repo = await withTimeout(this.env.ARTIFACTS.get(forkRepo), VERIFY_TIMEOUT_MS, "opening the fork");
		return (await withTimeout(repo.log({ ref: "main", limit: 1 }), VERIFY_TIMEOUT_MS, "reading the fork log"))[0]?.hash ?? null;
	}

	private async revokeToken(forkRepo: string, tokenId: string): Promise<boolean> {
		try {
			using repo = await withTimeout(this.env.ARTIFACTS.get(forkRepo), TEARDOWN_TIMEOUT_MS, "opening the fork");
			return await withTimeout(repo.revokeToken(tokenId), TEARDOWN_TIMEOUT_MS, "revoking the token");
		} catch (e) {
			console.error(`token revoke failed for ${forkRepo}: ${errorCode(e) ?? "error"}`);
			return false;
		}
	}

	// ---- container plumbing ----

	private async startContainer(input: StartRunInput, runId: string, host: string, repoPath: string): Promise<void> {
		if (this.setup === undefined || !this.container.running) {
			this.setup = this.setUp(input).catch((error) => {
				this.setup = undefined;
				throw error;
			});
		}
		await this.setup;
		// Credentials differ per run, so the intercepts are registered again (each replaces the earlier one).
		await this.container.interceptOutboundHttps(
			host,
			this.ctx.exports.ArtifactsGateway({
				props: { host, repoPath, secret: input.token, workItemId: input.workItemId, runId },
			}),
		);
		if (input.mode === "claude") {
			await this.container.interceptOutboundHttps("openrouter.ai", this.ctx.exports.ModelGateway({
					props: { model: input.model, workItemId: input.workItemId, runId, maxOutputTokens: input.limits.maxOutputTokens },
				}),);
		}
	}

	private async setUp(input: StartRunInput): Promise<void> {
		if (!this.container.running) {
			this.container.start({
				image: this.container.images.agent,
				instance: input.instance,
				// No direct egress: only the hosts intercepted per run are reachable.
				enableInternet: false,
			});
		}
		try {
			await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		} catch (error) {
			await this.container.destroy();
			throw error;
		}
	}

	private async runnerAlive(): Promise<boolean> {
		if ((await this.readCapped(PID_PATH, 256)) === undefined) {
			// The runner writes its pid right after it starts; before that, it is starting.
			return true;
		}
		return withDeadline("probing the runner", CONTAINER_IO_TIMEOUT_MS, async (signal) => {
			const probe = await this.container.exec(["/bin/sh", "-c", TASK_RUNNING_SCRIPT, "probe", PID_PATH], { signal });
			return (await probe.output()).exitCode === 0;
		});
	}

	/** Container events shifted onto the Durable Object's clock, validated, sanitized and redacted. */
	private async readActivity(run: Pick<RunRecord, "workItemId" | "clockSkewMs">): Promise<ActivityLine[]> {
		const raw = (await this.readCapped(EVENTS_PATH, MAX_EVENTS_BYTES)) ?? "";
		return parseActivity(raw, { workItemId: run.workItemId }).map((a) => ({
			...a,
			ts: new Date(Date.parse(a.ts) + run.clockSkewMs).toISOString(),
			text: redactText(a.text),
		}));
	}

	private async measureClockSkew(): Promise<number> {
		try {
			const before = Date.now();
			const out = await withDeadline("reading the container clock", CONTAINER_IO_TIMEOUT_MS, async (signal) => (await this.container.exec(["date", "-u", "+%s%3N"], { signal })).output());
			const after = Date.now();
			const containerMs = Number.parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
			return Number.isFinite(containerMs) ? Math.round((before + after) / 2 - containerMs) : 0;
		} catch {
			return 0;
		}
	}

	/** At most `maxBytes` of a container file as text; undefined when it doesn't exist. */
	private async readCapped(path: string, maxBytes: number): Promise<string | undefined> {
		try {
			return await withDeadline(`reading ${path}`, CONTAINER_IO_TIMEOUT_MS, async (signal) => readCappedText((await this.files.readFile(path, { signal })).body, maxBytes));
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
}
