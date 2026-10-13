# Shelter intake: the knowledge-work scenario

> **Synthetic scenario. Not operational guidance.**
> Larkhaven County, its river flood and the Larkhaven Mutual Aid Network are invented for this fixture. Any resemblance to a real county of that name, a real event or a real organisation is coincidental. Nothing here is an alert, eligibility guidance or an operating instruction, and it should never be used as one.

This is the second proof that Delta Convergence is not a software tool. There is no repository of source files and nothing to build. A volunteer group has a written intake policy, five agents are drafting volunteer materials from it, and the policy changes while they work.

## The story

The baseline holds two accepted records:

| Record | Facets | Changes? |
| --- | --- | --- |
| `shelter-intake-policy` | `pets`, `id_required`, `capacity_note`, `hours` | v1 to v2 (pets, id_required), then v3 (capacity_note) |
| `volunteer-roles` | `greeter`, `intake_desk` | never |

`shelter-intake-policy` v2 changes two facets:

| Facet | v1 | v2 |
| --- | --- | --- |
| `pets` | service animals only | crated pets admitted, pet area in Hall B |
| `id_required` | ID required | ID not listed as a requirement |

`capacity_note` and `hours` do not change. A separate prose-only edit fixes a typo in the welcome text and moves no facet.

Five agents are drafting:

| Item | Draft | Depends on | When v2 lands |
| --- | --- | --- | --- |
| WI-1 | Front-desk intake script | `pets`, `id_required` | stale |
| WI-2 | Door signage text | `pets` | stale |
| WI-3 | Volunteer briefing one-pager | `pets`, `id_required`, `hours` | stale |
| WI-4 | Cots and blankets supply list | `capacity_note` | untouched |
| WI-5 | Shift schedule | `volunteer-roles`, `hours` | untouched |

How it resolves:

- The typo fix is `NO_ACTION` with reason `PROSE_ONLY`. Nothing goes stale.
- The three stale drafts hand in work built on v1. Their claims conflict with v2 (rule R3).
- The contract check (rule R8) runs on the script and the briefing. It asserts that the text mentions the pet area when the policy admits crated pets, and that it does not still say "ID required" once the policy no longer lists it. It fails until the draft is revalidated. It is plain text matching, not a model.
- The script and the briefing are **revalidated**: a fresh receipt at v2, the agent re-runs, its claims now say crated pets are admitted, and the check passes.
- The door signage gets a **scoped exception**: "Existing printed signs stay posted until replacements arrive; the exception expires on the next policy version." The scope is `signs/door.md`. A later v3 ends it, and the gate says `EXCEPTION_LAPSED`.
- The supply list and the shift schedule are never touched, and the ledger says why (`NO_DEPENDENCY_ON_CHANGED_FACETS`).

## Layout

```
src/records.ts     the two records as real Markdown with front matter (parsed by the real parser)
src/documents.ts   the drafts the agents produce
src/check.ts       the contract check (R8): text assertions against the accepted facets
src/index.ts       actors, work items, claims, receipts, evidence and every event, via buildShelterIntakeScenario()
```

The evidence in `index.ts` is produced by actually running `runShelterIntakeCheck` on each draft against the facets accepted at v2. Nothing is hand-marked pass or fail.

## Where it is tested and shown

- `packages/delta-core/src/shelter-intake.test.ts` drives the whole story through `processEvent` on the in-memory and the Durable Object stand-in stores.
- `packages/delta-core/src/invariants.test.ts` runs the named invariants against this fixture too (see `testing/scenarios.ts`).
- `apps/console/src/mock/script-shelter-intake.ts` replays it as nine beats in the console. Open `?mock=1&scenario=shelter-intake`.

The console keeps the "Synthetic scenario. Not operational guidance." note in view for as long as this scenario is open.
