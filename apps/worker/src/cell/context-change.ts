import { z } from "zod";
import { CommitSha, FacetKey, FacetScalar, FacetValue, Slug, canonicalJson, parseContextRecord, type Actor, type ContextRecordFrontMatter } from "contracts";

// A context change is a commit to the baseline, made by the Worker as the acting human. This file
// builds the files for it: the new record version (or a prose-only edit) and a decision stub.

export const ContextChangeRequest = z.strictObject({
	recordId: Slug,
	/** The record's facets after the change. Omit to leave them as they are (a prose edit). */
	facets: z.record(FacetKey, FacetValue).optional(),
	/** Values the facets must no longer hold (documentation only). */
	not: z.record(FacetKey, z.union([FacetScalar, z.array(FacetScalar)])).optional(),
	/** The Markdown after the front-matter. Omit to keep the current prose. */
	prose: z.string().max(100_000).optional(),
	rationale: z.string().trim().min(1).max(2000),
	/** Force a new version even though no facet changed. */
	bumpVersion: z.boolean().optional(),
	/** Name part of the decision file, `decisions/NNNN-<slug>.md`. */
	decisionSlug: Slug.optional(),
	/** Compare-and-swap on the baseline: refuse if it is no longer at this commit. */
	expectedBaselineCommit: CommitSha.optional(),
});
export type ContextChangeRequest = z.infer<typeof ContextChangeRequest>;

export type PreviousRecord = { path: string; text: string };

export type ContextChangePlan =
	| {
			ok: true;
			kind: "first-version" | "new-version" | "prose-edit";
			recordId: string;
			version: number;
			path: string;
			decisionPath: string | null;
			files: Record<string, string>;
			message: string;
	  }
	| { ok: false; code: "INVALID_INPUT" | "RECORD_UNREADABLE" | "NOTHING_TO_CHANGE"; message: string };

export function planContextChange(input: {
	request: ContextChangeRequest;
	actor: Actor;
	now: string;
	idempotencyKey: string;
	previous: PreviousRecord | null;
	/** The version the reconciler currently holds as accepted, so a new version never collides with it. */
	currentVersion: number | null;
	existingPaths: string[];
}): ContextChangePlan {
	const { request, actor, now } = input;
	const id = request.recordId;

	let frontMatter: ContextRecordFrontMatter;
	let body: string;
	let kind: "first-version" | "new-version" | "prose-edit";
	let version: number;
	let path: string;
	let previousFacets: Record<string, unknown> = {};

	if (input.previous === null) {
		if (request.facets === undefined || Object.keys(request.facets).length === 0) {
			return { ok: false, code: "INVALID_INPUT", message: `${id} does not exist yet; its first version needs facets.` };
		}
		kind = "first-version";
		version = 1;
		path = `context/${id}.md`;
		body = request.prose ?? `# ${id}\n`;
		frontMatter = {
			id,
			version,
			status: "accepted",
			authority: actor.id,
			proposed_by: actor.id,
			accepted_by: actor.id,
			accepted_at: now,
			facets: request.facets,
			...(request.not ? { not: request.not } : {}),
		};
	} else {
		const parsed = parseContextRecord(input.previous.text);
		if (!parsed.ok) return { ok: false, code: "RECORD_UNREADABLE", message: `${input.previous.path} cannot be read: ${parsed.error}` };
		const prev = parsed.record.frontMatter;
		previousFacets = prev.facets;
		path = input.previous.path;
		const facetsChanged = request.facets !== undefined && canonicalJson(request.facets) !== canonicalJson(prev.facets);
		const newVersion = facetsChanged || request.bumpVersion === true;
		if (newVersion) {
			kind = "new-version";
			version = Math.max(prev.version, input.currentVersion ?? 0) + 1;
			body = request.prose ?? parsed.record.body;
			frontMatter = {
				id,
				version,
				status: "accepted",
				authority: prev.authority,
				proposed_by: actor.id,
				accepted_by: actor.id,
				accepted_at: now,
				supersedes: `${id}@${Math.max(prev.version, input.currentVersion ?? 0)}`,
				...(prev.validation ? { validation: prev.validation } : {}),
				facets: request.facets ?? prev.facets,
				...(request.not ? { not: request.not } : {}),
			};
		} else {
			if (request.prose === undefined || request.prose === parsed.record.body) {
				return { ok: false, code: "NOTHING_TO_CHANGE", message: "No facet and no prose differs from the current record; nothing to commit." };
			}
			// Same version, same facets: only the prose moves. The front-matter is kept as it was.
			kind = "prose-edit";
			version = prev.version;
			body = request.prose;
			frontMatter = prev;
		}
	}

	const decisionPath = kind === "prose-edit" ? null : nextDecisionPath(input.existingPaths, request.decisionSlug ?? `${id}-v${version}`);
	if (decisionPath && kind === "new-version") frontMatter = { ...frontMatter, decision: decisionPath };

	const text = renderRecord(frontMatter, body);
	const check = parseContextRecord(text);
	if (!check.ok || canonicalJson(check.record.frontMatter.facets) !== canonicalJson(frontMatter.facets) || check.record.frontMatter.version !== version) {
		return { ok: false, code: "INVALID_INPUT", message: `The change does not produce a valid record${check.ok ? "" : `: ${check.error}`}.` };
	}

	const files: Record<string, string> = { [path]: text };
	if (decisionPath) {
		files[decisionPath] = renderDecision({ recordId: id, version, supersedes: frontMatter.supersedes ?? null, actor, now, rationale: request.rationale, before: previousFacets, after: frontMatter.facets });
	}

	const subject = request.rationale.replace(/\s+/g, " ").slice(0, 60);
	const message = `${kind === "prose-edit" ? "context (prose)" : "context"}: ${id}${kind === "prose-edit" ? "" : ` v${version}`}: ${subject}\n\nDecided-by: ${actor.id}\nIdempotency-Key: ${input.idempotencyKey}\n`;
	return { ok: true, kind, recordId: id, version, path, decisionPath, files, message };
}

