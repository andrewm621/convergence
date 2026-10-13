import { canonicalJson } from "./canonical";

const encoder = new TextEncoder();

/** SHA-256 as lowercase hex. WebCrypto only, so it behaves the same in Node and in Workers. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** Hash of a value's canonical JSON form. */
export async function hashCanonical(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}
