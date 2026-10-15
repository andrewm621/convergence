import type { FacetValue, RecordSnapshot, WorkItemStatus } from "contracts";
import { diffFacets, type WhatIfOutcome } from "delta-core";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatFacet, plural } from "@/lib/format";
import { primaryReason, reasonLabel } from "@/lib/reasons";
import { cn } from "@/lib/utils";
import type { ViewState } from "@/state/store";
import { compareOptions } from "@/state/what-if";

/** The most edits held at once: enough to choose between, few enough to read side by side. */
export const MAX_HELD = 3;

export type HeldOption = { id: string; facets: Record<string, FacetValue> };

/** The edits held for comparison. They live in the editor, so closing the panel keeps them and closing the editor drops them. */
export function useHeldOptions() {
	const [held, setHeld] = useState<HeldOption[]>([]);
	const [serial, setSerial] = useState(1);
	const hold = useCallback(
		(facets: Record<string, FacetValue>) => {
			setHeld((list) => (list.length >= MAX_HELD ? list : [...list, { id: `option-${serial}`, facets }]));
			setSerial((n) => n + 1);
		},
		[serial],
	);
	const remove = useCallback((id: string) => setHeld((list) => list.filter((option) => option.id !== id)), []);
	return { held, hold, remove };
}

const optionName = (index: number) => `Option ${String.fromCharCode(65 + index)}`;

const sameFacets = (a: Record<string, FacetValue>, b: Record<string, FacetValue>) => diffFacets({ facets: a }, { facets: b }).length === 0;

/**
 * Bring `el` to the top of its nearest scrolling ancestor. Unlike `scrollIntoView`, this never scrolls the page itself, so the
 * header and the replay controls stay where they are.
 */
export function scrollToTopOfParent(el: HTMLElement | null) {
	let parent = el?.parentElement ?? null;
	while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
	if (!el || !parent) return;
	parent.scrollTop += el.getBoundingClientRect().top - parent.getBoundingClientRect().top - 8;
}

type HoldStatus = { kind: "ready" } | { kind: "unchanged" } | { kind: "full" } | { kind: "duplicate"; index: number };

/** Whether the edit in the editor can be held now, and if not, why. */
function holdStatus(snapshot: RecordSnapshot, held: readonly HeldOption[], draft: Record<string, FacetValue>): HoldStatus {
	if (held.length >= MAX_HELD) return { kind: "full" };
	if (diffFacets(snapshot, { facets: draft }).length === 0) return { kind: "unchanged" };
	const index = held.findIndex((option) => sameFacets(option.facets, draft));
	return index >= 0 ? { kind: "duplicate", index } : { kind: "ready" };
}

const QUIET_LINK = "text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

type LinksProps = {
	open: boolean;
	onToggle(): void;
	snapshot: RecordSnapshot;
	held: readonly HeldOption[];
	/** The settings in the editor right now. */
	draft: Record<string, FacetValue>;
	onHold(facets: Record<string, FacetValue>): void;
};

/** The quiet text links under the editor's impact line: open or close the comparison and, while it is open, hold the edit as an option. */
export function CompareLinks({ open, onToggle, snapshot, held, draft, onHold }: LinksProps) {
	const status = holdStatus(snapshot, held, draft);
	return (
		<p className="flex flex-wrap gap-x-4 gap-y-1">
			<button type="button" className={QUIET_LINK} aria-expanded={open} onClick={onToggle}>
				{open ? "Hide comparison" : "Compare alternatives"}
			</button>
			{open && status.kind === "ready" && (
				<button type="button" className={cn(QUIET_LINK, "text-foreground")} onClick={() => onHold(draft)}>
					Hold this edit as {optionName(held.length)}
				</button>
			)}
		</p>
	);
}

type PanelProps = {
	view: ViewState;
	recordId: string;
	snapshot: RecordSnapshot;
	held: readonly HeldOption[];
	/** The settings in the editor right now. */
	draft: Record<string, FacetValue>;
	onRemove(id: string): void;
	/** Put a held edit back into the editor's settings. */
	onLoad(facets: Record<string, FacetValue>): void;
};

/**
 * Hold up to three edits of this decision and see, for each, which known dependent work the real engine would block.
 * Every verdict comes from `compareOptions` (delta-core's `whatIf`); this component only words it. A preview: nothing is
 * saved, sent or recorded.
 */
