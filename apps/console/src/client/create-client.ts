import { createMockClient } from "@/mock/client";
import { createLiveClient } from "./live";
import { isScenarioName, type ConsoleClient, type ScenarioName } from "./types";

export type Runtime = {
	/** Replay a scripted scenario in the browser instead of connecting to the Worker. */
	mock: boolean;
	scenario: ScenarioName;
	/** Mock only: begin with no accepted context, to show the empty state. */
	start: "seeded" | "empty";
	/** Mock only: which script to start on (`story` or `fanout`). */
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
	return {
		mock,
		// The build replay exists only in the mock: the Worker has no such scenario.
		scenario: isScenarioName(scenarioParam) && (mock || scenarioParam !== "delta-convergence-build") ? scenarioParam : "notifications",
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
		: createLiveClient({ scenario: runtime.scenario });
}
