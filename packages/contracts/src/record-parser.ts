import { parseDocument } from "yaml";
import type { FacetScalar } from "./common";
import { ContextRecordFrontMatter, type ObjectHash, type RecordSnapshot } from "./context";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./hash";

export type ParsedContextRecord = {
	frontMatter: ContextRecordFrontMatter;
	/** Markdown after the front-matter. Prose is not governed; only facets are. */
	body: string;
};

export type ParseContextRecordResult = { ok: true; record: ParsedContextRecord } | { ok: false; error: string };

const FENCE = /^---[ \t]*$/;

/**
 * Parse a `context/**.md` file: YAML front-matter between `---` fences, then Markdown.
 * Never throws. Anything malformed (no fence, bad YAML, duplicate keys, aliases, unknown keys,
 * wrong types) is an `{ ok: false }` so callers fail closed.
 */
export function parseContextRecord(text: string): ParseContextRecordResult {
	const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
	if (lines[0] === undefined || !FENCE.test(lines[0])) return { ok: false, error: "missing opening --- front-matter fence" };
	const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
	if (close === -1) return { ok: false, error: "missing closing --- front-matter fence" };

	// YAML 1.2 core schema: `opt-in`, `on` and ISO timestamps stay strings; no implicit dates or YAML 1.1 booleans.
	const doc = parseDocument(lines.slice(1, close).join("\n"), { schema: "core", uniqueKeys: true });
	if (doc.errors.length > 0) return { ok: false, error: `invalid YAML: ${doc.errors[0]?.message ?? "unknown error"}` };
	if (doc.warnings.length > 0) return { ok: false, error: `invalid YAML: ${doc.warnings[0]?.message ?? "unknown warning"}` };

	let data: unknown;
	try {
		// maxAliasCount 0 disallows YAML aliases, so a record cannot expand itself.
		data = doc.toJS({ maxAliasCount: 0 });
	} catch (error) {
		return { ok: false, error: `invalid YAML: ${error instanceof Error ? error.message : "unreadable"}` };
	}
	const parsed = ContextRecordFrontMatter.safeParse(data);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return { ok: false, error: `invalid front-matter at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown"}` };
	}
	return { ok: true, record: { frontMatter: parsed.data, body: lines.slice(close + 1).join("\n") } };
}

/** Normalize `not` (scalar or list) to lists, with keys in a stable order. */
export function normalizeNot(not: ContextRecordFrontMatter["not"]): Record<string, FacetScalar[]> {
	const out: Record<string, FacetScalar[]> = {};
	for (const key of Object.keys(not ?? {}).sort()) {
		const value = (not ?? {})[key];
		out[key] = Array.isArray(value) ? value : [value as FacetScalar];
	}
	return out;
}

/**
 * Hash of the governed part of a record: its facets. Prose never enters it, and neither does
 * `not` (it documents rejected alternatives and is not a governed value).
 */
export async function hashFacets(facets: RecordSnapshot["facets"]): Promise<string> {
	return sha256Hex(canonicalJson(facets));
}

/**
 * Parse a record file and compute the hashes the reconciler needs. `blobHash` defaults to the
 * sha-256 of the file text; pass the git blob oid when you have it.
 */
export async function toRecordSnapshot(
	text: string,
	options: { blobHash?: ObjectHash } = {},
): Promise<{ ok: true; snapshot: RecordSnapshot; body: string } | { ok: false; error: string }> {
	const result = parseContextRecord(text);
	if (!result.ok) return result;
	const fm = result.record.frontMatter;
	const not = normalizeNot(fm.not);
	return {
		ok: true,
		body: result.record.body,
		snapshot: {
			recordId: fm.id,
			version: fm.version,
			status: fm.status,
			authority: fm.authority,
			acceptedBy: fm.accepted_by ?? null,
			acceptedAt: fm.accepted_at ?? null,
			validation: fm.validation ?? null,
			facets: fm.facets,
			not,
			blobHash: options.blobHash ?? (await sha256Hex(text)),
			facetHash: await hashFacets(fm.facets),
		},
	};
}
