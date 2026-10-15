import type { RejectedAlternative } from "delta-core";
import { formatFacet } from "@/lib/format";

/**
 * Under a conflicting claim whose value the governing decision already rejected: which version rejected it and, when the
 * decision recorded one, why. Never invents a rationale. It sits in the claim's own row, so it moves no control.
 */
export function RejectedNote({ rejected }: { rejected: RejectedAlternative }) {
	return (
		<div className="basis-full space-y-0.5 pl-[22px] text-xs leading-relaxed" data-testid="rejected-note">
			<p>
				Rejected in v{rejected.version}: &quot;<span className="font-semibold">{formatFacet(rejected.value)}</span>&quot;.
			</p>
			<p className="text-muted-foreground">{rejected.why ? `Why: ${rejected.why}` : "No rationale recorded."}</p>
		</div>
	);
}
