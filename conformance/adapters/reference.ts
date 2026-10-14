/**
 * The reference engine (delta-core) as a stdin/stdout implementation for the conformance runner.
 *
 *   stdin:  {"given": {"state": CellState, "policy": Policy}, "when": {"event": DeltaEvent}}
 *   stdout: {"state": CellState, "effects": Effect[]}
 *
 * Inputs are validated with the Zod contracts (fail closed: a non-zero exit, the reason on stderr).
 * Run with: node --import ./ts-hooks.mjs adapters/reference.ts
 */
import { CellState, DeltaEvent, Policy } from "contracts";
import { reconcile } from "delta-core";
import { readStdin } from "./stdio.ts";

export type Reconciler = (state: CellState, event: DeltaEvent, policy: Policy) => { state: CellState; effects: unknown[] };

export async function serve(reconciler: Reconciler): Promise<void> {
	try {
		const input = JSON.parse(await readStdin()) as { given?: { state?: unknown; policy?: unknown }; when?: { event?: unknown } };
		const state = CellState.parse(input.given?.state);
		const policy = Policy.parse(input.given?.policy);
		const event = DeltaEvent.parse(input.when?.event);
		process.stdout.write(`${JSON.stringify(reconciler(state, event, policy))}\n`);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await serve(reconcile);
