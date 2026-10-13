#!/usr/bin/env node
// Live run of the shelter act (Larkhaven County, knowledge work, synthetic) against a Worker and real Cloudflare Artifacts,
// with REAL model agents: AGENT_MODE=claude and an OPENROUTER_API_KEY on the Worker. It mirrors scripts/check-live.mjs
// (the notifications act): seed, two concurrent agents, a decision change while they work, stale and blocked visible,
// revalidate, promote. Nothing here asks a model to decide anything: the staleness, the contract check and the gate are
// the Worker's deterministic rules, and every resolution and promotion is a call this script makes as the human.
//
//   WORKER_URL=https://<worker>.workers.dev DEV_TOKEN=... node scripts/check-live-shelter.mjs [--cell <name>] [--stop-before-revalidate] [--keep] [--model <slug>] [--after-push] [--v2-after <seconds>]
//
// The Worker needs ENABLE_SMOKE=1 and AGENT_MODE=claude. Seeded repos are named `smoke-*`; at the end DELETE /api/smoke removes
// exactly the repos this run created, by name (unless kept). Other `smoke-` repos, such as a recorded demo's, are never touched.
// Exits non-zero if any check fails. The act:
//
//   SH-1 front-desk intake script (scripts/front-desk.md) relies on pets and id_required of shelter-intake-policy
//   SH-2 cots and blankets list (supplies/cots-and-blankets.md) relies on capacity_note of the SAME record
//   The decision changes while both agents work (v2: crated pets admitted, ID not listed). Only SH-1 goes stale: its file is
//   not the one that changed, it merges cleanly, and it is still wrong. SH-2 stays green.
//
//   --cell <name>              run in a cell with this name instead of a throwaway one, to leave a demo behind. The name must be
//                              shelter-intake-<something> (lowercase letters, digits, dashes, at most 40), so the console can open it
//                              with ?cell=<name>. The cell must not exist yet. Implies --keep.
//   --stop-before-revalidate   stop once v2 has made SH-1 stale and blocked (SH-2 ready, nothing promoted), so the revalidate, the
//                              re-dispatch and both promotions can be done on camera in the console. Implies --keep.
//   --keep                     leave the repos behind.
//   --model <slug>             run both agents on this allowlisted OpenRouter model instead of the Worker's default.
//   --after-push               land v2 after both agents have pushed, instead of while they run (the deterministic variant).
//   --v2-after <seconds>       how long after the dispatch v2 lands, while the agents run (default 25).

const base = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
const token = process.env.DEV_TOKEN ?? "";
if (!base || !token) {
	console.error("set WORKER_URL and DEV_TOKEN");
	process.exit(2);
}
const argv = process.argv.slice(2);
const valueOf = (flag) => {
	const at = argv.indexOf(flag);
	return at >= 0 ? argv[at + 1] : undefined;
};
const cellArg = valueOf("--cell");
const CELL_PREFIX = "shelter-intake-";
if (argv.includes("--cell") && !(typeof cellArg === "string" && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(cellArg) && cellArg.startsWith(CELL_PREFIX) && cellArg.length > CELL_PREFIX.length)) {
	console.error(`--cell needs a name of lowercase letters, digits and dashes, at most 40 characters, starting with ${CELL_PREFIX} (for example ${CELL_PREFIX}demo)`);
	process.exit(2);
}
const modelArg = valueOf("--model");
if (argv.includes("--model") && !(typeof modelArg === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelArg))) {
	console.error("--model needs an exact OpenRouter slug like vendor/name");
	process.exit(2);
}
const stopBeforeRevalidate = argv.includes("--stop-before-revalidate");
const afterPush = argv.includes("--after-push");
const midRunDelayS = Number(valueOf("--v2-after") ?? 25);
if (!(midRunDelayS >= 0 && midRunDelayS <= 300)) {
	console.error("--v2-after needs a number of seconds, 0 to 300");
	process.exit(2);
}
// A demo cell points at its repos, so deleting them at the end would break it.
const keep = argv.includes("--keep") || cellArg !== undefined || stopBeforeRevalidate;
const runId = Date.now().toString(36);
const scenario = cellArg ?? `${CELL_PREFIX}live-${runId}`;
/** Every repo this run seeds: the only ones the cleanup deletes. */
const created = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v);

