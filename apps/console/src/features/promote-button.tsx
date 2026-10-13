import { GitMerge, Loader, Lock } from "lucide-react";
import { useId, useState } from "react";
import { newIdempotencyKey } from "@/client/types";
import { ReasonChip } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConsole } from "@/state/console-context";
import { isDegraded } from "@/state/store";
import { useGate } from "@/state/use-gate";
import { scenarioMeta } from "./scenario-meta";

/**
 * Promote, gated. The button is disabled unless `GET /work-items/:id/gate` says the dry run
 * passes, and the tooltip (and the text under the button, for people who cannot hover) names
 * the reason codes it returned.
 */
export function PromoteButton({ workItemId, className, showReasons = false }: { workItemId: string; className?: string; showReasons?: boolean }) {
	const { client, view, notify } = useConsole();
	const { gate, loading, error } = useGate(workItemId);
	const wi = view.workItems[workItemId];
	const [promoting, setPromoting] = useState(false);
	const reasonsId = useId();
	if (!wi) return null;

	const promoted = wi.item.status === "promoted";
	const degraded = isDegraded(view);
	// While the poller is degraded a baseline change could be unread, so even a passing gate is not trusted.
	const readOnly = scenarioMeta(client.scenario, client.kind === "live").readOnlyReason;
	const canPromote = Boolean(gate?.pass) && !promoted && !promoting && wi.headSha !== null && !degraded && !readOnly;

	async function promote() {
		if (!wi?.headSha) return;
		setPromoting(true);
		const result = await client.api.promote(
			{ workItemId, expectedBaselineCommit: view.baselineCommit, forkHeadSha: wi.headSha },
			newIdempotencyKey(),
		);
		setPromoting(false);
		if (result.ok) notify("success", result.message ?? `${workItemId} promoted.`);
		else notify("danger", `${result.message}${result.reasonCodes?.length ? ` (${result.reasonCodes.join(", ")})` : ""}`);
	}

	const reasons = gate && !gate.pass && !promoted ? gate.reasonCodes : [];
	const label = promoted ? "Promoted" : promoting ? "Re-checking at current heads" : "Promote";

	return (
		<div className={className}>
			<Tooltip>
				<TooltipTrigger asChild>
					<span tabIndex={canPromote ? -1 : 0} data-testid="promote-trigger" aria-describedby={reasonsId} className="inline-flex">
						<Button size="sm" disabled={!canPromote} onClick={promote} data-testid="promote-button">
							{promoting ? <Loader className="animate-spin" aria-hidden /> : promoted ? <GitMerge aria-hidden /> : canPromote ? <GitMerge aria-hidden /> : <Lock aria-hidden />}
							{label}
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom" align="start" className="w-72">
					{readOnly ? (
						<p>{readOnly}</p>
					) : promoted ? (
						<p>Already merged into the baseline.</p>
					) : degraded ? (
						<p>The poller is degraded, so Delta Convergence cannot confirm this work is current. Promote reopens when the poller recovers.</p>
					) : error ? (
						<p>The gate could not be read: {error}</p>
					) : !gate ? (
						<p>{loading ? "Checking the gate at the current heads." : "No gate result yet."}</p>
					) : gate.pass ? (
						<p>The gate passes right now. Promote re-checks at the current heads before it merges.</p>
					) : (
						<div className="space-y-2">
							<p className="font-semibold">Promote is blocked</p>
							<ul className="flex flex-wrap gap-1.5" aria-label="Reason codes">
								{gate.reasonCodes.map((code) => (
									<li key={code}>
										<ReasonChip code={code} />
									</li>
								))}
							</ul>
							{gate.blockers.length > 0 && (
								<ul className="list-disc space-y-1 pl-4 text-muted-foreground">
									{gate.blockers.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							)}
						</div>
					)}
				</TooltipContent>
			</Tooltip>
			{/* Always on the page: touch and screen-reader users get the reasons without a hover. */}
			<span id={reasonsId} className={showReasons && reasons.length > 0 ? "mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" : "sr-only"}>
				{reasons.length > 0 ? (
					<>
						<span>Blocked by</span>
						{reasons.map((code) => (
							<ReasonChip key={code} code={code} />
						))}
					</>
				) : null}
			</span>
		</div>
	);
}
