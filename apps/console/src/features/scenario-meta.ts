import { BriefcaseBusiness, Code2, HeartHandshake, History } from "lucide-react";
import type { ScenarioName } from "@/client/types";

export type ScenarioMeta = {
	label: string;
	kind: string;
	icon: typeof Code2;
	/** A line the header keeps in view for as long as the scenario is open. */
	note?: string;
	/** The bold opening of `note`. Defaults to the synthetic-scenario note. */
	noteLead?: string;
	/** Left out of the scenario switcher unless it is the open scenario. Still reachable with `?scenario=`. */
	hidden?: boolean;
	/** A recording the Worker never seeds: left out of the switcher in live mode (a `-rec1` cell for it would be empty), offered in the mock. */
	replayOnly?: boolean;
	/** What runs the work, shown where a model name would be. Overrides the model on `AgentRunStarted`. */
	agentLabel?: string;
	/** The work is in this repo's real git history: shas link to GitHub and an all-zero sha reads "not in git". */
	realHistory?: boolean;
	/** Why Revalidate, Allow with exception, Reject, Merge and Change this decision are disabled. Set for recordings only. */
	readOnlyReason?: string;
	/** The example in the exception form's "What it covers" field: something this scenario could actually name. */
	scopeExample?: string;
};

/** Shown when a scenario names no example of its own. */
export const DEFAULT_SCOPE_EXAMPLE = "e.g. the one document this covers";

/** The note that must stay visible on the shelter scenario. */
export const SYNTHETIC_NOTE = "Synthetic scenario. Not operational guidance.";

/** The note that must stay visible on the Sablewood sales scenario. */
export const SALES_NOTE_LEAD = "Synthetic scenario.";
export const SALES_NOTE = `${SALES_NOTE_LEAD} Sablewood is a fictional software company; its leads and pipeline numbers are invented.`;

/** The note that must stay visible on the replay of our own build. */
export const BUILD_NOTE_LEAD = "Retrofitted from this repo's git history.";
export const BUILD_NOTE = `${BUILD_NOTE_LEAD} Decisions made before Convergence was recording them; dependencies declared by us; humans resolve.`;

/** The note on the live workspace of our own build, which starts where the replay ends. */
export const LIVE_BUILD_NOTE_LEAD = "Live:";
export const LIVE_BUILD_NOTE = `${LIVE_BUILD_NOTE_LEAD} this repo's own build decisions since Oct 13. Earlier history is the replay.`;

/** Where the shas in the build replay live. */
export const REPO_URL = "https://github.com/andrewm621/convergence";

export const SCENARIO_META: Record<ScenarioName, ScenarioMeta> = {
	notifications: { label: "Notifications", kind: "coding", icon: Code2, scopeExample: "e.g. src/notifications/delivery.ts" },
	"shelter-intake": {
		label: "Larkhaven County Shelter",
		kind: "knowledge work",
		icon: HeartHandshake,
		note: `${SYNTHETIC_NOTE} Larkhaven County, its river flood and the Larkhaven Mutual Aid Network are fictional.`,
		scopeExample: "e.g. the printed door signs only",
	},
	"delta-convergence-build": {
		label: "Our own build (replay)",
		kind: "replay",
		icon: History,
		note: BUILD_NOTE,
		noteLead: BUILD_NOTE_LEAD,
		agentLabel: "recorded build session",
		realHistory: true,
		readOnlyReason: "Resolved by a human outside the console in the real build.",
		scopeExample: "e.g. docs/PRD.md only",
	},
	"sales-ops": {
		label: "Sablewood Sales",
		kind: "knowledge work",
		icon: BriefcaseBusiness,
		note: SALES_NOTE,
		noteLead: SALES_NOTE_LEAD,
		replayOnly: true,
		scopeExample: "e.g. reports/q4-forecast.md",
	},
};

/**
 * What the console shows for a scenario. The build scenario is a replay in the mock and a live workspace on the Worker
 * (`?cell=delta-convergence-build-<name>`); the live one keeps the read-only actions but not the GitHub sha links, because
 * its fork heads are Artifacts commits, not commits of this repo.
 */
export function scenarioMeta(scenario: ScenarioName, live: boolean): ScenarioMeta {
	const meta = SCENARIO_META[scenario];
	if (live && scenario === "delta-convergence-build") {
		return { ...meta, label: "Our own build (live)", kind: "live", note: LIVE_BUILD_NOTE, noteLead: LIVE_BUILD_NOTE_LEAD, realHistory: false };
	}
	return meta;
}
