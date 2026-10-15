import { useEffect, useMemo, useRef } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { processLanes, type LaneSpan, type MarkTone, type ProcessLane, type ProcessMark } from "@/state/process-lanes";
import { PaneHeader } from "./context-timeline";

const LABEL_W = 208;
const COL_W = 116;
/** Where a lane's line runs, from the top of its row; marks hang their text below it. */
const LINE_Y = 22;

const DOT: Record<MarkTone, string> = {
	neutral: "bg-foreground/70",
	danger: "bg-danger",
	success: "bg-success",
	info: "bg-info",
	muted: "border-2 border-muted-foreground bg-background",
};

const TEXT: Record<MarkTone, string> = {
	neutral: "text-foreground",
	danger: "text-danger",
	success: "text-success",
	info: "text-info",
	muted: "text-muted-foreground",
};

/**
 * Process: one lane per work item, ledger order left to right. A thin line crosses every lane where a decision changed;
 * the lanes that relied on it go red there, the others do not. Read from the ledger alone, so a replay and a live cell draw alike.
 */
export function ProcessView() {
	const { view } = useConsole();
	const model = useMemo(() => processLanes({ ledger: view.ledger, workItems: view.workItems }), [view.ledger, view.workItems]);
	const width = model.columns.length * COL_W;
	const scroller = useRef<HTMLDivElement>(null);
	const lastWidth = useRef(0);

	// New steps land on the right: follow them, unless the reader has scrolled back to look at something earlier.
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const wasAtEnd = el.scrollLeft + el.clientWidth >= lastWidth.current + LABEL_W - 8;
		if (wasAtEnd) el.scrollLeft = el.scrollWidth;
		lastWidth.current = width;
	}, [width]);

	return (
		<section aria-label="Process" data-testid="process-view" className="flex min-h-0 flex-1 flex-col">
			<PaneHeader title="Process" subtitle="What each agent did, in ledger order" />
			{model.empty ? (
				<p className="px-4 py-4 text-sm text-muted-foreground" data-testid="process-empty">
					No agent activity yet.
				</p>
			) : (
				<div ref={scroller} className="min-h-0 flex-1 overflow-auto" data-testid="process-scroll">
					<div className="relative" style={{ width: LABEL_W + width, minWidth: "100%" }}>
						<div className="flex h-9 items-end border-b" aria-hidden={model.decisions.length === 0}>
							<div className="sticky left-0 z-20 h-full shrink-0 bg-background" style={{ width: LABEL_W }} />
							<div className="relative h-full" style={{ width }}>
								{model.decisions.map((d) => (
									<span key={`${d.seq}:${d.recordId}`} data-testid="decision-label" className="absolute bottom-1.5 pl-1.5 text-xs font-medium whitespace-nowrap" style={{ left: d.column * COL_W + COL_W / 2 }}>
										{d.label}
									</span>
								))}
							</div>
						</div>
						{model.lanes.map((lane) => (
							<Lane key={lane.workItemId} lane={lane} width={width} />
						))}
						<div className="flex h-8 items-center">
							<div className="sticky left-0 z-20 flex h-full shrink-0 items-center bg-background px-4 text-xs text-muted-foreground" style={{ width: LABEL_W }}>
								Time since first line
							</div>
							<div className="relative h-full" style={{ width }}>
								{model.columns.map((c, i) => (
									<span key={c.seq} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground" style={{ left: i * COL_W + COL_W / 2 }}>
										{c.relative ?? `#${c.seq}`}
									</span>
								))}
							</div>
						</div>
						{/* The decision lines sit over the lanes, behind the marks. */}
						<div className="pointer-events-none absolute inset-y-0 bottom-8 z-0" style={{ left: LABEL_W, width }} aria-hidden>
							{model.decisions.map((d) => (
								<div key={`${d.seq}:${d.recordId}`} data-testid="decision-line" className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: d.column * COL_W + COL_W / 2 }} />
							))}
						</div>
					</div>
				</div>
			)}
		</section>
	);
}

function Lane({ lane, width }: { lane: ProcessLane; width: number }) {
	return (
		<div data-testid="process-lane" data-work-item={lane.workItemId} className="flex min-h-[88px] border-b">
			<div className="sticky left-0 z-20 shrink-0 bg-background px-4 pt-3" style={{ width: LABEL_W }}>
				<div className="line-clamp-2 text-[13px] leading-snug font-medium" title={lane.title}>
					{lane.title}
				</div>
				{lane.agent && <div className="truncate text-xs text-muted-foreground">{lane.agent}</div>}
			</div>
			<div className="relative z-10" style={{ width }}>
				<div className="absolute inset-x-0 h-px bg-border" style={{ top: LINE_Y }} />
				{lane.spans.map((span, i) => (
					<Span key={i} span={span} />
				))}
				{lane.marks.map((mark) => (
					<Mark key={mark.id} mark={mark} lane={lane} />
				))}
			</div>
		</div>
	);
}

function Span({ span }: { span: LaneSpan }) {
	return (
		<div
			data-testid={`span-${span.kind}`}
			className={cn("absolute h-[3px] -translate-y-px rounded-full", span.kind === "blocked" ? "bg-danger/60" : "bg-foreground/15")}
			style={{ top: LINE_Y, left: span.from * COL_W + COL_W / 2, width: Math.max((span.to - span.from) * COL_W, 0) }}
		/>
	);
}

function Mark({ mark, lane }: { mark: ProcessMark; lane: ProcessLane }) {
	const summary = [mark.label, ...mark.detail].join(", ");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					data-testid="process-mark"
					data-kind={mark.kind}
					data-tone={mark.tone}
					data-seq={mark.seq}
					aria-label={`${lane.title}: ${summary}. Ledger line ${mark.seq}, ${mark.line.type}.`}
					className="absolute flex flex-col items-center rounded-md px-1 pb-1 text-center outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
					style={{ top: LINE_Y - 6, left: mark.column * COL_W, width: COL_W }}
				>
					<span className={cn("size-3 shrink-0 rounded-full ring-4 ring-background", DOT[mark.tone])} />
					<span className={cn("mt-1.5 bg-background px-1 text-xs leading-tight font-medium", TEXT[mark.tone])}>{mark.label}</span>
					{mark.detail.map((line) => (
						<span key={line} className="max-w-full bg-background px-1 text-[11px] leading-tight break-words text-muted-foreground">
							{line}
						</span>
					))}
				</button>
			</TooltipTrigger>
			<TooltipContent>
				<div className="font-mono">
					{mark.line.type} · #{mark.line.seq} · {shortHash(mark.line.hash)}
				</div>
				{mark.reasonCodes.length > 0 && <div className="mt-1 font-mono text-muted-foreground">{mark.reasonCodes.join(" · ")}</div>}
			</TooltipContent>
		</Tooltip>
	);
}
