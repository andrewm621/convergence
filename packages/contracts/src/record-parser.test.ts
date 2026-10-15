import { describe, expect, it } from "vitest";
import { parseContextRecord, toRecordSnapshot } from "./record-parser";

const GOOD = `---
id: notifications
version: 2
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T16:00:00Z
supersedes: notifications@1
validation: tests/contract/notifications.test.ts
decision: decisions/0002-notifications-opt-in.md
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
not:
  notifications.default: on
---
# Notifications
Users opt in.
`;

function withFrontMatter(yaml: string): string {
	return `---\n${yaml}\n---\nbody\n`;
}

const MINIMAL = `id: ctx
version: 1
status: accepted
authority: decision-owner
proposed_by: decision-owner
accepted_by: decision-owner
accepted_at: 2026-10-13T16:00:00Z
facets:
  a.b: 1`;

describe("parseContextRecord", () => {
	it("parses a valid record, keeping YAML 1.2 strings as strings", () => {
		const result = parseContextRecord(GOOD);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.frontMatter.facets).toEqual({ "notifications.default": "opt-in", "notifications.cadence": "weekly-digest" });
		expect(result.record.frontMatter.accepted_at).toBe("2026-10-13T16:00:00Z");
		expect(result.record.body).toContain("# Notifications");
	});

	it("keeps `on`/`yes` as strings rather than YAML 1.1 booleans", () => {
		const result = parseContextRecord(withFrontMatter(MINIMAL.replace("a.b: 1", "a.b: on")));
		expect(result.ok && result.record.frontMatter.facets["a.b"]).toBe("on");
	});

	it("tolerates CRLF line endings", () => {
		expect(parseContextRecord(GOOD.replace(/\n/g, "\r\n")).ok).toBe(true);
	});

	it.each([
		["no opening fence", "id: x\nversion: 1\n"],
		["no closing fence", "---\nid: x\nversion: 1\n"],
		["empty", ""],
		["bad YAML", withFrontMatter("id: [unclosed")],
		["duplicate keys", withFrontMatter(`${MINIMAL}\nversion: 2`)],
		["unknown key", withFrontMatter(`${MINIMAL}\nsurprise: true`)],
		["accepted without accepted_by", withFrontMatter(MINIMAL.replace("accepted_by: decision-owner\n", ""))],
		["version zero", withFrontMatter(MINIMAL.replace("version: 1", "version: 0"))],
		["version as string", withFrontMatter(MINIMAL.replace("version: 1", 'version: "1"'))],
		["bad status", withFrontMatter(MINIMAL.replace("status: accepted", "status: maybe"))],
		["nested facet value", withFrontMatter(`${MINIMAL.replace("a.b: 1", "a.b:\n    deep: 1")}`)],
		["supersedes a different record", withFrontMatter(`${MINIMAL.replace("version: 1", "version: 2")}\nsupersedes: other@1`)],
		["supersedes a later version", withFrontMatter(`${MINIMAL}\nsupersedes: ctx@1`)],
		["`not` names an unknown facet", withFrontMatter(`${MINIMAL}\nnot:\n  zzz: 1`)],
		["alias expansion", withFrontMatter(`${MINIMAL.replace("a.b: 1", "a.b: &x 1\n  c.d: *x")}`)],
		["front-matter is a list", withFrontMatter("- a\n- b")],
	])("rejects (fail closed): %s", (_name, text) => {
		const result = parseContextRecord(text);
		expect(result.ok).toBe(false);
	});
});

describe("toRecordSnapshot", () => {
	it("hashes facets only: a prose edit changes blobHash but not facetHash", async () => {
		const a = await toRecordSnapshot(GOOD);
		const b = await toRecordSnapshot(GOOD.replace("Users opt in.", "Users opt-in."));
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.snapshot.blobHash).not.toBe(b.snapshot.blobHash);
		expect(a.snapshot.facetHash).toBe(b.snapshot.facetHash);
		expect(a.snapshot.not).toEqual({ "notifications.default": ["on"] });
	});

	it("changes facetHash when a facet changes", async () => {
		const a = await toRecordSnapshot(GOOD);
		const b = await toRecordSnapshot(GOOD.replace("weekly-digest", "daily-digest"));
		expect(a.ok && b.ok && a.snapshot.facetHash !== b.snapshot.facetHash).toBe(true);
	});

	it("propagates parse failures", async () => {
		expect((await toRecordSnapshot("nope")).ok).toBe(false);
	});
});

describe("`why` (the decision's rationale)", () => {
	const WITH_WHY = GOOD.replace("facets:", 'why: "Opt-in only, after the consent complaints."\nfacets:');

	it("parses `why` and carries it onto the snapshot without touching any hash", async () => {
		const plain = await toRecordSnapshot(GOOD);
		const withWhy = await toRecordSnapshot(WITH_WHY);
		if (!plain.ok || !withWhy.ok) throw new Error("unreachable");
		expect(withWhy.snapshot.why).toBe("Opt-in only, after the consent complaints.");
		expect(withWhy.snapshot.facetHash).toBe(plain.snapshot.facetHash);
		// Records without `why` produce exactly the snapshot they always did: the key is absent, not null.
		expect("why" in plain.snapshot).toBe(false);
	});

	it("rejects an empty or non-string `why`", () => {
		expect(parseContextRecord(GOOD.replace("facets:", 'why: ""\nfacets:')).ok).toBe(false);
		expect(parseContextRecord(GOOD.replace("facets:", "why: 3\nfacets:")).ok).toBe(false);
	});
});
