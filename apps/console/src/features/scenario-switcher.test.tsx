import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Header, ScenarioSwitcher, visibleScenarios } from "./header";
import { SCENARIO_META } from "./scenario-meta";

// Scranton Paper is a recording. The Worker never seeds sales-ops, so a live `-rec1` cell for it would open empty:
// the live switcher must not offer it, and the mock must still.

function tabs(live: boolean, value: Parameters<typeof visibleScenarios>[0] = "notifications") {
	render(<ScenarioSwitcher value={value} onChange={() => undefined} live={live} />);
	const group = screen.getByRole("radiogroup", { name: "Scenario" });
	return within(group).getAllByRole("radio");
}

describe("scenario switcher, live", () => {
	it("leaves Scranton Paper out and keeps the other labels as they were", () => {
		const radios = tabs(true);
		expect(radios.map((r) => r.textContent?.replace(/\s+/g, " ").trim())).toEqual(["Notifications · coding", "Larkhaven County Shelter · knowledge work", "Our own build (replay) · replay"]);
		expect(screen.queryByRole("radio", { name: /Scranton Paper/ })).toBeNull();
		expect(visibleScenarios("shelter-intake", true)).toEqual(["notifications", "shelter-intake", "delta-convergence-build"]);
	});

	it("keeps the kind showing from 2xl, as before Scranton Paper existed", () => {
		const kinds = tabs(true).map((r) => r.lastElementChild!.className);
		for (const cls of kinds) expect(cls).not.toContain("min-[2200px]:inline");
		expect(kinds.every((cls) => cls.includes("2xl:inline"))).toBe(true);
	});

	it("still shows the open scenario, even a replay-only one reached by URL", () => {
		expect(visibleScenarios("sales-ops", true)).toContain("sales-ops");
	});

	it("the Header offers no Scranton Paper tab on a live cell", () => {
		render(<Header scenario="shelter-intake" onScenario={() => undefined} connection="live" live />);
		expect(screen.queryByRole("radio", { name: /Scranton Paper/ })).toBeNull();
	});
});

describe("scenario switcher, mock", () => {
	it("offers Scranton Paper alongside the others", () => {
		const radios = tabs(false);
		expect(radios.map((r) => r.textContent?.replace(/\s+/g, " ").trim())).toContain("Scranton Paper Supply · knowledge work");
		expect(radios).toHaveLength(4);
		expect(visibleScenarios("notifications", false)).toContain("sales-ops");
	});

	it("keeps the quieter kind at four tabs so they fit at 1920", () => {
		const inactive = tabs(false)
			.slice(1)
			.map((r) => r.lastElementChild!.className);
		expect(inactive.every((cls) => cls.includes("min-[2200px]:inline"))).toBe(true);
	});
});

describe("replayOnly", () => {
	it("is set on the Scranton Paper entry and on nothing the Worker seeds", () => {
		// Fails if the flag is dropped: the live switcher would offer an empty sales-ops-rec1 cell.
		expect(SCENARIO_META["sales-ops"].replayOnly).toBe(true);
		expect(SCENARIO_META.notifications.replayOnly).toBeFalsy();
		expect(SCENARIO_META["shelter-intake"].replayOnly).toBeFalsy();
		expect(SCENARIO_META["delta-convergence-build"].replayOnly).toBeFalsy();
	});
});
