#!/usr/bin/env node
// Proves concurrent agent runs against a deployed Worker (T-3 acceptance): seeds a baseline with two
// forks, dispatches one work item per fork at the same moment, then asserts from the Worker's own
// output that the run windows overlap and that each fork's history carries its own commit author.
//
//   WORKER_URL=https://<worker>.workers.dev DEV_TOKEN=... node scripts/check-overlap.mjs [--forks 2] [--cleanup]
//
// The Worker needs ENABLE_SMOKE=1 (it seeds repos). Exits non-zero if any check fails.

const base = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
const token = process.env.DEV_TOKEN ?? "";
if (!base || !token) {
	console.error("set WORKER_URL and DEV_TOKEN");
	process.exit(2);
}
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const forksAt = argv.indexOf("--forks");
const forkCount = forksAt >= 0 ? Number(argv[forksAt + 1]) || 2 : 2;

// Like api(), but returns the status and body instead of throwing, for checks that expect a non-2xx.
async function call(method, path, body, headers = {}) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json().catch(() => null) };
}

async function api(method, path, body, headers) {
	const { status, json } = await call(method, path, body, headers);
	if (status < 200 || status >= 300) throw new Error(`${method} ${path} -> ${status} ${JSON.stringify(json)}`);
	return json;
}

const runId = Date.now().toString(36);
const dispatch = (body, key, expectOk = true) =>
	(expectOk ? api : call)("POST", "/api/agents/dispatch", body, { "Idempotency-Key": key });

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const prompts = [
	"Add status badges and the status-change API",
	"Implement notification preferences and delivery",
	"Add a status history view",
	"Add digest scheduling",
	"Add notification settings page",
	"Add audit log",
];

const seeded = await api("POST", `/api/smoke/seed?forks=${forkCount}`);
console.log(`seeded ${seeded.baseline.name} with ${seeded.forks.length} forks`);
check("creation tokens revoked", seeded.creationTokensRevoked);

const t0 = Date.now();
const runs = await Promise.all(
	seeded.forks.map((fork, i) =>
		dispatch(
			{ forkRepo: fork.name, workItemId: `wi-${i + 1}`, prompt: prompts[i] ?? `Task ${i + 1}`, wait: true },
			`overlap-${runId}-${i + 1}`,
		),
	),
);
console.log(`all runs returned after ${Date.now() - t0} ms`);

const window = (r) => [Date.parse(r.AgentRunStarted.ts), Date.parse(r.AgentRunFinished?.ts ?? "")];
for (const r of runs) {
	const [s, e] = window(r);
	console.log(`  ${r.workItemId}  ${r.AgentRunStarted.ts} -> ${r.AgentRunFinished?.ts}  (${e - s} ms)  author=${r.author}  commit=${r.commit?.slice(0, 7)}`);
}

check("every run succeeded", runs.every((r) => r.state === "succeeded"), runs.map((r) => r.state).join(","));
check("every run reports both events", runs.every((r) => r.AgentRunStarted && r.AgentRunFinished));
check("write tokens revoked after each run", runs.every((r) => r.tokenRevoked === true));

// Every pair of run windows must overlap: max(starts) < min(ends).
const wins = runs.map(window);
const overlap = Math.min(...wins.map((w) => w[1])) - Math.max(...wins.map((w) => w[0]));
check("run windows overlap", overlap > 0, `common window ${overlap} ms`);

const authors = runs.map((r) => r.author);
check("distinct commit authors", new Set(authors).size === authors.length, authors.join(","));

for (const [i, fork] of seeded.forks.entries()) {
	const run = runs[i];
	const log = await api("GET", `/api/repos/${fork.name}/log`);
	const head = log.commits[0];
	check(`${fork.name}: head commit authored by ${run.author}`, head?.author === run.author, head?.author);
	check(`${fork.name}: head commit is the pushed commit`, head?.hash === run.commit);
	const others = authors.filter((a) => a !== run.author);
	check(`${fork.name}: no other work item's author in its log`, !log.commits.some((c) => others.includes(c.author)));

	const claimsFile = await api("GET", `/api/repos/${fork.name}/file?path=.delta/claims.json`);
	let claims = null;
	try {
		claims = JSON.parse(claimsFile.text);
	} catch {}
	check(
		`${fork.name}: .delta/claims.json cites recordId@version`,
		Array.isArray(claims) && claims.length > 0 && claims.every((c) => /^[a-z0-9][a-z0-9_-]*@[1-9][0-9]*$/.test(c.basedOn)),
		claims ? `${claims.length} claims` : "unparseable",
	);
}

