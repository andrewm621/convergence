import { ClaimsFile } from "contracts";
import { z } from "zod";
import { REPO_NAME_RE } from "./agents/protocol";
import { commitFiles, errorCode, getRepo, sleep } from "./artifacts/git-write";
import { diffCommits, type TreeDiff } from "./artifacts/tree-diff";
import { redactDeep } from "./artifacts/tokens";
import { NOTIFICATIONS_V1, STATUS_MODEL_V1 } from "scenario-notifications";
import { POINTER_SCENARIO } from "./cell/pointer-scenario";
import { pointerCommitMessage, pointerFiles } from "./smoke-build";
import { NOTIFICATIONS_V2, SEED_FILES, recordVersion } from "./smoke-fixtures";

const BRANCH = "main";
const RECORD_PATH = "context/notifications.md";

export interface StepRecord {
	step: string;
	ok: boolean;
	ms: number;
	result?: unknown;
	error?: { code?: string; message: string };
}

export interface SmokeReport {
	ok: boolean;
	totalMs: number;
	repos: { baseline: { name: string; remote?: string }; fork: { name: string; remote?: string } };
	steps: StepRecord[];
}

async function readText(repo: ArtifactsRepo, ref: string, path: string): Promise<string | null> {
	const blob = await repo.readFile({ ref, path });
	return blob ? await blob.text() : null;
}

/** The fork is ready once get() stops throwing FORK_IN_PROGRESS and info() answers. */
export async function waitForFork(env: Env, name: string, maxMs = 30_000) {
	const t0 = Date.now();
	let polls = 0;
	for (;;) {
		polls++;
		try {
			using repo = await env.ARTIFACTS.get(name);
			const info = await repo.info();
			return { polls, readyAfterMs: Date.now() - t0, info };
		} catch (e) {
			const code = errorCode(e);
			if (code !== "FORK_IN_PROGRESS" && code !== "CREATE_IN_PROGRESS" && code !== "NOT_FOUND") throw e;
			if (Date.now() - t0 > maxMs) throw new Error(`fork ${name} not ready after ${maxMs}ms`);
			await sleep(400);
		}
	}
}

/** Revoke a token on a repo that may have been created a moment ago. False when it could not be revoked. */
async function revokeToken(env: Env, repoName: string, token: string): Promise<boolean> {
	try {
		using repo = await getRepo(env, repoName, { retryNotFound: true });
		return await repo.revokeToken(token);
	} catch {
		return false;
	}
}

export interface SmokeOptions {
	baselineName?: string;
	/** Delete the repos this run created (never a reused baseline) once the steps are done. */
	cleanup?: boolean;
}

function summarizeDiff(diff: TreeDiff) {
	return { ...diff, changedPaths: [...diff.added, ...diff.removed, ...diff.changed].map((c) => c.path) };
}

