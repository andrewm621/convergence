# Calm Work Inbox v0.3.1: read-only implementation

Status: isolated feature branch. PR 0 establishes a validation baseline; PR 1 adds an opt-in, read-only React product surface.

## Safety contract

- The default console remains the current `?ui=new` application. `?ui=classic` also remains unchanged.
- `?ui=calm` activates a **read-only projection** of the same accepted `CellSnapshot`, live events, and mock events. It never invokes Worker mutations.
- `packages/contracts`, `packages/delta-core`, `conformance`, and the Worker remain unchanged.
- Work classifications mirror v0.1 status and degraded-poller behavior. The calm screen is **not** a second governance gate.
- Human assignee data, multi-user sessions, approval permissions, task-specific suggestion writes, candidate-review sidecars, and trusted initial delivery are **not** implemented in PR 1. The interface must not invent them.
- For old initial receipts, the interface says **recorded context**, not verified agent delivery. A registered work item does not itself prove a runtime handoff.
- The public view remains read-only. All calm paths are read-only even with the development bearer token.
- No real actions are performed by the calm UI. Use the existing console for available authorized actions; any demo controls are visibly synthetic.

## Test plan

1. Baseline: `pnpm -r typecheck`, `pnpm -r test`, `pnpm conformance`, `pnpm build:console`.
2. Verify `readUi` does not change its default; classic and new remain available.
3. Verify the calm view consumes the existing mock or live stream with no sidecar data.
4. Verify stale/revalidating/ready/unknown and degraded-poller descriptions are honest.
5. Verify decisions and work technical details are read from actual v0.1 records, receipts and ledger.
6. Test keyboard navigation, inspector close, and mobile layout without horizontal overflow.

## Scope limits

For this first slice the inbox shows **Needs team review**, not **Needs your input**. The existing credential represents one demo person, and the protocol's record authority is not the same as a review assignment. Until a real identity/assignment service exists, personalized ownership is unknowable. The first implementation uses a calm non-personalized work queue and exposes run actor when known.

A **review preview** is not a human review decision. R4 `DependencyDecided` stays exclusively in the existing v0.1 action path. No inferred dependency is accepted or rejected from the calm read-only view.

## Validation environment

This repository's documented baseline expects Node >=26 and pnpm 10.32.1. The CI workflow runs those exact tools on PRs, without secrets, remote Artifacts, production credentials, migrations or deploy steps.

