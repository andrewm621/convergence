import { CircleCheck } from "lucide-react";
import { useMemo } from "react";
import { newIdempotencyKey } from "@/client/types";
import { SeededBadge, useDegraded } from "@/components/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { quietOf, readyByException, runningAgents } from "@/state/derive";
import { groupByTray, rowReason, TRAY_LABEL, TRAYS, type Tray } from "@/state/trays";
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
 * The results strip from the last decision change sits in its header, so the fan-out count is always in view.
 */
export function Home({ tray, onTray }: { tray: Tray; onTray(next: Tray): void }) {
	const { view, client, select } = useConsole();
	const degraded = useDegraded();
	const groups = useMemo(() => groupByTray(view, degraded), [view, degraded]);
	const running = useMemo(() => runningAgents(view.ledger), [view.ledger]);
	const seeded = Object.values(view.workItems).filter((wi) => wi.item.source === "seeded").length;
	const hasRecords = Object.keys(view.records).length > 0;
	const hasWork = Object.keys(view.workItems).length > 0;

	return (
		<section aria-label="Home" className="flex min-h-0 flex-1 flex-col" data-testid="home">
			<PaneHeader title="Work" subtitle="What needs you, and where the rest stands">
				<CurrentResultsStrip />
			</PaneHeader>
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
										name === "needs-you" && count > 0 ? "bg-danger-soft text-danger ring-1 ring-danger/35" : "bg-muted text-muted-foreground",
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
					{TRAYS.map((name) => (
						<TabsContent key={name} value={name} className="p-4">
							{groups[name].length === 0 ? (
								hasWork && <EmptyTray tray={name} />
							) : (
								<ul className="space-y-2" aria-label={TRAY_LABEL[name]}>
									{groups[name].map((wi) => (
										<TrayRow
											key={wi.item.id}
											wi={wi}
											tray={name}
											reason={rowReason(view, wi, degraded)}
											leftAlone={!degraded && quietOf(view, wi) !== null}
											excepted={!degraded && readyByException(view, wi)}
											running={running.has(wi.item.id)}
											onOpen={select}
										/>
									))}
								</ul>
							)}
						</TabsContent>
					))}
				</div>
			</Tabs>
		</section>
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
