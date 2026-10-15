import type { Effect, ReconciliationEvent, WorkItemState } from "contracts";
import { describeCheck, checkDisplayName } from "@/lib/evidence";
import { plural, shortHash } from "@/lib/format";
import { primaryReason, reasonLabel } from "@/lib/reasons";

/**
 * The Process view's data: what each agent did, lane by lane, read straight off the ledger. A pure function of the
 * ledger lines and the work items, so the replay, the live console and a read-only view all draw the same picture.
 * The x axis is ledger order, not the clock: only a line that puts a mark on some lane (or moves a decision) takes a column.
 */

export type MarkKind = "run" | "rerun" | "push" | "conflict" | "stale" | "unaffected" | "check" | "resolution" | "dependency" | "merge" | "refused" | "failed";

/** What a mark means, for colour: danger (blocked), success (merged), info (a person decided), muted (left alone), neutral (work happening). */
export type MarkTone = "neutral" | "danger" | "success" | "info" | "muted";

/** The ledger line a mark comes from, for its tooltip. */
export type MarkLine = { type: ReconciliationEvent["type"]; seq: number; hash: string; ts: string };

export type ProcessMark = {
	id: string;
	seq: number;
	/** Index into `ProcessModel.columns`. */
	column: number;
	kind: MarkKind;
	tone: MarkTone;
	label: string;
	/** Muted lines under the label: a model, a short sha, a count. */
	detail: string[];
	/** Raw reason codes, for the tooltip. */
	reasonCodes: string[];
	line: MarkLine;
};

/** A stretch of a lane: the agent running, or the work held (stale, in conflict, failing) until a person acted or it merged. */
export type LaneSpan = { kind: "running" | "blocked"; from: number; to: number };

export type ProcessLane = {
	workItemId: string;
	title: string;
	/** The agent's display name. */
	agent: string;
	marks: ProcessMark[];
	spans: LaneSpan[];
};

export type ProcessColumn = { seq: number; ts: string; /** Time since the first line in view ("+0:12"), or null when the clock is unreadable. */ relative: string | null };

/** A decision version accepted: a vertical line across every lane. */
export type DecisionChange = { seq: number; column: number; recordId: string; from: number; to: number; label: string };

export type ProcessModel = {
	lanes: ProcessLane[];
	columns: ProcessColumn[];
	decisions: DecisionChange[];
	/** Nothing to draw yet. */
	empty: boolean;
};

type RawMark = Omit<ProcessMark, "column" | "id">;
type RawSpan = { kind: LaneSpan["kind"]; from: number; to: number | null };
type LaneDraft = { workItemId: string; title: string; agent: string; marks: RawMark[]; spans: RawSpan[]; started: number; blockedFrom: number | null };

const REFUSAL_CODES = new Set<string>(["FORBIDDEN_ACTOR", "UNKNOWN_WORK_ITEM", "ALREADY_PROMOTED", "STALE_BINDING", "ALREADY_RESOLVED", "REVALIDATION_IN_PROGRESS", "NOTHING_TO_REVALIDATE", "REVALIDATION_LIMIT"]);
const RECORD_REFUSAL_CODES = new Set<string>(["FORBIDDEN_ACTOR", "IMMUTABLE_VERSION", "VERSION_NOT_NEWER", "RECORD_NOT_ACCEPTED"]);
const SIGN_OFF_LABEL: Record<string, string> = { revalidate: "revalidate", "accept-exception": "exception", reject: "reject" };

