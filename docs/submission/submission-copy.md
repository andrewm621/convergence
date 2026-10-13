# Delta Convergence: Cloudflare submission copy

**Status:** draft v1 from PRD v1.2, before the build is finished. Final only after the claims in section 7 are checked against the shipped build. Anything marked `[VERIFY BEFORE SUBMIT]` is not confirmed built.

## 1. Project name

Delta Convergence

## 2. One-line pitch

Git tells you when two agents changed the same lines. Delta Convergence tells you when two agents are building from different decisions, and won't let the stale one merge.

## 3. Vision (143 words)

Agents rarely collide on lines of code. They collide on meaning. A decision changes mid-flight, one agent keeps building on the old version, and both branches still merge clean.

Git versions files. Nothing versions the accepted decisions behind the work, or tracks which work was built on which version. Delta Convergence adds that layer: every agent gets a receipt of the exact decisions it was handed, and a reconciler (think Kubernetes controller, for collaborative work) watches for drift.

When a decision changes, work built on the old version is found, blocked from merging, and sent to a human, who revalidates it or grants a scoped exception. Unaffected work keeps moving.

LLMs do the work and propose changes. The referee is deterministic rules with no model calls, and humans decide what ships.

The same engine handles a second, non-coding scenario with no code changes.

## 4. How we used Cloudflare

Only the first four bullets are in PRD §5 as core, and even those need confirming against the final build. Everything else is conditional.

- **Artifacts:** one baseline repo per scenario holds the code, the versioned decisions (`context/`) and decision records (`decisions/`). Every work item gets its own fork of that baseline, and each agent pushes to its own fork over git. The Worker reads logs and trees through the Artifacts binding and commits context changes and seed data from the Worker using isomorphic-git. `[VERIFY BEFORE SUBMIT: fork per work item and Worker-side commits working in the deployed build]`
- **Workers:** a Hono API seeds and forks repos, accepts context changes and resolutions, runs the promotion gate, and computes tree diffs and claim comparisons. The console (a React app) is served as Worker static assets. `[VERIFY BEFORE SUBMIT: console served from the Worker]`
- **Durable Objects:** one SQLite-backed `WorkspaceCell` per scenario holds work-item state, the append-only hash-chained ledger and the reconcile step, and pushes live updates to the console over WebSockets. `[VERIFY BEFORE SUBMIT: WebSocket hibernation API actually in use]`
- **Push detection:** the Durable Object polls each repo's log every few seconds and de-duplicates events on repo and commit SHA.
  - `[VERIFY BEFORE SUBMIT: Queues]` Include this next sentence only if the Artifacts push-event subscription ran in the deployed build: "Artifacts push events are delivered through a Queue to the same Durable Object." If it didn't, leave it out. The PRD says polling comes first and Queues are an upgrade, and the evaluation note says never to list Queues unless they ran.
- **Sandbox:** `[VERIFY BEFORE SUBMIT: Sandbox SDK]` Include "Agents run Claude Code headless in Sandbox containers and push over git" only if Sandbox ran in the recorded demo. If a local runner drove the agents instead, say: "Agents run through a local runner that clones and pushes to the same Artifacts forks."
- **AI Gateway:** `[VERIFY BEFORE SUBMIT: AI Gateway]` Mention only if agent calls actually went through it (model access is via OpenRouter; AI Gateway only if added on top).

Do not claim D1, KV, R2, Workflows or Workers AI. The PRD doesn't use them.

## 5. What's real, seeded and replayed

The two Scenario A agents in the video are real Claude agents running at the same time on separate Artifacts forks. The fan-out segment uses 40 seeded, synthetic work items with no model behind them; they are labelled "seeded" in the console and the video. The Scenario B segment (a synthetic company, "Northwind Field Services") is a replay of a recorded event log through the same engine, and is labelled as one. `[VERIFY BEFORE SUBMIT: update if Scenario B is upgraded to live, or if any Scenario A beat used a fallback]` The README has an "Implemented vs not" table with the full list.

## 6. Run instructions (summary)

The README is a stub today, so this is the intended shape. Fill in exact commands from the final README.

