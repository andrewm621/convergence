import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Wraps an action whose endpoint does not exist on this data source. The action itself is
 * disabled by the caller; this adds the tooltip that says why (a disabled button gets no
 * pointer events, so the tooltip hangs off a focusable wrapper). Renders the child alone when
 * the action is available.
 */
export function UnavailableHint({ available, reason, children }: { available: boolean; reason: string; children: ReactNode }) {
	if (available) return <>{children}</>;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span tabIndex={0} data-testid="unavailable-action" className="inline-flex">
					{children}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="w-72">
				<p>{reason}</p>
			</TooltipContent>
		</Tooltip>
	);
}
