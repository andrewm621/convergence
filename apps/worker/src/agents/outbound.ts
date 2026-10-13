import { WorkerEntrypoint } from "cloudflare:workers";
import { stripExpiry } from "../artifacts/tokens";
import { isRepoGitRequest } from "./protocol";

// Outbound handlers for the agent container. They run in the Worker, outside the sandbox, so the
// credentials they add are never in the container's environment, files or process list.

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
		const url = new URL(request.url);
		if (url.protocol !== "https:" || url.hostname !== host || !isRepoGitRequest(request.method, url, repoPath)) {
			return new Response("Forbidden", { status: 403 });
		}
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Basic ${btoa(`x:${stripExpiry(secret)}`)}`);
		return fetch(new Request(request, { headers }));
	}
}

/**
 * Model access for AGENT_MODE=claude: forwards to OpenRouter's Anthropic-compatible endpoint with the
 * Worker's key. Claude Code only holds a placeholder, which is replaced here.
 */
export class ModelGateway extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const key = (this.env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
		if (url.protocol !== "https:" || url.hostname !== "openrouter.ai" || !url.pathname.startsWith("/api/") || !key) {
			return new Response("Forbidden", { status: 403 });
		}
		const headers = new Headers(request.headers);
		headers.delete("x-api-key");
		headers.set("Authorization", `Bearer ${key}`);
		return fetch(new Request(request, { headers }));
	}
}
