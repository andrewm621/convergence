# Convergence Protocol

**Draft v0.1.** Sections 1 to 5 and 7 describe what ships in this repository today. Section 6 is a draft of what comes next and is not implemented.

## 1. Status and scope

The Convergence Protocol is a way for people and agents who work concurrently to share governed decisions. It covers code, and it covers any other work that relies on a decision someone made: a policy, a definition, a requirement. The rules are not specific to source code; the v0.1 wire formats assume git (commit ids, notes, forks).

There is one implementation, the reference implementation: this repository, running on Cloudflare Workers, Durable Objects and Artifacts. Its reconciliation engine is Delta (`packages/delta-core`), a pure function with no I/O. Its wire formats are defined by Zod schemas in `packages/contracts`. Everything in section 3 is taken from that code. Nothing in section 3 is aspirational.

The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

What is normative in v0.1:

- Section 3 (objects and rules R1 to R9) and section 4 (conformance).
- The Zod schemas in `packages/contracts/src`. The JSON Schemas in [`packages/contracts/schema`](../packages/contracts/schema) are generated from them. A JSON Schema cannot express cross-field refinements; where one is missing from a JSON Schema, the Zod schema is authoritative. Each affected file says so in its `description`.

Not normative: section 6 (draft extensions), the REST API in [`control-loop.md`](control-loop.md), and anything in `apps/`.

## 2. Model in one paragraph

Accepted records are versioned. A record holds governed facets (keys with simple values) and free prose; only facets are governed. Work relies on records in two separate ways. A **receipt** says what was delivered when the work started: exact record versions and hashes. **Declared dependencies** say which records, and which facets of them, the work relies on. When an accepted record changes, dependent work is found deterministically by comparing the facets it relied on, in the version its receipt holds, against the new version. Work that relied on a superseded version cannot be promoted until a person resolves it: by revalidating the work against the new version, by granting a scoped exception, or by rejecting the work. Any human may revalidate or reject; only the record's named authority may accept an exception. Models propose, people and deterministic rules decide, and no model sits in the control loop. A record or a dependency that a model wrote is a proposal until a person accepts it. Claims are never accepted: they are compared with the accepted records and labelled unverified.

Terms used below: a **cell** is one workspace's governed state (records, work items, dependencies, ledger). A **baseline** is the repository that holds the accepted records. A **fork** is the repository a work item's actor writes to. An **adapter** is the part of an implementation that turns observations (pushes, check runs, merges) into events and carries out effects.

**Worked example.** The notifications scenario has two work items. WI-2 (notification preferences) relies on `notifications.default` and `notifications.cadence`. WI-1 (status badges) relies only on `status-model`.

1. WI-2's receipt pins `notifications@1` (default `on`, cadence `immediate`). WI-1's receipt pins only `status-model@1`.
2. The decision owner accepts `notifications@2`: default `opt-in`, cadence `weekly-digest`.
3. The engine compares facets against the receipts. WI-2 relied on facets that changed, so it is Stale and promotion is blocked, even though its branch merges into the baseline without a git conflict.
4. WI-1 relies on nothing that changed. It stays Fresh, and the ledger records `NO_ACTION` with the reason.
5. A person revalidates WI-2. It gets a receipt at version 2, the agent reruns, and the gate clears once the checks pass.

## 3. Implemented (normative for v0.1)

### 3.1 Identities and primitives

| Name | Definition |
|---|---|
| `Actor` | `{kind: "human" \| "agent" \| "system", id, displayName}`. Only a `human` may resolve a work item, decide a dependency, or request promotion. |
| `Slug` | `^[a-z0-9][a-z0-9_-]*$`. Used for record ids. |
| `RecordRefString` | `recordId@version`, matching `^[a-z0-9][a-z0-9_-]*@[1-9][0-9]*$`. |
| `FacetKey` | `^[A-Za-z0-9][A-Za-z0-9_.-]*$`, for example `notifications.default`. |
| `FacetValue` | A string, a finite number, a boolean, null, or a flat list of those. Nested objects are rejected. |
| `IsoTimestamp` | ISO-8601 instant with offset. Time is always an input carried on events; the engine never reads a clock. |
| `Sha256` | Lowercase hex SHA-256 (64 characters). |
| `CommitSha` | A full git commit id, 40 or 64 hex characters. |

**Canonical JSON.** Everything that is hashed is first serialized as canonical JSON: object keys sorted, no insignificant whitespace, array order preserved, `undefined` members omitted. Non-finite numbers and non-plain objects (dates, maps, class instances) MUST be rejected. A hash is SHA-256 over the UTF-8 bytes, as lowercase hex. Implementation: `canonical.ts`, `hash.ts`.

### 3.2 Context record

**Purpose.** An accepted decision or definition that work can rely on. This is the unit of authority.

**Representation.** A Markdown file under `context/**.md` in the baseline, beginning with YAML front-matter between `---` lines, followed by prose. Schema: [`context-record-front-matter.json`](../packages/contracts/schema/context-record-front-matter.json).

```markdown
---
id: notifications
version: 2
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T16:00:00Z
supersedes: notifications@1
validation: tests/contract/notifications.test.ts
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
not:
  notifications.default: "on"
---
# Notifications
Users opt in to project status notifications, delivered as a weekly digest.
```

