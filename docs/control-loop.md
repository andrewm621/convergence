# The control loop (M2)

A baseline or fork push becomes a deduplicated `DeltaEvent`, runs through the pure `reconcile()` inside a per-scenario Durable Object, lands in a hash-chained ledger, and streams to the console. No model is involved anywhere in this path.

```
Artifacts repos --poll (alarm, every POLL_INTERVAL_MS)--> observe.ts: commit -> DeltaEvent
                                                              |
HTTP (Hono, bearer guard) -> routes.ts -> WorkspaceCell DO ---+--> processEvent (delta-core, serial)
   actor from the session                  (SQLite: state,        |--> state + ledger line, one transaction
                                            ledger, dedupe)       |--> effects executed
                                                                  `--> WebSocket fan-out (hibernation API)
```

Code: `apps/worker/src/cell/`. `cell-base.ts` is the Durable Object, `sqlite-store.ts` is the `CellStore`, `observe.ts` maps commits to events, `routes.ts` is the HTTP API, `ports.ts` is the only door to Artifacts.

## One cell per scenario

`WORKSPACE_CELL.getByName(<scenario>)`, SQLite-backed (`new_sqlite_classes` in `wrangler.jsonc`; the tables are created in code, so no further migration). Scenario names are `[a-z0-9-]{1,40}`.

Everything that changes state runs through one promise chain inside the object, so events are applied one at a time. The store's head check is the second line of defence, and `processEvent` retries if it ever loses that race.

### Tables

| Table | Holds |
|---|---|
| `cell_kv`, `cell_records`, `cell_work_items` | The `CellState`, split into rows so a commit rewrites only what changed |
| `cell_processed` | The R9 dedupe table (key and fingerprint) |
| `ledger` | One row per `ReconciliationEvent` |
| `ledger_head` | **The ledger head (seq, hash) as its own row**, written in the same transaction as the line it points at |
| `tracked_repos` | Watched repos, each with a poll cursor, failure count and last error |
| `written_commits` | Baseline commits the Worker itself pushed (see the trust boundary) |
| `record_paths`, `idempotency`, `meta_kv` | Where each record lives, answered Idempotency-Keys, scenario name, policy |

The head is never derived from the last ledger row. `commit` checks that the head row and the last line agree and refuses to append otherwise (`LedgerCorruptionError`). `GET .../ledger/verify` re-derives every hash and link and compares the end of the chain with the head row, so a deleted tail is caught as well as an edited line.

## Auth and actors

All routes are under `/api`, behind the existing bearer guard. The guard also accepts the secret from the WebSocket subprotocol (browsers cannot set headers on a WebSocket): `Sec-WebSocket-Protocol: delta.v1, bearer.<base64url(secret)>`.

There is one shared secret and no user accounts, so the secret stands for one human, the demo identity (`DEMO_ACTOR_ID`, default `decision-owner`, which must match the authority in the scenario's policy). Rules:

- **The actor of a Resolution, a PromotionRequested or a context change is derived from the authenticated session** in `auth.ts` and passed to the cell as an argument. No body is read for it. Bodies are strict: an `actor` field is a 400.
- `X-Delta-Principal: agent:<id>` (or `system:<id>`) can only **narrow** the session to a non-human. It cannot widen it, so lying in that header gains nothing. A non-human gets `403 FORBIDDEN_ACTOR` on every resolution, promote and context-change route, and the refusal is written to the ledger. The agent runtime never holds the secret, so it cannot reach `/api` at all.

## REST API

Every mutating route requires an `Idempotency-Key` header (`[A-Za-z0-9._:~-]{1,128}`) and a JSON object body. Errors look like `{ "error": { "code", "message" } }`.

| Route | Purpose |
|---|---|
| `POST /api/scenarios/:s/init` | `{ baselineRepo, policy }`. Reads the baseline head, loads the accepted records, starts the poller. `201` |
| `POST /api/scenarios/:s/work-items` | Register a work item: `{ id, title, forkRepo, requires?, intent?, source?, dependencies: [{ recordId, facetKeys }], baseCommit?, agent? }`. Builds the receipt, starts watching the fork. `201` |
| `GET  /api/scenarios/:s/state` | The `CellSnapshot` (the same object the WebSocket sends first, with `ledgerTail` reaching back to the latest baseline push). The polling fallback |
| `GET  /api/scenarios/:s/ledger?afterSeq=&limit=` | `{ entries: ReconciliationEvent[], head }` |
| `GET  /api/scenarios/:s/ledger/verify` | `{ ok: true, length, head }` or `{ ok: false, brokenAt, reason }` |
| `GET  /api/scenarios/:s/context/:recordId` | The prose of the record's accepted version, as `text/markdown` (prefills the Propose change editor) |
| `GET  /api/scenarios/:s/poller` | Poll interval, and per repo: cursor, failures, last error, last poll time |
| `POST /api/scenarios/:s/context-changes` | The Worker commits a context change to the baseline as the authority. Returns `{ commitSha, version, kind, path, decisionPath, observed }` |
| `GET  /api/scenarios/:s/work-items/:id/gate` | Dry-run promotion gate: `{ pass, reasonCodes, blockers, waivedBy, baselineCommit, snapshotHash, forkHeadSha }` |
| `POST /api/scenarios/:s/work-items/:id/resolutions` | `revalidate`, `accept-exception` (needs `scope`) or `reject`, each with `rationale` and the `binding` the human was looking at. `workItemId` may be repeated in the body; it must match the path |
| `POST /api/scenarios/:s/work-items/:id/promote` | `{ expectedBaselineCommit, forkHeadSha }` (and optionally `workItemId`). Two-phase, see below |
| `GET  /api/scenarios/:s/ws` | WebSocket upgrade, `?since=<seq>` to resume |

The gate endpoint calls `evaluateGate`, which runs the same `gateFrom` the reconciler runs inside `PromotionRequested`, so the preview and the real thing cannot disagree.

### Context change

Body: `{ recordId, facets?, not?, prose?, rationale, bumpVersion?, decisionSlug?, expectedBaselineCommit? }`.

- Facets that differ from the current ones (or `bumpVersion`) make **version N+1** plus `decisions/NNNN-<slug>.md`.
- Same facets with new `prose` is a **prose edit**: same version, no decision file. The reconciler answers `NO_ACTION` / `PROSE_ONLY` (the typo beat).
- The record is rebuilt from the version the reconciler accepted (read by blob hash), not from whatever file sits at the baseline head.
- Only the record's authority (the policy's, else the sitting version's) can change it, and only a human: otherwise `403 FORBIDDEN_ACTOR`.
- The commit is authored by the acting human and committed by the Worker (`delta-convergence`), pushed with 3 retries and jitter on `stale ref`. `expectedBaselineCommit` and the port's `expectedHead` are compare-and-swap: `409 BASELINE_MOVED`.
- The cell then observes its own commit immediately instead of waiting for the next tick. The poller sees it too, and R9 drops the repeat.

### Promotion

1. Catch up on the baseline and the fork, so the reconciler's re-check runs against heads that exist now.
2. `PromotionRequested` runs the gate. If it fails: `409 PROMOTION_BLOCKED` with the reason codes. If the caller's `expectedBaselineCommit` or `forkHeadSha` is stale: `409 BASELINE_MOVED` / `HEAD_MOVED`. If it passes, the reconciler emits `ALLOW_PROMOTION`.
3. The cell merges the fork head into the baseline (`ArtifactsPort.mergeFork`), compare-and-swap on both heads. A conflict is `409 MERGE_CONFLICT`.
4. `PromotionMerged` runs the gate **again** and only records a promotion if it still passes.

Promotions are serialised by the cell. A double click with the same key replays the first answer; with a new key it is `409 ALREADY_PROMOTED`. If the merge fails for an unexpected reason the answer is a stored `502 MERGE_FAILED`: retry with a new key.

### Idempotency

A key is remembered with a fingerprint of the request (route, actor and body). The same key and request replays the stored response with `Idempotent-Replay: true`. The same key with a different request is `409 IDEMPOTENCY_CONFLICT`. Responses of status 500 and above are not remembered, except `MERGE_FAILED`. The key is also the `requestId` of the ledger command, so the reconciler dedupes on it as a second line of defence.

### Status codes for refusals

The reconciler writes refusals down as `NO_ACTION`/`BLOCK_PROMOTION` with a reason code; the API maps them: `FORBIDDEN_ACTOR` 403, `UNKNOWN_WORK_ITEM` 404, and 409 for `STALE_BINDING`, `BASELINE_MOVED`, `HEAD_MOVED`, `ALREADY_PROMOTED`, `ALREADY_RESOLVED`, `NOTHING_TO_REVALIDATE`, `REVALIDATION_LIMIT`, `IDEMPOTENCY_CONFLICT`. A refused command still gets a ledger line.

## WebSocket protocol

Connect to `GET /api/scenarios/:s/ws[?since=<seq>]` with the secret in the subprotocol (above). The server selects `delta.v1`. Every frame is a text message holding **a contracts `WsMessage` exactly as the contract defines it, plus one extra top-level key, `meta`**. The strict `WsMessage` schemas do not know `meta`, so split it off before parsing (`parseFrame` in `cell/api.ts` does, and validates both halves).

```jsonc
{ "type": "event", "event": { /* ReconciliationEvent */ }, "workItems": [ /* touched */ ],
  "meta": { "seq": 12, "evaluationMs": 3.4, "baselineCommit": "...", "snapshotHash": "...", "dependencies": [ ... ] } }
