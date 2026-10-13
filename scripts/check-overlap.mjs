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
const forkCount = Number(argv[argv.indexOf("--forks") + 1]) || 2;

async function api(method, path, body) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
	return json;
}

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
		api("POST", "/api/agents/dispatch", {
			forkRepo: fork.name,
			workItemId: `wi-${i + 1}`,
			prompt: prompts[i] ?? `Task ${i + 1}`,
			wait: true,
		}),
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

if (flag("cleanup")) {
	const purged = await api("DELETE", "/api/smoke");
	console.log(`cleanup: deleted ${purged.deleted.length} smoke repos`);
}

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} check(s) FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
