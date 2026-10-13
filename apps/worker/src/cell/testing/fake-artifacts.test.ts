import { describe, expect, it } from "vitest";
import { isForkMetadata } from "../../artifacts/merge-rules";
import { FakeWorld } from "./fake-artifacts";

// The fake's promotion merge must agree with the real one (artifacts/git-merge.test.ts runs the same cases on isomorphic-git).

const APP = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].map((w) => `${w}\n`).join("");
const edit = (line: string, to: string) => APP.replace(`${line}\n`, `${to}\n`);
const HUMAN = { name: "decision-owner", email: "d@example.invalid" };
const WORKER = { name: "delta-convergence", email: "w@example.invalid" };

async function world(baseFiles: Record<string, string>) {
	const w = new FakeWorld();
	await w.create("baseline", baseFiles);
	w.fork("baseline", "fork");
	const merge = () =>
		w.port().mergeFork({
			baselineRepo: "baseline",
			forkRepo: "fork",
			expectedBaselineCommit: w.headOf("baseline") as string,
			forkHeadSha: w.headOf("fork") as string,
			message: "promote",
			author: HUMAN,
			committer: WORKER,
		});
	return { w, merge };
}

describe("the fake's promotion merge", () => {
	it("merges separate hunks of a source file, and the fork wins .delta/ where both added it", async () => {
		const { w, merge } = await world({ "src/app.ts": APP, ".delta/claims.json": "[]\n" });
		await w.push("fork", { "src/app.ts": edit("two", "TWO (fork)"), ".delta/claims.json": "fork\n" });
		await w.push("baseline", { "src/app.ts": edit("nine", "NINE (baseline)"), ".delta/claims.json": "baseline\n" });
		await merge();
		const files = w.filesAt("baseline");
		expect(files["src/app.ts"]).toContain("TWO (fork)");
		expect(files["src/app.ts"]).toContain("NINE (baseline)");
		expect(Object.keys(files)).toEqual(["src/app.ts"]); // no .delta/ in the baseline
	});

	it("conflicts on overlapping hunks, whatever else collides under .delta/", async () => {
		const { w, merge } = await world({ "src/app.ts": APP, ".delta/claims.json": "[]\n" });
		await w.push("fork", { "src/app.ts": edit("five", "FIVE (fork)"), ".delta/claims.json": "fork\n" });
		await w.push("baseline", { "src/app.ts": edit("five", "FIVE (baseline)"), ".delta/claims.json": "baseline\n" });
		await expect(merge()).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
	});

	it("conflicts on a .delta/ file one side deleted and the other changed", async () => {
		const { w, merge } = await world({ "src/app.ts": APP, ".delta/claims.json": "[]\n" });
		await w.push("fork", { ".delta/claims.json": "fork\n" });
		await w.push("baseline", { ".delta/claims.json": null });
		await expect(merge()).rejects.toMatchObject({ code: "MERGE_CONFLICT" });
	});

	it("does not fast-forward a fork that carries .delta/, and leaves it out of the baseline", async () => {
		const { w, merge } = await world({ "src/app.ts": APP });
		const forkHead = await w.push("fork", { "src/work.ts": "x\n", ".delta/claims.json": "fork\n" });
		const { mergeCommitSha } = await merge();
		expect(mergeCommitSha).not.toBe(forkHead);
		expect(Object.keys(w.filesAt("baseline")).sort()).toEqual(["src/app.ts", "src/work.ts"]);
	});

	it("still fast-forwards a fork with no .delta/", async () => {
		const { w, merge } = await world({ "src/app.ts": APP });
		const forkHead = await w.push("fork", { "src/work.ts": "x\n" });
		expect((await merge()).mergeCommitSha).toBe(forkHead);
	});
});

describe("isForkMetadata", () => {
	it("is a path under .delta/ with no empty, . or .. segment", () => {
		expect(isForkMetadata(".delta/claims.json")).toBe(true);
		expect(isForkMetadata(".delta/context/notifications.md")).toBe(true);
		for (const not of [".delta", ".delta/", ".delta//x", ".delta/../src/x.ts", ".delta/./x", "src/.delta/x", "x/.delta/y", ".deltax/y", "context/.delta/y"]) expect(isForkMetadata(not), not).toBe(false);
	});
});
