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
async function waitForFork(env: Env, name: string, maxMs = 30_000) {
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

function summarizeDiff(diff: TreeDiff) {
	return { ...diff, changedPaths: [...diff.added, ...diff.removed, ...diff.changed].map((c) => c.path) };
}

export async function runSmoke(env: Env, baselineName?: string): Promise<SmokeReport> {
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

	// (a) baseline repo
	const created = await step("a.create-baseline", async () => {
		if (baselineName) {
			using repo = await getRepo(env, baseline);
			const info = await repo.info();
			report.repos.baseline.remote = info.remote;
			return { reused: true, defaultBranch: info.defaultBranch };
		}
		const repo = await env.ARTIFACTS.create(baseline, { setDefaultBranch: BRANCH });
		report.repos.baseline.remote = repo.remote;
		// The creation token is not used (writes mint a short-lived token); revoke it right away.
		using handle = await getRepo(env, baseline);
		const revoked = await handle.revokeToken(repo.token).catch(() => false);
		return { reused: false, defaultBranch: repo.defaultBranch, creationTokenRevoked: revoked };
	});
	if (!created) return finish();

	// (b) seed commit pushed from the Worker
	const seed = await step("b.push-seed", () =>
		commitFiles(env, baseline, SEED_FILES, "seed: baseline context v1"),
	);
	if (!seed) return finish();

	// (c) fork, poll until ready
	const forked = await step("c.fork", async () => {
		using base = await getRepo(env, baseline);
		const created = await base.fork(fork);
		report.repos.fork.remote = created.remote;
		const ready = await waitForFork(env, fork);
		using forkRepo = await getRepo(env, fork);
		const revoked = await forkRepo.revokeToken(created.token).catch(() => false);
		return {
			status: "ready",
			polls: ready.polls,
			readyAfterMs: ready.readyAfterMs,
			source: ready.info.source,
			forkTokenRevoked: revoked,
		};
	});
	if (!forked) return finish();

	// (d) context change on the baseline: v2
	const v2 = await step("d.push-context-v2", () =>
		commitFiles(env, baseline, { [RECORD_PATH]: NOTIFICATIONS_V2 }, "context: notifications v2 (opt-in, weekly-digest)"),
	);
	if (!v2) return finish();

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

	return finish();
}
