import { CircleCheck, HelpCircle, Loader, ThumbsDown, ThumbsUp } from "lucide-react";
import { useMemo, useState } from "react";
import { newIdempotencyKey } from "@/client/types";
import { UnavailableHint } from "@/components/unavailable-hint";
import { Button } from "@/components/ui/button";
import { useConsole } from "@/state/console-context";
import { useReadOnlyReason } from "@/state/read-only";
import { analysisOf, recordName } from "@/state/derive";

type Decision = "accept" | "reject";

/**
 * A work item held because its claims rely on a decision it was never given (rule R4): the person who owns
 * the decision says whether that reliance counts. Reject clears the hold, so the work carries on. Accept
 * makes it a dependency the work was never built against, so it needs to be redone.
 *
 * Renders nothing unless the item has such an open question, or just answered one in this session.
 */
export function DependencyDecision({ workItemId }: { workItemId: string }) {
	const { client, view, notify } = useConsole();
	const [busy, setBusy] = useState<{ recordId: string; decision: Decision } | null>(null);
	const [answered, setAnswered] = useState<{ recordId: string; decision: Decision } | null>(null);
	const wi = view.workItems[workItemId];
	const analysis = useMemo(() => analysisOf(view, workItemId), [view, workItemId]);

	// Open questions: the records its claims lean on that are outside what it was given and that nobody has decided yet.
	const open = useMemo(() => {
		if (!analysis || wi?.item.status === "promoted") return [];
		return analysis.outsideReceipt
			.map((o) => o.recordId)
			.filter((recordId) => view.dependencies.some((d) => d.workItemId === workItemId && d.recordId === recordId && d.status === "proposed"));
	}, [analysis, view.dependencies, workItemId, wi?.item.status]);

	if (!wi) return null;
	if (open.length === 0 && !answered) return null;

	const readOnly = useReadOnlyReason();

	async function decide(recordId: string, decision: Decision) {
		setBusy({ recordId, decision });
		const result = await client.api.decideDependency({ workItemId, recordId, decision }, newIdempotencyKey());
		setBusy(null);
		if (result.ok) {
			setAnswered({ recordId, decision });
			notify("success", result.message ?? (decision === "accept" ? "Dependency accepted." : "Dependency rejected."));
		} else {
			notify("danger", `${result.message}${result.reasonCodes?.length ? ` (${result.reasonCodes.join(", ")})` : ""}`);
		}
	}

	return (
		<section aria-label="Undeclared dependency" className="space-y-2.5" data-testid="dependency-decision">
			{open.map((recordId) => {
				const name = recordName(recordId);
				const working = busy?.recordId === recordId;
				return (
					<div key={recordId} className="rounded-xl border border-warning/35 bg-warning-soft p-3.5" data-testid="dependency-question" data-record={recordId}>
						<p className="flex items-start gap-2 text-sm font-semibold">
							<HelpCircle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
							<span>Claims rely on {name}, which it wasn&apos;t given.</span>
						</p>
						<p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
							The agent says it read {name} on its own. Reject it if this work doesn&apos;t really depend on it. Accept it if it does, and the work will need a redo on the current version.
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							<UnavailableHint available={!readOnly} reason={readOnly ?? ""}>
								<Button data-testid="dependency-reject" disabled={Boolean(readOnly) || busy !== null} onClick={() => void decide(recordId, "reject")}>
									{working && busy?.decision === "reject" ? <Loader className="animate-spin" aria-hidden /> : <ThumbsDown aria-hidden />}
									Reject this dependency
								</Button>
							</UnavailableHint>
							<UnavailableHint available={!readOnly} reason={readOnly ?? ""}>
								<Button variant="outline" data-testid="dependency-accept" disabled={Boolean(readOnly) || busy !== null} onClick={() => void decide(recordId, "accept")}>
									{working && busy?.decision === "accept" ? <Loader className="animate-spin" aria-hidden /> : <ThumbsUp aria-hidden />}
									Accept this dependency
								</Button>
							</UnavailableHint>
						</div>
					</div>
				);
			})}
			{answered && open.length === 0 && (
				<p
					className="flex items-start gap-2 rounded-xl border border-success/35 bg-success-soft px-3.5 py-2.5 text-sm leading-relaxed"
					role="status"
					data-testid="dependency-answered"
					data-decision={answered.decision}
				>
					<CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
					{answered.decision === "reject"
						? `Rejected. This work no longer counts on ${recordName(answered.recordId)}. Recorded in the audit log.`
						: `Accepted. ${recordName(answered.recordId)} now counts as something this work depends on, so it needs a re-run on the current version. Recorded in the audit log.`}
				</p>
			)}
		</section>
	);
}
