# Delta Convergence — PRD (Cloudflare contest build)

**Status:** v1.2. Adds the outcome of an independent red-team evaluation: the demo reshape, the fan-out beat, git-note receipts and three ratified decisions. v1.1 had folded in all 12 source threads and the gap register. · **Date:** 2026-10-12 · **Owner:** Andrew Miller
**Submission deadline:** Wed **2026-10-14, 11:59 PM PT** (Thu 02:59 ET). Target submit time: **Wed 6:00 PM PT**, which leaves a buffer.
**Judging (scored 1–5):** **50%** originality and prototype quality · **25%** multi-agent concurrency, coordination, context preservation, review and conflict handling · **25%** ease of use and product experience. Ties break on the first criterion. **Use these weights to decide every cut:** a third of the score is how clear the console is.
**After submission:** finalists are notified **Oct 16**. Three teams present live for 10 minutes at Moscone West, SF on **Oct 21**, and the winner must attend. Hold Oct 21.
**Contest:** [Build the next GitHub: Cloudflare Challenge](https://www.cloudflare.com/git-competition/) · [Rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
**Source material:** private research notes and conversation exports, kept outside this repo on purpose.

> **One line:** Delta Convergence is a control plane that keeps concurrent humans and agents working from the same *meaning*. When an accepted decision changes mid-flight, it finds exactly which work relied on the old version, stops it from merging, and drives a human-approved reconciliation. All of this is deterministic and uses no LLM.

---

## 1. Thesis

Parallel agents produce **semantic conflicts before they produce merge conflicts.** Two branches can each pass their tests, never touch the same lines, and still disagree about what the product is supposed to do. The usual reason is that one of them was built from a decision that has since changed.

Git versions *files*. Nothing versions the **accepted understanding that governs the work**, and nothing tracks which work depended on which version of it. Delta Convergence adds that layer. It works like a Kubernetes-style reconciler, but instead of comparing desired and running *infrastructure* it compares **accepted context** with **in-flight work**:

| Kubernetes | Delta Convergence |
|---|---|
| Desired state (spec) | Accepted context: decisions and definitions, versioned in Git |
| Running state | Active work items: agent sessions on their own Artifacts forks |
| Controllers | Pure `reconcile(state, event, policy)` functions |
| Drift | Work whose **receipt** points at a superseded context version |
| Reconcile action | Revalidate, block promotion, request review, record |

**Design rule (decided, Oct 12):** No LLM is required to operate Delta. *The agents are LLMs; the referee isn't.* It enforces explicit, versioned context records, declared dependencies and authority rules. Models (the agents) do the work and propose changes. They never authorize anything. *"Delta reconciles commitments, not beliefs."*

**Why now / why Cloudflare.** Artifacts makes a Git repo per agent cheap and programmable. You can fork from a baseline, get push events through Queues, and read trees and blobs from a Worker. That is the versioned substrate. Delta Convergence is the coordination contract above it, which Artifacts deliberately leaves out. Artifacts has no diff, merge or "what changed in meaning" API; we build exactly that layer.

## 2. Problem and user

**User (contest persona):** a tech lead or solo builder running several coding agents in parallel on a codebase that is still changing.

**Failure we prevent:**
1. A decision changes while agents are working, e.g. "notifications are now opt-in, weekly digest".
2. One agent's work silently depends on the old version.
3. Both branches look fine; review approves them; the contradiction ships or turns into rework.

**Bigger claim (the second scenario proves it):** the same failure happens in knowledge work. When an org changes what "qualified lead" means, every agent and human that depends on that definition, whether forecasts, playbooks or dashboards, needs to revalidate. The loop is not code-specific.

**Product promise:** *When shared understanding changes, you see exactly which work is affected and why, and nothing stale merges without a human deciding.*

## 3. Goals, non-goals, success criteria

### Goals (contest)
- G1. Two or more **real Claude agents run concurrently**, each on its own Artifacts fork of a shared baseline.
- G2. Every work item carries a **ContextReceipt**: the exact context records and blob hashes it was given.
- G3. A context change pushed to the baseline **deterministically** flags affected work as stale and leaves unaffected work alone.
- G4. A **semantic diff** puts the agent's structured claims beside the accepted context and the code diff.
- G5. A **human resolves**: revalidate (re-dispatch on new context), accept with a scoped exception, or reject. Then the work is **promoted** (merged into the baseline).
- G6. Every step is written to an **append-only, hash-chained event ledger** and is inspectable afterwards ("why is this here?").
- G7. The **same engine runs a non-coding scenario** (sales-ops definitions) with no code changes, only a different baseline and seed.

### Non-goals
Universal memory or a knowledge graph. Automatic semantic understanding of arbitrary text. Auto-resolving consequential conflicts. Kubernetes compatibility (CRDs, Helm). DAO or governance models. A general canvas product. A chat interface. A replacement for Git or Artifacts.

### Success criteria (demo acceptance)
1. Two or more agents visibly running at the same time, each pushing to its own fork.
2. Each agent's governing context is inspectable down to the version and hash.
3. A baseline context push triggers evaluation within about 10 seconds, with no manual refresh.
4. **Affected and unaffected work are distinguished.** One item goes stale; the other stays green.
5. Promotion of stale work is **blocked** until a human resolves it.
6. Revalidation re-runs the agent on fresh context, and its new claims match.
7. After promotion, the baseline contains both the code and the decision record, and the ledger shows the full chain.
8. The second (sales-ops) scenario runs through the same loop.
9. Cloudflare Workers and Artifacts are demonstrably on the critical path. Judges can verify this in the code and README.

## 4. Core concepts and contracts

Everything is TypeScript and Zod, in `packages/contracts`. All objects are portable: storage-agnostic, with no Cloudflare types in the contracts.

| Object | What it is | Where it lives |
|---|---|---|
| `Actor` | Human, agent or system identity (`kind`, `id`, `displayName`) | DO SQLite |
| `ContextRecord` | A versioned decision or definition: a Markdown file with YAML front-matter. The **facets** are its machine-checkable claims (e.g. `notifications.default: opt-in`) | Baseline repo `context/**.md` |
| `ContextSnapshot` | The set of `{recordId, version, blobHash}` compiled for a work item | DO SQLite, plus `.delta/context/` in the fork |
| `ContextReceipt` | Proof of **what was delivered** to whom, when, and at which hashes: `{baselineCommit, contextPacketHash, accepted[{recordId, version, blobHash, facetHash}], proposedVisible[], noteRef}`. It proves delivery, not understanding. The receipt is also written as a **git note on the agent's fork** (`refs/notes/delta`), so it travels with the repo and is readable with any git client (`git notes --ref=delta show`); `noteRef` points to it | DO SQLite, plus a git note on the fork |
| `WorkItem` | A task for one agent: `{id, title, actor, forkRepo, source: live|seeded, intent: delivery|exploratory, requires[]: ["contract-test","human-resolution"], status}`. Items with `source: seeded` are synthetic work for the fan-out beat and are **always labelled "seeded"** in the UI | DO SQLite |
| `Dependency` | `{workItemId, recordId, facetKeys[], basis: declared|verified|inferred, status: proposed|accepted|rejected, evidenceRefs[]}`. Only `accepted` dependencies gate work | DO SQLite |
| `Claim` | A structured assertion the agent makes about its output: `{subject, value, basedOn: recordId@version}`. It is **self-reported**, so the UI labels it "agent-asserted, unverified" | Fork `.delta/claims.json` |
| `Evidence` | The result of a **Delta-run** contract check at a specific head: `{workItemId, headSha, check, pass, output}` | DO SQLite |
| `Condition` | An evaluated state on a work item: `Fresh`, `Stale`, `Uncertain`, `ClaimConflict`, `TestFailed`, `TestsPassed`, `Blocked`, `Ready`, `Promoted`. Every condition carries `reasonCodes[]` | DO SQLite |
| `Policy` | `{authority: {recordId → actorId}, staleness: "facet", requires[], maxRevalidations}` | DO SQLite (versioned) |
| `Resolution` | A human disposition: `revalidate`, `accept-exception{scope}`, `reject`. It requires `rationale` and a **binding**: `{recordId@version+blobHash, baseSha, forkHeadSha}` | DO SQLite, plus `decisions/` in the baseline |
| `ReconciliationEvent` | An append-only, hash-chained ledger line for every observation and effect. Each carries `policyVersion`. Types include `AgentRunStarted`, `AgentRunFinished`, `ResolutionRecorded`, `PromotionMerged` | DO SQLite (ledger table) |

**Smallest governed unit (decision):** a **facet of a ContextRecord**, i.e. one key/value inside an accepted decision. A record is the authority boundary, a facet is the checkable unit, and the version and blob hash are the identity. This answers the open "definition vs. decision vs. commitment" question in the most buildable way. Commitments (authority and approvals) are post-contest.

### ContextRecord file format
```markdown
---
id: notifications
version: 2
status: accepted            # proposed | accepted | superseded
authority: decision-owner           # actor allowed to accept changes
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T16:00:00Z
supersedes: notifications@1
validation: tests/contract/notifications.test.ts   # the Delta-run check (rule R8)
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
---
# Notifications
Users opt in to project status notifications, delivered as a weekly digest. (Decision 2026-10-13, see decisions/0002.)
```

### The reconciler (pure, no I/O, no LLM)
```ts
reconcile(state: CellState, event: DeltaEvent, policy: Policy): { state: CellState; effects: Effect[] }
// Effect = REQUEST_REVALIDATION | BLOCK_PROMOTION | REQUEST_REVIEW | DISPATCH_WORK | RECORD_CONDITION | ALLOW_PROMOTION | NO_ACTION
```
Mapping to the thread spec: `BLOCK_PROMOTION` plus `REQUEST_REVIEW` is the PRD's split of the spec's `REQUEST_APPROVAL`.

Rules for v1, all deterministic:
- **R1 Staleness (facet-level).** A baseline push to `context/X` produces a new accepted version. Diff its **facets** against the version in each non-promoted WorkItem's receipt. Only items with an *accepted* dependency on a **changed facet** become `Stale`. Effects: `BLOCK_PROMOTION` and `REQUEST_REVIEW`. If only the prose changed (no facet changed), the effect is `NO_ACTION` with reason `PROSE_ONLY`. That is a demo beat: a typo fix doesn't page anyone.
- **R2 Unaffected.** A WorkItem with no dependency on the changed facets stays `Fresh`. Effect: `NO_ACTION`, recorded with a reason code so the demo can show *why* it was left alone. WI-1 and WI-5 are the named negative controls.
- **R3 Claim conflict.** When a fork push updates `.delta/claims.json`, compare each claim to the *current accepted* facets. A matching `subject` with a different value gives `ClaimConflict`. A claim `basedOn` a superseded version is also a conflict, judged at facet level: it conflicts only if the claimed facet differs between the cited version and the current one. A claim is compared to the record that governs its subject, so a claim citing the wrong record is a conflict (or `Uncertain` if its value merely agrees), never a pass. Claims are labelled *agent-asserted*. Malformed or missing claims **fail closed** and give `Uncertain` with reason `NO_CLAIMS` or `MALFORMED_CLAIMS`.
- **R4 Undeclared reliance.** A claim citing a record that isn't in the receipt creates a `Dependency{basis: inferred, status: proposed}` and gives `Uncertain`. A human accepts or rejects it. Models propose; they never bind.
- **R5 Promotion gate.** A WorkItem may be promoted only if it is `Fresh` **and** `TestsPassed` for every check in `requires[]`, *or* it holds a bound `accept-exception` from the record's `authority`. An exception waives staleness, claim conflicts and the excepted record's own validation check, and nothing else: other records' checks must still pass, and unknowns (missing or malformed claims, undeclared dependencies, cross-claim conflict) are never waived. Anything unknown blocks. A fork that changes `context/**` is never promotable (`FORK_EDITS_CONTEXT`): agents propose context changes on the baseline, they do not carry them in through a merge.
- **R6 Revalidation.** `revalidate` creates a new receipt at the current versions. It dispatches the agent again on the same fork with a diff-aware prompt ("decision X changed from v1 to v2; reconcile your work"). A loop guard applies: after `maxRevalidations`, the result is `REQUEST_REVIEW`.
- **R7 Approval binding.** Every Resolution binds `recordId@version+blobHash`, `baseSha` and `forkHeadSha`. `promote` re-runs R1, R3 and R8 **at the current heads inside the DO** and carries `expectedBaselineCommit` (compare-and-swap). An exception **lapses** if its record gets a new accepted version. A context push that lands between approve and promote can't slip through: promotion is two-phase (the gate emits `ALLOW_PROMOTION`, the adapter merges, then the merge is recorded), and recording the merge re-runs the gate at the current state.
- **R8 Evidence (Delta-run, not agent-run).** Each scenario ships one contract check (for example, `notifications.default == opt-in` asserted against the code's actual default). Delta's runner executes it at the fork head on every push and again at promote, and stores `Evidence`. The conflict therefore doesn't depend on the agent honestly reporting its own claims. It also keeps the demo alive if the live agent skips claims.
- **R9 Idempotency.** Events are deduplicated on `(repo, commitSha)`, because Queues deliver at least once and the poller can double-fire. Evidence is keyed by `(repo, commitSha, check, runId)`, so a re-run at the same head (for example at promote) is not dropped as a replay. A merge is keyed by work item and merge commit. Mutating endpoints take an `Idempotency-Key`.
- **R3b Cross-claim conflict (P1).** Two non-promoted items that claim different values for the same subject give `Uncertain`. This covers the phone-optional-vs-required case. It applies only to subjects no accepted facet governs (R3 arbitrates the rest) and ignores rejected items.

Named invariant tests run against both fixtures, on an in-memory store **and** the DO store:
- "unaffected work never changes status"
- "prose-only edit stales nothing"
- "replayed event yields one ledger entry"
- "agent actor cannot resolve"
- "chain breaks on any edit"

This is the **"no LLM required" proof**, and the README should say so.

## 5. Architecture on Cloudflare

```
            ┌──────────────── Convergence Console (React SPA, Worker static assets) ───────────────┐
            │ context timeline · work graph (React Flow) · inspector (receipt / claims / diff)      │
            └───────────────▲ WebSocket (live) ──────────── REST ▼─────────────────────────────────┘
 ┌─────────────────────── Worker: Delta API (Hono) ────────────────────────────────────────────────┐
 │ /scenarios /work-items /resolutions /promote · token minting · tree diff · claims compare        │
 └──────▲──────────────────────────┬──────────────────────────────────▲───────────────────────────┘
        │ queue()                   │ RPC                               │ dispatch
 ┌──────┴──────┐        ┌───────────▼─────────────┐          ┌──────────┴──────────────────────────┐
 │ Queue:      │        │ Durable Object:          │          │ Sandbox SDK container per agent     │
 │ artifacts   │        │ WorkspaceCell (SQLite)   │          │ Claude Code headless, git clone/push │
 │ push events │        │ state + ledger + reconcile│         │ to its own Artifacts fork            │
 └──────▲──────┘        └──────────────────────────┘          └──────────┬──────────────────────────┘
        │ cf.artifacts.repo.pushed                                       │ git smart-HTTP
 ┌──────┴────────────────────────── Cloudflare Artifacts ─────────────────▼─────────────────────────┐
 │ <scenario>-baseline (context/, decisions/, code)  ──fork──▶  <scenario>-wi-<id> (one per agent)   │
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Concern | Choice | Notes / source |
|---|---|---|
| Versioned substrate | **Artifacts**: one baseline repo per scenario and **one fork per work item** | Cloudflare best practice: one repo per autonomous agent. The binding is **read-only** (`log`, `readTree`, `readFile`, `fork`); writes go over git smart-HTTP |
| Control plane | **Worker** (Hono) plus **Durable Object `WorkspaceCell`** with SQLite | One DO per scenario. It holds state and the ledger, runs `reconcile`, and fans out over WebSockets (hibernation API) |
| Events | **Poll first** (the DO polls `log({limit:1})` every 2–5 seconds per repo), then upgrade to the **Queues event subscription** on `artifacts.repo` → `pushed` once it works | The subscription flags are unverified, so this order removes a Tuesday risk. Both paths feed the same deduplicated `DeltaEvent` (R9) |
| Worker-side git writes | `isomorphic-git` plus the **patched `memory-fs.ts`** from the author's earlier Artifacts spike | Verified against the live service. Used to seed baselines and commit context changes |
| Agent runtime | **Sandbox SDK container per agent**, running `claude` headless (Claude models via OpenRouter's Anthropic-compatible endpoint) | Follows the CF Claude Code tutorial. Allow `*.artifacts.cloudflare.net` outbound. **Fallback:** a local runner (`apps/runner`, Node + Claude Agent SDK) on Andrew's Mac that clones and pushes to the same forks |
| Merge / promote | Real `git merge` inside a sandbox, or the local runner, then push to the baseline | Artifacts has no merge API. With one writer per repo, the DO serializes promotions |
| Diff | Tree walk (`readCommit` → `readTree` → compare blob hashes), plus a unified text diff for the changed blobs | `readTree` returns direct children only, so walk it recursively |
| UI | Vite + React 19 + Tailwind v4 + shadcn, React Flow + dagre | Standalone, with no local `link:` packages, so judges can `pnpm install` from a fresh clone |

**Repo layout**
```
convergence/
  packages/contracts/     # Zod schemas: ContextRecord, Receipt, Claim, Event, Effect…
  packages/delta-core/    # pure reconcile(), rules R1–R6, ledger hash-chain (WebCrypto), tests
  apps/worker/            # Hono API, WorkspaceCell DO, queue consumer, Artifacts adapter, sandbox dispatch
  apps/console/           # React SPA (served as Worker static assets)
  apps/runner/            # fallback local agent runner (Claude Agent SDK) — same protocol as sandbox
  scenarios/notifications/  # coding fixture: baseline repo seed + context v1/v2 + task prompts
  scenarios/sales-ops/      # knowledge-work fixture: same shape
  docs/PRD.md  README.md  LICENSE (MIT)
```

**Agent protocol** (identical in the sandbox and the local runner): clone the fork, read `AGENTS.md` and `.delta/context/*`, do the task, write `.delta/claims.json`, commit and push. The agent is told to cite `recordId@version` for every claim. If the agent omits claims, the work item gets a `NoClaims` condition. We don't infer them.

## 6. Demo scenarios

### Scenario A: "Notifications" (coding, primary)
A small TypeScript "project status" service: an API plus a settings page. The baseline contains `context/notifications.md` v1 ("users receive project status updates, immediately, default-on") and `context/status-model.md` v1.

| Work item | Agent | Depends on | Task |
|---|---|---|---|
| WI-1 Status badges | Agent A | `status-model` | Add status badges and the status-change API |
| WI-2 Notification delivery | Agent B | `notifications`, `status-model` | Implement notification preferences and delivery |

**Video order (decided):** lead with the strongest moment. Both forks *merge cleanly with plain git and CI is green*, yet Delta blocks the stale one. The console cut list is derived from this script; anything not on screen doesn't get built. The inspector's default tab is **"Why is this blocked?"**

1. Start both agents concurrently. The console shows two live forks with receipts at v1. Each receipt is also visible as a git note on its fork.
2. **Typo beat (10 s):** fix a typo in `notifications.md` prose. The ledger shows `NO_ACTION · PROSE_ONLY`, and nothing goes red. *This is not a notification system.*
3. **Mid-flight**, the human edits the decision: `notifications` v2 = **opt-in, weekly digest**. It is committed to the baseline via the console, which writes from the Worker with isomorphic-git.
4. The event arrives. R1 marks WI-2 **Stale** (`notifications.default` and `notifications.cadence` changed since `notifications@1`). WI-1 stays **Fresh** (R2, reason `NO_DEPENDENCY_ON_CHANGED_FACETS`). Both decisions are visible in the ledger.
5. WI-2 finishes and pushes. R3 compares the agent's claims (`default: on, cadence: immediate, basedOn notifications@1`) with the accepted facets and raises **ClaimConflict**. R8 runs the contract test at WI-2's head and gets **TestFailed**. The inspector shows the claim (*agent-asserted*), the test result (*test-verified*), the accepted facet (*recorded*) and the code diff hunk side by side. Promote is disabled, and the gate preview lists the reason codes.
6. **Control shot (the opener):** `git merge` both forks into a scratch clone of the baseline. The merge is clean, and each fork's own tests pass, so *plain Git plus CI would ship this.* Cut to the console: Delta blocks WI-2 and names the decision version it was built on. WI-1 is promoted straight away, which shows that unaffected work isn't slowed down.
7. The human clicks **Revalidate**. Agent B re-runs with the v1→v2 diff and pushes new claims. The claims match, and the contract test passes. Its status goes Fresh + TestsPassed, then it is Promoted (R7 re-checks at the current heads).
8. The final view: the baseline has both changes plus `decisions/0002-notifications-opt-in.md`. The ledger chain verifies, and `AgentRunStarted/Finished` show the two agents overlapping in time.
9. **Fan-out beat (about 30 s):** 30–50 seeded work items (`source: seeded`, labelled on screen) hold receipts against the same records. One decision change is evaluated across all of them in under a second: a handful go Stale with reason codes, and the rest are untouched. A results strip shows `N evaluated · K stale · rest untouched · <time>`. This answers the brief's *"hundreds of thousands of agents"*: the reconciler is the part that scales.

**Seeding for reliability:** fixed task prompts, a tiny codebase and a pinned model. The context change is triggered on cue. Because the Claude agents are real, step 4's conflict is *likely* rather than guaranteed. Agent B is told to build from its snapshot. The window is guaranteed because the change happens while it runs. **Replay mode** (P1) re-drives a recorded event log through the same DO in case live agents misbehave on recording day.

### Scenario B: "Qualified lead" (knowledge work, second scenario)
The company is synthetic ("Northwind Field Services"). **Don't use real client names or data in the public repo.** The baseline contains `context/definitions/qualified-lead.md` v1 (form fill and 50+ employees) and `context/definitions/sales-activity.md` v1.

| Work item | Agent | Depends on | Output |
|---|---|---|---|
| WI-3 Q4 pipeline forecast | Agent C | `qualified-lead` | `reports/q4-forecast.md` with claims about the counts and criteria used |
| WI-4 SDR weekly priorities | Agent D | `qualified-lead`, `sales-activity` | `playbooks/sdr-priorities.md` |
| WI-5 Activity glossary | Agent E | `sales-activity` | `docs/glossary.md` (unaffected control) |

Mid-flight, `qualified-lead` v2 adds a "verified budget signal" requirement. WI-3 and WI-4 go Stale; WI-5 stays Fresh. One is revalidated and one gets an **accept-exception** ("Q4 forecast is grandfathered on v1 for board deck; scoped to `reports/q4-forecast.md`") to show both resolution paths. **Same engine, same UI, a different baseline.** That is the generalization proof.

> **Status (Oct 12, reopened):** build B **seeded/replay-first** tonight. Its fixtures, contract check and recorded event log go through the same engine, which guarantees a 60–90 s segment in the video. **Andrew decides on Tuesday night** whether to upgrade B to live agents, once Scenario A is solid. The overnight agent runs restore the build hours that made the downgrade attractive.

## 7. UX: the Convergence Console

One screen, three panes, live over WebSocket.

- **Left, Context timeline.** Each ContextRecord with its version history (v1 → v2), who accepted it and when. A "Propose change" editor commits a new version to the baseline.
- **Center, Work graph.** React Flow with the baseline node and one fork node per work item. Status chips: `running · fresh · stale · uncertain · conflict · revalidating · ready · rejected · promoted`. Edges from each work item to the context records it depends on light up red when stale. **This is the "Oh!" moment:** the decision changes, and exactly one edge turns red.
- **Right, Inspector** for the selected work item:
  - *Receipt*: the records, versions and hashes it was given.
  - *Semantic diff*: claims vs the accepted facets, colored by match, conflict or undeclared.
  - *Code diff*: changed files.
  - *Why*: the causal chain *decision vN → receipt (what this agent was given) → claim → test → condition*. Each link carries an epistemic chip: **recorded** for accepted records and Resolutions, **agent-asserted, unverified** for claims, **test-verified** for Evidence. Undecided items read "Awaiting human", never a success badge.
  - *Gate preview*: `GET /work-items/:id/gate` is a dry run of promotion that returns pass/fail and reason codes. It drives the disabled-Promote tooltip.
  - *Actions*: Revalidate, Accept exception (with required scope and rationale), Reject, Promote (gated).
- **Bottom strip:** the live agent activity stream (stream-json from the agents), an agent-overlap bar showing concurrent runs (P1), and the ledger tail.
- **Empty state:** "No accepted context yet. Declare the first decision." The scenario seed then gives a one-click start.
- **Identity label:** the header shows "Acting as: Andrew (demo identity)". The console doesn't pretend to have real auth.

Visual grammar comes from the author's earlier review-loop prototype: canonical items are solid, proposed items dashed, and there are actor chips for human, agent and system. Supports both themes. A scenario switcher sits in the header.

## 8. Requirements (prioritized)

**P0 (must ship)**
- Contracts and `delta-core` with rules R1–R6 and unit tests on both fixtures.
- Seeding the Artifacts baseline, forking per work item, and minting write tokens.
- Running 2+ agents concurrently (sandbox *or* the local-runner fallback) and pushing to their forks.
- The push-event → DO → reconcile pipeline, with polling as the fallback.
- A context change committed from the console, then automatic stale detection.
- The console: work graph, inspector (receipt, claims vs facets, code diff), actions, live updates.
- Revalidate, accept-exception and promote, with real merge into the baseline and a decision record written.
- Scenario B through the same loop (see the cut line).
- R8 contract check (one per scenario) run by Delta's runner. Concurrency evidence: `AgentRunStarted/Finished` ledger events, plus commit author = work-item id.
- README with architecture, "where Workers and Artifacts are used", and run instructions. MIT `LICENSE` (Apache-2.0 and BSD are also allowed). A deployed URL.
- **README honesty package:**
  - "Why not Spec Kit + CI / Conductor + GitHub / Radicle / plain PRs?" table.
  - "What Delta does not do", e.g. it only gates actions that flow through it, and it doesn't understand arbitrary text.
  - "Implemented vs. not" table.
  - Replay segments labelled as replay.
  - The control comparison: the same scenario with a plain Git + PR review.
- A 5–10 minute demo video. The submission form text: vision, Cloudflare usage.

**P1 (should)**
- Replay mode from a recorded event log.
- Ledger hash-chain verification shown in the UI ("chain verified ✓").
- Git notes on the forks recording the receipt (Artifacts best practice).
- A third concurrent agent in Scenario A, to show scale.

**P2 (post-contest)**
- Authority and approvals, i.e. Commitments as first-class objects. Cross-org authority boundaries.
- AI adapters: dependency inference (`basis: inferred`) and claim extraction from diffs.
- Branch → Explore → Compare → Reconcile → Promote canvas for alternative futures.
- MCP server so any agent can fetch its receipt and post claims.

## 9. Build plan (about 46 working hours; PT)

| Block | Window (PT) | Deliverable | Done when |
|---|---|---|---|
| **M0 Foundation** | Mon night | Monorepo scaffold, wrangler config (personal CF account; Workers Paid), Artifacts baseline seed + fork + push deployed, `contracts` + `delta-core` with R1–R6 tests green | `curl` creates a baseline and fork; `pnpm test` passes |
| **M1 Agents** | Tue AM | **Decided: Sandbox first.** A Sandbox container runs Claude Code against a fork; two run concurrently and their pushes land. **Fallback checkpoint at Tue 11 AM PT:** switch to the local runner if containers fight back | Two forks receive agent commits at the same time |
| **M2 Control loop** | Tue midday | Queue subscription → DO → reconcile → ledger; context-change endpoint; stale detection end-to-end on Scenario A | Changing a decision flips WI-2 to Stale and leaves WI-1 alone |
| **M3 Console** | Tue PM–eve | Work graph, inspector, WebSocket live updates, actions wired | Scenario A runs fully from the UI |
| **M4 Resolve + promote** | Tue night | Revalidate re-dispatch, accept-exception, merge/promote, decision record | Final baseline contains code plus decision; ledger is complete |
| **M5 Scenario B** | Seeded: overnight Mon/Tue. Live upgrade: **Andrew decides Tue night** | Sales-ops fixture through the same loop, seeded/replay first | Replay segment runs end-to-end; live run if upgraded |
| **M6 Ship** | Wed midday | Replay mode, README, LICENSE, deploy, a fresh-clone run test | A clean clone follows the README to a running demo |
| **M7 Video + submit** | Wed 1–6 PM | Record (2 takes), edit, write form copy, submit | Submitted by 6 PM PT |

**Parallel tracks.** These run as separate agents, after the contracts are frozen at the end of M0:
1. `delta-core` and tests
2. Worker, DO and Artifacts adapter
3. Console UI against a mock event stream
4. Fixtures and agent prompts

## 10. Reuse (lift, don't rebuild)

The build lifts from the author's own prior spikes rather than rebuilding them:
- a verified Artifacts spike (in-memory fs for isomorphic-git, push routes, tree diff)
- a hash-chained ledger schema
- a review-loop UI prototype
- React Flow + dagre graph layout
- Durable Object WebSocket fan-out

The source paths are in the local, untracked context file.

All of this is Andrew's own prior code. Keep the contest repo's commit history entirely inside the contest window; the rules require "own original content".

## 11. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sandbox/Containers setup eats Tuesday (Docker, egress allowlist, root/`IS_SANDBOX`) | Med-High | **Hard decision at 11 AM Tue.** The local runner pushes to the same forks; the Worker/Artifacts/DO path is unchanged and still meets the criteria |
| Queue event subscriptions are flaky or undocumented flags | Med | The DO polls `log()` every 5 seconds behind the same `DeltaEvent` interface |
| Concurrent pushes to the baseline → `stale ref` | Med | One writer per repo; the DO serializes promotions; retry 3 times with jitter |
| Real agents don't produce the conflict, or skip claims | Med | Seeded prompts and a tight fixture; claims are required by `AGENTS.md`; replay mode for recording |
| Judges read it as "a dashboard beside Git" | Med | The demo centers on the **gate**: stale work cannot promote. Merge and promotion run *through* Delta |
| "Just a notification system" (red-team) | Med | Show the R2 precision (unaffected work isn't disturbed), the R3 claim conflict and the R5 gate, which a broadcast can't do |
| Scope: real build time is about 28–32 h plus overnight agent runs | High | Scenario B goes seeded-first with a live upgrade decision on Tue night. The console cut list comes from the video script. Fan-out uses seeded items, not more live agents |
| Artifacts is open beta and billing starts Oct 14 | Low | Cost is negligible at demo volume; requires Workers Paid on the personal account |
| `wrangler dev` has no local Artifacts | Certain | Develop against `remote: true`, deploy early (M0) |

## 12. Submission copy (draft; revise to match what was actually built)

**Project name:** Delta Convergence. Use one public name only; ProofMerge, Convergence Lab and the rest stay internal.

**One-line pitch:** Git tells you when two agents changed the same lines. Delta Convergence tells you when two agents are building from different decisions, and won't let the stale one merge.

**Video opener (human problem first, Kubernetes second):** Open with 15 seconds of the phone-number case. One agent makes the phone field optional and another makes the API require it. Both pass their tests, Git sees no conflict, and production breaks. *Optional narrative hook:* during disaster relief, two coordinators acting on stale inventory counts send supplies to the wrong place. The cost of stale shared meaning is real. Only after that comes "Kubernetes reconciles infrastructure; Delta reconciles collaborative work."

**Positioning line:** Git and Radicle prove *who changed what* and *who authorized it*. Delta tracks *which work depended on which accepted meaning*, and gates that work when the meaning changes.

**Vision:** Agents don't usually collide on lines of code; they collide on meaning. When a decision changes mid-flight, today's tools can't tell you which work was built on the old version. Delta Convergence gives every agent a versioned, receipted context, and keeps reconciling that accepted context against in-flight work like a Kubernetes controller. Stale work is caught before it merges, and nothing ships without a human deciding. The reconciler is deterministic. LLMs do the work; they don't get to decide what's true.

**How we used Cloudflare:**
- Every agent works in its own **Artifacts** fork of a shared baseline repo, and decisions and definitions live as versioned Markdown in that baseline.
- **Artifacts push events** stream through a **Queue** into a **Durable Object** per workspace. The DO holds the reconciliation state, the hash-chained ledger and the live WebSocket feed.
- A **Worker** exposes the Delta API, seeds and forks repos, and computes tree diffs from the Artifacts binding.
- Agents run Claude Code in **Sandbox** containers and push over Git.

## 13. Open decisions (need Andrew)

1. ~~**Cloudflare account.**~~ **Decided (Oct 12):** Andrew's personal account; he will supply an API token. Account details live in the local untracked context file. Still to verify at M0: Workers Paid and Containers access (`wrangler whoami`).
2. ~~**Model key for agents.**~~ **Decided (Oct 12):** OpenRouter. Agents reach Claude models through OpenRouter (`OPENROUTER_API_KEY`, set by Andrew as a Worker secret and in `.dev.vars`; model pinned by config). AI Gateway is optional on top and claimed only if used.
3. **Team fields.** Solo entry, or a second attendee?
4. **Video.** Who narrates, and should it be a screen recording or have a face cam?
5. ~~**Ratify "Delta never needs an LLM"**~~ **Decided (Oct 12):** "No LLM is required to operate Delta; models propose, rules and humans decide."
6. ~~**Name.**~~ **Decided (Oct 12): Delta Convergence.** Still to do: a quick collision check (GitHub, npm, domain) before the repo goes public.
7. **Try Together / What-if.** Recommendation: not built. Show it as a 20-second "where this goes" beat in the video.
8. **Token-revocation demo beat / tokens as the gate's teeth.** Not adopted for now. Possible P1 only if time remains after M4.
10. **Scenario B: live or seeded?** Andrew decides Tue night (see §6).
9. **Hold Oct 21** for the finalist presentation in SF.

## 14. Decision log (consolidated from threads, Oct 9–12)

| Decision | Status |
|---|---|
Status labels are strict. **Andrew-decided** means he stated or approved it. **Andrew-direction** means he pushed this way without formally deciding. **Recommended** means an assistant proposal.

| Decision | Status |
|---|---|
| The product is a deterministic reconciliation control plane; ProofMerge/semantic drift is the *scenario* and *review view*, not the product. Framing: "both, loop-first" | Andrew-decided (Oct 12) |
| The name is "Delta Convergence" | Andrew-decided (Oct 12) |
| No LLM is required to operate Delta; models propose and never authorize | Andrew-decided (Oct 12) |
| Defining moment = governing context changes mid-flight → affected work is revalidated (not just a two-branch conflict) | Recommended (latest thread), adopted in this PRD |
| Agents are real Claude agents; the scenario is seeded; replay is a fallback | Andrew-decided (Oct 12) |
| Second, non-coding scenario: seeded/replay first, with live vs. seeded decided Tue night | Reopened (Oct 12); Andrew decides Tue night |
| Smallest governed unit = a facet of an accepted ContextRecord, identified by version and hash; staleness is facet-level | Andrew-decided (Oct 12) |
| Storage = Git/Artifacts for context and work; DO SQLite for coordination state and ledger (not D1) | Andrew-decided (Oct 12) |
| Demo reshape: merge-clean-yet-blocked opener, fan-out beat with seeded items, receipts as git notes | Andrew-decided (Oct 12) |
| M1 runtime: Sandbox first, local-runner fallback at Tue 11 AM PT | Andrew-decided (Oct 12) |
| The canvas is a projection, not the source of truth; no giant mandatory graph | Recommended, adopted |
| Rejected: DAO framing, chat-first UI, Kubernetes compatibility, a broad horizontal platform | Recommended-rejected |
| Deferred to after the contest: the authority/autonomy model (A0–A4), the Agent Council demo, Try Together / What-if, a separate context service, AI dependency inference | Deferred |
| Raw transcripts and research stay out of the public repo, in Andrew's private knowledge vault | Andrew-decided (Oct 12) |
