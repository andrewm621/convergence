import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CellSnapshot } from "contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { TOKEN_STORAGE_KEY } from "@/client/auth";
import { readRuntime, type Runtime } from "@/client/create-client";
import { PUBLIC_READ_ONLY_NOTE } from "@/config";
import { startMock } from "@/test/harness";

// The public read-only view (`?view=public`) end to end: the real App and live client against a stubbed fetch that answers like
// the Worker's four public reads. Nothing here may send a credential, open a socket, or write.

const SECRET = "browser-session-secret";

/** A cell at the point where WI-2 is blocked, as the Worker's GET /state would send it. */
async function blockedSnapshot(): Promise<CellSnapshot> {
	const mock = await startMock();
	await mock.jump(5);
	const view = mock.view;
	const snapshot: CellSnapshot = {
		scenario: view.scenario,
		baselineCommit: view.baselineCommit,
		snapshotHash: view.snapshotHash,
		policy: view.policy as NonNullable<typeof view.policy>,
		records: view.records,
		workItems: Object.values(view.workItems),
		dependencies: view.dependencies,
		ledgerTail: view.ledger,
		ledgerHead: view.ledgerHead,
	};
	mock.stop();
	return snapshot;
}

type Call = { method: string; url: string; headers: Record<string, string> };

describe("public read-only runtime", () => {
	it("is entered with ?view=public on the live console and means nothing in the replay", () => {
		expect(readRuntime("?scenario=notifications&view=public", {}).publicView).toBe(true);
		expect(readRuntime("?cell=notifications-rec1&view=public", {})).toMatchObject({ publicView: true, cell: "notifications-rec1", scenario: "notifications" });
		expect(readRuntime("?scenario=notifications", {}).publicView).toBe(false);
		expect(readRuntime("?view=private", {}).publicView).toBe(false);
		expect(readRuntime("?mock=1&view=public", {}).publicView).toBe(false);
		expect(readRuntime("?view=public", { VITE_MOCK: "1" }).publicView).toBe(false);
	});
});

