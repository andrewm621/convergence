#!/usr/bin/env node
// Runs the same small task once per model, each on its own fresh fork, and reports what happened: did it run,
// did it push as its own author, did it write a valid .delta/claims.json, what it cost and how long it took.
// Needs the Worker in AGENT_MODE=claude with the models in AGENT_MODELS. Spends real money (capped per run by
// AGENT_MAX_COST_USD, enforced by the gateway).
//
//   WORKER_URL=... DEV_TOKEN=... node scripts/try-models.mjs openai/gpt-6-luna z-ai/glm-5.3-flash minimax/minimax-m3 [--cleanup]

const base = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
const token = process.env.DEV_TOKEN ?? "";
const models = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!base || !token || models.length === 0) {
	console.error("set WORKER_URL and DEV_TOKEN, and pass one or more model slugs");
	process.exit(2);
}

async function call(method, path, body, headers = {}) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, json: await res.json().catch(() => null) };
}

const PROMPT =
	"Implement notification preferences: create src/notifications.ts that exports a function defaultPreferences() returning the default notification settings from the notifications decision record. Keep it under 30 lines. Do not run tests or install anything.";
const CLAIM = /^[a-z0-9][a-z0-9_-]*@[1-9][0-9]*$/;

const seed = await call("POST", `/api/smoke/seed?forks=${models.length}`);
if (seed.status !== 200) throw new Error(`seed failed: ${seed.status} ${JSON.stringify(seed.json)}`);
const runId = Date.now().toString(36);

const results = await Promise.all(
	models.map(async (model, i) => {
		const fork = seed.json.forks[i].name;
		const workItemId = `wi-2-m${i + 1}`;
		const t0 = Date.now();
		const res = await call(
			"POST",
			"/api/agents/dispatch",
			{ forkRepo: fork, workItemId, prompt: PROMPT, model, wait: true },
			{ "Idempotency-Key": `models-${runId}-${i}` },
		);
		const wallMs = Date.now() - t0;
		const run = res.json;
		const out = { model, workItemId, fork, http: res.status, wallMs };
		if (res.status !== 200 && res.status !== 202) return { ...out, error: JSON.stringify(res.json) };

		const log = await call("GET", `/api/repos/${fork}/log`);
		const head = log.json?.commits?.[0];
		let claims = null;
		let claimsProblem = null;
		const file = await call("GET", `/api/repos/${fork}/file?path=.delta/claims.json`);
		if (file.status === 404) claimsProblem = "missing (.delta/claims.json not in the fork)";
		else {
			try {
				claims = JSON.parse(file.json.text);
				if (!Array.isArray(claims)) claimsProblem = "not an array";
				else if (claims.length === 0) claimsProblem = "empty";
				else if (!claims.every((c) => c && typeof c.subject === "string" && "value" in c && CLAIM.test(c.basedOn ?? ""))) claimsProblem = "an entry is missing subject/value/basedOn (recordId@version)";
			} catch {
				claimsProblem = "not valid JSON";
			}
		}
		const accurate =
			!claimsProblem &&
			claims.some((c) => c.subject === "notifications.default" && c.value === "on" && c.basedOn === "notifications@1") &&
			claims.some((c) => c.subject === "notifications.cadence" && c.value === "immediate" && c.basedOn === "notifications@1");
		return {
			...out,
			state: run.state,
			error: run.error,
			pushVerified: run.pushVerified,
			author: head?.author,
			authorOk: head?.author === `workitem-${workItemId}`,
			commit: run.commit?.slice(0, 7) ?? null,
			claimsValid: !claimsProblem,
			claimsProblem,
			claimsMatchRecord: accurate,
			usage: run.usage,
			runMs: run.durationMs,
			activity: (run.activity ?? []).filter((a) => ["agent", "tool", "text", "result", "usage", "error"].includes(a.kind)).map((a) => `${a.kind}: ${a.text}`),
		};
	}),
);

for (const r of results) {
	console.log(`\n== ${r.model}`);
	console.log(JSON.stringify({ ...r, activity: undefined }, null, 2));
	for (const line of r.activity ?? []) console.log(`   ${line.slice(0, 160)}`);
}
if (process.argv.includes("--cleanup")) {
	const purged = await call("DELETE", "/api/smoke");
	console.log(`\ncleanup: deleted ${purged.json?.deleted?.length ?? 0} smoke repos`);
}
