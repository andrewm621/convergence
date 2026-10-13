import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "isomorphic-git/http/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTES_REF, parseReceiptNote, serializeReceiptNote, type ContextReceipt } from "contracts";
import { pushNote, readNote } from "./git-note";
import { MemoryFS } from "./memory-fs";

// The receipt note's transport, against a real git server (`git http-backend` behind a local HTTP
// server), because the fake Artifacts cannot say whether a first note, a second note on top of it and a
// replacement all push as plain fast-forwards of refs/notes/delta. It cannot say whether the live
// Artifacts service accepts a push to a non-branch ref either; that is checked live.

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;
const WORKER = { name: "delta-convergence", email: "delta@example.invalid" };

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
}

function receipt(label: string): ContextReceipt {
	return {
		baselineCommit: "b".repeat(40),
		contextPacketHash: Buffer.from(label).toString("hex").padEnd(64, "0").slice(0, 64),
		accepted: [{ recordId: "notifications", version: 2, blobHash: "c".repeat(40), facetHash: "d".repeat(64) }],
		proposedVisible: [],
	};
}

/** Serve every bare repo under `root` over smart HTTP through git's own CGI. */
function serve(root: string): Promise<{ server: Server; base: string }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const url = new URL(req.url ?? "/", "http://localhost");
				const body = Buffer.concat(chunks);
				const child = spawn("git", ["http-backend"], {
					env: {
						PATH: process.env.PATH ?? "",
						GIT_PROJECT_ROOT: root,
						GIT_HTTP_EXPORT_ALL: "1",
						REQUEST_METHOD: req.method ?? "GET",
						PATH_INFO: url.pathname,
						QUERY_STRING: url.search.slice(1),
						CONTENT_TYPE: req.headers["content-type"] ?? "",
						CONTENT_LENGTH: String(body.length),
						REMOTE_USER: "x",
						REMOTE_ADDR: "127.0.0.1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_SYSTEM: "/dev/null",
					} as unknown as NodeJS.ProcessEnv,
				});
				const out: Buffer[] = [];
				child.stdout.on("data", (c: Buffer) => out.push(c));
				child.stdin.end(body);
				child.on("close", () => {
					const raw = Buffer.concat(out);
					const split = raw.indexOf("\r\n\r\n");
					const head = raw.subarray(0, split).toString("utf8").split("\r\n");
					const headers: Record<string, string> = {};
					let status = 200;
					for (const line of head) {
						const colon = line.indexOf(":");
						if (colon < 0) continue;
						const name = line.slice(0, colon).trim();
						const value = line.slice(colon + 1).trim();
						if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
						else headers[name] = value;
					}
					res.writeHead(status, headers);
					res.end(raw.subarray(split + 4));
				});
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
	});
}

describe.skipIf(!HAS_GIT)("pushNote against a real git server", () => {
	let dir: string;
	let server: Server;
	let remote: string;
	let first: string;
	let second: string;
	const bare = () => join(dir, "fork.git");

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "delta-note-"));
		git(dir, "init", "--bare", "--initial-branch=main", "fork.git");
		git(bare(), "config", "http.receivepack", "true");
		const work = join(dir, "work");
		git(dir, "init", "--initial-branch=main", work);
		git(work, "config", "user.name", "workitem-wi-2");
		git(work, "config", "user.email", "workitem-wi-2@delta.invalid");
		writeFileSync(join(work, "a.txt"), "a\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "first");
		first = git(work, "rev-parse", "HEAD");
		writeFileSync(join(work, "b.txt"), "b\n");
		git(work, "add", ".");
		git(work, "commit", "-m", "second");
		second = git(work, "rev-parse", "HEAD");
		git(work, "push", bare(), "main");
		const started = await serve(dir);
		server = started.server;
		remote = `${started.base}/fork.git`;
	});

	afterAll(async () => {
		await new Promise((resolve) => server?.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	});

	const onAuth = () => ({ username: "x", password: "unused" });
	const push = (commitSha: string, text: string) => pushNote({ fs: new MemoryFS(), http, remote, onAuth, commitSha, ref: NOTES_REF, text, author: WORKER });

	it("creates refs/notes/delta with the first note, readable by plain git, and leaves main alone", async () => {
		const text = serializeReceiptNote(receipt("one"));
		await push(first, text);
		expect(git(bare(), "notes", "--ref=delta", "show", first)).toBe(text.trim());
		expect(git(bare(), "rev-parse", "main")).toBe(second);
		const parsed = parseReceiptNote(`${git(bare(), "notes", "--ref=delta", "show", first)}\n`);
		expect(parsed.ok && parsed.receipt.contextPacketHash).toBe(receipt("one").contextPacketHash);
	});

	it("adds a second note on top of the first as a fast-forward (the fetch brings the ref in), keeping the first", async () => {
		const before = git(bare(), "rev-parse", NOTES_REF);
		const text = serializeReceiptNote(receipt("two"));
		const { noteCommit } = await push(second, text);
		expect(git(bare(), "rev-parse", NOTES_REF)).toBe(noteCommit);
		expect(git(bare(), "merge-base", "--is-ancestor", before, NOTES_REF) || "ancestor").toBe("ancestor");
		expect(git(bare(), "notes", "--ref=delta", "show", second)).toBe(text.trim());
		expect(git(bare(), "notes", "--ref=delta", "show", first)).toContain(receipt("one").contextPacketHash);
	});

	it("replaces a note already on the commit", async () => {
		const text = serializeReceiptNote(receipt("three"));
		await push(second, text);
		expect(git(bare(), "notes", "--ref=delta", "show", second)).toBe(text.trim());
		expect(git(bare(), "rev-parse", "main")).toBe(second);
	});

	it("reads back what it wrote in a local repo", async () => {
		const fs = new MemoryFS();
		await pushNote({ fs, http, remote, onAuth, commitSha: first, ref: NOTES_REF, text: serializeReceiptNote(receipt("four")), author: WORKER });
		expect(await readNote(fs, NOTES_REF, first)).toContain(receipt("four").contextPacketHash);
		expect(await readNote(fs, NOTES_REF, "e".repeat(40))).toBeNull();
	});
});
