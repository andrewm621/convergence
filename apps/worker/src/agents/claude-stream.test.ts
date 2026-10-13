import { describe, expect, it } from "vitest";
import { redactLine, summarizeStreamLine } from "../../container/claude-stream-lib";

const line = (o: object) => JSON.stringify(o);

describe("summarizeStreamLine", () => {
	it("reports the session start", () => {
		expect(summarizeStreamLine(line({ type: "system", subtype: "init", model: "anthropic/claude-sonnet-5.5" }))).toEqual([
			{ kind: "agent", text: "claude session started (anthropic/claude-sonnet-5.5)" },
		]);
	});

	it("summarizes short text and tool calls from an assistant message", () => {
		const out = summarizeStreamLine(
			line({
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "Reading the   context\nfiles." },
						{ type: "tool_use", name: "Read", input: { file_path: "/workspace/repo/.delta/context/notifications.md" } },
						{ type: "tool_use", name: "Bash", input: { command: "ls -la", description: "list" } },
						{ type: "tool_use", name: "Noop", input: {} },
					],
				},
			}),
		);
		expect(out).toEqual([
			{ kind: "text", text: "Reading the context files." },
			{ kind: "tool", text: "Read: /workspace/repo/.delta/context/notifications.md" },
			{ kind: "tool", text: "Bash: ls -la" },
			{ kind: "tool", text: "Noop" },
		]);
	});

	it("clips long text", () => {
		const [a] = summarizeStreamLine(line({ type: "assistant", message: { content: [{ type: "text", text: "w".repeat(1000) }] } }));
		expect(a?.text.length).toBeLessThanOrEqual(200);
	});

	it("skips tool results (long, may echo file contents)", () => {
		expect(summarizeStreamLine(line({ type: "user", message: { content: [{ type: "tool_result", content: "secret file body" }] } }))).toEqual([]);
	});

	it("reports the final result and marks errors", () => {
		expect(summarizeStreamLine(line({ type: "result", subtype: "success", is_error: false, result: "Done." }))).toEqual([{ kind: "result", text: "Done." }]);
		expect(summarizeStreamLine(line({ type: "result", subtype: "error_max_turns", is_error: true }))).toEqual([{ kind: "error", text: "error_max_turns" }]);
	});

	it("adds a usage line with turns, cost and tokens when the result event has them", () => {
		const out = summarizeStreamLine(
			line({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 4, total_cost_usd: 0.01234, usage: { input_tokens: 5200, output_tokens: 850 } }),
		);
		expect(out).toEqual([
			{ kind: "result", text: "Done." },
			{ kind: "usage", text: "4 turns, $0.0123, 5200 in / 850 out tokens" },
		]);
	});

	it("ignores junk and unknown shapes without throwing", () => {
		for (const bad of ["", "not json", "null", "[]", line({ type: "assistant", message: { content: "str" } }), line({ type: "mystery" })]) {
			expect(summarizeStreamLine(bad)).toEqual([]);
		}
	});

	it("redacts tokens, keys, bearer values, URL credentials and the account host label", () => {
		const token = ["art", "v2", "x"].join("_") + "_" + "A1b2C3d4E5".repeat(4);
		const text = `push to https://u:p@${"a1".repeat(16)}.artifacts.cloudflare.net/x with ${token}?expires=1 and sk-or-v1-abcdefghijklmnop and Bearer abcdefghijkl`;
		const out = redactLine(text);
		expect(out).not.toContain(token);
		expect(out).not.toContain("u:p@");
		expect(out).not.toContain("a1".repeat(16));
		expect(out).not.toContain("sk-or-v1-abcdefghijklmnop");
		expect(out).not.toContain("abcdefghijkl");
		const [a] = summarizeStreamLine(line({ type: "assistant", message: { content: [{ type: "text", text: `key ${token}` }] } }));
		expect(a?.text).not.toContain(token);
	});
});
