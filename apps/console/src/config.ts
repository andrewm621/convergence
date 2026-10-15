/**
 * Console-wide constants.
 *
 * The console has no real authentication, and says so. The demo identity appears in exactly
 * one place: this constant, which the header and the mock both read.
 */
export const DEMO_IDENTITY = {
	// Keep in step with `DEMO_ACTOR_NAME` in apps/worker/wrangler.jsonc, which names the ledger actor the Worker records.
	name: "Decision owner",
	label: "Decision owner (demo identity)",
} as const;

export const ACTING_AS = `Acting as: ${DEMO_IDENTITY.label}`;

/** Shown wherever an action is disabled in the public read-only view, and as the one-line note under the header. */
export const PUBLIC_READ_ONLY_NOTE = "Read-only public view. Actions need the maintainer's token.";

/** How often the live client polls the REST state read when the socket is down. */
export const POLL_INTERVAL_MS = 3000;

/** Base URL of the Convergence API. Empty means "same origin", which is how the Worker serves the console. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";
