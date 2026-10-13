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
	/** What runs the work, shown where a model name would be. Overrides the model on `AgentRunStarted`. */
	agentLabel?: string;
	/** The work is in this repo's real git history: shas link to GitHub and an all-zero sha reads "not in git". */
	realHistory?: boolean;
	/** Why Revalidate, Accept exception, Reject, Promote and Propose change are disabled. Set for recordings only. */
	readOnlyReason?: string;
};

/** The note that must stay visible on the shelter scenario. */
export const SYNTHETIC_NOTE = "Synthetic scenario. Not operational guidance.";

/** The note that must stay visible on the replay of our own build. */
export const BUILD_NOTE_LEAD = "Retrofitted from this repo's git history.";
export const BUILD_NOTE = `${BUILD_NOTE_LEAD} Decisions made before Delta Convergence was recording them; dependencies declared by us; humans resolve.`;

/** Where the shas in the build replay live. */
export const REPO_URL = "https://github.com/andrewm621/delta-convergence";

export const SCENARIO_META: Record<ScenarioName, ScenarioMeta> = {
	notifications: { label: "Notifications", kind: "coding", icon: Code2 },
	"shelter-intake": {
		label: "Larkhaven County Shelter",
		kind: "knowledge work",
		icon: HeartHandshake,
		note: `${SYNTHETIC_NOTE} Larkhaven County, its river flood and the Larkhaven Mutual Aid Network are fictional.`,
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
	},
	"sales-ops": { label: "Northwind Sales Ops", kind: "knowledge work", icon: BriefcaseBusiness, hidden: true },
};
