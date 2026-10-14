import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, type EdgeProps, type NodeProps } from "@xyflow/react";
import { FileText, GitBranch, Loader } from "lucide-react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { ActorChip, SeededBadge, statusMeta, StatusChip, useDegraded } from "@/components/status";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { agentModelFor, analysisOf, builtOnStamps, quietOf, readyByException, reasonSentences } from "@/state/derive";
import { useConsole } from "@/state/console-context";
import { scenarioMeta } from "./scenario-meta";
import { FIT, NODE_SIZE, TILE, type BaselineData, type ClusterData, type DependencyEdgeData, type ItemData, type RecordData } from "./graph-layout";

export function BaselineNode({ data }: NodeProps & { data: BaselineData }) {
	return (
		<div data-slot="baseline-node" style={{ width: NODE_SIZE.baseline.width }} className="rounded-xl border bg-card px-3.5 py-3 shadow-xs">
			<Handle type="source" position={Position.Right} id="out" />
			<div className="flex items-center gap-2">
				<GitBranch className="size-4 text-muted-foreground" aria-hidden />
				<span className="text-[15px] font-semibold">Baseline</span>
			</div>
			<p className="mt-1 text-[13px] text-muted-foreground">{data.scenario} · shared baseline</p>
			<p className="mt-1.5 font-mono text-[13px] text-muted-foreground">@ {shortHash(data.commit)}</p>
			<p className="text-[13px] text-muted-foreground">
				{data.promoted} of {data.total} merged
			</p>
		</div>
	);
}

export function RecordNode({ data }: NodeProps & { data: RecordData }) {
	return (
		<div
			data-slot="record-node"
			data-record={data.recordId}
			style={{ width: NODE_SIZE.record.width }}
			className={cn("rounded-xl border bg-card px-3.5 py-3 shadow-xs", data.proposedVersion !== null && "border-dashed")}
		>
			<Handle type="target" position={Position.Left} id="from-baseline" />
			<Handle type="target" position={Position.Right} id="dep-in" />
			<div className="flex items-center gap-2">
				<FileText className="size-4 text-muted-foreground" aria-hidden />
				<span className="min-w-0 truncate text-[15px] font-semibold">{data.recordId}</span>
				<Badge tone="primary" className="ml-auto text-[13px]" title="Accepted version">
					v{data.version}
				</Badge>
			</div>
			<p className="mt-1 text-[13px] text-muted-foreground">{data.priorVersion !== null ? `Updated from v${data.priorVersion}` : "Accepted decision"}</p>
			<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
				<span className="text-muted-foreground">{data.dependents} relying on it</span>
				{data.stale > 0 && (
					<Badge tone="danger" className="text-[13px]" data-testid={`stale-count-${data.recordId}`}>
						{data.stale} blocked
					</Badge>
				)}
				{data.proposedVersion !== null && (
					<Badge tone="outline" dashed className="text-[13px]">
						proposed v{data.proposedVersion}
					</Badge>
				)}
			</div>
		</div>
	);
}

export function WorkItemNode({ data }: NodeProps & { data: ItemData }) {
	const { wi, running, selected } = data;
	const { select, view, client } = useConsole();
	// Work that a change deliberately did not touch says so on the node, with the reason code. Not while the poller is degraded
	// (unknown is not unaffected), and not once the rules find something wrong with it.
	const degraded = useDegraded();
	const found = useMemo(() => quietOf(view, wi), [view, wi]);
	const quiet = degraded ? null : found;
	// Ready only because an accepted exception lifts a block: amber, not the green of cleanly ready work. Not while degraded (shown as unconfirmed).
	const excepted = useMemo(() => !degraded && readyByException(view, wi), [degraded, view, wi]);
	const builtOn = wi.receipt.accepted.map((entry) => `${entry.recordId}@${entry.version}`).join(" · ");
	const statusLabel = statusMeta(wi.item.status, degraded, quiet !== null, excepted).label;
	// Blocked on a changed decision: the card says which version it was built on and which is current, in words.
	const blockedBy = useMemo(() => {
		if (wi.item.status !== "stale" && wi.item.status !== "conflict") return null;
		const analysis = analysisOf(view, wi.item.id);
		const stamp = analysis ? builtOnStamps(analysis)[0] : undefined;
		return analysis && stamp ? { stamp, reasons: reasonSentences(view, analysis).join(" ") } : null;
	}, [view, wi.item.id, wi.item.status]);
	return (
		<div
			data-slot="work-item-node"
			data-work-item={wi.item.id}
			data-status={wi.item.status}
			role="button"
			tabIndex={0}
			aria-label={`${wi.item.id} ${wi.item.title}, ${statusLabel}`}
			aria-pressed={selected}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					select(wi.item.id);
				}
			}}
			style={{ width: NODE_SIZE.item.width, height: NODE_SIZE.item.height }}
			className={cn(
				"flex flex-col justify-between rounded-xl border bg-card px-3.5 py-2.5 shadow-xs transition-shadow outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
				selected && "shadow-md ring-2 ring-primary",
			)}
		>
			<Handle type="source" position={Position.Left} id="dep" />
			<div className="flex items-center gap-2">
				<span className="font-mono text-[13px] font-semibold">{wi.item.id}</span>
				{running && <Loader className="size-3.5 shrink-0 text-info motion-safe:animate-spin" aria-hidden />}
				<ActorChip actor={wi.item.actor} label={scenarioMeta(client.scenario, client.kind === "live").agentLabel ?? agentModelFor(view, wi.item.id) ?? undefined} className="min-w-0 text-[13px]" />
				<StatusChip status={wi.item.status} leftAlone={quiet !== null} excepted={excepted} className="ml-auto text-[13px]" />
			</div>
			<p className="truncate leading-tight font-semibold" style={{ fontSize: FIT.itemTitlePx }} title={wi.item.title}>
				{wi.item.title}
			</p>
			{quiet ? (
				<p data-testid={`left-alone-${wi.item.id}`} className="truncate text-[13px] font-medium text-success" title={`${quiet.message} (${quiet.reasonCodes.join(", ")})`}>
					Left alone: no recorded dependency on what changed
				</p>
			) : blockedBy ? (
				<p data-testid={`built-on-${wi.item.id}`} className="truncate text-[13px] font-medium text-danger" title={blockedBy.reasons}>
					{blockedBy.stamp}
				</p>
			) : (
				<p className="truncate font-mono text-[12.5px] text-muted-foreground" title={`Built on ${builtOn || "nothing yet"}`}>
					built on: {builtOn || "nothing yet"}
				</p>
			)}
		</div>
	);
}

