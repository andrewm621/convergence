import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Header } from "./header";
import { BUILD_NOTE, SCENARIO_META, scenarioMeta } from "./scenario-meta";

// Our own build is a replay in the mock and a live workspace on the Worker. The live one says so, keeps Revalidate and
// Promote disabled with the replay's tooltip, and does not link Artifacts commits to GitHub.

describe("our own build, live", () => {
	it("the banner says it is live, since Oct 13, with the earlier history in the replay", () => {
		render(<Header scenario="delta-convergence-build" onScenario={() => undefined} connection="live" live />);
		expect(screen.getByTestId("scenario-note")).toHaveTextContent("Live: this repo's own build decisions since Oct 13. Earlier history is the replay.");
		expect(screen.getByRole("radio", { name: /Our own build \(live\)/ })).toBeChecked();
	});

	it("the replay keeps its retrofit banner in the mock", () => {
		render(<Header scenario="delta-convergence-build" onScenario={() => undefined} connection="mock" />);
		expect(screen.getByTestId("scenario-note")).toHaveTextContent(BUILD_NOTE);
		expect(screen.getByRole("radio", { name: /Our own build \(replay\)/ })).toBeChecked();
	});

	it("keeps the actions disabled with the same tooltip, and turns off the GitHub sha links", () => {
		const live = scenarioMeta("delta-convergence-build", true);
		expect(live.readOnlyReason).toBe(SCENARIO_META["delta-convergence-build"].readOnlyReason);
		expect(live.readOnlyReason).toBeTruthy();
		expect(live.realHistory).toBe(false);
		expect(SCENARIO_META["delta-convergence-build"].realHistory).toBe(true);
	});

	it("leaves every other scenario as it was, live or not", () => {
		for (const name of ["notifications", "shelter-intake", "sales-ops"] as const) expect(scenarioMeta(name, true)).toBe(SCENARIO_META[name]);
	});

	it("never shortens the product name", () => {
		render(<Header scenario="delta-convergence-build" onScenario={() => undefined} connection="live" live />);
		expect(document.body.textContent ?? "").not.toMatch(/\bDelta\b(?! Convergence)/);
	});
});
