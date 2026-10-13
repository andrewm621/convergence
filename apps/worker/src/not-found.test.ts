import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { jsonNotFound } from "./not-found";

describe("jsonNotFound", () => {
	const app = new Hono();
	app.get("/api/known", (c) => c.json({ ok: true }));
	app.notFound(jsonNotFound);

	it("answers an unknown route with a JSON error body, not Hono's plain text", async () => {
		const res = await app.request("/api/nope");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "no route for GET /api/nope" } });
	});

	it("leaves known routes alone", async () => {
		const res = await app.request("/api/known");
		expect(res.status).toBe(200);
	});
});
