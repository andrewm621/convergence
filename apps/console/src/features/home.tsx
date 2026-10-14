import type { WorkItemState } from "contracts";
import { CircleCheck, Zap } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { newIdempotencyKey } from "@/client/types";
import { SeededBadge, useDegraded } from "@/components/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { builtOnRows } from "@/state/built-on";
import { useConsole } from "@/state/console-context";
import { currentEvaluation, quietOf, readyByException, runningAgents } from "@/state/derive";
import { changeSummary, groupByTray, historyOf, notAffected, rowReason, TRAY_LABEL, TRAYS, type Tray } from "@/state/trays";
import { PaneHeader } from "./context-timeline";
import { TrayRow } from "./tray-row";
import { CurrentResultsStrip, StartAgents } from "./work-graph";

const EMPTY: Record<Tray, { title: string; note: string }> = {
	"needs-you": { title: "Nothing needs you right now.", note: "When a decision changes under work in progress, that work shows up here." },
	working: { title: "No agents are working.", note: "Work that is running, re-running or not ready yet sits here." },
	ready: { title: "Nothing is ready to merge.", note: "Work that passes the merge check waits here for a person to merge it." },
	merged: { title: "Nothing merged yet.", note: "Merged and rejected work ends up here." },
};

/**
 * The Work view's home: one "Needs you" list of one-line rows, with Working, Ready and Merged as tabs with counts.
 * Needs you also lists work that is ready to merge (the last click is a person's), and keeps work the last change
 * left alone in view, muted. The results strip from the last decision change sits in its header.
 */
export function Home({ tray, onTray }: { tray: Tray; onTray(next: Tray): void }) {
	const { view, client, select, setTab } = useConsole();
	const degraded = useDegraded();
	const groups = useMemo(() => groupByTray(view, degraded), [view, degraded]);
	const quiet = useMemo(() => notAffected(view, degraded), [view, degraded]);
	const running = useMemo(() => runningAgents(view.ledger), [view.ledger]);
	const seeded = Object.values(view.workItems).filter((wi) => wi.item.source === "seeded").length;
	const hasRecords = Object.keys(view.records).length > 0;
	const hasWork = Object.keys(view.workItems).length > 0;

	// An item page always opens on its first tab, whatever was open last.
	function open(id: string) {
		setTab("why");
		select(id);
	}

	function row(wi: WorkItemState, name: Tray, options: { muted?: boolean } = {}) {
		const settings = name === "needs-you" ? builtOnRows(view, wi).flatMap((r) => r.changedSettings) : [];
		return (
			<TrayRow
				key={wi.item.id}
				wi={wi}
				tray={name}
				reason={rowReason(view, wi, degraded)}
				leftAlone={!degraded && quietOf(view, wi) !== null}
				excepted={!degraded && readyByException(view, wi)}
				running={running.has(wi.item.id)}
				onOpen={open}
				settings={settings}
				muted={options.muted}
			/>
		);
	}

	const needsYou = groups["needs-you"];
	const ready = groups.ready;
	const resolved = needsYou.length === 0 && ready.length === 0 && groups.merged.length > 0;

	return (
		<section aria-label="Home" className="flex min-h-0 flex-1 flex-col" data-testid="home">
			<PaneHeader title="Work" subtitle="What needs you, and where the rest stands">
				<CurrentResultsStrip />
			</PaneHeader>
			<SummaryBand />
			<Tabs value={tray} onValueChange={(value) => onTray(value as Tray)} className="min-h-0 flex-1">
				<TabsList className="gap-1 px-4" aria-label="Trays">
					{TRAYS.map((name) => {
						const count = groups[name].length;
						return (
							<TabsTrigger key={name} value={name} className="h-10 px-3 text-sm" data-tray={name}>
								{TRAY_LABEL[name]}
								<span
									data-testid={`tray-count-${name}`}
									className={cn(
										"min-w-5 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums",
										count === 0
											? "bg-muted text-muted-foreground"
											: name === "needs-you"
												? "bg-danger-soft text-danger ring-1 ring-danger/35"
												: name === "ready"
													? "bg-primary/15 text-primary ring-1 ring-primary/35"
													: "bg-muted text-muted-foreground",
									)}
								>
									{count}
								</span>
							</TabsTrigger>
						);
					})}
				</TabsList>
				<div className="min-h-0 flex-1 overflow-y-auto">
					{seeded > 0 && (
						<div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-dashed bg-card/90 px-3 py-1.5 text-xs" data-testid="seeded-banner">
							<SeededBadge />
							<span>Synthetic work items. No model is behind them.</span>
						</div>
					)}
					{view.ready && hasRecords && !hasWork && (
						<div className="grid place-items-center p-6">
							<StartAgents onStart={() => client.api.startScenario(newIdempotencyKey())} />
						</div>
					)}
					<TabsContent value="needs-you" className="space-y-5 p-4">
						{needsYou.length > 0 && (
							<ul className="space-y-2" aria-label="Needs you">
								{needsYou.map((wi) => row(wi, "needs-you"))}
							</ul>
						)}
						{ready.length > 0 && (
							<Subsection title="Ready to merge" testId="needs-you-ready">
								<ul className="space-y-2" aria-label="Ready to merge">
									{ready.map((wi) => row(wi, "ready"))}
								</ul>
							</Subsection>
						)}
						{needsYou.length === 0 && ready.length === 0 && hasWork && (resolved ? <Resolved items={groups.merged} onOpen={open} /> : <EmptyTray tray="needs-you" />)}
						{quiet.length > 0 && (
							<Subsection title="Not affected: nothing they rely on changed" testId="not-affected">
								<ul className="space-y-1.5" aria-label="Not affected">
									{quiet.map((wi) => row(wi, "working", { muted: true }))}
								</ul>
							</Subsection>
						)}
					</TabsContent>
					{TRAYS.filter((name) => name !== "needs-you").map((name) => (
						<TabsContent key={name} value={name} className="p-4">
							{groups[name].length === 0 ? (
								hasWork && <EmptyTray tray={name} />
							) : (
								<ul className="space-y-2" aria-label={TRAY_LABEL[name]}>
									{groups[name].map((wi) => row(wi, name))}
								</ul>
							)}
						</TabsContent>
					))}
				</div>
			</Tabs>
		</section>
	);
}