```

| `type` | `meta.seq` | Sent |
|---|---|---|
| `snapshot` | the ledger head it is current at | first, always; again on a client `"resync"` text message |
| `event` | the ledger line's seq | once per applied event, with the work items it touched |
| `agent-activity` | the ledger head when it was sent | live only; not stored or replayed |

`meta` fields (all in `WsMeta`, `cell/api.ts`):

- `seq`: always present. `agent-activity` has no `seq` of its own in the frozen contract, so this is where it lives. A client resumes with the highest `seq` it saw.
- `gap` (snapshot): more lines were missed than are replayed, or `since` is ahead of the server. Trust the snapshot, not the replay. A resumed connection always starts with a snapshot, so a snapshot after a resume is the resync signal.
- `replay` (event): the line is being re-sent after a reconnect.
- `evaluationMs` (event) and `evaluationMsBySeq` (snapshot, for the lines in `ledgerTail`): how long the reconciler plus its atomic commit took, for the "N evaluated, K stale, time" strip. Coarse: the runtime's clock only advances on I/O.
- On a **live** `event`: `baselineCommit`, `snapshotHash`, `dependencies` (when the event can change them: registration, fork push, dependency decision) and `records` (the histories of the records a `BaselinePushed` touched), so a client need not re-read the state. Replayed events carry only `seq`, `replay` and `evaluationMs`.

Other behaviour:

- **Resume:** reconnect with `?since=<seq>`. The server sends a fresh snapshot, then the ledger lines after `since` as `event` frames with `meta.replay`, in order (up to 200). Replayed frames carry the touched work items' state *now*, not as it was at that line.
- **`ledgerTail`** in the snapshot reaches back to the latest `BaselinePushed` (at least 50 lines, at most 300): that line holds the "left alone" decisions (`NO_DEPENDENCY_ON_CHANGED_FACETS`) for every unaffected work item.
- **Keepalive:** send the text `ping`; the runtime answers `pong` without waking the object.
- Effects reach the console inside `event` frames (`message.event.payload.effects`).
- If the socket fails, poll `GET .../state` every few seconds.

## The poller

`alarm()` runs every `POLL_INTERVAL_MS` (default 3000) for as long as the scenario has a baseline. Per tick:

1. `log({ limit: 1 })` on every tracked repo, in parallel. Nothing else happens for a repo whose head equals its cursor.
2. For a repo that moved, read up to 50 commits and walk back to the cursor.
   - **Baseline:** every new commit, oldest first (a typo fix and a decision change can land within one poll).
   - **Fork:** only the newest commit, because claims and `contextPaths` are replaced by every push.
3. Map each commit to a `DeltaEvent` (`observe.ts`), run `processEvent`, advance the cursor.
   - `BaselinePushed`: the context records the commit changed (diffed against the first parent), parsed and hashed, plus the snapshot hash of the whole context tree.
   - `ForkPushed`: `.delta/claims.json` at that commit (`null` if absent, the raw text if it is not JSON, so it reads as `MALFORMED_CLAIMS`), and **`contextPaths` from a tree diff of the fork against the baseline commit it was forked from**. If that diff cannot be made after repeated failures, the push is delivered with a sentinel path, so it fails closed.
4. A failing repo is retried on the next tick; after 4 failures on one commit the poller gives up on it and records why (`GET .../poller`).

Dedupe is R9: `(repo, commitSha)`. The Queue path later calls `observePush(repo, sha)` on the cell, which uses the same mapping and the same dedupe, so a push seen by both yields one ledger line. Queues are not implemented.

An alarm every few seconds per scenario is the idle cost of polling.

## Effects

| Effect | What the cell does |
|---|---|
| `RECORD_CONDITION`, `BLOCK_PROMOTION`, `REQUEST_REVIEW`, `NO_ACTION` | Written to the ledger and broadcast in the `event` frame. The console reacts to them there |
| `ALLOW_PROMOTION` | The promote request is waiting for it: it merges, then records `PromotionMerged` |
| `DISPATCH_WORK` / `REQUEST_REVALIDATION` | Announced as an `agent-activity` status line. **Re-dispatching the agent is not wired here** (M4): override `onDispatchWork` in `CellBase` |

A failing effect never fails the request that caused it; the ledger line is already written.

Internal Durable Object RPC (not reachable over HTTP): `recordObservation(event)` for Delta-run `EvidenceRecorded` and `AgentRunStarted/Finished`, `publishActivity(activity)`, `observePush(repo, sha)`, `pollNow()`.

## Trust boundary

What follows is what the Worker enforces on top of `packages/delta-core/DESIGN-NOTES.md`.

1. **The Worker is the only writer to the baseline.** It remembers the sha of every commit it pushes (`written_commits`). The poller turns a baseline commit's context record into an accepted version only if **all** of these hold:
   - the cell recorded that sha when the Worker pushed it;
   - it was recorded as a *context change*, never a promotion merge (a merge carries a fork's files);
   - its committer is the Worker (`delta-convergence`) and its author is the record's authority. The authority is the policy's, else the sitting version's, never the record file's own `authority` text. A record's first version has no sitting authority; then it must be the human the Worker wrote it for.

   Anything else that changes a record under `context/**` is reported as `invalid` in `BaselinePushed` and the reconciler ledgers `RECORD_NOT_ACCEPTED`. The reconciler's own check of `accepted_by` still applies on top. A record file may not name its own location either: only an accepted, authorised file sets `record_paths`.

   *Security review finding, fixed:* an earlier version of `observe.ts` compared only the commit's author name with the authority. Author and committer names are text anyone holding a write token can set, so a forged commit authored as the authority, with a file claiming `accepted_by` the authority, was accepted. `observe.test.ts` pins this down (it failed against that version). The same review led to three smaller changes: `init` takes authority from the policy only; a work item's `baseCommit` must be a real commit of the baseline (it is what `contextPaths` is measured against); a context change builds on the accepted blob, so a rejected file cannot leak into the next version.
2. **Fork commits can never yield an accepted version.** The poller maps a fork commit to `ForkPushed` only. Its `contextPaths` come from the tree diff, not from anything the agent says, and a non-empty list blocks promotion (`FORK_EDITS_CONTEXT`, not waivable). Claims are compared with accepted facets and cannot lower a bar.
3. **Actors come from the session** (above), never from a body, a header that widens, or commit metadata. Commit author names are used only to compare with an authority, never to establish who acted.
4. **The ledger head is its own row**, and verification compares it with the chain.
5. **Residual trust:** whoever holds the bearer secret is the human. A crash between the Worker's push and the write to `written_commits` leaves that commit unaccepted forever (fails closed); repeat the change. Real per-user auth is post-contest.

## Configuration

`wrangler.jsonc` vars: `POLL_INTERVAL_MS` (100 to 60000, default 3000), `DEMO_ACTOR_ID`, `DEMO_ACTOR_NAME`. Secret: `DEV_TOKEN`. No account id anywhere.

## Testing

- `src/cell/sqlite-store.test.ts`: the shared `describeStoreConformance` and `describeInvariants` suites, unchanged, against `SqliteCellStore` on Node's SQLite, plus tamper, truncation and persistence tests.
- `src/cell/sqlite-store.workerd.test.ts`: the same suites against **real Durable Object SQLite**.
- `src/cell/cell.workerd.test.ts`: the whole loop in workerd (Miniflare): real alarms, WebSockets and routes; Scenario A end to end, the trust boundary, idempotency, promotion, restart.
- `src/cell/observe.test.ts`, `auth.test.ts`, `context-change.test.ts`, `src/artifacts/git-merge.test.ts`: units.

`@cloudflare/vitest-pool-workers` was not used: its newest release requires vitest 4 and the repo is on vitest 5. The workerd tests drive Miniflare directly instead (`testing/workerd.ts`; it bundles `testing/test-worker.ts` with esbuild). Artifacts is the in-memory fake (`testing/fake-artifacts.ts`) behind the same `ArtifactsPort` as the real adapter.

## For the console (T-5): what matches and what does not

Checked against the console's live client (`apps/console/src/client/` on `claude/t5-console`).

| The console assumes | Here |
|---|---|
| `agent-activity` carries a `seq` | In `meta.seq` (the contract message has none) |
| An explicit gap or resync signal | A snapshot always opens a resumed connection; `meta.gap` says the replay is incomplete |
| `event` includes or pairs with dependencies, records, baseline | `meta.dependencies`, `meta.records`, `meta.baselineCommit`, `meta.snapshotHash` on live events |
| `meta.evaluationMs` / `evaluationMsBySeq` | Same names |
| Gate returns `{pass, reasonCodes, blockers?}` | Same, plus `waivedBy`, `baselineCommit`, `snapshotHash`, `forkHeadSha` |
| `ledgerTail` reaches the latest `BaselinePushed` | Yes (50 to 300 lines) |
| Every POST takes an `Idempotency-Key` | Required on every mutation |
| `meta` sits beside a strict `WsMessage` | Yes, that is the frame shape |

Deviations the client must adapt to:

1. **Work item routes are scenario-scoped**: `/api/scenarios/:s/work-items/:id/{gate,resolutions,promote}`, not `/work-items/:id/...`. A cell exists per scenario and a work item id means nothing without it.
2. **Error bodies** are `{ "error": { "code", "message", ... } }` (the Worker's existing convention), not top-level `{ code, message, reasonCodes }`. Blocked promotes put the reason codes in `error.reasonCodes`.
3. **Auth on the WebSocket**: `new WebSocket(url, ["delta.v1", "bearer." + base64url(secret)])`. The console's client currently opens it with no protocol and no secret.
4. **Not implemented**: `GET .../work-items/:id/changes` (per-file diff patches), `POST .../seed` and `POST .../start` (creating repos, registering work items and dispatching agents). Use `POST .../init` and `POST .../work-items` for setup; seeding and starting belong with the agent runtime.
5. **Resolution and promote bodies** are strict: no `actor`, `ts` or `requestId`. `workItemId` is tolerated if it matches the path.

## What only a live run can prove

The fake cannot show: the binding's real `log`/`readTree`/`readBlob` behaviour and latency; `commitFiles` pushing with an explicit author and committer; the in-Worker `isomorphic-git` clone, fetch, merge and push (`artifacts/git-merge.ts`, whose decision logic is unit-tested on a memory fs); token creation and revocation for the merge; alarm cadence against the real service; and a browser's WebSocket handshake with the subprotocol token.
