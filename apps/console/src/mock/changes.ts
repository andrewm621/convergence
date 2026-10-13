import type { WorkItemState } from "contracts";
import * as shelter from "scenario-shelter-intake";
import type { FileChange } from "@/client/types";

/**
 * Canned file changes for the mock. They are what a fork's tree diff would return (T-4): path,
 * status, counts and a unified patch. Written to match what each fixture's claims say the agent
 * built, so the Changes tab and the claim comparison tell the same story.
 */

function change(path: string, status: FileChange["status"], patch: string[]): FileChange {
	const lines = patch.filter((line) => !line.startsWith("@@"));
	return {
		path,
		status,
		additions: lines.filter((line) => line.startsWith("+")).length,
		deletions: lines.filter((line) => line.startsWith("-")).length,
		patch: patch.join("\n"),
	};
}

const notificationsWi1: FileChange[] = [
	change("src/status/badge.tsx", "added", [
		"@@ -0,0 +1,12 @@",
		"+import type { ProjectStatus } from './model';",
		"+",
		"+export const STATUS_VALUES: ProjectStatus[] = ['draft', 'active', 'blocked', 'done'];",
		"+",
		"+export function StatusBadge({ status }: { status: ProjectStatus }) {",
		"+  return <span data-status={status}>{status}</span>;",
		"+}",
	]),
	change("src/api/status.ts", "modified", [
		"@@ -8,6 +8,14 @@ export function registerStatusRoutes(app: App) {",
		"   app.get('/projects/:id/status', (req) => readStatus(req.params.id));",
		"+  app.post('/projects/:id/status', (req) => {",
		"+    const next = req.body.status as ProjectStatus;",
		"+    if (!canMoveForward(readStatus(req.params.id), next)) throw new Conflict('forward-only');",
		"+    return writeStatus(req.params.id, next);",
		"+  });",
	]),
];

const notificationsWi2Original: FileChange[] = [
	change("src/notifications/preferences.ts", "added", [
		"@@ -0,0 +1,9 @@",
		"+export const DEFAULTS = {",
		"+  // Decision notifications@1: updates are on by default and arrive immediately.",
		"+  enabled: true,",
		"+  cadence: 'immediate',",
		"+  channel: 'in-app',",
		"+} as const;",
	]),
	change("src/notifications/delivery.ts", "added", [
		"@@ -0,0 +1,10 @@",
		"+import { DEFAULTS } from './preferences';",
		"+",
		"+export async function deliver(userId: string, update: StatusUpdate) {",
		"+  const prefs = await loadPreferences(userId, DEFAULTS);",
		"+  if (prefs.enabled) await send(userId, update, prefs.channel);",
		"+}",
	]),
	change("src/settings/notifications-page.tsx", "added", [
		"@@ -0,0 +1,6 @@",
		"+export function NotificationsPage() {",
		"+  return <Toggle label='Project status updates' defaultChecked />;",
		"+}",
	]),
];

const notificationsWi2Revalidated: FileChange[] = [
	change("src/notifications/preferences.ts", "added", [
		"@@ -0,0 +1,9 @@",
		"+export const DEFAULTS = {",
		"+  // Decision notifications@2: opt-in, delivered as a weekly digest.",
		"+  enabled: false,",
		"+  cadence: 'weekly-digest',",
		"+  channel: 'in-app',",
		"+} as const;",
	]),
	change("src/notifications/delivery.ts", "added", [
		"@@ -0,0 +1,12 @@",
		"+import { DEFAULTS } from './preferences';",
		"+",
		"+export async function deliver(userId: string, update: StatusUpdate) {",
		"+  const prefs = await loadPreferences(userId, DEFAULTS);",
		"+  if (!prefs.enabled) return;",
		"+  if (prefs.cadence === 'weekly-digest') return queueForDigest(userId, update);",
		"+  await send(userId, update, prefs.channel);",
		"+}",
	]),
	change("src/settings/notifications-page.tsx", "added", [
		"@@ -0,0 +1,6 @@",
		"+export function NotificationsPage() {",
		"+  return <Toggle label='Weekly project digest' defaultChecked={false} />;",
		"+}",
	]),
];

