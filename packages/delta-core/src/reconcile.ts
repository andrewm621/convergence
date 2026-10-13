import {
	ClaimsFile,
	canonicalJson,
	compareStrings,
	dedupeKey,
	isCommand,
	type CellState,
	type DeltaEvent,
	type Dependency,
	type Effect,
	type Policy,
	type RecordDiff,
	type RecordSnapshot,
	type WorkItemState,
} from "contracts";
import { analyze, findStale } from "./analysis";
import { acceptedDependenciesOf, currentSnapshot, isPromoted, snapshotAt, workItemIds } from "./cell-state";
import { refreshWorkItem } from "./conditions";
import { effectsForChanges, noAction } from "./effects";
import { diffFacets } from "./facets";
import { authorityFor } from "./gate";

export type ReconcileResult = { state: CellState; effects: Effect[] };

export type EventClass = "new" | "duplicate" | "idempotency-conflict";

/** R9: has this event (or its Idempotency-Key) been seen before, and was it the same request? */
export function classifyEvent(state: CellState, event: DeltaEvent): EventClass {
	const key = dedupeKey(event);
	const seen = state.processed[key];
	if (seen === undefined) return "new";
	if (isCommand(event) && seen !== canonicalJson(event)) return "idempotency-conflict";
	return "duplicate";
}

/**
 * The reconciler. Pure: the same state, event and policy always give the same result. It reads
 * no clock, no randomness and no network; time and ids arrive on the event. It never mutates
 * its inputs. Models propose, rules and humans decide: nothing here calls a model.
 */
export function reconcile(state: CellState, event: DeltaEvent, policy: Policy): ReconcileResult {
	const verdict = classifyEvent(state, event);
	if (verdict === "duplicate") return { state, effects: [noAction(["DUPLICATE_EVENT"], { message: `Already processed ${dedupeKey(event)}.` })] };
	if (verdict === "idempotency-conflict") {
		return { state, effects: [noAction(["IDEMPOTENCY_CONFLICT"], { message: `Idempotency-Key reused with a different request: ${dedupeKey(event)}.` })] };
	}

	const draft = structuredClone(state);
	const effects = apply(draft, event, policy);
	draft.processed[dedupeKey(event)] = isCommand(event) ? canonicalJson(event) : "";
	return { state: draft, effects: effects.length > 0 ? effects : [noAction(["OBSERVATION_ONLY"])] };
}

function apply(draft: CellState, event: DeltaEvent, policy: Policy): Effect[] {
	switch (event.type) {
		case "WorkItemRegistered":
			return onWorkItemRegistered(draft, event, policy);
		case "BaselinePushed":
			return onBaselinePushed(draft, event, policy);
		case "ForkPushed":
			return onForkPushed(draft, event, policy);
		case "EvidenceRecorded":
			return onEvidenceRecorded(draft, event, policy);
		case "DependencyDecided":
			return onDependencyDecided(draft, event, policy);
		case "ReceiptIssued":
			return onReceiptIssued(draft, event, policy);
		case "ResolutionRecorded":
			return onResolutionRecorded(draft, event, policy);
		case "PromotionRequested":
			return onPromotionRequested(draft, event, policy);
		case "PromotionMerged":
			return onPromotionMerged(draft, event, policy);
		case "AgentRunStarted":
		case "AgentRunFinished":
			return [noAction(["OBSERVATION_ONLY"], { workItemId: event.workItemId })];
	}
}

type Of<T extends DeltaEvent["type"]> = Extract<DeltaEvent, { type: T }>;

// ---------- registration ----------

function onWorkItemRegistered(draft: CellState, event: Of<"WorkItemRegistered">, policy: Policy): Effect[] {
	const id = event.item.id;
	if (draft.workItems[id]) return [noAction(["DUPLICATE_EVENT"], { workItemId: id })];
	draft.workItems[id] = {
		item: { ...event.item, status: "running" },
		receipt: event.receipt,
		headSha: null,
		claims: null,
		evidence: [],
		conditions: [],
		revalidations: 0,
		revalidating: false,
		resolutions: [],
		promotionApproval: null,
		contextPaths: [],
	};
	draft.dependencies = [...draft.dependencies.filter((d) => d.workItemId !== id), ...event.dependencies.filter((d) => d.workItemId === id)];
	return effectsForChanges(refreshWorkItem(draft, id, policy, event.ts).changed);
}

