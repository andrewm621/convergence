# Scoped context, accountable work (experimental)

This experiment runs four isolated **test workers** against a real historical decision from this repository. It is an **adapter experiment**, not a change to the Convergence Protocol v0.1 or to the authoritative `delta-core` promotion gate.

Source: `scenarios/delta-convergence-build/src/records.ts`, decision `evidence-policy@1 -> @2`. Historical commit IDs and decision facet values come from that fixture. Its dependency graph was reconstructed after the fact; these are not historical packet deliveries or original model runs.

- WI-1 / builder: old evidence policy, dependent implementation, **revalidation required**.
- WI-2 / console: old evidence policy, dependent interface, **revalidation required**.
- WI-7 / docs: separate identity-label context, **unaffected**.
- REVIEW-1 / independent red team: new policy and redacted validation context; can raise findings, never approve.

## Run

Node.js 22+, no dependencies or model keys:

```sh
node experiments/scoped-agent-coordination/proof.mjs simulate
node --test experiments/scoped-agent-coordination/proof.test.mjs
node experiments/scoped-agent-coordination/proof.mjs prepare --dir ./agent-handoff
# Give each agent ONLY its packets/<role>.json in a separately permissioned Delta.dev thread/worktree.
# Each agent writes submissions/<role>.json with id, workItemId, and asserted.
node experiments/scoped-agent-coordination/proof.mjs review --dir ./agent-handoff
```

With `simulate`, separate Node Worker threads consume different scoped packets and produce deterministic stand-in responses. **These are not real independent LLM sessions.** With `prepare`/`review`, actual agents running in Delta.dev, Codex or other harnesses can supply the responses, but the execution tools must independently enforce each packet's access policy.

This experiment makes a deliberately narrow claim: known dependencies on changed decision facets are detected, unrelated work remains unaffected, an adversarial opinion stays a proposal, and no agent's own claim counts as a trusted executed test or authorization. The output is an **impact preview**, not a real merge block; production enforcement remains the existing Convergence Worker and `delta-core`.

## Security boundaries

Packet hashes are integrity digests only, **not signatures**. Worker threads are separate execution contexts but **not security sandboxes**. The harness does not call an LLM, perform external code verification, write authoritative context decisions, push commits, or merge work. It never proves that an agent truly understood its delivered context. It does not claim that the historical agents really consumed the constructed packets.

Delta.dev already provides a useful work substrate: linked conversation + worktree histories, continuous file deltas, and independently delegated subagents. It does **not** make Delta Convergence's semantic commitments and scoped reconciliation redundant. See https://delta.dev/docs/concepts/core-concepts and https://delta.dev/docs/agents/subagents.

Next integration: use the existing Convergence event pipeline (`WorkItemRegistered`, `BaselinePushed`, `ForkPushed`, `EvidenceRecorded`, `ResolutionRecorded`) to consume genuinely independent work with trusted runtime evidence, while preserving the v0.1 contracts until a test requires extension.
