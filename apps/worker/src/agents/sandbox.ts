import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { errorCode } from "../artifacts/git-write";
import { redactText } from "../artifacts/tokens";
import {
	authorFor,
	buildAgentPrompt,
	claudeEnv,
	commitSubject,
	parseActivity,
	pushedCommit,
	remoteParts,
	type ActivityLine,
	type AgentMode,
	type SandboxInstance,
} from "./protocol";

// One Durable Object per work item, each owning one container. It clones the work item's fork, runs the
// agent, and the in-container runner commits as the work item and pushes. Pattern follows Cloudflare's
// "Build a coding agent runner" tutorial: no direct internet, outbound handlers for the two hosts the
// run needs, and the task runs in the background with its state in files so a request can end safely.

const REPO_DIR = "/workspace/repo";
const TASK_DIR = "/workspace/task";
const EVENTS_PATH = `${TASK_DIR}/events.jsonl`;
const STDERR_PATH = `${TASK_DIR}/stderr.log`;
const EXIT_CODE_PATH = `${TASK_DIR}/exit-code`;
const PID_PATH = `${TASK_DIR}/pid`;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const ALARM_INTERVAL_MS = 3_000;
const RUN_KEY = "run";

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
}

export type RunState = "running" | "succeeded" | "failed" | "lost" | "none";

export interface RunRecord {
	workItemId: string;
	forkRepo: string;
	mode: AgentMode;
	author: string;
	tokenId: string;
	state: RunState;
	/** AgentRunStarted: when the Durable Object launched the runner. */
	startedAt: string;
	/** AgentRunFinished: when the Durable Object first observed the runner had exited. */
	finishedAt: string | null;
	exitCode: number | null;
	error: string | null;
	commit: string | null;
	tokenRevoked: boolean | null;
	/** DO clock minus container clock when the run started. The container clock runs several seconds behind. */
	clockSkewMs: number;
	activity: ActivityLine[];
}

export class AgentSandbox extends DurableObject<Env> {
	private readonly container: Container;
	private readonly files: Files;
	private setup: Promise<void> | undefined;
	private refreshing: Promise<RunRecord | null> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (!ctx.container) throw new Error("The container binding is not configured");
		this.container = ctx.container;
		this.files = new Files(ctx.container);
		if (this.container.running) {
			void ctx.blockConcurrencyWhile(() => this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
		}
	}

	/** Start a run in the background. Returns the record (state `running`) or `busy` when one is in flight. */
	async startRun(input: StartRunInput): Promise<{ status: "started" | "busy"; run: RunRecord }> {
		const current = await this.refresh();
		if (current?.state === "running") return { status: "busy", run: current };

		const author = authorFor(input.workItemId);
		const { host, path } = remoteParts(input.remote);

		await this.startContainer(input, host, path);
		await this.files.remove(REPO_DIR, { recursive: true, force: true });
		await this.files.remove(TASK_DIR, { recursive: true, force: true });
		await this.files.mkdir(TASK_DIR, { recursive: true });

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
			COMMIT_SUBJECT: commitSubject(input.workItemId, input.prompt),
			AGENT_PROMPT: input.mode === "claude" ? buildAgentPrompt(input.workItemId, input.prompt) : input.prompt,
			STUB_STEP_MS: String(input.stubStepMs),
			REPO_DIR,
			EVENTS_FILE: EVENTS_PATH,
			...(input.mode === "claude" ? claudeEnv(input.model) : {}),
		};

		const clockSkewMs = await this.measureClockSkew();
		const startedAt = new Date().toISOString();
		await this.container.exec(["/bin/sh", "-c", TASK_SCRIPT, "agent", TASK_DIR, "/opt/delta/run-agent.sh"], {
			cwd: "/workspace",
			env,
			stdout: "ignore",
			stderr: "ignore",
		});