/** One line on the last decision change: "notifications v2 landed · 2 settings changed: cadence, default · 1 blocked · 1 left alone". */
function SummaryBand() {
	const { view } = useConsole();
	const summary = changeSummary(view);
	const evaluation = currentEvaluation(view);
	if (!summary || !evaluation) return null;
	const parts = [summary.lead, summary.detail, evaluation.proseOnly ? null : `${evaluation.stale} blocked · ${evaluation.untouched} left alone`].filter(Boolean);
	return (
		<p className="flex shrink-0 items-center gap-2 border-b bg-card/60 px-4 py-2 text-sm" data-testid="change-summary">
			<Zap className="size-4 shrink-0 text-primary" aria-hidden />
			<span className="font-semibold">{parts[0]}</span>
			{parts.slice(1).map((part) => (
				<span key={part} className="text-muted-foreground">
					· {part}
				</span>
			))}
		</p>
	);
}

function Subsection({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
	return (
		<div className="space-y-2" data-testid={testId}>
			<h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
			{children}
		</div>
	);
}

/** Nothing left to do and something merged: say what was resolved. */
function Resolved({ items, onOpen }: { items: WorkItemState[]; onOpen(id: string): void }) {
	const { view } = useConsole();
	return (
		<div className="space-y-3 rounded-xl border border-success/30 bg-success/5 p-4" data-testid="resolved">
			<p className="flex items-center gap-2 text-sm font-semibold">
				<CircleCheck className="size-4 text-success" aria-hidden />
				Nothing needs you. Resolved:
			</p>
			<ul className="space-y-1.5" aria-label="Resolved">
				{items.map((wi) => {
					const history = historyOf(view, wi.item.id);
					return (
						<li key={wi.item.id}>
							<button type="button" onClick={() => onOpen(wi.item.id)} className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-[13px] outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
								<CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
								<span className="font-mono text-xs font-semibold">{wi.item.id}</span>
								<span className="min-w-0 truncate">{wi.item.title}</span>
								<span className="ml-auto shrink-0 text-muted-foreground" data-testid={`resolved-${wi.item.id}`}>
									{history.length > 0 ? history.join(", ") : wi.item.status === "rejected" ? "rejected" : "merged"}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function EmptyTray({ tray }: { tray: Tray }) {
	const { title, note } = EMPTY[tray];
	return (
		<div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed p-8 text-center" data-testid={`empty-${tray}`}>
			{tray === "needs-you" && <CircleCheck className="mb-1 size-6 text-success" aria-hidden />}
			<p className="text-sm font-semibold">{title}</p>
			<p className="max-w-sm text-[13px] text-muted-foreground">{note}</p>
		</div>
	);
}
