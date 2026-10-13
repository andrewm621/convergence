import { z } from "zod";
import { errorCode, getRepo } from "../artifacts/git-write";
import { DEFAULT_LIMITS, type RunLimits } from "./gateway-logic";
import { parseContextRecord } from "../../container/stub-agent-lib";
import { modelPrice } from "./model-prices";
import { AgentMode, ModelSlug, SandboxInstance, dispatchFingerprint, parseModelAllowlist, resolveModel, type DispatchRequest, type Revalidate } from "./protocol";
import type { AgentSandbox, RunRecord, StartOutcome } from "./sandbox";

const RUN_WAIT_MS = 150_000;

const AgentConfig = z.object({
	AGENT_MODE: AgentMode.default("stub"),
	AGENT_MODEL: ModelSlug.default("anthropic/claude-sonnet-5.5"),
	// Comma-separated OpenRouter slugs a dispatch may ask for. AGENT_MODEL is always allowed.
	AGENT_MODELS: z.string().default(""),
	STUB_STEP_MS: z.coerce.number().int().min(0).max(60_000).default(2500),
	SANDBOX_INSTANCE: SandboxInstance.default("lite"),
	// Hard caps for AGENT_MODE=claude: turns, dollars and wall clock.
	AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(100).default(15),
	AGENT_MAX_BUDGET_USD: z.coerce.number().positive().max(20).default(1),
	AGENT_TIMEOUT_S: z.coerce.number().int().min(30).max(3600).default(600),
	// Enforced by the gateways on every run, whatever flags the agent runs with.
	AGENT_MAX_MODEL_REQUESTS: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMITS.maxModelRequests),
	AGENT_MAX_GIT_REQUESTS: z.coerce.number().int().min(1).max(500).default(DEFAULT_LIMITS.maxGitRequests),
	AGENT_MAX_TOTAL_TOKENS: z.coerce.number().int().min(1000).max(20_000_000).default(DEFAULT_LIMITS.maxTotalTokens),
	AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(DEFAULT_LIMITS.maxOutputTokens),
	AGENT_MAX_COST_USD: z.coerce.number().positive().max(50).default(DEFAULT_LIMITS.maxCostUsd),
});

export interface AgentConfig {
	mode: AgentMode;
	/** The default model. */
	model: string;
	/** Every model a dispatch may select, default first. */
	models: string[];
	stubStepMs: number;
	instance: SandboxInstance;
	maxTurns: number;
	maxBudgetUsd: number;
	timeoutS: number;
	limits: RunLimits;
}

