import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseContextRecord, runStubAgent } from "../../container/stub-agent-lib";

// Mirrors the Claim / ClaimsFile contract in packages/contracts (PRD section 4): subject, value, basedOn.
const ClaimsFile = z.array(
	z.strictObject({
		subject: z.string().min(1),
		value: z.union([z.string(), z.number(), z.boolean()]),
		basedOn: z.string().regex(/^[a-z0-9][a-z0-9_-]*@[1-9][0-9]*$/),
	}),
);

const notifications = `---
id: notifications
version: 1
status: accepted
authority: andrew
facets:
  notifications.default: on
  notifications.cadence: immediate
---
# Notifications
Users receive project status updates immediately.
`;

const statusModel = `---
id: status-model
version: 3
status: accepted
facets:
  status.values: "draft"
  status.max: 5
  status.flag: true
---
# Status model
`;

const input = {
	workItemId: "wi-2",
	prompt: "Implement notification preferences and delivery\nsecond line",
	contextFiles: {
		"context/notifications.md": notifications,
		"context/status-model.md": statusModel,
	},
	indexTs: 'export function greet(name: string): string {\n  return "hello, " + name;\n}\n',
};

describe("parseContextRecord", () => {
	it("reads id, version and typed facets", () => {
		expect(parseContextRecord(statusModel)).toEqual({
			id: "status-model",
			version: 3,
			facets: { "status.values": "draft", "status.max": 5, "status.flag": true },
		});
	});

	it("keeps YAML 1.2 `on` as a string", () => {
		expect(parseContextRecord(notifications)?.facets["notifications.default"]).toBe("on");
	});

	it.each([
		["no front-matter", "# just prose"],
		["no id", "---\nversion: 1\n---\n"],
		["no version", "---\nid: x\n---\n"],
		["version zero", "---\nid: x\nversion: 0\n---\n"],
		["non-integer version", "---\nid: x\nversion: 1.5\n---\n"],
	])("returns null for %s", (_n, md) => {
		expect(parseContextRecord(md)).toBeNull();
	});
});

describe("runStubAgent", () => {
	const out = runStubAgent(input);

	it("writes claims that satisfy the claims contract", () => {
		const written = JSON.parse(out.files[".delta/claims.json"] as string);
		expect(ClaimsFile.safeParse(written).success).toBe(true);
		expect(written).toEqual(out.claims);
	});

	it("cites recordId@version for every claim", () => {
		expect(out.claims.map((c) => [c.subject, c.value, c.basedOn])).toEqual([
			["notifications.cadence", "immediate", "notifications@1"],
			["notifications.default", "on", "notifications@1"],
			["status.flag", true, "status-model@3"],
			["status.max", 5, "status-model@3"],
			["status.values", "draft", "status-model@3"],
		]);
	});

	it("makes a deterministic code change", () => {
		expect(runStubAgent(input)).toEqual(out);
		const mod = out.files["src/work/wi-2.ts"] as string;
		expect(mod).toContain("work item wi-2");
		expect(mod).toContain("// Task: Implement notification preferences and delivery");
		expect(mod).toContain('export const NOTIFICATIONS_DEFAULT = "on"; // notifications@1');
		expect(out.files["src/index.ts"]).toContain('export * from "./work/wi-2";');
	});

	it("does not duplicate the export when re-run on its own output", () => {
		const again = runStubAgent({ ...input, indexTs: out.files["src/index.ts"] as string });
		expect(again.files["src/index.ts"]).toBe(out.files["src/index.ts"]);
	});

	it("is independent of file order", () => {
		const reversed = { ...input, contextFiles: Object.fromEntries(Object.entries(input.contextFiles).reverse()) };
		expect(runStubAgent(reversed)).toEqual(out);
	});

	it("emits an empty claims array, not invented claims, when there is no usable context", () => {
		const none = runStubAgent({ ...input, contextFiles: { "context/readme.md": "# prose only" } });
		expect(none.claims).toEqual([]);
		expect(JSON.parse(none.files[".delta/claims.json"] as string)).toEqual([]);
	});

	it("creates src/index.ts when the fork has none", () => {
		const fresh = runStubAgent({ ...input, indexTs: null });
		expect(fresh.files["src/index.ts"]).toBe('export * from "./work/wi-2";\n');
	});
});
