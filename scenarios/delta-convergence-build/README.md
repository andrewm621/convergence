# Convergence governs its own build

> **Retrofitted from this repo's git history: these decisions were made before Convergence was recording them; the replay reconstructs them. Dependencies are declared by us. No automated evidence: humans resolve.**

This is a replay, not a live run. While building Convergence we changed our own accepted decisions mid-flight, and each change left some of our own work built on the old version. This package writes those decisions down as context records, declares what each piece of work relied on, and replays the real changes through the real `reconcile`.

Nothing here was detected by Convergence at the time. The records, the dependency lists and the claims are our reconstruction, and the result is only as good as the dependencies we declared.

The scenario is a fixture, like `shelter-intake`: plain data, built by `buildDogfoodBuildScenario()`, ready for the console to pick up later.

## The six decisions

| Record | What it decides | Facets | Changes in the replay |
| --- | --- | --- | --- |
| `evidence-policy` | What counts as a contract test | `evidence.counts-as-test`, `evidence.claims-check-role`, `evidence.required-facets` | v1 to v2, then v3 |
| `scenario-naming` | Name of the fictional county and its volunteer network | `scenario.county`, `scenario.network` | v1 to v2 (network never moves) |
| `scenario-plan` | How the second act of the demo is shown | `scenario.second-act`, `scenario.second-act-mode` | none (a live v2 happens later, in the live cell) |
| `product-naming` | The public name and the banned shorthand | `naming.public-name`, `naming.bare-delta` | v2 changes wording only (negative control, invented) |
| `positioning` | The headline claims | `positioning.llm-claim`, `positioning.tagline` | none |
| `demo-identity` | The label on the demo identity | `identity.label` | none |

Every record is accepted by the `decision-owner` role. There is no `validation:` path, so no check is attached to any record.

## The seven pieces of work

Each one requires a human resolution, starts `running`, declares the facets it relied on, and pushes claims for them with the values it was built against. Nothing relies on a whole record.