/** One request. A network failure or a timeout is an answer too (status 0), so a polling loop can go round again instead of dying. */
async function call(method, path, body, headers = {}, timeoutMs = 60_000) {
	const t0 = performance.now();
	let res;
	let text;
	try {
		res = await fetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		text = await res.text();
	} catch (error) {
		return { status: 0, json: { error: { code: "FETCH_FAILED", message: error instanceof Error ? error.message : String(error) } }, ms: Math.round(performance.now() - t0) };
	}
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json, ms: Math.round(performance.now() - t0) };
}
let keys = 0;
const idem = (label) => ({ "Idempotency-Key": `${label}-${runId}-${++keys}` });
const cellPath = (p) => `/api/scenarios/${scenario}${p}`;
const post = (p, body, label = "k") => call("POST", cellPath(p), body, idem(label));
const get = (p) => call("GET", cellPath(p));

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
	return Boolean(ok);
}
const note = (text) => console.log(`      ${text}`);

async function until(fn, ms, what, stepMs = 500) {
	const t0 = performance.now();
	for (;;) {
		const v = await fn();
		if (v) return { value: v, ms: Math.round(performance.now() - t0) };
		if (performance.now() - t0 > ms) return { value: null, ms: Math.round(performance.now() - t0), timedOut: what };
		await sleep(stepMs);
	}
}

/** The cell state, asked again a few times when a request is dropped (status 0) or fails; null when it never answers. */
async function stateOf() {
	for (let i = 0; i < 5; i++) {
		const res = await get("/state");
		if (res.status === 200 && res.json?.workItems) return res.json;
		await sleep(1000);
	}
	return null;
}
// A dropped /state reads as "not yet", so a polling loop goes round again instead of throwing.
const wiOf = async (id) => (await stateOf())?.workItems.find((w) => w.item.id === id);
const statusOf = async (id) => (await wiOf(id))?.item.status;
/** The cell state for a step that cannot go on without it: a /state that never answers is a failed check, not a TypeError. */
async function stateFor(what) {
	const st = await stateOf();
	if (st) return st;
	check(`read the cell state before ${what}`, false, "/state did not answer after 5 tries");
	await finish();
	process.exit(1);
}
const conditionsOf = (wi) => (wi?.conditions ?? []).map((c) => c.type);
/** The runtime's id for a cell work item (agents/work-item-ids.ts): lowercase. */
const runtimeId = (id) => id.toLowerCase();
const readRun = async (id) => (await call("GET", `/api/agents/runs/${runtimeId(id)}`)).json;
const fileOf = async (repo, path, ref = "main") => {
	const res = await call("GET", `/api/repos/${repo}/file?path=${encodeURIComponent(path)}&ref=${ref}`);
	return res.status === 200 ? res.json.text : null;
};
const firstLines = (text, n = 6) => (text ?? "").split("\n").filter((l) => l.trim() !== "").slice(0, n).join(" / ");

const results = { timings: {}, runs: {} };
let finishing = false;
for (const event of ["uncaughtException", "unhandledRejection"]) {
	process.on(event, async (error) => {
		console.error(`FAIL  unexpected error: ${error instanceof Error ? error.stack : String(error)}`);
		checks.push({ name: "no unexpected error", ok: false });
		await finish();
	});
}

