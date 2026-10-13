import { WorkerEntrypoint } from "cloudflare:workers";
import { stripExpiry } from "../artifacts/tokens";
import { MAX_MODEL_BODY_BYTES, allowGitCredential, allowModelCredential, requestedModel } from "./protocol";

// Outbound handlers for the agent container. They run in the Worker, outside the sandbox, so the
// credentials they add are never in the container's environment, files or process list.
//
// A credential is added only when the request matches exactly (method, host, port, path and, for the model,
// the pinned model name). Everything else gets a 403 with nothing added. Both handlers use `redirect: "manual"`
// so a 3xx from upstream is handed back to the container instead of being followed with the credential on it;
// the container's next request comes back through this same check.

export interface ArtifactsGatewayProps {
	/** Git host of the fork, e.g. the account's artifacts.cloudflare.net host. */
	host: string;
	/** Path of the fork on that host, e.g. `/git/<namespace>/<repo>.git`. */
	repoPath: string;
	/** The fork's short-lived write token (may carry `?expires=`). */
	secret: string;
}

/**
 * Adds the fork's token to git smart-HTTP requests for that one repo and refuses everything else.
 * Reached through `ctx.exports.ArtifactsGateway({ props })` from the AgentSandbox Durable Object.
 */
export class ArtifactsGateway extends WorkerEntrypoint<Env, ArtifactsGatewayProps> {
	override async fetch(request: Request): Promise<Response> {
		const { host, repoPath, secret } = this.ctx.props;
		if (!allowGitCredential(request.method, new URL(request.url), host, repoPath)) {
			return new Response("Forbidden", { status: 403 });
		}
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Basic ${btoa(`x:${stripExpiry(secret)}`)}`);
		return fetch(new Request(request, { headers, redirect: "manual" }));
	}
}

export interface ModelGatewayProps {
	/** The one model the run is pinned to (AGENT_MODEL). */
	model: string;
}

/**
 * Model access for AGENT_MODE=claude: forwards Anthropic Messages calls to OpenRouter with the Worker's key,
 * and only when the request body names the pinned model. Claude Code holds a placeholder, replaced here.
 */
export class ModelGateway extends WorkerEntrypoint<Env, ModelGatewayProps> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const key = (this.env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
		if (!key || !allowModelCredential(request.method, url)) return new Response("Forbidden", { status: 403 });

		const declared = Number(request.headers.get("content-length") ?? 0);
		if (declared > MAX_MODEL_BODY_BYTES) return new Response("Request too large", { status: 413 });
		const body = await request.arrayBuffer();
		if (body.byteLength > MAX_MODEL_BODY_BYTES) return new Response("Request too large", { status: 413 });
		if (requestedModel(new TextDecoder().decode(body)) !== this.ctx.props.model) {
			return new Response("Model not allowed", { status: 403 });
		}

		const headers = new Headers(request.headers);
		headers.delete("x-api-key");
		headers.set("Authorization", `Bearer ${key}`);
		return fetch(new Request(url, { method: "POST", headers, body, redirect: "manual" }));
	}
}
