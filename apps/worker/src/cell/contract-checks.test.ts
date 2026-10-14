import { describe, expect, it } from "vitest";
import type { ContractCheck } from "contracts";
import { NOTIFICATIONS_V1, NOTIFICATIONS_V2, STATUS_MODEL_V1, buildNotificationsScenario } from "scenario-notifications";
import { BRIEFING_PATH, BRIEFING_V1, BRIEFING_V2, SCRIPT_PATH, SCRIPT_V1, SCRIPT_V2, buildShelterIntakeScenario } from "scenario-shelter-intake";
import { runStubAgent } from "../../container/stub-agent-lib";
import type { FlatTree } from "../artifacts/tree-diff";
import type { ArtifactsPort } from "./ports";
import { CONTRACT_CHECKS, runContractCheck } from "./contract-checks";

// Rule R8: the Worker runs each record's contract check on the files a pushed head holds. These tests give the
// runner a tiny repo (path -> text, blob id = the path) and look at what it decides and what it says. `required`
// is what the work item relied on; the checks assert exactly that.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOTIFICATIONS_CHECK = "tests/contract/notifications.test.ts";
const STATUS_CHECK = "tests/contract/status-model.test.ts";

function repoOf(files: Record<string, string>): { port: ArtifactsPort; tree: FlatTree; reads: string[] } {
	const reads: string[] = [];
	const tree: FlatTree = new Map(Object.keys(files).map((path) => [path, { hash: `blob:${path}`, mode: "100644" }]));
	const port = {
		readBlob: async (_repo: string, oid: string) => {
			reads.push(oid);
			return files[oid.replace(/^blob:/, "")] ?? null;
		},
	} as unknown as ArtifactsPort;
	return { port, tree, reads };
}

const V2 = { "notifications.default": "opt-in", "notifications.cadence": "weekly-digest", "notifications.channel": "in-app" };
const WI2_NOTIFICATIONS = ["notifications.cadence", "notifications.default"];

/** What the stub agent pushes when handed these context files (and, as in a revalidation, told which records were delivered). */
function stubPush(context: Record<string, string>, workItemId = "wi-2", prompt = "Notification delivery"): Record<string, string> {
	const contextFiles = Object.fromEntries(Object.entries(context).map(([name, text]) => [`.delta/context/${name}`, text]));
	return runStubAgent({ workItemId, prompt, contextFiles, deliveredIds: ["notifications", "status-model"].filter((id) => `${id}.md` in context) }).files;
}

