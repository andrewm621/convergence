# Convergence: Cloudflare submission copy

**Status:** draft v4. On Oct 14 the decision owner approved pitch A, the plain-language swap and the protocol-first vision. Earlier: truth pass on 2026-10-13 against `main` (the build is deployed and the live runs below were verified). Revised for the video script v2, then on Oct 14 at 9:14 PM ET the decision owner switched the video's knowledge-work act from the live Larkhaven County shelter act to the existing sales-ops replay, with the fictional organization renamed from Northwind to Scranton Paper Supply Co. and Compare alternatives shown on the qualified-lead decision. Naming rule: the product is always "Convergence"; "Delta" is only the reconciliation engine inside it, never the product name, outside code identifiers. Final only after the claims in section 7 are checked against the recorded footage and the shipped build. Anything still marked `[AFTER RECORDING: …]` depends on the recorded video.

## 1. Project name

Convergence

## 2. One-line pitch

A draft protocol for decisions people and agents rely on. When one changes, work built on the old version is found and blocked until a named human resolves it.

## 2a. Short description (54 words)

Convergence is a draft protocol for decisions people and agents rely on; this is its first implementation. When an accepted decision changes mid-flight, it finds the work built on the old version, code or documents, and holds it back until a named human resolves it, leaving the rest alone. No model makes those calls.

## 2b. Tagline (11 words)

A protocol for knowing which work was built on which decision.

<!-- Alternate tagline (12 words): When a decision changes, find the work built on the old one. -->

## 3. Vision (149 words)

Letting agents work independently isn't the hard part anymore. Knowing what each piece of work relied on is. A decision changes mid-flight, one agent keeps building on the old version, and everything still merges clean.

We're not necessarily trying to give every agent the same knowledge. We're trying to make independent work possible without losing accountability for the assumptions and commitments behind it.

That's why Convergence is a protocol first: shared records, receipts and rules for the decisions people and agents rely on, with a traceable trail of what each piece of work relied on. A merge check in a code host, a feature built into Artifacts, or decisions outside code entirely could all build on it.

To be straight about where it stands: v0.1 draft, one implementation, evidence from synthetic scenarios. The 81-vector conformance kit is how you check yours, or tell me where the draft is wrong.


## 4. How we used Cloudflare

Each bullet below was checked against the code and the live runs on the deployed Worker. Markers remain only where the recorded footage decides it (`[AFTER RECORDING: …]`).

- **Artifacts:** one baseline repo per scenario holds the code, the versioned decisions (`context/`) and decision records (`decisions/`). Every work item gets its own fork of that baseline, and each agent pushes to its own fork over git. The Worker reads logs and trees through the Artifacts binding and commits context changes and seed data from the Worker using isomorphic-git.
- **Workers:** a Hono API seeds and forks repos, accepts context changes and resolutions, runs the promotion gate, and computes tree diffs and claim comparisons. The console (a React app) is served as Worker static assets.
- **Durable Objects:** one SQLite-backed `WorkspaceCell` per scenario holds work-item state, the append-only hash-chained ledger and the reconcile step, and pushes live updates to the console over hibernating WebSockets (the Durable Object accepts them with the hibernation API).
- **Push detection:** the Durable Object polls each repo's log every few seconds from an alarm and de-duplicates events on repo and commit SHA.
- **Sandbox:** agents run the Claude Code harness headless in Sandbox containers, one per agent, each owned by an `AgentSandbox` Durable Object, and push over git to their own fork. Outbound gateways on that Durable Object add the Artifacts token and the model key, so no credential is ever inside the container.
- **Models:** agents run on models reached through OpenRouter. The recorded live cells ran on `anthropic/claude-sonnet-5.5`, which completed every live run on Oct 14, and the console shows that model on each work item. `minimax/minimax-m3` also completed the shelter task on both forks. Earlier runs used other models and are history, not part of the video: the verified Oct 13 shelter run used GLM, and GPT-6 Luna failed intermittently inside Claude Code. `[AFTER RECORDING: confirm every live shot shows anthropic/claude-sonnet-5.5 on screen, and that no other model label appears in the footage]`

Do not claim Queues, AI Gateway, D1, KV, R2, Workflows or Workers AI. None of them is used in the code. The "gateways" are our own outbound handlers, not the Cloudflare AI Gateway product, and model access is OpenRouter.

## 5. What's real, seeded and replayed

