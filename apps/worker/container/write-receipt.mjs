// Writes .delta/receipt.json for a revalidation run from the context files now in .delta/context/.
//   node write-receipt.mjs --repo DIR --work-item ID --base-commit SHA --changes FILE
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRevalidationReceipt } from "./receipt-lib.ts";

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const repo = arg("repo");
const workItemId = arg("work-item");
const baseCommit = arg("base-commit");
const changesFile = arg("changes");
if (!repo || !workItemId || !baseCommit || !changesFile) {
	console.error("usage: write-receipt.mjs --repo DIR --work-item ID --base-commit SHA --changes FILE");
	process.exit(2);
}

const dir = join(repo, ".delta", "context");
const contextFiles = {};
if (existsSync(dir)) {
	for (const name of readdirSync(dir).sort()) if (name.endsWith(".md")) contextFiles[name] = readFileSync(join(dir, name), "utf8");
}
const receipt = await buildRevalidationReceipt({
	workItemId,
	baseCommit,
	changes: JSON.parse(readFileSync(changesFile, "utf8")),
	contextFiles,
});
writeFileSync(join(repo, ".delta", "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