		const run: RunRecord = {
			workItemId: input.workItemId,
			forkRepo: input.forkRepo,
			mode: input.mode,
			author: author.name,
			tokenId: input.tokenId,
			state: "running",
			startedAt,
			finishedAt: null,
			exitCode: null,
			error: null,
			commit: null,
			tokenRevoked: null,
			clockSkewMs,
			activity: [],
		};
		this.ctx.storage.kv.put(RUN_KEY, run);
		await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
		return { status: "started", run };
	}

	/** Current record, refreshed from the container while a run is in flight. */
	async readRun(): Promise<RunRecord | null> {
		return this.refresh();
	}

	/** Hold until the run ends (or `timeoutMs`), then return the record. */
	async waitForRun(timeoutMs: number): Promise<RunRecord | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const run = await this.refresh();
			if (!run || run.state !== "running" || Date.now() >= deadline) return run;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
	}

	override async alarm(): Promise<void> {
		const run = await this.refresh();
		if (run?.state === "running") await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
	}

	// ---- internals ----

	private storedRun(): RunRecord | null {
		return (this.ctx.storage.kv.get(RUN_KEY) as RunRecord | undefined) ?? null;
	}

	/** Single-flight: the alarm and a waiting request must not both finalize the same run. */
	private refresh(): Promise<RunRecord | null> {
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async doRefresh(): Promise<RunRecord | null> {
		const run = this.storedRun();
		if (!run || run.state !== "running") return run;

		let exitCode: number | null = null;
		if (!this.container.running) {
			return this.finish(run, { state: "lost", exitCode: null, error: "container stopped before the runner recorded an exit code" });
		}
		const exitText = await this.readOptionalText(EXIT_CODE_PATH);
		if (exitText !== undefined) exitCode = Number.parseInt(exitText, 10);
		if (exitCode === null) {
			const alive = await this.runnerAlive();
			if (alive) {
				// Keep the live tail fresh for GET /runs/:id while the run is in flight.
				return { ...run, activity: await this.readActivity(run.clockSkewMs) };
			}
			// It may have exited between the two reads.
			const late = await this.readOptionalText(EXIT_CODE_PATH);
			if (late === undefined) {
				return this.finish(run, { state: "lost", exitCode: null, error: "runner exited without recording an exit code" });
			}
			exitCode = Number.parseInt(late, 10);
		}
		if (exitCode === 0) return this.finish(run, { state: "succeeded", exitCode, error: null });
		const stderr = (await this.readOptionalText(STDERR_PATH)) ?? "";
		return this.finish(run, { state: "failed", exitCode, error: redactText(stderr.slice(-1500)) || `runner exited ${exitCode}` });
	}

	private async finish(
		run: RunRecord,
		outcome: { state: Exclude<RunState, "running" | "none">; exitCode: number | null; error: string | null },
	): Promise<RunRecord> {
		const finishedAt = new Date().toISOString();
		const activity = this.container.running ? await this.readActivity(run.clockSkewMs) : run.activity;
		const tokenRevoked = await this.revokeToken(run.forkRepo, run.tokenId);
		const done: RunRecord = {
			...run,
			...outcome,
			finishedAt,
			commit: pushedCommit(activity),
			tokenRevoked,
			activity,
		};
		this.ctx.storage.kv.put(RUN_KEY, done);
		// The run's output is stored above; free the container. The next dispatch starts a fresh one.
		if (this.container.running) await this.container.destroy().catch(() => undefined);
		this.setup = undefined;
		return done;
	}

	private async revokeToken(forkRepo: string, tokenId: string): Promise<boolean> {
		try {
			using repo = await this.env.ARTIFACTS.get(forkRepo);
			return await repo.revokeToken(tokenId);
		} catch (e) {
			console.error(`token revoke failed for ${forkRepo}: ${errorCode(e) ?? "error"}`);
			return false;
		}
	}

	private async startContainer(input: StartRunInput, host: string, repoPath: string): Promise<void> {
		if (this.setup === undefined || !this.container.running) {
			this.setup = this.setUp(input).catch((error) => {
				this.setup = undefined;
				throw error;
			});
		}
		await this.setup;
		// The token differs per run, so the git intercept is registered again (it replaces the earlier one).
		await this.container.interceptOutboundHttps(
			host,
			this.ctx.exports.ArtifactsGateway({ props: { host, repoPath, secret: input.token } }),
		);
	}

	private async setUp(input: StartRunInput): Promise<void> {
		if (!this.container.running) {
			this.container.start({
				image: this.container.images.agent,
				instance: input.instance,
				// No direct egress: only the hosts intercepted below are reachable.
				enableInternet: false,
			});
		}
		try {
			if (input.mode === "claude") {
				await this.container.interceptOutboundHttps("openrouter.ai", this.ctx.exports.ModelGateway({ props: {} }));
			}
			await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		} catch (error) {
			await this.container.destroy();
			throw error;
		}
	}

	private async runnerAlive(): Promise<boolean> {
		if ((await this.readOptionalText(PID_PATH)) === undefined) {
			// The runner writes its pid right after it starts; before that, it is starting.
			return true;
		}
		const probe = await this.container.exec(["/bin/sh", "-c", TASK_RUNNING_SCRIPT, "probe", PID_PATH]);
		return (await probe.output()).exitCode === 0;
	}

	/** Container events shifted onto the Durable Object's clock, so they order correctly against AgentRun* events. */
	private async readActivity(skewMs: number): Promise<ActivityLine[]> {
		return parseActivity((await this.readOptionalText(EVENTS_PATH)) ?? "").map((a) => {
			const t = Date.parse(a.ts);
			return Number.isNaN(t) ? a : { ...a, ts: new Date(t + skewMs).toISOString() };
		});
	}

	private async measureClockSkew(): Promise<number> {
		try {
			const before = Date.now();
			const out = await (await this.container.exec(["date", "-u", "+%s%3N"])).output();
			const after = Date.now();
			const containerMs = Number.parseInt(new TextDecoder().decode(out.stdout).trim(), 10);
			return Number.isFinite(containerMs) ? Math.round((before + after) / 2 - containerMs) : 0;
		} catch {
			return 0;
		}
	}

	private async readOptionalText(path: string): Promise<string | undefined> {
		try {
			return await (await this.files.readFile(path)).text();
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
}
