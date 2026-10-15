import { PUBLIC_READ_ONLY_NOTE } from "@/config";
import { scenarioMeta } from "@/features/scenario-meta";
import { useConsole } from "./console-context";

/** Why the action controls are off for this client (shown in their tooltip), or undefined when they are on. The public read-only view comes first. */
export function useReadOnlyReason(): string | undefined {
	const { client } = useConsole();
	return client.readOnly ? PUBLIC_READ_ONLY_NOTE : scenarioMeta(client.scenario, client.kind === "live").readOnlyReason;
}
