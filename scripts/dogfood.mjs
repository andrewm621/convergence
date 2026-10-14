#!/usr/bin/env node
// Convergence governing its own build, live (docs/dogfooding.md). Run against a deployed Worker.
//
//   node scripts/dogfood.mjs seed     --cell delta-convergence-build-live
//   node scripts/dogfood.mjs status   [--cell <name>]
//   node scripts/dogfood.mjs decide   --record <id> --facet <key>=<value> [--facet ...] [--prose "..."] \
//                                     --rationale "<one neutral line>" --idempotency-key <k> [--cell <name>]
//   node scripts/dogfood.mjs register --wi <id> --title "..." --depends <record>:<facet>,... \
//                                     --claim <facet>=<value>,... --head <sha|none> [--agent <id>] [--cell <name>]
//   node scripts/dogfood.mjs revalidate --wi <id> --rationale "<one neutral line>" --idempotency-key <k> [--cell <name>]
//   node scripts/dogfood.mjs update   --wi <id> --claim <facet>=<value>,... --head <sha|none> [--force] [--cell <name>]
//
// The cell defaults to $DOGFOOD_CELL, then delta-convergence-build-live. The Worker URL is $WORKER_URL and the bearer
// token $DEV_TOKEN, each from the environment or from a `.dev.vars` file (apps/worker/.dev.vars, then ./.dev.vars).
// Neither is ever printed. `decide`, `revalidate`, `status` and the init and register calls go through the ordinary API.
// `seed`, `register` and `update` create repos or commit to a pointer's fork, which the Worker only does with ENABLE_SMOKE=1.
// --facet and --claim can be repeated; within one value, `a=x,y,b=z` reads as a="x,y" and b="z".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIO = "delta-convergence-build";
const CELL_RE = /^delta-convergence-build-[a-z0-9-]{1,16}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// ---- configuration: environment first, then .dev.vars. The values are used, never printed ----
function devVars() {
	const out = {};
	for (const file of [join(root, "apps", "worker", ".dev.vars"), join(root, ".dev.vars")]) {
		if (!existsSync(file)) continue;
		for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
			const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
			if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
		}
	}
	return out;
}
const vars = devVars();
const base = (process.env.WORKER_URL ?? vars.WORKER_URL ?? "").replace(/\/$/, "");
const token = process.env.DEV_TOKEN ?? vars.DEV_TOKEN ?? "";

// ---- arguments ----
const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
	const arg = rest[i];
	if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
	const name = arg.slice(2);
	if (name === "force") {
		flags.force = ["1"];
		continue;
	}
	const value = rest[i + 1];
	if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
	(flags[name] ??= []).push(value);
	i++;
}
const one = (name, required = false) => {
	if (flags[name] && flags[name].length > 1 && name !== "facet" && name !== "claim") fail(`--${name} was given more than once`);
	if (required && !flags[name]) fail(`--${name} is required`);
	return flags[name]?.[0];
};
const cell = one("cell") ?? process.env.DOGFOOD_CELL ?? `${SCENARIO}-live`;

function fail(message) {
	console.error(message);
	process.exit(2);
}
if (!["seed", "status", "decide", "revalidate", "register", "update"].includes(command ?? "")) {
	fail("usage: dogfood.mjs seed|status|decide|revalidate|register|update (see the header of this file)");
}
if (!base || !token) fail("set WORKER_URL and DEV_TOKEN, in the environment or in apps/worker/.dev.vars");
if (!CELL_RE.test(cell) || cell.length > 40) fail(`the cell must be ${SCENARIO}-<name>: lowercase letters, digits and dashes, at most 40 characters`);

// ---- http ----
async function call(method, path, body, key) {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = text;
	try {
		json = JSON.parse(text);
	} catch {
		// leave the text
	}
	return { status: res.status, json };
}
const cellPath = (p) => `/api/scenarios/${cell}${p}`;
const j = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpFailure extends Error {}

/** The body of a 2xx answer; anything else throws, so callers can clean up and the bottom of the file reports it. */
async function must(res, what) {
	if (res.status >= 200 && res.status < 300) return res.json;
	throw new HttpFailure(`${what} failed: HTTP ${res.status} ${j(res.json).slice(0, 600)}`);
}

