import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { createClient, type Runtime } from "@/client/create-client";
import type { ScenarioName } from "@/client/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomStrip } from "@/features/bottom-strip";
import { ContextTimeline } from "@/features/context-timeline";
import { Header } from "@/features/header";
import { Home } from "@/features/home";
import { Inspector } from "@/features/inspector";
import { ItemPage } from "@/features/item-page";
import { MockControls } from "@/features/mock-controls";
import { WorkGraph } from "@/features/work-graph";
import type { MockClient } from "@/mock/client";
import { cn } from "@/lib/utils";
import { ConsoleProvider, useConsole } from "@/state/console-context";
import { TRAY_LABEL, type Tray } from "@/state/trays";

/** Which shell: the trays-and-item-page console (the default), or the original three-pane one at `?ui=classic`. */
export type UiChoice = "new" | "classic";

export function readUi(search: string): UiChoice {
	return new URLSearchParams(search).get("ui") === "classic" ? "classic" : "new";
}

export function App({ runtime, ui = "new" }: { runtime: Runtime; ui?: UiChoice }) {
	const [scenario, setScenario] = useState<ScenarioName>(runtime.scenario);
	// A named cell (`?cell=notifications-demo`) belongs to its scenario: choosing another one leaves it.
	const [cell, setCell] = useState(runtime.cell);
	// Switching the scenario swaps the client; the mock and the live client are chosen in `createClient`.
	const client = useMemo(() => createClient({ ...runtime, scenario, cell }), [runtime, scenario, cell]);

	function chooseScenario(next: ScenarioName) {
		if (next === scenario) return;
		setScenario(next);
		setCell(undefined);
		const url = new URL(window.location.href);
		url.searchParams.set("scenario", next);
		url.searchParams.delete("cell");
		url.searchParams.delete("script");
		window.history.replaceState(null, "", url);
	}

	return (
		<TooltipProvider>
			<ConsoleProvider client={client}>
				{ui === "classic" ? (
					<ClassicShell scenario={scenario} onScenario={chooseScenario} controls={runtime.controls} />
				) : (
					<NewShell scenario={scenario} onScenario={chooseScenario} controls={runtime.controls} />
				)}
			</ConsoleProvider>
		</TooltipProvider>
	);
}

type ShellProps = { scenario: ScenarioName; onScenario(next: ScenarioName): void; controls: boolean };

/**
 * Work view: decisions on the left, and the home trays (or, once a row is opened, its item page) across the rest.
 * Map view: the original graph and side pane. React Flow mounts only in Map, so it never fits itself to a hidden box.
 */
function NewShell({ scenario, onScenario, controls }: ShellProps) {
	const { client, connection, view, mode, setMode, selectedId, select } = useConsole();
	const [tray, setTray] = useState<Tray>("needs-you");
	const wi = selectedId ? view.workItems[selectedId] : undefined;
	const mock = client.kind === "mock" ? <MockControls mock={client as MockClient} initiallyVisible={controls} /> : null;
	return (
		<div className="flex h-full flex-col bg-background">
			<Header scenario={scenario} onScenario={onScenario} connection={connection} poller={view.poller} live={client.kind === "live"} mode={mode} onMode={setMode} />
			{mode === "map" ? (
				<main className="grid min-h-0 flex-1 grid-cols-[minmax(280px,320px)_minmax(0,1fr)_minmax(400px,480px)] divide-x">
					<div className="flex min-h-0 flex-col bg-card/40">
						<ContextTimeline />
					</div>
					<div className="flex min-h-0 flex-col">
						<WorkGraph />
					</div>
					<div className="flex min-h-0 flex-col bg-card/40">
						<Inspector />
					</div>
				</main>
			) : (
				<main className="grid min-h-0 flex-1 grid-cols-[minmax(280px,320px)_minmax(0,1fr)] divide-x">
					<div className="flex min-h-0 flex-col bg-card/40">
						<ContextTimeline />
					</div>
					<div className="flex min-h-0 min-w-0 flex-col">
						{wi ? <ItemPage wi={wi} backLabel={TRAY_LABEL[tray]} onBack={() => select(null)} /> : <Home tray={tray} onTray={setTray} />}
					</div>
				</main>
			)}
			{/* Outside the Work | Map switch, so hiding it for a recording survives a change of view. */}
			{mock}
			<BottomStrip />
			<Toaster />
		</div>
	);
}

/** The original three-pane console, kept whole at `?ui=classic` as the recording's fallback. */
function ClassicShell({ scenario, onScenario, controls }: ShellProps) {
	const { client, connection, view } = useConsole();
	return (
		<div className="flex h-full flex-col bg-background">
			<Header scenario={scenario} onScenario={onScenario} connection={connection} poller={view.poller} live={client.kind === "live"} />
			<main className="grid min-h-0 flex-1 grid-cols-[minmax(280px,320px)_minmax(0,1fr)_minmax(400px,480px)] divide-x">
				<div className="flex min-h-0 flex-col bg-card/40">
					<ContextTimeline />
				</div>
				<div className="flex min-h-0 flex-col">
					<WorkGraph />
					{client.kind === "mock" && <MockControls mock={client as MockClient} initiallyVisible={controls} />}
				</div>
				<div className="flex min-h-0 flex-col bg-card/40">
					<Inspector />
				</div>
			</main>
			<BottomStrip />
			<Toaster />
		</div>
	);
}

function Toaster() {
	const { toasts } = useConsole();
	return (
		<div className="pointer-events-none fixed right-4 bottom-[228px] z-50 flex w-80 flex-col gap-2" role="status" aria-live="polite">
			{toasts.map((toast) => {
				const Icon = toast.tone === "success" ? CircleCheck : toast.tone === "danger" ? CircleAlert : Info;
				return (
					<div
						key={toast.id}
						className={cn(
							"row-in pointer-events-auto flex items-start gap-2 rounded-lg border bg-popover px-3 py-2.5 text-[13px] shadow-lg",
							toast.tone === "danger" && "border-danger/40",
						)}
					>
						<Icon className={cn("mt-0.5 size-4 shrink-0", toast.tone === "success" ? "text-success" : toast.tone === "danger" ? "text-danger" : "text-info")} aria-hidden />
						<span>{toast.text}</span>
					</div>
				);
			})}
		</div>
	);
}
