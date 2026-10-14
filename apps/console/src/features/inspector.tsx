import type { WorkItemState } from "contracts";
import { MousePointerClick } from "lucide-react";
import { useMemo } from "react";
import { ActorChip, RunningDot, SeededBadge, StatusChip, useDegraded } from "@/components/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";
import { useConsole, type InspectorTab } from "@/state/console-context";
import { agentModelOf, analysisOf, hasProblem, mergeRecord, quietOf, readyByException, runningAgents, workItemsSorted } from "@/state/derive";
import { useGate } from "@/state/use-gate";
import { PaneHeader } from "./context-timeline";
import { ActionsTab } from "./inspector-actions";
import { ChangesTab, ReceiptTab, SemanticTab } from "./inspector-tabs";
import { WhyTab } from "./inspector-why";
import { PromoteButton } from "./promote-button";
import { scenarioMeta } from "./scenario-meta";

const TAB_CLASS = "h-auto min-h-9 min-w-0 shrink flex-1 px-1.5 py-1 text-center text-[12.5px] leading-tight whitespace-normal";

export function Inspector() {
	const { view, selectedId } = useConsole();
	const wi = selectedId ? view.workItems[selectedId] : undefined;
	return (
		<section aria-label="Selected work" className="flex min-h-0 min-w-0 flex-1 flex-col">
			<PaneHeader title={wi ? wi.item.title : "Work item"} subtitle={wi ? wi.item.id : "Select one on the graph"} truncateTitle />
			{wi ? <WorkItemInspector wi={wi} /> : <NothingSelected />}
		</section>
	);
}

function NothingSelected() {
	const { view, select } = useConsole();
	const degraded = useDegraded();
	const items = workItemsSorted(view).filter((wi) => wi.item.source !== "seeded");
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
			<div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
				<MousePointerClick className="size-5" aria-hidden />
			</div>
			<p className="text-sm font-semibold">Pick a work item</p>
			<p className="max-w-xs text-[13px] text-muted-foreground">Click one in the graph to see what it was given, what it claims, what Convergence checked, and why Merge is open or closed.</p>
			{items.length > 0 && (
				<ul className="flex flex-wrap justify-center gap-2" aria-label="Work items">
					{items.map((wi) => (
						<li key={wi.item.id}>
							<button type="button" onClick={() => select(wi.item.id)} className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
								<span className="font-mono font-semibold">{wi.item.id}</span>
								<StatusChip status={wi.item.status} excepted={!degraded && readyByException(view, wi)} />
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function WorkItemInspector({ wi }: { wi: WorkItemState }) {
	const { view, tab, setTab, client } = useConsole();
	const { gate } = useGate(wi.item.id);
	const degraded = useDegraded();
	const running = useMemo(() => runningAgents(view.ledger).has(wi.item.id), [view.ledger, wi.item.id]);
	// "Why blocked?" only when the rules found something wrong; an item that has simply not pushed yet is not blocked.
	const analysis = useMemo(() => analysisOf(view, wi.item.id), [view, wi.item.id]);
	const blocked = wi.item.status !== "promoted" && gate !== null && !gate.pass && analysis !== null && hasProblem(analysis);
	const found = useMemo(() => quietOf(view, wi), [view, wi]);
	const quiet = degraded ? null : found;
	// Ready only because an accepted exception lifts a block: amber, and it says so.
	const excepted = !degraded && readyByException(view, wi);
	const merged = wi.item.status === "promoted" ? mergeRecord(view, wi.item.id) : null;
	// A blocked item whose agent is still going would read "Blocked" and "agent running" at once: say what the agent is doing.
	const stillWorking = running && (wi.item.status === "stale" || wi.item.status === "conflict");

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="inspector" data-work-item={wi.item.id}>
			<div className="space-y-2.5 border-b px-4 py-3.5">
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs font-semibold text-muted-foreground">{wi.item.id}</span>
					{wi.item.source === "seeded" && <SeededBadge />}
					{running && <RunningDot label={stillWorking ? "Agent still working" : "Agent working"} />}
				</div>
				<h2 className="text-[15px] leading-snug font-semibold">{wi.item.title}</h2>
				<div className="flex flex-wrap items-center gap-2">
					<StatusChip status={wi.item.status} leftAlone={quiet !== null} excepted={excepted} />
					<ActorChip actor={wi.item.actor} label={scenarioMeta(client.scenario, client.kind === "live").agentLabel ?? agentModelOf(view.ledger, wi.item.id) ?? undefined} />
					<PromoteButton workItemId={wi.item.id} className="ml-auto" />
				</div>
				{merged && (
					<p className="text-[13px] text-muted-foreground" data-testid="merged-by">
						Merged{merged.by ? ` by ${merged.by}` : ""} at {formatDateTime(merged.ts)}
					</p>
				)}
			</div>

			<Tabs value={tab} onValueChange={(value) => setTab(value as InspectorTab)} className="min-h-0 flex-1">
				{/* Five tabs share the width and wrap onto a second line, so none is clipped at the narrowest inspector (400 px). */}
				<TabsList className="items-stretch gap-0 overflow-x-hidden px-1">
					<TabsTrigger value="why" className={TAB_CLASS}>
						{blocked ? "Why blocked?" : "Why"}
					</TabsTrigger>
					<TabsTrigger value="receipt" className={TAB_CLASS}>
						What it was given
					</TabsTrigger>
					<TabsTrigger value="semantic" className={TAB_CLASS}>
						Claims vs decision
					</TabsTrigger>
					<TabsTrigger value="changes" className={TAB_CLASS}>
						Changes
					</TabsTrigger>
					<TabsTrigger value="actions" className={TAB_CLASS}>
						Actions
					</TabsTrigger>
				</TabsList>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<TabsContent value="why">
						<WhyTab wi={wi} />
					</TabsContent>
					<TabsContent value="receipt">
						<ReceiptTab wi={wi} />
					</TabsContent>
					<TabsContent value="semantic">
						<SemanticTab wi={wi} />
					</TabsContent>
					<TabsContent value="changes">
						<ChangesTab wi={wi} />
					</TabsContent>
					<TabsContent value="actions">
						<ActionsTab wi={wi} />
					</TabsContent>
				</div>
			</Tabs>
		</div>
	);
}
