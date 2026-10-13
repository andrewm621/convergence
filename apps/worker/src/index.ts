import { Hono, type Context, type Next } from "hono";
import { assertSafePath, errorCode, getRepo } from "./artifacts/git-write";
import { redactDeep, redactText } from "./artifacts/tokens";
import { DispatchError, dispatchAgent, presentRun } from "./agents/dispatch";
import { DispatchRequest, IdempotencyKey, REPO_NAME_RE, RefName, WORK_ITEM_ID_RE } from "./agents/protocol";
import { POINTER_SCENARIO } from "./cell/pointer-scenario";
import { NOTIFICATIONS_SCENARIO_FILES, PointerForkRequest, PointerPushRequest, SEED_SCENARIOS, SMOKE_LABEL_RE, SmokeDeleteRequest, seedLabelAllowed, seedScenarioAllowed, deleteSmokeRepos, forkPointer, purgeSmokeRepos, pushPointer, runSmoke, seedForks } from "./smoke";
import { buildPointerSeed } from "./smoke-build";
import { SHELTER_SCENARIO, buildShelterSeed } from "./smoke-shelter";
import { bearerGuard } from "./cell/auth";
import { cellApi } from "./cell/routes";
import { jsonNotFound } from "./not-found";

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

// Deletes the repos named in the body ({"repos": ["smoke-..."]}) and nothing else. Wiping every `smoke-` repo, which
// would take a recorded demo's repos with it, needs an explicit ?all=1.
app.delete("/api/smoke", async (c) => {
	if (c.req.query("all") === "1") {
		const result = await purgeSmokeRepos(c.env);
		return c.json(result, result.failed.length ? 502 : 200);
	}
	const parsed = SmokeDeleteRequest.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "INVALID_INPUT",
					message: 'send {"repos": ["smoke-..."]} to delete those repos, or ?all=1 to delete every smoke- repo',
					issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
				},
			},
			400,
		);
	}
	const result = await deleteSmokeRepos(c.env, parsed.data.repos);
	return c.json(result, result.failed.length ? 502 : 200);
});

// A baseline plus N ready forks, for trying the agent runtime. Delete them with DELETE /api/smoke and their names.
// ?scenario=notifications seeds the baseline with Scenario A's accepted records, for the control loop.
// ?scenario=delta-convergence-build seeds our own build at the replay's end state (docs/dogfooding.md): the six records at
// their latest versions and seven pointer forks (the forks count is fixed), and answers with what to init and register.
// ?scenario=shelter-intake seeds the Larkhaven County shelter policy at v1 and two forks (the forks count is fixed), and answers with
// what to init and register, the prompts, and the mid-run decision to apply (scripts/check-live-shelter.mjs).
// ?label=<name> puts the name in the repo names (smoke-<name>-<time>-baseline), to tell a demo's repos apart.
app.post("/api/smoke/seed", async (c) => {
	const count = Math.min(Math.max(Number(c.req.query("forks") ?? 2) || 2, 1), 10);
	const scenario = c.req.query("scenario");
	const label = c.req.query("label");
	if (label !== undefined && !SMOKE_LABEL_RE.test(label)) {
		return c.json({ error: { code: "INVALID_INPUT", message: "label must be 1-40 lowercase letters, digits or hyphens" } }, 400);
	}
	if (!seedScenarioAllowed(scenario)) {
		return c.json({ error: { code: "INVALID_INPUT", message: `scenario must be one of ${SEED_SCENARIOS.join(", ")}` } }, 400);
	}
	if (!seedLabelAllowed(scenario, label)) {
		return c.json({ error: { code: "INVALID_INPUT", message: `label must not start with ${POINTER_SCENARIO} unless scenario=${POINTER_SCENARIO}` } }, 400);
	}
	if (scenario === POINTER_SCENARIO) {
		const seed = buildPointerSeed();
		const seeded = await seedForks(c.env, seed.workItems.length, seed.baselineFiles, label ?? POINTER_SCENARIO, seed.workItems.map((w) => ({ files: w.forkFiles, message: w.commitMessage })));
		return c.json(
			redactDeep({
				...seeded,
				scenario: POINTER_SCENARIO,
				policy: seed.policy,
				workItems: seed.workItems.map(({ forkFiles: _files, commitMessage: _message, ...item }, i) => ({ ...item, forkRepo: seeded.forks[i]?.name })),
			}),
		);
	}
	if (scenario === SHELTER_SCENARIO) {
		const seed = buildShelterSeed();
		const seeded = await seedForks(c.env, seed.workItems.length, seed.baselineFiles, label ?? SHELTER_SCENARIO);
		return c.json(
			redactDeep({
				...seeded,
				scenario: SHELTER_SCENARIO,
				policy: seed.policy,
				contextChange: seed.contextChange,
				workItems: seed.workItems.map((item, i) => ({ ...item, forkRepo: seeded.forks[i]?.name })),
			}),
		);
	}
	const files = scenario === "notifications" ? NOTIFICATIONS_SCENARIO_FILES : undefined;
	return c.json(redactDeep(await seedForks(c.env, count, files, label)));
});