const salesWi3: FileChange[] = [
	change("reports/q4-forecast.md", "added", [
		"@@ -0,0 +1,9 @@",
		"+# Q4 pipeline forecast",
		"+",
		"+Qualified leads are counted as: web form submitted and 50 or more employees.",
		"+",
		"+| Segment | Qualified leads | Weighted pipeline |",
		"+| --- | --- | --- |",
		"+| Field service, 50-249 | 212 | $1.84M |",
		"+| Field service, 250+ | 96 | $2.31M |",
	]),
];

const salesWi4Original: FileChange[] = [
	change("playbooks/sdr-priorities.md", "added", [
		"@@ -0,0 +1,8 @@",
		"+# SDR weekly priorities",
		"+",
		"+1. Work every lead that is form-filled with 50+ employees first.",
		"+2. Log each call, email or meeting as a touch.",
	]),
];

const salesWi4Revalidated: FileChange[] = [
	change("playbooks/sdr-priorities.md", "added", [
		"@@ -0,0 +1,9 @@",
		"+# SDR weekly priorities",
		"+",
		"+1. Work every lead that is form-filled, has 50+ employees and shows a verified budget signal first.",
		"+2. Leads without a budget signal go to nurture, not to the call list.",
		"+3. Log each call, email or meeting as a touch.",
	]),
];

const salesWi5: FileChange[] = [
	change("docs/glossary.md", "added", [
		"@@ -0,0 +1,7 @@",
		"+# Sales activity glossary",
		"+",
		"+- **Touch**: an outbound call, email or meeting made by a person.",
		"+- Automated sequences do not count as touches.",
	]),
];

/** A new text file as a unified patch: what the tree diff of a drafted document looks like. */
function addedDocument(path: string, text: string): FileChange {
	const lines = text.trimEnd().split("\n");
	return change(path, "added", [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]);
}

const shelterChanges: Record<string, FileChange[]> = {
	"WI-1": [addedDocument(shelter.SCRIPT_PATH, shelter.SCRIPT_V1)],
	"WI-1:revalidated": [addedDocument(shelter.SCRIPT_PATH, shelter.SCRIPT_V2)],
	"WI-2": [addedDocument(shelter.SIGNAGE_PATH, shelter.SIGNAGE_V1)],
	"WI-3": [addedDocument(shelter.BRIEFING_PATH, shelter.BRIEFING_V1)],
	"WI-3:revalidated": [addedDocument(shelter.BRIEFING_PATH, shelter.BRIEFING_V2)],
	"WI-4": [addedDocument(shelter.SUPPLIES_PATH, shelter.SUPPLIES_V1)],
	"WI-5": [addedDocument(shelter.SCHEDULE_PATH, shelter.SCHEDULE_V1)],
};

export function changesFor(scenario: "notifications" | "sales-ops" | "shelter-intake" | "delta-convergence-build", wi: WorkItemState): FileChange[] {
	if (wi.item.source === "seeded" || wi.headSha === null) return [];
	const revalidated = wi.revalidations > 0;
	if (scenario === "shelter-intake") {
		const id = wi.item.id;
		return shelterChanges[revalidated ? `${id}:revalidated` : id] ?? shelterChanges[id] ?? [];
	}
	switch (`${scenario}:${wi.item.id}`) {
		case "notifications:WI-1":
			return notificationsWi1;
		case "notifications:WI-2":
			return revalidated ? notificationsWi2Revalidated : notificationsWi2Original;
		case "sales-ops:WI-3":
			return salesWi3;
		case "sales-ops:WI-4":
			return revalidated ? salesWi4Revalidated : salesWi4Original;
		case "sales-ops:WI-5":
			return salesWi5;
		default:
			return [];
	}
}
