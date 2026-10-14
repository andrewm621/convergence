import { describe, expect, it } from "vitest";
import { loadVectors, runVectors, type VectorResult } from "../lib/runner.ts";
import { adapterCommand } from "./paths.ts";

const vectors = loadVectors();
const failing = (results: VectorResult[]): string[] => results.filter((r) => !r.pass).map((r) => r.id);

describe("the reference engine passes every vector", () => {
	it("100% against adapters/reference.ts", async () => {
		const results = await runVectors({ impl: adapterCommand("reference.ts"), vectors, jobs: 4 });
		expect(failing(results)).toEqual([]);
		expect(results).toHaveLength(vectors.length);
	});
});

/** The suite must tell a broken implementation from a conforming one, and point at the rule it breaks. */
describe("the vectors catch broken implementations", () => {
	it("an engine that never tracks staleness fails the R1 vectors, and still passes the ones staleness cannot touch", async () => {
		const failed = failing(await runVectors({ impl: adapterCommand("broken.ts", "ignore-staleness"), vectors, jobs: 4 }));
		expect(failed).toEqual(
			expect.arrayContaining(["we-01-decision-changes-mid-flight", "r1-02-whole-record-dependency-sees-added-facet", "r1-09-shelter-intake-policy-v2", "r5-09-stale-work-cannot-be-promoted"]),
		);
		expect(failed).not.toEqual(expect.arrayContaining(["r1-03-prose-only-edit"]));
		expect(failed).not.toContain("r3-04-missing-claims-fail-closed");
		expect(failed).not.toContain("r9-05-same-commit-other-repo");
	});

	it("an engine whose gate forgets receipts is caught promoting stale work", async () => {
		const results = await runVectors({ impl: adapterCommand("broken.ts", "promote-superseded"), vectors, jobs: 4 });
		expect(failing(results)).toEqual(["r5-09-stale-work-cannot-be-promoted"]);
		const problem = results.find((r) => !r.pass)?.problems.join("\n") ?? "";
		expect(problem).toContain("ALLOW_PROMOTION");
		expect(problem).toContain("BLOCK_PROMOTION");
	});

	it("an engine without an idempotency table fails exactly the R9 duplicate vectors", async () => {
		const failed = failing(await runVectors({ impl: adapterCommand("broken.ts", "skip-dedupe"), vectors, jobs: 4 }));
		expect(failed).toEqual(["r9-01-replayed-push", "r9-02-command-retried", "r9-03-key-reused-for-another-request", "r9-04-command-with-another-timestamp", "r9-06-register-twice"]);
	});

	it("output that is not a result fails every vector with a reason, not a crash", async () => {
		const sample = vectors.slice(0, 3);
		const notJson = await runVectors({ impl: `${JSON.stringify(process.execPath)} -e "process.stdout.write('nope')"`, vectors: sample });
		expect(notJson.map((r) => r.pass)).toEqual([false, false, false]);
		expect(notJson[0]?.problems[0]).toContain("not one JSON document");
		const crashed = await runVectors({ impl: `${JSON.stringify(process.execPath)} -e "process.exit(3)"`, vectors: sample });
		expect(crashed[0]?.problems[0]).toContain("exited with code 3");
	});
});