// ---------------------------------------------------------------------------------------------------------
// 0. Seed
// ---------------------------------------------------------------------------------------------------------
console.log(`scenario ${scenario}${modelArg ? `  model ${modelArg}` : ""}${afterPush ? "  (v2 lands after both pushes)" : "  (v2 lands while the agents run)"}`);
if (cellArg !== undefined) {
	// There is no cell reset, so a name that is already initialised cannot be reused. Look before creating any repo.
	const existing = await get("/state");
	if (existing.status !== 409) {
		console.error(existing.status === 200 ? `cell ${cellArg} already exists; pick another name (there is no cell reset)` : `cannot tell whether cell ${cellArg} exists: HTTP ${existing.status} ${j(existing.json).slice(0, 200)}`);
		process.exit(1);
	}
}
let t = performance.now();
const seeded = await call("POST", `/api/smoke/seed?scenario=shelter-intake${cellArg !== undefined ? `&label=${cellArg}` : ""}`);
// Record whatever was created before judging it, so every exit path below deletes it (unless kept).
for (const repo of [seeded.json?.baseline, ...(seeded.json?.forks ?? [])]) if (repo?.name) created.push(repo.name);
const items = seeded.json?.workItems ?? [];
check("seed the shelter baseline + 2 forks on real Artifacts", seeded.status === 200 && items.length === 2 && seeded.json.creationTokensRevoked, `${seeded.ms} ms`);
if (seeded.status !== 200 || items.length !== 2) {
	console.error(j(seeded.json));
	await finish();
}
const baselineRepo = seeded.json.baseline.name;
note(`repos: ${created.join(", ")}`);
const [wi1, wi2] = items; // SH-1 relies on facets the change moves; SH-2 does not
const POLICY_ID = "shelter-intake-policy";
const policyPath = `context/${POLICY_ID}.md`;
note(`SH-1 ${wi1.title} -> ${wi1.path}, relies on ${j(wi1.dependencies)}`);
note(`SH-2 ${wi2.title} -> ${wi2.path}, relies on ${j(wi2.dependencies)}`);

// ---------------------------------------------------------------------------------------------------------
// 1. Init the cell and register the work items
// ---------------------------------------------------------------------------------------------------------
const init = await post("/init", { baselineRepo, policy: seeded.json.policy }, "init");
check("init the shelter cell (reads the accepted records from the real baseline)", init.status === 201, `${init.status} ${init.ms} ms ${init.status === 201 ? "" : j(init.json)}`);
const state0 = (await get("/state")).json;
check("both records accepted at v1 from the baseline", state0.records?.[POLICY_ID]?.current === 1 && state0.records?.["volunteer-roles"]?.current === 1, j(Object.keys(state0.records ?? {})));
const regs = [];
for (const item of items) {
	regs.push(await post("/work-items", { id: item.id, title: item.title, forkRepo: item.forkRepo, agent: item.agent, requires: item.requires, dependencies: item.dependencies }, `reg-${item.id}`));
}
check("register SH-1 and SH-2", regs.every((r) => r.status === 201), regs.map((r) => `${r.status}/${r.ms} ms`).join(" ") + (regs.every((r) => r.status === 201) ? "" : ` ${j(regs.map((r) => r.json))}`));

// ---------------------------------------------------------------------------------------------------------
// 2. Dispatch both real agents at once. Each dispatch holds its request until the run ends (re-sent with the same
//    Idempotency-Key when the Worker's wait runs out, which replays the same run), so nothing polls a run mid-flight.
// ---------------------------------------------------------------------------------------------------------
const dispatchAt = Date.now();
const dispatchBody = (item) => ({ forkRepo: item.forkRepo, workItemId: runtimeId(item.id), prompt: item.prompt, wait: true, ...(modelArg ? { model: modelArg } : {}) });
async function runToEnd(item) {
	const key = idem(`d-${item.id}`);
	let res;
	// Up to 12 minutes. A dropped connection (status 0) is sent again after a pause; the same key replays the same run.
	for (const deadline = Date.now() + 720_000; Date.now() < deadline; ) {
		res = await call("POST", "/api/agents/dispatch", dispatchBody(item), key, 200_000);
		if (res.status === 0) await sleep(3000);
		else if (res.status >= 400 || (res.status === 200 && res.json?.state !== "running")) break;
	}
	return res;
}
const runs = items.map((item) => runToEnd(item));