The two Scenario A agents in the video are real agents running at the same time on separate Artifacts forks, on `anthropic/claude-sonnet-5.5`, the model shown on screen; they ran earlier on recording day and the video tags them "agents ran earlier today". The fan-out segment uses 40 seeded, synthetic work items with no model behind them; they are labelled "seeded" in the console and the video. The Scenario B segment is a replay, and the video must label it as a replay. It is the console's sales-ops story for a fictional organization, "Scranton Paper Supply Co.": the `qualified-lead` definition goes from v1 to v2, which adds a verified budget signal (`sales-activity` is untouched). Three work items are in flight: Q4 pipeline forecast, SDR weekly priorities and Activity glossary. After v2 the console reads "2 blocked · 1 left alone": the forecast and the SDR priorities were built on v1 and are held back, and the glossary is left alone. The forecast gets a scoped exception covering `reports/q4-forecast.md`; the SDR priorities are revalidated, re-run, their claims match, and all three merge by step 9 of 9. Its agents, git and clock are scripted, no model runs in it, it was never run live, and the console header reads "Mock · replay". The console banner reads "Synthetic scenario. Scranton Paper Supply Co. is a fictional paper distributor; its leads and pipeline numbers are invented." The video also shows Compare alternatives on the qualified-lead decision: Option A (v2 as drafted) blocks 2 items (forecast and SDR priorities; the glossary is not affected), Option B (criteria back to the v1 wording, verified-budget signal optional) blocks nothing, and an optional Option C (B plus a 100-employee minimum) blocks 1 item, the forecast. Those numbers are pinned in a console test. The story deck's slide "Not just code." (between "From here, it's the deployed product." and "What did you rely on? Is it still accepted?") shows four everyday examples: qualified lead, spring discount, refund window and shelter pets. The earlier Larkhaven County shelter act, a fictional county, also runs live on the deployed Worker with real agents (two real agents on separate forks, the intake policy changed mid-run, the front-desk script blocked and the supply list left alone, as verified on Oct 13); it is not in the video. The live multi-agent run in the video is Scenario A, the notifications act. `[AFTER RECORDING: whether any Scenario A beat used a fallback; update the wording to match]` The README has an "Implemented vs not" table with the full list.

The contract check that Convergence runs on an agent's pushed files is a plain-text match, written per scenario and committed in the repo. It is fixed and deterministic: no model generates or judges it when it runs, and it does not run the project's code. Do not say the checks or tests were "written by hand". The README says only that the tests are fixed fixtures and assertions written ahead of time, with no model involved when they run. How to describe AI help in writing the code is the decision owner's call; the README currently says "Built with AI coding agents, directed and reviewed by the decision owner."

### Comparison wording

Where the form or README mentions other approaches, keep it neutral and sourced: "Spec checks, pull requests, broadcasts and instruction files each cover part of this. Going by their public documentation, none records which in-flight work was built on which version of a decision. We have not tested them side by side." No product names unless each description is checked against the product's published documentation, and no loaded verbs.

## 6. Run instructions (summary)

Commands below follow the README and `package.json`. If they change, the README wins.

1. **Prerequisites:** Node 26 or newer and pnpm 10 or newer (per `package.json`). To run live agents or deploy: a Cloudflare account on Workers Paid with Artifacts and Containers access, Docker to build the container image, and an OpenRouter API key (agents call models through it).
2. **Install and test:** `pnpm install`, then `pnpm test` and `pnpm typecheck` (each runs `pnpm -r`). The tests need no network and no API key. Both passed on a fresh install on 2026-10-14 (contracts 81, delta-core 290, worker 736, console 367, conformance 177, 1,651 in all; typecheck clean), recorded in the README's Tests section. `pnpm conformance` prints `PASS: 81/81 vectors passed (protocol convergence/0.1)`.
3. **Run it:** replay needs no account: `pnpm --filter console dev`, then open `http://localhost:5173/?mock=1`. To serve the console from the Worker: `pnpm build:console`, then `cd apps/worker && npx wrangler dev`. Artifacts has no local emulator, so `wrangler dev` talks to the real service and needs a `wrangler login`. Live mode needs `DEV_TOKEN` as a Worker secret and `pnpm --filter worker exec wrangler deploy`. End-to-end checks: `node scripts/check-live.mjs` (Notifications, stub agents) and `node scripts/check-live-shelter.mjs` (Larkhaven County, real agents). Both need `WORKER_URL` and `DEV_TOKEN`, and `ENABLE_SMOKE=1` on the Worker.
4. **Deployed demo:** `https://delta-convergence.andrew-8c6.workers.dev` (console at `/`, story deck at `/story/`, credential-free replay at `/?mock=1`; all three returned 200 on 2026-10-14).
5. **No credentials?** Replay mode (`?mock=1`) plays a scripted story in the browser through the same rule code, labelled "Mock · replay" in the header. It is shipped.
6. **Repo:** `https://github.com/andrewm621/convergence`. MIT licensed.

