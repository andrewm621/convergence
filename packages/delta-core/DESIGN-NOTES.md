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
   re-run at promote is not dropped). Commands are keyed by `requestId` (the Idempotency-Key); a
   reused key with a different body is `IDEMPOTENCY_CONFLICT` and writes nothing.
3. **Promotion is two-phase.** `PromotionRequested` runs the gate and, if it passes, emits
   `ALLOW_PROMOTION` (an Effect added to the PRD's list). The adapter merges, then sends
   `PromotionMerged`, which is only accepted while the approval is still live. Any later event
   that makes the gate fail clears the approval, so a context push between approve and merge
   cannot slip through.
4. **Superseded-basis claims (R3).** "A claim based on a superseded version is a conflict" is
   applied facet-level: it conflicts only if the claimed subject differs between the cited
   version and the current one. A claim citing v1 of a facet that did not change is not a
   conflict, otherwise a prose-only version bump would indirectly stale everything. Reason code
   `SUPERSEDED_BASIS` accompanies `CLAIM_CONFLICT`.
5. **Prose-only edits.** Same version with a new blob and identical facets, or a new version with
   identical facets, are both `NO_ACTION/PROSE_ONLY`. The stored blob hash is updated. In
   `staleness: "record"` mode neither is prose-only. Changing facets inside an accepted version
   is refused (`IMMUTABLE_VERSION`).
6. **`facetKeys: []` means the whole record.** Any facet change, including an added one, stales it.
7. **Authority on context acceptance.** A record file only becomes an accepted version if its
   `accepted_by` equals `policy.authority[recordId]` (else the record's own `authority`).
   Otherwise it is kept as `proposed` with `FORBIDDEN_ACTOR`. Proposed records never govern.
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
    record(s), and with them the test requirement, because the contract test asserts against the
    new decision and would fail legitimately for grandfathered work. It never waives unknowns
    (`NO_CLAIMS`, `MALFORMED_CLAIMS`, undeclared dependencies, cross-claim conflict). It lapses when the record
    gets a new accepted version, when the fork head moves, or when the actor stops being the
    record's authority (checked against the current policy). A prose edit that keeps the version
    does not lapse it.
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
    the adapter with `buildReceipt`), is validated against current versions, and clears Stale.
    The item stays `revalidating` (gate blocked) until the agent's next push. After
    `maxRevalidations` the answer is `REQUEST_REVIEW`, with no re-dispatch.
15. **Receipt note.** `noteRef` is `refs/notes/delta:<commitSha>`. It is a pointer and is left out
    of the serialized note body. The body is `delta-receipt/v1` then sorted-key JSON.
16. **Status chips.** `WorkItemStatus` adds `uncertain` and `rejected` to the PRD's list, and the
    precedence is promoted > revalidating > rejected > ready > conflict > stale > uncertain > fresh >
    running. `ready` outranks `conflict` because Ready already accounts for a waiving exception.

## PRD changes recommended

- Section 4, R9: say that evidence is keyed with a run id, and that commands dedupe by
  Idempotency-Key. `(repo, commitSha)` alone would drop the re-run at promote.
- Section 4, R3: state that a superseded-version claim conflicts at facet level (choice 4).
- Section 4, R5: say that an accept-exception waives staleness, conflicts and the test requirement
  for the excepted record, but never unknowns (choice 11).
- Section 4, Effect list: add `ALLOW_PROMOTION`.
- Section 4, `WorkItem.status` / chips: add `uncertain` and `rejected`.

## For M2 (Durable Object store)

Implement `CellStore` and run `describeStoreConformance` and `describeInvariants` against it
(`src/testing/store-conformance.ts`, `src/testing/invariants.ts`; `SerializingStore` is the
JSON-row stand-in that already passes). `processEvent` must be called serially per cell; the store's
head check is the second line of defence.
