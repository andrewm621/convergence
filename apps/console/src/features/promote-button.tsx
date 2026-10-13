import { GitMerge, Loader, Lock } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { newIdempotencyKey } from "@/client/types";
import { ReasonChip } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DEMO_IDENTITY } from "@/config";
import { useConsole } from "@/state/console-context";
import { gateWaivers, mergeChecks } from "@/state/derive";
import { isDegraded } from "@/state/store";
import { useGate } from "@/state/use-gate";
import { scenarioMeta } from "./scenario-meta";

/**
 * Merge, gated (the action and endpoint are still "promote"). The button is disabled unless `GET /work-items/:id/gate`
 * says the dry run passes, and the tooltip (and the text under the button, for people who cannot hover) names the reason
 * codes it returned. Clicking it opens a sheet that says what was checked and what was not; only its Merge button promotes.
 */
export function PromoteButton({ workItemId, className, showReasons = false }: { workItemId: string; className?: string; showReasons?: boolean }) {
	const { client, view, notify } = useConsole();
	const { gate, loading, error } = useGate(workItemId);
	const wi = view.workItems[workItemId];
	const [promoting, setPromoting] = useState(false);
	const [sheetOpen, setSheetOpen] = useState(false);
	const [tipOpen, setTipOpen] = useState(false);
	// Closing the sheet hands focus back to the button, which would open the tooltip on top of the page again. Hold it
	// shut until the pointer or focus leaves and comes back.
	const holdTip = useRef(false);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const reasonsId = useId();
	const sheetTitleId = useId();

	const promoted = wi?.item.status === "promoted";
	const degraded = isDegraded(view);
	// While the poller is degraded a baseline change could be unread, so even a passing gate is not trusted.
	const readOnly = scenarioMeta(client.scenario, client.kind === "live").readOnlyReason;
	const canPromote = Boolean(wi) && Boolean(gate?.pass) && !promoted && !promoting && wi?.headSha !== null && !degraded && !readOnly;

	// The sheet's facts, read while it is open, from the same analysis the gate runs.
	const sheet = useMemo(() => {
		if (!sheetOpen || !wi) return null;
		return { checks: mergeChecks(view, wi), waivers: gateWaivers(view, wi) };
	}, [sheetOpen, view, wi, workItemId]);

	// If the gate closes (or the item merges) while the sheet is open, there is nothing left to confirm.
	useEffect(() => {
		if (!canPromote) setSheetOpen(false);
	}, [canPromote]);

	if (!wi) return null;

	async function promote() {
		if (!wi?.headSha) return;
		setSheetOpen(false);
		setPromoting(true);
		const result = await client.api.promote(
			{ workItemId, expectedBaselineCommit: view.baselineCommit, forkHeadSha: wi.headSha },
			newIdempotencyKey(),
		);
		setPromoting(false);
		if (result.ok) notify("success", result.message ?? `${workItemId} merged.`);
		else notify("danger", `${result.message}${result.reasonCodes?.length ? ` (${result.reasonCodes.join(", ")})` : ""}`);
	}

	const reasons = gate && !gate.pass && !promoted ? gate.reasonCodes : [];
	const label = promoted ? "Merged" : promoting ? "Re-checking before merge" : "Merge";
	// Where the gate passes only through an accepted exception, the sheet says so. The server's own gate result decides whether it does.
	const waivers =
		sheet && gate && gate.waivedBy.length > 0
			? sheet.waivers.length > 0
				? sheet.waivers
				: gate.waivedBy.map((w) => ({ scope: w.scope ?? null, signer: w.actor ?? DEMO_IDENTITY.label }))
			: [];

	return (
		<div className={className}>
			<Popover open={sheetOpen} onOpenChange={setSheetOpen}>
				{/* The tooltip would sit on top of the sheet, so it steps aside while the sheet is open. */}
				<Tooltip
					open={tipOpen && !sheetOpen}
					onOpenChange={(next) => {
						if (!next || !holdTip.current) setTipOpen(next);
					}}
				>
					<TooltipTrigger asChild>
						<span
							tabIndex={canPromote ? -1 : 0}
							data-testid="promote-trigger"
							aria-describedby={reasonsId}
							className="inline-flex"
							onPointerEnter={() => (holdTip.current = false)}
							onPointerDown={() => (holdTip.current = false)}
							onBlur={() => (holdTip.current = false)}
						>
							<PopoverTrigger asChild>
								<Button size="sm" disabled={!canPromote} data-testid="promote-button">
									{promoting ? <Loader className="animate-spin" aria-hidden /> : promoted || canPromote ? <GitMerge aria-hidden /> : <Lock aria-hidden />}
									{label}
								</Button>
							</PopoverTrigger>
						</span>
					</TooltipTrigger>
					<TooltipContent side="bottom" align="start" className="w-72">
						{readOnly ? (
							<p>{readOnly}</p>
						) : promoted ? (
							<p>Already merged into the baseline.</p>
						) : degraded ? (
							<p>The poller is degraded, so Delta Convergence cannot confirm this work is current. Merge reopens when the poller recovers.</p>
						) : error ? (
							<p>The merge check could not be read: {error}</p>
						) : !gate ? (
							<p>{loading ? "Running the merge check at the current heads." : "No merge check result yet."}</p>
						) : gate.pass ? (
							<p>The merge check passes right now. Merging asks you to confirm, then re-checks before it merges.</p>
						) : (
							<div className="space-y-2">
								<p className="font-semibold">Merge is blocked</p>
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
				<PopoverContent
					role="dialog"
					aria-labelledby={sheetTitleId}
					data-testid="merge-sheet"
					onCloseAutoFocus={() => {
						holdTip.current = true;
						setTipOpen(false);
					}}
					onOpenAutoFocus={(event) => {
						// Land on Cancel: opening the sheet from the keyboard and pressing Enter again must not merge.
						event.preventDefault();
						cancelRef.current?.focus();
					}}
				>
					<div className="space-y-2.5 text-[13px] leading-relaxed">
						<h3 id={sheetTitleId} className="text-sm font-semibold">
							Merging {wi.item.title}
						</h3>
						{sheet?.checks && (
							<p data-testid="merge-checked">
								<span className="font-semibold">Checked just now:</span> {sheet.checks.map((c) => c.text).join(", ")}.
							</p>
						)}
						{waivers.length > 0 && (
							<p data-testid="merge-exception" className="font-medium text-warning">
								{waivers.map((w) => `Passes with an accepted exception from ${w.signer}${w.scope ? `: ${w.scope}` : ""}.`).join(" ")}
							</p>
						)}
						<p data-testid="merge-not-checked">
							<span className="font-semibold">Not checked:</span> whether the work is right.
						</p>
						<p>Checked again at merge.</p>
						<p data-testid="merge-audit">Recorded in the audit log under {DEMO_IDENTITY.label}.</p>
					</div>
					<div className="mt-4 flex gap-2">
						<Button size="sm" onClick={() => void promote()} disabled={!canPromote} data-testid="merge-confirm">
							<GitMerge aria-hidden /> Merge
						</Button>
						<Button ref={cancelRef} size="sm" variant="ghost" onClick={() => setSheetOpen(false)} data-testid="merge-cancel">
							Cancel
						</Button>
					</div>
				</PopoverContent>
			</Popover>
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