export async function runSmoke(env: Env, opts: SmokeOptions = {}): Promise<SmokeReport> {
	const { baselineName, cleanup = false } = opts;
	const t0 = Date.now();
	const ts = Date.now();
	const prefix = baselineName ? baselineName.replace(/-baseline$/, "") : `smoke-${ts}`;
	const baseline = baselineName ?? `${prefix}-baseline`;
	const fork = baselineName ? `${prefix}-wi-1-${ts}` : `${prefix}-wi-1`;

	const report: SmokeReport = {
		ok: false,
		totalMs: 0,
		repos: { baseline: { name: baseline }, fork: { name: fork } },
		steps: [],
	};

	async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
		const start = Date.now();
		try {
			const result = await fn();
			report.steps.push({ step: name, ok: true, ms: Date.now() - start, result });
			return result;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			report.steps.push({ step: name, ok: false, ms: Date.now() - start, error: { code: errorCode(e), message } });
			return undefined;
		}
	}

	const finish = (): SmokeReport => {
		report.totalMs = Date.now() - t0;
		report.ok = report.steps.every((s) => s.ok);
		return redactDeep(report);
	};

	let baselineCreated = false;
	let forkCreated = false;

	async function runSteps(): Promise<void> {
		// (a) baseline repo
		const created = await step("a.create-baseline", async () => {
			if (baselineName) {
				using repo = await getRepo(env, baseline);
				const info = await repo.info();
				report.repos.baseline.remote = info.remote;
				return { reused: true, defaultBranch: info.defaultBranch };
			}
			const repo = await env.ARTIFACTS.create(baseline, { setDefaultBranch: BRANCH });
			baselineCreated = true;
			report.repos.baseline.remote = repo.remote;
			// The creation token is never used (writes mint a short-lived token). Revoke it, and fail the step if that fails.
			const revoked = await revokeToken(env, baseline, repo.token);
			if (!revoked) throw new Error("creation token for the baseline was not revoked");
			return { reused: false, defaultBranch: repo.defaultBranch, creationTokenRevoked: revoked };
		});
		if (!created) return;

		// (b) seed commit pushed from the Worker; the repo was created moments ago, so tolerate a brief NOT_FOUND
		const seed = await step("b.push-seed", () =>
			commitFiles(env, baseline, SEED_FILES, "seed: baseline context v1", { retryNotFound: !baselineName }),
		);
		if (!seed) return;

		// (c) fork, poll until ready
		const forked = await step("c.fork", async () => {
			using base = await getRepo(env, baseline);
			const created = await base.fork(fork);
			forkCreated = true;
			report.repos.fork.remote = created.remote;
			// Revoke the fork's creation token on every path, including a fork that never becomes ready.
			let ready: Awaited<ReturnType<typeof waitForFork>>;
			let revoked = false;
			try {
				ready = await waitForFork(env, fork);
			} finally {
				revoked = await revokeToken(env, fork, created.token);
			}
			if (!revoked) throw new Error("creation token for the fork was not revoked");
			return {
				status: "ready",
				polls: ready.polls,
				readyAfterMs: ready.readyAfterMs,
				source: ready.info.source,
				forkTokenRevoked: revoked,
			};
		});
		if (!forked) return;

		// (d) context change on the baseline: v2
		const v2 = await step("d.push-context-v2", () =>
			commitFiles(env, baseline, { [RECORD_PATH]: NOTIFICATIONS_V2 }, "context: notifications v2 (opt-in, weekly-digest)"),
		);
		if (!v2) return;

		// (e) read and diff through the binding only
		await step("e.diff-via-binding", async () => {
			using base = await getRepo(env, baseline);
			using forkRepo = await getRepo(env, fork);

			const baseLog = await base.log({ ref: BRANCH, limit: 5 });
			const forkLog = await forkRepo.log({ ref: BRANCH, limit: 5 });
			const head = baseLog[0];
			const prev = baseLog[1];
			const forkHead = forkLog[0];
			if (!head || !prev) throw new Error(`baseline log has ${baseLog.length} commits, expected at least 2`);
			if (!forkHead) throw new Error("fork log is empty");

			const baselineDiff = await diffCommits({ reader: base, commit: prev.hash }, { reader: base, commit: head.hash });
			const forkVsBaseline = await diffCommits(
				{ reader: forkRepo, commit: forkHead.hash },
				{ reader: base, commit: head.hash },
			);
			const forkVsPrev = await diffCommits(
				{ reader: forkRepo, commit: forkHead.hash },
				{ reader: base, commit: prev.hash },
			);

			const [baseV2, baseV1, forkRecord] = await Promise.all([
				readText(base, head.hash, RECORD_PATH),
				readText(base, prev.hash, RECORD_PATH),
				readText(forkRepo, BRANCH, RECORD_PATH),
			]);

			return {
				commits: {
					baselineHead: head.hash,
					baselineHeadMinus1: prev.hash,
					forkHead: forkHead.hash,
					baselineCommitCount: baseLog.length,
					forkCommitCount: forkLog.length,
				},
				recordVersions: {
					baselineHeadMinus1: baseV1 ? recordVersion(baseV1) : null,
					baselineHead: baseV2 ? recordVersion(baseV2) : null,
					fork: forkRecord ? recordVersion(forkRecord) : null,
				},
				baselinePrevToHead: summarizeDiff(baselineDiff),
				forkToBaselineHead: summarizeDiff(forkVsBaseline),
				forkToBaselinePrevIsEmpty:
					forkVsPrev.added.length + forkVsPrev.removed.length + forkVsPrev.changed.length === 0,
			};
		});

	}

	try {
		await runSteps();
	} finally {
		if (cleanup) {
			// Only repos this run created. A baseline passed in by the caller is never deleted.
			await step("z.cleanup", async () => {
				const deleted: Record<string, boolean> = {};
				if (forkCreated) deleted[fork] = await env.ARTIFACTS.delete(fork);
				if (baselineCreated) deleted[baseline] = await env.ARTIFACTS.delete(baseline);
				if (Object.values(deleted).some((ok) => !ok)) throw new Error(`delete returned false: ${JSON.stringify(deleted)}`);
				return { deleted };
			});
		}
	}

	return finish();
}

