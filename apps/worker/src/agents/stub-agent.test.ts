import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaimsFile as ContractClaimsFile } from "contracts";
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
};

describe("parseContextRecord", () => {
	it("reads id, version and typed facets", () => {
		expect(parseContextRecord(statusModel)).toEqual({
			id: "status-model",
			version: 3,
			facets: { "status.values": "draft", "status.max": 5, "status.flag": true },
		});
	});

	it("reads the quoted facet keys and values the Worker writes into a record", () => {
		const written = '---\nid: notifications\nversion: 2\nauthority: "decision-owner"\nfacets:\n  "notifications.cadence": "weekly-digest"\n  "notifications.default": "opt-in"\nnot:\n  "notifications.default": "on"\n---\n# Notifications\n';
		expect(parseContextRecord(written)).toEqual({ id: "notifications", version: 2, facets: { "notifications.cadence": "weekly-digest", "notifications.default": "opt-in" } });
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

	it("cites recordId@version for every claim, for the records the task is about", () => {
		expect(out.claims.map((c) => [c.subject, c.value, c.basedOn])).toEqual([
			["notifications.cadence", "immediate", "notifications@1"],
			["notifications.default", "on", "notifications@1"],
		]);
	});

	it("claims a record the prompt names by its id or its first word, and not the others", () => {
		const status = runStubAgent({ ...input, prompt: "Add status badges and the status-change API" });
		expect(new Set(status.claims.map((c) => c.basedOn))).toEqual(new Set(["status-model@3"]));
		const named = runStubAgent({ ...input, prompt: "Review notifications and status-model together" });
		expect(new Set(named.claims.map((c) => c.basedOn))).toEqual(new Set(["notifications@1", "status-model@3"]));
	});

	it("claims every record when the prompt names none of them", () => {
		const all = runStubAgent({ ...input, prompt: "Tidy the build" });
		expect(new Set(all.claims.map((c) => c.basedOn))).toEqual(new Set(["notifications@1", "status-model@3"]));
	});

	it("reads a flow list facet as an array of scalars, as the record parser does", () => {
		const record = parseContextRecord("---\nid: status-model\nversion: 1\nfacets:\n  status.values: [draft, active, blocked, done]\n  status.none: []\n---\n");
		expect(record?.facets).toEqual({ "status.values": ["draft", "active", "blocked", "done"], "status.none": [] });
		const out2 = runStubAgent({ ...input, prompt: "status", contextFiles: { "context/s.md": "---\nid: status-model\nversion: 1\nfacets:\n  status.values: [draft, active]\n---\n" } });
		expect(out2.claims).toEqual([{ subject: "status.values", value: ["draft", "active"], basedOn: "status-model@1" }]);
		expect(ContractClaimsFile.safeParse(JSON.parse(out2.files[".delta/claims.json"] as string)).success).toBe(true);
	});

	it("makes a deterministic code change", () => {
		expect(runStubAgent(input)).toEqual(out);
		const mod = out.files["src/work/wi-2.ts"] as string;
		expect(mod).toContain("work item wi-2");
		expect(mod).toContain("// Task: Implement notification preferences and delivery");
		expect(mod).toContain('export const NOTIFICATIONS_DEFAULT = "on"; // notifications@1');
		expect(Object.keys(out.files).sort()).toEqual([".delta/claims.json", "src/work/wi-2.ts"]);
	});

	it("shares no file with another work item except its own claims: no barrel to conflict on", () => {
		const one = runStubAgent({ ...input, workItemId: "wi-1", prompt: "Add status badges" });
		const two = runStubAgent({ ...input, workItemId: "wi-2" });
		expect(Object.keys(one.files).filter((path) => path in two.files)).toEqual([".delta/claims.json"]);
		expect(Object.keys(two.files)).not.toContain("src/index.ts");
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

	it("with a receipt (deliveredIds) it covers every facet of exactly the delivered records, whatever the title says", () => {
		const titleOnly = runStubAgent({ ...input, prompt: "Notification delivery" });
		expect(titleOnly.claims.every((c) => c.basedOn.startsWith("notifications@"))).toBe(true);
		const delivered = runStubAgent({ ...input, prompt: "Notification delivery", deliveredIds: ["notifications", "status-model"] });
		expect(new Set(delivered.claims.map((c) => c.basedOn.split("@")[0]))).toEqual(new Set(["notifications", "status-model"]));
		expect(delivered.files["src/work/wi-2.ts"]).toContain("export const STATUS_VALUES =");
		const only = runStubAgent({ ...input, prompt: "Notification delivery", deliveredIds: ["status-model"] });
		expect(only.claims.every((c) => c.basedOn.startsWith("status-model@"))).toBe(true);
		expect(runStubAgent({ ...input, deliveredIds: [] }).claims).toEqual([]);
	});
});
