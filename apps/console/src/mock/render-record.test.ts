import { describe, expect, it } from "vitest";
import { parseContextRecord } from "contracts";
import { renderRecord } from "./session";

const input = {
	id: "notifications",
	version: 2,
	authority: "decision-owner",
	actor: "decision-owner",
	acceptedAt: "2026-10-13T16:00:00Z",
	supersedes: "notifications@1",
	validation: null,
	facets: { "notifications.default": "opt-in" },
	not: [["notifications.default", "on"]] as const,
	prose: "# Notifications",
};

describe("mock renderRecord (kept in step with the Worker's)", () => {
	it("writes `why` when given, and the strict parser reads it back", () => {
		const parsed = parseContextRecord(renderRecord({ ...input, why: "Opt-in only, after the consent complaints." }));
		expect(parsed).toMatchObject({ ok: true, record: { frontMatter: { why: "Opt-in only, after the consent complaints.", not: { "notifications.default": "on" } } } });
	});

	it("writes no `why` line when there is none", () => {
		expect(renderRecord(input)).not.toContain("why:");
	});
});