Front-matter fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `Slug`. The record's identity, stable across versions. |
| `version` | yes | Integer, 1 or greater. |
| `status` | yes | `proposed`, `accepted` or `superseded`. |
| `authority` | yes | The actor id allowed to accept changes to this record. |
| `proposed_by` | yes | Actor id of the proposer. |
| `accepted_by`, `accepted_at` | when `status` is `accepted` | Who accepted it and when. |
| `supersedes` | no | `recordId@version` of an earlier version of the same record. |
| `validation` | no | Name of the check that asserts this record against the work (rule R8). |
| `decision` | no | Pointer to a decision log entry. |
| `facets` | yes | Map of `FacetKey` to `FacetValue`. The governed content. |
| `not` | no | Per-facet values the facet must not hold, usually the superseded value. Documentation only: it is not governed and not hashed. Each key MUST name a key of `facets`. |

Parsing MUST fail closed. A file is not a record if it lacks the opening or closing fence, if the YAML is invalid, has duplicate keys or aliases, if any key is unknown, or if any value has the wrong type. YAML is read with the 1.2 core schema, so `on` and `opt-in` stay strings. A file that fails to parse is reported (the `invalid` list of `BaselinePushed`) and is never accepted. Implementation: `record-parser.ts`.

**Identity and versioning.**

- A version is `recordId@version`. Versions increase; a version once accepted is immutable in its facets.
- Prose is not governed. Two files with the same facets have the same `facetHash`, which is the SHA-256 of the canonical JSON of `facets` alone. Neither prose nor `not` enters it.
- `blobHash` identifies the exact file content: a git blob oid (40 or 64 hex) or a SHA-256 of the file text. The engine treats it as opaque.
- `status: proposed` records are visible but govern nothing. `superseded` is parsed, but a record whose status is not `accepted` does not govern, and supersession in practice is a higher accepted version replacing a lower one; the reference reconciler does not act on the `status: superseded` value itself.

**Acceptance.** A record file becomes the accepted head of its record only if all of these hold (rule R1):

1. `status` is `accepted` and `accepted_by` equals the record's authority. The authority is the policy's entry for the record if there is one, otherwise the `authority` of the previous accepted version, otherwise (the first version only) the file's own `authority` field.
2. The version is not lower than the accepted head. A lower version is refused (`VERSION_NOT_NEWER`).
3. The version is not equal to the head with different facets. That is refused (`IMMUTABLE_VERSION`). The same version with identical facets and different prose is accepted as a prose edit, and so is a higher version whose facets are identical; neither makes work stale in `facet` mode.

Anything else produces a `NO_ACTION` effect with a reason code, and the record does not govern.

The engine cannot verify who wrote `accepted_by`. An adapter MUST restrict writes to the accepted baseline to authenticated humans. In the reference implementation the Worker is the only writer: it takes the acting human from the session, remembers the sha of every context change it pushes, and the poller turns a baseline commit into an accepted version only if the cell recorded that sha as a context change by the record's authority (see "Trust boundary" in [`control-loop.md`](control-loop.md)).

**RecordSnapshot** ([schema](../packages/contracts/schema/record-snapshot.json)) is the parsed, hashed form the reconciler sees: `recordId`, `version`, `status`, `authority`, `acceptedBy`, `acceptedAt`, `validation`, `facets`, `not`, `blobHash`, `facetHash`. A cell keeps, per record, `current` (the accepted head version or null), `versions` (every version seen) and `proposed` (the latest proposed version, if any).

### 3.3 Work item

**Purpose.** A task for one actor on its own fork. Schema: [`work-item.json`](../packages/contracts/schema/work-item.json).

Required fields: `id`, `title`, `actor`, `forkRepo`, `source` (`live` or `seeded`), `intent` (`delivery` or `exploratory`), `requires` (a list of `contract-test` and `human-resolution`), `status`. Optional: `participants`.

`status` is derived by the reconciler, never set by a caller: `running`, `fresh`, `stale`, `uncertain`, `conflict`, `revalidating`, `ready`, `promoted`, `rejected`. An item with `source: seeded` is synthetic and MUST be labelled as such wherever it is shown.

Identity: `id` is unique in a cell; registering the same id twice is a duplicate.

### 3.4 Dependency

**Purpose.** What a work item relies on. Schema: [`dependency.json`](../packages/contracts/schema/dependency.json).

Required fields: `workItemId`, `recordId`, `facetKeys` (empty means the whole record), `basis` (`declared`, `verified` or `inferred`), `status` (`proposed`, `accepted` or `rejected`), `evidenceRefs`.

Only `accepted` dependencies gate work. A dependency inferred by rule R4 starts as `proposed` and only a human can move it.

### 3.5 Context receipt

**Purpose.** Proof of what was delivered to a work item and at which hashes. It proves delivery, not understanding. Schema: [`context-receipt.json`](../packages/contracts/schema/context-receipt.json).

Required fields: `baselineCommit`, `contextPacketHash`, `accepted` (a list of `{recordId, version, blobHash, facetHash}`), `proposedVisible` (a list of `{recordId, version, blobHash}`). Optional: `noteRef`, of the form `refs/notes/delta:<commitSha>`.

