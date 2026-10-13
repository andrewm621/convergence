# delta-core design notes

Where the PRD (v1.2, section 4) left a choice open, this is what was chosen and why. Each item is
the most PRD-consistent reading; the PRD wins if it disagrees. Nothing here calls a model.

## Shape

- `reconcile(state, event, policy)` is synchronous and pure. Anything that needs WebCrypto
  (blob, facet, snapshot and receipt hashes, the ledger hash) is computed by the adapter and
  arrives on the event, or happens in the async `processEvent` wrapper. `contracts` owns the hash
  helpers (`sha256Hex`, `toRecordSnapshot`, `hashContextPacket`, `hashContextSnapshot`).
- Conditions are level-triggered: after any event that can affect an item, its conditions are
  recomputed from facts (receipt, accepted records, dependencies, claims, evidence, resolutions).
  Items an event cannot affect are not recomputed and stay byte-identical. That is how
  "unaffected work never changes status" is enforced rather than hoped for.
- `processEvent` does one atomic `store.commit({ state, entry })` per event. Duplicates and
  Idempotency-Key conflicts write nothing.

## Choices on ambiguous points

1. **Events beyond push events.** `DeltaEvent` also carries the commands and observations the
   rules need: `WorkItemRegistered`, `EvidenceRecorded`, `DependencyDecided`, `ReceiptIssued`,
   `ResolutionRecorded`, `PromotionRequested`, `PromotionMerged`, `AgentRunStarted/Finished`.
   The ledger `type` is the DeltaEvent type, so refusals (`FORBIDDEN_ACTOR`, `STALE_BINDING`) are
   ledgered too. `ResolutionRecorded` is the event name even when the resolution is refused.
2. **Dedupe key.** Push events use `(repo, commitSha)` exactly. Evidence at a head shares that
   pair with the push, so it is keyed `repo@sha#evidence:check:runId` (`runId` required, so a
   re-run at promote is not dropped). A merge is keyed `promoted:<item>:<mergeCommitSha>`, so a merge refused for want of approval cannot block the approved one. Commands are keyed by `requestId` (the Idempotency-Key); a
   reused key with a different body is `IDEMPOTENCY_CONFLICT` and writes nothing.
