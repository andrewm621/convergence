import type { WorkItemState } from "contracts";
import { ArrowRight, Check, HelpCircle, Minus, X } from "lucide-react";
import { useMemo } from "react";
import { useDegraded } from "@/components/status";
import { formatFacet } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { builtOnRows, type BuiltOnState } from "@/state/built-on";

const STATE_META: Record<BuiltOnState, { icon: typeof Check; label: string; tone: string }> = {
	current: { icon: Check, label: "current", tone: "text-success" },
	outdated: { icon: X, label: "out of date", tone: "text-danger" },
	"not-given": { icon: HelpCircle, label: "not given", tone: "text-warning" },
	"left-alone": { icon: Minus, label: "left alone", tone: "text-muted-foreground" },
};

/** "Built on": one row per decision, like the checks on a pull request. ✓ current, ✗ built on v1 now v2, ? not given, – left alone. */
export function BuiltOnRows({ wi }: { wi: WorkItemState }) {
	const { view } = useConsole();
	const degraded = useDegraded();
	const rows = useMemo(() => builtOnRows(view, wi), [view, wi]);
	return (
		<section aria-label="Built on" className="rounded-xl border bg-card" data-testid="built-on">
			<div className="flex items-baseline gap-2 border-b px-4 py-2.5">
				<h3 className="text-sm font-semibold">Built on</h3>
				<span className="text-xs text-muted-foreground">the decisions this work relies on, and where each stands now</span>
			</div>
			{rows.length === 0 ? (
				<p className="px-4 py-3 text-[13px] text-muted-foreground">No decision recorded for this work yet.</p>
			) : (
				<ul className="divide-y">
					{rows.map((row) => {
						// While the poller is behind, nothing is confirmed current.
						const unconfirmed = degraded && row.state === "current";
						const meta = unconfirmed ? { icon: HelpCircle, label: "unconfirmed", tone: "text-warning" } : STATE_META[row.state];
						const Icon = meta.icon;
						return (
							<li key={row.recordId} className="flex items-start gap-3 px-4 py-2.5" data-built-on={row.recordId} data-state={unconfirmed ? "unconfirmed" : row.state}>
								<Icon className={cn("mt-0.5 size-4 shrink-0", meta.tone)} aria-hidden />
								<div className="min-w-0 flex-1">
									<p className="flex flex-wrap items-baseline gap-x-2 text-sm">
										<span className="font-mono font-semibold">{row.recordId}</span>
										<span className={cn("text-[13px]", row.state === "current" && !unconfirmed ? "text-muted-foreground" : cn("font-medium", meta.tone))}>
											<span className="sr-only">{meta.label}: </span>
											{row.detail}
										</span>
									</p>
									{row.changedSettings.length > 0 && (
										<ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`What changed in ${row.recordId}`}>
											{row.changedSettings.map((setting) => (
												<li key={setting.key} className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs">
													<span className="font-medium">{setting.label}</span>
													<span className="text-muted-foreground line-through">{formatFacet(setting.from)}</span>
													<ArrowRight className="size-3 text-muted-foreground" aria-hidden />
													<span className="font-semibold">{formatFacet(setting.to)}</span>
												</li>
											))}
										</ul>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
