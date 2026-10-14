import {
	toRecordSnapshot,
	snapshotHashOf,
	type Actor,
	type Claim,
	type DeltaEvent,
	type FacetValue,
	type ReasonCode,
	type RecordSnapshot,
	type ResolutionBinding,
	type WorkItemState,
} from "contracts";
import { buildReceipt, currentSnapshot, diffFacets, evaluateGate } from "delta-core";
import { DEMO_IDENTITY } from "@/config";
import { CLAIMS_CHECK_NAME } from "@/lib/evidence";
import type { CommandResult, ContextChangeInput, FileChange, GateResult, PromoteInput, ResolveInput } from "@/client/types";
import type { MockCell, MockScenario } from "./cell";
import { changesFor } from "./changes";

/** Reasons that mean the engine refused a human command rather than applied it. */
const REFUSALS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
	"STALE_BINDING",
	"FORBIDDEN_ACTOR",
	"ALREADY_RESOLVED",
	"UNKNOWN_WORK_ITEM",
	"ALREADY_PROMOTED",
	"REVALIDATION_LIMIT",
	"REVALIDATION_IN_PROGRESS",
	"IDEMPOTENCY_CONFLICT",
	"DUPLICATE_EVENT",
]);

const PLACEHOLDER_TS = "2026-10-13T15:00:00Z";

/**
 * What the replayed agents "run on", shown on the cards. The agents in a replay are scripted, so most
 * say "stub agent"; notifications WI-2 is the one the live run used the project's cheap model for.
 */
const STUB_MODEL = "stub agent";
const REPLAY_MODELS: Record<string, Record<string, string>> = {
	notifications: { "WI-2": "openai/gpt-6-luna" },
};

function modelOf(scenario: string, workItemId: string): string {
	return REPLAY_MODELS[scenario]?.[workItemId] ?? STUB_MODEL;
}

export type SessionOptions = {
	/** Pause a moment between an approved promotion and the merge, so "re-checking at current heads" is visible. */
	promoteDelayMs: number;
};

/**
 * High-level operations over a `MockCell`: what the Worker, the agents and the human would do.
 * Beats and UI commands both go through here, so scripted and hand-driven runs behave the same.
 */
export class MockSession {
	readonly cell: MockCell;
	readonly scenario: MockScenario;
	readonly options: SessionOptions;
	#counter = 0;
	/** Work items whose revalidation was started but whose agent re-run has not landed yet. */
	readonly pendingReruns = new Set<string>();

	constructor(cell: MockCell, options: SessionOptions) {
		this.cell = cell;
		this.scenario = cell.scenario;
		this.options = options;
	}

	/** The acting human. The id is the scenario's decision authority; the label is the demo identity. */
	get human(): Actor {
		const authority = Object.values(this.scenario.policy.authority)[0] ?? "decision-owner";
		return { kind: "human", id: authority, displayName: DEMO_IDENTITY.label };
	}

