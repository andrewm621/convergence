import { describe, expect, it } from "vitest";
import { NOTIFICATIONS_V1, NOTIFICATIONS_V2, STATUS_MODEL_V1 } from "scenario-notifications";
import { ContextReader } from "./context-tree";
import { observeBaselineCommit, observeForkCommit, WORKER_COMMITTER, type ObserveDeps, type WrittenCommit } from "./observe";
import { FakeWorld } from "./testing/fake-artifacts";

// The trust boundary at the poller: which baseline commits may become an accepted context version.
// A commit counts only if the Worker wrote it, as the record's authority. Author names are text
// anyone with a write token can set, and a record file's own `accepted_by` / `authority` is
// agent-writable text, so neither grants anything by itself.

const AUTHORITY = "decision-owner";
const BASE = { "context/notifications.md": NOTIFICATIONS_V1, "context/status-model.md": STATUS_MODEL_V1 };

async function setup() {
	const world = new FakeWorld();
	await world.create("base", BASE);
	const written = new Map<string, WrittenCommit>();
	const deps: ObserveDeps = {
		port: world.port(),
		reader: new ContextReader(world.port()),
		now: () => "2026-10-13T16:00:00Z",
		trees: new Map(),
		authorityOf: () => AUTHORITY,
		written: (sha) => written.get(sha) ?? null,
	};
	const head = async (repo = "base") => (await world.port().log(repo, { limit: 1 }))[0]!;
	return { world, deps, written, head };
}

async function observed(deps: ObserveDeps, commit: Awaited<ReturnType<typeof setup>>["head"] extends () => Promise<infer C> ? C : never) {
	const { event, recordPaths } = await observeBaselineCommit(deps, "base", commit);
	if (event.type !== "BaselinePushed") throw new Error("expected BaselinePushed");
	return { event, recordPaths };
}

describe("baseline commits: only the Worker, as the authority, can accept context", () => {
	it("accepts a context change the Worker wrote as the authority", async () => {
		const { world, deps, written, head } = await setup();
		const sha = await world.push("base", { "context/notifications.md": NOTIFICATIONS_V2 }, { author: AUTHORITY, committer: WORKER_COMMITTER });
		written.set(sha, { kind: "context", actor: AUTHORITY });
		const { event, recordPaths } = await observed(deps, await head());
		expect(event.records.map((r) => `${r.recordId}@${r.version}`)).toEqual(["notifications@2"]);
		expect(event.invalid).toEqual([]);
		expect(recordPaths).toEqual({ notifications: "context/notifications.md" });
	});

	it("rejects a commit that merely names the authority as its author: nobody proved the Worker wrote it", async () => {
		const { world, deps, head } = await setup();
		// A forged author on a commit the Worker never made, with a file that claims accepted_by the authority.
		await world.push("base", { "context/notifications.md": NOTIFICATIONS_V2 }, { author: AUTHORITY, committer: AUTHORITY });
		const { event, recordPaths } = await observed(deps, await head());
		expect(event.records).toEqual([]);
		expect(event.invalid).toEqual([expect.objectContaining({ path: "context/notifications.md", error: expect.stringMatching(/not written by the Worker/) })]);
		expect(recordPaths).toEqual({});
	});

	it("rejects a Worker-recorded commit whose committer is not the Worker", async () => {
		const { world, deps, written, head } = await setup();
		const sha = await world.push("base", { "context/notifications.md": NOTIFICATIONS_V2 }, { author: AUTHORITY, committer: "someone-else" });
		written.set(sha, { kind: "context", actor: AUTHORITY });
		const { event } = await observed(deps, await head());
		expect(event.records).toEqual([]);
		expect(event.invalid[0]?.error).toMatch(/committer/);
	});

	it("rejects a Worker commit authored by someone other than the authority", async () => {
		const { world, deps, written, head } = await setup();
		const sha = await world.push("base", { "context/notifications.md": NOTIFICATIONS_V2 }, { author: "agent-b", committer: WORKER_COMMITTER });
		written.set(sha, { kind: "context", actor: "agent-b" });
		const { event } = await observed(deps, await head());
		expect(event.records).toEqual([]);
		expect(event.invalid[0]?.error).toMatch(/authority/);
	});

	it("never lets a merge commit accept context, even a Worker-written one", async () => {
		const { world, deps, written, head } = await setup();
		const sha = await world.push("base", { "context/notifications.md": NOTIFICATIONS_V2 }, { author: AUTHORITY, committer: WORKER_COMMITTER });
		written.set(sha, { kind: "merge", actor: AUTHORITY });
		const { event } = await observed(deps, await head());
		expect(event.records).toEqual([]);
		expect(event.invalid[0]?.error).toMatch(/merge/);
	});

	it("does not let a rejected file claim the record's path", async () => {
		const { world, deps, head } = await setup();
		await world.push("base", { "context/evil.md": NOTIFICATIONS_V2 }, { author: AUTHORITY, committer: AUTHORITY });
		const { recordPaths } = await observed(deps, await head());
		expect(recordPaths).toEqual({});
	});

	it("takes a proposed record from anyone, because a proposal governs nothing", async () => {
		const { world, deps, head } = await setup();
		await world.push("base", { "context/notifications.md": NOTIFICATIONS_V2.replace("status: accepted", "status: proposed") }, { author: "agent-b", committer: "agent-b" });
		const { event, recordPaths } = await observed(deps, await head());
		expect(event.records.map((r) => r.status)).toEqual(["proposed"]);
		expect(recordPaths).toEqual({});
	});
});

