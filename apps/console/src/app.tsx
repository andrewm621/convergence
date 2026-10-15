import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { createClient, type Runtime } from "@/client/create-client";
import { cellAfterSwitch, type ScenarioName } from "@/client/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomStrip } from "@/features/bottom-strip";
import { ContextTimeline } from "@/features/context-timeline";
import { Header } from "@/features/header";
import { Home } from "@/features/home";
import { Inspector } from "@/features/inspector";
import { NotPublic } from "@/features/not-public";
import { ItemPage } from "@/features/item-page";
import { MockControls } from "@/features/mock-controls";
import { ProcessView } from "@/features/process-view";
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
	// A named cell (`?cell=notifications-demo`) belongs to its scenario: choosing another one leaves it, except a staged recording cell (`-rec1`), which follows to the same suffix.
	const [cell, setCell] = useState(runtime.cell);
	// Switching the scenario swaps the client; the mock and the live client are chosen in `createClient`.
	const client = useMemo(() => createClient({ ...runtime, scenario, cell }), [runtime, scenario, cell]);

	function chooseScenario(next: ScenarioName) {
		if (next === scenario) return;
		setScenario(next);
		const nextCell = cellAfterSwitch(cell, next);
		setCell(nextCell);
		const url = new URL(window.location.href);
		url.searchParams.set("scenario", next);
		if (nextCell) url.searchParams.set("cell", nextCell);
		else url.searchParams.delete("cell");
		url.searchParams.delete("script");
		window.history.replaceState(null, "", url);
	}

	return (
		<TooltipProvider>
			<ConsoleProvider client={client}>
				<Shell ui={ui} scenario={scenario} onScenario={chooseScenario} controls={runtime.controls} cell={cell ?? scenario} />
			</ConsoleProvider>
		</TooltipProvider>
	);
}

type ShellProps = { scenario: ScenarioName; onScenario(next: ScenarioName): void; controls: boolean };

/** The public read-only view of a cell the Worker does not list shows a plain message instead of an empty console. */
function Shell({ ui, cell, ...props }: ShellProps & { ui: UiChoice; cell: string }) {
	const { connection } = useConsole();
	if (connection === "not-public") return <NotPublic cell={cell} />;
	return ui === "classic" ? <ClassicShell {...props} /> : <NewShell {...props} />;
}

/**
 * Work view: decisions on the left, and the home trays (or, once a row is opened, its item page) across the rest.
 * Map view: the original graph and side pane. React Flow mounts only in Map, so it never fits itself to a hidden box.
 * Process view: one lane per work item across the full width, read from the ledger.
 */
function NewShell({ scenario, onScenario, controls }: ShellProps) {
	const { client, connection, view, mode, setMode, selectedId, select } = useConsole();
	const [tray, setTray] = useState<Tray>("needs-you");
	const wi = selectedId ? view.workItems[selectedId] : undefined;
	const mock = client.kind === "mock" ? <MockControls mock={client as MockClient} initiallyVisible={controls} /> : null;
	return (
		<div className="flex h-full flex-col bg-background">
			<Header scenario={scenario} onScenario={onScenario} connection={connection} poller={view.poller} live={client.kind === "live"} readOnly={client.readOnly} mode={mode} onMode={setMode} />
			{mode === "process" ? (
				<main className="flex min-h-0 flex-1 flex-col">
					<ProcessView />
				</main>
			) : mode === "map" ? (
				// No decisions rail here: the decisions are nodes on the graph, and the graph needs the width to stay readable.
				<main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(400px,480px)] divide-x">
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
			<Header scenario={scenario} onScenario={onScenario} connection={connection} poller={view.poller} live={client.kind === "live"} readOnly={client.readOnly} />
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
