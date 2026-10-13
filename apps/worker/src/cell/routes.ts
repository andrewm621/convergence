import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { WorkItemId, type Actor } from "contracts";
import { IDEMPOTENCY_KEY, SCENARIO_NAME, failure, type CellResult } from "./api";
import { sessionActor } from "./auth";

// The cell's HTTP API. Mounted under /api, so the bearer guard in index.ts already ran. This layer
// does four things and nothing else: validate the shape of the request, derive the actor from the
// session, require an Idempotency-Key on every mutation, and hand the work to the scenario's
// WorkspaceCell. Rules live in delta-core; state lives in the cell.

type Vars = { actor: Actor; scenario: string };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export const cellApi = new Hono<{ Bindings: Env; Variables: Vars }>();

cellApi.use("/scenarios/:scenario/*", async (c, next) => {
	const scenario = c.req.param("scenario");
	if (!SCENARIO_NAME.test(scenario)) return c.json(failure(400, "INVALID_SCENARIO", "scenario must be 1-40 lowercase letters, digits or hyphens").body, 400);
	const session = sessionActor(c.env, c.req.raw);
	if (!session.ok) return c.json(failure(400, "INVALID_PRINCIPAL", session.message).body, 400);
	c.set("actor", session.actor);
	c.set("scenario", scenario);
	await next();
});

const jsonBody = bodyLimit({
	maxSize: 512 * 1024,
	onError: (c) => c.json(failure(413, "BODY_TOO_LARGE", "request body is too large").body, 413),
});

function cell(c: Ctx) {
	return c.env.WORKSPACE_CELL.getByName(c.get("scenario"));
}

function respond(c: Ctx, result: CellResult) {
	if (result.replay) c.header("Idempotent-Replay", "true");
	for (const [name, value] of Object.entries(result.headers ?? {})) c.header(name, value);
	return c.json(result.body as never, result.status as ContentfulStatusCode);
}

/** Every mutating route needs an Idempotency-Key. Returns the key, or a 400 response. */
function idempotencyKey(c: Ctx): { key: string } | { response: Response } {
	const key = c.req.header("Idempotency-Key");
	if (!key) return { response: c.json(failure(400, "IDEMPOTENCY_KEY_REQUIRED", "send an Idempotency-Key header on every mutating request").body, 400) };
	if (!IDEMPOTENCY_KEY.test(key)) return { response: c.json(failure(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ : ~ -").body, 400) };
	return { key };
}

async function readJson(c: Ctx): Promise<{ body: unknown } | { response: Response }> {
	const body = await c.req.json().catch(() => undefined);
	if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
		return { response: c.json(failure(400, "INVALID_JSON", "expected a JSON object body").body, 400) };
	}
	return { body };
}

function workItemId(c: Ctx): { id: string } | { response: Response } {
	const parsed = WorkItemId.safeParse(c.req.param("id"));
	return parsed.success ? { id: parsed.data } : { response: c.json(failure(400, "INVALID_INPUT", "invalid work item id").body, 400) };
}

/** Run a mutating route: key, body, then `act`. */
async function mutate(c: Ctx, act: (key: string, body: unknown) => Promise<CellResult>) {
	const key = idempotencyKey(c);
	if ("response" in key) return key.response;
	const body = await readJson(c);
	if ("response" in body) return body.response;
	return respond(c, await act(key.key, body.body));
}

// ---------- setup ----------

cellApi.post("/scenarios/:scenario/init", jsonBody, (c) => mutate(c, (key, body) => cell(c).init(c.get("scenario"), body, c.get("actor"), key)));

cellApi.post("/scenarios/:scenario/work-items", jsonBody, (c) => mutate(c, (key, body) => cell(c).registerWorkItem(body, c.get("actor"), key)));

// ---------- reads ----------

// The REST state read: the same object the WebSocket sends as its first `snapshot`. The polling fallback.
cellApi.get("/scenarios/:scenario/state", async (c) => respond(c, await cell(c).snapshot()));

cellApi.get("/scenarios/:scenario/ledger", async (c) => {
	const afterSeq = Number(c.req.query("afterSeq") ?? 0);
	const limit = Number(c.req.query("limit") ?? 200);
	if (!Number.isFinite(afterSeq) || !Number.isFinite(limit)) return c.json(failure(400, "INVALID_INPUT", "afterSeq and limit must be numbers").body, 400);
	return respond(c, await cell(c).ledger({ afterSeq, limit }));
});

cellApi.get("/scenarios/:scenario/ledger/verify", async (c) => respond(c, await cell(c).verifyLedger()));

cellApi.get("/scenarios/:scenario/poller", async (c) => c.json(await cell(c).pollerStatus()));

// The re-dispatches owed to the agent runtime (one per accepted revalidate resolution) and how far each got.
cellApi.get("/scenarios/:scenario/dispatches", async (c) => respond(c, await cell(c).dispatches()));

cellApi.get("/scenarios/:scenario/work-items/:id/gate", async (c) => {
	const id = workItemId(c);
	if ("response" in id) return id.response;
	return respond(c, await cell(c).gate(id.id));
});

// The prose of a record's accepted version, as Markdown (prefills the Propose change editor).
cellApi.get("/scenarios/:scenario/context/:recordId", async (c) => {
	const result = (await cell(c).recordText(c.req.param("recordId"))) as unknown as CellResult;
	return result.status === 200 ? c.text(result.body as string, 200, { "Content-Type": "text/markdown; charset=utf-8" }) : respond(c, result);
});

// ---------- commands ----------

cellApi.post("/scenarios/:scenario/context-changes", jsonBody, (c) => mutate(c, (key, body) => cell(c).changeContext(body, c.get("actor"), key)));

cellApi.post("/scenarios/:scenario/work-items/:id/resolutions", jsonBody, (c) => {
	const id = workItemId(c);
	if ("response" in id) return id.response;
	return mutate(c, (key, body) => cell(c).resolve(id.id, body, c.get("actor"), key));
});

cellApi.post("/scenarios/:scenario/work-items/:id/promote", jsonBody, (c) => {
	const id = workItemId(c);
	if ("response" in id) return id.response;
	return mutate(c, (key, body) => cell(c).promote(id.id, body, c.get("actor"), key));
});

// ---------- live ----------

cellApi.get("/scenarios/:scenario/ws", async (c) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		return c.json(failure(426, "UPGRADE_REQUIRED", "this endpoint speaks WebSocket; use GET /state to poll").body, 426);
	}
	return cell(c).fetch(c.req.raw);
});
