import type { AgentActivity } from "contracts";
import { describe, expect, it, vi } from "vitest";
import { agentRunsKey } from "@/state/console-context";
import { initialViewState, viewReducer } from "@/state/store";
import { createLiveClient } from "./live";
import type { AgentRunSummary } from "./types";

const SECRET = "s3cret";
const FORK_1 = "smoke-1a2b-wi-1";
const FORK_2 = "smoke-1a2b-wi-2";

/** The shape of `GET /api/agents/runs/:agentId`, trimmed to what matters here. */
function run(forkRepo: string, workItemId: string, extra: Record<string, unknown> = {}) {
	return {
		state: "success",
		mode: "real",
		model: "anthropic/claude-sonnet-5.5",
		workItemId,
		forkRepo,
		commit: "a".repeat(40),
		AgentRunStarted: { type: "AgentRunStarted", workItemId, ts: "2026-10-14T15:00:00.000Z" },
		AgentRunFinished: { type: "AgentRunFinished", workItemId, ts: "2026-10-14T15:00:30.000Z", outcome: "success" },
		usage: { costUsd: 0.01 },
		activity: [
			{ workItemId, ts: "2026-10-14T15:00:01.000Z", kind: "clone", text: "cloned the fork" },
			{ workItemId, ts: "2026-10-14T15:00:05.000Z", kind: "tool", text: "edit src/notify.ts" },
		],
		...extra,
	};
}

function reply(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function liveClient(fetchImpl: typeof fetch) {
	return createLiveClient({ scenario: "notifications", cell: "notifications-demo", apiBase: "http://delta.test", fetchImpl, token: () => SECRET });
}

describe("live client: agentRuns", () => {
	it("reads the run by lowercase agent id with the bearer token, and maps it to the cell's id", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).endsWith("/wi-1") ? reply(run(FORK_1, "wi-1")) : reply(run(FORK_2, "wi-2", { model: "openai/gpt-6-luna" }))));
		const runs = await liveClient(fetchImpl).api.agentRuns([
			{ id: "WI-1", forkRepo: FORK_1 },
			{ id: "WI-2", forkRepo: FORK_2 },
		]);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://delta.test/api/agents/runs/wi-1");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
		expect(runs.map((r) => [r.workItemId, r.model])).toEqual([
			["WI-1", "anthropic/claude-sonnet-5.5"],
			["WI-2", "openai/gpt-6-luna"],
		]);
		// Cell ids on every line, and the Worker's open-ended kinds read as one the console draws.
		expect(runs[0]?.activity.map((l) => [l.workItemId, l.kind, l.text])).toEqual([
			["WI-1", "status", "cloned the fork"],
			["WI-1", "tool", "edit src/notify.ts"],
		]);
	});

	it("ignores a run whose fork is not the work item's fork (the agent id belongs to another cell)", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => reply(run("someone-elses-wi-1", "wi-1")));
		const runs = await liveClient(fetchImpl).api.agentRuns([{ id: "WI-1", forkRepo: FORK_1 }]);
		expect(runs).toEqual([]);
	});

	it("tolerates a 404, a server error, a network failure and a body it cannot read", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(reply({ error: { code: "NOT_FOUND", message: "no run for wi-1" } }, 404))
			.mockResolvedValueOnce(reply({ error: {} }, 500))
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(new Response("<html>", { status: 200 }))
			.mockResolvedValueOnce(reply(run(FORK_2, "wi-5")));
		const runs = await liveClient(fetchImpl).api.agentRuns([
			{ id: "WI-1", forkRepo: FORK_1 },
			{ id: "WI-2", forkRepo: FORK_2 },
			{ id: "WI-3", forkRepo: "x" },
			{ id: "WI-4", forkRepo: "y" },
			{ id: "WI-5", forkRepo: FORK_2 },
		]);
		expect(runs.map((r) => r.workItemId)).toEqual(["WI-5"]);
	});

	it("drops activity lines it cannot read and names a stub run 'stub agent'", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			reply(run(FORK_1, "wi-1", { mode: "stub", model: "none", activity: [{ ts: "not a time", kind: "tool", text: "x" }, { kind: "tool" }, { workItemId: "wi-1", ts: "2026-10-14T15:00:01.000Z", kind: "error", text: "boom" }] })),
		);
		const [only] = await liveClient(fetchImpl).api.agentRuns([{ id: "WI-1", forkRepo: FORK_1 }]);
		expect(only?.model).toBe("stub agent");
		expect(only?.activity.map((l) => [l.kind, l.text])).toEqual([["error", "boom"]]);
	});
});

