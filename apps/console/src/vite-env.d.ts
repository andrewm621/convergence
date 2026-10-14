/// <reference types="vite/client" />

interface ImportMetaEnv {
	/** `1` replays Scenario A in the browser instead of connecting to the Worker. */
	readonly VITE_MOCK?: string;
	/** Base URL of the Convergence API. Empty means same origin. */
	readonly VITE_API_BASE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
