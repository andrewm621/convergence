import { describe, expect, it } from "vitest";
import type { Actor, DeltaEvent, Policy, ReconciliationEvent } from "contracts";
import type { CellStateInit } from "../cell-state";
import { verifyChain } from "../ledger";
import type { CellStore } from "../store";
import { conditionTypes, createCell, effectTypes, reasonsOf, resolutionEvent } from "./harness";

/**
 * What the named invariants need from a scenario. Both fixtures supply one, and the same five
 * tests then run against each, on every store.
 */
export type InvariantScenario = {
	label: string;
	seed: CellStateInit;
	policy: Policy;
	human: Actor;
	agent: Actor;
	/** The record whose accepted version changes. */
	recordId: string;
	/** Register everything and bring both items to a settled state. */
	setup: DeltaEvent[];
	/** Work that depends on the changed facets, and the unaffected control. */
	affectedId: string;
	controlId: string;
	/** Extra events that give the control a head, claims and evidence before the change. */
	controlPrep: DeltaEvent[];
	/** Extra events that give the affected item a head and claims before the change. */
	affectedPrep: DeltaEvent[];
	/** A real facet change to `recordId`. */
	contextChange: DeltaEvent;
	/** A prose-only edit to `recordId`. */
	proseOnly: DeltaEvent;
};

