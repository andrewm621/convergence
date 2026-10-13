import * as dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node } from "@xyflow/react";
import type { WorkItemState } from "contracts";
import type { DepEdge, EdgeKind } from "@/state/derive";

/**
 * The work graph, laid out left to right with dagre: baseline, then the context records it
 * holds, then the work that relies on them. Dependency edges run from a work item to the
 * record it depends on, so the one that goes stale is the one you see turn red.
 */

/**
 * Node sizes are set for video, not for a dense dashboard. At 1920x1080 the graph pane is about
 * 1120x600 px, and the fit below lands at roughly 1:1 for 2 to 5 work items, so a 17px title is
 * a 14px or larger title on screen. Making a node taller costs zoom for every node.
 */
export const NODE_SIZE = {
	baseline: { width: 176, height: 104 },
	record: { width: 272, height: 116 },
	item: { width: 380, height: 98 },
} as const;

/** Dagre spacing. `nodesep` is the vertical gap between nodes in a column; `ranksep` the gap between columns. */
export const SPACING = {
	nodesep: 14,
	/** Wide enough for the "was v1 · now v2" label that sits on the edge between a record and its work. */
	ranksep: 120,
	/** A fan-out cluster is wide, so the columns before it sit closer together. */
	ranksepCluster: 84,
	margin: 16,
} as const;

/**
 * How the graph is framed. Padding is small because the legend and the zoom controls sit under
 * the baseline column and the results strip above it, where the layout is empty; `maxZoom` keeps
 * a two-item graph from ballooning.
 */
export const FIT = {
	padding: 0.03,
	minZoom: 0.4,
	maxZoom: 1.3,
	/** Title size of a work item node in CSS px, before zoom. Effective size is this times the fitted zoom. */
	itemTitlePx: 17,
} as const;

export type BaselineData = { scenario: string; commit: string; promoted: number; total: number; [key: string]: unknown };
export type RecordData = { recordId: string; version: number; proposedVersion: number | null; priorVersion: number | null; dependents: number; stale: number; [key: string]: unknown };
export type ItemData = { wi: WorkItemState; running: boolean; selected: boolean; [key: string]: unknown };
export type ClusterData = { items: WorkItemState[]; selectedId: string | null; columns: number; [key: string]: unknown };
export type DependencyEdgeData = { kind: EdgeKind; label: string | null; flash: boolean; [key: string]: unknown };

export type GraphNode = Node<BaselineData, "baseline"> | Node<RecordData, "record"> | Node<ItemData, "item"> | Node<ClusterData, "cluster">;
export type GraphEdge = Edge<DependencyEdgeData> | Edge;

export const TILE = { width: 112, height: 48, gap: 6, pad: 12, header: 68 } as const;

export function clusterSize(count: number): { width: number; height: number; columns: number } {
	const columns = count > 12 ? 5 : 3;
	const rows = Math.max(1, Math.ceil(count / columns));
	return {
		columns,
		width: columns * TILE.width + (columns - 1) * TILE.gap + TILE.pad * 2,
		height: TILE.header + rows * TILE.height + (rows - 1) * TILE.gap + TILE.pad,
	};
}

export function edgeLabel(edge: DepEdge): string | null {
	switch (edge.kind) {
		case "stale":
			return `was v${edge.heldVersion ?? "?"} · now v${edge.currentVersion ?? "?"}`;
		case "excepted":
			return "allowed with exception";
		case "proposed":
			return "proposed";
		default:
			return null;
	}
}

export function dependencyEdge(edge: DepEdge, source: string, flash: boolean): Edge<DependencyEdgeData> {
	return {
		id: edge.id,
		type: "dependency",
		source,
		target: `record:${edge.recordId}`,
		sourceHandle: "dep",
		targetHandle: "dep-in",
		data: { kind: edge.kind, label: edgeLabel(edge), flash },
	};
}

type Placed = Map<string, { x: number; y: number }>;

function runDagre(nodes: GraphNode[], layoutEdges: Array<[string, string]>): Placed {
	const graph = new dagre.graphlib.Graph();
	const ranksep = nodes.some((node) => node.type === "cluster") ? SPACING.ranksepCluster : SPACING.ranksep;
	graph.setGraph({ rankdir: "LR", nodesep: SPACING.nodesep, ranksep, marginx: SPACING.margin, marginy: SPACING.margin });
	graph.setDefaultEdgeLabel(() => ({}));
	const ids = new Set(nodes.map((node) => node.id));
	for (const node of nodes) {
		// dagre writes x and y onto the label it is given, so every node needs its own copy.
		graph.setNode(node.id, { ...sizeOf(node) });
	}
	for (const [from, to] of layoutEdges) if (ids.has(from) && ids.has(to)) graph.setEdge(from, to);
	dagre.layout(graph);
	const placed: Placed = new Map();
	for (const node of nodes) {
		const { x, y } = graph.node(node.id);
		placed.set(node.id, { x, y });
	}
	return placed;
}

/** Edges that cross between the same two columns: the thing that makes a graph hard to read. */
function crossings(placed: Placed, layoutEdges: Array<[string, string]>): number {
	let count = 0;
	for (let i = 0; i < layoutEdges.length; i++) {
		for (let j = i + 1; j < layoutEdges.length; j++) {
			const [a, b] = layoutEdges[i] as [string, string];
			const [c, d] = layoutEdges[j] as [string, string];
			const pa = placed.get(a);
			const pb = placed.get(b);
			const pc = placed.get(c);
			const pd = placed.get(d);
			if (!pa || !pb || !pc || !pd || pa.x !== pc.x || pb.x !== pd.x) continue;
			if ((pa.y - pc.y) * (pb.y - pd.y) < 0) count += 1;
		}
	}
	return count;
}

/**
 * Run dagre over the nodes and edges (layout edges run record to work, so work sits on the right).
 * dagre breaks ties by insertion order, so on small graphs we try each ordering of records and
 * work items and keep the one with the fewest crossing edges.
 */
export function layoutGraph(nodes: GraphNode[], layoutEdges: Array<[string, string]>): GraphNode[] {
	const flip = (type: GraphNode["type"], list: GraphNode[]) => {
		const same = list.filter((node) => node.type === type);
		const others = list.filter((node) => node.type !== type);
		return [...others.slice(0, 1), ...same.reverse(), ...others.slice(1)];
	};
	const variants: GraphNode[][] = [nodes];
	if (nodes.length <= 24) variants.push(flip("item", [...nodes]), flip("record", [...nodes]), flip("record", flip("item", [...nodes])));

	let best: { placed: Placed; score: number } | null = null;
	for (const variant of variants) {
		const placed = runDagre(variant, layoutEdges);
		const score = crossings(placed, layoutEdges);
		if (!best || score < best.score) best = { placed, score };
		if (score === 0) break;
	}
	const placed = best?.placed ?? new Map();
	return nodes.map((node) => {
		const at = placed.get(node.id) ?? { x: 0, y: 0 };
		const size = sizeOf(node);
		return {
			...node,
			position: { x: at.x - size.width / 2, y: at.y - size.height / 2 },
			sourcePosition: Position.Right,
			targetPosition: Position.Left,
			width: size.width,
			height: size.height,
		} as GraphNode;
	});
}

function sizeOf(node: GraphNode): { width: number; height: number } {
	switch (node.type) {
		case "baseline":
			return NODE_SIZE.baseline;
		case "record":
			return NODE_SIZE.record;
		case "cluster": {
			const { width, height } = clusterSize(node.data.items.length);
			return { width, height };
		}
		default:
			return NODE_SIZE.item;
	}
}
