import type { WorkItemState } from "contracts";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { ActorChip, RunningDot, SeededBadge, StatusChip, useDegraded } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole, type InspectorTab } from "@/state/console-context";
import { agentModelFor, analysisOf, hasProblem, mergeRecord, quietOf, readyByException, runningAgents, validExceptions } from "@/state/derive";
import type { ViewState } from "@/state/store";
import { useGate } from "@/state/use-gate";
import type { Analysis } from "delta-core";
import { BuiltOnRows } from "./built-on-rows";
import { DependencyDecision } from "./dependency-decision";
import { ActionsTab, Resolutions } from "./inspector-actions";
import { ChangesTab, ReceiptTab, SemanticTab } from "./inspector-tabs";
import { WhyTab } from "./inspector-why";
import { PromoteButton } from "./promote-button";
import { scenarioMeta } from "./scenario-meta";
import { CurrentResultsStrip } from "./work-graph";

type Verdict = { text: string; tone: "danger" | "warning" | "success" | "neutral" };

/** One sentence on where the work stands. The Why tab carries the detail. */
export function verdictOf(view: ViewState, wi: WorkItemState, analysis: Analysis | null, degraded: boolean): Verdict {
	const status = wi.item.status;
	if (status === "promoted") {
		const merged = mergeRecord(view, wi.item.id);
		return { text: `Merged${merged?.by ? ` by ${merged.by}` : ""}${merged ? ` at ${formatDateTime(merged.ts)}` : ""}.`, tone: "neutral" };
	}
	if (status === "rejected") return { text: "Rejected. It won't be merged.", tone: "neutral" };
	if (degraded && (status === "fresh" || status === "ready")) return { text: "Unconfirmed: the poller is behind, so Convergence can't confirm this is built on the current decisions.", tone: "warning" };
	if (status === "revalidating") return { text: "Re-running on the current decisions. Merge stays closed until the agent pushes again.", tone: "neutral" };
	if (status === "uncertain") {
		const outside = analysis?.outsideReceipt[0];
		return {
			text: outside ? `Held: its claims rely on ${outside.recordId}, which it wasn't given. Reject or accept that dependency below.` : "Held: Convergence can't tell whether this is built on the current decisions.",
			tone: "warning",
		};
	}
	if (status === "stale" || status === "conflict") {
		if (analysis && analysis.stale.length > 0) return { text: "Blocked: it was built on a decision that has since changed.", tone: "danger" };
		if (analysis && analysis.conflicts.length > 0) return { text: "Blocked: what it says it built doesn't match the current decision.", tone: "danger" };
		if (analysis && analysis.failedChecks.length > 0) return { text: "Blocked: a check on this work is failing.", tone: "danger" };
		return { text: "Blocked from merging.", tone: "danger" };
	}
	if (status === "ready") {
		if (readyByException(view, wi)) {
			const exception = validExceptions(view, wi)[0];
			return { text: `Ready to merge with an exception from ${exception?.signer ?? "a person"}. A person still decides.`, tone: "warning" };
		}
		return { text: "Ready to merge. It passed the merge check; a person decides.", tone: "success" };
	}
	if (quietOf(view, wi)) return { text: "Left alone: the last decision change didn't touch anything it relies on.", tone: "success" };
	if (status === "fresh") return { text: "Up to date, but not ready to merge yet.", tone: "neutral" };
	return { text: wi.headSha === null ? "The agent is working. Nothing pushed yet." : "The agent is working.", tone: "neutral" };
}

const VERDICT_TONE: Record<Verdict["tone"], string> = {
	danger: "text-danger",
	warning: "text-warning",
	success: "text-success",
	neutral: "text-foreground",
};

/**
 * A work item as a page, like a pull request: the verdict and the one thing to do at the top, then what it was built on,
 * then the same tabs as the side pane, opening on "Why blocked?". Spans the centre and right of the Work view.
 */
