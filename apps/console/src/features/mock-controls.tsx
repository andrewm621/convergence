import { ChevronLeft, ChevronRight, Eye, EyeOff, Film, RotateCcw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import type { MockClient } from "@/mock/client";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";

/** Applies a step's screen hints (select an item, switch the tab, open the editor). */
function useBeatHints(mock: MockClient) {
	const { select, setTab, requestEditor } = useConsole();
	useEffect(
		() =>
			mock.controls.onUi((hint) => {
				if (hint.select) select(hint.select);
				if (hint.tab) setTab(hint.tab);
				if (hint.editor) requestEditor(hint.editor);
			}),
		[mock, select, setTab, requestEditor],
	);
}

function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	// Arrow keys belong to the tab list and the scenario switcher when one of them has focus.
	return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest('[role="tablist"], [role="radiogroup"]') !== null;
}

/**
 * Step-through controls for the presenter. Right arrow plays the next step, left arrow goes
 * back (by replaying from the start), `h` hides the bar for a clean recording.
 */
export function MockControls({ mock, initiallyVisible }: { mock: MockClient; initiallyVisible: boolean }) {
	const state = useSyncExternalStore(mock.controls.subscribe, mock.controls.getState, mock.controls.getState);
	const [visible, setVisible] = useState(initiallyVisible);
	useBeatHints(mock);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key === "ArrowRight") {
				event.preventDefault();
				void mock.controls.next();
			} else if (event.key === "ArrowLeft") {
				event.preventDefault();
				void mock.controls.prev();
			} else if (event.key.toLowerCase() === "h") {
				setVisible((v) => !v);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [mock]);

	if (!visible) return null;
	const total = state.beats.length;
	const next = state.beats[state.position];
	const last = state.position > 0 ? state.beats[state.position - 1] : undefined;
	const done = state.position >= total && total > 0;

	return (
		<div
			role="region"
			aria-label="Mock replay controls"
			data-testid="mock-controls"
			className="shrink-0 border-t bg-popover px-4 py-2.5"
		>
			<div className="flex items-center gap-2">
				<Film className="size-4 text-info" aria-hidden />
				<span className="text-xs font-semibold tracking-wide text-info uppercase">Replay</span>
				{state.scripts.length > 1 && (
					<NativeSelect aria-label="Script" className="h-7 w-auto text-xs" value={state.scriptId} disabled={state.busy} onChange={(e) => void mock.controls.setScript(e.target.value)}>
						{state.scripts.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</NativeSelect>
				)}
				<span className="ml-auto text-xs text-muted-foreground tabular-nums">
					Step {state.position} of {total}
				</span>
				<Button variant="ghost" size="icon-sm" aria-label="Hide controls (h)" title="Hide (press h to bring back)" onClick={() => setVisible(false)}>
					<EyeOff />
				</Button>
			</div>

			<div className="mt-2 flex items-center gap-3">
				<div className="min-w-0 flex-1">
					{done ? (
						<p className="text-sm font-semibold">End of the replay.</p>
					) : (
						<p className="truncate text-sm font-semibold" data-testid="next-beat">
							Next: {state.position + 1}. {next?.title ?? "…"}
						</p>
					)}
					<p className="truncate text-xs text-muted-foreground">{done ? (last?.caption ?? "") : (next?.caption ?? "")}</p>
				</div>
				<Button variant="outline" size="sm" disabled={state.busy || state.position === 0} onClick={() => void mock.controls.prev()} aria-label="Previous step">
					<ChevronLeft aria-hidden /> Back
				</Button>
				<Button size="sm" disabled={state.busy || done || !state.ready} onClick={() => void mock.controls.next()} aria-label="Next step">
					Next <ChevronRight aria-hidden />
				</Button>
			</div>

			<div className="mt-2.5 flex items-center gap-1.5">
				<ol className="flex flex-1 flex-wrap items-center gap-1" aria-label="Steps">
					{state.beats.map((beat, index) => {
						const played = index < state.position;
						const isNext = index === state.position;
						return (
							<li key={beat.title}>
								<button
									type="button"
									disabled={state.busy}
									title={beat.title}
									aria-label={`Go to step ${index + 1}: ${beat.title}`}
									aria-current={isNext ? "step" : undefined}
									onClick={() => void mock.controls.jump(index + 1)}
									className={cn(
										"grid size-6 place-items-center rounded-full border text-[11px] font-semibold tabular-nums transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60",
										played ? "border-primary bg-primary text-primary-foreground" : isNext ? "border-primary text-primary" : "border-border text-muted-foreground hover:bg-accent",
									)}
								>
									{index + 1}
								</button>
							</li>
						);
					})}
				</ol>
				<Button variant="ghost" size="xs" disabled={state.busy} onClick={() => void mock.controls.reset()} title="Start over from the seeded baseline">
					<RotateCcw aria-hidden /> Reset
				</Button>
				<Button variant="ghost" size="xs" disabled={state.busy} onClick={() => void mock.controls.resetToEmpty()} title="Start over with no accepted context, to show the empty state">
					<Eye aria-hidden /> Empty state
				</Button>
			</div>
		</div>
	);
}
