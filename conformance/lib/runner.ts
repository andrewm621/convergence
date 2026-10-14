import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL, canonical, diffProjections, project, type Vector } from "./project.ts";

export type VectorResult = { id: string; rules: string[]; pass: boolean; ms: number; problems: string[] };

export type RunOptions = {
	/** Shell command that starts the implementation under test. One process per vector. */
	impl: string;
	vectors: Vector[];
	/** Processes to run at once. */
	jobs?: number;
	/** Per-vector timeout. */
	timeoutMs?: number;
	cwd?: string;
};

export const VECTORS_DIR = new URL("../vectors/", import.meta.url);

/** Every vector in a directory, in file-name order. */
export function loadVectors(dir: string | URL = VECTORS_DIR): Vector[] {
	const path = dir instanceof URL ? fileURLToPath(dir) : dir;
	return readdirSync(path)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const vector = JSON.parse(readFileSync(join(path, name), "utf8")) as Vector;
			if (vector.protocol !== PROTOCOL) throw new Error(`${name}: protocol is ${String(vector.protocol)}, expected ${PROTOCOL}`);
			return vector;
		});
}

/** Keep vectors that exercise one of `filters` (a rule such as "R3", matched exactly), belong to a sequence of that name, or whose id contains it. */
export function filterVectors(vectors: Vector[], filters: string[]): Vector[] {
	if (filters.length === 0) return vectors;
	return vectors.filter((v) => filters.some((f) => v.rules.some((rule) => rule.toLowerCase() === f.toLowerCase()) || v.sequence?.name === f || v.id.includes(f)));
}

type Spawned = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function runProcess(command: string, input: string, timeoutMs: number, cwd: string | undefined): Promise<Spawned> {
	return new Promise((resolve) => {
		const child = spawn(command, { shell: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
		child.stdin.on("error", () => {
			// The implementation may exit without reading stdin; the exit code reports it.
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr: stderr + String(error), timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
		child.stdin.end(input);
	});
}

/** Run one vector: write `{given, when}` to the implementation's stdin, read `{state, effects}` from its stdout, compare the projections. */
export async function runVector(vector: Vector, options: Omit<RunOptions, "vectors">): Promise<VectorResult> {
	const started = performance.now();
	const done = (problems: string[]): VectorResult => ({ id: vector.id, rules: vector.rules, pass: problems.length === 0, ms: Math.round(performance.now() - started), problems });
	const spawned = await runProcess(options.impl, JSON.stringify({ given: vector.given, when: vector.when }), options.timeoutMs ?? 20_000, options.cwd);
	if (spawned.timedOut) return done(["timed out"]);
	if (spawned.code !== 0) return done([`exited with code ${String(spawned.code)}: ${spawned.stderr.trim().split("\n").slice(-3).join(" | ") || "(no stderr)"}`]);
	let output: unknown;
	try {
		output = JSON.parse(spawned.stdout);
	} catch {
		return done([`stdout is not one JSON document: ${spawned.stdout.slice(0, 120)}`]);
	}
	const shape = output as { state?: unknown; effects?: unknown } | null;
	if (shape === null || typeof shape !== "object" || typeof shape.state !== "object" || shape.state === null || !Array.isArray(shape.effects)) {
		return done(["stdout must be an object with a `state` object and an `effects` array"]);
	}
	const actual = project(output);
	if (canonical(actual) === canonical(vector.then)) return done([]);
	return done(diffProjections(vector.then, actual));
}

/** Run every vector, `jobs` at a time. Results come back in vector order. */
export async function runVectors(options: RunOptions): Promise<VectorResult[]> {
	const results: VectorResult[] = new Array(options.vectors.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < options.vectors.length) {
			const index = next++;
			results[index] = await runVector(options.vectors[index] as Vector, options);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(options.jobs ?? 4, options.vectors.length)) }, worker));
	return results;
}