/** `decisions/NNNN-slug.md` with NNNN one past the highest number already in `decisions/`. */
export function nextDecisionPath(existingPaths: string[], slug: string): string {
	let highest = 0;
	for (const path of existingPaths) {
		const match = /^decisions\/(\d{4,})-/.exec(path);
		if (match?.[1]) highest = Math.max(highest, Number(match[1]));
	}
	return `decisions/${String(highest + 1).padStart(4, "0")}-${slug}.md`;
}

// JSON scalars and flow collections are valid YAML, so every value is written with JSON.stringify:
// that quotes `on`, `null` and `123` correctly without a YAML emitter.
const q = (value: unknown) => JSON.stringify(value);

export function renderRecord(fm: ContextRecordFrontMatter, body: string): string {
	const lines = ["---", `id: ${fm.id}`, `version: ${fm.version}`, `status: ${fm.status}`, `authority: ${q(fm.authority)}`, `proposed_by: ${q(fm.proposed_by)}`];
	if (fm.accepted_by) lines.push(`accepted_by: ${q(fm.accepted_by)}`);
	if (fm.accepted_at) lines.push(`accepted_at: ${q(fm.accepted_at)}`);
	if (fm.supersedes) lines.push(`supersedes: ${fm.supersedes}`);
	if (fm.validation) lines.push(`validation: ${q(fm.validation)}`);
	if (fm.decision) lines.push(`decision: ${q(fm.decision)}`);
	lines.push("facets:");
	for (const key of Object.keys(fm.facets).sort()) lines.push(`  ${q(key)}: ${q(fm.facets[key])}`);
	const not = fm.not ?? {};
	if (Object.keys(not).length > 0) {
		lines.push("not:");
		for (const key of Object.keys(not).sort()) lines.push(`  ${q(key)}: ${q(not[key])}`);
	}
	lines.push("---");
	return `${lines.join("\n")}\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

function renderDecision(d: {
	recordId: string;
	version: number;
	supersedes: string | null;
	actor: Actor;
	now: string;
	rationale: string;
	before: Record<string, unknown>;
	after: Record<string, unknown>;
}): string {
	const changes: string[] = [];
	for (const key of [...new Set([...Object.keys(d.before), ...Object.keys(d.after)])].sort()) {
		const was = key in d.before ? canonicalJson(d.before[key]) : "(absent)";
		const now = key in d.after ? canonicalJson(d.after[key]) : "(removed)";
		if (was !== now) changes.push(`- \`${key}\`: ${was} -> ${now}`);
	}
	return [
		`# Decision: ${d.recordId} v${d.version}`,
		"",
		`- Record: ${d.recordId}@${d.version}${d.supersedes ? ` (supersedes ${d.supersedes})` : ""}`,
		`- Decided by: ${d.actor.id}`,
		`- Date: ${d.now}`,
		"",
		"## Facet changes",
		"",
		...(changes.length > 0 ? changes : ["- none (prose only)"]),
		"",
		"## Rationale",
		"",
		d.rationale,
		"",
	].join("\n");
}