/** The baseline files of Scenario A: the two accepted records the notifications policy governs, plus the agent protocol and a source file. */
export const NOTIFICATIONS_SCENARIO_FILES: Record<string, string> = {
	"AGENTS.md": SEED_FILES["AGENTS.md"]!,
	"context/notifications.md": NOTIFICATIONS_V1,
	"context/status-model.md": STATUS_MODEL_V1,
	"src/index.ts": SEED_FILES["src/index.ts"]!,
};

export interface SeededScenario {
	baseline: { name: string; remote: string };
	forks: { name: string; remote: string }[];
	/** True only when every creation token was revoked. */
	creationTokensRevoked: boolean;
}

export const SMOKE_PREFIX = "smoke-";

/** An optional name for a seeded set of repos (`smoke-<label>-<time>-...`), so a demo's repos can be told apart. */
export const SMOKE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Repos named after the build cell are reachable by the pointer routes, so only the build seed may use that label. */
export function seedLabelAllowed(scenario: string | undefined, label: string | undefined): boolean {
	return label === undefined || scenario === POINTER_SCENARIO || !label.startsWith(POINTER_SCENARIO);
}

/**
 * A baseline with the seed commit plus `count` ready forks, for exercising the agent runtime.
 * Names start with `smoke-`, which is what DELETE /api/smoke accepts. `label` replaces the default `m1` in the name.
 */
export async function seedForks(
	env: Env,
	count: number,
	files: Record<string, string> = SEED_FILES,
	label = "m1",
	/** One commit per fork, made right after it is ready, in fork order (a pointer work item's claims, say). */
	forkCommits: Array<{ files: Record<string, string>; message: string }> = [],
): Promise<SeededScenario> {
	const prefix = `${SMOKE_PREFIX}${label}-${Date.now()}`;
	const baselineName = `${prefix}-baseline`;
	const created = await env.ARTIFACTS.create(baselineName, { setDefaultBranch: BRANCH });
	// Every name this seed may have created, so a failure part-way deletes them instead of leaving orphans the caller never hears about.
	const attempted = [baselineName];
	try {
		let allRevoked = await revokeToken(env, baselineName, created.token);
		await commitFiles(env, baselineName, files, "seed: baseline context v1", { retryNotFound: true });

		// One fork at a time: seven concurrent forks of one baseline made Artifacts answer some with an internal error (live, Oct 13).
		const forks: Array<{ name: string; remote: string }> = [];
		for (let i = 0; i < count; i++) {
			const name = `${prefix}-wi-${i + 1}`;
			attempted.push(name);
			const fork = await forkSmokeRepo(env, baselineName, name, forkCommits[i]);
			allRevoked = fork.revoked && allRevoked;
			forks.push({ name, remote: fork.remote });
		}
		return { baseline: { name: baselineName, remote: created.remote }, forks, creationTokensRevoked: allRevoked };
	} catch (error) {
		await deleteSmokeRepos(env, attempted).catch(() => undefined);
		throw error;
	}
}