// ---------------------------------------------------------------------------------------------------------
// 3. The decision changes. By default while the agents are mid-run, a few seconds after they started.
// ---------------------------------------------------------------------------------------------------------
if (!afterPush) await sleep(midRunDelayS * 1000);
else await Promise.allSettled(runs);
if (!afterPush) {
	const midRun = await Promise.all(items.map((item) => readRun(item.id)));
	check("both agents are still running when the decision changes", midRun.every((r) => r?.state === "running"), `${Math.round((Date.now() - dispatchAt) / 1000)} s after dispatch; ${midRun.map((r) => `${r?.workItemId}=${r?.state}`).join(" ")}`);
	check("the Worker runs real model agents (mode claude), not the stub", midRun.every((r) => r?.mode === "claude"), midRun.map((r) => `${r?.mode}/${r?.model}`).join(" "));
}
const tV2 = performance.now();
const v2 = await post("/context-changes", seeded.json.contextChange, "v2");
const v2ResponseMs = Math.round(performance.now() - tV2);
check("shelter-intake-policy v2 context change accepted", v2.status === 201 && v2.json?.kind === "new-version" && v2.json?.version === 2, `${v2.status} ${v2ResponseMs} ms ${v2.status === 201 ? `path=${v2.json?.path} observed=${v2.json?.observed}` : j(v2.json)}`);
const v2Path = v2.json?.path ?? policyPath;
const stale = await until(async () => ["stale", "conflict"].includes(await statusOf("SH-1")), 20_000, "SH-1 stale", 150);
// The commit itself is a write to Artifacts and takes as long as Artifacts takes; the claim is about the evaluation after the commit lands.
check("SH-1 goes stale within 10 s of v2 being accepted", Boolean(stale.value) && stale.ms < 10_000, `context change took ${v2ResponseMs} ms; stale visible +${stale.ms} ms after the response; status=${await statusOf("SH-1")}`);
results.timings.v2RequestMs = v2ResponseMs;
results.timings.staleVisibleMs = v2ResponseMs + stale.ms;
results.timings.v2AfterDispatchMs = Date.now() - dispatchAt;
const wi2AfterV2 = await wiOf("SH-2");
check("SH-2 is untouched by v2 (no Stale condition: it relies on capacity_note, which did not move)", !conditionsOf(wi2AfterV2).includes("Stale") && !["stale", "conflict"].includes(wi2AfterV2?.item.status), `status=${wi2AfterV2?.item.status} conditions=${j(conditionsOf(wi2AfterV2))}`);
const ledgerV2 = (await get("/ledger?limit=500")).json.entries;
const effV2 = ledgerV2.filter((e) => e.type === "BaselinePushed").at(-1)?.payload?.effects ?? [];
check("v2 ledger line: SH-1 stale on pets + id_required, SH-2 NO_DEPENDENCY_ON_CHANGED_FACETS", effV2.some((e) => e.workItemId === "SH-1" && e.type === "RECORD_CONDITION") && effV2.some((e) => e.workItemId === "SH-2" && e.reasonCodes?.includes("NO_DEPENDENCY_ON_CHANGED_FACETS")), j(effV2.map((e) => `${e.type}:${e.workItemId ?? ""}:${(e.reasonCodes ?? []).join("+")}`)));

// ---------------------------------------------------------------------------------------------------------
// 4. Both runs finish and push. The documents are real model output.
// ---------------------------------------------------------------------------------------------------------
const [d1, d2] = await Promise.all(runs);
const [run1, run2] = [d1?.json, d2?.json];
check("both agents ran and pushed (state succeeded, push verified)", run1?.state === "succeeded" && run2?.state === "succeeded" && run1?.pushVerified && run2?.pushVerified, `${Math.round((Date.now() - dispatchAt) / 1000)} s after dispatch; ${run1?.state}/${run2?.state}${run1?.error ? ` ${j(run1.error)}` : ""}${run2?.error ? ` ${j(run2.error)}` : ""}`);
const w1 = [Date.parse(run1?.AgentRunStarted?.ts), Date.parse(run1?.AgentRunFinished?.ts)];
const w2 = [Date.parse(run2?.AgentRunStarted?.ts), Date.parse(run2?.AgentRunFinished?.ts)];
check("the two runs overlapped", w1[0] < w2[1] && w2[0] < w1[1], `${Math.round((w1[1] - w1[0]) / 1000)} s and ${Math.round((w2[1] - w2[0]) / 1000)} s`);
if (!(run1?.state === "succeeded" && run2?.state === "succeeded")) {
	for (const run of [run1, run2]) note(`${run?.workItemId}: ${run?.state} ${j(run?.error ?? "")} ${j((run?.activity ?? []).slice(-4).map((a) => `${a.kind}:${a.text}`))}`);
	await finish();
}
await sleep(4000); // usage reports can land just after a run ends
const [fin1, fin2] = await Promise.all(items.map((item) => readRun(item.id)));
results.runs.first = { "SH-1": runSummary(fin1), "SH-2": runSummary(fin2) };
note(`SH-1 run: ${j(results.runs.first["SH-1"])}`);
note(`SH-2 run: ${j(results.runs.first["SH-2"])}`);

