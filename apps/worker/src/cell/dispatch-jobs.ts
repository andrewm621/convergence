import { z } from "zod";
import {
	CommitSha,
	ContextReceipt,
	NOTES_REF,
	RecordDiff,
	formatNoteRef,
	parseRecordRef,
	serializeReceiptNote,
	sha256Hex,
	toRecordSnapshot,
	type CellState,
	type DeltaEventInput,
	type Effect,
	type Policy,
} from "contracts";
import { acceptedDependenciesOf, analyze, buildReceipt, currentSnapshot, type ProcessResult } from "delta-core";
import { redactText } from "../artifacts/tokens";
import { Revalidate, withTimeout } from "../agents/protocol";
import { runtimeIdCollision, runtimeIdFor } from "../agents/work-item-ids";
import { AgentRuntimeError, type AgentRunView, type AgentRuntimePort } from "./agent-port";
import type { CellMeta, DispatchJobRow } from "./meta";
import { WORKER_COMMITTER } from "./observe";
import type { ArtifactsPort } from "./ports";

// Revalidate re-dispatch (M4). When a human's `revalidate` Resolution is accepted the reconciler emits
// DISPATCH_WORK. That effect is only a request; this file is the Worker side that answers it, so
// delta-core stays pure. One job per accepted resolution, persisted in the cell's own SQLite and advanced
// a step at a time by the cell's alarm, so a restart loses nothing and no request waits for an agent:
//
//   queued    -> prepared   read the NEW accepted records from the baseline, build the receipt from them
//   prepared  -> receipted  write the receipt as a git note on the fork (best effort), record ReceiptIssued
//   receipted -> running    dispatch the agent runtime with that exact context, record AgentRunStarted
//   running   -> done       run finished: record AgentRunFinished; if its push is verified and the cell has
//                           seen it, record the Worker's own check as EvidenceRecorded
//
// Who decides what: the receipt is built by the Worker from the baseline's accepted records, and the actor
// of every event written here is the Worker; the agent never issues a receipt or records evidence. Whatever
// the container says is not used: the run's outcome comes from the runtime's record (built from the fork's
// real history), the pushed commit is re-read from the repo, and the claims check runs on the claims the
// poller read from that commit. Whether the revalidated work is fresh and promotable is still the gate's
// call (R1, R3, R7, R8); nothing here promotes anything.

const WORKER_IDENTITY = { name: WORKER_COMMITTER, email: "delta@example.invalid" };
const NOTE_TIMEOUT_MS = 25_000;
const DISPATCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_MISSES = 5;
const MAX_BACKOFF_MS = 30_000;

/** Evidence names a check after the record's `validation:` path, which is what the gate requires. */
const FALLBACK_CHECK = "delta:claims-vs-receipt";

const Prepared = z.object({
	/** The agent runtime's id for the work item (lowercase), see agents/work-item-ids.ts. */
	runtimeId: z.string(),
	prompt: z.string(),
	revalidate: Revalidate,
	receipt: ContextReceipt,
	/** The fork head the run starts from; the receipt note annotates it. */
	baseHead: CommitSha,
	noteError: z.string().optional(),
});
type Prepared = z.infer<typeof Prepared>;

/** What the cell offers the dispatcher. Every state change goes through `submit`, which is serialized with the poller. */
export interface DispatchHost {
	readonly port: ArtifactsPort;
	readonly runtime: AgentRuntimePort;
	readonly meta: CellMeta;
	scenario(): string;
	baselineRepo(): string;
	policy(): Policy;
	now(): string;
	loadState(): Promise<CellState>;
	submit(event: DeltaEventInput): Promise<ProcessResult>;
	/** Read a repo's new commits into the cell now (the poller's work, on demand). */
	catchUp(repo: string): Promise<void>;
	activity(workItemId: string, kind: string, text: string): Promise<void>;
	logError(what: string, error: unknown): void;
}

/** A failure retrying cannot fix: the job is marked failed and the work item stays blocked. */
class Permanent extends Error {}

const iso = (ts: string): string => new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
const short = (sha: string): string => sha.slice(0, 7);

