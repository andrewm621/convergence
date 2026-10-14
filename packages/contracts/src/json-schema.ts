import { z } from "zod";
import * as contracts from "./index";
import { Condition, Policy, Resolution } from "./conditions";
import { ContextReceipt, ContextRecordFrontMatter, RecordSnapshot } from "./context";
import { DeltaEvent, Effect, ReconciliationEvent } from "./events";
import { CellState } from "./state";
import { ClaimsFile, Dependency, Evidence, WorkItem } from "./work";
import { CellSnapshot, WsMessage } from "./ws";

/**
 * JSON Schema (draft 2020-12) for the wire objects of the Convergence Protocol, generated from the Zod
 * contracts with Zod's own `z.toJSONSchema`. The Zod schemas are the source of truth; the files in
 * `packages/contracts/schema/` are derived and a test fails when they drift (`json-schema.test.ts`).
 *
 * A JSON Schema cannot express a Zod `superRefine`. Where a contract has cross-field rules, the schema's
 * `description` says so and names them, and the Zod schema stays normative for those rules.
 */

type Entry = { file: string; title: string; description: string; schema: z.ZodType };

/** One entry per top-level wire object documented in docs/PROTOCOL.md section 3. */
export const SCHEMA_ENTRIES: readonly Entry[] = [
	{
		file: "context-record-front-matter",
		title: "ContextRecordFrontMatter",
		description:
			"YAML front-matter of a context record file (context/**.md), as a JSON object. Not expressed here: an accepted record must have accepted_by and accepted_at; supersedes must name an earlier version of the same record; every key of `not` must be a key of `facets`.",
		schema: ContextRecordFrontMatter,
	},
	{
		file: "record-snapshot",
		title: "RecordSnapshot",
		description: "A parsed, hashed context record as the reconciler sees it (carried by BaselinePushed and held in the cell state).",
		schema: RecordSnapshot,
	},
	{
		file: "context-receipt",
		title: "ContextReceipt",
		description:
			"What was delivered to a work item, pinned to exact versions and hashes. The body of the git note at refs/notes/delta (after the delta-receipt/v1 header line). noteRef is a pointer and is not written into the note body.",
		schema: ContextReceipt,
	},
	{
		file: "claims-file",
		title: "ClaimsFile",
		description: "The contents of .delta/claims.json in a work item's fork: a list of structured, self-reported assertions.",
		schema: ClaimsFile,
	},
	{
		file: "evidence",
		title: "Evidence",
		description: "The result of a check at a specific head of a work item's fork.",
		schema: Evidence,
	},
	{
		file: "dependency",
		title: "Dependency",
		description: "A declared, verified or inferred reliance of a work item on a record (and optionally on named facets of it).",
		schema: Dependency,
	},
	{
		file: "work-item",
		title: "WorkItem",
		description: "A task for one actor on its own fork.",
		schema: WorkItem,
	},
	{
		file: "policy",
		title: "Policy",
		description: "The versioned rules a cell runs under: who is the authority for each record, staleness mode, global requirements, revalidation limit.",
		schema: Policy,
	},
	{
		file: "resolution",
		title: "Resolution",
		description: "A human disposition of a work item, bound to the exact context and fork head it was made against. Not expressed here: scope is required when kind is accept-exception.",
		schema: Resolution,
	},
	{
		file: "condition",
		title: "Condition",
		description: "An evaluated state on a work item, with the reason codes that explain it.",
		schema: Condition,
	},
	{
		file: "delta-event",
		title: "DeltaEvent",
		description: "Every input the reconciler accepts, discriminated by `type`.",
		schema: DeltaEvent,
	},
	{
		file: "effect",
		title: "Effect",
		description: "What the reconciler asks the surrounding system to do, discriminated by `type`.",
		schema: Effect,
	},
	{
		file: "reconciliation-event",
		title: "ReconciliationEvent",
		description: "One line of the append-only, hash-chained ledger. `hash` covers every other field of the line in canonical JSON.",
		schema: ReconciliationEvent,
	},
	{
		file: "cell-state",
		title: "CellState",
		description: "The whole state of one workspace cell. Plain JSON; reconcile is a pure function of this, an event and a policy.",
		schema: CellState,
	},
	{
		file: "cell-snapshot",
		title: "CellSnapshot",
		description: "The read model sent to a console: cell state minus internals, plus the ledger tail and head.",
		schema: CellSnapshot,
	},
	{
		file: "ws-message",
		title: "WsMessage",
		description: "A server-to-client message on the delta.v1 WebSocket subprotocol, discriminated by `type`. The reference implementation adds a top-level `meta` key to each frame; strip it before validating.",
		schema: WsMessage,
	},
];

