# Convergence governs its own build

We use Convergence on the decisions that shape this repo. It runs in two modes that share one scenario, `delta-convergence-build`.

## What is governed

Six accepted decision records, each with facets the work can rely on, and seven pieces of work that declare which facets they rely on. The records and the work are in [`scenarios/delta-convergence-build`](../scenarios/delta-convergence-build/README.md).

| Record | What it decides |
| --- | --- |
| `evidence-policy` | What counts as a contract test |
| `scenario-naming` | Name of the fictional county and its volunteer network |
| `scenario-plan` | How the second act of the demo is shown |
| `product-naming` | The public name and the banned shorthand |
| `positioning` | The headline claims |
| `demo-identity` | The label on the demo identity |

The `scenario-plan` record and its "second act" wording, and the `scenario-naming` county record, reflect the earlier plan. The shelter act also runs live, but it is not in the submission video: the video's knowledge-work act is the Scranton Paper Supply replay. The record ids and example commands below keep their names.

The seven work items are WI-1 to WI-7: the M4 revalidate loop, the console evidence labels, the video script, the shelter fixtures, the shared brief, the README and the console identity header.

## The two modes

**Replay** (`?mock=1&scenario=delta-convergence-build`). Our history up to Oct 13, reconstructed from the git log and played through the real `reconcile` in the browser. The decisions were made before Convergence was recording them, so the console says "Retrofitted from this repo's git history". Nothing in it was detected at the time.

**Live since Oct 13** (`?cell=delta-convergence-build-live`, against the deployed Worker). A real cell in a Durable Object with a hash-chained ledger, watching real Artifacts repos. It does not replay history. It starts where the replay ends: all six records at their latest versions, WI-1 to WI-7 registered with a receipt at those versions, and claims that cite those versions. From there, every decision recorded with `dogfood.mjs decide` is a real ledger line, and the work that relied on the old version really goes stale. The console banner reads "Live: this repo's own build decisions since Oct 13. Earlier history is the replay."

Each live decision carries a short rationale approved by the Decision owner. It is stored in the decision file the Worker commits next to the new record version, and in the commit message.

## The guard

A cell of this scenario (its name is `delta-convergence-build`, or starts with `delta-convergence-build-`) never dispatches an agent runtime, whatever the Worker is configured with, and never merges anything.

- **Revalidate** (`dogfood.mjs revalidate`) records the resolution and moves the work item to `revalidating`. Nothing is dispatched. The activity stream says: "Human-resolved outside the console". The real work is redone in the real pull request, and then its pointer is pushed (`dogfood.mjs update`). On that push the Worker first issues the receipt at the current versions (the reconciler takes one only while a revalidation is open), then judges the new claims. Claims that cite the current versions with the current values leave the item fresh. Claims that still cite an old version or an old value surface as a `ClaimConflict`, and the item stays blocked. `update` refuses to run (exit 3) when the item is not revalidating, because without a revalidate there is no new receipt; `--force` pushes anyway.
- **Promote** is refused: `409 NOT_PROMOTABLE`, "not promotable: work items here are pointers to real PRs". Nothing reaches the baseline.
- The console disables Revalidate, Accept exception, Reject and Promote on this cell with the same tooltip as the replay: "Resolved by a human outside the console in the real build."

Tests: `apps/worker/src/cell/pointer-scenario.workerd.test.ts`.

## What a work item is here

A work item's fork is a pointer. It holds two files and nothing else: `.delta/claims.json` (what we declare the work holds, citing `record@version`) and `.delta/pointer.json` (the real commit it stands at, or `null` when the work is not in git, like the shared brief). The Worker reads the claims the way it reads any fork's.

## Commands

`scripts/dogfood.mjs` reads `WORKER_URL` and `DEV_TOKEN` from the environment or from `apps/worker/.dev.vars`, and never prints them. The cell defaults to `$DOGFOOD_CELL`, then `delta-convergence-build-live`.

```bash
# Once, with ENABLE_SMOKE=1 on the Worker: seed the repos, init the cell, register WI-1..WI-7.
node scripts/dogfood.mjs seed --cell delta-convergence-build-live

# See every work item, its conditions and its gate reason codes.
node scripts/dogfood.mjs status

# Record a decision as the Decision owner (works with smoke off).
node scripts/dogfood.mjs decide --record scenario-plan --facet scenario.second-act-mode=live \
  --rationale "Show the second act live." --idempotency-key plan-v2

# The full sequence after a decision: see what went stale, revalidate it (works with smoke off) ...
node scripts/dogfood.mjs revalidate --wi WI-4 --rationale "Redo the fixtures for the new county." --idempotency-key reval-wi-4-v3

# Register new work (needs smoke): a pointer fork plus its declared dependencies and claims.
node scripts/dogfood.mjs register --wi WI-8 --title "Demo recording" \
  --depends scenario-plan:scenario.second-act-mode,scenario-naming:scenario.county \
  --claim scenario.second-act-mode=live,scenario.county="Larkhaven County" --head none

# ... and push the pointer again after redoing the real work (needs smoke).
node scripts/dogfood.mjs update --wi WI-4 --claim scenario.county="Larkhaven County" --head <sha>
```

`--facet` and `--claim` can be repeated, and a value may contain commas (`a=x,y,b=z` reads as `a` = "x,y" and `b` = "z"). `register` can be rerun if it stopped after creating the fork. `--idempotency-key` makes a retry safe: the same key with the same request replays the first answer.

The pointer routes behind `register` and `update` only touch `smoke-delta-convergence-build-*` repos and never a baseline, so they cannot reach the repos of any other cell. `seed`, `register` and `update` create repos or commit to a fork, which the Worker only does with `ENABLE_SMOKE=1`. `decide` and `status` use the ordinary API and work with smoke off.

## Limits

- **Dependencies are declared by us.** Convergence does not infer which work relied on which decision. If we forget a dependency, nothing goes stale.
- **Humans resolve.** There is no agent in the loop. Revalidate only records that a person will redo the work elsewhere.
- **No automated evidence** for these items. They require a human resolution and no contract test; the gate has nothing to run.
- **Stale is not wrong.** It means the work was built on a version that has since been replaced. The work may well still be right.
- **No model in the loop.** Neither the cell nor the script calls a model.
- **The claims are our assertion.** The seed declares every item current at the latest versions at the moment it is seeded. That is a statement by us, not a check of the pull requests.
- The seed's product-naming record is the replay's last version, which only changes wording.