/** The file name a record is delivered under in `.delta/context/`: the baseline file's name when it is a plain `<slug>.md`, else `<recordId>.md`. */
export function contextFileName(recordId: string, path: string | null): string {
	const base = path?.split("/").pop() ?? "";
	return /^[a-z0-9][a-z0-9_-]*\.md$/.test(base) ? base : `${recordId}.md`;
}

/** The key the runtime dedupes this dispatch on: stable for one resolution, distinct across scenarios and resolutions. */
export async function dispatchKey(scenario: string, requestId: string): Promise<string> {
	return `redispatch-${(await sha256Hex(`${scenario}|${requestId}`)).slice(0, 32)}`;
}

export type ClaimsCheck = { pass: boolean; problems: string[] };

/**
 * The Worker's own check on a revalidated push. It is NOT an executed test. It says: the claims the
 * poller read from the verified head cite the versions the receipt delivered, cite every record that
 * changed, and the reconciler's own comparison (R1 and R3) finds nothing stale, conflicting or unreadable.
 * Deterministic, from the cell's state alone.
 */
export function claimsCheck(input: { state: CellState; workItemId: string; policy: Policy; receipt: ContextReceipt; changes: Array<{ recordId: string; toVersion: number }> }): ClaimsCheck {
	const { state, workItemId, policy, receipt, changes } = input;
	const wi = state.workItems[workItemId];
	if (!wi) return { pass: false, problems: ["unknown work item"] };
	const problems: string[] = [];
	const claims = wi.claims;
	if (!claims || claims.headSha !== wi.headSha) {
		problems.push("no claims were recorded for the verified head");
	} else if (claims.status !== "ok") {
		problems.push(`the claims at the verified head are ${claims.status}${claims.error ? ` (${claims.error})` : ""}`);
	} else {
		const delivered = new Map(receipt.accepted.map((e) => [e.recordId, e.version]));
		for (const claim of claims.claims) {
			const ref = parseRecordRef(claim.basedOn);
			const held = ref ? delivered.get(ref.recordId) : undefined;
			if (ref && held !== undefined && held !== ref.version) problems.push(`claim ${claim.subject} cites ${claim.basedOn}, but the receipt delivered ${ref.recordId}@${held}`);
		}
		for (const change of changes) {
			if (!claims.claims.some((claim) => claim.basedOn === `${change.recordId}@${change.toVersion}`)) problems.push(`no claim cites ${change.recordId}@${change.toVersion}, the version that changed`);
		}
	}
	const analysis = analyze(state, workItemId, policy);
	for (const finding of analysis.stale) problems.push(`still stale: ${finding.recordId}@${finding.fromVersion} (accepted is v${finding.toVersion})`);
	for (const finding of analysis.conflicts) problems.push(finding.message);
	for (const finding of analysis.uncertain) problems.push(finding.message);
	return { pass: problems.length === 0, problems };
}

export class RevalidationDispatcher {
	readonly #host: DispatchHost;
	#stepping = false;

	constructor(host: DispatchHost) {
		this.#host = host;
	}

	/** DISPATCH_WORK for an accepted revalidate resolution: owe the runtime one dispatch for it. Synchronous and idempotent. */
	enqueue(effect: Extract<Effect, { type: "DISPATCH_WORK" }>, requestId: string): void {
		this.#host.meta.enqueueDispatch({ requestId, workItemId: effect.workItemId, diff: effect.diff, nowMs: Date.now() });
	}

	/** One pass over the jobs that are owed work. Never throws; a job that cannot proceed is retried or marked failed. */
	async step(): Promise<void> {
		if (this.#stepping) return;
		this.#stepping = true;
		try {
			for (const job of this.#host.meta.activeDispatches()) {
				if (job.retryAt !== null && job.retryAt > Date.now()) continue;
				try {
					await this.#advance(job);
				} catch (error) {
					await this.#handle(job, error);
				}
			}
		} finally {
			this.#stepping = false;
		}
	}

	async #handle(job: DispatchJobRow, error: unknown): Promise<void> {
		const message = redactText(error instanceof Error ? error.message : String(error));
		if (error instanceof Permanent || (error instanceof AgentRuntimeError && !error.retryable)) {
			await this.#fail(job, message);
			return;
		}
		const attempts = job.attempts + 1;
		this.#host.logError(`re-dispatch of ${job.workItemId} (attempt ${attempts})`, error);
		if (attempts >= MAX_ATTEMPTS) {
			await this.#fail(job, `gave up after ${attempts} attempts: ${message}`);
			return;
		}
		this.#host.meta.updateDispatch(job.requestId, { attempts, error: message, retryAt: Date.now() + Math.min(2000 * 2 ** (attempts - 1), MAX_BACKOFF_MS) }, Date.now());
	}

