import { describe, expect, it } from "vitest";
import { redactDeep, redactText, stripExpiry } from "./tokens";

// Built at runtime so no token-shaped literal sits in the source.
const secret = ["art", "v2", "x"].join("_") + "_" + "A1b2C3d4E5".repeat(4);
const full = `${secret}?expires=1790000000`;

describe("stripExpiry", () => {
	it("drops the ?expires suffix for the Basic-auth password", () => {
		expect(stripExpiry(full)).toBe(secret);
	});

	it("leaves a token without a suffix unchanged", () => {
		expect(stripExpiry(secret)).toBe(secret);
	});
});

describe("redactText", () => {
	it("removes tokens, with or without the expiry suffix", () => {
		const out = redactText(`bearer ${full} and ${secret}`);
		expect(out).not.toContain(secret);
		expect(out).toBe("bearer [redacted-token] and [redacted-token]");
	});

	it("removes URL credentials and masks the account host label", () => {
		const acct = "0123456789abcdef0123456789abcdef";
		expect(redactText(`https://x:pw@${acct}.artifacts.cloudflare.net/git/default/r.git`)).toBe(
			"https://<account>.artifacts.cloudflare.net/git/default/r.git",
		);
	});

	it("keeps ordinary text and 40-char commit hashes", () => {
		const sha = "a".repeat(40);
		expect(redactText(`commit ${sha} pushed`)).toBe(`commit ${sha} pushed`);
	});
});

describe("redactDeep", () => {
	it("redacts nested strings and leaves other values alone", () => {
		const out = redactDeep({ a: [{ t: full }], n: 3, ok: true, none: null });
		expect(JSON.stringify(out)).not.toContain(secret);
		expect(out.n).toBe(3);
		expect(out.none).toBeNull();
	});
});
