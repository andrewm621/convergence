import { describe, expect, it } from "vitest";
import { cellAfterSwitch } from "./types";

describe("cellAfterSwitch", () => {
	it("carries a staged recording suffix to the chosen scenario, both ways", () => {
		expect(cellAfterSwitch("notifications-rec1", "shelter-intake")).toBe("shelter-intake-rec1");
		expect(cellAfterSwitch("shelter-intake-rec1", "notifications")).toBe("notifications-rec1");
		expect(cellAfterSwitch("notifications-rec12", "sales-ops")).toBe("sales-ops-rec12");
	});

	it("leaves any other cell, so the scenario's own cell opens", () => {
		expect(cellAfterSwitch("notifications-demo", "shelter-intake")).toBeUndefined();
		expect(cellAfterSwitch("notifications-rec", "shelter-intake")).toBeUndefined();
		expect(cellAfterSwitch(undefined, "shelter-intake")).toBeUndefined();
		expect(cellAfterSwitch("bogus-rec1", "shelter-intake")).toBeUndefined();
	});
});
