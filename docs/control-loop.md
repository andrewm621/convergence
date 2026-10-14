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
| `tracked_repos` | Watched repos, each with a poll cursor, the commit it is failing on (and how often), a backoff time, last error and a degraded note |
| `pending_promotions` | A promotion whose merge may have landed without being recorded (see Promotion) |
| `written_commits` | Baseline commits the Worker itself pushed (see the trust boundary) |
| `record_paths`, `idempotency`, `meta_kv` | Where each record lives, answered Idempotency-Keys, scenario name, policy |

The head is never derived from the last ledger row. `commit` checks that the head row and the last line agree and refuses to append otherwise (`LedgerCorruptionError`). `GET .../ledger/verify` re-derives every hash and link and compares the end of the chain with the head row, so a deleted tail is caught as well as an edited line.

## Auth and actors

All routes are under `/api`, behind the existing bearer guard. The guard (`bearerGuard` in `cell/auth.ts`, mounted by `index.ts` and by the test Worker) also accepts the secret from the WebSocket subprotocol (browsers cannot set headers on a WebSocket): `Sec-WebSocket-Protocol: delta.v1, bearer.<base64url(secret)>`. The subprotocol form counts **only on a request with `Upgrade: websocket`**; on anything else it is ignored.

There is one shared secret and no user accounts, so the secret stands for one human, the demo identity (`DEMO_ACTOR_ID`, default `decision-owner`, which must match the authority in the scenario's policy). Rules:

- **The actor of a Resolution, a PromotionRequested or a context change is derived from the authenticated session** in `auth.ts` and passed to the cell as an argument. No body is read for it. Bodies are strict: an `actor` field is a 400.
- `X-Delta-Principal: agent:<id>` (or `system:<id>`) can only **narrow** the session to a non-human. It cannot widen it, so lying in that header gains nothing. A non-human gets `403 FORBIDDEN_ACTOR` on every mutating route: init, work-item registration, context change, resolution and promote. Where the reconciler decides (a resolution or a promotion), the refusal is also written to the ledger as `NO_ACTION` / `FORBIDDEN_ACTOR`. The refusals the cell makes before the reconciler is involved (init, registration, context change) are HTTP-only: the frozen contract has no ledger event that can express them (an additive `ContextChangeRefused` event would; proposed, not built). The agent runtime never holds the secret, so it cannot reach `/api` at all.

## REST API

Every mutating route requires an `Idempotency-Key` header (`[A-Za-z0-9._:~-]{1,128}`) and a JSON object body. Errors look like `{ "error": { "code", "message" } }`.

| Route | Purpose |
|---|---|
| `POST /api/scenarios/:s/init` | `{ baselineRepo, policy }`. Reads the baseline head, loads the accepted records, starts the poller. `201`. Humans only |
| `POST /api/scenarios/:s/work-items` | Register a work item: `{ id, title, forkRepo, requires?, intent?, source?, dependencies: [{ recordId, facetKeys }], baseCommit?, agent? }`. Builds the receipt, starts watching the fork. `201`. Humans only. `409 REPO_ALREADY_TRACKED` if `forkRepo` is the baseline or already watched |
| `GET  /api/scenarios/:s/state` | The `CellSnapshot` (the same object the WebSocket sends first, with `ledgerTail` reaching back to the latest baseline push). The polling fallback. The `X-Delta-Poller` response header (`healthy` or `degraded`) says whether the poller is struggling (the body is the strict contract object, so it has no room for this). `snapshotHash` is computed from the baseline's context tree, not from what the reconciler accepted, so it can differ from a hash of the accepted records when a commit was refused |
| `GET  /api/scenarios/:s/ledger?afterSeq=&limit=` | `{ entries: ReconciliationEvent[], head }` |
| `GET  /api/scenarios/:s/ledger/verify` | `{ ok: true, length, head }` or `{ ok: false, brokenAt, reason }` |
| `GET  /api/scenarios/:s/context/:recordId` | The prose of the record's accepted version, as `text/markdown` (prefills the Propose change editor) |
| `GET  /api/scenarios/:s/poller` | Poll interval, `health` (`healthy` and the failing repos) and per repo: cursor, failing commit and its failure count, backoff, last error, degraded note, last poll time; `written` lists the last 20 baseline commits the Worker pushed (`sha`, `kind` context or merge, `actor`) |
| `POST /api/scenarios/:s/context-changes` | The Worker commits a context change to the baseline as the authority. Returns `{ commitSha, version, kind, path, decisionPath, observed }` |
| `GET  /api/scenarios/:s/dispatches` | The re-dispatches owed to the agent runtime, one per accepted revalidate resolution: phase, run id, receipt hash, `noteRef`, `noteError`, error. `runtime: false` when the cell has no agent runtime |
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
- The cell first catches up on the baseline. If it cannot record the baseline's newest commit, it answers `503 POLLER_BEHIND` (with `Retry-After`) instead of judging a stale picture. Not remembered under the key.
- The cell then observes its own commit immediately instead of waiting for the next tick. The poller sees it too, and R9 drops the repeat. `observed` is true only if the ledger now holds that commit (`processed[repo@sha]`), so `observed: false` means the poller will record it shortly.

### Promotion

1. Catch up on the baseline and the fork, so the reconciler's re-check runs against heads that exist now. If the baseline's newest commit cannot be recorded, `503 POLLER_BEHIND`.
2. `PromotionRequested` runs the gate. If it fails: `409 PROMOTION_BLOCKED` with the reason codes. If the caller's `expectedBaselineCommit` or `forkHeadSha` is stale: `409 BASELINE_MOVED` / `HEAD_MOVED`. If it passes, the reconciler emits `ALLOW_PROMOTION`.
3. The cell writes a `pending_promotions` row, then merges the fork head into the baseline (`ArtifactsPort.mergeFork`), compare-and-swap on both heads. The check runs twice: on the refs before the clone, and again on the refs that were actually cloned and fetched (`mergeInto`'s `expect`), because a push can land in between. A mismatch is `STALE_HEAD` (`409 BASELINE_MOVED`). A conflict is `409 MERGE_CONFLICT`. Two rules cover a fork's own bookkeeping, `.delta/` (its claims, and once revalidated its receipt and delivered context). First, the baseline never carries `.delta/`: the merge commit is the merge without it, with the baseline and the fork head as parents, so a fork that has `.delta/` is never fast-forwarded and a fork cut later cannot inherit another item's claims. Second, a baseline that still holds one (from before that rule) would make every later fork's claims an add/add conflict; when both-modified `.delta/` files are the only conflicts, the fork being promoted wins them, and every other file both sides changed is merged line by line with the same `diff3` isomorphic-git uses (`artifacts/merge-rules.ts`), so a real overlap is still a conflict. A `.delta/` file one side deleted and the other changed is a conflict too, as is a path that only looks like `.delta/` (`src/.delta/x`, `.delta/../x`). Both clear the pending row: nothing was merged.
4. `PromotionMerged` runs the gate **again** and only records a promotion if it still passes.

Promotions are serialised by the cell. A double click with the same key replays the first answer; with a new key it is `409 ALREADY_PROMOTED`. If the merge fails for an unexpected reason the answer is a stored `502 MERGE_FAILED`: retry with a new key.

**A merge that lands but is not recorded** (the response is lost, or the worker fails between the merge and `PromotionMerged`) does not leave the work item stuck. The pending row survives, and on the next poll the cell finds the merge commit in the baseline (the commit whose first parent is the approved baseline and whose second parent is the approved fork head, or, for a fast-forward, the fork head itself), marks it as a `merge`, and writes `PromotionMerged` (the gate runs again). The row is dropped once recorded, or after 10 minutes if no merge ever shows up.

**Fast-forwards.** When the baseline has not moved, the merge is a fast-forward and `mergeCommitSha` is the **agent-authored fork head**. It is recorded as `kind: merge` all the same, so when the poller reads it back as a baseline commit it can never accept context, whoever authored it. The same goes for the fork's earlier commits that a fast-forward brings in: the Worker never wrote them, so they are refused as context too.

### Idempotency

A key is remembered with a fingerprint of the request (route, actor and body). The same key and request replays the stored response with `Idempotent-Replay: true`. The same key with a different request is `409 IDEMPOTENCY_CONFLICT`. Responses of status 500 and above are not remembered, except `MERGE_FAILED`. **4xx responses are remembered**: a refused or invalid request replays the same refusal under the same key, even after the cause is fixed. A client should use a fresh key for each attempt (the console does). `503 POLLER_BEHIND` is not remembered. The key is also the `requestId` of the ledger command, so the reconciler dedupes on it as a second line of defence.

### Status codes for refusals

The reconciler writes refusals down as `NO_ACTION`/`BLOCK_PROMOTION` with a reason code; the API maps them: `FORBIDDEN_ACTOR` 403, `UNKNOWN_WORK_ITEM` 404, and 409 for `STALE_BINDING`, `BASELINE_MOVED`, `HEAD_MOVED`, `ALREADY_PROMOTED`, `ALREADY_RESOLVED`, `NOTHING_TO_REVALIDATE`, `REVALIDATION_LIMIT`, `REVALIDATION_IN_PROGRESS`, `IDEMPOTENCY_CONFLICT`. A refused command still gets a ledger line.

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
- `poller` (snapshot and live event): `{ healthy, degraded: [{ repo, kind, lastError, note }] }`, see The poller.
- On a **live** `event`: `baselineCommit`, `snapshotHash`, `dependencies` (when the event can change them: registration, fork push, dependency decision) and `records` (the histories of the records a `BaselinePushed` touched), so a client need not re-read the state. Replayed events carry only `seq`, `replay` and `evaluationMs`.

Other behaviour:

- **Resume:** reconnect with `?since=<seq>`. The server sends a fresh snapshot, then the ledger lines after `since` as `event` frames with `meta.replay`, in order (up to 200). Replayed frames carry the touched work items' state *now*, not as it was at that line.
- **`ledgerTail`** in the snapshot reaches back to the latest `BaselinePushed` (at least 50 lines, at most 300): that line holds the "left alone" decisions (`NO_DEPENDENCY_ON_CHANGED_FACETS`) for every unaffected work item.
- **Keepalive:** send the text `ping`; the runtime answers `pong` without waking the object.
- Effects reach the console inside `event` frames (`message.event.payload.effects`).
- If the socket fails, poll `GET .../state` every few seconds.

## The poller

`alarm()` runs every `POLL_INTERVAL_MS` (default 3000) for as long as the scenario has a baseline. What it promises:

- **A baseline commit is never skipped.** A lost change would leave a stale work item shown as Fresh. A commit that cannot be recorded stays at the front of the queue and is retried until it is, with backoff and a visible `degraded` status.
- A failing repo backs off (`POLL_INTERVAL_MS`, doubling, up to 30 s) and is reported, not abandoned. `pollNow()` and the catch-ups inside `promote` and `changeContext` ignore the backoff.
- **Only a fork commit may degrade**, because the fork's next push supersedes it. Failures are counted per `(repo, commit)` and reset on success. After 2 failed attempts at one fork commit it is delivered **fail-closed** (unreadable claims read as `MALFORMED_CLAIMS`; an uncomparable tree gets a sentinel `contextPaths` entry), and after 6 it is skipped with a note that stays until a later commit reads cleanly.

Per tick:

1. First, any pending promotion whose merge landed is finalized (see Promotion), so its commit is read as a merge.
2. `log({ limit: 1 })` on every tracked repo, in parallel. Nothing else happens for a repo whose head equals its cursor.
3. For a repo that moved:
   - **Baseline:** read history 50 commits at a time (`log` with `offset`) until the cursor is found, then record every new commit oldest first. A baseline that jumped by hundreds of commits loses none. If the cursor is not found within 5000 commits it is an error and the cursor does not move.
   - **Fork:** only the newest commit, because claims and `contextPaths` are replaced by every push.
4. Map each commit to a `DeltaEvent` (`observe.ts`), run `processEvent`, advance the cursor.
   - `BaselinePushed`: the context records the commit changed (diffed against the first parent), parsed and hashed, plus the snapshot hash of the whole context tree.
   - `ForkPushed`: `.delta/claims.json` at that commit (`null` if absent, the raw text if it is not JSON, so it reads as `MALFORMED_CLAIMS`), and **`contextPaths` from a tree diff of the fork against the baseline commit it was forked from**.

**Health.** `GET .../poller` returns `health`; `GET .../state` carries `X-Delta-Poller: healthy|degraded`; and every `snapshot` frame, and every live `event` frame, carries `meta.poller = { healthy, degraded: [{ repo, kind, lastError, note }] }`. When health changes, connected consoles get a fresh snapshot, so "poller degraded" can be shown without polling. Error text is passed through `redactText` before it is stored, returned or logged.

Dedupe is R9: `(repo, commitSha)`. The Queue path later calls `observePush(repo, sha)` on the cell, which uses the same mapping and the same dedupe, so a push seen by both yields one ledger line. Queues are not implemented.

An alarm every few seconds per scenario is the idle cost of polling.

## Effects

| Effect | What the cell does |
|---|---|
| `RECORD_CONDITION`, `BLOCK_PROMOTION`, `REQUEST_REVIEW`, `NO_ACTION` | Written to the ledger and broadcast in the `event` frame. The console reacts to them there |
| `ALLOW_PROMOTION` | The promote request is waiting for it: it merges, then records `PromotionMerged` |
| `DISPATCH_WORK` | Announced as an `agent-activity` line and queued as a re-dispatch job when the cell has an agent runtime (see Revalidate re-dispatch) |
| `REQUEST_REVALIDATION` | Announced with the same line |

A failing effect never fails the request that caused it; the ledger line is already written.

Internal Durable Object RPC (not reachable over HTTP): `recordObservation(event)` for `EvidenceRecorded` and `AgentRunStarted/Finished` (never `ReceiptIssued`), `publishActivity(activity)`, `observePush(repo, sha)`, `pollNow()`, `stepDispatches()`.

## Revalidate re-dispatch (M4)

A human's `revalidate` Resolution makes the reconciler emit `DISPATCH_WORK`. That is only a request; `cell/dispatch-jobs.ts` answers it in the Worker, so delta-core stays pure. One job per accepted resolution is stored in the cell's SQLite (`dispatch_jobs`, keyed by the resolution's Idempotency-Key, so a replay queues nothing new) and the alarm advances it one phase at a time, beside the poller. No request waits for an agent.

| Phase | What happens |
|---|---|
| `queued` to `prepared` | Reads the NEW accepted records from the baseline by blob hash, checks each parses to the accepted version and facet hash, and builds the receipt from the accepted state: every record the item depends on, at its current version. What changed is worked out from the receipt the item holds to the receipt delivered (a record the item never held counts from v0); a conflict with no version change gives an empty list and a prompt that says so. Two records that would be delivered under one file name fail the job. The runtime id is the lowercase cell id (`WI-2` is `wi-2`, `agents/work-item-ids.ts`; two ids that lowercase alike are refused). Everything is stored before any side effect |
| `prepared` to `receipted` | Writes the receipt as a git note on the fork's current head (`refs/notes/delta`, `artifacts/git-note.ts`; best effort, 25 s limit). On failure it posts an `agent-activity` line and goes on without `noteRef`; on success the receipt carries `noteRef`. Then records `ReceiptIssued` with the receipt it is about to hand over. The Worker writes it, never the agent; there is no HTTP route that can. If the cell did not take it because the accepted context moved in the meantime (`RECEIPT_MISMATCH` while the revalidation is still under way) the job goes back to `queued` and prepares again at the current heads, at most 3 times; any other refusal fails the job and nothing is dispatched |
| `receipted` to `running` | Dispatches the runtime with `revalidate: {changes, context}`, where `context` is the new accepted text, under a key derived from the scenario and the resolution (`redispatch-<hash>`), so a retry replays the same run. Records `AgentRunStarted` with the run id and the model (`stub agent` in stub mode) |
| `running` to `done` | When the run ends records `AgentRunFinished`. If its push is verified, re-reads the fork, confirms the head is that commit authored by the work item and that the cell recorded it, then runs each required contract check on the pushed files and records `EvidenceRecorded` (see below) |

Receipt before dispatch is deliberate: the reconciler only takes a receipt while the revalidation is under way, and the agent's next push ends that state. A failed or lost run leaves the item blocked and the job `failed`, with its error on `GET .../dispatches`, but it ends the revalidation through the ledger: the reducer clears `revalidating` on an `AgentRunFinished` with outcome `failure` or `cancelled` for the run that started during that revalidation (`revalidationRun` on the work item). A job that dies before any run starts, or whose run finished without a verified push, closes the same way: `#fail` submits an `AgentRunFinished` failure under the id `dispatch-failed:<resolution request key>` (an existing event, so no new event type), which the reducer recognises for the latest revalidate resolution only. The item stays blocked afterwards by its stale or conflicting claims (the receipt stays whatever was last issued), promotion stays closed, and each revalidate still counts against `maxRevalidations`. Retry: transient errors back off (2 s doubling) up to 5 attempts under the same key. A runtime that answers `RUN_IN_PROGRESS` (another run for the item is in flight) is not a failed attempt: the job waits a poll interval and asks again, and fails only after 15 minutes of that. A human can revalidate again, up to the policy's `maxRevalidations`. `GET .../dispatches` lists the jobs with phase, run id, receipt hash, `noteRef` and `noteError`.

One revalidation at a time: the reconciler refuses a `revalidate` while one is under way (`REVALIDATION_IN_PROGRESS`, 409, nothing dispatched), and the dispatcher re-checks just before it dispatches that the item is still `revalidating` and not promoted; otherwise the job finishes as `done` with a "superseded" note and the runtime is never asked. `AgentRunFinished` is written once per run, whatever later happens to the job (the job remembers it), so a failing evidence step never adds a contradicting failure line.

Crash gap: at the start of every step the dispatcher sweeps for a work item that is `revalidating` whose latest `revalidate` resolution has no job (the cell stopped between the resolution's ledger line and the job row) and queues it from the resolution's own key (`INSERT OR IGNORE`, so a job in any phase, including `failed`, is left alone). A resolution stored without a request key cannot be matched and is not swept.

**What the evidence is (rule R8: Delta-run, not agent-run).** After a verified push, for each `validation:` path the gate requires, the Worker runs a small pure assertion on the file contents the repo holds at the verified sha (`cell/contract-checks.ts`; the assertions live beside each scenario's fixtures, in `scenarios/*`). It records the result as `EvidenceRecorded` with `kind: "delta-run-check"`, and this is the one kind the Worker records as a test result for `requires: ["contract-test"]`. (The reconciler excludes `delta-claims-check` from counting; evidence with no `kind` is what the scenario fixtures record by hand and counts as before. It can only enter through the cell's internal observation hook, never over HTTP.) The `output` says what was asserted, on which file, at which sha, for example "Delta-run contract check tests/contract/notifications.test.ts at 3f9a1c2, reading src/index.ts, src/work/wi-2.ts: notifications contract passed ... src/work/wi-2.ts: notifications.default = "opt-in" as accepted". The notifications and status-model checks assert the facets the work item relied on: the Worker derives them from the item's accepted dependencies on the records that name that check (`facetKeys`, or every facet when the dependency is the whole record) and passes them in (the shelter check is the exception: it runs its document rules against the whole policy and uses the list only for the zero-facets guard below). A relied-on facet the code does not declare fails, so does a different value, and a check handed no facets fails closed instead of passing for having nothing to compare. A push that does not encode the accepted values fails under that check's real name (`TEST_FAILED`). The `output` is capped at about 4 KB. Nothing here runs in the container and nothing from the container is taken on its word.

What it is not: it is not the project's test suite. It is a plain-text match that the code declares each governed facet with the accepted value. Because it is only a text match, a commented-out declaration with the right literal also matches, and it cannot tell that code is reachable or used. The convention it relies on: code states a facet as a constant named after the facet key with a literal value (`export const NOTIFICATIONS_DEFAULT = "opt-in";`, `STATUS_VALUES = ["draft", ...]`); the stub agent does, and `AGENTS.md` says so. The stub covers every facet of every record the receipt delivered (its `.delta/receipt.json`), not just what the task title suggests, so a work item that depends on `status.values` gets a `STATUS_VALUES` constant. Coverage: the notifications and status-model checks (Scenario A) and the shelter-intake check (it runs the scenario's document rules on the pushed documents). Sales-ops has no check on purpose: its fixtures record hand-written results and its work products have no fixed file layout, so an assertion would be invented; its `validation:` paths get no evidence and the gate keeps saying `MISSING_EVIDENCE`. A `validation:` path with no registered check behaves the same way.

Beside those, the Worker records the claims check under `delta:claims-vs-receipt` with `kind: "delta-claims-check"`: whether the agent's claims cite the delivered versions and agree with the accepted facets. It is derived from the agent's own claims, so it is informational: the gate and the analysis never count it as a test result, whether it passes or fails, and it cannot replace or overwrite a real result for the same check and head (named invariant test "claims-check evidence never satisfies a validation check", `delta-core/src/claims-check-evidence.test.ts`).

Narration: say "Convergence runs its own contract check on the pushed code". Do not say "the test suite passes"; no test suite was run.

Known gaps: a push is accepted as the revalidation's result if it is the fork's verified head, without requiring that it descends from the head the run started at or landed after `AgentRunStarted`; initial (non-revalidation) pushes get no Worker-recorded evidence, because operator dispatches go outside the cell.

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
- `src/cell/observe.test.ts`, `auth.test.ts`, `meta.test.ts`, `context-change.test.ts`, `src/artifacts/git-merge.test.ts`: units. `meta.test.ts` covers the poller's bookkeeping (per-commit failure counts, reset on success); `git-merge.test.ts` covers the post-fetch head checks.
- Poller and promotion failure paths in `cell.workerd.test.ts`: a baseline commit that fails 5 times is still recorded; a baseline 120 commits ahead loses none; a merge that lands with a lost response is finalized by the poller; an unreadable fork push is delivered fail-closed.

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
| Some way to show "poller degraded" | `meta.poller` on snapshots and live events; `X-Delta-Poller` on `GET /state` |

Deviations the client must adapt to (the console adopted all five in `cloud/stage-b-console`, and was checked live against this cell in Miniflare with the in-memory Artifacts fake):

1. **Work item routes are scenario-scoped**: `/api/scenarios/:s/work-items/:id/{gate,resolutions,promote}`, not `/work-items/:id/...`. A cell exists per scenario and a work item id means nothing without it.
2. **Error bodies** are `{ "error": { "code", "message", ... } }` (the Worker's existing convention), not top-level `{ code, message, reasonCodes }`. Blocked promotes put the reason codes in `error.reasonCodes`.
3. **Auth on the WebSocket**: `new WebSocket(url, ["delta.v1", "bearer." + base64url(secret)])`. The console's client currently opens it with no protocol and no secret.
4. **Not implemented**: `GET .../work-items/:id/changes` (per-file diff patches), `POST .../seed` and `POST .../start` (creating repos, registering work items and dispatching agents). Use `POST .../init` and `POST .../work-items` for setup; seeding and starting belong with the agent runtime.
5. **Resolution and promote bodies** are strict: no `actor`, `ts` or `requestId`. `workItemId` is tolerated if it matches the path.

## What only a live run can prove

The fake cannot show: the binding's real `log`/`readTree`/`readBlob` behaviour and latency; `commitFiles` pushing with an explicit author and committer; the in-Worker `isomorphic-git` clone, fetch, merge and push (`artifacts/git-merge.ts`, whose decision logic is unit-tested on a memory fs); token creation and revocation for the merge; alarm cadence against the real service; and a browser's WebSocket handshake with the subprotocol token.
