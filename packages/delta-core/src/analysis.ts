import { canonicalJson, compareStrings, parseRecordRef, type Claim, type CellState, type Evidence, type FacetScalar, type ReasonCode, type RecordSnapshot, type WorkItemState } from "contracts";
import { acceptedDependenciesOf, currentSnapshot, dependenciesOf, isPromoted, isRejected, snapshotAt, workItemIds } from "./cell-state";
import { diffFacets, facetValuesEqual } from "./facets";
import type { Policy } from "contracts";

export type StaleFinding = {
	recordId: string;
	fromVersion: number;
	toVersion: number;
	facetKeys: string[];
	reasonCodes: ReasonCode[];
};

/**
 * A claim equals a value a decision declared in its `not` list for that facet. Informational: it rides on a
 * conflict that was already there and never changes whether the work is blocked. Present only on an exact match
 * with a DECLARED value; nothing is inferred.
 */
export type RejectedAlternative = {
	/** The governing record whose `not` list holds the value. */
	recordId: string;
	/** Its accepted version (the one that declared the rejection, not necessarily the one the claim cites). */
	version: number;
	/** The facet (equal to the claim's subject). */
	facet: string;
	/** The rejected value, as declared. */
	value: FacetScalar;
	/** The record's `why`, when it has one. */
	why?: string;
};

export type ConflictFinding = {
	recordId: string;
	subject: string;
	basedOn: string;
	reasonCodes: ReasonCode[];
	message: string;
	/** Set together with the `REJECTED_ALTERNATIVE` reason code. */
	rejected?: RejectedAlternative;
};

export type UncertainFinding = {
	reasonCodes: ReasonCode[];
	recordId: string | null;
	subjects: string[];
	message: string;
};

/** A claim that cites a record the work item was never given (rule R4). */
export type OutsideReceipt = { recordId: string; subjects: string[] };

/** Everything the rules say about one work item right now, derived from facts alone. */
export type Analysis = {
	stale: StaleFinding[];
	conflicts: ConflictFinding[];
	uncertain: UncertainFinding[];
	outsideReceipt: OutsideReceipt[];
	headEvidence: Evidence[];
	/** The part of `headEvidence` that counts as a test result: everything except the Worker's claims check (see `countsAsTest`). */
	testEvidence: Evidence[];
	requiredChecks: string[];
	failedChecks: string[];
	testsPassed: boolean;
};

/**
 * R1: compare each accepted dependency's facets against the version in the receipt. Only facets
 * the item depends on count; an empty `facetKeys` means the whole record. In `record` mode any
 * new version or blob counts instead.
 */
export function findStale(state: CellState, wi: WorkItemState, policy: Policy): StaleFinding[] {
	const findings: StaleFinding[] = [];
	for (const dep of acceptedDependenciesOf(state, wi.item.id)) {
		const current = currentSnapshot(state, dep.recordId);
		if (!current) continue; // nothing accepted to be stale against
		const entry = wi.receipt.accepted.find((e) => e.recordId === dep.recordId);
		if (!entry) {
			findings.push({ recordId: dep.recordId, fromVersion: 0, toVersion: current.version, facetKeys: [...dep.facetKeys].sort(), reasonCodes: ["STALE_RECEIPT"] });
			continue;
		}
		if (entry.version > current.version) {
			findings.push({ recordId: dep.recordId, fromVersion: entry.version, toVersion: current.version, facetKeys: [], reasonCodes: ["STALE_RECEIPT", "UNKNOWN_CONTEXT_VERSION"] });
			continue;
		}
		if (policy.staleness === "record") {
			if (entry.version !== current.version || entry.blobHash !== current.blobHash) {
				findings.push({ recordId: dep.recordId, fromVersion: entry.version, toVersion: current.version, facetKeys: [], reasonCodes: ["STALE_RECEIPT"] });
			}
			continue;
		}
		if (entry.version === current.version) continue; // same version: at most a prose edit
		const held = snapshotAt(state, dep.recordId, entry.version);
		if (!held) {
			findings.push({ recordId: dep.recordId, fromVersion: entry.version, toVersion: current.version, facetKeys: [], reasonCodes: ["STALE_RECEIPT", "UNKNOWN_CONTEXT_VERSION"] });
			continue;
		}
		const changed = diffFacets(held, current).map((change) => change.key);
		const relevant = dep.facetKeys.length === 0 ? changed : changed.filter((key) => dep.facetKeys.includes(key));
		if (relevant.length > 0) {
			findings.push({ recordId: dep.recordId, fromVersion: entry.version, toVersion: current.version, facetKeys: relevant, reasonCodes: ["STALE_RECEIPT", "FACET_CHANGED"] });
		}
	}
	return findings.sort((a, b) => compareStrings(a.recordId, b.recordId));
}

