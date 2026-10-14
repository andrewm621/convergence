import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The product is "Convergence". Delta is the reconciliation engine inside it, so "Delta" is never the
 * product name on its own and "Delta Convergence" is retired from every string a person can read.
 * Code identifiers (`DeltaEvent`), reason codes, `.delta/` paths and `refs/notes/delta` are not words
 * a person reads, so they are not in scope. This scans the console's source for both.
 */
const SRC = join(import.meta.dirname);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

describe("naming", () => {
	it("no console source file says Delta alone or the retired product name", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, index) => {
					const cleaned = line
						.replace(/Delta, the reconciliation engine/g, "")
						.replace(/\bDeltaEvent\b/g, "")
						.replace(/\bdelta-core\b|\.delta\/|refs\/notes\/delta|delta-theme|delta\.v1|X-Delta-Poller|DELTA_/g, "");
					if (/\bDelta\b/.test(cleaned) || /Delta Convergence/i.test(line)) offenders.push(`${file.replace(SRC, "src")}:${index + 1}: ${line.trim()}`);
				});
		}
		expect(offenders).toEqual([]);
	});

	it("the fictional county is Larkhaven, and nothing else", () => {
		const text = sourceFiles(SRC)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		expect(text).toContain("Larkhaven County");
		// Spelled in two halves so this file does not itself contain the retired name.
		expect(text).not.toMatch(new RegExp(["ce", "dar"].join(""), "i"));
	});
});
