import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("build base", () => {
	it("is absolute, so a deep path that falls back to index.html still loads /assets/*", () => {
		// With "./", a request for /foo/bar gets index.html whose "./assets/x.js" resolves to /foo/assets/x.js (HTML): a blank page.
		const config = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
		expect(config).toMatch(/^\s*base:\s*"\/",/m);
	});
});