/** Fork `baselineName` into `name`, wait until it is ready, revoke its creation token, and commit `commit` to it if given. */
export async function forkSmokeRepo(
	env: Env,
	baselineName: string,
	name: string,
	commit?: { files: Record<string, string>; message: string },
): Promise<{ remote: string; revoked: boolean }> {
	using base = await getRepo(env, baselineName);
	const fork = await base.fork(name);
	let revoked = false;
	try {
		await waitForFork(env, name);
	} finally {
		revoked = await revokeToken(env, name, fork.token);
	}
	if (commit) await commitFiles(env, name, commit.files, commit.message, { retryNotFound: true });
	return { remote: fork.remote, revoked };
}

/** DELETE /api/smoke body: the repos a run created, by exact name. Each must be a `smoke-` repo. */
export const SmokeDeleteRequest = z.strictObject({
	repos: z
		.array(z.string().regex(REPO_NAME_RE, "not a valid repo name").startsWith(SMOKE_PREFIX, `repo names must start with ${SMOKE_PREFIX}`))
		.min(1)
		.max(20),
});

/** Delete exactly these repos (`smoke-` names only). A name that does not exist is reported as failed. */
export async function deleteSmokeRepos(env: Env, names: string[]): Promise<{ deleted: string[]; failed: string[] }> {
	const deleted: string[] = [];
	const failed: string[] = [];
	for (const name of new Set(names)) {
		if (!name.startsWith(SMOKE_PREFIX)) throw new Error(`refusing to delete ${name}: not a ${SMOKE_PREFIX} repo`);
		((await env.ARTIFACTS.delete(name)) ? deleted : failed).push(name);
	}
	return { deleted, failed };
}

/** Delete every repo whose name starts with `smoke-`, a recorded demo's included. Only on request (`?all=1`). Returns the names removed. */
export async function purgeSmokeRepos(env: Env): Promise<{ deleted: string[]; failed: string[] }> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.ARTIFACTS.list({ limit: 200, cursor });
		for (const r of page.repos) if (r.name.startsWith("smoke-")) names.push(r.name);
		cursor = page.cursor;
	} while (cursor);
	const deleted: string[] = [];
	const failed: string[] = [];
	for (const name of names) ((await env.ARTIFACTS.delete(name)) ? deleted : failed).push(name);
	return { deleted, failed };
}

/** The repos of a seeded build cell are `smoke-delta-convergence-build-...`; the pointer routes touch nothing else, so never a recorded demo's repos. */
export const POINTER_REPO_PREFIX = `${SMOKE_PREFIX}${POINTER_SCENARIO}-`;
const PointerRepoName = z.string().regex(REPO_NAME_RE, "not a valid repo name").startsWith(POINTER_REPO_PREFIX, `repo names must start with ${POINTER_REPO_PREFIX}`);
/** A fork to write to: never a baseline. */
const PointerForkName = PointerRepoName.refine((name) => !name.endsWith("-baseline"), "a baseline is not a pointer fork");

/** What a pointer work item's fork holds: the claims, and where the real work stands. Nothing else can be written through these routes. */
const PointerBody = {
	claims: ClaimsFile.max(200),
	pointer: z.strictObject({
		workItem: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
		head: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
		note: z.string().trim().min(1).max(500),
	}),
};

/** POST /api/smoke/pointer-fork: a new fork of `baseline`, named `name`, holding one pointer commit. */
export const PointerForkRequest = z.strictObject({ baseline: PointerRepoName, name: PointerForkName, ...PointerBody });
/** POST /api/smoke/pointer-push: a new pointer commit on an existing fork. */
export const PointerPushRequest = z.strictObject({ repo: PointerForkName, ...PointerBody });

export async function forkPointer(env: Env, req: z.infer<typeof PointerForkRequest>) {
	const commit = { files: pointerFiles(req.claims, req.pointer), message: pointerCommitMessage(req.pointer) };
	return { name: req.name, ...(await forkSmokeRepo(env, req.baseline, req.name, commit)) };
}

export async function pushPointer(env: Env, req: z.infer<typeof PointerPushRequest>) {
	const result = await commitFiles(env, req.repo, pointerFiles(req.claims, req.pointer), pointerCommitMessage(req.pointer));
	return { repo: req.repo, commit: result.oid };
}
