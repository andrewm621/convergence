import diff3Merge from "diff3";

// The rules a promotion merge applies beyond plain git, shared by the real merge (git-merge.ts) and the in-memory
// Artifacts the tests use (cell/testing/fake-artifacts.ts), so the two cannot drift apart.

/** Files the control plane keeps in a fork (claims, receipt, delivered context), not part of the work being promoted. */
export const FORK_METADATA_DIR = ".delta";

/** A path under `.delta/`, with no empty, `.` or `..` segment that could make it mean something else. */
export const isForkMetadata = (path: string): boolean => {
	const segments = path.split("/");
	return segments.length > 1 && segments[0] === FORK_METADATA_DIR && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const LINEBREAKS = /^.*(\r?\n|$)/gm;

/**
 * The line-by-line three-way merge isomorphic-git uses when no driver is given (its internal `mergeFile`), reproduced
 * with the same `diff3` it depends on: once a driver is supplied, isomorphic-git hands it every file both sides changed,
 * so the files that are not ours to decide still need the real merge.
 */
export function mergeLines({ branches, contents }: { branches: string[]; contents: string[] }): { cleanMerge: boolean; mergedText: string } {
	const [baseContent = "", ourContent = "", theirContent = ""] = contents;
	const ours = ourContent.match(LINEBREAKS) ?? [];
	const base = baseContent.match(LINEBREAKS) ?? [];
	const theirs = theirContent.match(LINEBREAKS) ?? [];
	const markerSize = 7;
	let mergedText = "";
	let cleanMerge = true;
	for (const item of diff3Merge(ours, base, theirs)) {
		if (item.ok) mergedText += item.ok.join("");
		if (item.conflict) {
			cleanMerge = false;
			mergedText += `${"<".repeat(markerSize)} ${branches[1]}\n`;
			mergedText += item.conflict.a.join("");
			mergedText += `${"=".repeat(markerSize)}\n`;
			mergedText += item.conflict.b.join("");
			mergedText += `${">".repeat(markerSize)} ${branches[2]}\n`;
		}
	}
	return { cleanMerge, mergedText };
}
