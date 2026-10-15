import type { Context } from "hono";
import { redactText } from "../artifacts/tokens";
import { SCENARIO_NAME } from "./api";

// The opt-in public read-only view. `PUBLIC_READ_SCENARIOS` is a comma-separated list of cell names. For those
// cells, and only those, anyone may GET the three routes below without the bearer secret. Everything else under
// /api (every other method, every other route, every other cell, the WebSocket) still needs the secret.
//
// Why these three and not the others: each is a SELECT against the cell's own SQLite and nothing more. They do not
// poll, set an alarm, call Artifacts or the agent runtime, append to the ledger or seed anything (the cell's
// `snapshot`, `ledger` and `gate`; public-read.workerd.test.ts runs them against a counting Artifacts fake). Left
// closed on purpose: `/ledger/verify` (re-hashes the whole ledger on every call, and the console verifies in the
// browser), `/poller` (repo names and raw poller errors), `/dispatches`,
// `/context/:id` (reads a blob through Artifacts), `/ws` (arms the poller's alarm and relays live agent output),
// `/api/agents/runs/:id` (not scoped to a cell), `/api/repos/*`, `/api/cell/:name`, and everything in index.ts.

const PUBLIC_ROUTES: readonly RegExp[] = [
	/^\/api\/scenarios\/([a-z0-9][a-z0-9-]{0,39})\/state$/,
	/^\/api\/scenarios\/([a-z0-9][a-z0-9-]{0,39})\/ledger$/,
	/^\/api\/scenarios\/([a-z0-9][a-z0-9-]{0,39})\/work-items\/[A-Za-z0-9][A-Za-z0-9_-]*\/gate$/,
];

/** The cell names in `PUBLIC_READ_SCENARIOS`. Anything that is not a valid cell name is dropped, so a typo opens nothing. */
export function parsePublicScenarios(raw: string | undefined): ReadonlySet<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter((name) => SCENARIO_NAME.test(name)),
	);
}

/** Fails closed: true only for a GET whose whole path is one of the public routes of an allowlisted cell. */
export function isPublicRead(method: string, path: string, allowed: ReadonlySet<string>): boolean {
	if (method !== "GET" || allowed.size === 0) return false;
	for (const route of PUBLIC_ROUTES) {
		const match = route.exec(path);
		if (match) return allowed.has(match[1] as string);
	}
	return false;
}

const MODEL_KEY_RE = /\bsk-[A-Za-z0-9_-]{16,}/g;

/** Token-shaped strings, URL userinfo, the account id in a repo host, model keys, and the Worker's own secrets, in one string or in raw text. */
export function redactPublic(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
	let out = redactText(text).replace(MODEL_KEY_RE, "[redacted-key]");
	for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
	return out;
}

/**
 * Redact a JSON body by walking it and rewriting each string value on its own. Redacting the serialized text instead is
 * unsafe: the URL-credentials pattern can match from one JSON string into the next (`"see https://a.example","b":"ops@x"`)
 * and break the document. Object keys are redacted too, since agent claims can carry arbitrary keys.
 */
export function redactPublicJson(value: unknown, secrets: ReadonlyArray<string | undefined> = []): unknown {
	if (typeof value === "string") return redactPublic(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redactPublicJson(item, secrets));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactPublic(key, secrets), redactPublicJson(item, secrets)]));
	return value;
}

/** A JSON body gets the structure-preserving walk; any other body falls back to redacting its text. */
export function redactPublicBody(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return redactPublic(text, secrets);
	}
	return JSON.stringify(redactPublicJson(parsed, secrets));
}

/** Runs after the handler: rewrites the response body through `redactPublicBody` and marks it public and uncacheable. */
export async function redactPublicResponse(c: Context, secrets: ReadonlyArray<string | undefined>): Promise<void> {
	const response = c.res;
	const text = await response.text();
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");
	headers.set("Cache-Control", "no-store");
	headers.set("X-Delta-Access", "public-read");
	c.res = new Response(redactPublicBody(text, secrets), { status: response.status, statusText: response.statusText, headers });
}