export function ItemPage({ wi, backLabel, onBack }: { wi: WorkItemState; backLabel: string; onBack(): void }) {
	const { view, tab, setTab, client } = useConsole();
	const { gate } = useGate(wi.item.id);
	const degraded = useDegraded();
	const [more, setMore] = useState(false);
	const analysis = useMemo(() => analysisOf(view, wi.item.id), [view, wi.item.id]);
	const running = useMemo(() => runningAgents(view.ledger).has(wi.item.id), [view.ledger, wi.item.id]);
	const quiet = useMemo(() => (degraded ? null : quietOf(view, wi)), [view, wi, degraded]);
	const excepted = !degraded && readyByException(view, wi);
	const verdict = verdictOf(view, wi, analysis, degraded);
	const status = wi.item.status;
	const blocked = status !== "promoted" && gate !== null && !gate.pass && analysis !== null && hasProblem(analysis);
	const needsYou = status === "stale" || status === "conflict" || status === "uncertain";
	const done = status === "promoted" || status === "rejected";
	// Held on a dependency it was never given: the dependency question is the action, not Revalidate.
	const undeclared =
		!done && (analysis?.outsideReceipt ?? []).some((o) => view.dependencies.some((d) => d.workItemId === wi.item.id && d.recordId === o.recordId && d.status === "proposed"));
	const stillWorking = running && (status === "stale" || status === "conflict");

	return (
		<section aria-label="Selected work" className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="item-page" data-work-item={wi.item.id}>
			<div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-4 py-1.5">
				<Button variant="ghost" size="sm" onClick={onBack} className="-ml-2" data-testid="item-back">
					<ArrowLeft aria-hidden /> {backLabel}
				</Button>
				<div className="ml-auto">
					<CurrentResultsStrip />
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-4xl space-y-5 px-6 py-5">
					<header className="space-y-2">
						<div className="flex items-center gap-2">
							<span className="font-mono text-xs font-semibold text-muted-foreground">{wi.item.id}</span>
							{wi.item.source === "seeded" && <SeededBadge />}
							{running && <RunningDot label={stillWorking ? "Agent still working" : "Agent working"} />}
						</div>
						<h2 className="text-xl leading-snug font-semibold tracking-tight">{wi.item.title}</h2>
						<div className="flex flex-wrap items-center gap-2">
							<StatusChip status={status} leftAlone={quiet !== null} excepted={excepted} />
							<ActorChip actor={wi.item.actor} label={scenarioMeta(client.scenario, client.kind === "live").agentLabel ?? agentModelFor(view, wi.item.id) ?? undefined} />
						</div>
						<p className={cn("text-[15px] font-medium", VERDICT_TONE[verdict.tone])} data-testid="item-verdict">
							{verdict.text}
						</p>
					</header>

					{/* Renders nothing unless there is an open dependency question, or one was just answered here. */}
					{!done && <DependencyDecision workItemId={wi.item.id} />}

					{!done && (
						<div className="space-y-3 rounded-xl border bg-card p-4" data-testid="item-actions">
							<div className="flex flex-wrap items-start gap-3">
								{needsYou && !undeclared ? (
									<div className="min-w-0 flex-1">
										<Resolutions wi={wi} show="revalidate" />
									</div>
								) : (
									<p className="min-w-0 flex-1 pt-1 text-[13px] text-muted-foreground">
										{undeclared ? "Answer the dependency question above first." : status === "ready" ? "Merge asks you to confirm, then checks again before it merges." : "Merge opens once the work passes the merge check."}
									</p>
								)}
								<PromoteButton workItemId={wi.item.id} />
							</div>
							<div>
								<Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" aria-expanded={more} onClick={() => setMore((open) => !open)} data-testid="item-more">
									{more ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
									More
								</Button>
								{more && (
									<div className="mt-2">
										<Resolutions wi={wi} show="more" />
									</div>
								)}
							</div>
						</div>
					)}

					<BuiltOnRows wi={wi} />

					<Tabs value={tab} onValueChange={(value) => setTab(value as InspectorTab)} className="rounded-xl border bg-card">
						<TabsList className="px-2">
							<TabsTrigger value="why">{blocked ? "Why blocked?" : "Why"}</TabsTrigger>
							<TabsTrigger value="receipt">What it was given</TabsTrigger>
							<TabsTrigger value="semantic">Claims vs decision</TabsTrigger>
							<TabsTrigger value="changes">Changes</TabsTrigger>
							<TabsTrigger value="actions">Actions</TabsTrigger>
						</TabsList>
						<TabsContent value="why">
							<WhyTab wi={wi} showResolutions={false} />
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
							<ActionsTab wi={wi} withButtons={false} />
						</TabsContent>
					</Tabs>
				</div>
			</div>
		</section>
	);
}