// ---------- R1 / R2: baseline pushes ----------

function onBaselinePushed(draft: CellState, event: Of<"BaselinePushed">, policy: Policy): Effect[] {
	draft.baselineCommit = event.commitSha;
	draft.snapshotHash = event.snapshotHash;
	const effects: Effect[] = event.invalid.map((bad) => noAction(["RECORD_NOT_ACCEPTED"], { message: `${bad.path}: ${bad.error}` }));
	if (event.records.length === 0 && event.invalid.length === 0) return [noAction(["NO_CONTEXT_CHANGE"])];
	for (const snapshot of [...event.records].sort((a, b) => compareStrings(a.recordId, b.recordId))) {
		effects.push(...onContextRecord(draft, snapshot, event.ts, policy));
	}
	return effects;
}

function onContextRecord(draft: CellState, snap: RecordSnapshot, ts: string, policy: Policy): Effect[] {
	const recordId = snap.recordId;
	const history = (draft.records[recordId] ??= { current: null, versions: {}, proposed: null });

	if (snap.status !== "accepted") {
		if (snap.status === "proposed" && snap.version > (history.current ?? 0)) history.proposed = snap;
		return [noAction(["RECORD_NOT_ACCEPTED"], { recordId, message: `${recordId}@${snap.version} is ${snap.status}; it does not govern anything.` })];
	}
	// A context file only becomes an accepted version if its acceptor is the record's authority. The file's own
	// `authority` field is not evidence of authority: it is trusted for a record's first version only. After that,
	// authority is the policy's, else whatever the previous accepted version said (so only the sitting authority can hand it over).
	const prev = currentSnapshot(draft, recordId);
	const authority = policy.authority[recordId] ?? prev?.authority ?? snap.authority;
	if (snap.acceptedBy !== authority) {
		if (snap.version > (history.current ?? 0)) history.proposed = snap;
		return [noAction(["FORBIDDEN_ACTOR", "RECORD_NOT_ACCEPTED"], { recordId, message: `${recordId}@${snap.version} was accepted by ${snap.acceptedBy ?? "nobody"}, not by its authority ${authority}.` })];
	}

	if (prev) {
		if (snap.version < prev.version) return [noAction(["VERSION_NOT_NEWER"], { recordId, message: `${recordId}@${snap.version} is older than accepted v${prev.version}.` })];
		if (snap.version === prev.version) {
			if (snap.blobHash === prev.blobHash) return [noAction(["NO_CONTEXT_CHANGE"], { recordId })];
			if (diffFacets(prev, snap).length > 0) {
				return [noAction(["IMMUTABLE_VERSION"], { recordId, message: `${recordId}@${snap.version} is accepted; changing its facets requires a new version.` })];
			}
		}
	}

	const proseOnly = prev !== null && diffFacets(prev, snap).length === 0 && policy.staleness === "facet";
	history.versions[String(snap.version)] = snap;
	history.current = snap.version;
	if (history.proposed && history.proposed.version <= snap.version) history.proposed = null;

	const effects: Effect[] = [];
	if (proseOnly) effects.push(noAction(["PROSE_ONLY"], { recordId, message: `${recordId}@${snap.version}: only prose changed; no governed facet did.` }));

	for (const id of workItemIds(draft)) {
		const wi = draft.workItems[id] as WorkItemState;
		if (isPromoted(wi)) continue;
		const dependsOn = acceptedDependenciesOf(draft, id).some((dep) => dep.recordId === recordId);
		const hasException = wi.resolutions.some((r) => r.kind === "accept-exception" && r.binding.recordId === recordId);
		const wasStale = wi.conditions.some((c) => c.type === "Stale" && c.recordRefs.some((ref) => ref.startsWith(`${recordId}@`)));
		const nowStale = dependsOn && findStale(draft, wi, policy).some((f) => f.recordId === recordId);
		// Work that holds a live approval, or whose claims cite this record, can change verdict without depending on a changed facet.
		const involved = wi.promotionApproval !== null || (wi.claims?.status === "ok" && wi.claims.claims.some((c) => c.basedOn.startsWith(`${recordId}@`)));

		// A prose-only edit leaves already-stale work as it was; only a lapsing exception needs a second look.
		if ((!proseOnly && (nowStale || wasStale || involved)) || hasException) {
			const refresh = refreshWorkItem(draft, id, policy, ts);
			const changes = effectsForChanges(refresh.changed);
			if (changes.length > 0) effects.push(...changes);
			else if (!proseOnly) effects.push(noAction(["NO_DEPENDENCY_ON_CHANGED_FACETS"], { workItemId: id, recordId, message: `${id} depends on this record, but nothing it relies on changed; left alone.` }));
		} else if (!proseOnly) {
			const reason = dependsOn ? "depends on this record, but none of the facets it relies on changed" : "does not depend on this record";
			effects.push(noAction(["NO_DEPENDENCY_ON_CHANGED_FACETS"], { workItemId: id, recordId, message: `${id} ${reason}; left alone.` }));
		}
	}
	return effects;
}

