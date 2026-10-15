import type { FacetValue, RecordSnapshot, WorkItemStatus } from "contracts";
import { diffFacets, type WhatIfOutcome } from "delta-core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
			{!open && held.length > 0 && <span className="text-xs text-muted-foreground">{held.length} held</span>}
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
	onClose(): void;
};

/**
 * Hold up to three edits of this decision and see, for each, which known dependent work the real engine would block.
 * Every verdict comes from `compareOptions` (delta-core's `whatIf`); this component only words it. A preview: nothing is
 * saved, sent or recorded.
 *
 * It is a wide sheet over the main pane, to the right of the decisions column. It is not modal: the editor stays live
 * beside it, so an edit can be held, loaded back or removed while the options are read. Escape and Close shut it.
 */
export function CompareAlternatives({ view, recordId, snapshot, held, draft, onRemove, onLoad, onClose }: PanelProps) {
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

	// Focus moves to Close when the sheet opens and goes back to where it was when it closes. Escape closes it.
	const closeRef = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const opener = document.activeElement;
		closeRef.current?.focus();
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape" && !event.defaultPrevented) onCloseRef.current();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	const status = holdStatus(snapshot, held, draft);
	const hint =
		status.kind === "full"
			? "Three options held. Remove one to hold another."
			: held.length === 0
				? "Change a setting in the editor, then hold the edit as an option. Hold two or three to compare."
				: held.length === 1
					? `Change the settings again and hold a second edit to compare it with ${optionName(0)}.`
					: null;

	return createPortal(
		<section
			role="dialog"
			aria-modal="false"
			aria-labelledby={titleId}
			data-testid="compare-panel"
			className="fixed top-24 right-4 left-[336px] z-40 mx-auto flex max-h-[calc(100vh-7.5rem)] max-w-[1100px] flex-col rounded-xl border bg-popover text-popover-foreground shadow-xl ring-1 ring-border"
		>
			<header className="flex items-start gap-4 px-8 pt-6 pb-5">
				<div className="min-w-0 flex-1 space-y-1">
					<h2 id={titleId} className="text-xl font-semibold tracking-tight">
						Compare alternatives
					</h2>
					<p className="text-sm text-muted-foreground">Preview only: nothing is saved or sent. It counts known dependent work, from recorded dependencies.</p>
				</div>
				<Button ref={closeRef} type="button" variant="ghost" size="sm" onClick={onClose}>
					Close
				</Button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto border-t px-8 py-6">
				{held.length > 0 && (
					<div className={cn("grid grid-rows-[auto_auto_1fr_auto] gap-y-5", held.length === 1 && "max-w-md grid-cols-1", held.length === 2 && "grid-cols-2", held.length === 3 && "grid-cols-3")}>
						{held.map((option, index) => {
							const outcome = outcomes.find((o) => o.candidateId === option.id);
							const changes = diffFacets(snapshot, { facets: option.facets });
							return (
								<section
									key={option.id}
									aria-label={optionName(index)}
									data-testid="compare-option"
									data-option={option.id}
									data-blocked={outcome?.blockedIds.join(",")}
									className={cn("row-span-4 grid min-w-0 grid-rows-subgrid", index > 0 && "border-l pl-8", index < held.length - 1 && "pr-8")}
								>
									<div className="space-y-1.5">
										<h3 className="text-base font-semibold">{optionName(index)}</h3>
										<ul className="space-y-1 text-sm break-words text-muted-foreground">
											{changes.map((change) => (
												<li key={change.key}>
													<span className="font-mono text-[13px]">{change.key}</span> {change.kind === "removed" ? "removed" : `becomes ${formatFacet(change.to)}`}
												</li>
											))}
										</ul>
									</div>
									{outcome && <Verdict outcome={outcome} view={view} />}
									<p className="flex gap-4">
										<Button type="button" variant="link" size="sm" className="h-auto px-0 py-0.5 text-muted-foreground" onClick={() => onLoad(option.facets)}>
											Edit this one
										</Button>
										<Button type="button" variant="link" size="sm" className="h-auto px-0 py-0.5 text-muted-foreground" onClick={() => onRemove(option.id)}>
											Remove
										</Button>
									</p>
								</section>
							);
						})}
					</div>
				)}

				{hint && <p className={cn("text-sm text-muted-foreground", held.length > 0 && "mt-8")}>{hint}</p>}
			</div>
		</section>,
		document.body,
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
		<>
			<p className={cn("text-3xl font-semibold tracking-tight", blocked.length > 0 ? "text-danger" : "text-muted-foreground")}>{blocked.length === 0 ? "Blocks nothing" : `Blocks ${plural(blocked.length, "item")}`}</p>
			<div className="space-y-4">
				{blocked.length > 0 && (
					<ul className="space-y-3">
						{blocked.map((item) => (
							<li key={item.workItemId} data-work-item={item.workItemId}>
								<span className="text-base font-medium text-danger">{titleOf(item.workItemId)}</span>
								<span className="mt-0.5 block text-sm text-muted-foreground">
									{reasonOf(item.reasonCodes)}
									{ALREADY_BLOCKED.has(item.statusBefore) ? ", already blocked" : ""}
								</span>
							</li>
						))}
					</ul>
				)}
				{unaffected.length > 0 && <p className="text-sm text-muted-foreground">Not affected: {unaffected.map((item) => titleOf(item.workItemId)).join(", ")}</p>}
			</div>
		</>
	);
}
