import type { Context } from "hono";

/** Hono's default 404 is plain text; every error from /api is `{ error: { code, message } }`, so an unknown route is too. */
export function jsonNotFound(c: Context) {
	return c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404);
}
