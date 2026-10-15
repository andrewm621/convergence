import { ChartNoAxesGantt, Film, Info, KeyRound, LayoutList, Moon, Network, Radio, Sun, TriangleAlert, User, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { promptForToken } from "@/client/auth";
import { SCENARIOS, type ConnectionState, type PollerHealth, type ScenarioName } from "@/client/types";
import { ACTING_AS, POLL_INTERVAL_MS } from "@/config";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/state/console-context";
import { SCENARIO_META, SYNTHETIC_NOTE, scenarioMeta } from "./scenario-meta";

/** The scenarios the switcher offers: the open one always, the rest unless hidden, or replay-only while the console is live. */
export function visibleScenarios(value: ScenarioName, live: boolean): ScenarioName[] {
	return SCENARIOS.filter((name) => name === value || (!SCENARIO_META[name].hidden && !(live && SCENARIO_META[name].replayOnly)));
}

/** `compact`: the scenarios not open show as icons (named in their tooltip and to screen readers) below 2xl, to make room for Work | Map. Only the open one shows its kind until very wide screens, so four scenarios fit at 1920 (three, the live set, keep the kind at 2xl). */
export function ScenarioSwitcher({ value, onChange, live = false, compact = false }: { value: ScenarioName; onChange(next: ScenarioName): void; live?: boolean; compact?: boolean }) {
	const names = visibleScenarios(value, live);
	// With four tabs the ones not open wait for very wide screens to show their kind; three fit at 2xl.
	const crowded = names.length > 3;
	return (
		<div role="radiogroup" aria-label="Scenario" className="inline-flex shrink-0 items-center rounded-lg border bg-muted p-0.5">
			{names.map((name) => {
				const meta = name === value ? scenarioMeta(name, live) : SCENARIO_META[name];
				const Icon = meta.icon;
				const active = name === value;
				const iconOnly = compact && !active;
				return (
					<button
						key={name}
						type="button"
						role="radio"
						aria-checked={active}
						title={iconOnly ? `${meta.label} · ${meta.kind}` : undefined}
						onClick={() => onChange(name)}
						className={cn(
							"inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
							iconOnly && "px-2.5 2xl:px-3",
							active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-3.5" aria-hidden />
						<span className={iconOnly ? "sr-only 2xl:not-sr-only" : undefined}>{meta.label}</span>{" "}
						<span className={cn("hidden text-xs font-normal text-muted-foreground", active || !crowded ? "2xl:inline" : "min-[2200px]:inline")}>· {meta.kind}</span>
					</button>
				);
			})}
		</div>
	);
}

const MODES: { value: ViewMode; label: string; icon: typeof Radio; hint: string }[] = [
	{ value: "work", label: "Work", icon: LayoutList, hint: "What needs you, and where the rest of the work stands" },
	{ value: "map", label: "Map", icon: Network, hint: "Who is building on which decision, as a graph" },
	{ value: "process", label: "Process", icon: ChartNoAxesGantt, hint: "What each agent did over time, and where a decision change landed" },
];

/** Work | Map | Process: the new shell's views. Below 1440 px the buttons show as icons (named in their tooltip and to screen readers), so three views fit the header at 1280. */
export function ModeSwitcher({ value, onChange }: { value: ViewMode; onChange(next: ViewMode): void }) {
	return (
		<div role="radiogroup" aria-label="View" data-testid="mode-switcher" className="inline-flex shrink-0 items-center rounded-lg border bg-muted p-0.5">
			{MODES.map(({ value: mode, label, icon: Icon, hint }) => {
				const active = mode === value;
				return (
					<button
						key={mode}
						type="button"
						role="radio"
						aria-checked={active}
						title={hint}
						onClick={() => onChange(mode)}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
							"px-2.5 min-[1440px]:px-3",
							active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-3.5" aria-hidden />
						<span className="sr-only min-[1440px]:not-sr-only">{label}</span>
					</button>
				);
			})}
		</div>
	);
}

const CONNECTION_META: Record<ConnectionState, { text: string; tone: "success" | "warning" | "danger" | "info" | "neutral"; icon: typeof Radio; hint: string }> = {
	mock: {
		text: "Mock · replay",
		tone: "info",
		icon: Film,
		hint: "A scripted scenario replayed through the real reconciler in this browser. Not a live run.",
	},
	live: { text: "Live", tone: "success", icon: Radio, hint: "Connected to the Convergence Worker over WebSocket." },
	connecting: { text: "Connecting", tone: "neutral", icon: Radio, hint: "Opening the WebSocket." },
	reconnecting: { text: "Reconnecting", tone: "warning", icon: TriangleAlert, hint: "The socket dropped. Reconnecting and resuming from the last ledger line." },
	polling: { text: `Polling every ${POLL_INTERVAL_MS / 1000} s`, tone: "warning", icon: TriangleAlert, hint: "The socket is unavailable, so the console is re-reading state over REST." },
	offline: { text: "Offline", tone: "danger", icon: WifiOff, hint: "The Convergence API cannot be reached." },
	unauthorized: { text: "Token refused", tone: "danger", icon: KeyRound, hint: "The Worker refused the access token. Enter it again." },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
	const meta = CONNECTION_META[state];
	const Icon = meta.icon;
	return (
		<Badge tone={meta.tone} title={meta.hint} data-connection={state} role="status" className="h-7 px-2.5 text-[13px]">
			<Icon aria-hidden className={cn("size-3.5", state === "live" && "run-pulse")} />
			{meta.text}
		</Badge>
	);
}

/**
 * "Poller degraded": the poller that reads the Artifacts repos is failing, so a change could be
 * sitting unread. Shown whenever the Worker says so, and while it shows nothing is called Fresh.
 */
export function PollerBadge({ poller }: { poller: PollerHealth | null }) {
	if (!poller || poller.healthy) return null;
	const lines = poller.degraded.map((d) => `${d.kind} ${d.repo}: ${d.note ?? d.lastError ?? "failing"}`);
	const hint = ["The poller that reads the repos is behind, so Convergence cannot confirm that work is current. Nothing is shown as Fresh and Merge is closed until it recovers.", ...lines].join("\n");
	return (
		<Badge tone="warning" title={hint} data-testid="poller-degraded" role="status" className="h-7 px-2.5 text-[13px]">
			<TriangleAlert aria-hidden className="size-3.5" />
			Poller degraded
			{poller.degraded.length > 0 && <span className="font-normal">· {poller.degraded.length === 1 ? "1 repo" : `${poller.degraded.length} repos`}</span>}
		</Badge>
	);
}

type Theme = "light" | "dark";

function currentTheme(): Theme {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(currentTheme);
	useEffect(() => {
		document.documentElement.classList.toggle("dark", theme === "dark");
		try {
			localStorage.setItem("delta-theme", theme);
		} catch {
			// private mode: the theme just will not persist
		}
	}, [theme]);
	return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

export function Header({
	scenario,
	onScenario,
	connection,
	poller = null,
	live = false,
	mode,
	onMode,
}: {
	scenario: ScenarioName;
	/** The new shell's Work | Map control. Left out, the header has none (the classic shell). */
	mode?: ViewMode;
	onMode?(next: ViewMode): void;
	/** The live client, not the mock. */
	live?: boolean;
	onScenario(next: ScenarioName): void;
	connection: ConnectionState;
	poller?: PollerHealth | null;
}) {
	const [theme, toggleTheme] = useTheme();
	const { note, noteLead = SYNTHETIC_NOTE } = scenarioMeta(scenario, live);
	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-4 border-b bg-card px-4">
				<div className="flex shrink-0 items-center gap-2.5">
					<div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground" aria-hidden>
						<span className="text-[15px] leading-none font-bold">Δ</span>
					</div>
					<div className="leading-tight whitespace-nowrap">
						<div className="flex items-baseline gap-2">
							<span className="text-sm font-semibold tracking-tight">Convergence</span>
							<span className="text-[11px] text-muted-foreground" data-testid="no-model-line">
								No model makes these calls.
							</span>
						</div>
						<div className="text-xs text-muted-foreground" data-testid="tagline">
							Blocks work built on a decision that changed.
						</div>
					</div>
				</div>
				<div className="h-6 w-px shrink-0 bg-border" aria-hidden />
				{mode && onMode && <ModeSwitcher value={mode} onChange={onMode} />}
				<ScenarioSwitcher value={scenario} onChange={onScenario} live={live} compact={mode !== undefined} />
				<div className="ml-auto flex shrink-0 items-center gap-3">
					<PollerBadge poller={poller} />
					<ConnectionBadge state={connection} />
					{connection === "unauthorized" && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								// The secret goes straight into sessionStorage; the page reloads to reconnect with it.
								if (promptForToken()) window.location.reload();
							}}
						>
							<KeyRound aria-hidden /> Enter token
						</Button>
					)}
					<Badge tone="primary" className="h-7 px-2.5 text-[13px]" data-testid="acting-as">
						<User aria-hidden className="size-3.5" />
						{ACTING_AS}
					</Badge>
					<Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}>
						{theme === "dark" ? <Sun /> : <Moon />}
					</Button>
				</div>
			</header>
			{note && (
				<div role="note" data-testid="scenario-note" className="flex shrink-0 items-center gap-2 border-b bg-info/10 px-4 py-1.5 text-[13px] text-foreground">
					<Info aria-hidden className="size-3.5 shrink-0 text-info" />
					<span>
						<strong className="font-semibold">{noteLead}</strong> {note.slice(noteLead.length).trim()}
					</span>
				</div>
			)}
		</>
	);
}
