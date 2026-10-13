import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { createClient, type Runtime } from "@/client/create-client";
import type { ScenarioName } from "@/client/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BottomStrip } from "@/features/bottom-strip";
import { ContextTimeline } from "@/features/context-timeline";
import { Header } from "@/features/header";
import { Inspector } from "@/features/inspector";
import { MockControls } from "@/features/mock-controls";
import { WorkGraph } from "@/features/work-graph";
import type { MockClient } from "@/mock/client";
import { cn } from "@/lib/utils";
import { ConsoleProvider, useConsole } from "@/state/console-context";

export function App({ runtime }: { runtime: Runtime }) {
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
				<Shell scenario={scenario} onScenario={chooseScenario} controls={runtime.controls} />
			</ConsoleProvider>
		</TooltipProvider>
	);
}

function Shell({ scenario, onScenario, controls }: { scenario: ScenarioName; onScenario(next: ScenarioName): void; controls: boolean }) {
	const { client, connection, view } = useConsole();
	return (
		<div className="flex h-full flex-col bg-background">
			<Header scenario={scenario} onScenario={onScenario} connection={connection} poller={view.poller} />
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
