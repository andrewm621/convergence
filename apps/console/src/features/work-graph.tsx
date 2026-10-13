import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, useReactFlow, type NodeTypes, type EdgeTypes } from "@xyflow/react";
import { Play, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { newIdempotencyKey } from "@/client/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SeededBadge } from "@/components/status";
import { UnavailableHint } from "@/components/unavailable-hint";
import { formatMs, plural } from "@/lib/format";
import { useConsole } from "@/state/console-context";
import type { Evaluation } from "@/state/store";
import { PaneHeader } from "./context-timeline";
import { BaselineNode, ClusterNode, DependencyEdge, RecordNode, WorkItemNode } from "./graph-nodes";
import { FIT } from "./graph-layout";
import { buildGraph } from "./graph-model";

// Defined once, outside any component, so React Flow does not rebuild its node and edge types on every render.
const nodeTypes: NodeTypes = { baseline: BaselineNode, record: RecordNode, item: WorkItemNode, cluster: ClusterNode };
const edgeTypes: EdgeTypes = { dependency: DependencyEdge };

function useIsDark(): boolean {
	const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
	useEffect(() => {
		const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);
	return dark;
}

/**
 * The time the strip may show. The mock's number is real engine time. The Worker's `evaluationMs`
 * is the reconciler alone (often under 0.01 ms), which means nothing to a viewer, so in live mode
 * the strip shows only what this browser measured: change sent to verdict arriving. A change this
 * browser did not send has no honest number, so none is shown.
 */
export function WorkGraph() {
	const { view, client, observed } = useConsole();
	const evaluation = view.evaluation;
	const live = client.kind === "live";
	const ms = live ? (evaluation && observed?.seq === evaluation.seq ? observed.ms : null) : (evaluation?.ms ?? null);
	return (
		<section aria-label="Work graph" className="relative flex min-h-0 flex-1 flex-col">
			<PaneHeader title="Work graph" subtitle="Who is building on which decision">
				<ResultsStrip evaluation={evaluation} ms={ms} measuredHere={live} />
			</PaneHeader>
			<div className="relative min-h-0 flex-1">
				<ReactFlowProvider>
					<GraphCanvas />
				</ReactFlowProvider>
			</div>
		</section>
	);
}

function GraphCanvas() {
	const { view, selectedId, select, client } = useConsole();
	const dark = useIsDark();
	const { fitView } = useReactFlow();

	// The edge that has just turned stale flashes once. The timer lives in a ref so a re-render cannot cancel it.
	const previous = useRef<Map<string, string>>(new Map());
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
	const model = useMemo(() => buildGraph(view, selectedId, flash), [view, selectedId, flash]);
	useEffect(() => {
		const before = previous.current;
		previous.current = new Map(model.dependencies.map((d) => [d.id, d.kind]));
		const fresh = model.dependencies.filter((d) => d.kind === "stale" && before.has(d.id) && before.get(d.id) !== "stale").map((d) => d.id);
		if (fresh.length === 0) return;
		setFlash(new Set(fresh));
		if (flashTimer.current) clearTimeout(flashTimer.current);
		flashTimer.current = setTimeout(() => setFlash(new Set()), 1400);
	}, [model.dependencies]);
	useEffect(
		() => () => {
			if (flashTimer.current) clearTimeout(flashTimer.current);
		},
		[],
	);

	// Re-frame when the set of nodes changes, not on every status flip.
	const signature = model.nodes.map((n) => n.id).join("|");
	useEffect(() => {
		const timer = setTimeout(() => void fitView({ padding: FIT.padding, duration: 350, minZoom: FIT.minZoom, maxZoom: FIT.maxZoom }), 60);
		return () => clearTimeout(timer);
	}, [signature, fitView]);

	const hasRecords = Object.keys(view.records).length > 0;
	const hasWork = Object.keys(view.workItems).length > 0;

	return (
		<>
			<ReactFlow
				nodes={model.nodes}
				edges={model.edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				colorMode={dark ? "dark" : "light"}
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
				fitView
				fitViewOptions={{ padding: FIT.padding, minZoom: FIT.minZoom, maxZoom: FIT.maxZoom }}
				minZoom={FIT.minZoom}
				maxZoom={1.6}
				proOptions={{ hideAttribution: true }}
				onNodeClick={(_, node) => {
					if (node.type === "item") select(node.id.replace(/^item:/, ""));
				}}
				onPaneClick={() => select(null)}
				aria-label="Work graph canvas"
			>
				<Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--graph-dot)" />
				<Controls showInteractive={false} position="bottom-left" orientation="horizontal" />
			</ReactFlow>

			<div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-start gap-2 p-3">
				{model.seededCount > 0 && (
					<div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-dashed bg-card/90 px-3 py-1.5 text-xs shadow-xs" data-testid="seeded-banner">
						<SeededBadge />
						<span>Synthetic work items. No model is behind them.</span>
					</div>
				)}
			</div>

			<Legend />

			{view.ready && hasRecords && !hasWork && (
				<div className="pointer-events-none absolute inset-x-0 top-16 grid place-items-center p-6">
					<StartAgents onStart={() => client.api.startScenario(newIdempotencyKey())} />
				</div>
			)}
		</>
	);
}

export function StartAgents({ onStart }: { onStart(): Promise<{ ok: boolean; message?: string }> }) {
	const { notify, client } = useConsole();
	const [busy, setBusy] = useState(false);
	return (
		<div className="pointer-events-auto max-w-sm rounded-xl border bg-card/95 p-5 text-center shadow-md" data-testid="start-agents">
			<p className="text-sm font-semibold">No work yet</p>
			<p className="mt-1 text-xs text-muted-foreground">The decisions are accepted. Start the scenario and each agent gets a receipt of exactly what it was handed.</p>
			<UnavailableHint available={client.capabilities.start} reason="Starting is not available against the live Worker yet. Register the work items with POST /api/scenarios/:s/work-items; the agents start from there.">
				<Button
					className="mt-4"
					size="sm"
					disabled={busy || !client.capabilities.start}
					onClick={async () => {
						setBusy(true);
						const result = await onStart();
						setBusy(false);
						if (!result.ok) notify("danger", result.message ?? "Could not start.");
					}}
				>
					<Play aria-hidden /> Start the scenario
				</Button>
			</UnavailableHint>
		</div>
	);
}

/**
 * `N evaluated · K stale · M with no recorded dependency · time`: what the last decision change did, and how fast. When the change left
 * alone work that was already stale from an earlier one, those are counted apart (`K newly stale · J already stale ·
 * M with no recorded dependency`), so the numbers add up to the red cards on the graph.
 */
export function ResultsStrip({ evaluation, ms = evaluation?.ms ?? null, measuredHere = false }: { evaluation: Evaluation | null; ms?: number | null; measuredHere?: boolean }) {
	if (!evaluation) return null;
	const time = ms === null ? null : formatMs(ms);
	return (
		<div
			role="status"
			aria-label="Last evaluation"
			data-testid="results-strip"
			className="flex items-center gap-3 rounded-lg border bg-card/95 px-3 py-1 text-sm shadow-xs"
		>
			<Zap className="size-4 text-primary" aria-hidden />
			{evaluation.proseOnly ? (
				<>
					<span className="font-medium">{evaluation.recordRef ?? "Context"}: prose only</span>
					<Dot />
					<span className="tabular-nums">0 stale</span>
					<Dot />
					<span className="text-muted-foreground">nothing re-evaluated</span>
					<Badge tone="outline" className="font-mono">
						PROSE_ONLY
					</Badge>
				</>
			) : (
				<>
					<span className="font-medium tabular-nums">{plural(evaluation.evaluated, "item")} evaluated</span>
					<Dot />
					<span
						className={evaluation.stale > 0 ? "font-semibold text-danger tabular-nums" : "tabular-nums"}
						title={evaluation.alreadyStale > 0 ? "Went stale on this change. Some may have been stale for an earlier change too." : undefined}
					>
						{evaluation.stale} {evaluation.alreadyStale > 0 ? "newly stale" : "stale"}
					</span>
					{evaluation.alreadyStale > 0 && (
						<>
							<Dot />
							<span className="text-danger tabular-nums" title="Not touched by this change, but stale from an earlier one.">
								{evaluation.alreadyStale} already stale
							</span>
						</>
					)}
					<Dot />
					<span className="tabular-nums">{evaluation.untouched} with no recorded dependency</span>
					{time && (
						<>
							<Dot />
							<span
								className="text-muted-foreground tabular-nums"
								data-testid="results-time"
								title={measuredHere ? "Measured in this browser, from sending the change to this verdict arriving. Includes the network and the poller." : "Reconciler time for this evaluation"}
							>
								{time}
							</span>
						</>
					)}
				</>
			)}
		</div>
	);
}

function Dot() {
	return (
		<span className="text-muted-foreground" aria-hidden>
			·
		</span>
	);
}

function Legend() {
	return (
		<div className="pointer-events-none absolute bottom-3 left-[7.5rem] flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-xs" aria-label="Graph legend">
			<span className="inline-flex items-center gap-1.5">
				<svg width="26" height="6" aria-hidden>
					<line x1="0" y1="3" x2="26" y2="3" stroke="var(--muted-foreground)" strokeWidth="1.5" opacity="0.6" />
				</svg>
				relies on, still current
			</span>
			<span className="inline-flex items-center gap-1.5">
				<svg width="26" height="6" aria-hidden>
					<line x1="0" y1="3" x2="26" y2="3" stroke="var(--danger)" strokeWidth="2.5" strokeDasharray="7 4" />
				</svg>
				stale
			</span>
			<span className="inline-flex items-center gap-1.5">
				<svg width="26" height="6" aria-hidden>
					<line x1="0" y1="3" x2="26" y2="3" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeDasharray="2 4" />
				</svg>
				proposed
			</span>
		</div>
	);
}
