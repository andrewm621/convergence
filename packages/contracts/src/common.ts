import { z } from "zod";

/** Lowercase hex SHA-256. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256");
export type Sha256 = z.infer<typeof Sha256>;

/** A full git commit id: 40 hex characters (sha-1) or 64 (sha-256). Abbreviated shas are not ids. */
export const CommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full 40 or 64 char hex commit sha");
export type CommitSha = z.infer<typeof CommitSha>;

/** ISO-8601 instant, e.g. 2026-10-13T16:00:00Z. Time is always an input, never read inside delta-core. */
export const IsoTimestamp = z.iso.datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

export const Slug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "expected a lowercase slug");

/** Identity of a human, an agent or the system itself. Only humans may resolve or promote. */
export const Actor = z.strictObject({
	kind: z.enum(["human", "agent", "system"]),
	id: z.string().min(1),
	displayName: z.string().min(1),
});
export type Actor = z.infer<typeof Actor>;

/** One governed key inside an accepted decision, e.g. `notifications.default`. */
export const FacetKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "invalid facet key");
export type FacetKey = z.infer<typeof FacetKey>;

export const FacetScalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type FacetScalar = z.infer<typeof FacetScalar>;

/** A facet value is a scalar or a flat list of scalars. Nested objects are rejected (fail closed). */
export const FacetValue = z.union([FacetScalar, z.array(FacetScalar)]);
export type FacetValue = z.infer<typeof FacetValue>;

/** `recordId@version`, the form claims and supersedes pointers use. */
export const RecordRefString = z.string().regex(/^[a-z0-9][a-z0-9_-]*@[1-9][0-9]*$/, "expected recordId@version");
export type RecordRefString = z.infer<typeof RecordRefString>;

/** Three-way string comparator for `sort`: never returns "greater" for equal strings. */
export function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function formatRecordRef(recordId: string, version: number): string {
	return `${recordId}@${version}`;
}

export function parseRecordRef(ref: string): { recordId: string; version: number } | null {
	const parsed = RecordRefString.safeParse(ref);
	if (!parsed.success) return null;
	const at = ref.lastIndexOf("@");
	return { recordId: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}
