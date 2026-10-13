import { render } from "@testing-library/react";
import { ReactFlowProvider, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { buildNotificationsScenario } from "scenario-notifications";
import type { ConsoleMessage } from "@/client/types";
import { MockCell } from "@/mock/cell";
import { MockSession } from "@/mock/session";
import { initialViewState, viewReducer } from "@/state/store";
import { startMock } from "@/test/harness";
import { buildGraph } from "./graph-model";
import { DependencyEdge } from "./graph-nodes";
import type { DependencyEdgeData } from "./graph-layout";

function edgeStyle(data: DependencyEdgeData) {
	const { container } = render(
		<ReactFlowProvider>
			<svg>
				<DependencyEdge
					id="e"
					source="a"
					target="b"
					sourceX={0}
					sourceY={0}
					targetX={100}
					targetY={40}
					sourcePosition={Position.Left}
					targetPosition={Position.Right}
					data={data}
				/>
			</svg>
		</ReactFlowProvider>,
	);
	const path = container.querySelector("path.react-flow__edge-path") as SVGPathElement;
	return { stroke: path.style.stroke, dash: path.style.strokeDasharray, width: path.style.strokeWidth };
}

describe("the work graph: exactly one edge turns red", () => {
	it("WI-2's edge to notifications is stale; WI-1's edge is not; nothing else changes", async () => {
		const mock = await startMock();
		await mock.jump(3); // typo beat done, v2 only drafted
		let graph = buildGraph(mock.view, null);
		expect(graph.dependencies.filter((d) => d.kind === "stale")).toHaveLength(0);

		await mock.jump(4); // v2 lands
		graph = buildGraph(mock.view, null);
		const kinds = Object.fromEntries(graph.dependencies.map((d) => [d.id, d.kind]));
		expect(kinds).toEqual({
			"WI-1->status-model": "ok",
			"WI-2->notifications": "stale",
			"WI-2->status-model": "ok",
		});
		const dependencyEdges = graph.edges.filter((e) => e.type === "dependency");
		const red = dependencyEdges.filter((e) => (e.data as DependencyEdgeData).kind === "stale");
		expect(red).toHaveLength(1);
		expect(red[0]?.source).toBe("item:WI-2");
		expect(red[0]?.target).toBe("record:notifications");
		expect((red[0]?.data as DependencyEdgeData).label).toMatch(/^was v1 · now v2$/);
		mock.stop();
	});

	it("lays work out to the right of the records it relies on, with no node on top of another", async () => {
		const mock = await startMock();
		await mock.jump(4);
		const { nodes } = buildGraph(mock.view, null);
		const x = (id: string) => nodes.find((n) => n.id === id)?.position.x ?? Number.NaN;
		expect(x("baseline")).toBeLessThan(x("record:notifications"));
		expect(x("record:notifications")).toBeLessThan(x("item:WI-2"));
		const boxes = nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: n.width ?? 0, h: n.height ?? 0 }));
		for (const a of boxes) {
			for (const b of boxes) {
				if (a.id >= b.id) continue;
				const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
				expect(overlaps, `${a.id} overlaps ${b.id}`).toBe(false);
			}
		}
		mock.stop();
	});

	it("puts forty seeded items in one cluster, and one aggregate edge goes red", async () => {
		const mock = await startMock({ script: "fanout" });
		await mock.next(2);
		const graph = buildGraph(mock.view, null);
		expect(graph.nodes.filter((n) => n.type === "cluster")).toHaveLength(1);
		expect(graph.nodes.filter((n) => n.type === "item")).toHaveLength(0);
		const red = graph.edges.filter((e) => e.type === "dependency" && (e.data as DependencyEdgeData).kind === "stale");
		expect(red).toHaveLength(1);
		expect((red[0]?.data as DependencyEdgeData).label).toBe("8 of 12 blocked");
		mock.stop();
	});
});

describe("dependency edge styling", () => {
	it("a stale edge is red and dashed", () => {
		const style = edgeStyle({ kind: "stale", label: "stale: v1 → v2", flash: false });
		expect(style.stroke).toBe("var(--danger)");
		expect(style.dash).not.toBe("");
	});

	it("a current edge is neutral and solid", () => {
		const style = edgeStyle({ kind: "ok", label: null, flash: false });
		expect(style.stroke).toBe("var(--muted-foreground)");
		expect(style.dash).toBe("");
	});

	it("a proposed edge is dashed but not red", () => {
		const style = edgeStyle({ kind: "proposed", label: "proposed", flash: false });
		expect(style.stroke).not.toBe("var(--danger)");
		expect(style.dash).not.toBe("");
	});
});

describe("proposed dependencies", () => {
	it("an agent that relies on a record it was never given gets a dashed, proposed edge (R4)", async () => {
		const bundle = await buildNotificationsScenario();
		const messages: ConsoleMessage[] = [];
		const cell = new MockCell(bundle, (m) => messages.push(m));
		await cell.init("seeded");
		const session = new MockSession(cell, { promoteDelayMs: 0 });
		await session.startAgents(["wi1"]);
		const apply = (state: typeof initialViewState, list: ConsoleMessage[]) => list.reduce((acc, message) => viewReducer(acc, { type: "message", message }), state);
		const start = apply(initialViewState, [await cell.snapshot()]);

		// WI-1 was only given status-model, but its claims also cite notifications.
		const before = messages.length;
		await cell.send({ ...bundle.events.wi1Pushed, claims: bundle.claims.wi1Undeclared } as never);

		// The stream does not describe the inferred dependency, so the console asks for a fresh snapshot.
		const streamed = apply(start, messages.slice(before));
		expect(streamed.needsResync).toBe(true);
		const view = apply(streamed, [await cell.snapshot()]);
		expect(view.needsResync).toBe(false);

		const graph = buildGraph(view, null);
		const proposed = graph.dependencies.find((d) => d.recordId === "notifications");
		expect(proposed?.kind).toBe("proposed");
		const edge = graph.edges.find((e) => e.id === "WI-1->notifications");
		expect((edge?.data as DependencyEdgeData).kind).toBe("proposed");
		expect((edge?.data as DependencyEdgeData).label).toBe("proposed");
	});
});

describe("a decision's blocked badge", () => {
	it("counts blocked work, and leaves out work a person rejected", async () => {
		const mock = await startMock();
		await mock.jump(4); // v2 lands: WI-2 is blocked on notifications
		const badge = (view: typeof mock.view) => (buildGraph(view, null).nodes.find((n) => n.id === "record:notifications")?.data as { stale: number }).stale;
		expect(badge(mock.view)).toBe(1);
		const wi = mock.view.workItems["WI-2"];
		if (!wi) throw new Error("no WI-2");
		const rejected = { ...mock.view, workItems: { ...mock.view.workItems, "WI-2": { ...wi, item: { ...wi.item, status: "rejected" as const } } } };
		expect(badge(rejected)).toBe(0);
		mock.stop();
	});
});