/** A facet or claim value: JSON when it parses as a number, boolean or list, else the text as given. */
function parseValue(text) {
	const t = text.trim();
	if (/^(true|false|-?\d+(\.\d+)?)$/.test(t) || (t.startsWith("[") && t.endsWith("]"))) {
		try {
			return JSON.parse(t);
		} catch {
			// a list of bare words: fall through to the text
		}
	}
	return t;
}
const splitPair = (piece, sep) => {
	const at = piece.indexOf(sep);
	if (at <= 0 || at === piece.length - 1) fail(`expected <key>${sep}<value>, got "${piece}"`);
	return [piece.slice(0, at).trim(), piece.slice(at + 1).trim()];
};
/**
 * `a=x,b=y` as pairs. A comma-separated piece with no separator belongs to the value before it, so `a=x,y,b=z` is
 * a="x,y" and b="z". The key is what comes before the first separator of a piece.
 */
const splitPairs = (text, sep) => {
	const pieces = [];
	for (const piece of text.split(",")) {
		const keyed = piece.indexOf(sep) > 0 && /^[A-Za-z0-9_.-]+$/.test(piece.slice(0, piece.indexOf(sep)).trim());
		if (keyed || pieces.length === 0) pieces.push(piece);
		else pieces[pieces.length - 1] += `,${piece}`;
	}
	return pieces.map((p) => splitPair(p, sep));
};

async function state() {
	const res = await call("GET", cellPath("/state"));
	if (res.status === 409) fail(`the cell ${cell} is not initialised; run: dogfood.mjs seed --cell ${cell}`);
	return must(res, "reading the cell");
}

async function baselineRepoOf() {
	const poller = await must(await call("GET", cellPath("/poller")), "reading the poller");
	const repo = poller.repos?.find((r) => r.kind === "baseline")?.repo;
	if (!repo) fail("the cell does not report its baseline repo");
	return repo;
}

async function waitForHeads(ids, ms = 90_000) {
	const t0 = Date.now();
	for (;;) {
		const items = (await state()).workItems;
		if (ids.every((id) => items.find((w) => w.item.id === id)?.headSha)) return true;
		if (Date.now() - t0 > ms) return false;
		await sleep(1000);
	}
}

// ---- status ----
async function status() {
	const snap = await state();
	console.log(`cell ${cell}  baseline ${snap.baselineCommit.slice(0, 7)}  ledger ${snap.ledgerHead.seq} lines`);
	console.log("records: " + Object.entries(snap.records).map(([id, h]) => `${id}@${h.current}`).join(", "));
	for (const wi of snap.workItems) {
		const gate = await call("GET", cellPath(`/work-items/${wi.item.id}/gate`));
		const codes = gate.status === 200 ? gate.json.reasonCodes : [`gate HTTP ${gate.status}`];
		const conditions = wi.conditions.map((c) => (c.facetKeys?.length ? `${c.type}(${c.facetKeys.join(", ")})` : c.type));
		console.log(`${wi.item.id.padEnd(6)} ${wi.item.status.padEnd(12)} ${wi.item.title}`);
		console.log(`       head ${wi.headSha ? wi.headSha.slice(0, 7) : "none"}  conditions: ${conditions.join("; ") || "none"}  reason codes: ${codes.join(", ") || "none"}`);
	}
	const verify = await call("GET", cellPath("/ledger/verify"));
	console.log(`ledger chain: ${verify.json?.ok ? "verified" : j(verify.json)}`);
}

// ---- seed ----
async function seed() {
	const existing = await call("GET", cellPath("/state"));
	if (existing.status !== 409) fail(existing.status === 200 ? `cell ${cell} already exists; there is no reset, pick another name` : `cannot tell whether ${cell} exists: HTTP ${existing.status}`);
	const seeded = await must(await call("POST", `/api/smoke/seed?scenario=${SCENARIO}&label=${cell}`), "seeding the repos (needs ENABLE_SMOKE=1)");
	const repos = [seeded.baseline.name, ...seeded.forks.map((f) => f.name)];
	console.log(`seeded ${repos.length} repos: ${repos.join(", ")}`);
	if (!seeded.creationTokensRevoked) console.error("warning: not every creation token was revoked");
	try {
		await must(await call("POST", cellPath("/init"), { baselineRepo: seeded.baseline.name, policy: seeded.policy }, `dogfood-init-${cell}`), "init");
		for (const item of seeded.workItems) {
			const { id, title, forkRepo, agent, requires, dependencies } = item;
			await must(await call("POST", cellPath("/work-items"), { id, title, forkRepo, agent, requires, dependencies }, `dogfood-register-${cell}-${id}`), `registering ${id}`);
		}
	} catch (error) {
		console.error(`seeding stopped; the repos above exist and can be deleted by name (DELETE /api/smoke with {"repos": [...]})`);
		throw error;
	}
	const ids = seeded.workItems.map((w) => w.id);
	const seen = await waitForHeads(ids);
	console.log(seen ? "the cell has read every pointer" : "the cell has not read every pointer yet; run status in a minute");
	await status();
	console.log(`\nopen the console with ?cell=${cell}`);
}