3. **Promotion is two-phase.** `PromotionRequested` runs the gate and, if it passes, emits
   `ALLOW_PROMOTION` (an Effect added to the PRD's list). The adapter merges, then sends
   `PromotionMerged`, which is only accepted while the approval is still live **and** the gate
   passes again at merge time (policy, claims, evidence and context are all re-read). Any event
   that can change the verdict clears the approval: a fork push, and a context change that makes
   the item stale, touches a record its claims cite, or arrives while it holds an approval. So a
   context push between approve and merge cannot slip through, even for work that does not depend
   on the changed facet.
4. **Superseded-basis claims (R3).** "A claim based on a superseded version is a conflict" is
   applied facet-level: it conflicts only if the claimed subject differs between the cited
   version and the current one. A claim citing v1 of a facet that did not change is not a
   conflict, otherwise a prose-only version bump would indirectly stale everything. Reason code
   `SUPERSEDED_BASIS` accompanies `CLAIM_CONFLICT`. A claim is also checked against the record that
   actually governs its subject: citing a record that does not carry the subject is a conflict
   with the governing record when the value differs (`WRONG_RECORD`), and Uncertain when it
   merely agrees. Citing the wrong record never passes.
5. **Prose-only edits.** Same version with a new blob and identical facets, or a new version with
   identical facets, are both `NO_ACTION/PROSE_ONLY`. The stored blob hash is updated. In
   `staleness: "record"` mode neither is prose-only. Changing facets inside an accepted version
   is refused (`IMMUTABLE_VERSION`).
6. **`facetKeys: []` means the whole record.** Any facet change, including an added one, stales it.
7. **Authority on context acceptance.** A record file's own `authority` and `accepted_by` fields
   are agent-writable text, so they are not evidence of authority. A file becomes an accepted
   version only if `accepted_by` equals the sitting authority: `policy.authority[recordId]`, else
   the `authority` of the previous accepted version. The file's own field is trusted for a record's
   first version only. A sitting authority may hand authority over by accepting a version that
   names the next one. Otherwise the record is kept `proposed` with `FORBIDDEN_ACTOR`, and only
   when the version is newer than the current one. Proposed records never govern. Residual
   trust: `accepted_by` is still self-declared text, so the Worker must be the only writer to
   the baseline (single writer per repo, already required for stale-ref reasons) and must reject
   baseline commits whose author is not the authority.
8. **`not` in front-matter** is parsed and kept but is documentation of rejected alternatives. It
   is not part of the facet hash, not diffed and not used by the rules.
9. **R3b** (implemented, not a todo) applies only to subjects no accepted facet governs. When a
   facet governs the subject, R3 already arbitrates against the accepted value, and two items
   disagreeing is a symptom of that. Without this, a grandfathered item and a revalidated item
   would block each other in Scenario B.
10. **R4.** The inferred dependency is created at fork-push time. A rejected dependency makes the
    claim ignored. An accepted one gates, and since the receipt never delivered that record the
    item is `Stale/STALE_RECEIPT` until revalidated.
11. **Exceptions (R5/R7).** An `accept-exception` waives staleness and conflicts on the excepted
    record(s), and **only the excepted records' own validation checks**: those checks may fail
    or be absent. Every other record's check still has to pass at the head, any other failing
    check still blocks, and unknowns (`NO_CLAIMS`, `MALFORMED_CLAIMS`, undeclared dependencies,
    `WRONG_RECORD`, cross-claim conflict) and `FORK_EDITS_CONTEXT` are never waived. It lapses when
    the record gets a new accepted version, when the fork head moves, or when the actor stops
    being the record's authority (checked against the current policy). A prose edit that keeps
    the version does not lapse it. An exception needs something stale or conflicting on its
    record (`ALREADY_RESOLVED` otherwise).
12. **Requirements.** `contract-test`: the `validation` check of every record the item
    accepted-depends on must have passing evidence at the head (at least one passing check if
    none declare one), and nothing may fail. `human-resolution`: a valid exception or a recorded
    `revalidate` by a human, and the last resolution is not a `reject`. `intent` (delivery vs
    exploratory) does not change any rule.
13. **Binding checks (R7).** A resolution must match the current baseline commit, snapshot hash,
    fork head and the record's current version and blob. Reject and revalidate are bound too.
    Stale binding is `STALE_BINDING`: the console reloads and decides again. The snapshot hash is
    supplied by the adapter on each `BaselinePushed`; the core compares it, it does not compute it.
14. **Revalidate** marks the item `revalidating` and emits `REQUEST_REVALIDATION` and
    `DISPATCH_WORK` with the facet diff. The new receipt comes back as `ReceiptIssued` (hashed by
    the adapter with `buildReceipt`), is validated against current versions, and clears Stale. A receipt is only taken while the
    item is `revalidating` (`REVALIDATION_NOT_REQUESTED` otherwise), and a revalidation is only
    taken for an item that is stale or conflicting (`NOTHING_TO_REVALIDATE`).
    The item stays `revalidating` (gate blocked) until the agent's next push. After
    `maxRevalidations` the answer is `REQUEST_REVIEW`, with no re-dispatch.
15. **Receipt note.** `noteRef` is `refs/notes/delta:<commitSha>`. It is a pointer and is left out
    of the serialized note body. The body is `delta-receipt/v1` then sorted-key JSON.
16. **Status chips.** `WorkItemStatus` adds `uncertain` and `rejected` to the PRD's list, and the
    precedence is promoted > revalidating > rejected > ready > conflict > stale > uncertain > fresh >
    running. `ready` outranks `conflict` because Ready already accounts for a waiving exception.

17. **Forks that edit `context/**` are blocked (`FORK_EDITS_CONTEXT`).** The adapter fills
    `ForkPushed.contextPaths` from the tree diff of the fork against its base; the core stores it
    on `WorkItemState.contextPaths` (replaced on every push) and the gate fails while it is
    non-empty. No exception waives it. Agents propose context changes on the baseline through a
    human; they never carry them in through a merge. The push is also ledgered as
    `FORK_CONTEXT_IGNORED`: the fork's copy is never read as an accepted version.
18. **R3b ignores rejected work**, and a reject (or revalidate) re-evaluates the counterparts that
    share a claimed subject, so a dead item cannot keep a live one Uncertain.
19. **Hashes and comparators.** `CommitSha` and `NoteRef` accept only full 40 or 64 hex characters.
    `canonicalJson` throws on anything that is not a plain object, array or scalar (a `Date` or
    `Map` would otherwise hash as `{}`). Sorts use a three-way comparator.

## Trust boundary: agent-writable inputs

What an agent can write, and why none of it grants authority or bypasses the gate:
- **Claims** (`.delta/claims.json`): compared to accepted facets; a claim cannot lower a bar. A
  claim on a subject nothing governs is not contradicted, which is why R8 evidence exists.
- **Context files in a fork:** never read as accepted (`FORK_CONTEXT_IGNORED`) and block promotion.
- **Context file front-matter on the baseline:** `accepted_by`/`authority` are checked against the
  sitting authority (choice 7), not trusted.
- **Inferred dependencies:** created `proposed`; only a human can make one gate.
- **Actor fields on commands** (`Resolution.actor`, `PromotionRequested.actor`): the core checks
  `kind` and `id`, but they arrive in the event body, so the Worker must set them from the
  authenticated session and never from a request body.

## PRD changes (applied to docs/PRD.md in the fix round)

- R9: evidence is keyed with a run id; commands dedupe by Idempotency-Key.
- R3: superseded-version claims conflict at facet level; a claim on the wrong record is a conflict.
- R5: what an accept-exception waives (choice 11).
- Effects: `ALLOW_PROMOTION`, with the merge re-checking the gate.
- R3b scope; section 7 chips `uncertain` and `rejected`; the `FORK_EDITS_CONTEXT` rule.

## For M2 (Durable Object store)

Implement `CellStore` and run `describeStoreConformance` and `describeInvariants` against it
(`src/testing/store-conformance.ts`, `src/testing/invariants.ts`; `SerializingStore` is the
JSON-row stand-in that already passes). `processEvent` must be called serially per cell; the store's
head check is the second line of defence. **Persist the ledger head (seq and hash) as its own
row, written in the same transaction as the line; never derive it from the last ledger row.**
Otherwise truncating the tail looks like a valid shorter chain. Verify against the stored head on load.
