import type { FacetScalar, FacetValue } from "contracts";

export function shortHash(hash: string | null | undefined, length = 7): string {
	return hash ? hash.slice(0, length) : "none";
}

export function formatTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatDateTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export function formatMs(ms: number): string {
	if (ms < 0.01) return "<0.01 ms";
	if (ms < 1) return `${ms.toFixed(2)} ms`;
	if (ms < 100) return `${ms.toFixed(1)} ms`;
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}

/** Facet values as a human reads them: strings bare, lists in brackets. */
export function formatFacet(value: FacetValue | null | undefined): string {
	if (value === undefined) return "(not set)";
	if (Array.isArray(value)) return `[${value.map(formatScalar).join(", ")}]`;
	return formatScalar(value);
}

function formatScalar(value: FacetScalar): string {
	return value === null ? "null" : String(value);
}

/** Parse what a person typed into a facet field: booleans, numbers, `[a, b]` lists, else text. */
export function parseFacetInput(text: string): FacetValue {
	const trimmed = text.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part !== "")
			.map((part) => (part === "true" ? true : part === "false" ? false : part !== "" && Number.isFinite(Number(part)) ? Number(part) : part));
	}
	return trimmed;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
