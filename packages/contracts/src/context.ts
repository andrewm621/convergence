import { z } from "zod";
import { CommitSha, FacetKey, FacetScalar, FacetValue, IsoTimestamp, RecordRefString, Sha256, Slug, parseRecordRef } from "./common";

/** Content id of a record file: a git blob oid (sha-1) or a sha-256 of the bytes. Opaque to delta-core. */
export const ObjectHash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a 40 or 64 char hex hash");
export type ObjectHash = z.infer<typeof ObjectHash>;

export const RecordStatus = z.enum(["proposed", "accepted", "superseded"]);
export type RecordStatus = z.infer<typeof RecordStatus>;

const NotValues = z.union([FacetScalar, z.array(FacetScalar)]);

/**
 * Front-matter of `context/**.md`. Strict: unknown keys, wrong types, nested facet values and
 * accepted records without an acceptor are all rejected, so a malformed record fails closed.
 */
export const ContextRecordFrontMatter = z
	.strictObject({
		id: Slug,
		version: z.number().int().min(1),
		status: RecordStatus,
		authority: z.string().min(1),
		proposed_by: z.string().min(1),
		accepted_by: z.string().min(1).nullish(),
		accepted_at: IsoTimestamp.nullish(),
		supersedes: RecordRefString.nullish(),
		/** The Delta-run check (rule R8) that asserts this record against code. */
		validation: z.string().min(1).nullish(),
		decision: z.string().min(1).nullish(),
		facets: z.record(FacetKey, FacetValue),
		/** Per-facet values the facet must NOT hold (typically the superseded value). Documentation: not governed, not hashed. */
		not: z.record(FacetKey, NotValues).nullish(),
	})
	.superRefine((fm, ctx) => {
		if (fm.status === "accepted") {
			if (!fm.accepted_by) ctx.addIssue({ code: "custom", path: ["accepted_by"], message: "accepted records need accepted_by" });
			if (!fm.accepted_at) ctx.addIssue({ code: "custom", path: ["accepted_at"], message: "accepted records need accepted_at" });
		}
		if (fm.supersedes) {
			const ref = parseRecordRef(fm.supersedes);
			if (!ref || ref.recordId !== fm.id || ref.version >= fm.version) {
				ctx.addIssue({ code: "custom", path: ["supersedes"], message: "supersedes must point at an earlier version of the same record" });
			}
		}
		for (const key of Object.keys(fm.not ?? {})) {
			if (!(key in fm.facets)) ctx.addIssue({ code: "custom", path: ["not", key], message: "`not` names a facet the record does not define" });
		}
	});
export type ContextRecordFrontMatter = z.infer<typeof ContextRecordFrontMatter>;

/**
 * A parsed, hashed context record as the reconciler sees it. Built from the file text by
 * `toRecordSnapshot`; the Worker sends these in a `BaselinePushed` event.
 */
export const RecordSnapshot = z.strictObject({
	recordId: Slug,
	version: z.number().int().min(1),
	status: RecordStatus,
	authority: z.string().min(1),
	acceptedBy: z.string().min(1).nullable(),
	acceptedAt: IsoTimestamp.nullable(),
	validation: z.string().min(1).nullable(),
	facets: z.record(FacetKey, FacetValue),
	not: z.record(FacetKey, z.array(FacetScalar)),
	blobHash: ObjectHash,
	facetHash: Sha256,
});
export type RecordSnapshot = z.infer<typeof RecordSnapshot>;

/** `{recordId, version, blobHash}` compiled for one work item. */
export const ContextSnapshotEntry = z.strictObject({
	recordId: Slug,
	version: z.number().int().min(1),
	blobHash: ObjectHash,
});
export type ContextSnapshotEntry = z.infer<typeof ContextSnapshotEntry>;
export const ContextSnapshot = z.array(ContextSnapshotEntry);
export type ContextSnapshot = z.infer<typeof ContextSnapshot>;

export const ReceiptEntry = z.strictObject({
	recordId: Slug,
	version: z.number().int().min(1),
	blobHash: ObjectHash,
	facetHash: Sha256,
});
export type ReceiptEntry = z.infer<typeof ReceiptEntry>;

/** Where a receipt lives in git: `refs/notes/delta` annotating a commit on the work item's fork. */
export const NOTES_REF = "refs/notes/delta";
export const NoteRef = z.string().regex(/^refs\/notes\/delta:[0-9a-f]{7,64}$/, "expected refs/notes/delta:<commitSha>");
export type NoteRef = z.infer<typeof NoteRef>;

export function formatNoteRef(commitSha: string): NoteRef {
	return `${NOTES_REF}:${CommitSha.parse(commitSha)}`;
}

/**
 * Proof of what was delivered to a work item, and at which hashes. It proves delivery, not
 * understanding. `noteRef` says where the receipt was written as a git note; it is a pointer
 * and is not part of the serialized note body (see `serializeReceiptNote`).
 */
export const ContextReceipt = z.strictObject({
	baselineCommit: CommitSha,
	contextPacketHash: Sha256,
	accepted: z.array(ReceiptEntry),
	proposedVisible: z.array(ContextSnapshotEntry),
	noteRef: NoteRef.optional(),
});
export type ContextReceipt = z.infer<typeof ContextReceipt>;
