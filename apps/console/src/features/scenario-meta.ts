import { BriefcaseBusiness, Code2, HeartHandshake } from "lucide-react";
import type { ScenarioName } from "@/client/types";

export type ScenarioMeta = {
	label: string;
	kind: string;
	icon: typeof Code2;
	/** A line the header keeps in view for as long as the scenario is open. */
	note?: string;
};

/** The note that must stay visible on the shelter scenario. */
export const SYNTHETIC_NOTE = "Synthetic scenario. Not operational guidance.";

export const SCENARIO_META: Record<ScenarioName, ScenarioMeta> = {
	notifications: { label: "Notifications", kind: "coding", icon: Code2 },
	"shelter-intake": {
		label: "Larkhaven County Shelter",
		kind: "knowledge work",
		icon: HeartHandshake,
		note: `${SYNTHETIC_NOTE} Larkhaven County, its river flood and the Larkhaven Mutual Aid Network are fictional.`,
	},
	"sales-ops": { label: "Northwind Sales Ops", kind: "knowledge work", icon: BriefcaseBusiness },
};
