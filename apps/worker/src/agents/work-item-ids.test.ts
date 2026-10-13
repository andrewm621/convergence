import { describe, expect, it } from "vitest";
import { cellIdFor, runtimeIdCollision, runtimeIdFor } from "./work-item-ids";

describe("cell id to runtime id", () => {
	it("lowercases the fixture ids: WI-1 is wi-1, WI-2 is wi-2", () => {
		expect(runtimeIdFor("WI-1")).toEqual({ ok: true, id: "wi-1" });
		expect(runtimeIdFor("WI-2")).toEqual({ ok: true, id: "wi-2" });
		expect(runtimeIdFor("wi-2")).toEqual({ ok: true, id: "wi-2" });
	});

	it.each(["WI_2", "-WI", "WI-", "a".repeat(41), ""])("has no runtime id for %j", (id) => {
		expect(runtimeIdFor(id).ok).toBe(false);
	});

	it("round-trips: the runtime id maps back to exactly one cell id", () => {
		const known = ["WI-1", "WI-2", "Shelter-3"];
		for (const id of known) {
			const runtime = runtimeIdFor(id);
			expect(runtime.ok && cellIdFor(runtime.id, known)).toBe(id);
		}
		expect(cellIdFor("wi-9", known)).toBeNull();
	});

	it("refuses to guess when two cell ids share a runtime id", () => {
		expect(cellIdFor("wi-2", ["WI-2", "wi-2"])).toBeNull();
		expect(runtimeIdCollision("WI-2", ["WI-1", "WI-2", "wi-2"])).toBe("wi-2");
		expect(runtimeIdCollision("WI-2", ["WI-1", "WI-2"])).toBeNull();
	});
});
