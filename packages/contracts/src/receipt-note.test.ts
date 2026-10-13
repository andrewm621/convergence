import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import type { ContextReceipt } from "./context";
import { formatNoteRef } from "./context";
import { hashContextPacket, parseReceiptNote, serializeReceiptNote } from "./receipt-note";
import { sha256Hex } from "./hash";

const h = (c: string) => c.repeat(64);

function receipt(): ContextReceipt {
	return {
		baselineCommit: "a100000000000000000000000000000000000001",
		contextPacketHash: h("a"),
		accepted: [
			{ recordId: "status-model", version: 1, blobHash: h("b"), facetHash: h("c") },
			{ recordId: "notifications", version: 1, blobHash: h("d"), facetHash: h("e") },
		],
		proposedVisible: [],
		noteRef: formatNoteRef("a100000000000000000000000000000000000001"),
	};
}

describe("canonicalJson", () => {
	it("is independent of key order and drops undefined", () => {
		expect(canonicalJson({ b: 1, a: { d: 1, c: [2, 1] }, u: undefined })).toBe('{"a":{"c":[2,1],"d":1},"b":1}');
	});
	it("refuses non-finite numbers", () => {
		expect(() => canonicalJson({ n: Number.NaN })).toThrow();
	});
});

describe("sha256Hex", () => {
	it("matches the known empty-string digest", async () => {
		expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
});

describe("receipt git note", () => {
	it("is byte-identical regardless of key or list order", () => {
		const a = receipt();
		const b: ContextReceipt = { ...a, accepted: [...a.accepted].reverse() };
		const reordered = JSON.parse(JSON.stringify(b)) as ContextReceipt;
		expect(serializeReceiptNote(a)).toBe(serializeReceiptNote(reordered));
	});

	it("omits noteRef from the body (it is a pointer to the note, not part of it)", () => {
		expect(serializeReceiptNote(receipt())).not.toContain("noteRef");
	});

	it("starts with a fixed header, sorts records and ends with a newline", () => {
		const text = serializeReceiptNote(receipt());
		expect(text.startsWith("delta-receipt/v1\n{")).toBe(true);
		expect(text.indexOf("notifications")).toBeLessThan(text.indexOf("status-model"));
		expect(text.endsWith("}\n")).toBe(true);
	});

	it("round-trips", () => {
		const parsed = parseReceiptNote(serializeReceiptNote(receipt()));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(serializeReceiptNote(parsed.receipt)).toBe(serializeReceiptNote(receipt()));
	});

	it.each([
		["wrong header", "something-else\n{}\n"],
		["bad json", "delta-receipt/v1\n{nope"],
		["bad shape", 'delta-receipt/v1\n{"baselineCommit":"zz"}\n'],
		["no body", "delta-receipt/v1"],
	])("fails closed on %s", (_n, text) => {
		expect(parseReceiptNote(text).ok).toBe(false);
	});

	it("packet hash ignores record order but not content", async () => {
		const r = receipt();
		expect(await hashContextPacket(r.accepted)).toBe(await hashContextPacket([...r.accepted].reverse()));
		const changed = r.accepted.map((e) => ({ ...e, version: e.version + 1 }));
		expect(await hashContextPacket(changed)).not.toBe(await hashContextPacket(r.accepted));
	});
});
