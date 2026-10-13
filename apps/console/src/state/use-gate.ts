import { useEffect, useState } from "react";
import type { GateResult } from "@/client/types";
import { useConsole } from "./console-context";

export type GateState = {
	gate: GateResult | null;
	/** A read is in flight; the previous result stays on screen meanwhile. */
	loading: boolean;
	error: string | null;
	/** Which work item the result belongs to. */
	forId: string | null;
};

/**
 * The promotion gate's dry run for one work item (`GET /work-items/:id/gate`). It re-runs
 * whenever that item, the baseline or the accepted context changes, so the preview in the
 * inspector never shows a verdict for a world that has moved.
 */
export function useGate(workItemId: string | null): GateState {
	const { client, view } = useConsole();
	const item = workItemId ? view.workItems[workItemId] : undefined;
	const [state, setState] = useState<GateState>({ gate: null, loading: false, error: null, forId: null });

	useEffect(() => {
		if (!workItemId || !item) {
			setState({ gate: null, loading: false, error: null, forId: null });
			return;
		}
		let cancelled = false;
		setState((current) => ({ ...current, loading: true, forId: workItemId, gate: current.forId === workItemId ? current.gate : null }));
		client.api
			.gate(workItemId)
			.then((gate) => {
				if (!cancelled) setState({ gate, loading: false, error: null, forId: workItemId });
			})
			.catch((error: unknown) => {
				if (!cancelled) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "The gate could not be read." }));
			});
		return () => {
			cancelled = true;
		};
		// `item` is the work item's state object: it changes whenever the server says it changed.
	}, [client, workItemId, item, view.baselineCommit, view.snapshotHash]);

	return state;
}
