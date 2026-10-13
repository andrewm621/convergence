# The shelter act, live

> Synthetic scenario. Not operational guidance. Larkhaven County, its river flood and the Larkhaven Mutual Aid Network are invented.

The second act of the demo is the Larkhaven County shelter policy: knowledge work, no code. The console replays it from fixtures (`?mock=1&scenario=shelter-intake`, five drafts). This page is the live version: two real model agents each write a real document on their own fork, the policy changes while they work, and the Worker's deterministic rules do the rest. No model decides a condition, an authorization or a promotion.

## What happens

| Item | Document | Relies on (`shelter-intake-policy`) | When v2 lands |
| --- | --- | --- | --- |
| SH-1 Front-desk intake script | `scripts/front-desk.md` | `pets`, `id_required` | stale and blocked |
| SH-2 Cots and blankets supply list | `supplies/cots-and-blankets.md` | `capacity_note` | untouched, ready |

v2 admits crated pets (pet area in Hall B) and stops listing ID as a requirement. Both agents read the same record. Only SH-1 relied on the facets that moved. The stale file is `scripts/front-desk.md`, not the record that changed (`context/shelter-intake-policy.md`): it merges cleanly and is still wrong.

Revalidating SH-1 makes the Worker issue a new receipt at v2 and re-dispatch the agent with the v2 context. The Worker then runs its own contract check (`checks/shelter-intake.check`, plain text matching in `scenarios/shelter-intake/src/check.ts`) on the pushed script: it must name Hall B and must not still say "service animals only" or "ID required". The gate passes and SH-1 promotes. SH-2 promotes as a real merge on a baseline that has moved.

## How it is wired

- `POST /api/smoke/seed?scenario=shelter-intake[&label=<name>]` (needs `ENABLE_SMOKE=1`) creates the baseline with `AGENTS.md`, `context/shelter-intake-policy.md` and `context/volunteer-roles.md` at v1, plus two forks. It answers with the policy to `init`, the two work items (title, document path, prompt, declared dependencies, `requires`) and the mid-run decision (`contextChange`). The fixtures are `apps/worker/src/smoke-shelter.ts`.
- `AGENTS.md` in the baseline carries a table of task, document path and relied-on facets. A re-dispatch is given only the work item title, so the table is how the agent finds its file and its facets again.
- The records name the demo identity (`decision-owner`) as their authority, because the bearer secret stands for that one human. The replay's fixtures name a shelter coordinator; the text is otherwise the same.
- SH-2 has no `requires`, so it needs no test: a first push gets no Worker-run evidence. SH-1 requires `contract-test`, which the revalidation run produces.
- Claims are agent-asserted. The supply agent is told to claim `capacity_note` only: a claim on a moved facet would make it stale too (rule R3).

## Run it

The Worker needs `ENABLE_SMOKE=1`, `AGENT_MODE=claude` and the `OPENROUTER_API_KEY` secret (see `docs/agent-runtime.md`). `AGENT_MAX_COST_USD` is 1.00 in `wrangler.jsonc`, enough headroom for a stronger model.

Stage it for camera (seed, two agents, decision change while they run, stop with SH-1 stale and blocked and SH-2 ready; the repos are kept):

```bash
WORKER_URL=https://<worker>.workers.dev DEV_TOKEN=... node scripts/check-live-shelter.mjs --cell shelter-intake-demo --stop-before-revalidate
```

Open `<worker url>/?cell=shelter-intake-demo` in the console. On camera: Revalidate SH-1, watch the re-dispatch, then promote SH-2 and SH-1.

Run the whole act unattended (the repos are deleted at the end, by exact name):

```bash
WORKER_URL=https://<worker>.workers.dev DEV_TOKEN=... node scripts/check-live-shelter.mjs
```

Options: `--model <slug>` runs both agents on an allowlisted model, `--after-push` lands v2 after both agents have pushed instead of while they run, `--keep` leaves the repos. A cell name must be `shelter-intake-<something>` and must not exist yet; there is no cell reset.

If the contract check fails on the model's rewrite, the script revalidates once more (the policy allows two). A failed check is a real outcome: SH-1 stays blocked until a rewrite passes.

## Evidence and a local-dev caveat

One unattended run on a local `wrangler dev` Worker (real Artifacts, local Docker containers, `z-ai/glm-5.3-flash` for every agent) passed every check: both agents wrote their documents (56 s and 38 s) while v2 landed 25 s after the dispatch, SH-1 went stale (`STALE_RECEIPT`, `FACET_CHANGED`, then `CLAIM_CONFLICT`, `SUPERSEDED_BASIS` once its push arrived), SH-2 stayed green (`NO_DEPENDENCY_ON_CHANGED_FACETS`), the revalidation re-dispatch rewrote the script (41 s) and the Worker's own contract check passed on it, both promotions merged, and the ledger chain verified. The gateways metered about $0.03 for the three runs.

In the same local setup, most other attempts stalled: the Durable Object of one agent stopped answering `GET /api/agents/runs/<id>` while its container was still working (the `doRefresh` read of a container file never returned), and only restarting `wrangler dev` freed it. It was not seen with the stub and was not reproduced against a deployed Worker, which has not been tried. Treat it as a local-dev finding until it is seen or ruled out on the deployed Worker, and stage the act (`--stop-before-revalidate`) well before filming. Nothing in the control loop depends on it.