const seen = await until(async () => {
	const [a, b] = [await wiOf("SH-1"), await wiOf("SH-2")];
	return a?.headSha === run1.commit && b?.headSha === run2.commit;
}, 30_000, "ForkPushed for both");
check("ForkPushed recorded for both forks, at the heads the runs verified", Boolean(seen.value), `${seen.ms} ms`);

const doc1 = await fileOf(wi1.forkRepo, wi1.path);
const doc2 = await fileOf(wi2.forkRepo, wi2.path);
check("SH-1 wrote its script and SH-2 its supply list, each at its own path", Boolean(doc1) && Boolean(doc2), `${wi1.path} ${doc1?.length ?? 0} chars; ${wi2.path} ${doc2?.length ?? 0} chars`);
note(`${wi1.path}: ${firstLines(doc1, 8)}`);
note(`${wi2.path}: ${firstLines(doc2, 8)}`);
const claims1 = await readClaims(wi1.forkRepo);
const claims2 = await readClaims(wi2.forkRepo);
note(`SH-1 claims: ${j(claims1)}`);
note(`SH-2 claims: ${j(claims2)}`);
check("SH-1 built on v1: its claims cite shelter-intake-policy@1", claims1.length > 0 && claims1.every((c) => c.basedOn === `${POLICY_ID}@1`), j(claims1.map((c) => `${c.subject}@${c.basedOn}`)));
check("SH-2 claims only capacity_note (the agent stayed in its lane)", claims2.length > 0 && claims2.every((c) => c.subject === "capacity_note" && c.basedOn.startsWith(`${POLICY_ID}@`)), j(claims2.map((c) => `${c.subject}@${c.basedOn}`)));

// What lands where: the stale file is not the file that changed.
check("the stale item is a DIFFERENT file from the record that changed", wi1.path !== v2Path && !wi1.path.startsWith("context/"), `stale: ${wi1.path}; changed: ${v2Path}`);

// ---------------------------------------------------------------------------------------------------------
// 5. Stale and blocked visible; the unaffected item is ready
// ---------------------------------------------------------------------------------------------------------
await sleep(1500);
const s1 = await wiOf("SH-1");
const s2 = await wiOf("SH-2");
check("SH-1 is stale, with its pushed script built on v1", ["stale", "conflict"].includes(s1?.item.status), `status=${s1?.item.status} conditions=${j(conditionsOf(s1))}`);
const gate1 = await get("/work-items/SH-1/gate");
check("gate dry-run for the stale SH-1 fails with reason codes (blocked)", gate1.status === 200 && gate1.json?.pass === false && gate1.json?.reasonCodes?.length > 0, `${gate1.ms} ms ${j(gate1.json?.reasonCodes)}`);
const gate2 = await get("/work-items/SH-2/gate");
check("SH-2 is ready and its gate passes (it never relied on what changed)", s2?.item.status === "ready" && gate2.status === 200 && gate2.json?.pass === true, `status=${s2?.item.status} ${j(gate2.json?.reasonCodes)} ${gate2.json?.pass === true ? "" : j(gate2.json)}`);

if (stopBeforeRevalidate) {
	note("stopping before the revalidate, as asked: v2 is accepted, SH-1 is stale and blocked, SH-2 is ready, nothing is promoted");
	note(`console: <worker url>/?cell=${scenario}   (token in the address bar hash, as usual)`);
	note(`repos kept: ${created.join(", ")}`);
	await finish();
}

// ---------------------------------------------------------------------------------------------------------
// 6. Promote SH-2 (the baseline moved since the fork: a real merge, not a fast-forward)
// ---------------------------------------------------------------------------------------------------------
{
	const st = await stateFor("promoting SH-2");
	t = performance.now();
	const prom = await post("/work-items/SH-2/promote", { expectedBaselineCommit: st.baselineCommit, forkHeadSha: st.workItems.find((w) => w.item.id === "SH-2")?.headSha }, "prom-wi2");
	const ms = Math.round(performance.now() - t);
	check("promote SH-2 (baseline moved since the fork: a real merge)", prom.status === 200 && prom.json?.promoted === true, `${prom.status} ${ms} ms ${j(prom.json).slice(0, 300)}`);
	results.timings.promoteWI2Ms = ms;
	const head = ((await call("GET", `/api/repos/${baselineRepo}/log?limit=3`)).json?.commits ?? [])[0];
	check("baseline head is a real merge commit (2 parents) and now holds the supply list", head?.parents?.length === 2 && (await fileOf(baselineRepo, wi2.path)) !== null, `parents=${head?.parents?.length}`);
}