	#key(prefix: string): string {
		this.#counter += 1;
		return `${prefix}-${this.#counter}`;
	}

	// ---------- the world: baseline ----------

	async seedBaseline(): Promise<void> {
		const { seed, repo } = this.scenario;
		const event: DeltaEvent = {
			type: "BaselinePushed",
			ts: PLACEHOLDER_TS,
			repo,
			commitSha: seed.baselineCommit,
			snapshotHash: seed.snapshotHash,
			records: seed.records,
			invalid: [],
		};
		await this.cell.send(event);
	}

	/** Send a pre-built fixture event (the scripted typo, the v2 push, a fork push). */
	async fixture(name: string): Promise<void> {
		const event = this.scenario.events[name];
		if (!event) throw new Error(`mock: no fixture event "${name}" in ${this.scenario.name}`);
		// The fixtures record the scenario's contract-check results with no kind. In the replay Convergence ran them, as the Worker does.
		if (event.type === "EvidenceRecorded" && !event.evidence.kind) {
			await this.cell.send({ ...event, evidence: { ...event.evidence, kind: "delta-run-check" } });
			return;
		}
		await this.cell.send(event);
	}

	// ---------- the world: agents ----------

	/** Register work items with receipts at the current accepted versions, and start their agents. */
	async startAgents(keys: string[]): Promise<void> {
		for (const key of keys) {
			const item = this.scenario.workItems[key];
			const dependencies = this.scenario.dependencies[key] ?? [];
			if (!item) continue;
			const state = await this.cell.state();
			if (state.workItems[item.id]) continue;
			const receipt = await buildReceipt(state, {
				baselineCommit: state.baselineCommit,
				recordIds: dependencies.map((dep) => dep.recordId),
				noteCommit: state.baselineCommit,
			});
			await this.cell.send({ type: "WorkItemRegistered", ts: PLACEHOLDER_TS, item, receipt, dependencies });
		}
		for (const key of keys) {
			const item = this.scenario.workItems[key];
			if (item) await this.cell.send({ type: "AgentRunStarted", ts: PLACEHOLDER_TS, workItemId: item.id, runId: `run-${item.id.toLowerCase()}`, model: modelOf(this.scenario.name, item.id) });
		}
	}

	async finishRun(workItemId: string, runId = `run-${workItemId.toLowerCase()}`, outcome: "success" | "failure" | "cancelled" = "success"): Promise<void> {
		await this.cell.send({ type: "AgentRunFinished", ts: PLACEHOLDER_TS, workItemId, runId, outcome });
	}

	// ---------- a human changes a decision ----------

	async proposeChange(input: ContextChangeInput): Promise<CommandResult> {
		const state = await this.cell.state();
		if (input.expectedBaselineCommit && input.expectedBaselineCommit !== state.baselineCommit) {
			return { ok: false, code: "BASELINE_MOVED", message: `the baseline is at ${state.baselineCommit}, not ${input.expectedBaselineCommit}` };
		}
		const prev = currentSnapshot(state, input.recordId);
		if (!prev) return { ok: false, code: "UNKNOWN_RECORD", message: `${input.recordId} has no accepted version yet.` };
		const changes = diffFacets(prev, { facets: input.facets });
		const version = changes.length > 0 ? prev.version + 1 : prev.version;

		const text = renderRecord({
			id: prev.recordId,
			version,
			authority: prev.authority,
			actor: this.human.id,
			acceptedAt: this.cell.clock.next(2),
			supersedes: version > prev.version ? `${prev.recordId}@${prev.version}` : null,
			validation: prev.validation,
			facets: input.facets,
			not: changes.filter((c) => c.from !== undefined).map((c) => [c.key, c.from as FacetValue] as const),
			prose: input.prose,
		});
		const parsed = await toRecordSnapshot(text);
		if (!parsed.ok) return { ok: false, code: "MALFORMED_RECORD", message: parsed.error };
		if (parsed.snapshot.blobHash === prev.blobHash) return { ok: false, code: "NO_CONTEXT_CHANGE", message: "Nothing changed." };
		this.cell.texts.set(parsed.snapshot.blobHash, text);

		const heads: RecordSnapshot[] = [];
		for (const id of Object.keys(state.records)) {
			const head = id === prev.recordId ? parsed.snapshot : currentSnapshot(state, id);
			if (head) heads.push(head);
		}
		const event: DeltaEvent = {
			type: "BaselinePushed",
			ts: PLACEHOLDER_TS,
			repo: this.scenario.repo,
			commitSha: this.cell.nextSha("b"),
			snapshotHash: await snapshotHashOf(heads),
			records: [parsed.snapshot],
			invalid: [],
		};
		await this.cell.send(event);
		return { ok: true, message: changes.length > 0 ? `${prev.recordId} v${version} is now the decision.` : `Saved a wording change to ${prev.recordId} v${version}.` };
	}

	// ---------- a human resolves ----------

	async resolve(input: ResolveInput, key: string): Promise<CommandResult> {
		const ts = PLACEHOLDER_TS;
		const result = await this.cell.send({
			type: "ResolutionRecorded",
			ts,
			requestId: key,
			resolution: {
				kind: input.kind,
				workItemId: input.workItemId,
				actor: this.human,
				rationale: input.rationale,
				...(input.scope ? { scope: input.scope } : {}),
				binding: input.binding,
				requestId: key,
				ts,
			},
		});
		const refusal = refusalOf(result.effects);
		if (result.outcome !== "applied" || refusal) {
			return { ok: false, code: refusal?.[0] ?? "REFUSED", message: refusalMessage(refusal?.[0]), reasonCodes: refusal };
		}
		if (input.kind === "revalidate") {
			await this.startRerun(input.workItemId);
			return { ok: true, message: "Revalidation started: the agent is re-running on the current decisions." };
		}
		return { ok: true, message: input.kind === "reject" ? "Rejected." : "Exception recorded." };
	}

	// ---------- revalidation: the agent comes back ----------

	/** Convergence issues a fresh receipt and re-dispatches the agent. The re-run lands later (`completeRerun`). */
	async startRerun(workItemId: string): Promise<void> {
		const state = await this.cell.state();
		const wi = state.workItems[workItemId];
		if (!wi) return;
		const receipt = await buildReceipt(state, {
			baselineCommit: state.baselineCommit,
			recordIds: wi.receipt.accepted.map((entry) => entry.recordId),
			noteCommit: wi.headSha ?? state.baselineCommit,
		});
		await this.cell.send({ type: "ReceiptIssued", ts: PLACEHOLDER_TS, workItemId, receipt });
		await this.cell.send({ type: "AgentRunStarted", ts: PLACEHOLDER_TS, workItemId, runId: this.#rerunId(workItemId), model: modelOf(this.scenario.name, workItemId) });
		this.pendingReruns.add(workItemId);
	}

	#rerunId(workItemId: string): string {
		return `run-${workItemId.toLowerCase()}-rv`;
	}

	/** The re-run pushes claims restated from the accepted facets, and Convergence's checks pass at the new head. */
	async completeRerun(workItemId: string): Promise<void> {
		if (!this.pendingReruns.has(workItemId)) return;
		this.pendingReruns.delete(workItemId);
		const state = await this.cell.state();
		const wi = state.workItems[workItemId];
		if (!wi) return;
		const head = this.cell.nextSha("f");
		const claims: Claim[] = [];
		// Each check asserts the facets this work item relied on for the records that name it (as the Worker's checks do).
		const checks = new Map<string, Set<string>>();
		for (const dep of state.dependencies) {
			if (dep.workItemId !== workItemId || dep.status !== "accepted") continue;
			const record = currentSnapshot(state, dep.recordId);
			if (!record) continue;
			const keys = dep.facetKeys.length > 0 ? dep.facetKeys : Object.keys(record.facets);
			for (const subject of keys) {
				const value = record.facets[subject];
				if (value !== undefined) claims.push({ subject, value, basedOn: `${record.recordId}@${record.version}` });
			}
			if (record.validation) {
				const asserted = checks.get(record.validation) ?? new Set<string>();
				for (const subject of keys) asserted.add(subject);
				checks.set(record.validation, asserted);
			}
		}
		const repo = wi.item.forkRepo;
		await this.cell.send({ type: "ForkPushed", ts: PLACEHOLDER_TS, repo, commitSha: head, workItemId, claims, contextPaths: [] });
		const runId = this.#rerunId(workItemId);
		// What the Worker records for a verified push: its own contract check per `validation:` path (this is what
		// satisfies contract-test), then the informational claims check under its own name.
		for (const [check, asserted] of [...checks].sort(([x], [y]) => x.localeCompare(y))) {
			await this.cell.send({
				type: "EvidenceRecorded",
				ts: PLACEHOLDER_TS,
				repo,
				commitSha: head,
				runId,
				evidence: { workItemId, headSha: head, check, pass: true, output: `Convergence contract check ${check} at ${head.slice(0, 7)} passed, asserting ${[...asserted].sort().join(", ")}.`, kind: "delta-run-check" },
			});
		}
		await this.cell.send({
			type: "EvidenceRecorded",
			ts: PLACEHOLDER_TS,
			repo,
			commitSha: head,
			runId,
			evidence: { workItemId, headSha: head, check: CLAIMS_CHECK_NAME, pass: true, output: "claims cite the current decision versions", kind: "delta-claims-check" },
		});
		await this.finishRun(workItemId, this.#rerunId(workItemId));
	}

	// ---------- promotion ----------

	async promote(input: PromoteInput, key: string): Promise<CommandResult> {
		const ts = PLACEHOLDER_TS;
		const result = await this.cell.send({
			type: "PromotionRequested",
			ts,
			requestId: key,
			workItemId: input.workItemId,
			actor: this.human,
			expectedBaselineCommit: input.expectedBaselineCommit,
			forkHeadSha: input.forkHeadSha,
		});
		const allowed = result.effects.find((effect) => effect.type === "ALLOW_PROMOTION");
		if (result.outcome !== "applied" || !allowed) {
			const reasons = [...new Set(result.effects.flatMap((effect) => effect.reasonCodes))];
			return { ok: false, code: reasons[0] ?? "BLOCKED", message: "Merge blocked at the current heads.", reasonCodes: reasons };
		}
		if (this.options.promoteDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.promoteDelayMs));
		await this.cell.send({ type: "PromotionMerged", ts, workItemId: input.workItemId, repo: this.scenario.repo, mergeCommitSha: this.cell.nextSha("b") });
		return { ok: true, message: `${input.workItemId} merged into the baseline.` };
	}

	/** Promote a work item by looking at the current state, as a presenter driving the demo would. */
	async promoteNow(workItemId: string): Promise<CommandResult> {
		const state = await this.cell.state();
		const wi = state.workItems[workItemId];
		if (!wi || wi.item.status === "promoted") return { ok: true, message: "Already merged." };
		return this.promote({ workItemId, expectedBaselineCommit: state.baselineCommit, forkHeadSha: wi.headSha ?? "0000000" }, this.#key(`promote-${workItemId}`));
	}

	/** Resolve a work item against the current state, as a presenter driving the demo would. */
	async resolveNow(kind: ResolveInput["kind"], workItemId: string, recordId: string, rationale: string, scope?: string): Promise<CommandResult> {
		const state = await this.cell.state();
		const wi = state.workItems[workItemId];
		const record = currentSnapshot(state, recordId);
		if (!wi?.headSha || !record) return { ok: false, code: "UNBOUND", message: "Nothing to attach the sign-off to yet." };
		const binding: ResolutionBinding = {
			recordId,
			version: record.version,
			blobHash: record.blobHash,
			baseSha: state.baselineCommit,
			forkHeadSha: wi.headSha,
			contextSnapshotHash: state.snapshotHash,
		};
		return this.resolve({ kind, workItemId, rationale, scope, binding }, this.#key(`${kind}-${workItemId}`));
	}

	// ---------- reads ----------

	async gate(workItemId: string): Promise<GateResult> {
		const state = await this.cell.state();
		const verdict = evaluateGate(state, workItemId, this.scenario.policy);
		return {
			pass: verdict.promotable,
			reasonCodes: verdict.reasonCodes,
			blockers: verdict.blockers,
			waivedBy: verdict.waivedBy.map((r) => ({ kind: r.kind, scope: r.scope, rationale: r.rationale, actor: r.actor.displayName })),
		};
	}

	async changes(workItemId: string): Promise<FileChange[]> {
		const state = await this.cell.state();
		const wi: WorkItemState | undefined = state.workItems[workItemId];
		if (!wi) return [];
		return changesFor(this.scenario.name, wi);
	}

	/** Drop-in for the empty state's one-click seed. */
	async seedIfEmpty(): Promise<void> {
		const state = await this.cell.state();
		if (Object.keys(state.records).length === 0) await this.seedBaseline();
	}
}

function refusalOf(effects: { reasonCodes: ReasonCode[] }[]): ReasonCode[] | undefined {
	const codes = [...new Set(effects.flatMap((effect) => effect.reasonCodes))].filter((code) => REFUSALS.has(code));
	return codes.length > 0 ? codes : undefined;
}

function refusalMessage(code: ReasonCode | undefined): string {
	switch (code) {
		case "STALE_BINDING":
			return "The decisions or the agent's copy moved since you opened this. Reload and decide again.";
		case "FORBIDDEN_ACTOR":
			return "Only the person who signs off on that decision can do that.";
		case "ALREADY_RESOLVED":
			return "An exception on that decision would lift nothing: the work isn't behind on it and no claim conflicts with it.";
		case "REVALIDATION_LIMIT":
			return "Revalidated too many times. A person needs to look at why this keeps failing.";
		case "REVALIDATION_IN_PROGRESS":
			return "A revalidation is already under way. Wait for the agent's push before revalidating again.";
		default:
			return "The engine refused that request.";
	}
}

// ---------- record files ----------

type RenderInput = {
	id: string;
	version: number;
	authority: string;
	actor: string;
	acceptedAt: string;
	supersedes: string | null;
	validation: string | null;
	facets: Record<string, FacetValue>;
	not: ReadonlyArray<readonly [string, FacetValue]>;
	prose: string;
};

/** Compose a `context/*.md` file. Values are written as JSON, which is valid YAML flow syntax. */
export function renderRecord(input: RenderInput): string {
	const lines = [
		"---",
		`id: ${input.id}`,
		`version: ${input.version}`,
		"status: accepted",
		`authority: ${input.authority}`,
		`proposed_by: ${input.actor}`,
		`accepted_by: ${input.actor}`,
		`accepted_at: ${input.acceptedAt}`,
	];
	if (input.supersedes) lines.push(`supersedes: ${input.supersedes}`);
	if (input.validation) lines.push(`validation: ${input.validation}`);
	lines.push("facets:");
	for (const [key, value] of Object.entries(input.facets)) lines.push(`  ${key}: ${JSON.stringify(value)}`);
	if (input.not.length > 0) {
		lines.push("not:");
		for (const [key, value] of input.not) lines.push(`  ${key}: ${JSON.stringify(value)}`);
	}
	lines.push("---", input.prose.trim(), "");
	return lines.join("\n");
}
