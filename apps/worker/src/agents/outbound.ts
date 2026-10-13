import { WorkerEntrypoint } from "cloudflare:workers";
import { stripExpiry } from "../artifacts/tokens";
import {
	MAX_GIT_BODY_BYTES,
	MAX_MODEL_BODY_BYTES,
	UsageTracker,
	allowGitCredential,
	allowModelCredential,
	forwardModelHeaders,
	limitStream,
	prepareModelBody,
	settleModelCall,
	tapUsage,
	worstCaseCostUsd,
} from "./gateway-logic";
import { modelPrice } from "./model-prices";

// Outbound handlers for the agent container. They run in the Worker, outside the sandbox, so the
// credentials they add are never in the container's environment, files or process list.
//
// The container is not trusted with anything, including its own budget. Each gateway:
//   1. matches the request in one canonical form (see gateway-logic.ts) and adds a credential only on an exact match;
//   2. caps the body size;
//   3. asks the run's AgentSandbox Durable Object to admit the request against the run's meter (request counts and,
//      for the model, a token ceiling), and reports the real usage afterwards.
// Redirects are never followed with a credential attached (`redirect: "manual"`): a 3xx goes back to the container,
// whose next request comes through this same check.

type Env_ = Env;

export interface ArtifactsGatewayProps {
	/** Git host of the fork, e.g. the account's artifacts.cloudflare.net host. */
	host: string;
	/** Path of the fork on that host, e.g. `/git/<namespace>/<repo>.git`. */
	repoPath: string;
	/** The fork's short-lived write token (may carry `?expires=`). */
	secret: string;
	workItemId: string;
	runId: string;
}

/**
 * Adds the fork's token to git smart-HTTP requests for that one repo and refuses everything else.
 * Reached through `ctx.exports.ArtifactsGateway({ props })` from the AgentSandbox Durable Object.
 */
export class ArtifactsGateway extends WorkerEntrypoint<Env_, ArtifactsGatewayProps> {
	override async fetch(request: Request): Promise<Response> {
		const { host, repoPath, secret, workItemId, runId } = this.ctx.props;
		if (!allowGitCredential(request.method, request.url, host, repoPath)) return new Response("Forbidden", { status: 403 });

		const declared = request.headers.get("content-length");
		if (declared !== null && !(Number(declared) <= MAX_GIT_BODY_BYTES)) return new Response("Request too large", { status: 413 });

		const admission = await this.env.AGENT_SANDBOX.getByName(workItemId).admitRequest(runId, { kind: "git" });
		if (!admission.ok) return new Response(admission.reason, { status: admission.status });

		const headers = new Headers(request.headers);
		headers.set("Authorization", `Basic ${btoa(`x:${stripExpiry(secret)}`)}`);
		// A body with no declared length is counted as it streams, so it can't exceed the cap by omitting the header.
		const body = request.body && declared === null ? limitStream(request.body, MAX_GIT_BODY_BYTES) : request.body;
		return fetch(new Request(request.url, { method: request.method, headers, body, redirect: "manual", ...(body ? { duplex: "half" } : {}) } as RequestInit));
	}
}

export interface ModelGatewayProps {
	/** The one model this run is pinned to (the dispatched model). */
	model: string;
	workItemId: string;
	runId: string;
	/** Ceiling on a single request's max_tokens. */
	maxOutputTokens: number;
}

function modelError(status: number, message: string): Response {
	return Response.json({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "invalid_request_error", message } }, { status });
}

/** The one upstream URL the model key is ever sent to; the container's own URL (and its query) is never forwarded. */
const MODEL_UPSTREAM_URL = "https://openrouter.ai/api/v1/messages";

/**
 * Model access for AGENT_MODE=claude: forwards Anthropic Messages calls to OpenRouter with the Worker's key,
 * only for the run's pinned model, with max_tokens clamped and only whitelisted body fields and headers passed on,
 * and only while the run's meter admits it. Claude Code holds a placeholder credential, replaced here.
 *
 * Every admitted call is settled exactly once, whatever happens to it: real usage when the response was a clean 2xx
 * with complete usage, the priced worst case otherwise (non-2xx, no usage, truncated or aborted stream, a failed
 * fetch). A call is never forwarded unless the meter admitted it, and the meter refuses a run it doesn't know.
 */
export class ModelGateway extends WorkerEntrypoint<Env_, ModelGatewayProps> {
	override async fetch(request: Request): Promise<Response> {
		const { model, workItemId, runId, maxOutputTokens } = this.ctx.props;
		const key = (this.env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
		const price = modelPrice(model);
		if (!key || !price || !allowModelCredential(request.method, request.url)) return new Response("Forbidden", { status: 403 });

		const declared = request.headers.get("content-length");
		if (declared !== null && !(Number(declared) <= MAX_MODEL_BODY_BYTES)) return modelError(413, "request too large");
		const raw = await request.arrayBuffer();
		if (raw.byteLength > MAX_MODEL_BODY_BYTES) return modelError(413, "request too large");

		const prep = prepareModelBody(new TextDecoder().decode(raw), raw.byteLength, model, maxOutputTokens);
		if (!prep.ok) return modelError(prep.status, prep.reason);

		const sandbox = this.env.AGENT_SANDBOX.getByName(workItemId);
		const requestId = crypto.randomUUID();
		const reserveTokens = prep.estInputTokens + prep.maxTokens;
		const reserveCostUsd = worstCaseCostUsd(price, prep.worstInputTokens, prep.maxTokens);
		// Reserve before forwarding. If the meter can't be reached, or doesn't know this run, nothing is forwarded.
		let admission: Awaited<ReturnType<typeof sandbox.admitRequest>>;
		try {
			admission = await sandbox.admitRequest(runId, { kind: "model", requestId, reserveTokens, reserveCostUsd });
		} catch {
			return modelError(503, "run meter unavailable");
		}
		if (!admission.ok) return modelError(admission.status, admission.reason);

		// From here the call holds a reservation, so it must be settled on every path.
		let settled = false;
		const settle = (outcome: "end" | "aborted", upstreamOk: boolean, tracker?: UsageTracker) => {
			if (settled) return;
			settled = true;
			const charge = settleModelCall({
				upstreamOk,
				outcome,
				seen: tracker?.result() ?? null,
				worstInputTokens: prep.worstInputTokens,
				maxTokens: prep.maxTokens,
				price,
			});
			this.ctx.waitUntil(reportUsage(sandbox, runId, { requestId, ...charge }));
		};

		const headers = forwardModelHeaders(request.headers);
		headers.set("Authorization", `Bearer ${key}`);
		let upstream: Response;
		try {
			upstream = await fetch(new Request(MODEL_UPSTREAM_URL, { method: "POST", headers, body: prep.body, redirect: "manual" }));
		} catch {
			settle("aborted", false);
			return modelError(502, "upstream unavailable");
		}

		const tracker = new UsageTracker();
		if (!upstream.body) {
			settle("end", upstream.ok, tracker);
			return upstream;
		}
		return new Response(
			tapUsage(upstream.body, tracker, (outcome) => settle(outcome, upstream.ok, tracker)),
			upstream,
		);
	}
}

type Sandbox = ReturnType<Env_["AGENT_SANDBOX"]["getByName"]>;

/** Report a settled call to the run's meter; one retry, because a lost report would leave the call charged only at the run's end. */
async function reportUsage(sandbox: Sandbox, runId: string, usage: { requestId: string; input: number; output: number; cost: number }): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await sandbox.recordModelUsage(runId, usage);
			return;
		} catch {
			// Retry once; the run's end charges anything still unsettled at its reserved worst case.
		}
	}
}