/** The fan-out: many synthetic work items in one compact grid, each tile clickable and labelled. */
export function ClusterNode({ data }: NodeProps & { data: ClusterData }) {
	const { select, view } = useConsole();
	const degraded = useDegraded();
	const counts = data.items.reduce<Record<string, number>>((acc, wi) => {
		const label = statusMeta(wi.item.status, degraded, false, readyByException(view, wi)).label.toLowerCase();
		return { ...acc, [label]: (acc[label] ?? 0) + 1 };
	}, {});
	return (
		<div data-slot="cluster-node" className="rounded-xl border border-dashed bg-card/70 shadow-xs" style={{ width: data.columns * TILE.width + (data.columns - 1) * TILE.gap + TILE.pad * 2 }}>
			<Handle type="source" position={Position.Left} id="dep" />
			<div className="flex items-center gap-2 px-3 pt-3">
				<SeededBadge />
				<span className="text-[15px] font-semibold">{data.items.length} seeded work items</span>
			</div>
			<p className="px-3 pb-2.5 text-[13px] text-muted-foreground">
				Synthetic, no model behind them.{" "}
				{Object.entries(counts)
					.map(([status, n]) => `${n} ${status}`)
					.join(" · ")}
			</p>
			<div className="nodrag nopan grid px-3 pb-3" style={{ gridTemplateColumns: `repeat(${data.columns}, ${TILE.width}px)`, gap: TILE.gap }}>
				{data.items.map((wi) => {
					const meta = statusMeta(wi.item.status, degraded, false, readyByException(view, wi));
					const Icon = meta.icon;
					return (
						<button
							key={wi.item.id}
							type="button"
							data-work-item={wi.item.id}
							data-status={wi.item.status}
							aria-label={`${wi.item.id}, seeded, ${meta.label}`}
							aria-pressed={data.selectedId === wi.item.id}
							title={`${wi.item.id} (seeded) · ${meta.description}`}
							onClick={() => select(wi.item.id)}
							style={{ height: TILE.height }}
							className={cn(
								"flex flex-col justify-center gap-0.5 rounded-md border border-dashed px-2 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
								toneClass(meta.tone),
								data.selectedId === wi.item.id && "border-solid ring-2 ring-primary",
							)}
						>
							<span className="font-mono text-[12px] leading-[16px] font-semibold">{wi.item.id}</span>
							<span className="flex items-center gap-1 text-[12px] leading-[16px] font-medium">
								<Icon className="size-3 shrink-0" aria-hidden />
								<span className="truncate">{meta.label}</span>
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function toneClass(tone: ReturnType<typeof statusMeta>["tone"]): string {
	switch (tone) {
		case "danger":
			return "border-danger/40 bg-danger-soft text-danger";
		case "success":
			return "border-success/30 bg-success-soft text-success";
		case "warning":
			return "border-warning/35 bg-warning-soft text-warning";
		case "info":
			return "border-info/30 bg-info-soft text-info";
		case "merged":
			return "border-merged/30 bg-merged-soft text-merged";
		case "primary":
			return "border-primary/30 bg-accent text-accent-foreground";
		default:
			return "border-border bg-muted text-muted-foreground";
	}
}

/**
 * A dependency edge. Accepted and fresh: thin and neutral. Stale: red and dashed, with a text
 * label (never color alone). Proposed: dashed and neutral. Excepted: amber and dashed.
 */
export function DependencyEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps & { data?: DependencyEdgeData }) {
	const kind = data?.kind ?? "ok";
	const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.35 });
	const style =
		kind === "stale"
			? { stroke: "var(--danger)", strokeWidth: 2.5, strokeDasharray: "9 6" }
			: kind === "excepted"
				? { stroke: "var(--warning)", strokeWidth: 2, strokeDasharray: "9 6" }
				: kind === "proposed"
					? { stroke: "var(--muted-foreground)", strokeWidth: 1.5, strokeDasharray: "3 5" }
					: { stroke: "var(--muted-foreground)", strokeWidth: 1.5, opacity: 0.55 };
	return (
		<>
			<BaseEdge id={id} path={path} style={style} className={cn(data?.flash && "edge-stale-flash")} />
			{data?.label && (
				<EdgeLabelRenderer>
					<div
						className="nodrag nopan pointer-events-none absolute"
						style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
						data-edge-label={kind}
					>
						<Badge tone={kind === "stale" ? "danger" : kind === "excepted" ? "warning" : "outline"} dashed={kind !== "ok"} className="bg-card shadow-xs">
							{data.label}
						</Badge>
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
}