/** A dispatch problem with a stable code the API maps to an HTTP status. */
export class DispatchError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 422 | 500 | 503,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Read the AGENT_* vars. Invalid values fail loudly instead of silently running the wrong agent. */
export function readAgentConfig(env: Env): AgentConfig {
	const parsed = AgentConfig.safeParse({
		AGENT_MODE: env.AGENT_MODE,
		AGENT_MODEL: env.AGENT_MODEL,
		AGENT_MODELS: env.AGENT_MODELS,
		STUB_STEP_MS: env.STUB_STEP_MS,
		SANDBOX_INSTANCE: env.SANDBOX_INSTANCE,
		AGENT_MAX_TURNS: env.AGENT_MAX_TURNS,
		AGENT_MAX_BUDGET_USD: env.AGENT_MAX_BUDGET_USD,
		AGENT_TIMEOUT_S: env.AGENT_TIMEOUT_S,
		AGENT_MAX_MODEL_REQUESTS: env.AGENT_MAX_MODEL_REQUESTS,
		AGENT_MAX_GIT_REQUESTS: env.AGENT_MAX_GIT_REQUESTS,
		AGENT_MAX_TOTAL_TOKENS: env.AGENT_MAX_TOTAL_TOKENS,
		AGENT_MAX_OUTPUT_TOKENS: env.AGENT_MAX_OUTPUT_TOKENS,
		AGENT_MAX_COST_USD: env.AGENT_MAX_COST_USD,
	});
	if (!parsed.success) {
		throw new DispatchError(500, "AGENT_CONFIG_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
	}
	const c = parsed.data;
	let models: string[];
	try {
		models = parseModelAllowlist(c.AGENT_MODELS, c.AGENT_MODEL);
	} catch {
		throw new DispatchError(500, "AGENT_CONFIG_INVALID", "AGENT_MODELS must be comma-separated OpenRouter model slugs");
	}
	return {
		mode: c.AGENT_MODE,
		model: c.AGENT_MODEL,
		models,
		stubStepMs: c.STUB_STEP_MS,
		instance: c.SANDBOX_INSTANCE,
		maxTurns: c.AGENT_MAX_TURNS,
		maxBudgetUsd: c.AGENT_MAX_BUDGET_USD,
		timeoutS: c.AGENT_TIMEOUT_S,
		limits: {
			maxModelRequests: c.AGENT_MAX_MODEL_REQUESTS,
			maxGitRequests: c.AGENT_MAX_GIT_REQUESTS,
			maxTotalTokens: c.AGENT_MAX_TOTAL_TOKENS,
			maxOutputTokens: c.AGENT_MAX_OUTPUT_TOKENS,
			maxCostUsd: c.AGENT_MAX_COST_USD,
		},
	};
}

/** Shape returned to API callers: the two ledger-ready events plus the run's state. */
export function presentRun(run: RunRecord) {
	return {
		workItemId: run.workItemId,
		forkRepo: run.forkRepo,
		mode: run.mode,
		model: run.model,
		author: run.author,
		state: run.state,
		AgentRunStarted: { type: "AgentRunStarted", workItemId: run.workItemId, ts: run.startedAt },
		AgentRunFinished: run.finishedAt
			? { type: "AgentRunFinished", workItemId: run.workItemId, ts: run.finishedAt, outcome: run.state }
			: null,
		durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
		commit: run.commit,
		pushVerified: run.pushVerified,
		baseHead: run.baseHead,
		revalidation: run.revalidation,
		exitCode: run.exitCode,
		error: run.error,
		tokenRevoked: run.tokenRevoked,
		usage: run.usage,
		clockSkewMs: run.clockSkewMs,
		activity: run.activity,
	};
}

/** A revalidation's context files must be the versions it says it is delivering. Checked before a token is minted. */
export function checkRevalidationContext(revalidate: Revalidate): void {
	const delivered = new Map<string, number>();
	for (const [name, text] of Object.entries(revalidate.context)) {
		const record = parseContextRecord(text);
		if (!record) throw new DispatchError(400, "CONTEXT_INVALID", `${name} is not a valid context record`);
		delivered.set(record.id, record.version);
	}
	for (const change of revalidate.changes) {
		if (delivered.get(change.recordId) !== change.toVersion) {
			throw new DispatchError(
				400,
				"CONTEXT_MISMATCH",
				`context must include ${change.recordId} at version ${change.toVersion}`,
			);
		}
	}
}

/**
 * Start the agent for one work item on its fork. Mints a short-lived write token for that fork only;
 * the token goes to the outbound handler, never into the container, a URL or a log line.
 * The same Idempotency-Key with the same request returns the run it started, with no second token or run.
 */
export async function dispatchAgent(
	env: Env,
	req: DispatchRequest,
	idempotencyKey: string,
): Promise<{ httpStatus: 200 | 202; run: RunRecord }> {
	const cfg = readAgentConfig(env);
	if (req.revalidate) checkRevalidationContext(req.revalidate);
	if (cfg.mode === "claude" && !(env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY) {
		throw new DispatchError(503, "OPENROUTER_API_KEY_MISSING", "AGENT_MODE=claude needs the OPENROUTER_API_KEY secret");
	}

	const resolved = resolveModel(req.model, cfg.model, cfg.models);
	if (!resolved.ok) throw new DispatchError(400, "MODEL_NOT_ALLOWED", resolved.error);
	// Without a price there is no worst case to charge, so the gateway would refuse every call: say so up front.
	if (cfg.mode === "claude" && !modelPrice(resolved.model)) {
		throw new DispatchError(400, "MODEL_NOT_ALLOWED", `model ${resolved.model} has no entry in the price table, so its cost cannot be bounded`);
	}
	const fingerprint = await dispatchFingerprint({ ...req, model: resolved.model });
	const sandbox = env.AGENT_SANDBOX.getByName(req.workItemId);
	const seen = await sandbox.peekIdempotency(idempotencyKey, fingerprint);
	if (seen === "reused") {
		throw new DispatchError(422, "IDEMPOTENCY_KEY_REUSED", "that Idempotency-Key was used with a different request");
	}

	let run: RunRecord | null = null;
	if (seen === "replay") {
		run = await sandbox.readRun();
	}
	if (!run) run = await startNewRun(env, sandbox, req, { ...cfg, model: resolved.model }, idempotencyKey, fingerprint);

	if (req.wait && run.state === "running") run = (await sandbox.waitForRun(RUN_WAIT_MS)) ?? run;
	// Still running (not waiting, or the wait timed out): the caller polls GET /agents/runs/:id.
	return { httpStatus: run.state === "running" ? 202 : 200, run };
}

async function startNewRun(
	env: Env,
	sandbox: DurableObjectStub<AgentSandbox>,
	req: DispatchRequest,
	cfg: AgentConfig,
	idempotencyKey: string,
	fingerprint: string,
): Promise<RunRecord> {
	using repo = await getRepo(env, req.forkRepo).catch((e) => {
		if (errorCode(e) === "NOT_FOUND") throw new DispatchError(404, "FORK_NOT_FOUND", `no repo named ${req.forkRepo}`);
		throw e;
	});
	const info = await repo.info();
	// Agents write only to forks. A baseline has no source and must never receive an agent token.
	if (!info.source) throw new DispatchError(400, "NOT_A_FORK", `${req.forkRepo} is not a fork`);
	if (info.readOnly) throw new DispatchError(400, "FORK_READ_ONLY", `${req.forkRepo} is read-only`);

	const ttl = cfg.mode === "claude" ? 3600 : 900;
	const token = await repo.createToken("write", ttl);

	let started: StartOutcome;
	try {
		started = await sandbox.startRun({
			workItemId: req.workItemId,
			forkRepo: req.forkRepo,
			remote: info.remote,
			token: token.plaintext,
			tokenId: token.id,
			mode: cfg.mode,
			model: cfg.model,
			prompt: req.prompt,
			stubStepMs: cfg.stubStepMs,
			instance: cfg.instance,
			maxTurns: cfg.maxTurns,
			maxBudgetUsd: cfg.maxBudgetUsd,
			timeoutS: cfg.timeoutS,
			limits: cfg.limits,
			idempotencyKey,
			fingerprint,
			revalidate: req.revalidate,
		});
	} catch (e) {
		await repo.revokeToken(token.id).catch(() => false);
		throw e;
	}
	// Anything but a fresh start means the minted token went unused.
	if (started.status !== "started") await repo.revokeToken(token.id).catch(() => false);
	if (started.status === "busy") {
		throw new DispatchError(409, "RUN_IN_PROGRESS", `work item ${req.workItemId} already has a run in flight`);
	}
	if (started.status === "key_reused") {
		throw new DispatchError(422, "IDEMPOTENCY_KEY_REUSED", "that Idempotency-Key was used with a different request");
	}
	if (!started.run) throw new Error("run missing after start");
	return started.run;
}
