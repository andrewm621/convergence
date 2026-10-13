import type { WorkItemState } from "contracts";
import { clusterSize, dependencyEdge, layoutGraph, type GraphEdge, type GraphNode } from "./graph-layout";
import { dependencyEdges, currentRecord, recordIds, runningAgents, workItemsSorted, type DepEdge } from "@/state/derive";
import type { ViewState } from "@/state/store";

export type GraphModel = {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** The dependency edges before layout, for tests and the legend. */
	dependencies: DepEdge[];
	seededCount: number;
};

/** Cluster edges stand for many dependencies at once: stale if any seeded item's edge to that record is. */
function aggregate(edges: DepEdge[]): Map<string, DepEdge> {
	const byRecord = new Map<string, DepEdge>();
	for (const edge of edges) {
		const seen = byRecord.get(edge.recordId);
		if (!seen || (edge.kind === "stale" && seen.kind !== "stale")) byRecord.set(edge.recordId, edge);
	}
	return byRecord;
}

/**
 * Turn the view state into laid-out React Flow nodes and edges. Live work items get a node each.
 * Seeded items (the fan-out) share one compact cluster so forty of them stay legible.
 */
export function buildGraph(view: ViewState, selectedId: string | null, flashIds: ReadonlySet<string> = new Set()): GraphModel {
	const items = workItemsSorted(view);
	const live = items.filter((wi) => wi.item.source !== "seeded");
	const seeded = items.filter((wi) => wi.item.source === "seeded");
	const dependencies = dependencyEdges(view);
	const running = runningAgents(view.ledger);

	const nodes: GraphNode[] = [
		{
			id: "baseline",
			type: "baseline",
			position: { x: 0, y: 0 },
			data: {
				scenario: view.scenario,
				commit: view.baselineCommit,
				promoted: items.filter((wi) => wi.item.status === "promoted").length,
				total: items.length,
			},
			draggable: false,
		},
	];
	const layoutEdges: Array<[string, string]> = [];
	const edges: GraphEdge[] = [];

	for (const id of recordIds(view)) {
		const head = currentRecord(view, id);
		const history = view.records[id];
		if (!head || !history) continue;
		const deps = dependencies.filter((d) => d.recordId === id);
		const versions = Object.keys(history.versions).map(Number).sort((a, b) => a - b);
		const prior = versions.filter((v) => v < head.version).at(-1) ?? null;
		nodes.push({
			id: `record:${id}`,
			type: "record",
			position: { x: 0, y: 0 },
			data: {
				recordId: id,
				version: head.version,
				proposedVersion: history.proposed?.version ?? null,
				priorVersion: prior,
				dependents: deps.filter((d) => d.kind !== "proposed").length,
				stale: deps.filter((d) => d.kind === "stale").length,
			},
			draggable: false,
		});
		layoutEdges.push(["baseline", `record:${id}`]);
		edges.push({ id: `baseline->${id}`, source: "baseline", target: `record:${id}`, sourceHandle: "out", targetHandle: "from-baseline", style: { stroke: "var(--border)", strokeWidth: 1.5 }, selectable: false });
	}

	const itemNode = (wi: WorkItemState): GraphNode => ({
		id: `item:${wi.item.id}`,
		type: "item",
		position: { x: 0, y: 0 },
		data: { wi, running: running.has(wi.item.id), selected: wi.item.id === selectedId },
		draggable: false,
	});
	for (const wi of live) {
		nodes.push(itemNode(wi));
		for (const dep of dependencies.filter((d) => d.workItemId === wi.item.id)) {
			layoutEdges.push([`record:${dep.recordId}`, `item:${wi.item.id}`]);
			edges.push(dependencyEdge(dep, `item:${wi.item.id}`, flashIds.has(dep.id)));
		}
	}

	if (seeded.length > 0) {
		nodes.push({ id: "cluster:seeded", type: "cluster", position: { x: 0, y: 0 }, data: { items: seeded, selectedId, columns: clusterSize(seeded.length).columns }, draggable: false });
		const seededIds = new Set(seeded.map((wi) => wi.item.id));
		for (const edge of aggregate(dependencies.filter((d) => seededIds.has(d.workItemId))).values()) {
			const staleCount = dependencies.filter((d) => seededIds.has(d.workItemId) && d.recordId === edge.recordId && d.kind === "stale").length;
			const total = dependencies.filter((d) => seededIds.has(d.workItemId) && d.recordId === edge.recordId).length;
			const merged: DepEdge = { ...edge, id: `cluster->${edge.recordId}`, workItemId: "cluster" };
			layoutEdges.push([`record:${edge.recordId}`, "cluster:seeded"]);
			const built = dependencyEdge(merged, "cluster:seeded", flashIds.has(merged.id));
			const label = edge.kind === "stale" ? `${staleCount} of ${total} stale` : null;
			edges.push({ ...built, data: { ...(built.data as NonNullable<typeof built.data>), label } });
		}
	}

	// A later edge paints over an earlier one: the stale (red) edges go last. No z-index, so labels stay on top.
	const order: Record<string, number> = { ok: 0, proposed: 1, excepted: 2, stale: 3 };
	const rank = (edge: GraphEdge) => order[(edge.data as { kind?: string } | undefined)?.kind ?? ""] ?? -1;
	edges.sort((a, b) => rank(a) - rank(b));
	return { nodes: layoutGraph(nodes, layoutEdges), edges, dependencies, seededCount: seeded.length };
}
