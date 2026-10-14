import { fileURLToPath } from "node:url";

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Shell command that runs one of the adapters in conformance/adapters with plain Node. */
export function adapterCommand(file: string, ...args: string[]): string {
	return [process.execPath, "--import", here("../ts-hooks.mjs"), here(`../adapters/${file}`), ...args].map((part) => JSON.stringify(part)).join(" ");
}
