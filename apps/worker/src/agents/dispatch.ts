import { z } from "zod";
import { errorCode, getRepo } from "../artifacts/git-write";
import { AgentMode, SandboxInstance, type DispatchRequest } from "./protocol";
import type { RunRecord } from "./sandbox";

const RUN_WAIT_MS = 150_000;

const AgentConfig = z.object({
	AGENT_MODE: AgentMode.default("stub"),
	AGENT_MODEL: z.string().min(1).default("anthropic/claude-sonnet-5.5"),
	STUB_STEP_MS: z.coerce.number().int().min(0).max(60_000).default(2500),
	SANDBOX_INSTANCE: SandboxInstance.default("lite"),
});

export interface AgentConfig {
	mode: AgentMode;
	model: string;
	stubStepMs: number;
	instance: SandboxInstance;
}

/** A dispatch problem with a stable code the API maps to an HTTP status. */
export class DispatchError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 500 | 503,
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
		STUB_STEP_MS: env.STUB_STEP_MS,
		SANDBOX_INSTANCE: env.SANDBOX_INSTANCE,
	});
	if (!parsed.success) {
		throw new DispatchError(500, "AGENT_CONFIG_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
	}
	const c = parsed.data;
	return { mode: c.AGENT_MODE, model: c.AGENT_MODEL, stubStepMs: c.STUB_STEP_MS, instance: c.SANDBOX_INSTANCE };
}

/** Shape returned to API callers: the two ledger-ready events plus the run's state. */
export function presentRun(run: RunRecord) {
	return {
		workItemId: run.workItemId,
		forkRepo: run.forkRepo,
		mode: run.mode,
		author: run.author,
		state: run.state,
		AgentRunStarted: { type: "AgentRunStarted", workItemId: run.workItemId, ts: run.startedAt },
		AgentRunFinished: run.finishedAt
			? { type: "AgentRunFinished", workItemId: run.workItemId, ts: run.finishedAt, outcome: run.state }
			: null,
		durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null,
		commit: run.commit,
		exitCode: run.exitCode,
		error: run.error,
		tokenRevoked: run.tokenRevoked,
		clockSkewMs: run.clockSkewMs,
		activity: run.activity,
	};
}

/**
 * Start the agent for one work item on its fork. Mints a short-lived write token for that fork only;
 * the token goes to the outbound handler, never into the container, a URL or a log line.
 */
export async function dispatchAgent(env: Env, req: DispatchRequest): Promise<{ httpStatus: 200 | 202; run: RunRecord }> {
	const cfg = readAgentConfig(env);
	if (cfg.mode === "claude" && !(env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY) {
		throw new DispatchError(503, "OPENROUTER_API_KEY_MISSING", "AGENT_MODE=claude needs the OPENROUTER_API_KEY secret");
	}

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

	const sandbox = env.AGENT_SANDBOX.getByName(req.workItemId);
	let started: Awaited<ReturnType<typeof sandbox.startRun>>;
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
		});
	} catch (e) {
		await repo.revokeToken(token.id).catch(() => false);
		throw e;
	}
	if (started.status === "busy") {
		await repo.revokeToken(token.id).catch(() => false);
		throw new DispatchError(409, "RUN_IN_PROGRESS", `work item ${req.workItemId} already has a run in flight`);
	}

	if (!req.wait) return { httpStatus: 202, run: started.run };
	const finished = await sandbox.waitForRun(RUN_WAIT_MS);
	return { httpStatus: 200, run: finished ?? started.run };
}
