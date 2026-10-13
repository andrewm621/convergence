/**
 * Context records for Scenario A, as the Markdown files that live in the baseline repo under
 * `context/`. These are the real files the parser reads, so the fixtures exercise the real path.
 */

export const NOTIFICATIONS_CHECK = "tests/contract/notifications.test.ts";
export const STATUS_MODEL_CHECK = "tests/contract/status-model.test.ts";

export const NOTIFICATIONS_PATH = "context/notifications.md";
export const STATUS_MODEL_PATH = "context/status-model.md";

/** v1: updates arrive immediately and are on by default. */
export const NOTIFICATIONS_V1 = `---
id: notifications
version: 1
status: accepted
authority: andrew
proposed_by: andrew
accepted_by: andrew
accepted_at: 2026-10-12T16:00:00Z
validation: ${NOTIFICATIONS_CHECK}
facets:
  notifications.default: "on"
  notifications.cadence: immediate
  notifications.channel: in-app
---
# Notifications
Users receive project status updates immediatly, and they are on by default.
`;

/** v1 with a typo fixed in the prose. No facet moves: the typo beat. */
export const NOTIFICATIONS_V1_TYPO_FIX = NOTIFICATIONS_V1.replace("immediatly", "immediately");

/** v2: notifications are opt-in, delivered as a weekly digest. Channel is untouched. */
export const NOTIFICATIONS_V2 = `---
id: notifications
version: 2
status: accepted
authority: andrew
proposed_by: andrew
accepted_by: andrew
accepted_at: 2026-10-13T16:00:00Z
supersedes: notifications@1
validation: ${NOTIFICATIONS_CHECK}
decision: decisions/0002-notifications-opt-in.md
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
  notifications.channel: in-app
not:
  notifications.default: "on"
  notifications.cadence: immediate
---
# Notifications
Users opt in to project status notifications, delivered as a weekly digest. (Decision 2026-10-13, see decisions/0002.)
`;

/** v3: a new version whose facets equal v2's. Only the prose moved. */
export const NOTIFICATIONS_V3_PROSE_BUMP = `---
id: notifications
version: 3
status: accepted
authority: andrew
proposed_by: andrew
accepted_by: andrew
accepted_at: 2026-10-13T18:00:00Z
supersedes: notifications@2
validation: ${NOTIFICATIONS_CHECK}
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
  notifications.channel: in-app
---
# Notifications
Project status notifications are opt-in and arrive as a weekly digest.
`;

/** An unauthorised change: accepted by someone who is not the record's authority. */
export const NOTIFICATIONS_V2_FORGED = NOTIFICATIONS_V2.replace("accepted_by: andrew", "accepted_by: agent-b");

export const STATUS_MODEL_V1 = `---
id: status-model
version: 1
status: accepted
authority: andrew
proposed_by: andrew
accepted_by: andrew
accepted_at: 2026-10-12T16:00:00Z
validation: ${STATUS_MODEL_CHECK}
facets:
  status.values: [draft, active, blocked, done]
  status.transitions: forward-only
---
# Status model
A project is draft, active, blocked or done, and only moves forward.
`;