export function CompareAlternatives({ view, recordId, snapshot, held, draft, onRemove, onLoad }: PanelProps) {
	const [outcomes, setOutcomes] = useState<WhatIfOutcome[]>([]);
	useEffect(() => {
		if (held.length === 0) {
			setOutcomes([]);
			return;
		}
		let cancelled = false;
		void compareOptions(view, recordId, held).then((result) => {
			if (!cancelled) setOutcomes(result ?? []);
		});
		return () => {
			cancelled = true;
		};
	}, [view, recordId, held]);

	const status = holdStatus(snapshot, held, draft);
	const hint =
		status.kind === "full"
			? "Three options held. Remove one to hold another."
			: held.length === 0
				? "Change a setting above, then hold the edit as an option. Hold two or three to compare."
				: held.length === 1
					? `Change the settings again and hold a second edit to compare it with ${optionName(0)}.`
					: null;

	return (
		<section aria-label="Compare alternatives" data-testid="compare-panel" className="@container space-y-3 border-t pt-3">
			<div className="space-y-0.5">
				<h3 className="text-sm font-semibold">Compare alternatives</h3>
				<p className="text-xs text-muted-foreground">Preview only: nothing is saved or sent. It counts known dependent work, from recorded dependencies.</p>
			</div>

			{held.length > 0 && (
				// Two options sit side by side even in the narrow decisions column; a third only when there is room for it.
				<div className={cn("grid gap-x-5 gap-y-5", held.length === 2 && "grid-cols-2", held.length === 3 && "@3xl:grid-cols-3")}>
					{held.map((option, index) => {
						const outcome = outcomes.find((o) => o.candidateId === option.id);
						const changes = diffFacets(snapshot, { facets: option.facets });
						return (
							<section key={option.id} aria-label={optionName(index)} data-testid="compare-option" data-option={option.id} data-blocked={outcome?.blockedIds.join(",")} className="min-w-0 space-y-1.5">
								<h4 className="text-sm font-semibold">{optionName(index)}</h4>
								<ul className="space-y-0.5 text-xs break-words text-muted-foreground">
									{changes.map((change) => (
										<li key={change.key}>
											<span className="font-mono">{change.key}</span> {change.kind === "removed" ? "removed" : `becomes ${formatFacet(change.to)}`}
										</li>
									))}
								</ul>
								{outcome && <Verdict outcome={outcome} view={view} />}
								<p className="flex gap-3">
									<Button type="button" variant="link" size="xs" className="h-auto px-0 py-0.5 text-muted-foreground" onClick={() => onLoad(option.facets)}>
										Edit this one
									</Button>
									<Button type="button" variant="link" size="xs" className="h-auto px-0 py-0.5 text-muted-foreground" onClick={() => onRemove(option.id)}>
										Remove
									</Button>
								</p>
							</section>
						);
					})}
				</div>
			)}

			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</section>
	);
}

const ALREADY_BLOCKED: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>(["stale", "conflict", "uncertain", "revalidating"]);

/** The engine's most important reason for a block, in plain words (lib/reasons). */
function reasonOf(codes: readonly string[]): string {
	const code = primaryReason(codes);
	return code === undefined ? "Blocked" : reasonLabel(code);
}

/** One option's verdict, as the engine gave it: what blocks and why, and the rest named plainly. */
function Verdict({ outcome, view }: { outcome: WhatIfOutcome; view: ViewState }) {
	const titleOf = (id: string) => view.workItems[id]?.item.title ?? id;
	// Merged and rejected work is out of the picture, the same as the editor's own effect line.
	const live = outcome.items.filter((item) => item.status !== "promoted" && item.status !== "rejected");
	const blocked = live.filter((item) => item.blocked);
	const unaffected = live.filter((item) => !item.blocked);
	return (
		<div className="space-y-1.5">
			<p className={cn("text-sm font-semibold", blocked.length > 0 ? "text-danger" : "text-muted-foreground")}>{blocked.length === 0 ? "Blocks nothing" : `Blocks ${plural(blocked.length, "item")}`}</p>
			{blocked.length > 0 && (
				<ul className="space-y-1 text-sm">
					{blocked.map((item) => (
						<li key={item.workItemId} data-work-item={item.workItemId}>
							<span className="text-danger">{titleOf(item.workItemId)}</span>
							<span className="block text-xs text-muted-foreground">
								{reasonOf(item.reasonCodes)}
								{ALREADY_BLOCKED.has(item.statusBefore) ? ", already blocked" : ""}
							</span>
						</li>
					))}
				</ul>
			)}
			{unaffected.length > 0 && <p className="text-xs text-muted-foreground">Not affected: {unaffected.map((item) => titleOf(item.workItemId)).join(", ")}</p>}
		</div>
	);
}
