import { buildDogfoodBuildScenario } from "scenario-delta-convergence-build";
import { buildNotificationsScenario } from "scenario-notifications";
import { buildSalesOpsScenario } from "scenario-sales-ops";
import { buildShelterIntakeScenario } from "scenario-shelter-intake";
import type { ClientHandlers, CommandResult, ConsoleClient, ConsoleMessage, ScenarioName } from "@/client/types";
import type { ActivityLine, BeatContext, MockScript, UiHint } from "./beats";
import { MockCell, type MockScenario } from "./cell";
import { buildScript } from "./script-build";
import { fanoutScript } from "./script-fanout";
import { notificationsScript } from "./script-notifications";
import { salesOpsScript } from "./script-sales-ops";
import { shelterIntakeScript } from "./script-shelter-intake";
import { MockSession } from "./session";

export type MockOptions = {
	scenario: ScenarioName;
	/** `seeded`: the baseline already holds v1 decisions. `empty`: no accepted context yet. */
	start?: "seeded" | "empty";
	/** Space agent output out over time. Off in tests. */
	drip?: boolean;
	/** Pause between an approved promotion and its merge. */
	promoteDelayMs?: number;
	/** When a human clicks Revalidate by hand, the agent re-run lands after this long. Null: only a beat lands it. */
	rerunDelayMs?: number | null;
	/** Which script to start on. */
	script?: string;
};

export type MockControlsState = {
	ready: boolean;
	busy: boolean;
	scenario: ScenarioName;
	scriptId: string;
	scripts: { id: string; label: string }[];
	beats: { title: string; caption: string }[];
	/** Beats already played. */
	position: number;
};

export type MockControls = {
	getState(): MockControlsState;
	subscribe(listener: () => void): () => void;
	next(): Promise<void>;
	prev(): Promise<void>;
	jump(position: number): Promise<void>;
	reset(): Promise<void>;
	setScript(id: string): Promise<void>;
	/** Start from an empty workspace, to show the empty state. */
	resetToEmpty(): Promise<void>;
	onUi(listener: (hint: UiHint) => void): () => void;
};

export type MockClient = ConsoleClient & { kind: "mock"; controls: MockControls };

type Loaded = { scenario: MockScenario; scripts: MockScript[] };

async function load(name: ScenarioName): Promise<Loaded> {
	if (name === "notifications") {
		const bundle = await buildNotificationsScenario();
		return { scenario: bundle, scripts: [notificationsScript(bundle), fanoutScript(bundle)] };
	}
	if (name === "delta-convergence-build") {
		const bundle = await buildDogfoodBuildScenario();
		// The fixture's events are keyed by step; the mock looks them up flat, and keeps their real timestamps.
		const events = Object.fromEntries(bundle.timeline.map((step) => [step.key, step.event]));
		return { scenario: { ...bundle, events, realTimestamps: true }, scripts: [buildScript(bundle)] };
	}
	if (name === "shelter-intake") {
		const bundle = await buildShelterIntakeScenario();
		return { scenario: bundle, scripts: [shelterIntakeScript(bundle)] };
	}
	const bundle = await buildSalesOpsScenario();
	return { scenario: bundle, scripts: [salesOpsScript(bundle)] };
}

/**
 * The mock client: the real reconciler in the browser, with a scripted world around it.
 * It speaks the same contract as the live client: a `snapshot`, then `event` and
 * `agent-activity` messages, so the console cannot tell them apart.
 */
