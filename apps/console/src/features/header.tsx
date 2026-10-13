import { Film, Info, KeyRound, Moon, Radio, Sun, TriangleAlert, User, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { promptForToken } from "@/client/auth";
import { SCENARIOS, type ConnectionState, type PollerHealth, type ScenarioName } from "@/client/types";
import { ACTING_AS, POLL_INTERVAL_MS } from "@/config";
import { cn } from "@/lib/utils";
import { SCENARIO_META, SYNTHETIC_NOTE, scenarioMeta } from "./scenario-meta";

export function ScenarioSwitcher({ value, onChange, live = false }: { value: ScenarioName; onChange(next: ScenarioName): void; live?: boolean }) {
	return (
		<div role="radiogroup" aria-label="Scenario" className="inline-flex items-center rounded-lg border bg-muted p-0.5">
			{SCENARIOS.filter((name) => name === value || !SCENARIO_META[name].hidden).map((name) => {
				const meta = name === value ? scenarioMeta(name, live) : SCENARIO_META[name];
				const Icon = meta.icon;
				const active = name === value;
				return (
					<button
						key={name}
						type="button"
						role="radio"
						aria-checked={active}
						onClick={() => onChange(name)}
						className={cn(
							"inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
							active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
						)}
					>
						<Icon className="size-3.5" aria-hidden />
						{meta.label}{" "}
						<span className="hidden text-xs font-normal text-muted-foreground xl:inline">· {meta.kind}</span>
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
	live: { text: "Live", tone: "success", icon: Radio, hint: "Connected to the Delta Convergence Worker over WebSocket." },
	connecting: { text: "Connecting", tone: "neutral", icon: Radio, hint: "Opening the WebSocket." },
	reconnecting: { text: "Reconnecting", tone: "warning", icon: TriangleAlert, hint: "The socket dropped. Reconnecting and resuming from the last ledger line." },
	polling: { text: `Polling every ${POLL_INTERVAL_MS / 1000} s`, tone: "warning", icon: TriangleAlert, hint: "The socket is unavailable, so the console is re-reading state over REST." },
	offline: { text: "Offline", tone: "danger", icon: WifiOff, hint: "The Delta Convergence API cannot be reached." },
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
	const hint = ["The poller that reads the repos is behind, so Delta Convergence cannot confirm that work is current. Nothing is shown as Fresh and Promote is closed until it recovers.", ...lines].join("\n");
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
}: {
	scenario: ScenarioName;
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
				<div className="flex items-center gap-2.5">
					<div className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground" aria-hidden>
						<span className="text-[15px] leading-none font-bold">Δ</span>
					</div>
					<div className="leading-tight">
						<div className="text-sm font-semibold tracking-tight">Delta Convergence</div>
						<div className="text-xs text-muted-foreground">Console</div>
					</div>
				</div>
				<div className="mx-2 h-6 w-px bg-border" aria-hidden />
				<ScenarioSwitcher value={scenario} onChange={onScenario} live={live} />
				<div className="ml-auto flex items-center gap-3">
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
