import { describe, expect, it } from "vitest";
import { buildRevalidationReceipt } from "../../container/receipt-lib";
import { checkRevalidationContext, DispatchError } from "./dispatch";
import { runStubAgent } from "../../container/stub-agent-lib";

const v2 = `---
id: notifications
version: 2
status: accepted
facets:
  notifications.default: opt-in
  notifications.cadence: weekly-digest
---
# Notifications
`;
const changes = [{ recordId: "notifications", fromVersion: 1, toVersion: 2 }];

describe("buildRevalidationReceipt", () => {
	it("lists what was delivered with a content hash, in name order", async () => {
		const receipt = await buildRevalidationReceipt({
			workItemId: "wi-2",
			baseCommit: "a".repeat(40),
			changes,
			contextFiles: { "z.md": "---\nid: z\nversion: 1\n---\n", "notifications.md": v2, "prose.md": "# no front-matter" },
		});
		expect(receipt.kind).toBe("revalidation");
		expect(receipt.delivered.map((d) => [d.file, d.recordId, d.version])).toEqual([
			["notifications.md", "notifications", 2],
			["z.md", "z", 1],
		]);
		expect(receipt.delivered[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(receipt.changes).toEqual(changes);
	});

	it("is deterministic", async () => {
		const input = { workItemId: "wi-2", baseCommit: "a".repeat(40), changes, contextFiles: { "notifications.md": v2 } };
		expect(await buildRevalidationReceipt(input)).toEqual(await buildRevalidationReceipt(input));
	});
});

describe("revalidation through the stub agent", () => {
	it("re-claims against the new version and values", () => {
		const out = runStubAgent({
			workItemId: "wi-2",
			prompt: "REVALIDATION: notifications changed from v1 to v2.",
			contextFiles: { "context/notifications.md": v2 },
			indexTs: 'export * from "./work/wi-2";\n',
		});
		expect(out.claims).toEqual([
			{ subject: "notifications.cadence", value: "weekly-digest", basedOn: "notifications@2" },
			{ subject: "notifications.default", value: "opt-in", basedOn: "notifications@2" },
		]);
		expect(out.files["src/index.ts"]).toBe('export * from "./work/wi-2";\n');
	});
});

describe("checkRevalidationContext", () => {
	it("passes when the context carries the claimed new version", () => {
		expect(() => checkRevalidationContext({ changes, context: { "notifications.md": v2 } })).not.toThrow();
	});

	it.each([
		["a stale version", { "notifications.md": v2.replace("version: 2", "version: 1") }, "CONTEXT_MISMATCH"],
		["a missing record", { "other.md": "---\nid: other\nversion: 2\n---\n" }, "CONTEXT_MISMATCH"],
		["a file that is not a record", { "notifications.md": "# prose" }, "CONTEXT_INVALID"],
	])("rejects %s", (_n, context, code) => {
		try {
			checkRevalidationContext({ changes, context });
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(DispatchError);
			expect((e as DispatchError).code).toBe(code);
		}
	});
});