export function describeInvariants(storeLabel: string, makeStore: () => CellStore, scenarios: InvariantScenario[]): void {
	for (const sc of scenarios) {
		describe(`named invariants: ${sc.label} on ${storeLabel}`, () => {
			async function ready() {
				const cell = await createCell(sc.seed, sc.policy, makeStore());
				for (const event of sc.setup) await cell.send(event);
				for (const event of [...sc.controlPrep, ...sc.affectedPrep]) await cell.send(event);
				return cell;
			}

			it("unaffected work never changes status", async () => {
				const cell = await ready();
				const controlBefore = structuredClone(await cell.wi(sc.controlId));
				const affectedBefore = (await cell.wi(sc.affectedId)).item.status;

				const result = await cell.send(sc.contextChange);

				// The control is byte-identical: status, conditions, receipt, everything.
				expect(await cell.wi(sc.controlId)).toEqual(controlBefore);
				// It is recorded as deliberately left alone, with the reason.
				const left = result.effects.find((e) => e.type === "NO_ACTION" && e.workItemId === sc.controlId);
				expect(left?.reasonCodes).toEqual(["NO_DEPENDENCY_ON_CHANGED_FACETS"]);
				// ...while the work that did depend on the change did move.
				const affectedAfter = await cell.wi(sc.affectedId);
				expect(affectedAfter.item.status).not.toBe(affectedBefore);
				expect(conditionTypes(affectedAfter)).toContain("Stale");
				expect(conditionTypes(affectedAfter)).toContain("Blocked");
			});

			it("prose-only edit stales nothing", async () => {
				const cell = await ready();
				const before = await cell.state();

				const result = await cell.send(sc.proseOnly);

				const after = await cell.state();
				expect(result.effects.map((e) => e.type)).toEqual(["NO_ACTION"]);
				expect(reasonsOf(result)).toEqual(["PROSE_ONLY"]);
				expect(effectTypes(result)).not.toContain("BLOCK_PROMOTION");
				expect(effectTypes(result)).not.toContain("REQUEST_REVIEW");
				// Every work item is untouched; only the baseline moved.
				expect(after.workItems).toEqual(before.workItems);
				expect(after.baselineCommit).not.toBe(before.baselineCommit);
				// A prose edit does not even make a new version.
				expect(after.records[sc.recordId]?.current).toBe(before.records[sc.recordId]?.current);
			});

			it("replayed event yields one ledger entry", async () => {
				const cell = await ready();
				const first = await cell.send(sc.contextChange);
				const ledgerAfterFirst = await cell.store.ledger();
				const stateAfterFirst = await cell.state();

				const replay = await cell.send(sc.contextChange);
				// Queues deliver at least once and the poller can double-fire: same (repo, commitSha), new timestamp.
				const doubleFire = await cell.send({ ...sc.contextChange, ts: "2030-01-01T00:00:00Z" });

				expect(first.outcome).toBe("applied");
				expect(replay.outcome).toBe("duplicate");
				expect(doubleFire.outcome).toBe("duplicate");
				expect(reasonsOf(replay)).toEqual(["DUPLICATE_EVENT"]);
				expect(await cell.store.ledger()).toEqual(ledgerAfterFirst);
				expect(await cell.state()).toEqual(stateAfterFirst);
				const entriesForEvent = (await cell.store.ledger()).filter((e: ReconciliationEvent) => JSON.stringify(e.payload.event) === JSON.stringify(sc.contextChange));
				expect(entriesForEvent).toHaveLength(1);
			});

			it("agent actor cannot resolve", async () => {
				const cell = await ready();
				await cell.send(sc.contextChange);
				const before = structuredClone(await cell.wi(sc.affectedId));

				for (const [i, actor] of [
					sc.agent,
					{ ...sc.agent, id: sc.human.id }, // an agent borrowing the human's id is still an agent
					{ kind: "system", id: "delta", displayName: "Delta" } as Actor,
				].entries()) {
					for (const kind of ["revalidate", "reject", "accept-exception"] as const) {
						const event = resolutionEvent(await cell.state(), {
							kind,
							workItemId: sc.affectedId,
							recordId: sc.recordId,
							actor,
							requestId: `agent-${i}-${kind}`,
							ts: "2026-10-13T17:00:00Z",
							scope: "any scope",
						});
						const result = await cell.send(event);
						expect(result.effects).toEqual([expect.objectContaining({ type: "NO_ACTION", reasonCodes: ["FORBIDDEN_ACTOR"] })]);
					}
				}

				// Nothing about the work item changed: not its status, not its resolutions, not its revalidation count.
				expect(await cell.wi(sc.affectedId)).toEqual(before);
				// The refusals are in the ledger, so they are auditable.
				const refused = (await cell.store.ledger()).filter((e) => e.type === "ResolutionRecorded");
				expect(refused).toHaveLength(9);

				// And the same event from a human is accepted.
				const ok = await cell.send(
					resolutionEvent(await cell.state(), { kind: "reject", workItemId: sc.affectedId, recordId: sc.recordId, actor: sc.human, requestId: "human-reject", ts: "2026-10-13T17:05:00Z" }),
				);
				expect(reasonsOf(ok)).toContain("RESOLUTION_REJECTED");
			});

			it("chain breaks on any edit", async () => {
				const cell = await ready();
				await cell.send(sc.contextChange);
				await cell.send(sc.proseOnly);
				const entries = await cell.store.ledger();
				expect(entries.length).toBeGreaterThanOrEqual(4);
				expect(await verifyChain(entries)).toMatchObject({ ok: true });

				const edits: Array<[string, (e: ReconciliationEvent) => void]> = [
					["payload event", (e) => ((e.payload.event as { ts: string }).ts = "2031-01-01T00:00:00Z")],
					["payload effects", (e) => e.payload.effects.push({ type: "NO_ACTION", reasonCodes: [] })],
					["ts", (e) => (e.ts = "2031-01-01T00:00:00Z")],
					["type", (e) => (e.type = e.type === "ForkPushed" ? "BaselinePushed" : "ForkPushed")],
					["policyVersion", (e) => (e.policyVersion += 1)],
					["baselineSha", (e) => (e.baselineSha = "dead000000000000000000000000000000000001")],
					["seq", (e) => (e.seq += 100)],
					["prevHash", (e) => (e.prevHash = "1".repeat(64))],
					["hash", (e) => (e.hash = "2".repeat(64))],
				];
				for (const index of [0, Math.floor(entries.length / 2), entries.length - 1]) {
					for (const [name, edit] of edits) {
						const tampered = structuredClone(entries);
						edit(tampered[index] as ReconciliationEvent);
						const verdict = await verifyChain(tampered);
						expect(verdict.ok, `${name} edit at line ${index + 1} must break the chain`).toBe(false);
					}
				}

				// A forger who recomputes one line's hash still breaks the link to the next line.
				// (Covered by the unit tests in ledger.test.ts; here we check removal and reordering.)
				expect((await verifyChain(entries.slice(1))).ok).toBe(false);
				expect((await verifyChain([...entries.slice(0, 1), ...entries.slice(2)])).ok).toBe(false);
				expect((await verifyChain([entries[1] as ReconciliationEvent, entries[0] as ReconciliationEvent, ...entries.slice(2)])).ok).toBe(false);
			});
		});
	}
}
