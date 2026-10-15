import { createMockClient } from "@/mock/client";
import { createLiveClient } from "./live";
import { isScenarioName, scenarioOfCell, type ConsoleClient, type ScenarioName } from "./types";

export type Runtime = {
	/** Replay a scripted scenario in the browser instead of connecting to the Worker. */
	mock: boolean;
	scenario: ScenarioName;
	/**
	 * Live only: `?view=public` opens the cell as the public read-only view. No token is read or asked for, state comes from polling
	 * the Worker's public GET reads, and every command is refused in the browser. It is ignored with `?mock=1`.
	 */
	publicView?: boolean;
	/** Live only: a named cell (`notifications-demo`) to open instead of the scenario's own. Its name decides `scenario`. */
	cell?: string;
	/** Mock only: begin with no accepted context, to show the empty state. */
	start: "seeded" | "empty";
	/** Mock only: which script to start on (`story`, `fanout` or `undeclared`). */
	script?: string;
	/** Mock only: space agent output out over time. */
	drip: boolean;
	/** Mock only: show the beat controls. */
	controls: boolean;
};

/** `VITE_MOCK=1` or `?mock=1` selects the mock. Everything else is a query parameter for the mock. */
export function readRuntime(search: string, env: { VITE_MOCK?: string } = import.meta.env): Runtime {
	const params = new URLSearchParams(search);
	const scenarioParam = params.get("scenario");
	const mock = env.VITE_MOCK === "1" || params.get("mock") === "1";
	// `?cell=` names a cell on the Worker, so it means nothing to the mock; a name that is not valid is ignored.
	const cellParam = params.get("cell");
	const cellScenario = mock ? null : scenarioOfCell(cellParam);
	return {
		mock,
		publicView: !mock && params.get("view") === "public",
		// The build replay exists only in the mock: the Worker has no such scenario.
		scenario: cellScenario ?? (isScenarioName(scenarioParam) && (mock || scenarioParam !== "delta-convergence-build") ? scenarioParam : "notifications"),
		...(cellScenario ? { cell: cellParam as string } : {}),
		start: params.get("start") === "empty" ? "empty" : "seeded",
		script: params.get("script") ?? undefined,
		drip: params.get("drip") !== "0",
		controls: params.get("controls") !== "0",
	};
}

/** The one place the mock and the live client are chosen between. */
export function createClient(runtime: Runtime): ConsoleClient {
	return runtime.mock
		? createMockClient({ scenario: runtime.scenario, start: runtime.start, script: runtime.script, drip: runtime.drip })
		: createLiveClient({ scenario: runtime.scenario, cell: runtime.cell, readOnly: runtime.publicView });
}
