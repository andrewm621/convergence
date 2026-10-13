import { describe, expect, it } from "vitest";
import { bearerFromRequest, sessionActor } from "./auth";

const req = (headers: Record<string, string>) => new Request("https://delta.test/api/x", { headers });
const b64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("bearerFromRequest", () => {
	it("reads Authorization: Bearer", () => {
		expect(bearerFromRequest(req({ Authorization: "Bearer s3cret" }))).toBe("s3cret");
	});

	it("reads the WebSocket subprotocol form a browser has to use", () => {
		expect(bearerFromRequest(req({ Upgrade: "websocket", "Sec-WebSocket-Protocol": `delta.v1, bearer.${b64url("pa ss/+word=")}` }))).toBe("pa ss/+word=");
	});

	it("ignores the subprotocol secret on anything that is not a WebSocket upgrade", () => {
		expect(bearerFromRequest(req({ "Sec-WebSocket-Protocol": `delta.v1, bearer.${b64url("s3cret")}` }))).toBe("");
	});

	it("returns an empty string for nothing, a wrong scheme or junk", () => {
		expect(bearerFromRequest(req({}))).toBe("");
		expect(bearerFromRequest(req({ Authorization: "Basic abc" }))).toBe("");
		expect(bearerFromRequest(req({ Upgrade: "websocket", "Sec-WebSocket-Protocol": "delta.v1, bearer.***" }))).toBe("");
	});
});

describe("sessionActor", () => {
	it("is the demo human for a bearer holder, from configuration", () => {
		expect(sessionActor({}, req({}))).toEqual({ ok: true, actor: { kind: "human", id: "decision-owner", displayName: "Decision owner (demo identity)" } });
		expect(sessionActor({ DEMO_ACTOR_ID: "pat", DEMO_ACTOR_NAME: "Pat" }, req({}))).toMatchObject({ ok: true, actor: { kind: "human", id: "pat", displayName: "Pat" } });
	});

	it("can only narrow the session to an agent or the system, never widen it", () => {
		expect(sessionActor({}, req({ "X-Delta-Principal": "agent:agent-b" }))).toMatchObject({ ok: true, actor: { kind: "agent", id: "agent-b" } });
		expect(sessionActor({}, req({ "X-Delta-Principal": "system:delta" }))).toMatchObject({ ok: true, actor: { kind: "system", id: "delta" } });
		// An agent that borrows the human's id is still an agent.
		expect(sessionActor({}, req({ "X-Delta-Principal": "agent:decision-owner" }))).toMatchObject({ ok: true, actor: { kind: "agent", id: "decision-owner" } });
		for (const bad of ["human:decision-owner", "agent:", "agent", "agent:a b", "decision-owner"]) {
			expect(sessionActor({}, req({ "X-Delta-Principal": bad })).ok, bad).toBe(false);
		}
	});
});