`contextPacketHash` is the SHA-256 of the canonical JSON of the `accepted` list sorted by `recordId`, then `version`. It does not depend on list order.

**Git note.** The receipt is also written as a git note on a commit of the work item's fork, in the ref `refs/notes/delta`, so it travels with the repository and `git notes --ref=delta show <sha>` reads it. The note text is:

```
delta-receipt/v1
<receipt as canonical JSON, indented by two spaces, keys sorted>
```

followed by a newline. Lists are sorted by `recordId` then `version`. `noteRef` is not written into the note, because it says where the note lives. The same receipt MUST always produce the same bytes. A reader MUST fail closed on a wrong header, invalid JSON or a body that does not match the schema. Implementation: `receipt-note.ts`. The adapter writes the note; the agent does not.

A receipt is replaced only by the revalidation path (rule R6).

### 3.6 Claim

**Purpose.** A structured assertion an agent makes about its output. It is self-reported and MUST be presented as unverified. Schema: [`claims-file.json`](../packages/contracts/schema/claims-file.json).

Representation: `.delta/claims.json` in the work item's fork, a JSON array of `{subject, value, basedOn}`: `subject` is a `FacetKey`, `value` a `FacetValue`, `basedOn` a `RecordRefString`. A missing file, an empty array or a malformed file is treated as no usable claims (rule R3). The reference implementation keeps `.delta/` out of the baseline when it merges.

### 3.7 Evidence and checks

**Purpose.** The result of a check at a specific head of a work item's fork. Schema: [`evidence.json`](../packages/contracts/schema/evidence.json).

Required fields: `workItemId`, `headSha`, `check`, `pass`, `output`. Optional `kind`: `executed-test`, `delta-run-check` or `delta-claims-check`. A `delta-claims-check` is derived from agent-written claims; it is informational and never counts as a test result (rule R8). Evidence with no `kind` counts as a test result.

A **check** is a deterministic function of the pushed file contents and the accepted facets, named by the `validation` field of a record. It decides pass or fail without a model. The reference implementation ships plain text-matching checks for the notifications and shelter-intake scenarios (`scenarios/*/src/check*.ts`); the `ContractCheck` type is in `scenario-kit.ts`.

### 3.8 Policy

