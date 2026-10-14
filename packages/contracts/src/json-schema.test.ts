import { describe, expect, it } from "vitest";
import { SCHEMA_ENTRIES, generateSchemaFiles } from "./json-schema";
import * as contracts from "./index";
import { parseContextRecord } from "./record-parser";

const RECORD = `---
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
not:
  notifications.default: "on"
---
# Notifications
`;

// contracts has no Node typings, so the directory listing goes through a dynamic import typed by hand.
const { readdirSync } = (await import(/* @vite-ignore */ "node:fs" as string)) as { readdirSync(path: URL): string[] };
const committed = readdirSync(new URL("../schema/", import.meta.url)).filter((name) => name.endsWith(".json"));

/**
 * The files in packages/contracts/schema/ are generated from the Zod contracts. This test regenerates them in
 * memory and fails if a committed file differs, if one is missing, or if a stale one is left behind.
 * To refresh them after changing a contract, run `pnpm --filter contracts schema` (vitest's `-u`).
 */
describe("JSON Schemas match the Zod contracts", () => {
	const generated = generateSchemaFiles();

	it("has one committed file per generated schema, and no others", () => {
		expect([...committed].sort()).toEqual(Object.keys(generated).sort());
	});

	for (const [name, text] of Object.entries(generated)) {
		it(`${name} is up to date`, async () => {
			await expect(text).toMatchFileSnapshot(`../schema/${name}`);
		});
	}

	it("every schema is closed (strict objects) and names a draft", () => {
		for (const text of Object.values(generated)) {
			const schema = JSON.parse(text) as Record<string, unknown>;
			expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
			expect(schema["title"]).toEqual(expect.any(String));
		}
		const frontMatter = JSON.parse(generated["context-record-front-matter.json"] as string) as { additionalProperties?: unknown };
		expect(frontMatter.additionalProperties).toBe(false);
	});

	it("generator entries cover the exported wire schemas they claim to", () => {
		const exported = new Set<unknown>(Object.values(contracts));
		for (const entry of SCHEMA_ENTRIES) expect(exported.has(entry.schema)).toBe(true);
	});

	it("the record front-matter schema lists the keys the parser accepts", () => {
		const parsed = parseContextRecord(RECORD);
		if (!parsed.ok) throw new Error(parsed.error);
		const schema = JSON.parse(generated["context-record-front-matter.json"] as string) as { properties: Record<string, unknown>; required: string[] };
		for (const key of Object.keys(parsed.record.frontMatter)) expect(Object.keys(schema.properties)).toContain(key);
		expect(schema.required).toEqual(expect.arrayContaining(["id", "version", "status", "authority", "proposed_by", "facets"]));
	});
});
