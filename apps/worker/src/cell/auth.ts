import type { MiddlewareHandler } from "hono";
import type { Actor } from "contracts";

// Who is calling, as far as the Worker can tell. There is one shared bearer secret and no user
// accounts (the console says "Acting as: ... (demo identity)"), so the secret maps to one human.
//
// Rules this file enforces:
//   - An actor is derived here, from the request's credential, and handed to the cell as an
//     argument. No route reads `actor` from a request body (bodies are strict, so a stray
//     `actor` field is a 400).
//   - Presenting the secret makes you the demo human. `X-Delta-Principal` can only NARROW that
//     (act as an agent or the system); it can never widen it. So a caller who lies in that header
//     gains nothing, and the agent runtime, which never holds the secret, cannot reach /api at all.

export const WS_PROTOCOL = "delta.v1";
const BEARER_PROTOCOL_PREFIX = "bearer.";

/**
 * The bearer secret from `Authorization: Bearer <secret>`, or, for browsers (whose WebSocket
 * cannot set headers), from `Sec-WebSocket-Protocol: delta.v1, bearer.<base64url(secret)>`. The
 * subprotocol form counts only on a WebSocket upgrade: nothing else has a reason to send it.
 * Returns "" when there is none.
 */
export function bearerFromRequest(request: Request): string {
	const header = request.headers.get("Authorization") ?? "";
	if (header.startsWith("Bearer ")) return header.slice("Bearer ".length);
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return "";
	for (const part of (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",")) {
		const protocol = part.trim();
		if (protocol.startsWith(BEARER_PROTOCOL_PREFIX)) return decodeBase64Url(protocol.slice(BEARER_PROTOCOL_PREFIX.length));
	}
	return "";
}

function decodeBase64Url(value: string): string {
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
		const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

/** The guard for everything under /api: the shared bearer secret. Fails closed when `DEV_TOKEN` is unset. */
export const bearerGuard: MiddlewareHandler<{ Bindings: { DEV_TOKEN?: string } }> = async (c, next) => {
	const expected = c.env.DEV_TOKEN;
	const given = bearerFromRequest(c.req.raw);
	if (!expected || !given || !(await safeEqual(given, expected))) {
		return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }, 401);
	}
	await next();
};

export type SessionEnv = { DEMO_ACTOR_ID?: string; DEMO_ACTOR_NAME?: string };

const PRINCIPAL = /^(agent|system):([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;

export type SessionResult = { ok: true; actor: Actor } | { ok: false; message: string };

/** The actor for a request that already passed the bearer guard. */
export function sessionActor(env: SessionEnv, request: Request): SessionResult {
	const principal = request.headers.get("X-Delta-Principal");
	if (principal !== null) {
		const match = PRINCIPAL.exec(principal);
		if (!match) return { ok: false, message: "X-Delta-Principal must look like agent:<id> or system:<id>" };
		const kind = match[1] as "agent" | "system";
		const id = match[2] as string;
		return { ok: true, actor: { kind, id, displayName: id } };
	}
	return {
		ok: true,
		actor: {
			kind: "human",
			id: env.DEMO_ACTOR_ID || "decision-owner",
			displayName: env.DEMO_ACTOR_NAME || "Decision owner (demo identity)",
		},
	};
}
