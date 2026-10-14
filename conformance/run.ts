/**
 * Convergence Protocol conformance runner.
 *
 *   node conformance/run.ts --impl "<shell command>" [--filter R3] [--filter worked-example] [--jobs 8] [--verbose]
 *
 * For each vector in conformance/vectors/ it starts the command, writes `{given, when}` as JSON to its stdin,
 * reads `{state, effects}` as JSON from its stdout, projects both sides to the normative fields and compares
 * them. Prints a pass/fail table and a summary line; exits 1 if any vector fails, 2 on bad usage.
 */
import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { filterVectors, loadVectors, runVectors } from "./lib/runner.ts";

const USAGE = 'usage: node run.ts --impl "<shell command>" [--filter <rule or id>]... [--jobs N] [--timeout ms] [--verbose]';

const { values } = parseArgs({
	options: {
		impl: { type: "string" },
		filter: { type: "string", multiple: true, default: [] },
		jobs: { type: "string" },
		timeout: { type: "string" },
		verbose: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
});

if (values.help || !values.impl) {
	console.error(USAGE);
	process.exit(values.help ? 0 : 2);
}

const vectors = filterVectors(loadVectors(), values.filter);
if (vectors.length === 0) {
	console.error(`no vectors match ${values.filter.join(", ")}`);
	process.exit(2);
}

const results = await runVectors({
	impl: values.impl,
	vectors,
	jobs: values.jobs ? Number(values.jobs) : Math.min(8, availableParallelism()),
	timeoutMs: values.timeout ? Number(values.timeout) : 20_000,
});

const width = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
	console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(width)}  ${r.rules.join(",")}`);
	if (!r.pass) for (const line of values.verbose ? r.problems : r.problems.slice(0, 4)) console.log(`        ${line}`);
}

const failed = results.filter((r) => !r.pass);
const byRule = new Map<string, { pass: number; total: number }>();
for (const r of results) {
	for (const rule of r.rules) {
		const tally = byRule.get(rule) ?? { pass: 0, total: 0 };
		tally.total += 1;
		if (r.pass) tally.pass += 1;
		byRule.set(rule, tally);
	}
}
const rules = [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true })).map(([rule, t]) => `${rule} ${t.pass}/${t.total}`);
console.log("");
console.log(`by rule: ${rules.join("  ")}`);
console.log(`${failed.length === 0 ? "PASS" : "FAIL"}: ${results.length - failed.length}/${results.length} vectors passed (protocol convergence/0.1)`);
process.exit(failed.length === 0 ? 0 : 1);
