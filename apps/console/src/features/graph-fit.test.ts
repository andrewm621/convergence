import { getNodesBounds, getViewportForBounds } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { FIT, NODE_SIZE, TILE, clusterSize, layoutGraph, type GraphNode } from "./graph-layout";

/**
 * The graph pane at 1920x1080 is about 1120 x 600 px (1920 less the 320 px context column and the
 * 480 px inspector; 1080 less the header, banner, pane header, replay controls and bottom strip).
 * These tests pin the framing so a tweak to node size, spacing or padding cannot quietly make the
 * nodes unreadable on a video again. Effective px is the CSS px the node is drawn at, times zoom.
 */
const PANE = { width: 1120, height: 600 };

function origin() {
	return { x: 0, y: 0 };
}

function graphOf(itemCount: number, opts: { cluster?: boolean; records?: number } = {}) {
	const records = opts.records ?? 2;
	const nodes = [{ id: "baseline", type: "baseline", position: origin(), data: {} }] as unknown as GraphNode[];
	const edges: Array<[string, string]> = [];
	for (let r = 0; r < records; r++) {
		nodes.push({ id: `record:r${r}`, type: "record", position: origin(), data: {} } as unknown as GraphNode);
		edges.push(["baseline", `record:r${r}`]);
	}
	if (opts.cluster) {
		nodes.push({ id: "cluster:seeded", type: "cluster", position: origin(), data: { items: Array.from({ length: itemCount }) } } as unknown as GraphNode);
		for (let r = 0; r < records; r++) edges.push([`record:r${r}`, "cluster:seeded"]);
	} else {
		for (let i = 0; i < itemCount; i++) {
			nodes.push({ id: `item:WI-${i}`, type: "item", position: origin(), data: {} } as unknown as GraphNode);
			// Every item relies on the first record; every other one on the second as well.
			edges.push(["record:r0", `item:WI-${i}`]);
			if (records > 1 && i % 2 === 0) edges.push(["record:r1", `item:WI-${i}`]);
		}
	}
	return layoutGraph(nodes, edges);
}

function fit(nodes: GraphNode[], pane = PANE) {
	const bounds = getNodesBounds(nodes);
	const viewport = getViewportForBounds(bounds, pane.width, pane.height, FIT.minZoom, FIT.maxZoom, FIT.padding);
	return { bounds, zoom: viewport.zoom, viewport };
}

describe("graph framing at 1920x1080", () => {
	it.each([2, 3, 4, 5, 6])("%i work items: the item title is at least 14px on screen", (count) => {
		const { zoom } = fit(graphOf(count));
		expect(FIT.itemTitlePx * zoom).toBeGreaterThanOrEqual(14);
	});

	it("up to 5 items the whole graph sits at about 1:1 or larger, so the small text is legible too", () => {
		for (const count of [2, 3, 4, 5]) expect(fit(graphOf(count)).zoom).toBeGreaterThanOrEqual(0.95);
	});

	it("a small graph is not blown up past the max zoom", () => {
		expect(fit(graphOf(1)).zoom).toBeLessThanOrEqual(FIT.maxZoom);
	});

	it("the 40-item fan-out fits whole inside the pane, unclamped, with readable tiles", () => {
		const nodes = graphOf(40, { cluster: true });
		const { bounds, zoom } = fit(nodes);
		expect(zoom).toBeGreaterThan(FIT.minZoom);
		expect(bounds.width * zoom).toBeLessThanOrEqual(PANE.width);
		expect(bounds.height * zoom).toBeLessThanOrEqual(PANE.height);
		// Tile text is 12px.
		expect(12 * zoom).toBeGreaterThanOrEqual(10);
		const cluster = clusterSize(40);
		expect(cluster.columns).toBe(5);
		expect(cluster.width).toBe(5 * TILE.width + 4 * TILE.gap + TILE.pad * 2);
	});

	it("lays work items out in one column with no overlap", () => {
		const items = graphOf(6).filter((n) => n.type === "item");
		const sorted = [...items].sort((a, b) => a.position.y - b.position.y);
		for (let i = 1; i < sorted.length; i++) {
			const prev = sorted[i - 1] as GraphNode;
			expect((sorted[i] as GraphNode).position.y).toBeGreaterThanOrEqual(prev.position.y + NODE_SIZE.item.height);
		}
		expect(new Set(items.map((n) => n.position.x)).size).toBe(1);
	});
});
