import { Hono, type Context, type Next } from "hono";
import { assertSafePath, errorCode, getRepo } from "./artifacts/git-write";
import { redactDeep, redactText } from "./artifacts/tokens";
import { DispatchError, dispatchAgent, presentRun } from "./agents/dispatch";
import { DispatchRequest, REPO_NAME_RE, WORK_ITEM_ID_RE } from "./agents/protocol";
import { purgeSmokeRepos, runSmoke, seedForks } from "./smoke";
import { bearerGuard } from "./cell/auth";
import { cellApi } from "./cell/routes";

export { WorkspaceCell } from "./workspace-cell";
export { AgentSandbox } from "./agents/sandbox";
export { ArtifactsGateway, ModelGateway } from "./agents/outbound";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, version: c.env.APP_VERSION }));

// Everything under /api needs the bearer secret. Fails closed when DEV_TOKEN is unset.
app.use("/api/*", bearerGuard);

// Smoke endpoints create and delete real repos. Off unless ENABLE_SMOKE=1.
app.use("/api/smoke/*", requireSmoke);
app.use("/api/smoke", requireSmoke);

app.post("/api/smoke", async (c) => {
	const body = await c.req.json<{ baseline?: unknown }>().catch(() => ({}) as { baseline?: unknown });
	let baselineName: string | undefined;
	if (body.baseline !== undefined) {
		if (typeof body.baseline !== "string" || !REPO_NAME_RE.test(body.baseline)) {
			return c.json({ error: { code: "INVALID_INPUT", message: "baseline must be a valid repo name" } }, 400);
		}
		baselineName = body.baseline;
	}
	const report = await runSmoke(c.env, { baselineName, cleanup: c.req.query("cleanup") === "1" });
	return c.json(report, report.ok ? 200 : 502);
});

app.delete("/api/smoke", async (c) => {
	const result = await purgeSmokeRepos(c.env);
	return c.json(result, result.failed.length ? 502 : 200);
});

// A baseline plus N ready forks, for trying the agent runtime. Delete them with DELETE /api/smoke.
app.post("/api/smoke/seed", async (c) => {
	const count = Math.min(Math.max(Number(c.req.query("forks") ?? 2) || 2, 1), 6);
	return c.json(redactDeep(await seedForks(c.env, count)));
});

app.post("/api/agents/dispatch", async (c) => {
	const parsed = DispatchRequest.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{ error: { code: "INVALID_INPUT", message: "invalid dispatch request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } },
			400,
		);
	}
	try {
		const { httpStatus, run } = await dispatchAgent(c.env, parsed.data);
		return c.json(presentRun(run), httpStatus);
	} catch (e) {
		if (e instanceof DispatchError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
		throw e;
	}
});

app.get("/api/agents/runs/:workItemId", async (c) => {
	const id = c.req.param("workItemId");
	if (!WORK_ITEM_ID_RE.test(id)) return c.json({ error: { code: "INVALID_INPUT", message: "invalid work item id" } }, 400);
	const run = await c.env.AGENT_SANDBOX.getByName(id).readRun();
	if (!run) return c.json({ error: { code: "NOT_FOUND", message: `no run for ${id}` } }, 404);
	return c.json(presentRun(run));
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

// Text of one file at a ref, read through the binding (for checking what an agent pushed).
app.get("/api/repos/:name/file", async (c) => {
	const name = c.req.param("name");
	const path = c.req.query("path") ?? "";
	if (!REPO_NAME_RE.test(name)) return c.json({ error: { code: "INVALID_REPO_NAME", message: "invalid repo name" } }, 400);
	try {
		assertSafePath(path);
	} catch {
		return c.json({ error: { code: "INVALID_INPUT", message: "invalid path" } }, 400);
	}
	using repo = await getRepo(c.env, name);
	const blob = await repo.readFile({ ref: c.req.query("ref") ?? "main", path });
	if (!blob) return c.json({ error: { code: "NOT_FOUND", message: `no ${path} at that ref` } }, 404);
	return c.json({ repo: name, path, text: redactText(await blob.text()) });
});

app.get("/api/cell/:name", async (c) => {
	const stub = c.env.WORKSPACE_CELL.get(c.env.WORKSPACE_CELL.idFromName(c.req.param("name")));
	return c.json({ id: await stub.getId() });
});

app.route("/api", cellApi); // WorkspaceCell API: scenarios, work items, resolutions, promote, WebSocket (docs/control-loop.md)

app.onError((err, c) => {
	const code = errorCode(err);
	const status = code === "NOT_FOUND" ? 404 : 500;
	console.error(redactText(err.message));
	return c.json({ error: { code: code ?? "INTERNAL_ERROR", message: redactText(err.message) } }, status);
});

async function requireSmoke(c: Context<{ Bindings: Env }>, next: Next) {
	if (c.env.ENABLE_SMOKE !== "1") {
		return c.json({ error: { code: "SMOKE_DISABLED", message: "smoke endpoints are disabled (set ENABLE_SMOKE=1)" } }, 404);
	}
	await next();
}

export default app;