describe("fork commits can never accept context", () => {
	it("reports a fork's edit to context/** as contextPaths, never as records", async () => {
		const { world, deps, head } = await setup();
		const baseSha = (await head()).sha;
		world.fork("base", "fork-1");
		const sha = await world.push("fork-1", { "context/notifications.md": NOTIFICATIONS_V2, ".delta/claims.json": "[]" }, { author: "workitem-wi-1", committer: AUTHORITY });
		const commit = (await world.port().log("fork-1", { limit: 1 }))[0]!;
		const tracked = { repo: "fork-1", kind: "fork" as const, workItemId: "WI-1", baseCommit: baseSha };
		const event = await observeForkCommit(deps, tracked, "base", commit);
		expect(event.type).toBe("ForkPushed");
		if (event.type !== "ForkPushed") return;
		expect(event.commitSha).toBe(sha);
		expect(event.contextPaths).toEqual(["context/notifications.md"]);
		expect("records" in event).toBe(false);
	});

	it("reads a claims file inherited unchanged from the fork's base as missing, so an agent cannot start with another item's claims", async () => {
		const { world, deps, head } = await setup();
		await world.push("base", { ".delta/claims.json": '[{"subject":"status.values","value":"x","basedOn":"status-model@1"}]' }, { author: AUTHORITY, committer: WORKER_COMMITTER });
		const baseSha = (await head()).sha;
		world.fork("base", "fork-1");
		await world.push("fork-1", { "src/work.ts": "export {};\n" }, { author: "workitem-wi-1" });
		const tracked = { repo: "fork-1", kind: "fork" as const, workItemId: "WI-1", baseCommit: baseSha };
		const inherited = await observeForkCommit(deps, tracked, "base", (await world.port().log("fork-1", { limit: 1 }))[0]!);
		expect(inherited.type === "ForkPushed" && inherited.claims).toBeNull();

		// Its own claims, even identical in meaning, are a different file: they count.
		await world.push("fork-1", { ".delta/claims.json": '[{"subject":"status.values","value":"y","basedOn":"status-model@1"}]' }, { author: "workitem-wi-1" });
		const own = await observeForkCommit(deps, tracked, "base", (await world.port().log("fork-1", { limit: 1 }))[0]!);
		expect(own.type === "ForkPushed" && own.claims).toEqual([{ subject: "status.values", value: "y", basedOn: "status-model@1" }]);
	});

	it("fails closed when the fork cannot be compared with its base", async () => {
		const { world, deps } = await setup();
		world.fork("base", "fork-1");
		await world.push("fork-1", { "src/a.ts": "x" });
		const commit = (await world.port().log("fork-1", { limit: 1 }))[0]!;
		const tracked = { repo: "fork-1", kind: "fork" as const, workItemId: "WI-1", baseCommit: "a".repeat(40) };
		await expect(observeForkCommit(deps, tracked, "base", commit)).rejects.toThrow();
		const degraded = await observeForkCommit(deps, tracked, "base", commit, { degraded: true });
		expect(degraded.type === "ForkPushed" && degraded.contextPaths.length).toBeGreaterThan(0);
	});
});