// ---- Idempotency: the same key and request returns the run it started; a new run is not launched. ----
{
	const fork = seeded.forks[0];
	const body = { forkRepo: fork.name, workItemId: "wi-1", prompt: prompts[0], wait: true };
	const replay = await dispatch(body, `overlap-${runId}-1`);
	check("same Idempotency-Key replays the original run", replay.AgentRunStarted.ts === runs[0].AgentRunStarted.ts && replay.commit === runs[0].commit);
	const reused = await dispatch({ ...body, prompt: "a different task" }, `overlap-${runId}-1`, false);
	check("a reused key with a different request is rejected (422)", reused.status === 422, String(reused.status));
	const missing = await call("POST", "/api/agents/dispatch", body);
	check("a dispatch without Idempotency-Key is rejected (400)", missing.status === 400, String(missing.status));
}

// ---- Duplicate-dispatch race: two simultaneous dispatches for one work item launch exactly one run. ----
{
	const fork = seeded.forks[0];
	const body = { forkRepo: fork.name, workItemId: "wi-1", prompt: "Second pass on badges" };
	const results = await Promise.all([dispatch(body, `race-${runId}-a`, false), dispatch(body, `race-${runId}-b`, false)]);
	const statuses = results.map((r) => r.status).sort();
	check("simultaneous dispatches: one starts, one is refused", statuses.join() === "202,409", statuses.join());
	for (let i = 0; i < 120; i++) {
		const r = await api("GET", "/api/agents/runs/wi-1");
		if (r.state !== "running") break;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const log = await api("GET", `/api/repos/${fork.name}/log`);
	check("the race produced exactly one new commit", log.commits.length === 3, `${log.commits.length} commits`);
}

// ---- Revalidation on the same fork: new context version, diff-aware prompt, new receipt. ----
if (seeded.forks.length >= 2) {
	const fork = seeded.forks[1];
	const v2 = `---
id: notifications
version: 2
status: accepted
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
---
# Notifications
Users opt in to project status notifications, delivered as a weekly digest.
`;
	const changes = [{ recordId: "notifications", fromVersion: 1, toVersion: 2 }];
	const reval = await dispatch(
		{ forkRepo: fork.name, workItemId: "wi-2", prompt: prompts[1], wait: true, revalidate: { changes, context: { "notifications.md": v2 } } },
		`reval-${runId}-2`,
	);
	check("revalidation run succeeded on the same fork", reval.state === "succeeded" && reval.forkRepo === fork.name, reval.state);
	check("revalidation is reported on the run", reval.revalidation?.[0]?.toVersion === 2);
	check("revalidation push verified against the fork history", reval.pushVerified === true && /^[0-9a-f]{40}$/.test(reval.commit ?? ""));
	const log = await api("GET", `/api/repos/${fork.name}/log`);
	check("revalidation commit is by the same work item, on top of the first run", log.commits[0]?.author === "workitem-wi-2" && log.commits.length === 3, `${log.commits.length} commits`);
	check("revalidation commit subject names the change", /revalidate notifications v1->v2/.test(log.commits[0]?.message ?? ""), log.commits[0]?.message);
	const claims = JSON.parse((await api("GET", `/api/repos/${fork.name}/file?path=.delta/claims.json`)).text);
	check(
		"claims now cite notifications@2 with the new values",
		claims.length > 0 && claims.every((c) => c.basedOn === "notifications@2") && claims.some((c) => c.subject === "notifications.default" && c.value === "opt-in"),
	);
	const receipt = JSON.parse((await api("GET", `/api/repos/${fork.name}/file?path=.delta/receipt.json`)).text);
	check("receipt lists the delivered v2 record", receipt.kind === "revalidation" && receipt.delivered.some((d) => d.recordId === "notifications" && d.version === 2));
	const note = await call("GET", `/api/repos/${fork.name}/log?ref=refs/notes/delta`);
	console.log(`INFO  git note ref refs/notes/delta: HTTP ${note.status}${note.json?.commits?.length ? `, ${note.json.commits.length} commit(s)` : ""}`);
	const badContext = await dispatch(
		{ forkRepo: fork.name, workItemId: "wi-2", prompt: "x", revalidate: { changes, context: { "notifications.md": v2.replace("version: 2", "version: 1") } } },
		`reval-bad-${runId}`,
		false,
	);
	check("context that does not carry the claimed version is rejected (400)", badContext.status === 400, String(badContext.status));
}

if (flag("cleanup")) {
	// Only the repos this run seeded, by name: other smoke- repos (a recorded demo's) stay.
	const purged = await api("DELETE", "/api/smoke", { repos: [seeded.baseline.name, ...seeded.forks.map((f) => f.name)] });
	console.log(`cleanup: deleted ${purged.deleted.length} smoke repos`);
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
