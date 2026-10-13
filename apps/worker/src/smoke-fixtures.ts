// Synthetic content for the M0a smoke run. The ContextRecord shape follows PRD section 4.

export const AGENTS_MD = `# Agent protocol

1. Read \`context/*.md\`. Each file is an accepted decision; its front-matter facets are binding.
2. Do the task on your own fork.
3. Cite \`recordId@version\` for every claim you make.
4. Commit and push to your fork. Never push to the baseline.
`;

export const INDEX_TS = `export function greet(name: string): string {
  return "hello, " + name;
}
`;

export const NOTIFICATIONS_V1 = `---
id: notifications
version: 1
status: accepted
authority: andrew
proposed_by: andrew
accepted_by: andrew
accepted_at: 2026-10-12T16:00:00Z
validation: tests/contract/notifications.test.ts
facets:
  notifications.default: on
  notifications.cadence: immediate
---
# Notifications
Users receive project status updates immediately. Notifications are on by default.
`;

export const NOTIFICATIONS_V2 = `---
id: notifications
version: 2
status: accepted
authority: andrew
proposed_by: andrew
accepted_by: andrew
accepted_at: 2026-10-13T16:00:00Z
supersedes: notifications@1
validation: tests/contract/notifications.test.ts
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
---
# Notifications
Users opt in to project status notifications, delivered as a weekly digest.
`;

export const SEED_FILES: Record<string, string> = {
	"AGENTS.md": AGENTS_MD,
	"context/notifications.md": NOTIFICATIONS_V1,
	"src/index.ts": INDEX_TS,
};

/** Pull `version: N` out of a record's front-matter. */
export function recordVersion(markdown: string): number | null {
	const match = /^version:\s*(\d+)\s*$/m.exec(markdown);
	return match?.[1] ? Number(match[1]) : null;
}
