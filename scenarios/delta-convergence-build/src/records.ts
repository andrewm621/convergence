/**
 * Context records for the build-history replay.
 *
 * Retrofitted from this repo's git history: these decisions were made before Delta Convergence was recording
 * them, and the replay reconstructs them. "Larkhaven County" and "Larkhaven Mutual Aid Network" are the invented
 * names the shelter fixture uses. The decision owner is a role only.
 *
 * Facet keys are dotted (`evidence.counts-as-test`) and quoted in the front matter, with flat scalar values.
 */

export const EVIDENCE_POLICY_PATH = "context/decisions/evidence-policy.md";
export const SCENARIO_NAMING_PATH = "context/decisions/scenario-naming.md";
export const SCENARIO_PLAN_PATH = "context/decisions/scenario-plan.md";
export const PRODUCT_NAMING_PATH = "context/decisions/product-naming.md";
export const POSITIONING_PATH = "context/decisions/positioning.md";
export const DEMO_IDENTITY_PATH = "context/decisions/demo-identity.md";

const NOTE = "> Retrofitted from this repo's git history. Dependencies are declared by us; no automated evidence.";

/** v1: the agent's own claims check is accepted as the contract test. First landed in commit 2cf1f2e (PR #6). */
export const EVIDENCE_POLICY_V1 = `---
id: evidence-policy
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T03:47:01Z
facets:
  "evidence.counts-as-test": "claims-check"
  "evidence.claims-check-role": "test"
  "evidence.required-facets": "none"
---
# What counts as a contract test

${NOTE}

The check an agent's claims go through is what gates a work item.
`;

/** v2: only a check Delta Convergence runs counts; the claims check is informational. Commit 163cb45 (PR #6). */
export const EVIDENCE_POLICY_V2 = `---
id: evidence-policy
version: 2
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T04:04:23Z
supersedes: evidence-policy@1
facets:
  "evidence.counts-as-test": "delta-run-check"
  "evidence.claims-check-role": "informational"
  "evidence.required-facets": "none"
not:
  "evidence.counts-as-test": "claims-check"
  "evidence.claims-check-role": "test"
---
# What counts as a contract test

${NOTE}

Only a check that Delta Convergence runs itself counts as a test. The claims check is recorded but informational.
`;

/** v3: the run check asserts the facets the item relied on, taken from its receipt. Commit cd31c39 (PR #6). */
export const EVIDENCE_POLICY_V3 = `---
id: evidence-policy
version: 3
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T04:18:34Z
supersedes: evidence-policy@2
facets:
  "evidence.counts-as-test": "delta-run-check"
  "evidence.claims-check-role": "informational"
  "evidence.required-facets": "from-receipt"
not:
  "evidence.required-facets": "none"
---
# What counts as a contract test

${NOTE}

A run check asserts exactly the facets the work item relied on, and fails closed when it is handed none.
`;

/** v1: the fictional county is Cedar County. First appears in commit 61867a9 (PR #3). */
export const SCENARIO_NAMING_V1 = `---
id: scenario-naming
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T02:57:39Z
facets:
  "scenario.county": "Cedar County"
  "scenario.network": "Larkhaven Mutual Aid Network"
---
# Naming for the shelter scenario

${NOTE}

The synthetic shelter scenario is set in an invented county.
`;

/** v2: renamed to Larkhaven County. Commit 59d48e4 (PR #4). The network name does not move. */
export const SCENARIO_NAMING_V2 = `---
id: scenario-naming
version: 2
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T03:11:59Z
supersedes: scenario-naming@1
facets:
  "scenario.county": "Larkhaven County"
  "scenario.network": "Larkhaven Mutual Aid Network"
not:
  "scenario.county": "Cedar County"
---
# Naming for the shelter scenario

${NOTE}

The invented county is renamed. The volunteer network keeps its name.
`;

/** v1: the second act of the demo is the shelter scenario, shown as a replay. The live v2 happens later, in the live cell. */
export const SCENARIO_PLAN_V1 = `---
id: scenario-plan
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T03:00:00Z
facets:
  "scenario.second-act": "shelter-intake"
  "scenario.second-act-mode": "replay"
---
# Plan for the second act

${NOTE}

The second act is the shelter scenario, played from a recording.
`;

/** v1: the public name is Delta Convergence; the bare word is banned. */
export const PRODUCT_NAMING_V1 = `---
id: product-naming
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T02:58:20Z
facets:
  "naming.public-name": "Delta Convergence"
  "naming.bare-delta": "banned"
---
# Product naming

${NOTE}

The product is always called by its full name.
`;

/** v2: wording only. The facets are byte-identical, so this is the negative control (PROSE_ONLY). */
export const PRODUCT_NAMING_V2 = `---
id: product-naming
version: 2
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T04:30:00Z
supersedes: product-naming@1
facets:
  "naming.public-name": "Delta Convergence"
  "naming.bare-delta": "banned"
---
# Product naming

${NOTE}

The product is always called by its full name, in the console, the README and the video. The shorthand stays out of every public surface. (Illustrative wording edit: it has no commit in the repo.)
`;

/** v1: the headline claims. No change in the replay. */
export const POSITIONING_V1 = `---
id: positioning
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T02:58:20Z
facets:
  "positioning.llm-claim": "control loop makes no model calls"
  "positioning.tagline": "a control plane that keeps concurrent humans and agents working from the same meaning"
---
# Positioning

${NOTE}

What the product says about itself.
`;

/** v1: the label the console shows for the human who decides. No change in the replay. */
export const DEMO_IDENTITY_V1 = `---
id: demo-identity
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T02:58:20Z
facets:
  "identity.label": "Decision owner (demo identity)"
---
# Demo identity

${NOTE}

The console labels the person who resolves work as a demo identity.
`;
