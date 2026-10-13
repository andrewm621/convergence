import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The product is "Delta Convergence" in full, everywhere a person can read it: never "Delta" alone.
 * Code identifiers (`DeltaEvent`), reason codes, `.delta/` paths and `refs/notes/delta` are not words
 * a person reads, so they are not in scope. This scans the console's source for the bare word.
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
	it("no console source file says Delta alone", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(SRC)) {
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, index) => {
					const cleaned = line
						.replace(/Delta Convergence/g, "")
						.replace(/\bDeltaEvent\b/g, "")
						.replace(/\bdelta-core\b|\.delta\/|refs\/notes\/delta|delta-theme|delta\.v1|X-Delta-Poller|DELTA_/g, "");
					if (/\bDelta\b/.test(cleaned)) offenders.push(`${file.replace(SRC, "src")}:${index + 1}: ${line.trim()}`);
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