export function createMockClient(options: MockOptions): MockClient {
	const drip = options.drip ?? true;
	const promoteDelayMs = options.promoteDelayMs ?? 700;
	const rerunDelayMs = options.rerunDelayMs === undefined ? 2500 : options.rerunDelayMs;

	let handlers: ClientHandlers | null = null;
	let loaded: Loaded | null = null;
	let cell: MockCell | null = null;
	let session: MockSession | null = null;
	let scriptId = options.script ?? "story";
	let startMode = options.start ?? "seeded";
	let position = 0;
	let busy = false;
	let ready = false;
	let disposed = false;
	let generation = 0;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const stateListeners = new Set<() => void>();
	const uiListeners = new Set<(hint: UiHint) => void>();
	let controlsState: MockControlsState | null = null;

	const emit = (message: ConsoleMessage) => {
		if (!disposed) handlers?.onMessage(message);
	};

	const script = (): MockScript => {
		const found = loaded?.scripts.find((s) => s.id === scriptId) ?? loaded?.scripts[0];
		if (!found) throw new Error("mock: scripts are not loaded");
		return found;
	};

	function publish() {
		controlsState = null;
		for (const listener of stateListeners) listener();
	}

	function clearTimers() {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	}

	function context(instant: boolean, c: MockCell, s: MockSession): BeatContext {
		return {
			session: s,
			cell: c,
			drip(lines: readonly ActivityLine[]) {
				lines.forEach(([workItemId, kind, text], index) => {
					if (instant || !drip) {
						c.say(workItemId, kind, text);
						return;
					}
					const timer = setTimeout(() => {
						timers.delete(timer);
						if (c === cell) c.say(workItemId, kind, text);
					}, 350 + index * 650);
					timers.add(timer);
				});
			},
		};
	}

	async function rebuildTo(target: number): Promise<void> {
		const mine = ++generation;
		if (!loaded) loaded = await load(options.scenario);
		clearTimers();
		const nextCell = new MockCell(loaded.scenario, emit);
		await nextCell.init(startMode);
		if (mine !== generation) return; // a newer rebuild (or a disconnect) took over
		const nextSession = new MockSession(nextCell, { promoteDelayMs });
		cell = nextCell;
		session = nextSession;

		// Replay the beats silently, then send one fresh snapshot (and the agent output so far).
		nextCell.mute(true);
		position = 0;
		for (const beat of script().beats.slice(0, target)) {
			await beat.run(context(true, nextCell, nextSession));
			if (mine !== generation) return;
			position += 1;
		}
		nextCell.mute(false);
		await nextCell.emitSnapshot();
		for (const line of nextCell.activityLog) emit(line);
	}

	async function playOne(): Promise<void> {
		if (!cell || !session) return;
		const beat = script().beats[position];
		if (!beat) return;
		const hint = await beat.run(context(false, cell, session));
		position += 1;
		if (hint) for (const listener of uiListeners) listener(hint);
	}

	async function guarded(action: () => Promise<void>): Promise<void> {
		if (busy || !ready) return;
		busy = true;
		publish();
		try {
			await action();
		} finally {
			busy = false;
			publish();
		}
	}

	const controls: MockControls = {
		getState() {
			if (!controlsState) {
				controlsState = {
					ready,
					busy,
					scenario: options.scenario,
					scriptId,
					scripts: (loaded?.scripts ?? []).map((s) => ({ id: s.id, label: s.label })),
					beats: loaded ? script().beats.map((b) => ({ title: b.title, caption: b.caption })) : [],
					position,
				};
			}
			return controlsState;
		},
		subscribe(listener) {
			stateListeners.add(listener);
			return () => stateListeners.delete(listener);
		},
		next: () => guarded(playOne),
		prev: () => guarded(() => rebuildTo(Math.max(0, position - 1))),
		jump: (target) =>
			guarded(async () => {
				const total = script().beats.length;
				const to = Math.max(0, Math.min(total, target));
				if (to > position) {
					while (position < to) await playOne();
				} else if (to < position) {
					await rebuildTo(to);
				}
			}),
		reset: () =>
			guarded(async () => {
				startMode = "seeded";
				await rebuildTo(0);
			}),
		resetToEmpty: () =>
			guarded(async () => {
				startMode = "empty";
				await rebuildTo(0);
			}),
		setScript: (id) =>
			guarded(async () => {
				scriptId = id;
				startMode = "seeded";
				await rebuildTo(0);
			}),
		onUi(listener) {
			uiListeners.add(listener);
			return () => uiListeners.delete(listener);
		},
	};

	const withSession = async <T>(fn: (s: MockSession) => Promise<T>, fallback: T): Promise<T> => (session ? fn(session) : fallback);

	const client: MockClient = {
		kind: "mock",
		scenario: options.scenario,
		capabilities: { seed: true, start: true, changes: true },
		controls,
		connect(next) {
			handlers = next;
			disposed = false;
			next.onConnection("mock");
			void (async () => {
				await rebuildTo(0);
				ready = true;
				publish();
			})();
			return () => {
				disposed = true;
				handlers = null;
				generation += 1;
				clearTimers();
			};
		},
		async refresh() {
			if (cell) await cell.emitSnapshot();
		},
		api: {
			gate: (id) => withSession((s) => s.gate(id), { pass: false, reasonCodes: ["UNKNOWN_WORK_ITEM"], blockers: [], waivedBy: [] }),
			changes: (id) => withSession((s) => s.changes(id), []),
			readRecordText: (id) => withSession(() => (cell ? cell.bodyOf(id) : Promise.resolve("")), ""),
			proposeContextChange: (input) => withSession((s) => s.proposeChange(input), fail("Not connected")),
			async resolve(input, key) {
				const result = await withSession((s) => s.resolve(input, key), fail("Not connected"));
				if (result.ok && input.kind === "revalidate" && rerunDelayMs !== null && session) {
					const owner = session;
					const timer = setTimeout(() => {
						timers.delete(timer);
						if (owner === session) void owner.completeRerun(input.workItemId);
					}, rerunDelayMs);
					timers.add(timer);
				}
				return result;
			},
			promote: (input, key) => withSession((s) => s.promote(input, key), fail("Not connected")),
			async seedScenario() {
				return withSession(async (s) => {
					await s.seedBaseline();
					return { ok: true as const, message: "Seeded the baseline decisions." };
				}, fail("Not connected"));
			},
			async startScenario() {
				return withSession(async (s) => {
					await s.seedIfEmpty();
					await s.startAgents(Object.keys(s.scenario.workItems));
					return { ok: true as const, message: "Agents started." };
				}, fail("Not connected"));
			},
		},
	};
	return client;
}

function fail(message: string): CommandResult {
	return { ok: false, code: "NOT_CONNECTED", message };
}
