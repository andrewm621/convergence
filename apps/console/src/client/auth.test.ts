import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_STORAGE_KEY, bootstrapToken, clearToken, readToken, socketProtocols, toBase64Url, tokenFromHash } from "./auth";

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	};
}

describe("the access token", () => {
	beforeEach(() => {
		clearToken(memoryStorage());
		sessionStorage.clear();
		localStorage.clear();
	});

	it("reads #token= from the URL hash without form-decoding it, and leaves other hash params alone", () => {
		expect(tokenFromHash("#token=abc+def/ghi=")).toEqual({ token: "abc+def/ghi=", rest: "" });
		expect(tokenFromHash("#a=1&token=x%20y&b=2")).toEqual({ token: "x y", rest: "#a=1&b=2" });
		expect(tokenFromHash("#a=1")).toEqual({ token: null, rest: "#a=1" });
		expect(tokenFromHash("")).toEqual({ token: null, rest: "" });
		expect(tokenFromHash("#token=")).toEqual({ token: null, rest: "" });
	});

	it("takes the hash token, stores it only in sessionStorage, and removes it from the address bar", () => {
		const storage = memoryStorage();
		const replaceHash = vi.fn();
		const prompt = vi.fn();
		expect(bootstrapToken({ hash: "#token=from-hash", storage, replaceHash, prompt })).toBe("from-hash");
		expect(storage.map.get(TOKEN_STORAGE_KEY)).toBe("from-hash");
		expect(replaceHash).toHaveBeenCalledWith("");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("falls back to the tab's stored token, then to a prompt, and gives up if the person declines", () => {
		const storage = memoryStorage();
		const prompt = vi.fn<() => string | null>().mockReturnValueOnce("  typed-in  ").mockReturnValueOnce(null);
		expect(bootstrapToken({ hash: "", storage, prompt })).toBe("typed-in");
		expect(storage.map.get(TOKEN_STORAGE_KEY)).toBe("typed-in");
		// Now it is stored: no second prompt.
		expect(bootstrapToken({ hash: "", storage, prompt })).toBe("typed-in");
		expect(prompt).toHaveBeenCalledTimes(1);
		storage.map.clear();
		expect(bootstrapToken({ hash: "", storage, prompt })).toBeNull();
	});

	it("writes to sessionStorage and never to localStorage", () => {
		bootstrapToken({ hash: "#token=only-session", replaceHash: () => undefined });
		expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe("only-session");
		expect(readToken()).toBe("only-session");
		expect(localStorage.length).toBe(0);
	});

	it("keeps the token in memory when sessionStorage throws, so requests do not all 401 after the hash is cleared", () => {
		const broken = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const replaceHash = vi.fn();
		expect(bootstrapToken({ hash: "#token=kept-in-memory", storage: broken, replaceHash })).toBe("kept-in-memory");
		expect(replaceHash).toHaveBeenCalledWith("");
		expect(readToken(broken)).toBe("kept-in-memory");
		expect(localStorage.length).toBe(0);
		clearToken(broken);
		expect(readToken(broken)).toBeNull();
	});

	it("never logs the token", () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
		bootstrapToken({ hash: "#token=do-not-log-me", storage: memoryStorage(), replaceHash: () => undefined });
		socketProtocols("do-not-log-me");
		expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain("do-not-log-me");
	});

	it("builds the WebSocket subprotocol the Worker decodes: delta.v1 plus bearer.<base64url>", () => {
		expect(toBase64Url("abc")).toBe("YWJj");
		// Characters that differ between base64 and base64url, and a multi-byte one.
		const encoded = toBase64Url("??>>é");
		expect(encoded).not.toMatch(/[+/=]/);
		const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
		expect(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))).toBe("??>>é");
		expect(socketProtocols("abc")).toEqual(["delta.v1", "bearer.YWJj"]);
		expect(socketProtocols(null)).toEqual(["delta.v1"]);
	});
});
