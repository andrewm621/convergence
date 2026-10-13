# Live verification (integration stage A)

The M2 control loop, merged into `main`, was deployed and run against the real Cloudflare Artifacts binding with the stub agent. Everything below was observed on the deployed Worker on 2026-10-12 (local evening); the Worker's URL is not recorded here.

Repeat it with `scripts/check-live.mjs` (needs `ENABLE_SMOKE=1`, `AGENT_MODE=stub`):

```bash
set -a; . ./.env; set +a          # DEV_TOKEN
WORKER_URL=https://<worker>.workers.dev node scripts/check-live.mjs [--keep]
```

It seeds a baseline and two forks (`POST /api/smoke/seed?scenario=notifications`), runs the whole of Scenario A and a second, fast-forward scenario, prints PASS/FAIL per check with timings, and purges the `smoke-*` repos unless `--keep`. The last full run was 40/40.

## Verified live

| Checklist item | Result | Observed |
|---|---|---|
| Seed baseline + 2 forks on real Artifacts, creation tokens revoked | pass | 7 to 8 s |
| `init` reads the accepted records from the real baseline | pass | 0.8 to 1.6 s |
| Register WI-1 and WI-2 | pass | 0.3 to 0.6 s each |
| Both stub agents dispatched concurrently, push verified | pass | runs overlapped (about 15 s each, 25 to 31 s for both responses) |
| `ForkPushed` for both forks (the poller saw the real pushes) | pass | 0.4 to 2 s after the runs returned; the recorded heads equal the verified heads |
| Prose-only change | pass | `NO_ACTION` / `PROSE_ONLY`; no work item changed; request 1.1 to 3.6 s |
| `notifications` v2 context change | pass | WI-2 stale (`STALE_RECEIPT`, `FACET_CHANGED`), WI-1 untouched (`NO_DEPENDENCY_ON_CHANGED_FACETS`), both in the ledger |
| **Stale-evaluation latency** (request to WI-2 Stale in `GET /state`) | pass | **1.35 s, 1.46 s, 3.6 s, 3.97 s** across four runs (limit 10 s). The change is observed inside the request (`observed: true`); the time is the commit push plus the read-back |
| Context commit author/committer survives Artifacts | pass | `log()` shows author `decision-owner`; the cell only accepts a commit whose committer is the Worker, and v2 was accepted, so the committer survived too |
| Gate dry-run | pass | stale WI-2: `STALE_RECEIPT`, `FACET_CHANGED`, `CLAIM_CONFLICT`, `SUPERSEDED_BASIS`; WI-1: pass, no codes; about 55 ms |
| Promote WI-1, real merge (baseline had moved) | pass | baseline head has 2 parents; `PromotionMerged` in the ledger; 1.6 to 3.2 s. The in-Worker isomorphic-git merge on the in-memory fs works against real Artifacts |
| Promote, fast-forward (baseline unmoved) | pass | merge commit equals the fork head; 1.2 s |
| Merge recorded as `kind=merge` | pass | `GET .../poller` now lists `written` commits; both the merge commit and the fast-forwarded fork head show `kind: merge`. The poller's `BaselinePushed` for the merge carries no records |
| Revalidate resolution for WI-2 | pass | `REVALIDATION_STARTED` plus `DISPATCH_WORK` effects |
| Stub re-dispatch with the new context, then claims | pass (operator step) | 17 to 20 s; claims re-cite `notifications@2` with `opt-in` / `weekly-digest`; poller recorded the push 0.4 s later |
| WebSocket with `delta.v1` + bearer subprotocol (Node client) | pass | server selected `delta.v1`; first frame is a `snapshot`; then one `event` per ledger line, plus `agent-activity` |
| `ledger/verify` | pass | `ok: true` on every scenario, 5 to 12 lines |
| Agent principal on a resolution | pass | `403 FORBIDDEN_ACTOR`, and a `NO_ACTION` line in the ledger |
| No bearer | pass | `401` |
| Poller health at the end | pass | healthy, no degraded repos |
| Concurrent Artifacts pushes / `stale ref` | not hit | no retry was needed |
| `log()` returning `[]` for an unresolvable ref | not hit | |

## Failed, and how it was fixed

1. **The stub agent blocked its own work item.** It claimed every context record it read, so WI-1 (which depends only on `status-model`) claimed `notifications` too and the gate failed with `UNDECLARED_DEP`. Fix: the stub cites only the records its prompt names (by id or first word), falling back to all when none match. Tested in `stub-agent.test.ts`.
2. **List facets became a string.** `status.values: [draft, active, blocked, done]` was claimed as the string `"[draft, active, blocked, done]"`, a false `CLAIM_CONFLICT`. Fix: the stub reads flow lists as arrays.
3. **The stub could not read the records the Worker writes.** The Worker quotes facet keys (`"notifications.cadence": ...`), the stub's reader did not, so a revalidation run produced zero claims and `NO_CLAIMS`. Fix: quoted keys are read.
4. **Cost-cap bypass paths in the gateway meter** (the finding from commit 33fcd24). See below.
5. **Parser differential and unbounded reads in the gateways** (security review, commit `fix(m1): canonicalize forwarded model body; bound body reads before buffering`). The model gateway forwarded the raw request text when nothing was dropped or clamped, so a duplicate `model` or `max_tokens` key (read last by our `JSON.parse`, possibly first upstream) could pass the pin and the ceiling and then run something else. It now always forwards `JSON.stringify` of the validated object, and sizes the call by the larger of the received and forwarded bytes (lone surrogates and invalid UTF-8 come out well-formed). The model gateway used to `await request.arrayBuffer()` before the size check; it now reads through `readBodyLimited` and stops at 8 MB with `413`. The git gateway passed a declared-length body through unbounded; `limitStream` now always applies, and a body that runs past 64 MB gets `413`. Tests: duplicate keys, canonical output, chunked oversize bodies, and a false `content-length`, for both gateways.

