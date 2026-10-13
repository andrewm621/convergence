import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { errorCode } from "../artifacts/git-write";
import { redactText } from "../artifacts/tokens";
import {
	authorFor,
	buildAgentPrompt,
	buildRevalidationPrompt,
	claimedPushSha,
	claudeEnv,
	commitSubject,
	parseActivity,
	parseExitCode,
	readCappedText,
	remoteParts,
	sanitizeText,
	verifyPush,
	MAX_EVENTS_BYTES,
	type ActivityLine,
	type AgentMode,
	type PushVerdict,
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
const STDERR_READ_BYTES = 64 * 1024;
const RUN_KEY = "run";
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
	/** Caller's Idempotency-Key and the fingerprint of the request it was first used with. */
	idempotencyKey: string;
	fingerprint: string;
	/** Diff-aware re-run on the same fork. */
	revalidate?: Revalidate;
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
	/** The fork head this run produced, only ever set from the fork's real history. */
	commit: string | null;
	/** True when the fork's history agreed with the run's outcome; false when it contradicted it; null when not checked. */
	pushVerified: boolean | null;
	/** Fork head before the run started (read through the binding). */
	baseHead: string | null;
	tokenRevoked: boolean | null;
	/** Present on a revalidation run: which decisions changed. */
	revalidation: Revalidate["changes"] | null;
	/** DO clock minus container clock when the run started. The container clock can run seconds behind. */
	clockSkewMs: number;
	/** Agent-reported activity: display only, never evidence. */
	activity: ActivityLine[];
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
			if (run) return { status: "replay", run: (await this.refresh()) ?? run };
		}
		if (this.starting) return { status: "busy", run: this.storedRun() };
		this.starting = true;
		try {
			const current = await this.refresh();
			if (current?.state === "running") return { status: "busy", run: current };
			return { status: "started", run: await this.launch(input) };
		} finally {
			this.starting = false;
		}
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

	// ---- launching ----

	private async launch(input: StartRunInput): Promise<RunRecord> {
		const author = authorFor(input.workItemId);
		const { host, path } = remoteParts(input.remote);

		// Record the run as `running` and the key as used before touching the container.
		const provisional: RunRecord = {
			workItemId: input.workItemId,
			forkRepo: input.forkRepo,
			mode: input.mode,
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
			clockSkewMs: 0,
			activity: [],
		};
		this.ctx.storage.kv.put(RUN_KEY, provisional);
		this.rememberKey({ key: input.idempotencyKey, fingerprint: input.fingerprint });

		try {
			const baseHead = await this.readForkHead(input.forkRepo);
			await this.startContainer(input, host, path);
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
				? `revalidate ${input.revalidate.changes.map((c) => `${c.recordId} v${c.fromVersion}->v${c.toVersion}`).join(", ")}`
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

			const run: RunRecord = { ...provisional, startedAt, baseHead, clockSkewMs };
			this.ctx.storage.kv.put(RUN_KEY, run);
			await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
			return run;
		} catch (e) {
			// The run never launched: close the record, free the key so the caller can retry, and let the caller revoke the token.
			this.forgetKey(input.idempotencyKey);
			this.ctx.storage.kv.put(RUN_KEY, {
				...provisional,
				state: "failed",
				finishedAt: new Date().toISOString(),
				error: redactText(e instanceof Error ? e.message : String(e)).slice(0, 500),
			} satisfies RunRecord);
			if (this.container.running) await this.container.destroy().catch(() => undefined);
			this.setup = undefined;
			throw e;
		}
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
		// Still launching: the container isn't ready to be inspected yet.
		if (this.starting) return run;

		if (Date.now() - Date.parse(run.startedAt) > RUN_TIMEOUT_MS) {
			return this.finish(run, { state: "failed", exitCode: null, error: "run exceeded the time limit" });
		}
		if (!this.container.running) {
			return this.finish(run, { state: "lost", exitCode: null, error: "container stopped before the runner recorded an exit code" });
		}

		let exitCode = parseExitCode(await this.readCapped(EXIT_CODE_PATH, 32));
		if (exitCode === null) {
			if (await this.runnerAlive()) {
				// Keep the live tail fresh, and persisted in case the container disappears.
				const live = { ...run, activity: await this.readActivity(run) };
				this.ctx.storage.kv.put(RUN_KEY, live);
				return live;
			}
			// It may have exited between the two reads.
			exitCode = parseExitCode(await this.readCapped(EXIT_CODE_PATH, 32));
			if (exitCode === null) {
				return this.finish(run, { state: "lost", exitCode: null, error: "runner exited without a valid exit code" });
			}
		}
		if (exitCode === 0) return this.finish(run, { state: "succeeded", exitCode, error: null });
		const stderr = (await this.readCapped(STDERR_PATH, STDERR_READ_BYTES)) ?? "";
		return this.finish(run, {
			state: "failed",
			exitCode,
			error: redactText(sanitizeText(stderr.slice(-1500), 1500)) || `runner exited ${exitCode}`,
		});
	}

	private async finish(
		run: RunRecord,
		outcome: { state: Exclude<RunState, "running" | "none">; exitCode: number | null; error: string | null },
	): Promise<RunRecord> {
		const finishedAt = new Date().toISOString();
		const activity = this.container.running ? await this.readActivity(run) : run.activity;

		let { state, error } = outcome;
		let commit: string | null = null;
		let pushVerified: boolean | null = null;
		if (outcome.state === "succeeded") {
			// The runner says it succeeded. Believe it only if the fork's real history agrees.
			const verdict = await this.verifyFork(run, claimedPushSha(activity));
			pushVerified = verdict.ok;
			if (verdict.ok) commit = verdict.commit;
			else {
				state = "failed";
				error = verdict.error;
			}
		}

		const tokenRevoked = await this.revokeToken(run.forkRepo, run.tokenId);
		const done: RunRecord = { ...run, state, error, exitCode: outcome.exitCode, finishedAt, commit, pushVerified, tokenRevoked, activity };
		this.ctx.storage.kv.put(RUN_KEY, done);
		// The run's output is stored above; free the container. The next dispatch starts a fresh one.
		if (this.container.running) await this.container.destroy().catch(() => undefined);
		this.setup = undefined;
		return done;
	}

	private async verifyFork(run: RunRecord, claimedSha: string | null): Promise<PushVerdict> {
		try {
			using repo = await this.env.ARTIFACTS.get(run.forkRepo);
			const log = await repo.log({ ref: "main", limit: 10 });
			return verifyPush({
				baseHead: run.baseHead,
				recent: log.map((m) => ({ hash: m.hash, author: m.author.name })),
				expectedAuthor: run.author,
				claimedSha,
			});
		} catch (e) {
			return { ok: false, error: `could not verify the push: ${errorCode(e) ?? "error"}` };
		}
	}

	private async readForkHead(forkRepo: string): Promise<string | null> {
		using repo = await this.env.ARTIFACTS.get(forkRepo);
		return (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? null;
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

	// ---- container plumbing ----

	private async startContainer(input: StartRunInput, host: string, repoPath: string): Promise<void> {
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
			this.ctx.exports.ArtifactsGateway({ props: { host, repoPath, secret: input.token } }),
		);
		if (input.mode === "claude") {
			await this.container.interceptOutboundHttps("openrouter.ai", this.ctx.exports.ModelGateway({ props: { model: input.model } }));
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
		const probe = await this.container.exec(["/bin/sh", "-c", TASK_RUNNING_SCRIPT, "probe", PID_PATH]);
		return (await probe.output()).exitCode === 0;
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
			const out = await (await this.container.exec(["date", "-u", "+%s%3N"])).output();
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
			return await readCappedText((await this.files.readFile(path)).body, maxBytes);
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
}