function validClaims(wi: WorkItemState): Claim[] | null {
	const cs = wi.claims;
	if (wi.headSha === null || !cs || cs.headSha !== wi.headSha || cs.status !== "ok") return null;
	return cs.claims;
}

/**
 * A claim value that is exactly one of the record's declared `not` values for the subject. Scalars only: a list-valued
 * claim is never matched, because `not` lists hold separate rejected values and "contains" would be a guess.
 */
function rejectedAlternative(record: RecordSnapshot, subject: string, value: Claim["value"]): RejectedAlternative | undefined {
	if (Array.isArray(value)) return undefined;
	const declared = record.not[subject];
	if (!declared?.some((rejected) => facetValuesEqual(rejected, value))) return undefined;
	return { recordId: record.recordId, version: record.version, facet: subject, value, ...(record.why ? { why: record.why } : {}) };
}

/** The sentence a conflict message gains when the claimed value was declared rejected. */
function rejectedSentence(rejected: RejectedAlternative): string {
	return ` ${rejected.recordId}@${rejected.version} rejected ${canonicalJson(rejected.value)} for ${rejected.facet}${rejected.why ? `: ${rejected.why}` : "."}`;
}

/** R3 and R4: compare claims to the current accepted facets; fail closed on missing or malformed ones. */
function findClaimIssues(state: CellState, wi: WorkItemState): Pick<Analysis, "conflicts" | "uncertain" | "outsideReceipt"> {
	const conflicts: ConflictFinding[] = [];
	const uncertain: UncertainFinding[] = [];
	const outside = new Map<string, Set<string>>();
	if (wi.headSha === null) return { conflicts, uncertain, outsideReceipt: [] };

	const cs = wi.claims;
	if (!cs || cs.headSha !== wi.headSha || cs.status === "missing") {
		uncertain.push({ reasonCodes: ["NO_CLAIMS"], recordId: null, subjects: [], message: "No claims were pushed for the current head, so nothing can be compared." });
		return { conflicts, uncertain, outsideReceipt: [] };
	}
	if (cs.status === "malformed") {
		uncertain.push({ reasonCodes: ["MALFORMED_CLAIMS"], recordId: null, subjects: [], message: `Claims could not be read: ${cs.error ?? "malformed"}.` });
		return { conflicts, uncertain, outsideReceipt: [] };
	}

	const inReceipt = new Set(wi.receipt.accepted.map((e) => e.recordId));
	const deps = dependenciesOf(state, wi.item.id);
	for (const claim of cs.claims) {
		const ref = parseRecordRef(claim.basedOn);
		if (!ref) {
			uncertain.push({ reasonCodes: ["MALFORMED_CLAIMS"], recordId: null, subjects: [claim.subject], message: `Claim basedOn "${claim.basedOn}" is not recordId@version.` });
			continue;
		}
		const dep = deps.find((d) => d.recordId === ref.recordId);
		if (!inReceipt.has(ref.recordId)) {
			if (dep?.status === "rejected") continue; // a human said this reliance doesn't count
			if (!dep || dep.status === "proposed") {
				const subjects = outside.get(ref.recordId) ?? new Set<string>();
				subjects.add(claim.subject);
				outside.set(ref.recordId, subjects);
				continue;
			}
		}
		const current = currentSnapshot(state, ref.recordId);
		const basis = snapshotAt(state, ref.recordId, ref.version);
		if (!current || !basis) {
			uncertain.push({ reasonCodes: ["UNKNOWN_CONTEXT_VERSION"], recordId: ref.recordId, subjects: [claim.subject], message: `Claim cites ${claim.basedOn}, which is not a version Convergence has seen.` });
			continue;
		}
		const nowValue = current.facets[claim.subject];
		const basisValue = basis.facets[claim.subject];
		if (nowValue === undefined && basisValue === undefined) {
			// The cited record does not carry this subject. If another accepted record governs it, the claim cites the wrong record:
			// a conflict when the value differs from the governing facet, Uncertain when it merely agrees. Never a pass.
			const governors = governorsOf(state, claim.subject);
			let flagged = false;
			for (const governor of governors) {
				const governing = governor.facets[claim.subject];
				if (governing !== undefined && !facetValuesEqual(claim.value, governing)) {
					flagged = true;
					const rejected = rejectedAlternative(governor, claim.subject, claim.value);
					conflicts.push({
						recordId: governor.recordId,
						subject: claim.subject,
						basedOn: claim.basedOn,
						reasonCodes: rejected ? ["CLAIM_CONFLICT", "WRONG_RECORD", "REJECTED_ALTERNATIVE"] : ["CLAIM_CONFLICT", "WRONG_RECORD"],
						message: `Claims ${claim.subject} = ${canonicalJson(claim.value)} citing ${claim.basedOn}, but ${governor.recordId}@${governor.version} governs it and says ${canonicalJson(governing)}.${rejected ? rejectedSentence(rejected) : ""}`,
						...(rejected ? { rejected } : {}),
					});
				}
			}
			if (!flagged && governors.length > 0) {
				uncertain.push({
					reasonCodes: ["WRONG_RECORD"],
					recordId: ref.recordId,
					subjects: [claim.subject],
					message: `Claim on ${claim.subject} cites ${claim.basedOn}, but ${governors.map((g) => g.recordId).join(", ")} governs it.`,
				});
			}
			continue; // ungoverned everywhere: nothing to contradict
		}
		const superseded = ref.version !== current.version;
		if (nowValue !== undefined && !facetValuesEqual(claim.value, nowValue)) {
			const rejected = rejectedAlternative(current, claim.subject, claim.value);
			const reasonCodes: ReasonCode[] = superseded ? ["CLAIM_CONFLICT", "SUPERSEDED_BASIS"] : ["CLAIM_CONFLICT"];
			if (rejected) reasonCodes.push("REJECTED_ALTERNATIVE");
			conflicts.push({
				recordId: ref.recordId,
				subject: claim.subject,
				basedOn: claim.basedOn,
				reasonCodes,
				message: `Claims ${claim.subject} = ${canonicalJson(claim.value)}; accepted ${ref.recordId}@${current.version} says ${canonicalJson(nowValue)}.${rejected ? rejectedSentence(rejected) : ""}`,
				...(rejected ? { rejected } : {}),
			});
		} else if (superseded && !facetValuesEqual(basisValue, nowValue)) {
			conflicts.push({
				recordId: ref.recordId,
				subject: claim.subject,
				basedOn: claim.basedOn,
				reasonCodes: ["CLAIM_CONFLICT", "SUPERSEDED_BASIS"],
				message: `Built on ${claim.basedOn}; ${claim.subject} has changed since (now ${ref.recordId}@${current.version}).`,
			});
		}
	}

	for (const [recordId, subjects] of [...outside.entries()].sort(([a], [b]) => compareStrings(a, b))) {
		uncertain.push({
			reasonCodes: ["UNDECLARED_DEP"],
			recordId,
			subjects: [...subjects].sort(),
			message: `Claims rely on ${recordId}, which was not in the receipt and has no accepted dependency. A human must accept or reject it.`,
		});
	}
	return {
		conflicts: conflicts.sort((a, b) => compareStrings(a.subject, b.subject)),
		uncertain,
		outsideReceipt: [...outside.entries()].map(([recordId, subjects]) => ({ recordId, subjects: [...subjects].sort() })).sort((a, b) => compareStrings(a.recordId, b.recordId)),
	};
}

