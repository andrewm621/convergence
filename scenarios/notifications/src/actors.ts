import type { Actor } from "contracts";

export const actors = {
	decisionOwner: { kind: "human", id: "decision-owner", displayName: "Decision owner (demo identity)" },
	agentA: { kind: "agent", id: "agent-a", displayName: "Agent A" },
	agentB: { kind: "agent", id: "agent-b", displayName: "Agent B" },
	seeded: { kind: "agent", id: "seed-agent", displayName: "Seeded agent" },
	delta: { kind: "system", id: "delta", displayName: "Delta Convergence" },
} satisfies Record<string, Actor>;