	/** End a job as failed. If a run was started, close it in the ledger as a failure (once). */
	async #fail(job: DispatchJobRow, reason: string, options: { runFinished?: boolean } = {}): Promise<void> {
		const host = this.#host;
		host.meta.updateDispatch(job.requestId, { phase: "failed", error: reason, retryAt: null }, Date.now());
		if (job.runId && !options.runFinished) {
			try {
				await host.submit({ type: "AgentRunFinished", ts: host.now(), workItemId: job.workItemId, runId: job.runId, outcome: "failure" });
			} catch (error) {
				host.logError("could not record the failed run", error);
			}
		}
		await host.activity(job.workItemId, "error", `Revalidation did not complete: ${reason}`).catch(() => undefined);
	}

	async #advance(first: DispatchJobRow): Promise<void> {
		const host = this.#host;
		let job = first;
		const reload = (): DispatchJobRow => host.meta.activeDispatches().find((j) => j.requestId === first.requestId) ?? job;

		if (job.phase === "queued") {
			const prepared = await this.#prepare(job);
			host.meta.updateDispatch(job.requestId, { phase: "prepared", payload: prepared, error: null }, Date.now());
			job = reload();
		}
		if (job.phase === "prepared") {
			const prepared = Prepared.parse(job.payload);
			const updated = await this.#issueReceipt(job, prepared);
			host.meta.updateDispatch(job.requestId, { phase: "receipted", payload: updated, error: null }, Date.now());
			job = reload();
		}
		if (job.phase === "receipted") {
			const prepared = Prepared.parse(job.payload);
			const run = await this.#dispatch(job, prepared);
			host.meta.updateDispatch(job.requestId, { phase: "running", runId: run.runId, error: null, attempts: 0, retryAt: null }, Date.now());
			return;
		}
		if (job.phase === "running") await this.#check(job, Prepared.parse(job.payload));
	}

	// ---------- queued -> prepared ----------

	async #prepare(job: DispatchJobRow): Promise<Prepared> {
		const host = this.#host;
		const state = await host.loadState();
		const wi = state.workItems[job.workItemId];
		if (!wi) throw new Permanent(`${job.workItemId} is not a registered work item`);
		if (wi.item.status === "promoted") throw new Permanent(`${job.workItemId} is already promoted`);
		if (!wi.revalidating) throw new Permanent(`no revalidation is under way for ${job.workItemId}, so no new receipt would be taken`);
		const runtime = runtimeIdFor(job.workItemId);
		if (!runtime.ok) throw new Permanent(runtime.error);
		const clash = runtimeIdCollision(job.workItemId, Object.keys(state.workItems));
		if (clash) throw new Permanent(`${job.workItemId} and ${clash} would share one agent sandbox and one commit author`);

		// Everything the work depends on, at the versions accepted now: the receipt covers exactly what is delivered.
		const recordIds = [...new Set([...wi.receipt.accepted.map((e) => e.recordId), ...acceptedDependenciesOf(state, job.workItemId).map((d) => d.recordId)])].filter((id) => currentSnapshot(state, id) !== null).sort();
		const receipt = await buildReceipt(state, { baselineCommit: state.baselineCommit, recordIds });

		const context: Record<string, string> = {};
		for (const entry of receipt.accepted) {
			// Blobs are content-addressed: this is the text the receipt's blobHash names, whoever else has written to the baseline since.
			const text = await host.port.readBlob(host.baselineRepo(), entry.blobHash);
			if (text === null) throw new Error(`cannot read ${entry.recordId}@${entry.version} (${short(entry.blobHash)}) from the baseline`);
			const parsed = await toRecordSnapshot(text, { blobHash: entry.blobHash });
			if (!parsed.ok || parsed.snapshot.recordId !== entry.recordId || parsed.snapshot.version !== entry.version || parsed.snapshot.facetHash !== entry.facetHash) {
				throw new Permanent(`the baseline's ${entry.recordId} blob does not match the accepted v${entry.version}; nothing was delivered`);
			}
			context[contextFileName(entry.recordId, host.meta.recordPath(entry.recordId))] = text;
		}

		// What changed, against the versions delivered now (the accepted head may have moved since the resolution).
		const delivered = new Map(receipt.accepted.map((e) => [e.recordId, e.version]));
		const changes = z
			.array(RecordDiff)
			.parse(job.diff)
			.flatMap((d) => {
				const toVersion = delivered.get(d.recordId);
				return toVersion !== undefined && toVersion > d.fromVersion ? [{ recordId: d.recordId, fromVersion: d.fromVersion, toVersion }] : [];
			});
		const revalidate = Revalidate.safeParse({ changes, context });
		if (!revalidate.success) throw new Permanent(`this change cannot be delivered as a revalidation: ${revalidate.error.issues[0]?.message ?? "invalid"}`);

		const head = (await host.port.log(wi.item.forkRepo, { limit: 1 }))[0];
		if (!head) throw new Error(`${wi.item.forkRepo} has no commits`);
		return {
			runtimeId: runtime.id,
			// The runtime prefixes the diff-aware revalidation text; the task itself is the work item's title.
			prompt: wi.item.title,
			revalidate: revalidate.data,
			receipt,
			baseHead: head.sha,
		};
	}

	// ---------- prepared -> receipted ----------

	async #issueReceipt(job: DispatchJobRow, prepared: Prepared): Promise<Prepared> {
		const host = this.#host;
		const state = await host.loadState();
		const wi = state.workItems[job.workItemId];
		if (!wi) throw new Permanent(`${job.workItemId} is not a registered work item`);

		// The note is best effort: a failure is reported and the receipt is issued without a noteRef.
		let noteRef: string | undefined;
		let noteError: string | undefined;
		try {
			await withTimeout(
				host.port.writeNote({ repo: wi.item.forkRepo, commitSha: prepared.baseHead, ref: NOTES_REF, text: serializeReceiptNote(prepared.receipt), author: WORKER_IDENTITY, committer: WORKER_IDENTITY }),
				NOTE_TIMEOUT_MS,
				"receipt note",
			);
			noteRef = formatNoteRef(prepared.baseHead);
		} catch (error) {
			noteError = redactText(error instanceof Error ? error.message : String(error));
			await host.activity(job.workItemId, "status", `Receipt note not written (${noteError}); the receipt is recorded in the ledger without a noteRef.`).catch(() => undefined);
		}

		const receipt = { ...prepared.receipt, ...(noteRef ? { noteRef: noteRef as ContextReceipt["noteRef"] } : {}) };
		const result = await host.submit({ type: "ReceiptIssued", ts: host.now(), workItemId: job.workItemId, receipt });
		// Whatever the reconciler said, the test is whether the cell now holds this receipt.
		const held = (await host.loadState()).workItems[job.workItemId]?.receipt;
		if (held?.contextPacketHash !== receipt.contextPacketHash || held.baselineCommit !== receipt.baselineCommit) {
			const codes = [...new Set(result.effects.flatMap((e) => e.reasonCodes))].join(", ") || result.outcome;
			throw new Permanent(`the cell did not take the new receipt (${codes}); revalidate again`);
		}
		await host.activity(job.workItemId, "status", `New receipt issued: ${receipt.accepted.map((e) => `${e.recordId}@${e.version}`).join(", ")}${noteRef ? ` (note on ${short(prepared.baseHead)})` : ""}.`).catch(() => undefined);
		return { ...prepared, receipt, ...(noteError ? { noteError } : {}) };
	}

	// ---------- receipted -> running ----------

	async #dispatch(job: DispatchJobRow, prepared: Prepared): Promise<AgentRunView> {
		const host = this.#host;
		const state = await host.loadState();
		const wi = state.workItems[job.workItemId];
		if (!wi) throw new Permanent(`${job.workItemId} is not a registered work item`);
		const run = await withTimeout(
			host.runtime.dispatch({
				workItemId: prepared.runtimeId,
				forkRepo: wi.item.forkRepo,
				prompt: prepared.prompt,
				revalidate: prepared.revalidate,
				idempotencyKey: await dispatchKey(host.scenario(), job.requestId),
			}),
			DISPATCH_TIMEOUT_MS,
			"agent dispatch",
		);
		await host.submit({ type: "AgentRunStarted", ts: iso(run.startedAt), workItemId: job.workItemId, runId: run.runId, model: run.model });
		await host.activity(job.workItemId, "status", `Agent re-dispatched on ${wi.item.forkRepo} with ${prepared.revalidate.changes.map((c) => `${c.recordId} v${c.fromVersion} to v${c.toVersion}`).join(", ")}.`).catch(() => undefined);
		return run;
	}

	// ---------- running -> done ----------

	async #check(job: DispatchJobRow, prepared: Prepared): Promise<void> {
		const host = this.#host;
		const run = await host.runtime.status(prepared.runtimeId);
		if (!run || run.runId !== job.runId) {
			const misses = job.misses + 1;
			if (misses >= MAX_MISSES) throw new Permanent(`the runtime has no record of run ${job.runId ?? "(none)"}`);
			host.meta.updateDispatch(job.requestId, { misses }, Date.now());
			return;
		}
		if (job.misses > 0) host.meta.updateDispatch(job.requestId, { misses: 0 }, Date.now());
		if (run.state === "running") return;

		await host.submit({ type: "AgentRunFinished", ts: iso(run.finishedAt ?? host.now()), workItemId: job.workItemId, runId: run.runId, outcome: run.state === "succeeded" ? "success" : "failure" });
		if (run.state !== "succeeded" || !run.commit || run.pushVerified !== true) {
			await this.#fail(job, run.error ?? `the run ${run.state === "succeeded" ? "ended without a verified push" : run.state}`, { runFinished: true });
			return;
		}

		// The commit is not taken from the run's word: it must be the fork's head, authored by the work item, and the cell must have recorded it.
		const state0 = await host.loadState();
		const forkRepo = state0.workItems[job.workItemId]?.item.forkRepo;
		if (!forkRepo) throw new Permanent(`${job.workItemId} is not a registered work item`);
		await host.catchUp(forkRepo);
		const head = (await host.port.log(forkRepo, { limit: 1 }))[0];
		if (!head || head.sha !== run.commit || head.authorName !== run.author) {
			await this.#fail(job, `the fork head (${head ? short(head.sha) : "none"}) is not the verified push ${short(run.commit)}; no evidence was recorded`, { runFinished: true });
			return;
		}
		const state = await host.loadState();
		const wi = state.workItems[job.workItemId];
		if (wi?.headSha !== head.sha) {
			await this.#fail(job, `the cell has not recorded the verified push ${short(head.sha)} as the head of ${job.workItemId}; no evidence was recorded`, { runFinished: true });
			return;
		}

		const verdict = claimsCheck({ state, workItemId: job.workItemId, policy: host.policy(), receipt: prepared.receipt, changes: prepared.revalidate.changes });
		const checks = analyze(state, job.workItemId, host.policy()).requiredChecks;
		const output = [
			`NOT AN EXECUTED TEST. Delta verified the push ${short(head.sha)} (author ${run.author}) and compared the claims at that head with the receipt it issued and the accepted facets.`,
			verdict.pass ? "Result: the claims cite the delivered versions and agree with the accepted facets." : `Result: failed. ${verdict.problems.join(" ")}`,
			"The record's contract test was not run.",
		].join(" ");
		for (const check of checks.length > 0 ? checks : [FALLBACK_CHECK]) {
			await host.submit({
				type: "EvidenceRecorded",
				ts: host.now(),
				repo: forkRepo,
				commitSha: head.sha,
				runId: run.runId,
				evidence: { workItemId: job.workItemId, headSha: head.sha, check, pass: verdict.pass, output, kind: "delta-claims-check" },
			});
		}
		host.meta.updateDispatch(job.requestId, { phase: "done", error: null }, Date.now());
		await host.activity(job.workItemId, "status", verdict.pass ? `Revalidated push ${short(head.sha)} checked: claims match the new receipt.` : `Revalidated push ${short(head.sha)} did not check out: ${verdict.problems.join(" ")}`).catch(() => undefined);
	}
}
