import type { FacetValue, AgentActivity } from "contracts";
import type { MockCell } from "./cell";
import type { MockSession } from "./session";

/** What a beat asks the screen to do besides changing state: select an item, open the editor. */
export type UiHint = {
	select?: string;
	tab?: "why" | "receipt" | "semantic" | "changes" | "actions";
	editor?: { recordId: string; facets: Record<string, FacetValue>; prose: string; rationale: string };
};

export type ActivityLine = readonly [workItemId: string, kind: AgentActivity["kind"], text: string];

export type BeatContext = {
	session: MockSession;
	cell: MockCell;
	/** Stream agent output into the activity strip (spaced out live, immediate when replaying). */
	drip(lines: readonly ActivityLine[]): void;
};

export type Beat = {
	id: string;
	/** Short name shown on the controls. */
	title: string;
	/** What the audience should see happen, in one line. */
	caption: string;
	run(ctx: BeatContext): Promise<UiHint | undefined>;
};

export type MockScript = {
	id: string;
	label: string;
	beats: Beat[];
};