// ---- decide ----
async function decide() {
	const recordId = one("record", true);
	const rationale = one("rationale", true).trim();
	const key = one("idempotency-key", true);
	if (rationale.includes("\n") || rationale.length > 300) fail("--rationale is one neutral line of at most 300 characters");
	if (!flags.facet?.length) fail("--facet <key>=<value> is required (give it once per facet that changes)");
	const snap = await state();
	const history = snap.records[recordId];
	if (!history || history.current === null) fail(`no accepted version of ${recordId}; records: ${Object.keys(snap.records).join(", ")}`);
	const facets = { ...history.versions[String(history.current)].facets };
	for (const [k, v] of flags.facet.flatMap((f) => splitPairs(f, "="))) {
		if (!(k in facets)) fail(`${recordId} has no facet ${k}; it has: ${Object.keys(facets).join(", ")}`);
		facets[k] = parseValue(v);
	}
	const prose = one("prose");
	const body = { recordId, facets, rationale, ...(prose !== undefined ? { prose } : {}) };
	const res = await call("POST", cellPath("/context-changes"), body, key);
	const out = await must(res, "the decision");
	console.log(`${out.kind}: ${out.recordId} v${out.version}  commit ${out.commitSha.slice(0, 7)}  observed by the cell: ${out.observed}${res.status === 200 ? "  (replayed)" : ""}`);
	if (out.decisionPath) console.log(`decision file: ${out.decisionPath}`);
	await sleep(1500);
	await status();
}

// ---- register / update ----
function headOf() {
	const head = one("head", true);
	if (head === "none") return null;
	if (!SHA_RE.test(head)) fail("--head is a 40-character commit sha, or none when the work is not in git");
	return head;
}

/** Claims for the facets of `depends` (record -> facets), at each record's current version. */
function claimsFor(snap, claimArgs, factToRecord) {
	return claimArgs.flatMap((arg) => splitPairs(arg, "=")).map(([subject, value]) => {
		const recordId = factToRecord.get(subject);
		if (!recordId) fail(`--claim ${subject}: that facet is not one this work item depends on (${[...factToRecord.keys()].join(", ")})`);
		return { subject, value: parseValue(value), basedOn: `${recordId}@${snap.records[recordId].current}` };
	});
}

async function register() {
	const wi = one("wi", true);
	const title = one("title", true);
	const depends = splitPairs(one("depends", true), ":");
	const head = headOf();
	const agent = one("agent") ?? "agent-build";
	const snap = await state();
	if (snap.workItems.some((w) => w.item.id === wi)) fail(`${wi} is already registered`);
	const facetToRecord = new Map();
	const byRecord = new Map();
	for (const [recordId, facet] of depends) {
		if (!snap.records[recordId]) fail(`no accepted version of ${recordId}`);
		if (!(facet in snap.records[recordId].versions[String(snap.records[recordId].current)].facets)) fail(`${recordId} has no facet ${facet}`);
		facetToRecord.set(facet, recordId);
		byRecord.set(recordId, [...(byRecord.get(recordId) ?? []), facet]);
	}
	one("claim", true);
	const claims = claimsFor(snap, flags.claim, facetToRecord);
	const baseline = await baselineRepoOf();
	const name = `${baseline.replace(/-baseline$/, "")}-${wi.toLowerCase()}`;
	const pointer = { workItem: wi, head, note: `${title}. This fork is a pointer to the real work, not the work itself. The claims are what we declare it holds.` };
	// Rerunnable: if an earlier run made the fork but stopped before registering it, use it as it is.
	const existing = await call("GET", `/api/repos/${name}/log?limit=1`);
	if (existing.status === 200 && existing.json?.commits?.length > 0) console.log(`fork ${name} already exists; registering it as it is`);
	else await must(await call("POST", "/api/smoke/pointer-fork", { baseline, name, claims, pointer }), "creating the pointer fork (needs ENABLE_SMOKE=1)");
	const dependencies = [...byRecord].map(([recordId, facetKeys]) => ({ recordId, facetKeys }));
	await must(await call("POST", cellPath("/work-items"), { id: wi, title, forkRepo: name, agent: { id: agent }, requires: ["human-resolution"], dependencies }, `dogfood-register-${cell}-${wi}`), `registering ${wi}`);
	console.log(`registered ${wi} with fork ${name}`);
	await waitForHeads([wi]);
	await status();
}

