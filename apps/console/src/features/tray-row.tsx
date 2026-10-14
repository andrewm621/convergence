import type { WorkItemState } from "contracts";
import { ArrowRight, ChevronRight } from "lucide-react";
import { RunningDot, SeededBadge, StatusChip } from "@/components/status";
import { formatFacet } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChangedSetting } from "@/state/derive";
import type { Tray } from "@/state/trays";

/**
 * One line of the home list: id, title, the status chip and one reason line. The whole row opens the item page.
 * It mounts with `row-in`, so a row that has just moved into a tray slides in.
 */
export function TrayRow({
	wi,
	tray,
	reason,
	leftAlone,
	excepted,
	running,
	onOpen,
	settings = [],
	muted = false,
}: {
	wi: WorkItemState;
	tray: Tray;
	reason: string;
	leftAlone: boolean;
	excepted: boolean;
	running: boolean;
	onOpen(id: string): void;
	/** Blocked work: the settings it was built on that changed, old → new. */
	settings?: ChangedSetting[];
	/** Work that is not affected: quieter, so it stays in view without asking for attention. */
	muted?: boolean;
}) {
	return (
		<li className="row-in" data-slot="tray-row" data-work-item={wi.item.id}>
			<button
				type="button"
				onClick={() => onOpen(wi.item.id)}
				className={cn(
					"group flex w-full items-center gap-3 rounded-lg border px-4 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50",
					muted ? "border-dashed bg-transparent py-2 opacity-80" : "bg-card py-3",
				)}
			>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-2">
						<span className="shrink-0 font-mono text-xs font-semibold text-muted-foreground">{wi.item.id}</span>
						<span className="min-w-0 truncate text-sm font-semibold">{wi.item.title}</span>
						{wi.item.source === "seeded" && <SeededBadge className="shrink-0" />}
					</span>
					<span
						className={cn("mt-1 block truncate text-[13px]", tray !== "needs-you" ? "text-muted-foreground" : wi.item.status === "uncertain" ? "font-medium text-warning" : "font-medium text-danger")}
						data-testid={`row-reason-${wi.item.id}`}
						title={reason}
					>
						{reason}
					</span>
					{settings.length > 0 && (
						<span className="mt-1.5 flex flex-wrap gap-1.5" data-testid={`row-settings-${wi.item.id}`}>
							{settings.map((setting) => (
								<span key={`${setting.recordId}:${setting.key}`} className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs">
									<span className="font-medium">{setting.label}</span>
									<span className="text-muted-foreground line-through">{formatFacet(setting.from)}</span>
									<ArrowRight className="size-3 text-muted-foreground" aria-hidden />
									<span className="font-semibold">{formatFacet(setting.to)}</span>
								</span>
							))}
						</span>
					)}
				</span>
				{running && tray !== "working" && <RunningDot label="Agent still working" />}
				<StatusChip status={wi.item.status} leftAlone={leftAlone} excepted={excepted} className="shrink-0" />
				<ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
			</button>
		</li>
	);
}
