import { commitFiles, errorCode, getRepo, sleep } from "./artifacts/git-write";
import { diffCommits, type TreeDiff } from "./artifacts/tree-diff";
import { redactDeep } from "./artifacts/tokens";
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

export interface SeededScenario {
	baseline: { name: string; remote: string };
	forks: { name: string; remote: string }[];
	/** True only when every creation token was revoked. */
	creationTokensRevoked: boolean;
}

/**
 * A baseline with the seed commit plus `count` ready forks, for exercising the agent runtime.
 * Names start with `smoke-` so DELETE /api/smoke can purge them.
 */
export async function seedForks(env: Env, count: number): Promise<SeededScenario> {
	const prefix = `smoke-m1-${Date.now()}`;
	const baselineName = `${prefix}-baseline`;
	const created = await env.ARTIFACTS.create(baselineName, { setDefaultBranch: BRANCH });
	let allRevoked = await revokeToken(env, baselineName, created.token);
	await commitFiles(env, baselineName, SEED_FILES, "seed: baseline context v1", { retryNotFound: true });

	const forks = await Promise.all(
		Array.from({ length: count }, async (_, i) => {
			const name = `${prefix}-wi-${i + 1}`;
			using base = await getRepo(env, baselineName);
			const fork = await base.fork(name);
			try {
				await waitForFork(env, name);
			} finally {
				allRevoked = (await revokeToken(env, name, fork.token)) && allRevoked;
			}
			return { name, remote: fork.remote };
		}),
	);
	return { baseline: { name: baselineName, remote: created.remote }, forks, creationTokensRevoked: allRevoked };
}

/** Delete every repo whose name starts with `smoke-`. Returns the names removed. */
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