const line = (workItemId: string, ts: string, text: string, kind: AgentActivity["kind"] = "tool"): AgentActivity => ({ type: "agent-activity", workItemId, runId: "run", kind, text, ts });

describe("store: agent runs read after the fact", () => {
	const t = (s: number) => `2026-10-14T15:00:${String(s).padStart(2, "0")}.000Z`;

	it("merges both agents' lines oldest first so they interleave, and records each model", () => {
		const runs: AgentRunSummary[] = [
			{ workItemId: "WI-1", model: "anthropic/claude-sonnet-5.5", activity: [line("WI-1", t(1), "a1"), line("WI-1", t(4), "a2")] },
			{ workItemId: "WI-2", model: "openai/gpt-6-luna", activity: [line("WI-2", t(2), "b1"), line("WI-2", t(3), "b2")] },
		];
		const view = viewReducer(initialViewState, { type: "agent-runs", runs });
		expect(view.activity.map((l) => l.text)).toEqual(["a1", "b1", "b2", "a2"]);
		expect(view.agentModels).toEqual({ "WI-1": "anthropic/claude-sonnet-5.5", "WI-2": "openai/gpt-6-luna" });
	});

	it("does not double a line the socket already delivered, or one read twice, and slots new ones in by time", () => {
		let view = viewReducer(initialViewState, { type: "message", message: line("WI-1", t(5), "live line") });
		const runs: AgentRunSummary[] = [{ workItemId: "WI-1", model: null, activity: [line("WI-1", t(1), "early"), line("WI-1", t(5), "live line")] }];
		view = viewReducer(view, { type: "agent-runs", runs });
		view = viewReducer(view, { type: "agent-runs", runs });
		expect(view.activity.map((l) => l.text)).toEqual(["early", "live line"]);
		expect(view.agentModels).toEqual({}); // a run that names no model sets none
	});

	it("keeps the newest 300 lines", () => {
		const many = Array.from({ length: 350 }, (_, i) => line("WI-1", new Date(Date.UTC(2026, 9, 14, 15, 0, 0, i * 10)).toISOString(), `n${i}`));
		const view = viewReducer(initialViewState, { type: "agent-runs", runs: [{ workItemId: "WI-1", model: null, activity: many }] });
		expect(view.activity).toHaveLength(300);
		expect(view.activity[0]?.text).toBe("n50");
		expect(view.activity.at(-1)?.text).toBe("n349");
	});

	it("is not wiped by a snapshot, and is cleared by a reset", () => {
		let view = viewReducer(initialViewState, { type: "agent-runs", runs: [{ workItemId: "WI-1", model: "m/x", activity: [line("WI-1", t(1), "a")] }] });
		expect(viewReducer(view, { type: "reset" }).agentModels).toEqual({});
		view = viewReducer(view, { type: "agent-runs", runs: [] });
		expect(view.activity).toHaveLength(1);
	});
});

describe("when the runs are read again", () => {
	const item = (id: string, headSha: string | null, extra: Record<string, unknown> = {}) => ({ item: { id, forkRepo: `${id}-fork`, source: "live" }, headSha, revalidating: false, ...extra }) as never;

	it("changes with a fork push or a re-run, and not with anything else", () => {
		const base = agentRunsKey({ "WI-1": item("WI-1", "a"), "WI-2": item("WI-2", null) });
		expect(agentRunsKey({ "WI-1": item("WI-1", "a"), "WI-2": item("WI-2", null) })).toBe(base);
		expect(agentRunsKey({ "WI-1": item("WI-1", "b"), "WI-2": item("WI-2", null) })).not.toBe(base);
		expect(agentRunsKey({ "WI-1": item("WI-1", "a"), "WI-2": item("WI-2", null, { revalidating: true }) })).not.toBe(base);
		expect(agentRunsKey({})).toBe("");
	});
});