describe("the public read-only view", () => {
	let snapshot: CellSnapshot;
	let calls: Call[];
	let prompt: ReturnType<typeof vi.fn>;
	let sockets: number;
	beforeAll(async () => {
		snapshot = await blockedSnapshot();
	});

	const runtime: Runtime = { mock: false, publicView: true, scenario: "notifications", start: "seeded", drip: false, controls: true };

	function stubWorker(handler: (url: URL) => Response) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input), "http://localhost");
				calls.push({ method: init?.method ?? "GET", url: url.pathname, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
				return handler(url);
			}),
		);
	}

	const publicWorker = (url: URL) =>
		url.pathname.endsWith("/state")
			? new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json", "X-Delta-Poller": "healthy" } })
			: url.pathname.endsWith("/gate")
				? new Response(JSON.stringify({ pass: false, reasonCodes: ["STALE_DEPENDENCY"], blockers: ["built on notifications v1, now v2"], waivedBy: [] }), { status: 200 })
				: new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });

	beforeEach(() => {
		calls = [];
		sockets = 0;
		sessionStorage.setItem(TOKEN_STORAGE_KEY, SECRET); // a maintainer's tab: the public view must not use it
		prompt = vi.fn(() => SECRET);
		vi.stubGlobal("prompt", prompt);
		window.prompt = prompt as unknown as typeof window.prompt;
		vi.stubGlobal(
			"WebSocket",
			class {
				constructor() {
					sockets += 1;
				}
				close() {}
			},
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		sessionStorage.clear();
	});

	it("shows the state with no token: badge, one-line note, no acting-as identity, no prompt, no socket", async () => {
		stubWorker(publicWorker);
		render(<App runtime={runtime} />);

		expect(await screen.findByText("Live · read-only")).toBeInTheDocument();
		expect(screen.getByTestId("public-note")).toHaveTextContent(PUBLIC_READ_ONLY_NOTE);
		expect(PUBLIC_READ_ONLY_NOTE).toBe("Read-only public view. Actions need the maintainer's token.");
		expect(screen.queryByTestId("acting-as")).toBeNull();
		expect(screen.queryByRole("button", { name: "Enter token" })).toBeNull();
		// The switcher names the one scenario and offers no other.
		expect(within(screen.getByRole("radiogroup", { name: "Scenario" })).getAllByRole("radio")).toHaveLength(1);
		expect(await screen.findByTestId("row-reason-WI-2")).toBeInTheDocument();

		expect(prompt).not.toHaveBeenCalled();
		expect(sockets).toBe(0);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call.method).toBe("GET");
			expect(call.url).toMatch(/^\/api\/scenarios\/notifications\/(state|work-items\/[A-Za-z0-9_-]+\/gate)$/);
			expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
		}
	});

	it("keeps the views working and turns every action off, each saying why", async () => {
		const user = userEvent.setup();
		stubWorker(publicWorker);
		render(<App runtime={runtime} />);

		await user.click(await screen.findByTestId("row-reason-WI-2"));
		const page = await screen.findByTestId("item-page");
		expect(within(page).getByTestId("item-verdict")).toHaveTextContent("Blocked");
		expect(within(page).getByRole("tab", { name: /^Why/ })).toHaveAttribute("aria-selected", "true");
		expect(within(page).getByRole("heading", { name: "Why is this blocked?" })).toBeInTheDocument();
		expect(within(page).getByTestId("built-on")).toBeInTheDocument();

		expect(within(page).getByTestId("revalidate-button")).toBeDisabled();
		expect(within(page).getByTestId("promote-button")).toBeDisabled();
		await user.click(within(page).getByRole("button", { name: /More/ }));
		for (const name of [/Allow with exception/, /Reject/]) expect(within(page).getByRole("button", { name })).toBeDisabled();

		// The decision editor and the audit log: the editor cannot be opened, the log is a plain read.
		const edits = screen.getAllByRole("button", { name: /Change this decision/ });
		expect(edits.length).toBeGreaterThan(0);
		for (const edit of edits) expect(edit).toBeDisabled();
		expect(await screen.findByRole("region", { name: "Audit log" })).toBeInTheDocument();

		// After all that, still nothing but GETs, and still no credential.
		for (const call of calls) {
			expect(call.method).toBe("GET");
			expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
		}
	});

	it("refuses a command in the client without sending it", async () => {
		stubWorker(publicWorker);
		const { createLiveClient } = await import("@/client/live");
		const client = createLiveClient({ scenario: "notifications", readOnly: true, apiBase: "http://delta.test", token: () => SECRET });
		const binding = { recordId: "notifications", version: 1, blobHash: "a".repeat(64), baseSha: "b".repeat(40), forkHeadSha: "c".repeat(40), contextSnapshotHash: "d".repeat(64) };
		const results = await Promise.all([
			client.api.resolve({ kind: "revalidate", workItemId: "WI-2", rationale: "x", binding }, "k1"),
			client.api.promote({ workItemId: "WI-2", expectedBaselineCommit: "b".repeat(40), forkHeadSha: "c".repeat(40) }, "k2"),
			client.api.proposeContextChange({ recordId: "notifications", facets: {}, prose: "x", rationale: "x" }, "k3"),
			client.api.decideDependency({ workItemId: "WI-2", recordId: "notifications", decision: "accept" }, "k4"),
			client.api.seedScenario("k5"),
			client.api.startScenario("k6"),
		]);
		for (const result of results) expect(result.ok).toBe(false);
		expect(results[0]).toMatchObject({ code: "READ_ONLY" });
		expect(await client.api.readRecordText("notifications")).toBe("");
		expect(await client.api.agentRuns([{ id: "WI-2", forkRepo: "r" }])).toEqual([]);
		expect(calls).toEqual([]);
		expect(client.readOnly).toBe(true);
	});

	it("says so, with a link to the replay, when the cell is not public", async () => {
		stubWorker(() => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 }));
		render(<App runtime={{ ...runtime, scenario: "shelter-intake", cell: "shelter-intake-private" }} />);
		const message = await screen.findByTestId("not-public");
		expect(message).toHaveTextContent("This cell is not available in the public view");
		expect(within(message).getByRole("link", { name: /replay/i })).toHaveAttribute("href", "?mock=1");
		// It asked once and gave up: no polling a cell that refused, no prompt for a token.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(calls.filter((c) => c.url.endsWith("/state"))).toHaveLength(1);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("polls the state again on its interval, so a changed cell shows up without a reload", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			stubWorker(publicWorker);
			render(<App runtime={runtime} />);
			await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/state")).length).toBeGreaterThanOrEqual(1));
			const before = calls.filter((c) => c.url.endsWith("/state")).length;
			await vi.advanceTimersByTimeAsync(3000);
			expect(calls.filter((c) => c.url.endsWith("/state")).length).toBeGreaterThan(before);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the authenticated live view is unchanged", () => {
	it("still shows the identity badge and plain Live, and keeps using the socket path", async () => {
		const { Header } = await import("./header");
		render(<Header scenario="notifications" onScenario={() => {}} connection="live" live />);
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.queryByText("Live · read-only")).toBeNull();
		expect(screen.getByTestId("acting-as")).toBeInTheDocument();
		expect(screen.queryByTestId("public-note")).toBeNull();
	});
});
