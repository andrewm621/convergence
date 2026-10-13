import { describe, expect, it } from "vitest";
import type { DeltaEvent } from "contracts";
import { evaluateGate } from "./gate";
import { conditionTypes, createCell, resolutionEvent, type Cell } from "./testing/harness";
import { notifications as n } from "./testing/scenarios";

// Rule R8 is "Delta-run, not agent-run". The Worker also compares an agent's claims with the receipt it issued
// (Evidence kind `delta-claims-check`), but that is derived from the agent's own word, so the reconciler must
// never let it stand in for a record's `validation:` check, or let it fail or overwrite one.

const CHECKS = [n.docs.notificationsV2.snapshot.validation as string, n.docs.statusModelV1.snapshot.validation as string];
const T = "2026-10-13T17:00:00Z";

/** WI-2 (requires a contract test) revalidated and pushed, fresh and with correct claims, and no test result yet. */
async function pushedFresh(): Promise<Cell> {
	const c = await createCell(n.seed, n.policy);
	await c.send(n.events.registerWi1);
	await c.send(n.events.registerWi2);
	await c.send(n.events.v2);
	await c.send(n.events.wi2PushedV1);
	await c.send(resolutionEvent(await c.state(), { kind: "revalidate", workItemId: "WI-2", recordId: "notifications", actor: n.actors.decisionOwner, requestId: "rv-1", ts: T }));
	await c.send(n.events.wi2ReceiptIssued);
	await c.send(n.events.wi2PushedRevalidated);
	return c;
}

const evidence = (check: string, pass: boolean, kind?: "delta-claims-check" | "delta-run-check"): DeltaEvent => ({
	type: "EvidenceRecorded",
	ts: T,
	repo: n.workItems.wi2.forkRepo,
	commitSha: n.commits.wi2HeadRevalidated,
	runId: `run-${check}-${pass}-${kind ?? "plain"}`,
	evidence: { workItemId: "WI-2", headSha: n.commits.wi2HeadRevalidated, check, pass, output: "x", ...(kind ? { kind } : {}) },
});

describe("claims-check evidence never satisfies a validation check", () => {
	it("[negative] passing claims-check evidence under every validation path leaves the contract-test requirement unmet", async () => {
		const c = await pushedFresh();
		for (const check of CHECKS) await c.send(evidence(check, true, "delta-claims-check"));
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.promotable).toBe(false);
		expect(gate.reasonCodes).toContain("MISSING_EVIDENCE");
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("TestsPassed");
	});

	it("[negative] failing claims-check evidence is not a failed test: no TEST_FAILED, no TestFailed condition", async () => {
		const c = await pushedFresh();
		for (const check of CHECKS) await c.send(evidence(check, false, "delta-claims-check"));
		const gate = evaluateGate(await c.state(), "WI-2", n.policy);
		expect(gate.reasonCodes).not.toContain("TEST_FAILED");
		expect(conditionTypes(await c.wi("WI-2"))).not.toContain("TestFailed");
	});

	it("[negative] it cannot overwrite a real result for the same check and head, in either direction", async () => {
		const c = await pushedFresh();
		for (const check of CHECKS) {
			await c.send(evidence(check, true, "delta-run-check"));
			await c.send(evidence(check, false, "delta-claims-check"));
		}
		expect(evaluateGate(await c.state(), "WI-2", n.policy)).toMatchObject({ promotable: true, reasonCodes: [] });
		expect((await c.wi("WI-2")).evidence.filter((e) => e.pass).length).toBe(CHECKS.length);

		const d = await pushedFresh();
		await d.send(evidence(CHECKS[0] as string, false, "delta-run-check"));
		await d.send(evidence(CHECKS[0] as string, true, "delta-claims-check"));
		expect(evaluateGate(await d.state(), "WI-2", n.policy).reasonCodes).toContain("TEST_FAILED");
	});

	it("[positive] delta-run-check evidence satisfies the check like any test result, and the claims check beside it changes nothing", async () => {
		const c = await pushedFresh();
		for (const check of CHECKS) await c.send(evidence(check, true, "delta-run-check"));
		await c.send(evidence("delta:claims-vs-receipt", true, "delta-claims-check"));
		expect(evaluateGate(await c.state(), "WI-2", n.policy)).toMatchObject({ promotable: true, reasonCodes: [] });
		expect(conditionTypes(await c.wi("WI-2"))).toEqual(n.expected.afterRevalidation["WI-2"].conditions);
	});
});