/** Accepted records whose current facets include `subject`: the ones that actually govern it. */
function governorsOf(state: CellState, subject: string): RecordSnapshot[] {
	const out: RecordSnapshot[] = [];
	for (const recordId of Object.keys(state.records).sort(compareStrings)) {
		const snapshot = currentSnapshot(state, recordId);
		if (snapshot && snapshot.facets[subject] !== undefined) out.push(snapshot);
	}
	return out;
}

function isGoverned(state: CellState, subject: string): boolean {
	return governorsOf(state, subject).length > 0;
}

/**
 * R3b: another live work item claims a different value for a subject this item also claims.
 * Only for subjects no accepted record governs (the "phone number" case): when a facet governs
 * the subject, R3 already arbitrates against the accepted value, so two items disagreeing about
 * it is a symptom, not a second finding.
 */
function findCrossClaimConflicts(state: CellState, wi: WorkItemState): UncertainFinding[] {
	const mine = validClaims(wi);
	if (!mine || mine.length === 0 || isRejected(wi)) return [];
	const findings: UncertainFinding[] = [];
	for (const otherId of workItemIds(state)) {
		if (otherId === wi.item.id) continue;
		const other = state.workItems[otherId];
		if (!other || isPromoted(other) || isRejected(other)) continue; // dead work does not contradict anyone
		const theirs = validClaims(other);
		if (!theirs) continue;
		const subjects = new Set<string>();
		for (const a of mine) {
			for (const b of theirs) {
				if (a.subject === b.subject && !facetValuesEqual(a.value, b.value) && !isGoverned(state, a.subject)) subjects.add(a.subject);
			}
		}
		if (subjects.size > 0) {
			findings.push({
				reasonCodes: ["CROSS_CLAIM_CONFLICT"],
				recordId: null,
				subjects: [...subjects].sort(),
				message: `${otherId} claims a different value for ${[...subjects].sort().join(", ")}.`,
			});
		}
	}
	return findings;
}

