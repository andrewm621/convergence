# Run the experiment with genuinely independent agents

The seeded test workers are not models. This runbook describes how to replace them with separately scoped sessions, using Delta.dev as the work substrate or another agent runtime that provides enforceable tool permissions.

## 0. Guardrails

- Do not connect this experiment to production or customer data.
- Use the actual Convergence repository, or a disposable clone, as the source project.
- Keep the experiment's context and decisions separate from the production accepted baseline.
- The agent's self-reported test results, context references, permissions and approvals remain untrusted until independently checked.
- A Delta worktree isolates file changes but is not a strict OS security sandbox. The Scout and Reviewer subagent profiles can run terminal commands, so do not infer read-only security from their names. Use separate sandbox mounts, credentials, and tool gateways when information must be withheld.

## 1. Generate role-specific handoffs

From the repository root:

```sh
node experiments/scoped-agent-coordination/proof.mjs prepare --dir ./agent-handoff
```

The resulting packets have different context fragments and versioned decision receipts. There is no universal knowledge packet.

## 2. Open separate Delta.dev threads

Make four distinct threads, each with a separate worktree or isolated runtime and only the scope it should read:

| Thread | Intent | Allowed source | Output |
| --- | --- | --- | --- |
| Builder (WI-1) | Evaluate code impact of the evidence-policy change | M4 loop, original v1 evidence policy, its receipt | Implementation claims and proposed rework |
| Console (WI-2) | Evaluate labeling of tests and agent claims | Console review surface, original v1 evidence policy | UX claims and proposed fix |
| Documentation (WI-7) | Work unrelated to the evidence policy | Identity label decision only | Confirmation of no affected dependency |
| Independent red team (REVIEW-1) | Challenge evidence trust | Current v2 policy, limited redacted claims | Unverified finding, no direct integration authority |

In each thread, deliver only that role's `packets/<role>.json`. Pin the actual repository commit or relevant source files independently. Do not use one unrestricted project mount for all four.

Ask each agent to produce one JSON file `submissions/<role>.json`:

```json
{
  "id": "builder",
  "workItemId": "WI-1",
  "basedOn": "evidence-policy@1",
  "asserted": {
    "evidence.counts-as-test": "claims-check"
  },
  "finding": "Optional plain text; unverified"
}
```

Avoid instructing the red team to agree with the decision; tell it to challenge the evidence while observing the safety contract.

## 3. Compare without homogenizing context

Collect only those JSON submissions into the handoff directory. Do not share other agents' hidden knowledge, secrets or internal workspaces. Run:

```sh
node experiments/scoped-agent-coordination/proof.mjs review --dir ./agent-handoff
```

The report identifies known changed-facet dependencies, irrelevant work, conflicting self-reported claims and independent proposed findings. A missing or malformed output blocks its assessment.

## 4. Real authorization and verification

The `proof.mjs` evaluator is an impact **preview**, not production enforcement. To test the real gate, use the existing Convergence Worker/API and its `delta-core` implementation, providing actual historical or new `WorkItemRegistered`, `BaselinePushed`, `ForkPushed`, `EvidenceRecorded`, and `ResolutionRecorded` events. Verified tests must be run by the trusted host against pinned outputs. No agent may simply declare its own evidence trusted or approve its exception.

## 5. Minimum acceptance criteria

1. Every active participant has a different, deliberate context packet.
2. Only work with a **recorded dependency on changed governing facets** requires revalidation.
3. Unrelated work is unchanged.
4. The red-team review remains independently attributable and untrusted until judged.
5. Attempts to promote from a forged or stale receipt, or to self-approve, fail closed.
6. A human must be able to inspect and resolve an actual downstream mismatch in the existing production gate.

Delta.dev references: https://delta.dev/docs/concepts/core-concepts , https://delta.dev/docs/concepts/delta-and-git , https://delta.dev/docs/agents/subagents .
