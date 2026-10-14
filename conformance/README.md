# Convergence Protocol conformance kit

Test vectors and a runner for checking an implementation of the [Convergence Protocol v0.1](../docs/PROTOCOL.md) from the outside, in any language. Your implementation is a command that reads one JSON document on stdin and writes one on stdout. The kit never links against your code.

## Run it

Against the reference engine (`packages/delta-core`):

```bash
pnpm install
pnpm conformance                       # every vector
pnpm conformance --filter R3           # vectors tagged with rule R3 (exact match; R3b is separate)
pnpm conformance --filter worked-example
```

Against your own implementation, from the repository root:

```bash
node conformance/run.ts --impl "python3 my_engine.py"
node conformance/run.ts --impl "./target/release/my-engine" --filter R7 --verbose
```

The runner needs Node 26 or later and nothing else. It prints one PASS or FAIL line per vector, a tally by rule and a summary line. It exits 0 if every selected vector passed, 1 if any failed and 2 on bad usage. Options: `--filter` (repeatable; matches a rule tag, a sequence name or part of a vector id), `--jobs N` (processes at once), `--timeout ms` (per vector) and `--verbose` (every difference, not the first four).

## The contract

For each vector the runner starts your command once and writes this to its stdin:

```json
{ "given": { "state": <CellState>, "policy": <Policy> }, "when": { "event": <DeltaEvent> } }
```

Your command applies the one event to the state under the policy, as `reconcile(state, event, policy)` does in section 3.11, and writes this to stdout:

```json
{ "state": <CellState>, "effects": [<Effect>, ...] }
```

It should then exit 0. A non-zero exit, a timeout, or output that is not one JSON object with a `state` object and an `effects` array fails the vector.

The objects are the ones in [`packages/contracts/schema`](../packages/contracts/schema): `cell-state.json`, `policy.json`, `delta-event.json` and `effect.json`. Two details of `CellState` matter for a foreign implementation:

- `processed` is the rule R9 dedupe table, keyed by the dedupe keys of section 3.11. For a command (`DependencyDecided`, `ResolutionRecorded`, `PromotionRequested`) the value is the canonical JSON of the whole command event, so that a reused key with a different body can be told apart from a replay. For every other event it is the empty string.
- `conditions` on a work item are what the previous events left. Rules are level-triggered: a condition that has not changed keeps its original `observedAt`.

## What is compared

Both your output and the expected result are projected to the normative fields of section 4 (`lib/project.ts`) and compared as canonical JSON:

- **State:** the baseline commit and snapshot hash; per record, the accepted head, the versions seen and the proposed version; per work item, its status, its conditions (type and reason codes), its head, its receipt's `contextPacketHash`, whether a revalidation is under way, the revalidation count, the kinds of its recorded resolutions and whether it holds a promotion approval; every dependency (work item, record, facet keys, basis, status); and the keys of `processed`.
- **Effects:** type, reason codes, `workItemId` and `recordId` where present, the condition type of `RECORD_CONDITION`, the fork head and baseline commit of `ALLOW_PROMOTION`, and the mode and facet diff of `DISPATCH_WORK` and `REQUEST_REVALIDATION`.

Not compared: `message` text, `observedAt`, a condition's `recordRefs` and `facetKeys`, the evidence and claims a work item caches, the order of effects (they are compared as a multiset) and the order of reason codes in a list.

## The vectors

`vectors/*.json`, one file per vector:

```json
{
  "protocol": "convergence/0.1",
  "id": "r6-04-nothing-to-revalidate",
  "description": "Revalidating WI-1, which is fresh, is refused (NOTHING_TO_REVALIDATE); no run is dispatched.",
  "rules": ["R6"],
  "polarity": "negative",
  "fixture": "notifications",
  "given": { "state": { ... }, "policy": { ... } },
  "when": { "event": { ... } },
  "then": { "state": { ... }, "effects": [ ... ] }
}
```

- `rules` names the rules the vector exercises: `R1` to `R9`, and `R3b` for cross-claim conflicts. Every rule has at least one `positive` vector (the rule acts: it stales, flags, blocks, refuses or dedupes) and one `negative` vector (a near miss the rule must leave alone or let through).
- `fixture` is the scenario the starting state comes from: `notifications` (code), `sales-ops` and `shelter-intake` (synthetic knowledge work) or `delta-convergence-build` (this repository's own decisions, replayed). Every name in them is synthetic or a demo identity.
- The worked example of section 2 is the sequence `we-01` to `we-11`, tagged `"sequence": {"name": "worked-example", "step": n}`. Each step's `given.state` is where the previous step ended.
- `then` holds only the projection described above.

The vectors are generated from the reference engine by `scripts/vectors.ts`; re-running it gives byte-identical files (canonical JSON, keys sorted). After an intended change to the engine or a fixture:

```bash
pnpm --filter conformance vectors      # rewrite vectors/, then review the diff
```

`pnpm --filter conformance test` fails if the committed vectors drift from the generator, if a vector's inputs do not satisfy the contracts, or if the worked example's steps do not chain. It also runs the kit against the reference (every vector must pass) and against three deliberately broken engines in `adapters/broken.ts` (never tracks staleness, promotes stale work, no idempotency table), each of which must fail the vectors for the rule it breaks.

## What passing means

Passing means your implementation produced the same normative state and effects as the reference engine on these vectors: the same statuses, condition types, effect types and reason codes for the same inputs. The vectors are a sample. They are not a proof that the rules hold for every input.

Passing does not certify anything the kit cannot see from one `reconcile` call:

- the adapter: observing git or Artifacts, issuing receipts and git notes, running checks, merging;
- security and authorization: who may write the baseline, whether `accepted_by` is authentic, whether evidence comes from the implementation rather than the agent (rules R1 and R8 leave these to the adapter);
- the ledger hash chain, atomic commit of state and ledger, record parsing and the receipt note bytes. This repository's own tests cover those for the reference implementation (see section 4 of the protocol).

The kit validates vector inputs with the Zod contracts in `packages/contracts`, which the JSON Schemas are generated from. It does not run a JSON Schema validator.
