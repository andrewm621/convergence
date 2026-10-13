import { hashCanonical, type FacetValue, type ReceiptEntry, type WorkItemState } from "contracts";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatFacet, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { receiptFacets, type ReceiptFacetRow } from "@/state/derive";

/**
 * A digest per facet. The receipt itself carries one hash for all of a record's facets, so this is
 * computed here from the facet's canonical JSON (name and value) to give each named facet something
 * to point at on screen. It is the same kind of hash, not a field the Worker sent.
 */
function useFacetDigests(rows: readonly ReceiptFacetRow[]): Record<string, string> {
	const [digests, setDigests] = useState<Record<string, string>>({});
	const signature = useMemo(() => JSON.stringify(rows.map((row) => [row.key, row.handed])), [rows]);
	useEffect(() => {
		let cancelled = false;
		const entries = JSON.parse(signature) as [string, FacetValue][];
		void Promise.all(entries.map(async ([key, value]) => [key, await hashCanonical({ [key]: value })] as const)).then((pairs) => {
			if (!cancelled) setDigests(Object.fromEntries(pairs));
		});
		return () => {
			cancelled = true;
		};
	}, [signature]);
	return digests;
}

/**
 * The named facets one receipt entry handed to a work item: facet name, the value it was handed,
 * a short hash, and a marker where the accepted record has moved on. Readable at 1080p: nothing
 * here is below 14px.
 */
export function ReceiptFacetList({ wi, entry, className }: { wi: WorkItemState; entry: ReceiptEntry; className?: string }) {
	const { view } = useConsole();
	const facets = useMemo(() => receiptFacets(view, wi, entry), [view, wi, entry]);
	const digests = useFacetDigests(facets.rows);
	const version = facets.current?.version;

	if (!facets.held) {
		return (
			<p className={cn("text-sm text-muted-foreground", className)} data-testid="receipt-facets-missing">
				The setting values for {entry.recordId}@{entry.version} are not in this snapshot. Their combined hash is {shortHash(entry.facetHash, 8)}.
			</p>
		);
	}

	return (
		<div className={className} data-testid={`receipt-facets-${entry.recordId}`}>
			<ul className="divide-y rounded-lg border bg-background/60" aria-label={`Settings of ${entry.recordId}@${entry.version} that were handed over`}>
				{facets.rows.map((row) => (
					<li key={row.key} data-facet={row.key} data-facet-status={row.status} className={cn("px-3 py-2 text-sm", row.status !== "unchanged" && "bg-danger-soft")}>
						<div className="flex items-baseline gap-x-3">
							<span className="min-w-0 flex-1 break-words">
								<span className="font-mono font-semibold">{row.key}</span>
								<span className="text-muted-foreground"> = </span>
								<span className={cn("font-medium", row.status !== "unchanged" && "line-through decoration-danger/60")}>{formatFacet(row.handed)}</span>
							</span>
							<span
								className="shrink-0 font-mono text-muted-foreground"
								title={`sha-256 of this facet (name and value): ${digests[row.key] ?? "computing"}. Computed in the console; the receipt carries one combined hash.`}
								data-testid={`facet-hash-${row.key}`}
							>
								#{digests[row.key] ? shortHash(digests[row.key], 8) : "........"}
							</span>
						</div>
						{row.status === "changed" && (
							<p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-danger">
								<Badge tone="danger" className="px-1.5 text-sm">
									<TriangleAlert aria-hidden /> changed in v{version}
								</Badge>
								<ArrowRight className="size-3.5" aria-hidden />
								<span>{formatFacet(row.now)}</span>
								{row.relied && <span className="text-muted-foreground">(this work relies on it)</span>}
							</p>
						)}
						{row.status === "removed" && (
							<p className="mt-1 flex flex-wrap items-center gap-2 font-medium text-danger">
								<Badge tone="danger" className="px-1.5 text-sm">
									<TriangleAlert aria-hidden /> removed in v{version}
								</Badge>
							</p>
						)}
						{row.status === "unchanged" && version !== undefined && version !== entry.version && <p className="mt-0.5 text-muted-foreground">unchanged in v{version}</p>}
					</li>
				))}
				{facets.added.map((added) => (
					<li key={added.key} data-facet={added.key} data-facet-status="added" className="px-3 py-2 text-sm text-muted-foreground">
						<span className="font-mono font-semibold">{added.key}</span> is new in v{version} = {formatFacet(added.now)}. It was not handed over.
					</li>
				))}
				{facets.rows.length === 0 && facets.added.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">This version governs no settings.</li>}
			</ul>
		</div>
	);
}