// ---------------------------------------------------------------------------------------------------------
// 7. Revalidate SH-1. The cell issues the receipt, re-dispatches the agent with the v2 context, runs its own contract check on the
//    pushed file and records it as evidence. A failed check leaves SH-1 blocked and a human can revalidate again (maxRevalidations 2).
// ---------------------------------------------------------------------------------------------------------
let revalidated = false;
for (let attempt = 1; attempt <= 2 && !revalidated; attempt++) {
	const st = await stateFor("revalidating SH-1");
	const wi = st.workItems.find((w) => w.item.id === "SH-1");
	const hist = st.records[POLICY_ID];
	const rec = hist.versions[String(hist.current)];
	const binding = { recordId: POLICY_ID, version: rec.version, blobHash: rec.blobHash, baseSha: st.baselineCommit, forkHeadSha: wi?.headSha, contextSnapshotHash: st.snapshotHash };
	const res = await post("/work-items/SH-1/resolutions", { kind: "revalidate", rationale: "Rework the front-desk script to the current intake policy.", binding }, `reval${attempt}`);
	check(`revalidate resolution for SH-1 recorded (attempt ${attempt})`, res.status === 200 || res.status === 201, `${res.status} ${res.status < 300 ? "" : j(res.json).slice(0, 400)}`);
	if (res.status >= 300) break;
	const tRe = performance.now();
	const job = await until(
		async () => {
			// The job is keyed by the resolution's Idempotency-Key, which post() prefixed with the label.
			const jb = ((await get("/dispatches")).json?.jobs ?? []).find((x) => x.workItemId === "SH-1" && x.requestId.startsWith(`reval${attempt}-`));
			return jb && (jb.phase === "done" || jb.phase === "failed") ? jb : false;
		},
		480_000,
		"the re-dispatch job to finish",
		2000,
	);
	check(`the cell re-dispatched the agent itself and the job reached done (attempt ${attempt})`, job.value?.phase === "done", `${job.ms} ms ${j(job.value)}`);
	results.timings[`redispatch${attempt}Ms`] = job.ms;
	await sleep(4000);
	const run = await readRun("SH-1");
	results.runs[`revalidation${attempt}`] = runSummary(run);
	note(`SH-1 re-dispatched run: ${j(runSummary(run))}`);
	check("the re-dispatched run succeeded and its push is verified", run?.state === "succeeded" && run?.pushVerified === true, `${run?.state} ${run?.error ?? ""} (${Math.round((performance.now() - tRe) / 1000)} s)`);
	const after = await wiOf("SH-1");
	const doc = await fileOf(wi1.forkRepo, wi1.path);
	note(`${wi1.path} after revalidation: ${firstLines(doc, 8)}`);
	const reClaims = await readClaims(wi1.forkRepo);
	note(`SH-1 claims after revalidation: ${j(reClaims)}`);
	check("the revalidated push re-cites shelter-intake-policy@2 and states the new pets and ID facets", reClaims.length > 0 && reClaims.every((c) => c.basedOn === `${POLICY_ID}@2`) && reClaims.some((c) => c.subject === "pets") && reClaims.some((c) => c.subject === "id_required"), j(reClaims.map((c) => `${c.subject}@${c.basedOn}`)));
	check("the cell holds a new receipt at shelter-intake-policy v2 (issued by the Worker before the dispatch)", after?.receipt?.accepted?.some((e) => e.recordId === POLICY_ID && e.version === 2), j(after?.receipt?.accepted?.map((e) => `${e.recordId}@${e.version}`)));
	const atHead = (after?.evidence ?? []).filter((e) => e.headSha === after?.headSha);
	const ran = atHead.filter((e) => e.kind === "delta-run-check");
	check("the Worker ran the shelter contract check itself on the pushed file (kind delta-run-check, names the file and sha)", ran.length >= 1 && ran.every((e) => /Delta-run contract check .* at [0-9a-f]{7}, reading .*front-desk\.md/.test(e.output)), j(ran.map((e) => `${e.check}:${e.pass}`)));
	for (const e of ran) note(`evidence: pass=${e.pass} ${e.output}`);
	const gateR = await get("/work-items/SH-1/gate");
	revalidated = (await statusOf("SH-1")) === "ready" && gateR.json?.pass === true;
	check(`SH-1 is ready and the gate passes at the new head (attempt ${attempt})`, revalidated, `status=${await statusOf("SH-1")} ${j(gateR.json?.reasonCodes)}`);
	if (!revalidated && attempt < 2) note("the contract check failed on the model's rewrite; a human can revalidate again, so this run does (maxRevalidations is 2)");
}