// ---------- R3 / R3b / R4: fork pushes ----------

function validSubjects(wi: WorkItemState): Set<string> {
	const cs = wi.claims;
	return new Set(cs && cs.status === "ok" ? cs.claims.map((c) => c.subject) : []);
}

function onForkPushed(draft: CellState, event: Of<"ForkPushed">, policy: Policy): Effect[] {
	const id = event.workItemId;
	const wi = draft.workItems[id];
	if (!wi || event.repo !== wi.item.forkRepo) {
		return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id, message: `Push from ${event.repo} does not belong to a registered work item.` })];
	}
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];

	const touched = validSubjects(wi);
	wi.headSha = event.commitSha;
	wi.revalidating = false;
	wi.promotionApproval = null;
	wi.contextPaths = [...event.contextPaths].sort(compareStrings);

	const effects: Effect[] = [];
	if (event.contextPaths.length > 0) {
		effects.push(noAction(["FORK_CONTEXT_IGNORED"], { workItemId: id, message: `A fork cannot change accepted context (${event.contextPaths.join(", ")}); only the baseline can. This fork is blocked from promotion.` }));
	}

	const parsed = event.claims === null ? null : ClaimsFile.safeParse(event.claims);
	if (parsed === null || (parsed.success && parsed.data.length === 0)) {
		wi.claims = { headSha: event.commitSha, status: "missing", claims: [], error: null };
	} else if (!parsed.success) {
		const issue = parsed.error.issues[0];
		wi.claims = { headSha: event.commitSha, status: "malformed", claims: [], error: `${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
	} else {
		wi.claims = { headSha: event.commitSha, status: "ok", claims: parsed.data, error: null };
		// R4: a claim citing a record outside the receipt proposes an inferred dependency; it never binds.
		const inReceipt = new Set(wi.receipt.accepted.map((e) => e.recordId));
		const cited = new Map<string, Set<string>>();
		for (const claim of parsed.data) {
			const recordId = claim.basedOn.slice(0, claim.basedOn.lastIndexOf("@"));
			if (inReceipt.has(recordId)) continue;
			const subjects = cited.get(recordId) ?? new Set<string>();
			subjects.add(claim.subject);
			cited.set(recordId, subjects);
		}
		for (const [recordId, subjects] of [...cited.entries()].sort(([a], [b]) => compareStrings(a, b))) {
			const evidenceRef = `${event.repo}@${event.commitSha}:.delta/claims.json`;
			const existing = draft.dependencies.find((d) => d.workItemId === id && d.recordId === recordId);
			if (!existing) {
				const dep: Dependency = { workItemId: id, recordId, facetKeys: [...subjects].sort(), basis: "inferred", status: "proposed", evidenceRefs: [evidenceRef] };
				draft.dependencies.push(dep);
			} else if (existing.status === "proposed") {
				existing.facetKeys = [...new Set([...existing.facetKeys, ...subjects])].sort();
				if (!existing.evidenceRefs.includes(evidenceRef)) existing.evidenceRefs.push(evidenceRef);
			}
		}
	}

	effects.push(...effectsForChanges(refreshWorkItem(draft, id, policy, event.ts).changed));

	// R3b: other live items that share a claimed subject may now disagree with (or stop disagreeing with) this one.
	effects.push(...refreshCounterparts(draft, id, new Set([...touched, ...validSubjects(wi)]), policy, event.ts));
	return effects;
}

/** Refresh every other live item that claims one of `subjects`, because its cross-claim verdict may have changed. */
function refreshCounterparts(draft: CellState, id: string, subjects: Set<string>, policy: Policy, ts: string): Effect[] {
	const effects: Effect[] = [];
	for (const otherId of workItemIds(draft)) {
		const other = draft.workItems[otherId] as WorkItemState;
		if (otherId === id || isPromoted(other)) continue;
		if (![...validSubjects(other)].some((subject) => subjects.has(subject))) continue;
		effects.push(...effectsForChanges(refreshWorkItem(draft, otherId, policy, ts).changed));
	}
	return effects;
}

// ---------- R8: evidence ----------

function onEvidenceRecorded(draft: CellState, event: Of<"EvidenceRecorded">, policy: Policy): Effect[] {
	const { evidence } = event;
	const id = evidence.workItemId;
	const wi = draft.workItems[id];
	if (!wi || event.repo !== wi.item.forkRepo || event.commitSha !== evidence.headSha) {
		return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id, message: "Evidence does not match a registered work item and head." })];
	}
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];
	wi.evidence = [...wi.evidence.filter((e) => !(e.check === evidence.check && e.headSha === evidence.headSha)), evidence];
	if (evidence.headSha !== wi.headSha) {
		return [noAction(["STALE_EVIDENCE"], { workItemId: id, message: `${evidence.check} ran at ${evidence.headSha}, but the current head is ${wi.headSha ?? "unset"}; it does not count.` })];
	}
	return effectsForChanges(refreshWorkItem(draft, id, policy, event.ts).changed);
}

// ---------- R4: dependency decisions ----------

function onDependencyDecided(draft: CellState, event: Of<"DependencyDecided">, policy: Policy): Effect[] {
	const id = event.workItemId;
	if (event.actor.kind !== "human") {
		return [noAction(["FORBIDDEN_ACTOR"], { workItemId: id, message: "Only a human can accept or reject a dependency." })];
	}
	const wi = draft.workItems[id];
	if (!wi) return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id })];
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];
	const dep = draft.dependencies.find((d) => d.workItemId === id && d.recordId === event.recordId);
	if (!dep || dep.status !== "proposed") {
		return [noAction(["ALREADY_RESOLVED"], { workItemId: id, recordId: event.recordId, message: "No proposed dependency to decide." })];
	}
	dep.status = event.decision;
	const effects: Effect[] = [noAction(["DEPENDENCY_DECIDED"], { workItemId: id, recordId: event.recordId, message: `${event.actor.id} ${event.decision} the dependency on ${event.recordId}.` })];
	effects.push(...effectsForChanges(refreshWorkItem(draft, id, policy, event.ts).changed));
	return effects;
}

// ---------- R6: receipts after revalidation ----------

function onReceiptIssued(draft: CellState, event: Of<"ReceiptIssued">, policy: Policy): Effect[] {
	const id = event.workItemId;
	const wi = draft.workItems[id];
	if (!wi) return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id })];
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];
	// A receipt is only taken while a human-requested revalidation is under way; nothing else may swap an item's receipt.
	if (!wi.revalidating) return [noAction(["REVALIDATION_NOT_REQUESTED"], { workItemId: id, message: "No revalidation is under way for this work item; a new receipt is not taken." })];

	const entries = event.receipt.accepted;
	const matchesCurrent = entries.every((entry) => {
		const current = currentSnapshot(draft, entry.recordId);
		return current !== null && current.version === entry.version && current.blobHash === entry.blobHash && current.facetHash === entry.facetHash;
	});
	const covers = acceptedDependenciesOf(draft, id).every((dep) => entries.some((entry) => entry.recordId === dep.recordId) || currentSnapshot(draft, dep.recordId) === null);
	if (!matchesCurrent || !covers) {
		return [noAction(["RECEIPT_MISMATCH"], { workItemId: id, message: "The receipt is not at the current accepted versions of every record this work depends on." })];
	}
	wi.receipt = event.receipt;
	return effectsForChanges(refreshWorkItem(draft, id, policy, event.ts).changed);
}

// ---------- R5 / R6 / R7: human resolutions ----------

function diffsFor(draft: CellState, wi: WorkItemState, staleRecordIds: string[]): RecordDiff[] {
	const diffs: RecordDiff[] = [];
	const ids = staleRecordIds.length > 0 ? staleRecordIds : wi.receipt.accepted.map((e) => e.recordId);
	for (const recordId of [...new Set(ids)].sort()) {
		const current = currentSnapshot(draft, recordId);
		const entry = wi.receipt.accepted.find((e) => e.recordId === recordId);
		if (!current || (entry && entry.version === current.version)) continue;
		const held = entry ? snapshotAt(draft, recordId, entry.version) : null;
		diffs.push({ recordId, fromVersion: entry?.version ?? 0, toVersion: current.version, changes: diffFacets(held, current) });
	}
	return diffs;
}

function onResolutionRecorded(draft: CellState, event: Of<"ResolutionRecorded">, policy: Policy): Effect[] {
	const { resolution } = event;
	const id = resolution.workItemId;
	const { binding } = resolution;

	if (resolution.actor.kind !== "human") {
		return [noAction(["FORBIDDEN_ACTOR"], { workItemId: id, message: `${resolution.actor.kind} ${resolution.actor.id} cannot resolve; only a human can.` })];
	}
	const wi = draft.workItems[id];
	if (!wi) return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id })];
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];

	// R7: the resolution must be bound to exactly what the human was looking at.
	const record = currentSnapshot(draft, binding.recordId);
	const bound =
		binding.baseSha === draft.baselineCommit &&
		binding.contextSnapshotHash === draft.snapshotHash &&
		wi.headSha !== null &&
		binding.forkHeadSha === wi.headSha &&
		record !== null &&
		binding.version === record.version &&
		binding.blobHash === record.blobHash;
	if (!bound) {
		return [noAction(["STALE_BINDING"], { workItemId: id, recordId: binding.recordId, message: "The context or the fork moved since this resolution was prepared; reload and decide again." })];
	}

	if (resolution.kind === "accept-exception") {
		if (authorityFor(draft, policy, binding.recordId) !== resolution.actor.id) {
			return [noAction(["FORBIDDEN_ACTOR"], { workItemId: id, recordId: binding.recordId, message: `Only the authority for ${binding.recordId} can accept an exception.` })];
		}
		const before = analyze(draft, id, policy);
		const covered = before.stale.some((f) => f.recordId === binding.recordId) || before.conflicts.some((f) => f.recordId === binding.recordId);
		if (!covered) return [noAction(["ALREADY_RESOLVED"], { workItemId: id, recordId: binding.recordId, message: "Nothing stale or conflicting on this record to except." })];
		wi.resolutions.push(resolution);
		const refresh = refreshWorkItem(draft, id, policy, event.ts);
		return [noAction(["EXCEPTION_APPLIED"], { workItemId: id, recordId: binding.recordId, message: `Scoped exception: ${resolution.scope ?? ""}` }), ...effectsForChanges(refresh.changed)];
	}

	if (resolution.kind === "reject") {
		wi.resolutions.push(resolution);
		wi.promotionApproval = null;
		const refresh = refreshWorkItem(draft, id, policy, event.ts);
		// Rejected work no longer counts in cross-claim comparisons (R3b), so its counterparts are re-evaluated.
		return [
			{ type: "BLOCK_PROMOTION", workItemId: id, reasonCodes: ["RESOLUTION_REJECTED"] },
			...effectsForChanges(refresh.changed),
			...refreshCounterparts(draft, id, validSubjects(wi), policy, event.ts),
		];
	}

	// revalidate (R6): only for work that is stale or conflicting, with a loop guard
	const analysis = analyze(draft, id, policy);
	if (analysis.stale.length === 0 && analysis.conflicts.length === 0) {
		return [noAction(["NOTHING_TO_REVALIDATE"], { workItemId: id, message: "Nothing stale or conflicting; there is nothing to revalidate." })];
	}
	if (wi.revalidations >= policy.maxRevalidations) {
		return [
			{ type: "REQUEST_REVIEW", workItemId: id, message: `Revalidated ${wi.revalidations} times already; a person needs to look at why this keeps failing.`, reasonCodes: ["REVALIDATION_LIMIT"] },
			{ type: "BLOCK_PROMOTION", workItemId: id, reasonCodes: ["REVALIDATION_LIMIT"] },
		];
	}
	const diff = diffsFor(draft, wi, analysis.stale.map((f) => f.recordId));
	wi.resolutions.push(resolution);
	wi.revalidations += 1;
	wi.revalidating = true;
	wi.promotionApproval = null;
	const refresh = refreshWorkItem(draft, id, policy, event.ts);
	return [
		...effectsForChanges(refresh.changed),
		...refreshCounterparts(draft, id, validSubjects(wi), policy, event.ts),
		{ type: "REQUEST_REVALIDATION", workItemId: id, diff, reasonCodes: ["REVALIDATION_STARTED"] },
		{ type: "DISPATCH_WORK", workItemId: id, mode: "revalidate", diff, reasonCodes: ["REVALIDATION_STARTED"] },
	];
}

// ---------- R7: promotion ----------

function onPromotionRequested(draft: CellState, event: Of<"PromotionRequested">, policy: Policy): Effect[] {
	const id = event.workItemId;
	const refuse = (reasonCodes: Effect["reasonCodes"], message: string): Effect[] => [
		{ type: "BLOCK_PROMOTION", workItemId: id, reasonCodes },
		noAction(reasonCodes, { workItemId: id, message }),
	];
	if (event.actor.kind !== "human") return refuse(["FORBIDDEN_ACTOR"], "Only a human can promote.");
	const wi = draft.workItems[id];
	if (!wi) return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id })];
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];
	// Compare-and-swap: a context push or another promotion that landed first wins; this request is stale.
	if (event.expectedBaselineCommit !== draft.baselineCommit) return refuse(["BASELINE_MOVED"], `The baseline is at ${draft.baselineCommit}, not ${event.expectedBaselineCommit}.`);
	if (wi.headSha === null || event.forkHeadSha !== wi.headSha) return refuse(["HEAD_MOVED"], `The fork head is ${wi.headSha ?? "unset"}, not ${event.forkHeadSha}.`);

	// Re-check R1, R3 and R8 at the current heads, not at whatever the console last showed.
	const refresh = refreshWorkItem(draft, id, policy, event.ts);
	const changes = effectsForChanges(refresh.changed);
	if (!refresh.gate.promotable) {
		return [...changes, { type: "BLOCK_PROMOTION", workItemId: id, reasonCodes: refresh.gate.reasonCodes }];
	}
	wi.promotionApproval = { forkHeadSha: wi.headSha, baselineCommit: draft.baselineCommit, requestId: event.requestId };
	return [...changes, { type: "ALLOW_PROMOTION", workItemId: id, forkHeadSha: wi.headSha, baselineCommit: draft.baselineCommit, reasonCodes: refresh.gate.waivedBy.length > 0 ? ["EXCEPTION_APPLIED"] : [] }];
}

function onPromotionMerged(draft: CellState, event: Of<"PromotionMerged">, policy: Policy): Effect[] {
	const id = event.workItemId;
	const wi = draft.workItems[id];
	if (!wi) return [noAction(["UNKNOWN_WORK_ITEM"], { workItemId: id })];
	if (isPromoted(wi)) return [noAction(["ALREADY_PROMOTED"], { workItemId: id })];
	if (!wi.promotionApproval || wi.promotionApproval.forkHeadSha !== wi.headSha) {
		return [noAction(["PROMOTION_NOT_APPROVED"], { workItemId: id, message: "No live promotion approval for this head; the merge is not recorded as a promotion." })];
	}
	// R7 at merge time too: re-run the gate at the current state. If anything moved since approval, the merge is not a promotion.
	const refresh = refreshWorkItem(draft, id, policy, event.ts);
	if (!refresh.gate.promotable) {
		wi.promotionApproval = null;
		return [
			...effectsForChanges(refresh.changed),
			{ type: "BLOCK_PROMOTION", workItemId: id, reasonCodes: refresh.gate.reasonCodes },
			noAction(["PROMOTION_NOT_APPROVED", ...refresh.gate.reasonCodes], { workItemId: id, message: "The gate no longer passes at the current state; the merge is not recorded as a promotion." }),
		];
	}
	wi.promotionApproval = null;
	wi.item.status = "promoted";
	draft.baselineCommit = event.mergeCommitSha;
	return effectsForChanges(refreshWorkItem(draft, id, policy, event.ts).changed);
}
