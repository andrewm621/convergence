/**
 * Regenerate conformance/vectors/ from the reference engine. Deterministic: re-running it writes byte-identical
 * files. A test (test/vectors-drift.test.ts) fails when the committed files differ from what this produces.
 *
 *   pnpm --filter conformance vectors
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateVectorFiles } from "./vectors.ts";

const dir = fileURLToPath(new URL("../vectors/", import.meta.url));
const files = await generateVectorFiles();

mkdirSync(dir, { recursive: true });
for (const name of readdirSync(dir)) if (name.endsWith(".json") && !(name in files)) rmSync(join(dir, name));
for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
console.log(`wrote ${Object.keys(files).length} vectors to ${dir}`);
