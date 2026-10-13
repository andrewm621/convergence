// Reads Claude Code's stream-json on stdin. Keeps the raw stream in --raw and appends short, redacted activity
// lines {workItemId, ts, kind, text} to --events. Always exits 0: run-agent.sh decides success from the last line.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { summarizeStreamLine } from "./claude-stream-lib.ts";

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const events = arg("events");
const raw = arg("raw");
const workItemId = arg("work-item") ?? "";
if (!events || !raw) {
	console.error("usage: claude-events.mjs --events FILE --raw FILE --work-item ID");
	process.exit(2);
}

for await (const line of createInterface({ input: process.stdin })) {
	appendFileSync(raw, `${line}\n`);
	for (const a of summarizeStreamLine(line)) {
		appendFileSync(events, `${JSON.stringify({ workItemId, ts: new Date().toISOString(), kind: a.kind, text: a.text })}\n`);
	}
}