/**
 * Does this Evidence count as a test result for its check? Everything does except `delta-claims-check`, the
 * Worker's comparison of agent-written claims with the receipt. That is derived from the agent's own word, so
 * it must never satisfy, fail or overwrite a validation check (rule R8: Delta-run, not agent-run).
 *
 * This is an exclusion list on purpose: evidence with no `kind` is the fixtures' hand-recorded results (including
 * sales-ops), and an allowlist would orphan all of them. Only the Worker's internal observation hook writes
 * evidence, never an HTTP caller, and the one kind it writes for a test result is `delta-run-check`.
 */
export function countsAsTest(evidence: Evidence): boolean {
	return evidence.kind !== "delta-claims-check";
}

/** The latest Evidence per check at the item's current head. Evidence for any other head does not count (R8). */
export function evidenceAtHead(wi: WorkItemState): Evidence[] {
	if (wi.headSha === null) return [];
	const latest = new Map<string, Evidence>();
	for (const evidence of wi.evidence) if (evidence.headSha === wi.headSha) latest.set(countsAsTest(evidence) ? evidence.check : `\u0000claims\u0000${evidence.check}`, evidence);
	return [...latest.values()].sort((a, b) => compareStrings(a.check, b.check) || compareStrings(a.kind ?? "", b.kind ?? ""));
}

/** Checks the item's accepted dependencies require: the `validation` of each record it relies on. */
export function requiredChecksFor(state: CellState, wi: WorkItemState): string[] {
	const checks = new Set<string>();
	for (const dep of acceptedDependenciesOf(state, wi.item.id)) {
		const validation = currentSnapshot(state, dep.recordId)?.validation;
		if (validation) checks.add(validation);
	}
	return [...checks].sort();
}

export function analyze(state: CellState, workItemId: string, policy: Policy): Analysis {
	const wi = state.workItems[workItemId];
	if (!wi) throw new Error(`analyze: unknown work item ${workItemId}`);
	const claimIssues = findClaimIssues(state, wi);
	const headEvidence = evidenceAtHead(wi);
	const requiredChecks = requiredChecksFor(state, wi);
	const testEvidence = headEvidence.filter(countsAsTest);
	const failedChecks = testEvidence.filter((e) => !e.pass).map((e) => e.check);
	const testsPassed =
		testEvidence.length > 0 && failedChecks.length === 0 && requiredChecks.every((check) => testEvidence.some((e) => e.check === check && e.pass));
	return {
		stale: findStale(state, wi, policy),
		conflicts: claimIssues.conflicts,
		uncertain: [...claimIssues.uncertain, ...findCrossClaimConflicts(state, wi)],
		outsideReceipt: claimIssues.outsideReceipt,
		headEvidence,
		testEvidence,
		requiredChecks,
		failedChecks,
		testsPassed,
	};
}