const issuesOf = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) => error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

// A pointer work item for the live build cell: a fork of the baseline holding only a pointer and its claims.
app.post("/api/smoke/pointer-fork", async (c) => {
	const parsed = PointerForkRequest.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: { code: "INVALID_INPUT", message: "invalid pointer fork request", issues: issuesOf(parsed.error) } }, 400);
	return c.json(redactDeep(await forkPointer(c.env, parsed.data)));
});

// New claims and a new pointer for an existing pointer work item: the fork's next commit, which the cell reads as a push.
app.post("/api/smoke/pointer-push", async (c) => {
	const parsed = PointerPushRequest.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: { code: "INVALID_INPUT", message: "invalid pointer push request", issues: issuesOf(parsed.error) } }, 400);
	return c.json(redactDeep(await pushPointer(c.env, parsed.data)));
});

app.post("/api/agents/dispatch", async (c) => {
	const parsed = DispatchRequest.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) {
		return c.json(
			{ error: { code: "INVALID_INPUT", message: "invalid dispatch request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } },
			400,
		);
	}
	const key = IdempotencyKey.safeParse(c.req.header("Idempotency-Key"));
	if (!key.success) {
		return c.json({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: key.error.issues[0]?.message ?? "Idempotency-Key header is required" } }, 400);
	}
	try {
		const { httpStatus, run } = await dispatchAgent(c.env, parsed.data, key.data);
		// Activity lines come from the sandbox and can carry git error text (remote URLs): redact before it leaves.
		return c.json(redactDeep(presentRun(run)), httpStatus);
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
	return c.json(redactDeep(presentRun(run)));
});

app.get("/api/repos/:name/log", async (c) => {
	const name = c.req.param("name");
	if (!REPO_NAME_RE.test(name)) return c.json({ error: { code: "INVALID_REPO_NAME", message: "invalid repo name" } }, 400);
	const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
	const ref = RefName.safeParse(c.req.query("ref") ?? "main");
	if (!ref.success) return c.json({ error: { code: "INVALID_INPUT", message: "invalid ref" } }, 400);

	using repo = await getRepo(c.env, name);
	const commits = await repo.log({ ref: ref.data, limit });
	return c.json({
		repo: name,
		ref: ref.data,
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
	const ref = RefName.safeParse(c.req.query("ref") ?? "main");
	if (!ref.success) return c.json({ error: { code: "INVALID_INPUT", message: "invalid ref" } }, 400);
	using repo = await getRepo(c.env, name);
	const blob = await repo.readFile({ ref: ref.data, path });
	if (!blob) return c.json({ error: { code: "NOT_FOUND", message: `no ${path} at that ref` } }, 404);
	return c.json({ repo: name, path, text: redactText(await blob.text()) });
});

app.get("/api/cell/:name", async (c) => {
	const stub = c.env.WORKSPACE_CELL.get(c.env.WORKSPACE_CELL.idFromName(c.req.param("name")));
	return c.json({ id: await stub.getId() });
});

app.route("/api", cellApi); // WorkspaceCell API: scenarios, work items, resolutions, promote, WebSocket (docs/control-loop.md)

app.notFound(jsonNotFound);

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
