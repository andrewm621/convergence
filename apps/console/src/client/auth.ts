/**
 * The bearer secret for live mode. It comes from a `#token=...` URL hash param or a prompt, lives
 * only in sessionStorage (so it dies with the tab and never reaches localStorage), is sent in an
 * Authorization header (REST) or the WebSocket subprotocol, and is never logged: nothing in this
 * file or the live client passes it to `console`, an error message or a URL.
 */

export const TOKEN_STORAGE_KEY = "delta-convergence.token";
const HASH_PARAM = "token";
/** The WebSocket subprotocol the Worker selects, and the prefix of the one that carries the secret. */
export const WS_PROTOCOL = "delta.v1";
const BEARER_PREFIX = "bearer.";

type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Used only when sessionStorage cannot hold the token (blocked or throwing), so the URL hash we already cleared is not the only copy. Dies with the page load; never persisted. */
let memoryToken: string | null = null;

function sessionStore(): TokenStorage | null {
	try {
		return typeof sessionStorage === "undefined" ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function readToken(storage: TokenStorage | null = sessionStore()): string | null {
	try {
		const stored = storage?.getItem(TOKEN_STORAGE_KEY);
		if (stored) return stored;
	} catch {
		// fall through to the in-memory copy
	}
	return memoryToken;
}

export function storeToken(token: string, storage: TokenStorage | null = sessionStore()): void {
	try {
		if (!storage) throw new Error("no storage");
		storage.setItem(TOKEN_STORAGE_KEY, token);
		memoryToken = null;
	} catch {
		// Storage can be unavailable (private mode): the token then lives in memory for this page load only.
		memoryToken = token;
	}
}

export function clearToken(storage: TokenStorage | null = sessionStore()): void {
	memoryToken = null;
	try {
		storage?.removeItem(TOKEN_STORAGE_KEY);
	} catch {
		// nothing to clear
	}
}

/** The token in a URL hash (`#token=abc` or `#a=1&token=abc`), plus the hash with it removed. Not form-decoded, so `+` survives. */
export function tokenFromHash(hash: string): { token: string | null; rest: string } {
	const parts = hash.replace(/^#/, "").split("&").filter(Boolean);
	let token: string | null = null;
	const rest: string[] = [];
	for (const part of parts) {
		const eq = part.indexOf("=");
		const name = eq === -1 ? part : part.slice(0, eq);
		if (name === HASH_PARAM && eq !== -1) {
			try {
				token = decodeURIComponent(part.slice(eq + 1));
			} catch {
				token = part.slice(eq + 1);
			}
		} else {
			rest.push(part);
		}
	}
	return { token: token || null, rest: rest.length ? `#${rest.join("&")}` : "" };
}

export type BootstrapOptions = {
	hash?: string;
	storage?: TokenStorage | null;
	/** Asks the person for the secret. `null` or an empty string means they declined. */
	prompt?: () => string | null;
	/** Called with the URL hash left after the token is taken out of it, so the secret does not stay in the address bar or history. */
	replaceHash?: (hash: string) => void;
};

/** Find the token for this tab: the URL hash first, then sessionStorage, then ask. Returns null if there is none. */
export function bootstrapToken(options: BootstrapOptions = {}): string | null {
	const storage = options.storage === undefined ? sessionStore() : options.storage;
	const hash = options.hash ?? (typeof location === "undefined" ? "" : location.hash);
	const fromHash = tokenFromHash(hash);
	if (fromHash.token) {
		storeToken(fromHash.token, storage);
		(options.replaceHash ?? defaultReplaceHash)(fromHash.rest);
		return fromHash.token;
	}
	const stored = readToken(storage);
	if (stored) return stored;
	const asked = (options.prompt ?? defaultPrompt)()?.trim();
	if (asked) {
		storeToken(asked, storage);
		return asked;
	}
	return null;
}

/** Ask again after the Worker refused the stored secret. */
export function promptForToken(storage: TokenStorage | null = sessionStore()): string | null {
	const asked = defaultPrompt()?.trim();
	if (!asked) return null;
	storeToken(asked, storage);
	return asked;
}

function defaultPrompt(): string | null {
	return typeof window === "undefined" ? null : window.prompt("Delta Convergence access token (kept only for this browser tab):");
}

function defaultReplaceHash(hash: string): void {
	if (typeof history === "undefined" || typeof location === "undefined") return;
	history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

/** base64url of the secret's UTF-8 bytes, as the Worker's subprotocol decoder expects. */
export function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The protocol list for `new WebSocket(url, protocols)`: `["delta.v1", "bearer.<b64url>"]`. */
export function socketProtocols(token: string | null): string[] {
	return token ? [WS_PROTOCOL, `${BEARER_PREFIX}${toBase64Url(token)}`] : [WS_PROTOCOL];
}
