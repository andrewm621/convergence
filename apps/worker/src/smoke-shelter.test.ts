import { parseContextRecord } from "contracts";
import { describe, expect, it } from "vitest";
import { contractChecks } from "scenario-shelter-intake";
import { CONTRACT_CHECKS, runContractCheck } from "./cell/contract-checks";
import { ContextChangeRequest, planContextChange } from "./cell/context-change";
import { runtimeIdFor } from "./agents/work-item-ids";
import { POLICY_PATH, ROLES_PATH, SHELTER_WORK_ITEMS, buildShelterSeed, shelterAgentsMd } from "./smoke-shelter";

describe("the seed for the live shelter act", () => {
	const seed = buildShelterSeed();

	it("holds the policy and the roles at v1, accepted by the demo identity that is their authority", () => {
		expect(Object.keys(seed.baselineFiles).sort()).toEqual(["AGENTS.md", ROLES_PATH, POLICY_PATH].sort());
		for (const [path, id] of [[POLICY_PATH, "shelter-intake-policy"], [ROLES_PATH, "volunteer-roles"]] as const) {
			const parsed = parseContextRecord(seed.baselineFiles[path] as string);
			if (!parsed.ok) throw new Error(`${path}: ${parsed.error}`);
			const fm = parsed.record.frontMatter;
			expect(fm.id).toBe(id);
			expect(fm.version).toBe(1);
			expect(fm.authority).toBe("decision-owner");
			expect(fm.accepted_by).toBe("decision-owner");
			expect(seed.policy.authority[id]).toBe("decision-owner");
		}
		const policy = parseContextRecord(seed.baselineFiles[POLICY_PATH] as string);
		expect(policy.ok && policy.record.frontMatter.validation).toBe("checks/shelter-intake.check");
	});

	it("has the check the Worker runs for that record", () => {
		expect(Object.keys(contractChecks)).toContain("checks/shelter-intake.check");
		expect(CONTRACT_CHECKS["checks/shelter-intake.check"]).toBeDefined();
	});

	it("registers two items on different documents, one relying on a facet the change moves and one that does not", () => {
		expect(seed.workItems.map((w) => w.id)).toEqual(["SH-1", "SH-2"]);
		const changed = Object.keys(seed.contextChange.not);
		const facetsOf = (id: string) => SHELTER_WORK_ITEMS.find((w) => w.id === id)?.dependencies.flatMap((d) => d.facetKeys) ?? [];
		expect(changed.sort()).toEqual(["id_required", "pets"]);
		expect(facetsOf("SH-1").some((k) => changed.includes(k))).toBe(true);
		expect(facetsOf("SH-2").some((k) => changed.includes(k))).toBe(false);
		expect(new Set(seed.workItems.map((w) => w.path)).size).toBe(2);
		// The stale document is a different file from the record that changed.
		for (const w of seed.workItems) expect(w.path).not.toBe(POLICY_PATH);
	});

	it("uses work item ids whose runtime ids do not collide with the notifications act (WI-1, WI-2), so the acts never share a sandbox", () => {
		const runtime = seed.workItems.map((w) => {
			const r = runtimeIdFor(w.id);
			if (!r.ok) throw new Error(r.error);
			return r.id;
		});
		expect(runtime).toEqual(["sh-1", "sh-2"]);
		for (const id of runtime) expect(["wi-1", "wi-2"]).not.toContain(id);
	});

	it("keeps the green item free of an initial test requirement, because a first push gets no Worker-run evidence", () => {
		expect(SHELTER_WORK_ITEMS.find((w) => w.id === "SH-1")?.requires).toEqual(["contract-test"]);
		expect(SHELTER_WORK_ITEMS.find((w) => w.id === "SH-2")?.requires).toEqual([]);
	});

	it("reads only paths the contract check reads", () => {
		const check = contractChecks["checks/shelter-intake.check"]!;
		for (const w of seed.workItems) expect(check.reads(w.path), w.path).toBe(true);
		expect(check.reads(POLICY_PATH)).toBe(false);
	});

	it("tells the agent, in AGENTS.md, which file each task writes and which facets it relies on", () => {
		const text = seed.baselineFiles["AGENTS.md"] as string;
		expect(text).toBe(shelterAgentsMd());
		for (const w of seed.workItems) {
			expect(text).toContain(`| ${w.title} | \`${w.path}\` |`);
			for (const d of w.dependencies) for (const k of d.facetKeys) expect(text).toContain(`\`${k}\``);
			expect(w.prompt.startsWith(w.title)).toBe(true);
			expect(w.prompt).toContain(w.path);
		}
		expect(text).toContain("Synthetic scenario. Not operational guidance.");
	});

	it("plans as a normal new version of the policy by the demo identity, with every facet kept", async () => {
		const request = ContextChangeRequest.parse({ ...seed.contextChange });
		const plan = planContextChange({
			request,
			actor: { kind: "human", id: "decision-owner", displayName: "Decision owner (demo identity)" },
			now: "2026-10-14T16:00:00Z",
			idempotencyKey: "k",
			previous: { path: POLICY_PATH, text: seed.baselineFiles[POLICY_PATH] as string },
			currentVersion: 1,
			existingPaths: [],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan).toMatchObject({ kind: "new-version", version: 2, path: POLICY_PATH });
		const parsed = parseContextRecord(plan.files[POLICY_PATH] as string);
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.record.frontMatter.facets).toEqual({
			pets: "crated pets admitted, pet area in Hall B",
			id_required: "ID not listed as a requirement",
			capacity_note: "Hall A holds 120 cots; the shift lead decides on overflow",
			hours: "doors open 7:00 to 21:00 daily",
		});
		expect(parsed.record.frontMatter.accepted_by).toBe("decision-owner");
	});

	it("names no real place, person or account (synthetic orgs only)", () => {
		const text = JSON.stringify(seed);
		expect(text).toContain("Larkhaven");
		expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
		expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
	});
});

