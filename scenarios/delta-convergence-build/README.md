# Delta Convergence governs its own build

> **Retrofitted from this repo's git history: these decisions were made before Delta Convergence was recording them; the replay reconstructs them. Dependencies are declared by us. No automated evidence: humans resolve.**

This is a replay, not a live run. While building Delta Convergence we changed our own accepted decisions mid-flight, and each change left some of our own work built on the old version. This package writes those decisions down as context records, declares what each piece of work relied on, and replays the real changes through the real `reconcile`.

Nothing here was detected by Delta Convergence at the time. The records, the dependency lists and the order of events are our reconstruction, and the reasoning is only as good as the dependencies we declared.

The scenario is a fixture, like `shelter-intake`: plain data, built by `buildDogfoodBuildScenario()`, ready for the console to pick up later.

## The six decisions

| Record | What it decides | Facets | Changes in the replay |
| --- | --- | --- | --- |
| `evidence-policy` | What counts as a contract test | `evidence.counts-as-test`, `evidence.claims-check-role`, `evidence.required-facets` | v1 to v2, then v3 |
| `scenario-naming` | Name of the fictional county and its volunteer network | `scenario.county`, `scenario.network` | v1 to v2 (network never moves) |
| `scenario-plan` | How the second act of the demo is shown | `scenario.second-act`, `scenario.second-act-mode` | none (a live v2 happens later, in the live cell) |
| `product-naming` | The public name and the banned shorthand | `naming.public-name`, `naming.bare-delta` | v2 changes wording only (negative control) |
| `positioning` | The headline claims | `positioning.llm-claim`, `positioning.tagline` | none |
| `demo-identity` | The label on the demo identity | `identity.label` | none |

Every record is accepted by the `decision-owner` role. There is no `validation:` path, so no check is attached to any record.

## The seven pieces of work

Each one requires a human resolution, starts `running`, and declares the facets it relied on. Nothing relies on a whole record.

| Item | Work | Relies on |
| --- | --- | --- |
| WI-1 | M4 revalidate loop (PR #6) | `evidence.counts-as-test`, `evidence.claims-check-role`, `evidence.required-facets` |
| WI-2 | Console evidence labels (PR #7) | `evidence.counts-as-test`, `evidence.claims-check-role`, `naming.public-name` |
| WI-3 | Video script | `evidence.counts-as-test`, `scenario.county`, `scenario.second-act-mode` |
| WI-4 | Shelter fixtures (PRs #3 and #4) | `scenario.county` |
| WI-5 | Shared brief (Notion) | `scenario.county`, `scenario.second-act-mode` |
| WI-6 | README | `positioning.llm-claim`, `positioning.tagline`, `scenario.second-act-mode` |
| WI-7 | Console identity header | `identity.label` (the negative control: it stays untouched throughout) |

## The events

| Step | Change | Commit | PR | What the replay shows |
| --- | --- | --- | --- | --- |
| seed | Evidence policy v1: the claims check counts as a test | `2cf1f2e` | #6 | The starting state. Naming v1 ("Cedar County") first appears in `61867a9` (PR #3), which is the baseline commit of the replay |
| 1 | Evidence policy v2: only a check Delta Convergence runs counts; the claims check is informational | `163cb45` | #6 | WI-1, WI-2, WI-3 go stale. WI-4 to WI-7 are untouched (`NO_DEPENDENCY_ON_CHANGED_FACETS`) |
| 2 | Scenario naming v2: Cedar County becomes Larkhaven County | `59d48e4` (Cedar first appears in `61867a9`, `faf83a8`) | #4 (Cedar: #3) | WI-3, WI-4, WI-5 go stale. WI-1, WI-2, WI-6, WI-7 are untouched |
| 3 | Product naming v2: wording only, no facet moves | none (illustrative) | none | `NO_ACTION` with `PROSE_ONLY`. Nothing is re-evaluated |
| 4 | Evidence policy v3: run checks take the facets they assert from the receipt | `cd31c39` | #6 | After a human revalidates WI-1 to WI-5, only WI-1 goes stale again: it is the only item that relies on `evidence.required-facets` |
| all | (no change to the demo identity label) | | | WI-7 never goes stale |

Fork heads and receipts use the real shas where a commit exists: WI-1 `2cf1f2e`, WI-2 the tip of the `console/m4-followups` branch (PR #7) when this was written, WI-3 `faf83a8`, WI-4 `61867a9`, WI-6 the tip of `cloud/t9-readme` (PR #1), WI-7 `2181838`. WI-5 is a placeholder because the shared brief lives in Notion, not in git. Branch tips can move; the shas in this fixture do not.

## What is real and what is not

Real: the commits and PR numbers in the table, the values of every facet (they are the values the repo held at those commits), and the engine. The test drives the real `reconcile` through the real ledger on both the in-memory store and the Durable Object stand-in.

Reconstructed by us:

- **The dependencies.** We declared them after the fact. Delta Convergence did not infer them.
- **The order.** The replay tells the story in the order evidence, naming, prose edit, evidence again. The commits were not made in that order: the county rename (`59d48e4`, 23:11 US Eastern on Oct 12) landed before the evidence policy commits (`2cf1f2e`, `163cb45`, `cd31c39`, from 23:47 on Oct 12 to 00:18 on Oct 13). Replay timestamps are replay time, not commit time.
- **The prose-only edit** in step 3 has no commit. It is the negative control, added so the replay shows a change that must not move anything.
- **The resolutions.** In step 4 the test records a human revalidation of WI-1 to WI-5 by the `decision-owner` role, so that the last change can be seen reaching only the item that relies on it. These are scripted for the replay.

No claims and no evidence are recorded. Each fork is pushed with an empty claims file, so every item carries an `Uncertain` condition with `NO_CLAIMS`, honestly. There is no check to run and no agent output to compare. Humans resolve.

## Layout

```
src/records.ts   the six records (ten versions) as real Markdown with front matter, parsed by the real parser
src/index.ts     actors, work items, dependencies, receipts and every event, via buildDogfoodBuildScenario()
```

## Where it is tested

`packages/delta-core/src/dogfood-build.test.ts` drives the scripted sequence through `processEvent` and asserts the reason codes at each step. `packages/delta-core/src/testing/scenarios.ts` also runs the named invariants against this fixture.

The console is not wired to this package yet.
