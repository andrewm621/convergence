import { describeInvariants } from "./testing/invariants";
import { invariantScenarios, stores } from "./testing/scenarios";

for (const [label, makeStore] of stores) describeInvariants(label, makeStore, invariantScenarios);