| Item | Work | Relies on | Head |
| --- | --- | --- | --- |
| WI-1 | M4 revalidate loop (PR #6) | `evidence.counts-as-test`, `evidence.claims-check-role`, `evidence.required-facets` | `ce882f2` (PR #6 merge) |
| WI-2 | Console evidence labels (PR #7) | `evidence.counts-as-test`, `evidence.claims-check-role`, `naming.public-name` | `6689702` (PR #7 merge) |
| WI-3 | Video script | `evidence.counts-as-test`, `scenario.county`, `scenario.second-act-mode` | `f29ac84` |
| WI-4 | Shelter fixtures (PR #4) | `scenario.county` | `3036894` (PR #4 squash merge) |
| WI-5 | Shared brief (Notion) | `scenario.county`, `scenario.second-act-mode` | not in git |
| WI-6 | README | `positioning.llm-claim`, `positioning.tagline`, `scenario.second-act-mode` | `e0710e6` (the draft README) |
| WI-7 | Console identity header | `identity.label` (the negative control: it stays untouched throughout) | `3036894` |

## The events, in commit order

Times are the commits' own author times (US Eastern). The replay applies them in this order, with these timestamps (stored as UTC). Two rows are exceptions, and the table says so: the WI-4 push and the WI-2 push are anchored to commits that are not on main (see "What is real and what is not").

| Time (ET) | Event | Commit | PR | What the replay shows |
| --- | --- | --- | --- | --- |
| Oct 12 22:16 | WI-6 pushed: the draft README | `e0710e6` | none | Claims the headline wording and "replay". Fresh |
| Oct 12 22:57 | WI-4 pushed: the first version of the shelter fixtures, which use "Cedar County". Built on a side branch that is not on main; the time cannot be checked from public history (see below) | not on main | none | Claims `scenario.county: Cedar County`. Fresh |
| Oct 12 22:58 | WI-3 pushed: the video script's shelter act. "Cedar County" first appears on main | `f29ac84` | none | Claims Cedar County and "replay". Fresh |
| not in git | WI-5 pushed: the shared brief | not in git | none | Claims Cedar County and "replay". Fresh |
| Oct 12 23:27 | **Scenario naming v2**: Cedar County becomes Larkhaven County | `3036894` | #4 | WI-3, WI-4, WI-5 go stale. WI-1, WI-2, WI-6, WI-7 are untouched (`NO_DEPENDENCY_ON_CHANGED_FACETS`) |
| Oct 12 23:27 | WI-7 pushed: the console identity header | `3036894` | #4 | Claims the label. Fresh |
| Oct 12 23:47 | WI-1 pushed (first version): the claims check counts as a test | `7d7fa09` | #6 | Claims evidence policy v1. Fresh |
| Oct 12 23:54 | WI-2 pushed (first version): evidence labels, built on v1. The time cannot be checked from main (see below) | first version of PR #7, since rewritten when the branch was rebased; its sha is not cited | #7 | Claims evidence policy v1. Fresh |
| Oct 13 00:04 | **Evidence policy v2**: only a check Convergence runs counts; the claims check is informational | `8350830` | #6 | WI-1, WI-2, WI-3 stale. WI-4 to WI-7 untouched |
| Oct 13 00:18 | **Evidence policy v3**: run checks take the facets they assert from the receipt | `2f3d2c8` | #6 | WI-1 gains `evidence.required-facets` as a stale facet; no other item does. WI-4 to WI-7 untouched |
| invented | **Product naming wording edit**: no facet moves | none | none | `NO_ACTION` with `PROSE_ONLY`. Nothing is re-evaluated |

PR #6 merged as `ce882f2` and PR #7 as `6689702`; those merge commits are the heads of WI-1 and WI-2, because that is where the work lives on main now. Their claims, and the timestamps of their pushes, are from their first versions. PR #4 landed on main as the single squash commit `3036894`, which is the head of WI-4 and WI-7 and the commit cited for the county rename.

WI-7 never goes stale.

## What is real and what is not

Real: the commits, their times and the PR numbers in the table, except the two rows named below; the order; the values of every facet (they are the values the repo held at those commits); and the engine. The test drives the real `reconcile` through the real ledger on both the in-memory store and the Durable Object stand-in. The county rename really was committed before the evidence policy changes, and the replay says so.

Reconstructed by us:

- **The dependencies and the claims.** We declared them after the fact. Convergence did not infer them. WI-3 makes no claim about the evidence rule, because the video script was written before that rule existed; we declare the dependency afterwards, and it goes stale on it through the declaration alone.
- **The starting state.** All six records are at v1 when the replay begins, and the work items are registered then (replay setup, timestamped before the first commit, not history). The evidence policy's first commit (`7d7fa09`) is later than the rename, so having it in the starting state puts it slightly ahead of the commits. Nothing depends on that gap, but it is a gap.
- **WI-1, WI-2 and WI-4 heads.** Each is a merge commit (or, for WI-4, a squash merge), not the commit its first version was pushed in, so the head sha is later than the push time on the same event.
- **Every cited sha is on main.** Each can be checked with `git merge-base --is-ancestor <sha> main`. The shelter fixtures were first committed with the name "Cedar County" (Oct 12 22:57 ET), and the rename to "Larkhaven County" was committed on the same side branch (Oct 12 23:11 ET). Neither commit is on main or on the remote: PR #4 was squash-merged as `3036894`, whose diff replaces "Cedar County" with "Larkhaven County" in the video script and submission copy, and adds the shelter fixtures already under the new name. So from main alone you can verify that Cedar County first appears at `f29ac84` and that `3036894` is where it becomes Larkhaven County. You cannot verify the 22:57 time of the WI-4 push, and the replay dates the rename at `3036894`'s own time (23:27 ET), not the earlier side-branch time. The WI-4 push time is kept because it is the real author time of that side-branch commit, and it is flagged as unverifiable in the fixture's label.
- **The WI-2 push time.** The 23:54 ET time is the first version of PR #7, which was rewritten when the branch was rebased. The commits PR #7 left on main are later (Oct 13 00:26 and 00:28 ET), so this time cannot be checked from main either.
- **PR numbers.** #4, #6 and #7 are taken from the commit subjects on main (`(#4)`, `Merge PR #6`, `Merge PR #7`). The pull request pages themselves are not available on this repository, so do not rely on a link; the commits are the evidence. The draft README (`e0710e6`) is on main; there is no PR number to cite for it.
- **WI-5 and the wording edit are not in git.** They carry the all-zero sha (`0000000000000000000000000000000000000000`), which reads as "none", and are labelled "not in git" in the fixture. The shared brief lives in Notion. The product-naming wording edit is the one invented event in the replay: it has no commit. We kept it because it is the negative control, a change that must not move anything.

No automated evidence is recorded and no resolutions are scripted in the replay: humans resolve, later, in the console.

## Layout

```
src/records.ts   the six records (ten versions) as real Markdown with front matter, parsed by the real parser
src/index.ts     actors, work items, dependencies, claims, receipts and every event, via buildDogfoodBuildScenario()
                 `timeline` lists the whole replay in commit order
```

## Where it is tested

`packages/delta-core/src/dogfood-build.test.ts` drives the timeline through `processEvent` and asserts the stale and untouched sets and reason codes at each step. `packages/delta-core/src/testing/scenarios.ts` also runs the named invariants against this fixture.

The console is not wired to this package yet.