## 7. Claims to check against the final build before submitting

| # | Claim (where it appears) | Why it needs checking | How to check |
|---|---|---|---|
| 1 | Each agent runs on its own Artifacts fork; two or more run concurrently (Cloudflare, video 2) | Goal G1, depends on the Sandbox or local-runner outcome | Two forks in the baseline; `AgentRunStarted/Finished` timestamps overlap |
| 2 | Agents run in Sandbox containers (Cloudflare bullet 5) | Confirmed in the deployed build (no local runner exists in the repo); the footage must come from the same runtime | Check which runtime produced the recorded footage |
| 3 | Push detection is polling; Queues are not used (Cloudflare bullet 4) | Queues are not built, so no copy may mention them | Search the form, README and video for "Queue" and delete any mention |
| 4 | Receipts are written as git notes on the fork (video 2) | P1 item | `git notes --ref=delta show` works on a fork |
| 5 | "The control loop makes no model calls" (vision, video 1) | Public claim; ratified in the PRD but confirm in code | No model call anywhere in `delta-core` or the reconcile path; invariant tests pass |
| 6 | Staleness is facet-level; prose-only edits stale nothing (video 3) | Core rule R1 | Test "prose-only edit stales nothing" passes; ledger shows `PROSE_ONLY` |
| 7 | Unaffected work stays untouched (video 4, 9, 10) | Core rule R2 | Test "unaffected work never changes status" passes against all fixtures, including the Larkhaven County negative controls (supply list, shift schedule) and the Scranton Paper sales-ops fixture, with their reason codes. In the Scranton Paper replay the item left alone is the Activity glossary, which relies on `sales-activity` only |
| 8 | Promotion of stale work is blocked until a human resolves it (pitch, video 5) | Core rule R5 | Gate returns fail with reason codes; promote endpoint rejects |
| 9 | Convergence runs a contract check at the fork head and the claim conflict doesn't depend on the agent's honesty (video 4) | Rule R8 | Evidence rows exist; TestFailed appears with no claims |
| 10 | Promote re-checks at current heads (video 8) | Rule R7 | Compare-and-swap on `expectedBaselineCommit`; test for a context push between approve and promote |
| 11 | Ledger is append-only and hash-chained (video 8). Say exactly what was checked and where: the console badge reads "verified in this browser" and re-derives hashes only for the ledger lines the console holds. The full stored ledger is checked server-side by `GET /api/scenarios/:s/ledger/verify`, which `scripts/check-live.mjs` and `scripts/check-live-shelter.mjs` call; the console never calls it. Do not say the UI verified the whole audit log | Chain is P0; the UI indicator is P1. The badge covers lines in view, not the whole server-side log | "chain breaks on any edit" test passes (`invariants.ts`, `ledger.test.ts`); badge visible; `ledger/verify` returns `ok: true` in the recorded live runs |
| 12 | "Clean merge, each branch's own tests green, merged result fails the contract check" (video 0, 5) | Whether any hosted CI exists; whether the contract check runs on the merged tree | State exactly what ran; don't call local test runs a hosted pipeline; run the contract check on the scratch merge and confirm it fails; terminal text legible on the export |
| 13 | Fan-out: N evaluated, K stale, elapsed time; "under a second" (video 9) | Numbers must come from a real run | Record the result strip; use the measured figure |
| 14 | Scenario B in the video (Scranton Paper Supply Co. sales ops, fictional) is a replay on the same engine (vision, video 10, section 5). Larkhaven County runs live on the Worker but is not in the video | The footage must say it is a replay. The Larkhaven County live run was verified Oct 13. "No code changes" holds for the engine, but each scenario also ships fixtures and a seed file, and the Larkhaven County and notifications scenarios a plain-text check (sales ops has none) | Replay runs end to end; on-screen tag says replay; `packages/delta-core` is unchanged between scenarios; Scranton Paper Supply Co. replaces Northwind everywhere in the repo and video. Checked on `main` fe9c05a: no "Northwind" remains in scenarios, worker or console code, the README, the deck or `docs/` (except the rename notes here and the video script, which another change owns); a console test asserts the name is absent, and `AGENTS.md` still uses it as an example of a synthetic organization. Re-grep the video script |
| 15 | Both resolution paths shown in the Scranton Paper replay (video 10): the Q4 pipeline forecast gets an exception covering `reports/q4-forecast.md`, and SDR weekly priorities is revalidated | The Scranton Paper replay has no beat that moves the decision past v2, so it does not show an exception lapsing (the Larkhaven County scenario does, `EXCEPTION_LAPSED`) | Both clicks work in the replay; narrate the exception as scoped with its reason on the record, and do not say it lapses |
| 16 | Receipts on screen list record versions and facet hashes (video 2, 6, 10); the prior-art answer depends on this | A red edge alone looks hand-assigned | Receipt tab at recording resolution shows `recordId@version` and facet hashes; the Why panel links back to them; ledger shows a ruling bound to a version |
| 17 | Neutral comparison of other approaches by category, no product names (video 11, section 5, README "Why not X?") | Rules §4 bans personal attacks on any discernible product; descriptions came from published docs, never tested | Re-read each category's public documentation; match the README table; cut anything unconfirmed; no loaded verbs; say "not tested side by side" |
| 18 | "What it doesn't do" list as one line (video 12) | Must match README | README lists the same limits |
| 19 | MIT licence, public repo, deployed URL (section 6) | Contest requires them | `LICENSE` present; URL loads from a clean browser |
| 20 | Repo hygiene | Public repo | No client or person names, no private paths, no account IDs or tokens, only synthetic data (Scranton Paper Supply Co. and Larkhaven County, both fictional, no real people, companies, agencies or operational detail) |
| 21 | Hand-counted word count of the vision (section 3) | Contest word limit is 150 | Recount in the form field after any edit |
| 22 | Contract checks are fixed, committed and run with no model (video 4, section 5) | Reviewers asked whether the checks are generated. Do not say "by hand"; say they are plain-text matches that no model generates or judges at run time | Each scenario's contract check is committed in the repo; the README says the same in plain words (see Tests) |
| 23 | Agents run on models reached through OpenRouter (section 4; video 2) | Do not name a model the footage doesn't show. The recorded live cells ran on `anthropic/claude-sonnet-5.5`; MiniMax also completed runs; GLM (Oct 13 verified run) and GPT-6 Luna are earlier history | Check the recorded footage and the work items' model chips: every live shot should read `anthropic/claude-sonnet-5.5`; match the on-screen labels; name no other model as part of the video |
| 24 | Scranton Paper segment is labelled as a replay and as fictional (video 10) | The act is a scripted replay and must not read as a live run or a real company. The name is a fictional nod chosen by the owner (owner decision, Oct 14); keep the "fictional" banner on every frame | On every frame of segment 10, the console header reads "Mock · replay" and the banner reads "Synthetic scenario. Scranton Paper Supply Co. is a fictional paper distributor; its leads and pipeline numbers are invented."; the switcher shows "Scranton Paper Supply"; narration says it is a replay and a fictional company; no real company or person named. Larkhaven County is not in the video; wherever it does appear (README, console, form), keep "Synthetic scenario. Not operational guidance." and the fictional note, with no imperatives, seals or alert styling |
| 25 | Naming: the product is "Convergence" everywhere; Delta is only the reconciliation engine, never the product name (video, form, README) | the decision owner's decision, Oct 14 | Search narration, on-screen text, form copy and README for bare "Delta"; only code identifiers (`refs/notes/delta`, `delta-core`) may keep it, plus video segment 11b ("Where this comes from"), where the decision owner names Strata, Delta and Convergence as ideas |

## 8. Open items for the decision owner

- Solo entry or a second attendee (PRD §13, item 3).
- Narrator and face cam (item 4).
- Resolved (Oct 14, 9:14 PM ET): the video's knowledge-work act is the Scranton Paper sales-ops replay, not the Larkhaven County live act. Larkhaven County still runs live on the deployed Worker and is not in the video. Still open: confirm the form and video label the Scranton Paper act as a replay.
- Resolved: the fictional organization in the sales-ops fixture is renamed from "Northwind" to "Scranton Paper Supply Co.". Keep checking the final video and copy for any leftover "Northwind". The earlier county rename (from a name real US counties share to "Larkhaven County") also stands.
- Which models to name in the form: the section 4 wording names Sonnet 5.5 for the recorded cells. Confirm it against the footage.
- Name collision check (GitHub, npm, domain) before the repo goes public (PRD §13, item 6).