Schema: [`policy.json`](../packages/contracts/schema/policy.json). Fields: `version` (stamped on every ledger line), `authority` (a map from record id to the actor id that may accept changes to the record and grant exceptions against it), `staleness` (`facet` or `record`), `requires` (global requirements, unioned with each item's own), `maxRevalidations`.

### 3.9 Conditions and reason codes

A **Condition** is an evaluated state on a work item: `Fresh`, `Stale`, `Uncertain`, `ClaimConflict`, `TestFailed`, `TestsPassed`, `Blocked`, `Ready` or `Promoted`. Each carries `reasonCodes`, the involved `recordRefs` and `facetKeys`, a `message` and `observedAt`. Schema: [`condition.json`](../packages/contracts/schema/condition.json). Conditions are recomputed from facts on every event (level-triggered); a condition that has not changed keeps its original `observedAt`.

`ReasonCode` is a frozen vocabulary (see `conditions.ts`). Every condition and every effect carries reason codes so that a person can be told why something was blocked or left alone. Codes may be added; they MUST NOT be renamed.

### 3.10 Resolution

**Purpose.** A human disposition of a work item. Schema: [`resolution.json`](../packages/contracts/schema/resolution.json).

Required fields: `kind` (`revalidate`, `accept-exception` or `reject`), `workItemId`, `actor`, `rationale` (non-empty), `binding`, `ts`. `scope` is required for `accept-exception` and otherwise optional. `requestId` is optional.

`binding` pins the resolution to exactly what the person was looking at: `{recordId, version, blobHash, baseSha, forkHeadSha, contextSnapshotHash}` (rule R7).

### 3.11 Events and effects

The reconciler takes one `DeltaEvent` ([schema](../packages/contracts/schema/delta-event.json)), discriminated by `type`, and returns a new state and a list of `Effect`s ([schema](../packages/contracts/schema/effect.json)).

| Event | Carries | Dedupe key (rule R9) |
|---|---|---|
| `BaselinePushed` | `repo`, `commitSha`, `snapshotHash`, `records` (changed `RecordSnapshot`s), `invalid` (files that failed to parse) | `repo@commitSha` |
| `ForkPushed` | `repo`, `commitSha`, `workItemId`, `claims` (parsed `.delta/claims.json` or null), `contextPaths` (paths under `context/` the fork changed) | `repo@commitSha` |
| `EvidenceRecorded` | `repo`, `commitSha`, `runId`, `evidence` | `repo@commitSha#evidence:<check>:<runId>` |
| `WorkItemRegistered` | `item`, `receipt`, `dependencies` | `register:<id>` |
| `DependencyDecided` | `requestId`, `workItemId`, `recordId`, `decision` (`accepted` or `rejected`), `actor` | `cmd:<requestId>` |
| `ReceiptIssued` | `workItemId`, `receipt` | `receipt:<id>:<baselineCommit>:<contextPacketHash>` |
| `ResolutionRecorded` | `requestId`, `resolution` | `cmd:<requestId>` |
| `PromotionRequested` | `requestId`, `workItemId`, `actor`, `expectedBaselineCommit`, `forkHeadSha` | `cmd:<requestId>` |
| `PromotionMerged` | `workItemId`, `repo`, `mergeCommitSha` | `promoted:<id>:<mergeCommitSha>` |
| `AgentRunStarted` | `workItemId`, `runId`, optional `model` (display only) | `run:<id>:<runId>:started` |
| `AgentRunFinished` | `workItemId`, `runId`, `outcome` (`success`, `failure`, `cancelled`) | `run:<id>:<runId>:finished` |

Every event also carries `ts`. The three command events (`DependencyDecided`, `ResolutionRecorded`, `PromotionRequested`) are keyed by an idempotency key.

Effects: `REQUEST_REVALIDATION`, `BLOCK_PROMOTION`, `REQUEST_REVIEW`, `DISPATCH_WORK`, `RECORD_CONDITION`, `ALLOW_PROMOTION`, `NO_ACTION`. Every effect carries `reasonCodes`. `ALLOW_PROMOTION` means the gate cleared and the adapter may merge `forkHeadSha` into the baseline. The engine asks; the adapter does.

Purity. `reconcile(state, event, policy)` MUST be a pure function: the same inputs give the same result, it reads no clock, randomness or network, and it does not mutate its inputs. Time and ids arrive on the event. Test: `purity.test.ts`.

### 3.12 Ledger

**Purpose.** An append-only, hash-chained record of every event applied and the effects it produced. Schema: [`reconciliation-event.json`](../packages/contracts/schema/reconciliation-event.json).

A ledger line has `seq` (from 1), `prevHash`, `hash`, `type` (the event type), `payload` (`{event, effects}`), `policyVersion`, `baselineSha` (the baseline commit after the event) and `ts` (the event's `ts`).

- `hash` is the SHA-256 of the canonical JSON of every field of the line except `hash`.
- The first line's `prevHash` is 64 zeros.
- A verifier MUST re-derive every hash and check `seq` continuity and every `prevHash` link, and report the first line that fails. A verifier SHOULD accept an anchor (a known `seq` and `hash`) to verify a tail.
- An implementation SHOULD store the head `(seq, hash)` separately from the lines, so a deleted tail is detectable.
- A refused command (wrong actor, stale binding, a moved baseline) is still applied as an event with a `NO_ACTION` or `BLOCK_PROMOTION` effect, so the refusal is on the ledger. A replayed event and an idempotency conflict are not: they write no line.
- Applying an event MUST commit the new state and the new ledger line atomically.

Implementation: `ledger.ts`, `engine.ts`, `store.ts`.

### 3.13 Cell state

[`cell-state.json`](../packages/contracts/schema/cell-state.json) is the whole state of one cell as plain JSON: `schemaVersion` (1), `baselineCommit`, `snapshotHash`, `records`, `workItems`, `dependencies`, `processed` (the rule R9 dedupe table). `snapshotHash` is supplied by the adapter and is opaque to the engine. [`cell-snapshot.json`](../packages/contracts/schema/cell-snapshot.json) is the read model for a console: the state minus internals, plus the `scenario` name, the policy, the ledger tail and the ledger head.

### 3.14 Live channel: `delta.v1`

A cell's updates can be streamed to a client over a WebSocket. This is part of the reference implementation's API, not of the reconciliation rules; another implementation MAY provide a different transport. The channel schemas are normative only for an implementation that offers `delta.v1`. Each frame is a text message holding a `WsMessage` ([schema](../packages/contracts/schema/ws-message.json)):

- `snapshot`: a `CellSnapshot`, sent first on connect.
- `event`: a `ReconciliationEvent` and the work items it touched, once per ledger line.
- `agent-activity`: one line of live agent output (`workItemId`, `runId`, `kind` of `status`, `tool`, `text` or `error`, `text`, `ts`). Not stored.

The handshake, the extra top-level `meta` key on each frame (strip it before validating), resume with `?since=<seq>` and authentication are described in [`control-loop.md`](control-loop.md).

### 3.15 Rules R1 to R9

These are the rules a conforming implementation MUST apply. Each is checked by named tests in `packages/delta-core/src`. Test pointers are `file` then the `describe` block.

**R1. Staleness is facet-level.** When a new accepted version of a record is observed, every work item that is not promoted and has an accepted dependency on that record MUST be compared against it. The item is Stale when a facet its dependency names (every facet, when `facetKeys` is empty) was added, removed or changed between the version in the item's receipt and the new version. It is also Stale when the receipt never delivered the record (see R4), or when the version the receipt holds is unknown to the cell or ahead of the accepted head (`UNKNOWN_CONTEXT_VERSION`). Prose never causes staleness. With `staleness: record`, any new version or blob hash does. A Stale item gets a `RECORD_CONDITION`, a `REQUEST_REVIEW` and, through the Blocked condition, a `BLOCK_PROMOTION`. Only accepted versions count; the acceptance rule in section 3.2 applies. A prose-only change yields `NO_ACTION` with `PROSE_ONLY`.
Tests: `rules-r1-r2.test.ts` ("R1 staleness is facet-level", "R1 context acceptance (authority and shape)"); invariant "prose-only edit stales nothing".

**R2. Unaffected work is left alone, with the reason recorded.** A work item with no accepted dependency on a changed facet, and no claim citing the changed record, MUST NOT change status, conditions or receipt. The implementation records a `NO_ACTION` effect with `NO_DEPENDENCY_ON_CHANGED_FACETS` for each such item, except on a prose-only change, where a single `NO_ACTION` with `PROSE_ONLY` stands for all items. An item whose claims cite the changed record (or that holds an approval or exception on it) is refreshed instead, and may become a `ClaimConflict` (`SUPERSEDED_BASIS`) or lose its approval.
Tests: `rules-r1-r2.test.ts` ("R2 unaffected work is left alone, with the reason recorded"); invariant "unaffected work never changes status".

**R3. Claim conflict.** When a fork push supplies claims for its head, each claim is compared with the current accepted record it cites.
- A claim whose value differs from the current accepted facet is a conflict (`CLAIM_CONFLICT`).
- A claim citing a superseded version is a conflict if the claimed facet differs between the cited version and the current one (`SUPERSEDED_BASIS`), even when the claimed value happens to equal the current one. If the facet did not change, it is not a conflict.
- A claim on a subject the cited record does not carry, but another accepted record governs, is a conflict if the value differs and Uncertain if it agrees (`WRONG_RECORD`). It is never a pass.
- A claim on a subject no accepted record governs is not contradicted.
- Missing, empty or malformed claims, or claims for a different head, MUST be treated as unknown and fail closed to Uncertain (`NO_CLAIMS`, `MALFORMED_CLAIMS`). A claim citing a version the cell has never seen is Uncertain (`UNKNOWN_CONTEXT_VERSION`).
Tests: `rules-r3-r4.test.ts` ("R3 claim conflict"); `freeze-fixes.test.ts` ("S4 a claim is checked against the record that governs its subject").

**R3b. Cross-claim conflict.** Two live work items (neither promoted nor rejected) that claim different values for the same subject, where no accepted facet governs that subject, MUST both be Uncertain (`CROSS_CLAIM_CONFLICT`) with a `REQUEST_REVIEW`. The condition clears when either side stops disagreeing.
Tests: `rules-r3-r4.test.ts` ("R3b cross-claim conflict (P1)"); `freeze-fixes.test.ts` ("S5 R3b ignores rejected items").

**R4. Undeclared reliance.** A claim that cites a record that is not in the item's receipt, and for which the item has no accepted dependency, MUST create (or extend) a dependency with `basis: inferred` and `status: proposed`, and make the item Uncertain (`UNDECLARED_DEP`). A proposed dependency does not gate. Only a human can decide it (`DependencyDecided`); a decision from an agent or a system actor is refused (`FORBIDDEN_ACTOR`). An accepted dependency on a record the receipt never delivered makes the item Stale. A rejected one clears the uncertainty.
Tests: `rules-r3-r4.test.ts` ("R4 undeclared reliance", "R3b and R4 on the sales-ops fixture").

**R5. Promotion gate.** A work item is promotable only if none of the following holds, and anything unknown blocks:
- it is rejected, or a revalidation is in progress, or nothing has been pushed;
- it is Stale or has a claim conflict that no valid exception covers;
- it is Uncertain for any reason;
- its fork changed anything under `context/` (`FORK_EDITS_CONTEXT`); agents propose context changes on the baseline and never carry them in through a merge;
- a check is failing at the current head (`TEST_FAILED`), other than the validation check of an excepted record;
- `contract-test` is required (by the policy or by the item) and some accepted dependency's `validation` check has no passing evidence at the current head (`MISSING_EVIDENCE`), or there is no evidence at all;
- `human-resolution` is required and no valid exception or recorded human revalidation exists (`HUMAN_RESOLUTION_MISSING`).
An `accept-exception` waives the staleness and conflict findings of the record it names, and that record's own validation check, and nothing else. It never waives unknowns, `FORK_EDITS_CONTEXT`, or another record's checks. The gate is a dry run: evaluating it changes nothing.
Tests: `rules-r5-r9.test.ts` ("R5 promotion gate"); `freeze-fixes.test.ts` ("S1 an exception waives only the excepted record's own checks", "S3 a fork cannot smuggle context/** through a merge").

**R6. Revalidation.** A `revalidate` resolution is accepted only for an item that is Stale or in conflict, only from a human, only one at a time, and at most `maxRevalidations` times. When accepted, the engine emits `REQUEST_REVALIDATION` and `DISPATCH_WORK` carrying the facet diff, and the item is `revalidating`. After the limit, the answer is `REQUEST_REVIEW` and `BLOCK_PROMOTION` (`REVALIDATION_LIMIT`), not another run. The adapter then issues a new receipt at the current versions (`ReceiptIssued`). The engine MUST take a new receipt only while a revalidation is in progress; with none in progress it is refused (`REVALIDATION_NOT_REQUESTED`). During a revalidation it is taken only if each entry matches the current accepted version, `blobHash` and `facetHash` and every accepted dependency is covered; otherwise it is refused (`RECEIPT_MISMATCH`). The receipt does not hide old claims and does not by itself make the item promotable: the revalidation ends at the agent's next push, or when the run tied to it fails or is cancelled.
Tests: `rules-r5-r9.test.ts` ("R6 revalidation"); `revalidation-freshness.test.ts` ("R6: one revalidation at a time"); `freeze-fixes.test.ts` ("S7 and N7 revalidation preconditions").

**R7. Approval binding.** A resolution MUST be refused (`STALE_BINDING`) unless its binding equals the cell's current state: `baseSha` is the baseline commit, `contextSnapshotHash` is the current snapshot hash, `forkHeadSha` is the fork's current head (and the fork has pushed), and `recordId`, `version` and `blobHash` are the record's current accepted head. Only a human may resolve. An `accept-exception` additionally requires the actor to be the record's authority, and there must be something stale or conflicting on that record to except. An exception lapses (`EXCEPTION_LAPSED`) when its record gets a new accepted version, when the fork head moves, or when its actor stops being the record's authority; a prose-only edit that keeps the version does not lapse it. Promotion is a compare-and-swap on `expectedBaselineCommit` and `forkHeadSha` (`BASELINE_MOVED`, `HEAD_MOVED`), re-runs the gate at the current heads, and is two-phase: the engine emits `ALLOW_PROMOTION`, the adapter merges, and `PromotionMerged` re-runs the gate and is recorded as a promotion only if it still passes and an approval exists (`PROMOTION_NOT_APPROVED`).
Tests: `rules-r5-r9.test.ts` ("R7 approval binding and promotion"); `revalidation-freshness.test.ts` ("R7: freshness at promote follows the receipt"); `freeze-fixes.test.ts` ("S2 approval cannot survive a context change", "S6 authority comes from policy or the previous accepted version"); invariant "agent actor cannot resolve".

**R8. Evidence is produced by the implementation, not the agent, and counts only at the current head.** Evidence counts only if it is for the work item's fork, names the item's current head, and is the latest result for its check. A new push invalidates earlier evidence. Failing evidence blocks the item whether or not `contract-test` is required. Evidence of kind `delta-claims-check` MUST NOT satisfy, fail or overwrite a validation check. The engine cannot verify who produced evidence, so the adapter MUST run checks itself on the pushed content and MUST NOT accept evidence from the agent. In the reference implementation only the Worker's internal observation hook writes evidence.
Tests: `rules-r5-r9.test.ts` ("R8 evidence only counts at the current head"); `claims-check-evidence.test.ts`.

**R9. Idempotency.** Events are deduplicated on the keys in section 3.11. Processing a duplicate MUST return `NO_ACTION` with `DUPLICATE_EVENT`, leave state and ledger unchanged, and write no ledger line. For events other than commands this holds whatever the timestamp. A command (`DependencyDecided`, `ResolutionRecorded`, `PromotionRequested`) is a duplicate only if the whole event, including `ts`, is identical in canonical JSON. A command whose idempotency key was already used with any other content is a conflict (`IDEMPOTENCY_CONFLICT`) and writes nothing. A work item cannot be registered twice.
Tests: `rules-r5-r9.test.ts` ("R9 idempotency"); invariant "replayed event yields one ledger entry".

The five **named invariants** run against four scenario fixtures and every test store: unaffected work never changes status; prose-only edit stales nothing; replayed event yields one ledger entry; agent actor cannot resolve; chain breaks on any edit (`invariants.test.ts`, `testing/invariants.ts`). The hash chain itself is tested in `ledger.test.ts`.

## 4. Conformance

A conforming implementation applies the rules in section 3.15, accepts and emits the objects in sections 3.1 to 3.13 with the formats given there, and produces the same state and effects as the reference engine for the same inputs. "The same" means the same statuses, condition types, effect types and reason codes; the `message` text is informative. Effects are compared as a set of (effect type, work item, reason code) entries. The order of effects, how reason codes are grouped into effects, and duplicate identical effects are not normative. For example, the reference engine emits two `BLOCK_PROMOTION` effects for a rejected work item, one for the Blocked condition and one for the rejection; an implementation that emits a single `BLOCK_PROMOTION` carrying both reason codes produces the same set and conforms.

The conformance kit in [`conformance/`](../conformance/README.md) checks an implementation from the outside, in any language. It holds JSON test vectors generated from the reference engine over the scenario fixtures. Each vector gives a cell state, a policy and one event, and the expected result projected to the fields above: statuses, condition types, effect types and reason codes, plus the ids, versions and hashes that the inputs fix. The expected effects are stored as the effect set described above. Every rule R1 to R9, and R3b, has positive and negative vectors, and the worked example of section 2 is a named sequence. The runner takes the implementation as a shell command, writes `{given, when}` to its stdin, reads `{state, effects}` from its stdout and compares the projections. Passing means the same normative result on these vectors. It does not certify an adapter's git or Artifacts handling, its security or its authorization, which one reconcile step cannot show.

The rest of the conformance suite is the test suite of this repository, and it runs against this implementation only. What exists:

| Part | Files | Checks |
|---|---|---|
| Conformance kit | `conformance/` (vectors, `run.ts`, `adapters/reference.ts`) | Rules R1 to R9 against any implementation over stdin and stdout; the reference passes every vector, and deliberately broken engines fail the vectors for the rule they break |
| Rules R1 to R9 | `packages/delta-core/src/rules-r1-r2.test.ts`, `rules-r3-r4.test.ts`, `rules-r5-r9.test.ts`, `revalidation-freshness.test.ts`, `claims-check-evidence.test.ts`, `freeze-fixes.test.ts` | Each rule, with positive and negative cases, on the notifications and sales-ops fixtures |
| Named invariants | `invariants.test.ts` with `testing/invariants.ts` | Five invariants on each of four fixtures (notifications, sales-ops, shelter-intake, delta-convergence-build) and each test store |
| Ledger | `ledger.test.ts` | Hash chain, tamper detection, anchors |
| Store | `store.test.ts` with `testing/store-conformance.ts` | Any `CellStore` that passes is a valid store: atomic commit, ledger paging, no aliasing |
| Purity | `purity.test.ts` | `delta-core` imports no clock, randomness, timers, network, Node I/O, Cloudflare types or model SDK |
| Domains | `scenarios.test.ts`, `shelter-intake.test.ts`, `fanout.test.ts`, `dogfood-build.test.ts` | End-to-end stories on the notifications, sales-ops and shelter-intake fixtures, the seeded fan-out, and a replay of this repository's own decisions |
| Wire formats | `packages/contracts/src/schemas.test.ts`, `record-parser.test.ts`, `receipt-note.test.ts`, `freeze-fixes.test.ts` | Strict parsing, record front-matter, receipt note bytes, canonical JSON, hashing |
| JSON Schemas | `packages/contracts/src/json-schema.test.ts` | The committed schemas match the Zod contracts |

Run it:

```bash
pnpm install
pnpm --filter delta-core test      # rules, invariants, ledger, stores, purity, scenarios
pnpm --filter contracts test       # wire formats and JSON Schemas
pnpm -r test                       # everything, including the Worker adapter and the conformance kit
pnpm conformance                   # the conformance vectors against the reference engine
node conformance/run.ts --impl "<command>"   # ... or against another implementation
```

After changing a contract, regenerate the JSON Schemas with `pnpm --filter contracts schema`. The test fails until the committed files match.

The Worker's own tests (`apps/worker`) cover the adapter: git observation, receipt notes, merging, idempotency headers, the poller. They test this implementation, not the protocol.

## 5. Domains

The same objects carry different content in different domains. The scenarios in `scenarios/` are fixtures, not products; the second and third are synthetic.

| Object | Code (`notifications`) | Shelter intake (`shelter-intake`, synthetic) | Sales ops (`sales-ops`, synthetic) |
|---|---|---|---|
| Work product | Code in a fork | Volunteer documents (a script, signage text, a one-pager, a supply list, a schedule) | Reports and priorities for a sales team |
| Record | `notifications`, `status-model` | `shelter-intake-policy`, `volunteer-roles` | `qualified-lead`, `sales-activity` |
| Authority | `decision-owner` | `shelter-coordinator` | `decision-owner` |
| Facets (example) | `notifications.default`, `notifications.cadence`, `notifications.channel` | `pets`, `id_required`, `capacity_note`, `hours` | `lead.qualified.criteria`, `lead.qualified.min-employees` |
| The change | v2: default `on` becomes `opt-in`, cadence `immediate` becomes `weekly-digest` | v2: `pets` and `id_required` change; v3 later changes `capacity_note` | v2: criteria gain a verified budget signal |
| Prose-only edit | Typo fix in v1 | Typo fix in the welcome text | Reworded sentence in v1 |
| Work item (example) | WI-2 "Notification preferences and delivery" | WI-1 "Front-desk intake script" | WI-4 "SDR weekly priorities" |
| Claim (example) | `notifications.default = "on"`, basedOn `notifications@1` | `pets = "service animals only"`, basedOn `shelter-intake-policy@1` | `lead.qualified.criteria = "form-fill-and-50-plus-employees"`, basedOn `qualified-lead@1` |
| `validation` check | `tests/contract/notifications.test.ts`: text match of facet declarations in `src/` | `checks/shelter-intake.check`: text assertions on the documents (the pet area is mentioned, no "service animals only" remains) | `checks/qualified-lead-criteria.check` is named in the record; the fixture's evidence is recorded by hand and no check is registered |
| Revalidated | WI-2 | WI-1, WI-3 | WI-4 |
| Scoped exception | not used | WI-2 door signage, scope `signs/door.md`, lapses when v3 lands | WI-3 forecast, scope `reports/q4-forecast.md` |
| Left alone (R2) | WI-1 (depends only on `status-model`) | WI-4 supply list, WI-5 schedule | WI-5 activity glossary |

A fourth fixture, `delta-convergence-build`, replays this repository's own decisions through the same objects; it is reconstructed from history and records no automated evidence.

Nothing in the engine knows which domain it is in. A facet is a key and a value; a check is a function from files and facets to pass or fail.

## 6. Draft extensions

Nothing in this section is implemented. Terms introduced here are proposals and may change.

### 6.1 Scoped acceptance (Draft, not implemented)

Today a record's `status: accepted` is a property of the file, and "who may accept" is one entry in a cell's policy, so the cell is the implicit scope. In the draft there is no global "accepted". Acceptance is a statement made by an authority within a named scope: this version of this record is accepted for this scope. Importing a record from another scope brings its content and its history but not its authority; in the importing scope it is proposed until that scope's authority accepts it. This would replace today's rule that a record's first version is trusted to name its own authority.

### 6.2 Coordination levels (Draft, not implemented)

A record or a scope MAY declare how strongly the protocol acts on a change:

- `observe`: record conditions and ledger lines only.
- `advise`: also request review and revalidation, but never block.
- `verify`: also run checks and report the gate verdict, but do not refuse a merge.
- `enforce`: the gate is binding and the adapter refuses a merge without `ALLOW_PROMOTION`.

Today's implementation is `enforce` for gated facets: a dependency on a facet gates promotion, and the adapter merges only on `ALLOW_PROMOTION`. There is no way to choose a lower level.

### 6.3 Basis and evidence states (Draft, not implemented)

A record MAY name its grounds, the reason behind it, as a chain such as goal, requirement, decision. (The existing `Dependency.basis` field describes how a dependency was established and is unrelated.) Each link states how the implementation knows it, using an evidence state:

- `observed`: seen directly by a check or a person.
- `reported`: stated by someone who is not verified. Today's claims are reported.
- `inferred`: derived by a rule or a model. R4's `basis: inferred` dependencies would be in this state.
- `disputed`: two sources disagree and no authority has settled it.
- `unknown`: nobody has said.

An unknown reason MUST stay unknown; an implementation MUST NOT fill it in by inference and present it as known. If work relies on a requirement rather than on the decision that currently satisfies it, a deterministic check of the requirement could let a decision change without blocking work that still meets its purpose. Without such a check, the current behavior (block on any relied-on facet change) remains the rule.

### 6.4 Governance adapters (Draft, not implemented)

Who may accept a record would be pluggable. Today it is a named owner: one actor id per record. Later adapters could implement delegation, quorum or a vote. An adapter turns its inputs into an acceptance statement under a named rule, and the engine sees only that statement. A vote is an input to acceptance, not truth: the ledger would record the inputs and the rule that produced the decision.

### 6.5 Interoperability (Draft, not implemented)

A goal is for records, dependencies, receipts and the ledger to be exportable to open provenance formats such as W3C PROV, so that a decision's history can be read by tools that know nothing about this protocol. No mapping has been defined or checked.

Records are Markdown files with YAML front-matter, the same shape as the Open Knowledge Format (OKF) v0.2, an Apache-2.0 format published by Google Cloud (https://github.com/GoogleCloudPlatform/open-knowledge-format). OKF requires a `type` field, which records do not yet carry, so records are not yet valid OKF documents. OKF covers provenance and advisory trust; the protocol adds acceptance, authority, dependencies and gating. A compatibility profile (an optional `type` plus OKF's optional keys) and an exporter (status mapped as proposed→draft, accepted→stable, superseded→deprecated) are planned. Neither is implemented.

## 7. Versioning and open questions

### 7.1 Versioning of the protocol

This document is **v0.1**. Wire identifiers carry their own versions: the receipt note header `delta-receipt/v1`, the WebSocket subprotocol `delta.v1`, and `CellState.schemaVersion` 1. They change only for a breaking change. The identifiers `delta-receipt/v1`, `delta.v1`, `refs/notes/delta`, `.delta/` and `DeltaEvent` are named after the reference engine (Delta) and are kept for compatibility.

Breaking changes (they MUST change a version identifier and be listed with the release):
- removing or renaming an object, a field, an event type, an effect type or a reason code;
- changing a field's type, or making an optional field required;
- changing what a rule requires, or what a reason code means;
- changing canonical JSON or any hash input, including the receipt note format and the ledger line hash.

Not breaking: adding a reason code, an optional field, a new event or effect type that existing rules ignore, or a new check. Because every object schema is strict, a consumer built on an older schema will reject an object that carries a newer field; additions therefore still need a release note, and the JSON Schemas are the release artifact. Before v1.0 no stability beyond this is promised.

### 7.2 Open questions

- **Relation vocabulary.** The only relations today are a work item relying on a record (`Dependency`), a version superseding a version (`supersedes`), and a claim based on a version (`basedOn`). Whether to add more (satisfies, contradicts, derived from) and what each would mean for staleness is undecided.
- **Decision or Commitment as the primary object.** The governed unit today is the facet of a record. Whether the primary object should be a decision (what was chosen), a commitment (who is bound to what) or both, and where authority and approval live, is undecided.
- **Nested facet values.** Facets are scalars or flat lists so that equality is unambiguous. Whether structured values are worth the comparison rules is open.
- **Proposed context in receipts.** `proposedVisible` exists in the receipt but nothing fills it today.
- **Verified dependencies.** `basis: verified` exists on `Dependency` but nothing produces it today.