export function processLanes(input: { ledger: readonly ReconciliationEvent[]; workItems: Record<string, WorkItemState> }): ProcessModel {
	const { ledger, workItems } = input;
	const lanes = new Map<string, LaneDraft>();
	const decisions: Array<Omit<DecisionChange, "column">> = [];
	const lastVersion = new Map<string, number>();

	function lane(id: string, fallbackTitle?: string, fallbackAgent?: string): LaneDraft {
		let draft = lanes.get(id);
		if (!draft) {
			const item = workItems[id]?.item;
			draft = { workItemId: id, title: item?.title ?? fallbackTitle ?? id, agent: item?.actor.displayName ?? fallbackAgent ?? "", marks: [], spans: [], started: 0, blockedFrom: null };
			lanes.set(id, draft);
		}
		return draft;
	}

	function add(draft: LaneDraft, entry: ReconciliationEvent, mark: Omit<RawMark, "seq" | "line" | "reasonCodes"> & { reasonCodes?: string[] }) {
		draft.marks.push({ ...mark, reasonCodes: mark.reasonCodes ?? [], seq: entry.seq, line: { type: entry.type, seq: entry.seq, hash: entry.hash, ts: entry.ts } });
	}

	function block(draft: LaneDraft, seq: number) {
		if (draft.blockedFrom === null) draft.blockedFrom = seq;
	}

	function release(draft: LaneDraft, seq: number) {
		if (draft.blockedFrom === null) return;
		draft.spans.push({ kind: "blocked", from: draft.blockedFrom, to: seq });
		draft.blockedFrom = null;
	}

	for (const entry of ledger) {
		const event = entry.payload.event;
		const effects = entry.payload.effects;
		switch (event.type) {
			case "WorkItemRegistered":
				lane(event.item.id, event.item.title, event.item.actor.displayName);
				break;
			case "AgentRunStarted": {
				const draft = lane(event.workItemId);
				const again = draft.started > 0;
				draft.started += 1;
				draft.spans.push({ kind: "running", from: entry.seq, to: null });
				add(draft, entry, { kind: again ? "rerun" : "run", tone: "neutral", label: again ? "re-run" : "run started", detail: event.model ? [event.model] : [] });
				break;
			}
			case "AgentRunFinished": {
				const draft = lane(event.workItemId);
				const open = [...draft.spans].reverse().find((span) => span.kind === "running" && span.to === null);
				if (open) open.to = entry.seq;
				if (event.runId.startsWith("dispatch-failed:")) {
					add(draft, entry, { kind: "failed", tone: "danger", label: "re-run not started", detail: ["dispatch failed"] });
				} else if (event.outcome !== "success") {
					add(draft, entry, { kind: "failed", tone: "danger", label: `run ${event.outcome === "failure" ? "failed" : "cancelled"}`, detail: [] });
				}
				break;
			}
			case "ForkPushed": {
				const draft = lane(event.workItemId);
				const claims = Array.isArray(event.claims) ? event.claims.length : null;
				const conflict = effects.find((e) => e.type === "RECORD_CONDITION" && e.workItemId === event.workItemId && e.condition.type === "ClaimConflict");
				const sha = shortHash(event.commitSha);
				const claimText = claims === null ? "no claims" : plural(claims, "claim");
				if (conflict && conflict.type === "RECORD_CONDITION") {
					block(draft, entry.seq);
					add(draft, entry, { kind: "conflict", tone: "danger", label: "claims conflict", detail: [`push ${sha}`, claimText], reasonCodes: conflict.condition.reasonCodes });
				} else {
					add(draft, entry, { kind: "push", tone: "neutral", label: `push ${sha}`, detail: [claimText] });
				}
				break;
			}
			case "EvidenceRecorded": {
				const { evidence } = event;
				// Only a failing check is worth a mark; Convergence's own claims check is informational and never a test.
				if (evidence.pass || describeCheck(evidence)?.kind === "delta-claims-check") break;
				const draft = lane(evidence.workItemId);
				block(draft, entry.seq);
				add(draft, entry, { kind: "check", tone: "danger", label: "check failed", detail: [checkDisplayName(evidence.check)], reasonCodes: codesOf(effects, evidence.workItemId) });
				break;
			}
			case "DependencyDecided": {
				const draft = lane(event.workItemId);
				add(draft, entry, { kind: "dependency", tone: "info", label: `dependency ${event.decision}`, detail: [event.recordId, event.actor.displayName] });
				break;
			}
			case "ResolutionRecorded": {
				const { resolution } = event;
				const draft = lane(resolution.workItemId);
				const codes = codesOf(effects, resolution.workItemId);
				const applied =
					resolution.kind === "revalidate" ? effects.some((e) => e.type === "REQUEST_REVALIDATION") : resolution.kind === "accept-exception" ? codes.includes("EXCEPTION_APPLIED") : effects.some((e) => e.type === "BLOCK_PROMOTION" && e.reasonCodes.includes("RESOLUTION_REJECTED"));
				if (!applied) {
					const why = primaryReason(codes.filter((c) => REFUSAL_CODES.has(c)));
					add(draft, entry, { kind: "refused", tone: "danger", label: "sign-off refused", detail: [SIGN_OFF_LABEL[resolution.kind] ?? resolution.kind, ...(why ? [reasonLabel(why)] : [])], reasonCodes: codes });
					break;
				}
				// A person acting ends the hold, except a rejection, which leaves the work held for good.
				if (resolution.kind !== "reject") release(draft, entry.seq);
				add(draft, entry, { kind: "resolution", tone: "info", label: SIGN_OFF_LABEL[resolution.kind] ?? resolution.kind, detail: [resolution.actor.displayName], reasonCodes: codes });
				break;
			}
			case "PromotionRequested": {
				// A request that went through is told by the merge that follows; only a refused one gets a mark of its own.
				if (effects.some((e) => e.type === "ALLOW_PROMOTION")) break;
				const draft = lane(event.workItemId);
				const codes = codesOf(effects, event.workItemId);
				const why = primaryReason(codes);
				add(draft, entry, { kind: "refused", tone: "danger", label: "merge refused", detail: why ? [reasonLabel(why)] : [], reasonCodes: codes });
				break;
			}
			case "PromotionMerged": {
				const draft = lane(event.workItemId);
				release(draft, entry.seq);
				add(draft, entry, { kind: "merge", tone: "success", label: "merged", detail: [shortHash(event.mergeCommitSha)] });
				break;
			}
			case "BaselinePushed": {
				for (const record of event.records) {
					const prior = lastVersion.get(record.recordId);
					const refused = effects.some((e) => e.type === "NO_ACTION" && e.recordId === record.recordId && e.reasonCodes.some((c) => RECORD_REFUSAL_CODES.has(c)));
					if (record.status !== "accepted" || refused) continue;
					lastVersion.set(record.recordId, Math.max(prior ?? 0, record.version));
					// A re-push of the same bytes, or a version bump that moved no governed setting, changed no decision: no line.
					const unchanged = effects.some((e) => e.type === "NO_ACTION" && e.recordId === record.recordId && (e.reasonCodes.includes("PROSE_ONLY") || e.reasonCodes.includes("NO_CONTEXT_CHANGE")));
					if (unchanged) continue;
					const from = prior ?? record.version - 1;
					if (record.version > from && from >= 1) decisions.push({ seq: entry.seq, recordId: record.recordId, from, to: record.version, label: `${record.recordId} v${from} → v${record.version}` });
				}
				if (event.records.length === 0) break;
				const touched = new Set<string>();
				for (const e of effects) if ("workItemId" in e && e.workItemId !== undefined) touched.add(e.workItemId);
				for (const id of touched) {
					const mine = effects.filter((e) => "workItemId" in e && e.workItemId === id);
					const stale = mine.find((e) => e.type === "RECORD_CONDITION" && e.condition.type === "Stale");
					const draft = lane(id);
					if (stale) {
						const codes = [...new Set(mine.flatMap((e) => (e.type === "RECORD_CONDITION" && (e.condition.type === "Stale" || e.condition.type === "Blocked") ? e.condition.reasonCodes : [])))];
						const why = (["EXCEPTION_LAPSED", "FACET_CHANGED"] as const).find((c) => codes.includes(c)) ?? primaryReason(codes);
						block(draft, entry.seq);
						add(draft, entry, { kind: "stale", tone: "danger", label: "went stale", detail: why ? [reasonLabel(why)] : [], reasonCodes: codes });
					} else if (mine.some((e) => e.type === "NO_ACTION" && e.reasonCodes.includes("NO_DEPENDENCY_ON_CHANGED_FACETS"))) {
						add(draft, entry, { kind: "unaffected", tone: "muted", label: "not affected", detail: [], reasonCodes: ["NO_DEPENDENCY_ON_CHANGED_FACETS"] });
					}
				}
				break;
			}
			default:
				break;
		}
	}

	// Work the ledger tail no longer shows still gets its lane.
	for (const id of Object.keys(workItems).sort(byId)) lane(id);

	const seqs = new Set<number>(decisions.map((d) => d.seq));
	for (const draft of lanes.values()) for (const mark of draft.marks) seqs.add(mark.seq);
	const order = [...seqs].sort((a, b) => a - b);
	const columnOf = new Map(order.map((seq, index) => [seq, index]));
	const byLineSeq = new Map(ledger.map((entry) => [entry.seq, entry]));
	const first = ledger[0] ? Date.parse(ledger[0].ts) : Number.NaN;
	const columns: ProcessColumn[] = order.map((seq) => {
		const ts = byLineSeq.get(seq)?.ts ?? "";
		return { seq, ts, relative: relativeTime(Date.parse(ts) - first) };
	});
	const lastColumn = Math.max(order.length - 1, 0);
	const col = (seq: number) => columnOf.get(seq) ?? lastColumn;

	const out: ProcessLane[] = [...lanes.values()].map((draft) => {
		const spans: LaneSpan[] = draft.spans.map((span) => ({ kind: span.kind, from: col(span.from), to: span.to === null ? lastColumn : col(span.to) }));
		if (draft.blockedFrom !== null) spans.push({ kind: "blocked", from: col(draft.blockedFrom), to: lastColumn });
		return {
			workItemId: draft.workItemId,
			title: draft.title,
			agent: draft.agent,
			marks: draft.marks.map((mark) => ({ ...mark, column: col(mark.seq), id: `${draft.workItemId}:${mark.seq}:${mark.kind}` })),
			spans,
		};
	});

	return {
		lanes: out,
		columns,
		decisions: decisions.map((d) => ({ ...d, column: col(d.seq) })),
		empty: out.length === 0 || out.every((l) => l.marks.length === 0),
	};
}

function codesOf(effects: readonly Effect[], workItemId: string): string[] {
	return [...new Set(effects.filter((e) => "workItemId" in e && e.workItemId === workItemId).flatMap((e) => e.reasonCodes))].filter((c) => c !== "OBSERVATION_ONLY");
}

function byId(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

/** "+0:12", "+4:05", "+1:02:03". Null when either clock reading is not a time. */
export function relativeTime(ms: number): string | null {
	if (!Number.isFinite(ms) || ms < 0) return null;
	const total = Math.round(ms / 1000);
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const two = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `+${h}:${two(m)}:${two(s)}` : `+${m}:${two(s)}`;
}
