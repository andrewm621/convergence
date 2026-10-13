import { Hono } from "hono";
import { errorCode, getRepo } from "./artifacts/git-write";
import { redactText } from "./artifacts/tokens";
import { runSmoke } from "./smoke";

export { WorkspaceCell } from "./workspace-cell";

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: c.env.APP_VERSION }));

// Everything under /api needs the bearer secret. Fails closed when DEV_TOKEN is unset.
app.use("/api/*", async (c, next) => {
	const expected = c.env.DEV_TOKEN;
	const header = c.req.header("Authorization") ?? "";
	const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
	if (!expected || !given || !(await safeEqual(given, expected))) {
		return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }, 401);
	}
	await next();
});

app.post("/api/smoke", async (c) => {
	const body = await c.req.json<{ baseline?: unknown }>().catch(() => ({}) as { baseline?: unknown });
	let baseline: string | undefined;
	if (body.baseline !== undefined) {
		if (typeof body.baseline !== "string" || !REPO_NAME_RE.test(body.baseline)) {
			return c.json({ error: { code: "INVALID_INPUT", message: "baseline must be a valid repo name" } }, 400);
		}
		baseline = body.baseline;
	}
	const report = await runSmoke(c.env, baseline);
	return c.json(report, report.ok ? 200 : 502);
});

app.get("/api/repos/:name/log", async (c) => {
	const name = c.req.param("name");
	if (!REPO_NAME_RE.test(name)) return c.json({ error: { code: "INVALID_REPO_NAME", message: "invalid repo name" } }, 400);
	const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
	const ref = c.req.query("ref") ?? "main";

	using repo = await getRepo(c.env, name);
	const commits = await repo.log({ ref, limit });
	return c.json({
		repo: name,
		ref,
		commits: commits.map((m) => ({
			hash: m.hash,
			treeHash: m.treeHash,
			message: m.message,
			parents: m.parents,
			author: m.author.name,
			committedAt: m.committedAt,
		})),
	});
});

app.get("/api/cell/:name", async (c) => {
	const stub = c.env.WORKSPACE_CELL.get(c.env.WORKSPACE_CELL.idFromName(c.req.param("name")));
	return c.json({ id: await stub.getId() });
});

app.onError((err, c) => {
	const code = errorCode(err);
	const status = code === "NOT_FOUND" ? 404 : 500;
	console.error(redactText(err.message));
	return c.json({ error: { code: code ?? "INTERNAL_ERROR", message: redactText(err.message) } }, status);
});

async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

export default app;