describe("the Worker-run contract checks (R8)", () => {
	it("[positive] the stub agent's revalidated push (v2 context) passes the notifications check, naming the file, the sha and what it asserted", async () => {
		const files = stubPush({ "notifications.md": NOTIFICATIONS_V2, "status-model.md": STATUS_MODEL_V1 });
		const { port, tree } = repoOf(files);
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS });
		expect(result?.pass).toBe(true);
		expect(result?.output).toContain(`Convergence contract check ${NOTIFICATIONS_CHECK} at ${SHA.slice(0, 7)}`);
		expect(result?.output).toContain("src/work/wi-2.ts");
		expect(result?.output).toContain("asserting notifications.cadence, notifications.default");
		expect(result?.output).toContain('notifications.default = "opt-in" as accepted');
		expect(result?.output).toContain('notifications.cadence = "weekly-digest" as accepted');
	});

	it("[positive] the stub, covering every record the receipt delivered, declares the status facets WI-2 relies on, so the status-model check really passes", async () => {
		const n = await buildNotificationsScenario();
		const files = stubPush({ "notifications.md": NOTIFICATIONS_V2, "status-model.md": STATUS_MODEL_V1 });
		expect(files["src/work/wi-2.ts"]).toContain("export const STATUS_VALUES =");
		const { port, tree } = repoOf(files);
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: STATUS_CHECK, facets: n.docs.statusModelV1.snapshot.facets, required: ["status.values"] });
		expect(result?.pass).toBe(true);
		expect(result?.output).toContain("asserting status.values");
		expect(result?.output).toMatch(/src\/work\/wi-2\.ts: status\.values = \[.*\] as accepted/);
	});

	it("a run check with no declared required facet fails", async () => {
		// The old stub (scoped by the task title) pushed no STATUS_* constants for WI-2. That must not pass the status-model check.
		const n = await buildNotificationsScenario();
		const facets = n.docs.statusModelV1.snapshot.facets;
		const titleScoped = runStubAgent({ workItemId: "wi-2", prompt: "Notification delivery", contextFiles: { ".delta/context/notifications.md": NOTIFICATIONS_V2, ".delta/context/status-model.md": STATUS_MODEL_V1 } }).files;
		expect(titleScoped["src/work/wi-2.ts"]).not.toContain("STATUS_VALUES");
		const { port, tree } = repoOf(titleScoped);
		const declared = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: STATUS_CHECK, facets, required: ["status.values"] });
		expect(declared?.pass).toBe(false);
		expect(declared?.output).toContain("status.values is not declared in the code");
		// And a check handed nothing to assert fails closed rather than passing for having matched zero facets.
		for (const check of [STATUS_CHECK, NOTIFICATIONS_CHECK]) {
			const none = await runContractCheck(port, { repo: "r", sha: SHA, tree, check, facets, required: [] });
			expect(none?.pass, check).toBe(false);
			expect(none?.output).toMatch(/nothing to assert/);
		}
	});

	it("[negative] a push that still encodes v1 fails with the check's real name and the value that differs", async () => {
		const files = { "src/work/wi-2.ts": 'export const NOTIFICATIONS_DEFAULT = "on"; // notifications@1\nexport const NOTIFICATIONS_CADENCE = "immediate"; // notifications@1\n', "src/index.ts": "export {};\n" };
		const { port, tree } = repoOf(files);
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS });
		expect(result?.pass).toBe(false);
		expect(result?.output).toContain(`Convergence contract check ${NOTIFICATIONS_CHECK}`);
		expect(result?.output).toContain('src/work/wi-2.ts: notifications.default = "on", accepted is "opt-in"');
	});

	it("[negative] a push that never declares a required facet fails, rather than passing for lack of anything to assert", async () => {
		const { port, tree } = repoOf({ "src/index.ts": "export {};\n" });
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS });
		expect(result?.pass).toBe(false);
		expect(result?.output).toContain("notifications.default is not declared in the code");
		expect(result?.output).toContain("notifications.cadence is not declared in the code");
	});

	it("[boundary] only the facets the item relied on are asserted: another facet's value in the code is not the check's business", async () => {
		const files = { "src/work/wi-2.ts": 'export const NOTIFICATIONS_DEFAULT = "opt-in";\nexport const NOTIFICATIONS_CHANNEL = "email";\n' };
		const { port, tree } = repoOf(files);
		const relied = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: ["notifications.default"] });
		expect(relied?.pass).toBe(true);
		const channel = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: ["notifications.channel"] });
		expect(channel?.pass).toBe(false);
		// A key that is not an accepted facet of the record cannot be asserted.
		const unknown = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: ["notifications.nope"] });
		expect(unknown?.pass).toBe(false);
		expect(unknown?.output).toContain("notifications.nope is not an accepted facet");
	});

	it("[negative] the agent's own claims file and the context it was handed are never read, so they cannot satisfy the check", async () => {
		const files = {
			".delta/claims.json": JSON.stringify([{ subject: "notifications.default", value: "opt-in", basedOn: "notifications@2" }]),
			".delta/context/notifications.md": NOTIFICATIONS_V2,
			"src/index.ts": "export {};\n",
		};
		const { port, tree, reads } = repoOf(files);
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS });
		expect(result?.pass).toBe(false);
		expect(reads).toEqual(["blob:src/index.ts"]);
	});

	it("[negative] a v1 constant beside a v2 one still fails (any declaration that differs fails)", async () => {
		const files = { "src/a.ts": 'export const NOTIFICATIONS_DEFAULT = "opt-in";\nexport const NOTIFICATIONS_CADENCE = "weekly-digest";\n', "src/b.ts": 'export const NOTIFICATIONS_DEFAULT = "on";\n' };
		const { port, tree } = repoOf(files);
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS });
		expect(result?.pass).toBe(false);
		expect(result?.output).toContain('src/b.ts: notifications.default = "on"');
	});

	it("[boundary] a check that is not registered returns null so the Worker records no evidence for it", async () => {
		const { port, tree } = repoOf({ "src/index.ts": "" });
		expect(await runContractCheck(port, { repo: "r", sha: SHA, tree, check: "checks/qualified-lead-criteria.check", facets: {}, required: [] })).toBeNull();
		expect(await runContractCheck(port, { repo: "r", sha: SHA, tree, check: "constructor", facets: {}, required: [] })).toBeNull();
		expect(await runContractCheck(port, { repo: "r", sha: SHA, tree, check: "__proto__", facets: {}, required: [] })).toBeNull();
	});

	it("[boundary] fails closed on too many files and on a file that is too large, and throws when a file cannot be read", async () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 41; i++) many[`src/f${i}.ts`] = "export {};\n";
		const a = repoOf(many);
		expect((await runContractCheck(a.port, { repo: "r", sha: SHA, tree: a.tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS }))?.output).toMatch(/failed closed: 41 files/);
		const big = repoOf({ "src/big.ts": "x".repeat(200_001) });
		const bigResult = await runContractCheck(big.port, { repo: "r", sha: SHA, tree: big.tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS });
		expect(bigResult).toMatchObject({ pass: false });
		expect(bigResult?.output).toMatch(/failed closed: src\/big\.ts is larger/);
		const missing = repoOf({ "src/a.ts": "x" });
		missing.tree.set("src/gone.ts", { hash: "blob:nowhere", mode: "100644" });
		await expect(runContractCheck(missing.port, { repo: "r", sha: SHA, tree: missing.tree, check: NOTIFICATIONS_CHECK, facets: V2, required: WI2_NOTIFICATIONS })).rejects.toThrow(/cannot read src\/gone\.ts/);
	});

	it("[boundary] a long output is cut at about 4 KB with a visible marker, and a short one is left alone", async () => {
		const facets: Record<string, string> = {};
		const files: Record<string, string> = {};
		for (let i = 0; i < 30; i++) {
			facets[`notifications.facet${i}`] = `value-${i}`;
			files[`src/f${i}.ts`] = `export const NOTIFICATIONS_FACET${i} = "wrong-${"x".repeat(150)}";\n`;
		}
		const { port, tree } = repoOf(files);
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets, required: Object.keys(facets) });
		expect(result?.pass).toBe(false);
		expect(result?.output.length).toBeLessThanOrEqual(4096);
		expect(result?.output.endsWith("… (truncated)")).toBe(true);
		const short = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets, required: ["notifications.facet0"] });
		expect(short?.output.endsWith("… (truncated)")).toBe(false);
	});

	it("[positive] the v1 context delivers v1 values and a v1 push passes against v1 facets (the check follows the accepted facets, not a fixed answer)", async () => {
		const n = await buildNotificationsScenario();
		const files = stubPush({ "notifications.md": NOTIFICATIONS_V1, "status-model.md": STATUS_MODEL_V1 });
		const { port, tree } = repoOf(files);
		const v1 = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: n.docs.notificationsV1.snapshot.facets, required: WI2_NOTIFICATIONS });
		expect(v1?.pass).toBe(true);
		const againstV2 = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: NOTIFICATIONS_CHECK, facets: n.docs.notificationsV2.snapshot.facets, required: WI2_NOTIFICATIONS });
		expect(againstV2?.pass).toBe(false);
	});

	it("the shelter-intake check runs on the scenario documents of the push: v2 documents pass, the v1 front-desk script fails against the v2 policy", async () => {
		const s = await buildShelterIntakeScenario();
		const facets = s.docs.policyV2.snapshot.facets;
		const required = Object.keys(facets);
		const check = Object.keys(CONTRACT_CHECKS).find((k) => k.includes("shelter-intake")) as string;
		expect(check).toBeTruthy();
		const good = repoOf({ [SCRIPT_PATH]: SCRIPT_V2, [BRIEFING_PATH]: BRIEFING_V2, "README.md": "ignored" });
		expect((await runContractCheck(good.port, { repo: "r", sha: SHA, tree: good.tree, check, facets, required }))?.pass).toBe(true);
		const bad = repoOf({ [SCRIPT_PATH]: SCRIPT_V1, [BRIEFING_PATH]: BRIEFING_V1 });
		const failed = await runContractCheck(bad.port, { repo: "r", sha: SHA, tree: bad.tree, check, facets, required });
		expect(failed?.pass).toBe(false);
		expect(failed?.output).toContain(`${SCRIPT_PATH}:`);
		const none = repoOf({ "README.md": "nothing" });
		expect((await runContractCheck(none.port, { repo: "r", sha: SHA, tree: none.tree, check, facets, required }))?.pass).toBe(false);
		// An item that relies on none of the policy has nothing to be checked against: fail closed here too.
		expect((await runContractCheck(good.port, { repo: "r", sha: SHA, tree: good.tree, check, facets, required: [] }))?.pass).toBe(false);
	});

	it("registers nothing for sales-ops, on purpose", () => {
		expect(Object.keys(CONTRACT_CHECKS).sort()).toEqual(expect.not.arrayContaining(["checks/qualified-lead-criteria.check", "checks/sales-activity-glossary.check"]));
	});

	it("honours a registry passed in (the unit seam), for a check that reads nothing", async () => {
		const empty: Record<string, ContractCheck> = { "x.check": { reads: () => false, run: (files) => ({ pass: Object.keys(files).length === 0, output: "saw no files" }) } };
		const { port, tree } = repoOf({ "src/a.ts": "x" });
		const result = await runContractCheck(port, { repo: "r", sha: SHA, tree, check: "x.check", facets: {}, required: [] }, empty);
		expect(result).toEqual({ pass: true, output: `Convergence contract check x.check at ${SHA.slice(0, 7)}, reading no files: saw no files` });
	});
});
