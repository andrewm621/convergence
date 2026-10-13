// Token and URL hygiene for anything that leaves the Worker (responses, logs, errors).
// Live Artifacts tokens look like `<prefix>_v<N>_<chars incl. underscore>?expires=<unix>`.
// The pattern is deliberately prefix-agnostic.
const TOKEN_RE = /\b[a-z]+_v\d+_[A-Za-z0-9_]{24,}(?:\?expires=\d+)?/g;
const URL_CREDENTIALS_RE = /(https?:\/\/)[^/\s@]+@/g;
const ACCOUNT_HOST_RE = /(\/\/)[0-9a-f]{32}(\.artifacts\.)/g;

/** Basic-auth password form of a token: drop the `?expires=...` suffix. */
export function stripExpiry(token: string): string {
	return token.split("?expires=")[0] ?? token;
}

/** Replace token-shaped strings, URL userinfo and the account id in the git host label. */
export function redactText(text: string): string {
	return text
		.replace(TOKEN_RE, "[redacted-token]")
		.replace(URL_CREDENTIALS_RE, "$1")
		.replace(ACCOUNT_HOST_RE, "$1<account>$2");
}

/** Deep-redact every string in a JSON-serialisable value. */
export function redactDeep<T>(value: T): T {
	if (typeof value === "string") return redactText(value) as T;
	if (Array.isArray(value)) return value.map(redactDeep) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
		) as T;
	}
	return value;
}