/** A human's revalidate: the work is stale, and the real work will be redone elsewhere. Binds to what the console would bind to. */
async function revalidate() {
	const wi = one("wi", true);
	const rationale = one("rationale", true).trim();
	const key = one("idempotency-key", true);
	if (rationale.includes("\n") || rationale.length > 300) fail("--rationale is one neutral line of at most 300 characters");
	const snap = await state();
	const item = snap.workItems.find((w) => w.item.id === wi);
	if (!item) fail(`no work item ${wi}`);
	if (!item.headSha) fail(`${wi} has no push yet: a resolution binds to a specific head`);
	// The record to bind to is one the work is stale or in conflict on; any current record would bind, this is the one that matters.
	const condition = item.conditions.find((c) => c.type !== "Fresh" && c.recordRefs?.length > 0);
	if (!condition) fail(`${wi} is not stale or in conflict (${item.conditions.map((c) => c.type).join(", ") || "no conditions"}); there is nothing to revalidate`);
	const recordId = condition.recordRefs[0].split("@")[0];
	const history = snap.records[recordId];
	const record = history?.versions[String(history.current)];
	if (!record) fail(`no accepted version of ${recordId}`);
	const binding = { recordId, version: record.version, blobHash: record.blobHash, baseSha: snap.baselineCommit, forkHeadSha: item.headSha, contextSnapshotHash: snap.snapshotHash };
	const out = await must(await call("POST", cellPath(`/work-items/${wi}/resolutions`), { kind: "revalidate", rationale, binding }, key), "the revalidate");
	console.log(`revalidate recorded for ${wi} (ledger line ${out.seq}); nothing is dispatched here. Redo the real work, then: dogfood.mjs update --wi ${wi} --claim ... --head <sha>`);
	await sleep(1000);
	await status();
}

async function update() {
	const wi = one("wi", true);
	const head = headOf();
	const snap = await state();
	const item = snap.workItems.find((w) => w.item.id === wi);
	if (!item) fail(`no work item ${wi}`);
	if (item.item.status !== "revalidating" && !flags.force) {
		console.error(`${wi} is ${item.item.status}, not revalidating. Without a revalidate the Worker issues no new receipt, so the new claims would be judged against the old one and the item stays stale. Run: dogfood.mjs revalidate --wi ${wi} ... first, or pass --force to push the pointer anyway.`);
		process.exit(3);
	}
	const factToRecord = new Map(snap.dependencies.filter((d) => d.workItemId === wi && d.status === "accepted").flatMap((d) => d.facetKeys.map((f) => [f, d.recordId])));
	one("claim", true);
	const claims = claimsFor(snap, flags.claim, factToRecord);
	const pointer = { workItem: wi, head, note: `${item.item.title}. Updated after the real work was redone; the claims are what we declare it holds now.` };
	const pushed = await must(await call("POST", "/api/smoke/pointer-push", { repo: item.item.forkRepo, claims, pointer }), "pushing the pointer (needs ENABLE_SMOKE=1)");
	console.log(`pushed ${pushed.commit.slice(0, 7)} to ${pushed.repo}`);
	const t0 = Date.now();
	while (Date.now() - t0 < 60_000 && (await state()).workItems.find((w) => w.item.id === wi)?.headSha !== pushed.commit) await sleep(1000);
	await status();
}

try {
	await { seed, status, decide, revalidate, register, update }[command]();
} catch (error) {
	console.error(error instanceof HttpFailure ? error.message : `unexpected error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
