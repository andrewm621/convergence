// CLI wrapper for the scripted agent. Runs inside the container: node stub-agent.mjs --repo DIR --work-item ID
// Activity is appended to --events as JSON lines {workItemId, ts, kind, text}.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runStubAgent } from "./stub-agent-lib.ts";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const repo = arg("repo");
const workItemId = arg("work-item");
const eventsFile = arg("events");
const stepMs = Number(arg("step-ms", "0"));
if (!repo || !workItemId) {
	console.error("usage: stub-agent.mjs --repo DIR --work-item ID [--events FILE] [--step-ms N]");
	process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (kind, text) => {
	const line = JSON.stringify({ workItemId, ts: new Date().toISOString(), kind, text });
	if (eventsFile) appendFileSync(eventsFile, `${line}\n`);
	else console.log(line);
};

function readContext(dir) {
	const out = {};
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir).sort()) {
		if (name.endsWith(".md")) out[name] = readFileSync(join(dir, name), "utf8");
	}
	return out;
}

say("read", "reading AGENTS.md and the context records");
// .delta/context/ (what the control plane delivered) wins over context/ (the seeded copy) by file name.
const merged = { ...readContext(join(repo, "context")), ...readContext(join(repo, ".delta", "context")) };
const contextFiles = Object.fromEntries(Object.entries(merged).map(([name, text]) => [`context/${name}`, text]));
await sleep(stepMs);

// A revalidation run carries the receipt of what the control plane delivered; the stub covers exactly those records.
let deliveredIds = null;
const receiptPath = join(repo, ".delta", "receipt.json");
if (existsSync(receiptPath)) {
	try {
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		if (Array.isArray(receipt.delivered)) deliveredIds = receipt.delivered.map((d) => String(d.recordId));
	} catch {
		// an unreadable receipt leaves the title heuristic in place
	}
}

const result = runStubAgent({
	workItemId,
	prompt: process.env.AGENT_PROMPT ?? "",
	contextFiles,
	deliveredIds,
});
say("plan", result.summary);
await sleep(stepMs);

for (const [path, content] of Object.entries(result.files)) {
	const full = join(repo, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	say("write", path);
	await sleep(stepMs);
}
say("done", `${result.claims.length} claim(s) written to .delta/claims.json`);
