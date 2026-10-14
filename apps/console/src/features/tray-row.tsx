import type { WorkItemState } from "contracts";
import { ChevronRight } from "lucide-react";
import { RunningDot, SeededBadge, StatusChip } from "@/components/status";
import { cn } from "@/lib/utils";
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
}: {
	wi: WorkItemState;
	tray: Tray;
	reason: string;
	leftAlone: boolean;
	excepted: boolean;
	running: boolean;
	onOpen(id: string): void;
}) {
	return (
		<li className="row-in" data-slot="tray-row" data-work-item={wi.item.id}>
			<button
				type="button"
				onClick={() => onOpen(wi.item.id)}
				className="group flex w-full items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
				</span>
				{running && tray !== "working" && <RunningDot label="Agent still working" />}
				<StatusChip status={wi.item.status} leftAlone={leftAlone} excepted={excepted} className="shrink-0" />
				<ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
			</button>
		</li>
	);
}
