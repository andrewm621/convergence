#!/usr/bin/env node
// Live verification of the control loop (M2) against a deployed Worker and real Cloudflare Artifacts, with the
// stub agent. Runs Scenario A end to end and prints each check as PASS/FAIL with timings.
//
//   WORKER_URL=https://<worker>.workers.dev DEV_TOKEN=... node scripts/check-live.mjs [--keep]
//
// The Worker needs ENABLE_SMOKE=1 (it seeds the repos) and AGENT_MODE=stub. Seeded repos are named `smoke-*`;
// DELETE /api/smoke removes them (done at the end unless --keep). Exits non-zero if any check fails.

const base = (process.env.WORKER_URL ?? "").replace(/\/$/, "");
const token = process.env.DEV_TOKEN ?? "";
if (!base || !token) {
	console.error("set WORKER_URL and DEV_TOKEN");
	process.exit(2);
}
const keep = process.argv.includes("--keep");
const runId = Date.now().toString(36);
const scenario = `live-${runId}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body, headers = {}) {
	const t0 = performance.now();
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json, ms: Math.round(performance.now() - t0), headers: res.headers };
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
function note(text) {
	console.log(`      ${text}`);
}
const j = (v) => JSON.stringify(v);

async function until(fn, ms, what, stepMs = 250) {
	const t0 = performance.now();
	for (;;) {
		const v = await fn();
		if (v) return { value: v, ms: Math.round(performance.now() - t0) };
		if (performance.now() - t0 > ms) return { value: null, ms: Math.round(performance.now() - t0), timedOut: what };
		await sleep(stepMs);
	}
}

const wiOf = async (id) => (await get("/state")).json.workItems.find((w) => w.item.id === id);
const statusOf = async (id) => (await wiOf(id))?.item.status;

// ---- WebSocket (delta.v1 + bearer subprotocol) ----
const b64url = (s) => Buffer.from(s).toString("base64url");
const frames = [];
function openSocket() {
	const url = `${base.replace(/^http/, "ws")}${cellPath("/ws")}`;
	const ws = new WebSocket(url, ["delta.v1", `bearer.${b64url(token)}`]);
	const opened = new Promise((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", (e) => reject(new Error(`websocket error: ${e.message ?? "handshake failed"}`)));
	});
	ws.addEventListener("message", (m) => frames.push({ at: performance.now(), data: JSON.parse(String(m.data)) }));
	return { ws, opened };
}

const results = { timings: {} };

// ---------------------------------------------------------------------------------------------------------
// 0. Seed
// ---------------------------------------------------------------------------------------------------------
console.log(`scenario ${scenario}`);
let t = performance.now();
const seeded = await call("POST", "/api/smoke/seed?forks=2&scenario=notifications");
check("seed baseline + 2 forks on real Artifacts", seeded.status === 200 && seeded.json.forks?.length === 2 && seeded.json.creationTokensRevoked, `${seeded.ms} ms`);
if (seeded.status !== 200) {
	console.error(j(seeded.json));
	process.exit(1);
}
const baselineRepo = seeded.json.baseline.name;
const [fork1, fork2] = seeded.json.forks.map((f) => f.name);
const prefix = baselineRepo.replace(/-baseline$/, "");
const agentIds = { "WI-1": `${prefix}-wi-1`.length > 0 ? "wi-1" : "wi-1", "WI-2": "wi-2" };

// ---------------------------------------------------------------------------------------------------------
// 1. Init the cell and register work items
// ---------------------------------------------------------------------------------------------------------
const policy = { version: 1, authority: { notifications: "decision-owner", "status-model": "decision-owner" }, staleness: "facet", requires: [], maxRevalidations: 2 };
const init = await post("/init", { baselineRepo, policy }, "init");
check("init the notifications cell (reads accepted records from the real baseline)", init.status === 201, `${init.status} ${init.ms} ms ${init.status === 201 ? "" : j(init.json)}`);
const state0 = (await get("/state")).json;
check("both records accepted at v1 from the baseline", state0.records?.notifications?.current === 1 && state0.records?.["status-model"]?.current === 1, j(Object.keys(state0.records ?? {})));

const reg1 = await post("/work-items", { id: "WI-1", title: "Status badges and the status-change API", forkRepo: fork1, dependencies: [{ recordId: "status-model", facetKeys: ["status.transitions", "status.values"] }] }, "reg1");
const reg2 = await post("/work-items", { id: "WI-2", title: "Notification preferences and delivery", forkRepo: fork2, requires: ["contract-test"], dependencies: [{ recordId: "notifications", facetKeys: ["notifications.cadence", "notifications.default"] }, { recordId: "status-model", facetKeys: ["status.values"] }] }, "reg2");
check("register WI-1 and WI-2", reg1.status === 201 && reg2.status === 201, `${reg1.ms}/${reg2.ms} ms ${reg1.status === 201 && reg2.status === 201 ? "" : j([reg1.json, reg2.json])}`);

// Open the socket before anything happens, to see snapshot and then live events.
const { ws, opened } = openSocket();
let wsOk = true;
try {
	await opened;
} catch (e) {
	wsOk = false;
	check("WebSocket handshake with the delta.v1 + bearer subprotocol", false, e.message);
}
if (wsOk) {
	await sleep(1200);
	const first = frames[0]?.data;
	check("WebSocket: the first frame is a snapshot", first?.type === "snapshot", `protocol=${ws.protocol} first=${first?.type} meta.seq=${first?.meta?.seq}`);
}

// ---------------------------------------------------------------------------------------------------------
// 2. Dispatch both stub agents concurrently
// ---------------------------------------------------------------------------------------------------------
t = performance.now();
const dispatchBody = (wi, fork, prompt) => ({ forkRepo: fork, workItemId: agentIds[wi], prompt, wait: true });
const [d1, d2] = await Promise.all([
	call("POST", "/api/agents/dispatch", dispatchBody("WI-1", fork1, "Add status badges and the status-change API"), idem("d1")),
	call("POST", "/api/agents/dispatch", dispatchBody("WI-2", fork2, "Implement notification preferences and delivery"), idem("d2")),
]);
const dispatchMs = Math.round(performance.now() - t);
const run1 = d1.json;
const run2 = d2.json;
check("both stub agents ran and pushed (push verified)", run1?.state === "succeeded" && run2?.state === "succeeded" && run1?.pushVerified && run2?.pushVerified, `${dispatchMs} ms; ${run1?.state}/${run2?.state}${run1?.error ? ` ${run1.error}` : ""}${run2?.error ? ` ${run2.error}` : ""}`);
const w1 = [Date.parse(run1?.AgentRunStarted?.ts), Date.parse(run1?.AgentRunFinished?.ts)];
const w2 = [Date.parse(run2?.AgentRunStarted?.ts), Date.parse(run2?.AgentRunFinished?.ts)];
check("the two runs overlapped", w1[0] < w2[1] && w2[0] < w1[1], `${w1[1] - w1[0]} ms and ${w2[1] - w2[0]} ms`);

// ForkPushed: the poller must see each fork's head.
const forkSeen = await until(async () => {
	const [a, b] = [await wiOf("WI-1"), await wiOf("WI-2")];
	return a?.headSha && b?.headSha ? { a: a.headSha, b: b.headSha } : false;
}, 30_000, "ForkPushed for both");
const pushedAt = Math.max(Date.parse(run1?.AgentRunFinished?.ts ?? 0), Date.parse(run2?.AgentRunFinished?.ts ?? 0));
check("ForkPushed recorded for both forks (poller saw the real pushes)", Boolean(forkSeen.value), `${forkSeen.ms} ms after both runs returned`);
check("the recorded fork heads are the heads the runs verified", forkSeen.value?.a === run1?.commit && forkSeen.value?.b === run2?.commit, `${forkSeen.value?.a?.slice(0, 7)}/${run1?.commit?.slice(0, 7)} ${forkSeen.value?.b?.slice(0, 7)}/${run2?.commit?.slice(0, 7)}`);
results.timings.forkPushedAfterRunMs = forkSeen.ms;
const ledger0 = (await get("/ledger?limit=500")).json.entries;
const forkPushed = ledger0.filter((e) => e.type === "ForkPushed");
note(`ForkPushed ledger lines: ${forkPushed.length}; ts lag vs run finish: ${forkPushed.map((e) => `${e.id ?? ""}${Date.parse(e.ts) - Date.parse(run1?.AgentRunFinished?.ts ?? 0)}ms`).join(", ")}`);
const wi2Before = await wiOf("WI-2");
note(`WI-2 conditions after push: ${j(wi2Before?.conditions?.map((c) => c.type))}; status ${wi2Before?.item.status}; WI-1 ${await statusOf("WI-1")}`);

// ---------------------------------------------------------------------------------------------------------
// 3. Prose-only change, then the real v2 change
// ---------------------------------------------------------------------------------------------------------
const mark = frames.length;
t = performance.now();
const typo = await post("/context-changes", { recordId: "notifications", prose: "# Notifications\nUsers receive project status updates immediately, and they are on by default.\n", rationale: "fix typo" }, "typo");
const typoMs = Math.round(performance.now() - t);
check("prose-only change is accepted as a prose edit (same version, no decision file)", typo.status === 201 && typo.json?.kind === "prose-edit" && typo.json?.version === 1, `${typo.status} ${typoMs} ms ${typo.status === 201 ? "" : j(typo.json)}`);
const ledger1 = (await get("/ledger?limit=500")).json.entries;
const bp1 = ledger1.filter((e) => e.type === "BaselinePushed").at(-1);
const codes1 = (bp1?.payload?.effects ?? []).flatMap((e) => e.reasonCodes);
check("prose-only change ledgers NO_ACTION / PROSE_ONLY", codes1.length === 1 && codes1[0] === "PROSE_ONLY", `codes=${j(codes1)} observed=${typo.json?.observed}`);
check("no work item changed on the prose-only edit", (await statusOf("WI-2")) === wi2Before?.item.status, `WI-2 ${await statusOf("WI-2")}`);

// Authorship of the accepted context commit as Artifacts reports it (the silent-failure suspect).
{
	const log = await call("GET", `/api/repos/${baselineRepo}/log?limit=10`);
	const head = log.json?.commits?.[0];
	note(`baseline head after the typo fix: ${head?.hash?.slice(0, 7)} author=${head?.author}`);
	results.typoCommit = head;
}

t = performance.now();
const tStart = performance.now();
const v2 = await post(
	"/context-changes",
	{
		recordId: "notifications",
		facets: { "notifications.default": "opt-in", "notifications.cadence": "weekly-digest", "notifications.channel": "in-app" },
		not: { "notifications.default": "on", "notifications.cadence": "immediate" },
		prose: "# Notifications\nUsers opt in to project status notifications, delivered as a weekly digest.\n",
		rationale: "Make notifications opt-in with a weekly digest.",
	},
	"v2",
);
const v2ResponseMs = Math.round(performance.now() - tStart);
check("notifications v2 context change accepted", v2.status === 201 && v2.json?.kind === "new-version" && v2.json?.version === 2, `${v2.status} ${v2ResponseMs} ms ${v2.status === 201 ? `observed=${v2.json?.observed}` : j(v2.json)}`);
let staleMs = null;
const stale = await until(async () => (await statusOf("WI-2")) === "stale" || (await statusOf("WI-2")) === "conflict", 20_000, "WI-2 stale", 100);
staleMs = v2ResponseMs + stale.ms;
check("WI-2 goes stale after v2 (evaluated within 10 s)", Boolean(stale.value) && staleMs < 10_000, `request->response ${v2ResponseMs} ms, +${stale.ms} ms to read state; total ${staleMs} ms; status=${await statusOf("WI-2")}`);
results.timings.v2RequestMs = v2ResponseMs;
results.timings.staleVisibleMs = staleMs;
const wi1After = await wiOf("WI-1");
check("WI-1 is untouched (Fresh, no dependency on the changed facets)", wi1After?.conditions?.map((c) => c.type).includes("Fresh") && !wi1After?.conditions?.some((c) => c.type === "Stale"), `status=${wi1After?.item.status} conditions=${j(wi1After?.conditions?.map((c) => c.type))}`);
const ledger2 = (await get("/ledger?limit=500")).json.entries;
const bp2 = ledger2.filter((e) => e.type === "BaselinePushed").at(-1);
const eff2 = bp2?.payload?.effects ?? [];
check("v2 ledger line: WI-2 stale conditions + WI-1 NO_DEPENDENCY_ON_CHANGED_FACETS", eff2.some((e) => e.workItemId === "WI-1" && e.reasonCodes?.includes("NO_DEPENDENCY_ON_CHANGED_FACETS")) && eff2.some((e) => e.workItemId === "WI-2" && e.type === "RECORD_CONDITION"), j(eff2.map((e) => `${e.type}:${e.workItemId ?? ""}:${(e.reasonCodes ?? []).join("+")}`)));
{
	const log = await call("GET", `/api/repos/${baselineRepo}/log?limit=10`);
	const commits = log.json?.commits ?? [];
	note(`baseline log: ${commits.map((c) => `${c.hash.slice(0, 7)}[${c.author}] ${c.message.split("\n")[0]}`).join(" | ")}`);
	check("the v2 context commit shows the acting human as author (Artifacts did not rewrite it)", commits[0]?.author?.toLowerCase().includes("decision") || commits[0]?.author?.toLowerCase().includes("owner"), `author=${commits[0]?.author}`);
}

// WebSocket saw the event.
await sleep(500);
if (wsOk) {
	const live = frames.slice(mark).map((f) => f.data);
	const evs = live.filter((m) => m.type === "event");
	const bpFrames = evs.filter((m) => m.event?.type === "BaselinePushed");
	check("WebSocket: live BaselinePushed events arrive after the snapshot", bpFrames.length >= 2, `events=${evs.length} types=${j(evs.map((m) => m.event?.type))} evalMs=${j(bpFrames.map((m) => m.meta?.evaluationMs))}`);
	results.timings.evaluationMs = bpFrames.map((m) => m.meta?.evaluationMs);
}

// ---------------------------------------------------------------------------------------------------------
// 4. Gate dry runs
// ---------------------------------------------------------------------------------------------------------
const gate2 = await get("/work-items/WI-2/gate");
check("gate dry-run for the stale WI-2 fails with reason codes", gate2.status === 200 && gate2.json?.pass === false && gate2.json?.reasonCodes?.length > 0, `${gate2.ms} ms ${j(gate2.json?.reasonCodes)}`);
const gate1 = await get("/work-items/WI-1/gate");
check("gate dry-run for WI-1 passes", gate1.status === 200 && gate1.json?.pass === true, `${gate1.ms} ms ${j(gate1.json?.reasonCodes)} ${gate1.json?.pass === true ? "" : j(gate1.json)}`);

// ---------------------------------------------------------------------------------------------------------
// 5. Promote WI-1 for real (baseline has moved: this is the real-merge path, not a fast-forward)
// ---------------------------------------------------------------------------------------------------------
const stateP = (await get("/state")).json;
const wi1Head = (await wiOf("WI-1")).headSha;
t = performance.now();
const prom1 = await post("/work-items/WI-1/promote", { expectedBaselineCommit: stateP.baselineCommit, forkHeadSha: wi1Head }, "prom1");
const prom1Ms = Math.round(performance.now() - t);
check("promote WI-1 (baseline moved since the fork: a real merge)", prom1.status === 200 || prom1.status === 201, `${prom1.status} ${prom1Ms} ms ${j(prom1.json).slice(0, 400)}`);
results.timings.promoteWI1Ms = prom1Ms;
{
	const log = await call("GET", `/api/repos/${baselineRepo}/log?limit=10`);
	const commits = log.json?.commits ?? [];
	note(`baseline log: ${commits.map((c) => `${c.hash.slice(0, 7)}[${c.author}] p=${c.parents?.length} ${c.message.split("\n")[0]}`).join(" | ")}`);
	const head = commits[0];
	check("baseline head is a real merge commit (2 parents)", head?.parents?.length === 2, `parents=${head?.parents?.length}`);
	const mergeSha = head?.hash;
	await sleep(4000);
	const led = (await get("/ledger?limit=500")).json.entries;
	const bpMerge = led.filter((e) => e.type === "BaselinePushed").at(-1);
	const poller = (await get("/poller")).json;
	const writtenMerge = (poller?.written ?? []).find((w) => w.sha === mergeSha);
	check("the merge commit is recorded by the cell as kind=merge (so it can never accept context)", writtenMerge?.kind === "merge", j(poller?.written));
	note(`BaselinePushed for the merge: records=${j(bpMerge?.payload?.event?.records)} invalid=${j(bpMerge?.payload?.event?.invalid)}`);
	const merged = led.filter((e) => e.type === "PromotionMerged").at(-1);
	check("PromotionMerged recorded in the ledger", Boolean(merged), merged ? `mergeCommitSha=${merged.payload?.mergeCommitSha?.slice(0, 7) ?? merged.payload?.event?.mergeCommitSha?.slice(0, 7)} head=${mergeSha?.slice(0, 7)}` : "none");
	results.mergeSha = mergeSha;
}
check("WI-1 is promoted", ["promoted", "merged"].includes(await statusOf("WI-1")), `status=${await statusOf("WI-1")}`);

// ---------------------------------------------------------------------------------------------------------
// 6. Revalidate WI-2. Since M4 the cell does the rest itself: it issues the new receipt, re-dispatches the agent with
//    the new context, records its own check on the verified push, and WI-2 promotes. (Before M4 the operator
//    dispatched the stub by hand here and WI-2 stayed Stale.) Needs AGENT_MODE=stub, or a model you want to pay for.
// ---------------------------------------------------------------------------------------------------------
{
	const st = (await get("/state")).json;
	const wi2 = await wiOf("WI-2");
	const hist = st.records.notifications;
	const rec = hist.versions[String(hist.current)];
	const binding = { recordId: "notifications", version: rec.version, blobHash: rec.blobHash, baseSha: st.baselineCommit, forkHeadSha: wi2.headSha, contextSnapshotHash: st.snapshotHash };
	const res = await post("/work-items/WI-2/resolutions", { kind: "revalidate", rationale: "Rework notifications to the opt-in weekly digest.", binding }, "reval");
	check("revalidate resolution for WI-2 recorded", res.status === 200 || res.status === 201, `${res.status} ${res.status < 300 ? "" : j(res.json).slice(0, 400)}`);
	const ledgerR = (await get("/ledger?limit=500")).json.entries;
	const resEntry = ledgerR.filter((e) => e.type === "ResolutionRecorded").at(-1);
	note(`resolution effects: ${j((resEntry?.payload?.effects ?? []).map((e) => `${e.type}:${(e.reasonCodes ?? []).join("+")}`))}`);

	const job = await until(
		async () => {
			const jb = ((await get("/dispatches")).json?.jobs ?? [])[0];
			return jb && (jb.phase === "done" || jb.phase === "failed") ? jb : false;
		},
		240_000,
		"the re-dispatch job to finish",
		1000,
	);
	check("the cell re-dispatched the agent itself and the job reached done", job.value?.phase === "done", `${job.ms} ms ${j(job.value)}`);
	results.timings.redispatchJobMs = job.ms;
	note(`dispatch job: ${j(job.value)}`);
	const run = await call("GET", `/api/agents/runs/${agentIds["WI-2"]}`);
	check("the re-dispatched run succeeded and its push is verified", run.json?.state === "succeeded" && run.json?.pushVerified === true, `${run.json?.state} ${run.json?.error ?? ""}`);
	const claimsFile = await call("GET", `/api/repos/${fork2}/file?path=.delta/claims.json`);
	let reClaims = [];
	try {
		reClaims = JSON.parse(claimsFile.json?.text ?? "[]");
	} catch {
		// leave empty
	}
	check("the revalidated push carries claims that re-cite notifications@2 with the new facet values", reClaims.length > 0 && reClaims.every((c) => c.basedOn === "notifications@2") && reClaims.some((c) => c.subject === "notifications.default" && c.value === "opt-in"), j(reClaims));

	const after = await wiOf("WI-2");
	check("the poller recorded the revalidated push as the head of WI-2", after?.headSha === run.json?.commit, `${after?.headSha?.slice(0, 7)} vs ${run.json?.commit?.slice(0, 7)}`);
	check("the cell holds a new receipt at notifications v2 (issued by the Worker, before the dispatch)", after?.receipt?.accepted?.some((e) => e.recordId === "notifications" && e.version === 2), j(after?.receipt?.accepted?.map((e) => `${e.recordId}@${e.version}`)));
	const ledgerA = (await get("/ledger?limit=500")).json.entries;
	const order = ledgerA.map((e) => e.type);
	check("ledger order: ReceiptIssued, AgentRunStarted, then the push, AgentRunFinished and EvidenceRecorded", order.lastIndexOf("ReceiptIssued") < order.lastIndexOf("AgentRunStarted") && order.lastIndexOf("AgentRunStarted") < order.lastIndexOf("EvidenceRecorded"), j(order.slice(-10)));
	const atHead = (after?.evidence ?? []).filter((e) => e.headSha === after?.headSha);
	const ran = atHead.filter((e) => e.kind === "delta-run-check");
	check("the Worker ran each required contract check itself on the pushed files (kind delta-run-check, names the file and sha)", ran.length > 0 && ran.every((e) => e.pass && /Delta-run contract check .* at [0-9a-f]{7}, reading /.test(e.output)), j(ran.map((e) => `${e.check}:${e.pass}`)));
	check("the claims check is recorded beside them, informational only (kind delta-claims-check under delta:claims-vs-receipt)", atHead.some((e) => e.kind === "delta-claims-check" && e.check === "delta:claims-vs-receipt"), j(atHead.map((e) => `${e.check}:${e.pass}:${e.kind}`)));
	note(`receipt noteRef=${after?.receipt?.noteRef ?? "none"}; noteError=${job.value?.noteError ?? "none"}  (UNVERIFIED before this run: whether Artifacts accepts a push to refs/notes/delta)`);
	const noteLog = await call("GET", `/api/repos/${fork2}/log?ref=refs/notes/delta`);
	note(`GET log?ref=refs/notes/delta on the fork: HTTP ${noteLog.status} ${noteLog.json?.commits?.length ?? 0} commit(s)`);

	const gateR = await get("/work-items/WI-2/gate");
	check("WI-2 is Ready and the gate passes at the new head", (await statusOf("WI-2")) === "ready" && gateR.json?.pass === true, `status=${await statusOf("WI-2")} ${j(gateR.json?.reasonCodes)}`);
	const stateR = (await get("/state")).json;
	t = performance.now();
	const prom2 = await post("/work-items/WI-2/promote", { expectedBaselineCommit: stateR.baselineCommit, forkHeadSha: after?.headSha }, "prom2");
	const prom2Ms = Math.round(performance.now() - t);
	check("promote WI-2 after the revalidation merges", prom2.status === 200 && prom2.json?.promoted === true, `${prom2.status} ${prom2Ms} ms ${j(prom2.json).slice(0, 300)}`);
	results.timings.promoteWI2Ms = prom2Ms;
	const merged = await call("GET", `/api/repos/${baselineRepo}/file?path=src/work/wi-2.ts`);
	check("the baseline now holds WI-2's code, built on opt-in", merged.status === 200 && /opt-in/.test(merged.json?.text ?? ""), `${merged.status}`);
	results.wi2AfterRevalidation = await statusOf("WI-2");
}

// ---------------------------------------------------------------------------------------------------------
// 7. Ledger chain, final state, WebSocket tail
// ---------------------------------------------------------------------------------------------------------
{
	const verify = await get("/ledger/verify");
	check("ledger/verify reports a valid chain", verify.json?.ok === true, j(verify.json));
	const led = (await get("/ledger?limit=1000")).json.entries;
	const merges = led.filter((e) => e.type === "PromotionMerged");
	note(`ledger lines: ${led.length}; types: ${j(led.map((e) => e.type))}`);
	check("both promotions are in the ledger as PromotionMerged", merges.length === 2, `${merges.length}`);
	const poller = (await get("/poller")).json;
	check("poller healthy at the end", poller?.health?.healthy === true, j(poller?.health));
	check("final statuses: WI-1 and WI-2 promoted", (await statusOf("WI-1")) === "promoted" && (await statusOf("WI-2")) === "promoted", `${await statusOf("WI-1")}/${await statusOf("WI-2")}`);
	if (wsOk) {
		const evs = frames.map((f) => f.data).filter((m) => m.type === "event");
		check("WebSocket: saw an event for every ledger line since the snapshot", evs.length >= led.length - (frames[0]?.data?.meta?.seq ?? 0), `${evs.length} events, ledger ${led.length}, snapshot seq ${frames[0]?.data?.meta?.seq}`);
		note(`frame types: ${j(frames.map((f) => `${f.data.type}${f.data.event ? ":" + f.data.event.type : ""}`))}`);
	}
}

// ---------------------------------------------------------------------------------------------------------
// 8. The fast-forward promotion path: a fresh scenario where the baseline has not moved since the fork
// ---------------------------------------------------------------------------------------------------------
{
	const ffScenario = `${scenario}-ff`;
	const seed2 = await call("POST", "/api/smoke/seed?forks=1&scenario=notifications");
	const b2 = seed2.json.baseline.name;
	const f2 = seed2.json.forks[0].name;
	const fpost = (p, body, label) => call("POST", `/api/scenarios/${ffScenario}${p}`, body, idem(label));
	const fget = (p) => call("GET", `/api/scenarios/${ffScenario}${p}`);
	const i2 = await fpost("/init", { baselineRepo: b2, policy }, "ffinit");
	const r2 = await fpost("/work-items", { id: "WI-1", title: "Status badges and the status-change API", forkRepo: f2, dependencies: [{ recordId: "status-model", facetKeys: ["status.transitions", "status.values"] }] }, "ffreg");
	check("fast-forward scenario: init + register", i2.status === 201 && r2.status === 201, `${i2.status}/${r2.status}`);
	const d = await call("POST", "/api/agents/dispatch", { forkRepo: f2, workItemId: "wi-1", prompt: "Add status badges and the status-change API", wait: true }, idem("ffdisp"));
	check("fast-forward scenario: stub agent pushed", d.json?.state === "succeeded", `${d.ms} ms`);
	await until(async () => (await fget("/state")).json.workItems[0]?.headSha === d.json?.commit, 20_000, "ForkPushed");
	const st = (await fget("/state")).json;
	const p0 = performance.now();
	const pr = await fpost("/work-items/WI-1/promote", { expectedBaselineCommit: st.baselineCommit, forkHeadSha: d.json.commit }, "ffprom");
	const prMs = Math.round(performance.now() - p0);
	check("fast-forward promotion succeeds; the merge commit is the fork head", pr.status === 200 && pr.json?.mergeCommitSha === d.json?.commit, `${pr.status} ${prMs} ms merge=${pr.json?.mergeCommitSha?.slice(0, 7)} forkHead=${d.json?.commit?.slice(0, 7)} ${pr.status === 200 ? "" : j(pr.json).slice(0, 300)}`);
	results.timings.promoteFastForwardMs = prMs;
	await sleep(4000);
	const pol = (await fget("/poller")).json;
	check("the fast-forwarded fork head is recorded as kind=merge (an agent-authored commit can never accept context)", (pol?.written ?? []).some((w) => w.sha === d.json?.commit && w.kind === "merge"), j(pol?.written));
	const v = (await fget("/ledger/verify")).json;
	check("fast-forward scenario: ledger chain valid", v?.ok === true, j(v));
	check("fast-forward scenario: WI-1 promoted, poller healthy", (await fget("/state")).json.workItems[0]?.item.status === "promoted" && pol?.health?.healthy === true, j(pol?.health));
}

console.log("\n" + "-".repeat(60));
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
console.log(j(results.timings));
ws?.close();
if (!keep) {
	const purge = await call("DELETE", "/api/smoke");
	note(`cleanup: ${j(purge.json).slice(0, 200)}`);
}
process.exit(failed.length ? 1 : 0);