/**
 * Every exported Zod schema, by export name. Shared definitions (Actor, ReasonCode, FacetValue, ...) become
 * named `$defs` in each file instead of being copied inline wherever they are used.
 */
const NAMED_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = Object.entries(contracts).flatMap(([name, value]) =>
	value instanceof z.ZodType && /^[A-Z]/.test(name) ? [[name, value] as const] : [],
);

function namesExcept(root: z.ZodType) {
	const registry = z.registry<{ id: string }>();
	for (const [name, schema] of NAMED_SCHEMAS) {
		if (schema !== root && !registry.has(schema)) registry.add(schema, { id: name });
	}
	return registry;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const ANONYMOUS_REF = /^#\/\$defs\/(__schema\d+)$/;

function anonymousRef(node: Json): string | null {
	if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
	const keys = Object.keys(node);
	const ref = node["$ref"];
	return keys.length === 1 && typeof ref === "string" ? (ANONYMOUS_REF.exec(ref)?.[1] ?? null) : null;
}

function countRefs(node: Json, counts: Map<string, number>): void {
	const name = anonymousRef(node);
	if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	if (node !== null && typeof node === "object") for (const child of Object.values(node)) countRefs(child, counts);
}

function substitute(node: Json, bodies: Map<string, Json>): Json {
	const name = anonymousRef(node);
	if (name && bodies.has(name)) return substitute(bodies.get(name) as Json, bodies);
	if (Array.isArray(node)) return node.map((child) => substitute(child, bodies));
	if (node !== null && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, substitute(child, bodies)]));
	return node;
}

/**
 * Zod extracts some one-off subschemas (those of refined objects) into anonymous `__schemaN` definitions.
 * Put the ones used exactly once back where they are used, so a reader sees the field, not a pointer. Shared
 * anonymous definitions stay, and so do all named ones.
 */
function inlineSingleUseDefs(document: { $defs?: Record<string, Json> } & Record<string, Json>): Record<string, Json> {
	const defs = document.$defs;
	if (!defs) return document;
	const counts = new Map<string, number>();
	countRefs(document as Json, counts);
	const once = new Map<string, Json>();
	for (const [name, body] of Object.entries(defs)) if (name.startsWith("__schema") && counts.get(name) === 1) once.set(name, body);
	const kept = Object.fromEntries(Object.entries(defs).filter(([name]) => !once.has(name)));
	const { $defs: _unused, ...rest } = document;
	const out = substitute(rest as Json, once) as Record<string, Json>;
	if (Object.keys(kept).length > 0) out["$defs"] = substitute(kept as Json, once);
	return out;
}

/** Generate every schema in memory. Keys are file names (with `.json`), values are the exact file text. */
export function generateSchemaFiles(): Record<string, string> {
	const files: Record<string, string> = {};
	for (const entry of SCHEMA_ENTRIES) {
		const generated = z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input", unrepresentable: "throw", reused: "ref", metadata: namesExcept(entry.schema) });
		const { $schema, ...rest } = generated as { $schema?: string } & Record<string, unknown>;
		const document = { $schema, title: entry.title, description: entry.description, ...inlineSingleUseDefs(rest as never) };
		files[`${entry.file}.json`] = `${JSON.stringify(document, null, 2)}\n`;
	}
	return files;
}