describe("the shelter contract check on what the live agents write", () => {
	const tree = (files: Record<string, string>) => new Map(Object.keys(files).map((p) => [p, { hash: `h-${p}`, mode: "100644" }]));
	const port = (files: Record<string, string>) => ({ readBlob: async (_repo: string, hash: string) => files[hash.slice(2)] ?? null }) as never;
	const facetsV2 = { pets: "crated pets admitted, pet area in Hall B", id_required: "ID not listed as a requirement", capacity_note: "Hall A holds 120 cots; the shift lead decides on overflow", hours: "doors open 7:00 to 21:00 daily" };
	const run = (files: Record<string, string>, required: string[]) =>
		runContractCheck(port(files), { repo: "r", sha: "a".repeat(40), tree: tree(files) as never, check: "checks/shelter-intake.check", facets: facetsV2, required });

	it("fails a script written against v1 and passes the same script rewritten against v2", async () => {
		const v1 = "# Front-desk intake script\n\n1. Intake: ID required.\n2. Pets: service animals only.\n";
		const v2 = "# Front-desk intake script\n\n1. Intake: ID is not listed as a requirement.\n2. Pets: crated pets are included; the pet area is in Hall B.\n";
		expect((await run({ "scripts/front-desk.md": v1 }, ["pets", "id_required"]))?.pass).toBe(false);
		expect((await run({ "scripts/front-desk.md": v2 }, ["pets", "id_required"]))?.pass).toBe(true);
	});

	it("passes a supply list that never touches pets or ID, whatever version the policy is at", async () => {
		const supplies = "# Supply list: cots and blankets\n\n- 120 cots for Hall A.\n- One blanket per cot.\n";
		expect((await run({ "supplies/cots-and-blankets.md": supplies }, ["capacity_note"]))?.pass).toBe(true);
	});
});
