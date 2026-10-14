import type { DogfoodBuildScenario } from "scenario-delta-convergence-build";
import type { Beat, MockScript } from "./beats";
import type { MockSession } from "./session";

/**
 * Convergence governs its own build: a replay of real stale events from this repo's git history.
 * Retrofitted: the decisions were made before Convergence was recording them, the dependencies are
 * declared by us, and humans resolve (so there are no resolutions and no agent output here). The beats play
 * the fixture's `timeline` in commit order through the real engine. The last one is invented: a wording-only
 * edit that has no commit, kept as the negative control.
 */
export function buildScript(bundle: DogfoodBuildScenario): MockScript {
	const byKey = new Map(bundle.timeline.map((step) => [step.key, step]));

	/** Send these timeline steps, in the order given, unless the cell already took them. */
	async function play(session: MockSession, keys: string[]): Promise<void> {
		const state = await session.cell.state();
		for (const key of keys) {
			const step = byKey.get(key);
			if (!step) throw new Error(`mock: no timeline step "${key}"`);
			if (key.startsWith("register-") && state.workItems[key.slice("register-".length)]) continue;
			await session.cell.send(step.event);
		}
	}

	const beats: Beat[] = [
		{
			id: "work-begins",
			title: "Seven pieces of our own work",
			caption:
				"The M4 loop, the console labels, the video script, the shelter fixtures, the shared brief, the README and the identity header, each with the decisions it relied on declared by us. Four have pushed work so far; the other three have not started.",
			async run({ session }) {
				await session.seedIfEmpty();
				await play(session, [...bundle.timeline.filter((s) => s.key.startsWith("register-")).map((s) => s.key), "push-WI-5", "push-WI-6", "push-WI-4", "push-WI-3"]);
				return { select: "WI-3", tab: "receipt" };
			},
		},
		{
			id: "county-renamed",
			title: "The county is renamed",
			caption: "Renamed the fictional county. Three pieces of our own work were built on the old name.",
			async run({ session }) {
				await play(session, ["namingV2"]);
				return { select: "WI-4", tab: "why" };
			},
		},
		{
			id: "more-work-lands",
			title: "More work lands",
			caption: "The identity header, the M4 loop and the console labels get their first versions. The M4 loop and the console labels assume the claims check counts as a contract test.",
			async run({ session }) {
				await play(session, ["push-WI-7", "push-WI-1", "push-WI-2"]);
				return { select: "WI-2", tab: "semantic" };
			},
		},
		{
			id: "evidence-v2",
			title: "What counts as a test changes",
			caption: "Changed what counts as a contract test. The console PR was built on the old rule.",
			async run({ session }) {
				await play(session, ["evidenceV2"]);
				return { select: "WI-2", tab: "why" };
			},
		},
		{
			id: "evidence-v3",
			title: "Checks assert the facets relied on",
			caption: "Contract checks now assert the facets each item relied on. Only the M4 loop relied on that, so it gains a stale facet; everything else is unchanged.",
			async run({ session }) {
				await play(session, ["evidenceV3"]);
				return { select: "WI-1", tab: "why" };
			},
		},
		{
			id: "wording-edit",
			title: "A wording-only edit",
			caption: "A wording-only edit. Nothing re-evaluated. This one is invented for the replay: it has no commit, and it is the negative control.",
			async run({ session }) {
				await play(session, ["productNamingProse"]);
				return { select: "WI-7", tab: "why" };
			},
		},
	];

	return { id: "story", label: "Our own build, in commit order", beats };
}