if (revalidated) {
	const st = await stateFor("promoting SH-1");
	t = performance.now();
	const prom = await post("/work-items/SH-1/promote", { expectedBaselineCommit: st.baselineCommit, forkHeadSha: st.workItems.find((w) => w.item.id === "SH-1")?.headSha }, "prom-wi1");
	const ms = Math.round(performance.now() - t);
	check("promote SH-1 after the revalidation merges", prom.status === 200 && prom.json?.promoted === true, `${prom.status} ${ms} ms ${j(prom.json).slice(0, 300)}`);
	results.timings.promoteWI1Ms = ms;
	const merged = await fileOf(baselineRepo, wi1.path);
	check("the baseline now holds the script, built on the crated-pets policy (names Hall B)", merged !== null && /Hall B/.test(merged), `${merged === null ? "missing" : `${merged.length} chars`}`);
}

// ---------------------------------------------------------------------------------------------------------
// 8. Ledger chain, final state, cost
// ---------------------------------------------------------------------------------------------------------
{
	const verify = await get("/ledger/verify");
	check("ledger/verify reports a valid chain", verify.json?.ok === true, j(verify.json));
	const led = (await get("/ledger?limit=1000")).json.entries;
	note(`ledger lines: ${led.length}; types: ${j(led.map((e) => e.type))}`);
	check("both promotions are in the ledger as PromotionMerged", led.filter((e) => e.type === "PromotionMerged").length === 2, `${led.filter((e) => e.type === "PromotionMerged").length}`);
	const poller = (await get("/poller")).json;
	check("poller healthy at the end", poller?.health?.healthy === true, j(poller?.health));
	check("final statuses: SH-1 and SH-2 promoted", (await statusOf("SH-1")) === "promoted" && (await statusOf("SH-2")) === "promoted", `${await statusOf("SH-1")}/${await statusOf("SH-2")}`);
	const runs = Object.values(results.runs).flatMap((r) => (r.model ? [r] : Object.values(r)));
	results.totalCostUsd = Number(runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0).toFixed(4));
	note(`model cost metered by the gateways, all runs: $${results.totalCostUsd}`);
}

await finish();

/** The .delta/claims.json a fork holds at its head, or [] when it is missing or unreadable. */
async function readClaims(repo) {
	try {
		return JSON.parse((await fileOf(repo, ".delta/claims.json")) ?? "[]");
	} catch {
		return [];
	}
}

function runSummary(run) {
	return {
		model: run?.model,
		seconds: run?.durationMs == null ? null : Math.round(run.durationMs / 1000),
		modelRequests: run?.usage?.modelRequests ?? null,
		inputTokens: run?.usage?.inputTokens ?? null,
		outputTokens: run?.usage?.outputTokens ?? null,
		costUsd: run?.usage?.costUsd ?? null,
	};
}

/** Print the summary, delete this run's repos unless they are kept, and exit non-zero if any check failed. */
async function finish() {
	if (finishing) return;
	finishing = true;
	console.log("\n" + "-".repeat(60));
	const failed = checks.filter((c) => !c.ok);
	console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
	console.log(j(results));
	if (!keep) {
		// Only the repos this run seeded, by name. A bare DELETE is refused, and ?all=1 would take a demo's repos too.
		if (created.length > 0) {
			const purge = await call("DELETE", "/api/smoke", { repos: created });
			note(`cleanup: ${j(purge.json).slice(0, 300)}`);
		}
	} else if (created.length > 0) {
		note(`kept repos: ${created.join(", ")}`);
	}
	process.exit(failed.length ? 1 : 0);
}