1. **Prerequisites:** Node 26 or newer and pnpm 10 or newer (per `package.json`). To run live agents or deploy: a Cloudflare account on Workers Paid with Artifacts beta access, and an OpenRouter API key (agents call Claude models through it). `[VERIFY BEFORE SUBMIT: Artifacts access requirements and any Containers requirement]`
2. **Install and test:** `pnpm install`, then `pnpm test` and `pnpm typecheck`. The reconciler's invariant tests need no network and no API key. `[VERIFY BEFORE SUBMIT: both pass on a fresh clone]`
3. **Run the Worker:** `wrangler dev` with remote bindings, because Artifacts has no local emulator. `[VERIFY BEFORE SUBMIT: exact commands, seed script and scenario start steps]`
4. **Deployed demo:** `[DEPLOYED URL: fill at submit]`
5. **No credentials?** Replay mode re-drives a recorded run through the same engine. `[VERIFY BEFORE SUBMIT: replay mode shipped, it's P1]`
6. **Repo:** `[PUBLIC REPO URL: fill at submit]`. MIT licensed.

## 7. Claims to check against the final build before submitting

| # | Claim (where it appears) | Why it needs checking | How to check |
|---|---|---|---|
| 1 | Each agent runs on its own Artifacts fork; two or more run concurrently (Cloudflare, video 2) | Goal G1, depends on the Sandbox or local-runner outcome | Two forks in the baseline; `AgentRunStarted/Finished` timestamps overlap |
| 2 | Agents run in Sandbox containers (Cloudflare bullet 5) | M1 had a Tuesday 11 AM fallback to a local runner | Check which runtime produced the recorded footage |
| 3 | Push events arrive through a Queue (Cloudflare bullet 4) | Queue subscription flags were unverified; polling is the primary path | Confirm the consumer fired in the deployed build; otherwise delete the sentence |
| 4 | Receipts are written as git notes on the fork (video 2) | P1 item | `git notes --ref=delta show` works on a fork |
| 5 | "The control loop makes no model calls" (vision, video 1) | Public claim; ratified in the PRD but confirm in code | No model call anywhere in `delta-core` or the reconcile path; invariant tests pass |
| 6 | Staleness is facet-level; prose-only edits stale nothing (video 3) | Core rule R1 | Test "prose-only edit stales nothing" passes; ledger shows `PROSE_ONLY` |
| 7 | Unaffected work stays untouched (video 4, 9) | Core rule R2 | Test "unaffected work never changes status" passes against both fixtures |
| 8 | Promotion of stale work is blocked until a human resolves it (pitch, video 5) | Core rule R5 | Gate returns fail with reason codes; promote endpoint rejects |
| 9 | Delta runs a contract check at the fork head and the claim conflict doesn't depend on the agent's honesty (video 4) | Rule R8 | Evidence rows exist; TestFailed appears with no claims |
| 10 | Promote re-checks at current heads (video 8) | Rule R7 | Compare-and-swap on `expectedBaselineCommit`; test for a context push between approve and promote |
| 11 | Ledger is append-only and hash-chained; "chain verified" shows in the UI (video 8) | Chain is P0; the UI indicator is P1 | "chain breaks on any edit" test passes; indicator visible |
| 12 | "Merge clean, CI green" (video 5) | Whether any hosted CI exists | State exactly what ran; don't call local test runs a hosted pipeline |
| 13 | Fan-out: N evaluated, K stale, elapsed time; "under a second" (video 9) | Numbers must come from a real run | Record the result strip; use the measured figure |
| 14 | Scenario B is a replay, runs with no code changes (vision, video 10, section 5) | Replay mode is P1; live upgrade still undecided | Replay runs end to end; tag matches reality; check git diff between scenarios shows fixtures only |
| 15 | Both resolution paths shown: revalidate and accept-exception (video 10) | Accept-exception for B may not ship | Both clicks work in the replay |
| 16 | Positioning line names Radicle (video 1) | The prior-art note flags Radicle claims as unverified | Read Radicle's docs; check the "proves who authorized a version" wording; cut Radicle if unconfirmed |
| 17 | Competitor rows: Spec Kit, Conductor, AGENTS.md, broadcast (video 11) | Descriptions came from published docs, never tested | Re-read each product's docs; match the README table; cut anything unconfirmed |
| 18 | "What it doesn't do" list (video 12) | Must match README | README lists the same limits |
| 19 | MIT licence, public repo, deployed URL (section 6) | Contest requires them | `LICENSE` present; URL loads from a clean browser |
| 20 | Repo hygiene | Public repo | No client or person names other than Andrew, no private paths, no account IDs or tokens, only synthetic Northwind data |
| 21 | Hand-counted word count of the vision (section 3) | Contest word limit is 150 | Recount in the form field after any edit |

## 8. Open items for Andrew

- Solo entry or a second attendee (PRD §13, item 3).
- Narrator and face cam (item 4).
- Scenario B live or seeded (Tuesday night).
- Whether to describe Scenario B as "replayed" in the form if it stays replay. This draft says yes.
- Name collision check (GitHub, npm, domain) before the repo goes public (PRD §13, item 6).
