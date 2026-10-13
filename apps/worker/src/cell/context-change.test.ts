import { describe, expect, it } from "vitest";
import { parseContextRecord } from "contracts";
import { NOTIFICATIONS_V1, NOTIFICATIONS_V2 } from "scenario-notifications";
import { nextDecisionPath, planContextChange, type ContextChangeRequest } from "./context-change";

const actor = { kind: "human" as const, id: "decision-owner", displayName: "Decision owner" };
const previous = { path: "context/notifications.md", text: NOTIFICATIONS_V1 };
const base = { actor, now: "2026-10-13T16:00:00Z", idempotencyKey: "key-12345678", previous, currentVersion: 1, existingPaths: ["context/notifications.md", "decisions/0001-start.md"] };
const plan = (request: Partial<ContextChangeRequest>, over: { previous?: { path: string; text: string } | null; currentVersion?: number | null } = {}) =>
	planContextChange({ ...base, ...over, request: { recordId: "notifications", rationale: "because", ...request } as ContextChangeRequest });

describe("planContextChange", () => {
	it("writes the next version, a decision stub numbered after the last, and a parseable record", () => {
		const result = plan({ facets: { "notifications.default": "opt-in", "notifications.cadence": "weekly-digest", "notifications.channel": "in-app" }, rationale: "Opt-in, weekly." });
		if (!result.ok) throw new Error(result.message);
		expect(result).toMatchObject({ kind: "new-version", version: 2, path: "context/notifications.md", decisionPath: "decisions/0002-notifications-v2.md" });
		const parsed = parseContextRecord(result.files["context/notifications.md"] as string);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.record.frontMatter).toMatchObject({ id: "notifications", version: 2, status: "accepted", accepted_by: "decision-owner", proposed_by: "decision-owner", supersedes: "notifications@1", authority: "decision-owner" });
		expect(parsed.record.frontMatter.facets["notifications.default"]).toBe("opt-in");
		// Values that YAML would read as booleans or numbers survive as strings.
		const quoted = plan({ facets: { "notifications.default": "on", "x.count": "007" } });
		if (!quoted.ok) throw new Error(quoted.message);
		expect(parseContextRecord(quoted.files["context/notifications.md"] as string)).toMatchObject({ ok: true, record: { frontMatter: { facets: { "notifications.default": "on", "x.count": "007" } } } });
		expect(result.files["decisions/0002-notifications-v2.md"]).toContain("`notifications.default`: \"on\" -> \"opt-in\"");
		expect(result.message).toContain("Idempotency-Key: key-12345678");
	});

	it("keeps the version for a prose-only edit and writes no decision", () => {
		const result = plan({ prose: "# Notifications\nA new sentence.\n" });
		if (!result.ok) throw new Error(result.message);
		expect(result).toMatchObject({ kind: "prose-edit", version: 1, decisionPath: null });
		expect(Object.keys(result.files)).toEqual(["context/notifications.md"]);
		expect(result.files["context/notifications.md"]).toContain("A new sentence.");
	});

	it("treats unchanged facets as a prose edit, and refuses a no-op", () => {
		expect(plan({ facets: { "notifications.default": "on", "notifications.cadence": "immediate", "notifications.channel": "in-app" }, prose: "# N\nnew\n" })).toMatchObject({ ok: true, kind: "prose-edit" });
		expect(plan({})).toMatchObject({ ok: false, code: "NOTHING_TO_CHANGE" });
	});

	it("can force a new version with the same facets", () => {
		expect(plan({ bumpVersion: true, prose: "# N\nbumped\n" })).toMatchObject({ ok: true, kind: "new-version", version: 2 });
	});

	it("never reuses a version the reconciler already holds", () => {
		expect(plan({ bumpVersion: true, prose: "# N\n" }, { currentVersion: 4 })).toMatchObject({ ok: true, version: 5 });
	});

	it("creates a first version and needs facets for it", () => {
		const created = plan({ recordId: "billing", facets: { "billing.currency": "usd" } }, { previous: null, currentVersion: null });
		expect(created).toMatchObject({ ok: true, kind: "first-version", version: 1, path: "context/billing.md" });
		expect(plan({ recordId: "billing" }, { previous: null, currentVersion: null })).toMatchObject({ ok: false, code: "INVALID_INPUT" });
	});

	it("fails closed on a record it cannot read", () => {
		expect(plan({ facets: { a: 1 } }, { previous: { path: "context/notifications.md", text: "not a record" } })).toMatchObject({ ok: false, code: "RECORD_UNREADABLE" });
	});

	it("builds on whatever record text it is given (the cell passes the accepted version's blob)", () => {
		const result = plan({ bumpVersion: true, prose: "# N\n" }, { previous: { path: "context/notifications.md", text: NOTIFICATIONS_V2 }, currentVersion: 2 });
		if (!result.ok) throw new Error(result.message);
		expect(result.version).toBe(3);
		expect(result.files["context/notifications.md"]).toContain("weekly-digest");
	});
});

describe("nextDecisionPath", () => {
	it("numbers after the highest existing decision", () => {
		expect(nextDecisionPath([], "x")).toBe("decisions/0001-x.md");
		expect(nextDecisionPath(["decisions/0001-a.md", "decisions/0007-b.md", "decisions/notes.md"], "x")).toBe("decisions/0008-x.md");
	});
});
