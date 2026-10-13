// Turns Claude Code's `--output-format stream-json` into short activity lines for the console's live strip.
// Pure and defensive: unknown shapes are ignored, never thrown on. Tool results are skipped on purpose
// (they are long and may echo file contents); only tool calls, short text and the final result survive.

export interface Activity {
	kind: string;
	text: string;
}

const MAX_TEXT = 200;

const SECRET_PATTERNS: [RegExp, string][] = [
	[/\b[a-z]+_v\d+_[A-Za-z0-9_]{24,}(?:\?expires=\d+)?/g, "[redacted-token]"],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
	[/(https?:\/\/)[^/\s@]+@/g, "$1"],
	[/(\/\/)[0-9a-f]{32}(\.artifacts\.)/g, "$1<account>$2"],
];

export function redactLine(text: string): string {
	return SECRET_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

function clip(text: string, max = MAX_TEXT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One-line description of a tool call: the argument that says what it touches. */
function describeTool(name: string, input: unknown): string {
	const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const pick = ["file_path", "path", "command", "pattern", "url", "description"].find((k) => typeof args[k] === "string");
	return pick ? `${name}: ${clip(String(args[pick]), 120)}` : name;
}

/** `4 turns, $0.0123, 5200 in / 850 out tokens`, from whichever of those fields the result event carries. */
function describeUsage(e: {
	num_turns?: unknown;
	total_cost_usd?: unknown;
	usage?: { input_tokens?: unknown; output_tokens?: unknown };
}): string {
	const parts: string[] = [];
	if (typeof e.num_turns === "number") parts.push(`${e.num_turns} turns`);
	if (typeof e.total_cost_usd === "number") parts.push(`$${e.total_cost_usd.toFixed(4)}`);
	const { input_tokens: i, output_tokens: o } = e.usage ?? {};
	if (typeof i === "number" && typeof o === "number") parts.push(`${i} in / ${o} out tokens`);
	return parts.join(", ");
}

export function summarizeStreamLine(line: string): Activity[] {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return [];
	}
	if (!event || typeof event !== "object") return [];
	const e = event as {
		type?: unknown;
		subtype?: unknown;
		model?: unknown;
		message?: { content?: unknown };
		result?: unknown;
		is_error?: unknown;
		num_turns?: unknown;
		total_cost_usd?: unknown;
		usage?: { input_tokens?: unknown; output_tokens?: unknown };
	};

	const out: Activity[] = [];
	if (e.type === "system" && e.subtype === "init") {
		out.push({ kind: "agent", text: `claude session started${typeof e.model === "string" ? ` (${e.model})` : ""}` });
	} else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
		for (const block of e.message.content as unknown[]) {
			if (!block || typeof block !== "object") continue;
			const b = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
			if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "text", text: clip(b.text) });
			if (b.type === "tool_use" && typeof b.name === "string") out.push({ kind: "tool", text: describeTool(b.name, b.input) });
		}
	} else if (e.type === "result") {
		const text = typeof e.result === "string" && e.result.trim() ? clip(e.result) : String(e.subtype ?? "finished");
		out.push({ kind: e.is_error === true ? "error" : "result", text });
		const usage = describeUsage(e);
		if (usage) out.push({ kind: "usage", text: usage });
	}
	return out.map((a) => ({ kind: a.kind, text: redactLine(a.text) }));
}