### Cost-cap audit (`gateway-logic.ts`)

| Path | Finding | Fix |
|---|---|---|
| Reported cost below tokens x price | A positive `cost` (even `1e-12`) was trusted over the token count | Charge `max(reported, tokens x table price)` |
| Zero cost accepted by the meter | `recordUsage` took `cost: 0` for a call that used tokens | A zero or missing cost for a call with tokens is replaced by the reserved worst case |
| Usage fields dropped as zero | An unreadable `input_tokens` (fraction, string, huge) was summed as 0 beside valid cache fields | Any present-but-unreadable field makes the usage incomplete, so the call is charged its worst case |
| Zero input tokens | A "complete" stream reporting 0 input was believed | Zero input is not complete |
| Reasoning and OpenAI-style counts | Reasoning tokens reported only separately were not counted | The larger of `output_tokens`, `completion_tokens` and the reasoning figures; `prompt_tokens` likewise for input |
| Request id reuse | A settled id could be admitted again, so a stale report could settle the new reservation with a smaller figure | Settled ids (at most 40) are kept in the meter and refused; old stored meters still load |
| Float rounding | Ten charges of 0.025 sum to just under 0.25 and did not trip the cap | A total within a nano-dollar of the cap is at the cap |
| Reservation vs settlement | Checked, no gap: the reservation prices the whole body as input tokens at top rates plus `max_tokens`; settlement can only be higher, and an overshoot trips the meter | none |
| Concurrent runs sharing a meter | Checked, no gap: the meter lives in the work item's Durable Object (synchronous admit and settle) and is keyed by run id; an old run's calls are refused (`403 unknown run`) | none |
| Cache read/write tokens | Checked, already summed into input at the top rate | none |

Tests are in `gateway-logic.test.ts` (new `cost cap:` blocks) and `outbound.test.ts`.

## Cheap-model run through the hardened gateway

`openai/gpt-6-luna`, the WI-2 task, `AGENT_MODE=claude`, gateway caps on: the run **succeeded** (push verified as `workitem-wi-2-m1`, valid and accurate claims, 42 s, 7 model calls, 12 turns). Claude Code worked with the body whitelist, the header whitelist and the canonical re-serialized body. Usage was **settled, not worst-cased**: the meter shows 96,967 in and 1,735 out tokens and $0.0255, which is exactly those tokens at the table's top rates, not the roughly $0.03 per call a worst-case charge would add up to. At luna's list price ($0.10 / $0.50 per M) the real spend was about $0.011, under the $0.02 limit.

Findings from getting there:
- **Cap `0.02` cannot start the run.** The reservation for the first call (whole body as input tokens at the table's top rate, plus `max_tokens`) was already above $0.02, so no call was admitted (0 model requests). Cap `0.05` died on the 7th call, because the meter now charges tokens at the table's top rates (luna's `0.25 / 0.75` is 2.5x its list price). It completed at `0.08`. Keep `AGENT_MAX_COST_USD` well above the cheap models' real cost: the cap is in table dollars. At the default `0.25`, `anthropic/claude-sonnet-5.5` (table `4 / 10`) probably cannot start either (first reservation about $0.3 or more for a Claude Code body of 50 to 80 KB); this was computed, not run.
- The Worker is back in stub mode with the default cap (`0.25`) and smoke endpoints off.

## Operational notes

- **Deploys propagate slowly.** For several seconds after `wrangler deploy` (and a 5 s sleep), requests were still served by the previous version: with `ENABLE_SMOKE` back at 0, `POST /api/smoke/seed` still created repos. The stray repos were purged (redeploy with `ENABLE_SMOKE:1`, `DELETE /api/smoke`, redeploy). Wait a while before relying on a changed var.
- **No migration needed for `tracked_repos`**: before this deploy the live `WorkspaceCell` was the M0a skeleton (it only answered `getId()` and created no tables), the control-loop code existed only on a branch with no credentials, and the first `init` created every table with `CREATE TABLE IF NOT EXISTS`.
- A facet-only context change keeps the old prose unless `prose` is sent (the v2 record kept "updates immediately" text). The script sends prose.
- A baseline `git clone` of a larger repo was not tried; the merge ran on repos of 4 to 10 files.
- Context-change latency varies from 1.1 to 3.9 s between runs (Artifacts push and read-back), always well under 10 s.

## Still unverified

- **Receipt re-issue after a revalidation (M4).** Nothing sends `ReceiptIssued` to the cell, so after the revalidated push WI-2 keeps its v1 receipt and stays Stale (`STALE_RECEIPT`); promoting WI-2 after a revalidation therefore cannot be shown live. `DISPATCH_WORK` is only announced as `agent-activity` (the operator dispatched the stub by hand). The loop is closed by wiring the verified revalidation result (the Worker computes the expected receipt already) into `recordObservation`.
- **Contract-test evidence.** `EvidenceRecorded` is internal-only and nothing records it from the agent runtime, so the live work items were registered with `requires: []`. A `requires: ["contract-test"]` item cannot pass the gate live.
- **A browser's WebSocket handshake** (Node's client was used, with the same subprotocol), and reconnect with `?since=`.
- Poller failure paths against the real service (backoff, degraded notes, a baseline far ahead), alarm cadence over a long idle period, and the Queue path (not implemented).
- Subrequest limits and latency on a large repository, and a merge conflict (`MERGE_CONFLICT`).
- `meta.evaluationMs` is `0` in live frames: the runtime clock only advances on I/O, so the strip should use request timings, not that field.
