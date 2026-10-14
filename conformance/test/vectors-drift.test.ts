import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateVectorFiles } from "../scripts/vectors.ts";

const dir = fileURLToPath(new URL("../vectors/", import.meta.url));

/**
 * The files in conformance/vectors/ are generated from the reference engine. This test regenerates them in memory
 * and fails if a committed file differs, is missing, or is left over. To refresh them after an intended engine or
 * fixture change, run `pnpm --filter conformance vectors` and review the diff.
 */
describe("committed vectors match the generator", async () => {
	const generated = await generateVectorFiles();
	const committed = readdirSync(dir).filter((name) => name.endsWith(".json"));

	it("has one committed file per generated vector, and no others", () => {
		expect([...committed].sort()).toEqual(Object.keys(generated).sort());
	});

	it("generating twice gives byte-identical files", async () => {
		expect(await generateVectorFiles()).toEqual(generated);
	});

	for (const [name, text] of Object.entries(generated)) {
		it(`${name} is up to date`, () => {
			expect(readFileSync(`${dir}${name}`, "utf8")).toBe(text);
		});
	}
});
