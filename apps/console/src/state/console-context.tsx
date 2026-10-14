import type { FacetValue, WorkItemState } from "contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { ConnectionState, ConsoleClient, ConsoleMessage } from "@/client/types";
import { DegradedContext } from "@/components/status";
import { initialViewState, isDegraded, viewReducer, type ViewState } from "./store";

export type Toast = { id: number; tone: "success" | "danger" | "info"; text: string };

/** The editor can be opened with a draft, e.g. by the mock's "Draft the decision change" beat. */
export type EditorRequest = { recordId: string; facets: Record<string, FacetValue>; prose: string; rationale: string; nonce: number };

export type InspectorTab = "why" | "receipt" | "semantic" | "changes" | "actions";

/** The new shell's two views: Work (home trays and item pages) and Map (the work graph with the side pane). */
export type ViewMode = "work" | "map";

type ConsoleContextValue = {
	client: ConsoleClient;
	view: ViewState;
	connection: ConnectionState;
	selectedId: string | null;
	select(id: string | null): void;
	tab: InspectorTab;
	setTab(tab: InspectorTab): void;
	mode: ViewMode;
	setMode(mode: ViewMode): void;
	editorRequest: EditorRequest | null;
	requestEditor(request: Omit<EditorRequest, "nonce"> | null): void;
	toasts: Toast[];
	notify(tone: Toast["tone"], text: string): void;
	/** Call when this browser sends a context change. The next evaluation to arrive is timed from here. */
	markChangeSent(): void;
	/** Call if that change was refused, so a later unrelated change is not timed against it. */
	clearChangeSent(): void;
	/** Time from sending a context change to its evaluation arriving here, measured in this browser. */
	observed: ObservedEvaluation | null;
};

/** `ms` is client-measured: sent to verdict on screen, so it includes the network and the poller. */
export type ObservedEvaluation = { seq: number; ms: number };

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

/** Live cells have a couple of agents; a seeded fan-out has none worth asking the Worker about. */
const MAX_RUN_READS = 12;

/** Changes when a live work item's fork head moves or its re-run ends, and on the first snapshot. */
export function agentRunsKey(workItems: Record<string, WorkItemState>): string {
	const parts = Object.values(workItems)
		.filter((wi) => wi.item.source === "live")
		.map((wi) => `${wi.item.id}@${wi.item.forkRepo}@${wi.headSha ?? ""}@${wi.revalidating ? "run" : ""}`)
		.sort();
	return parts.length > 0 ? parts.join("|") : "";
}

export function useConsole(): ConsoleContextValue {
	const value = useContext(ConsoleContext);
	if (!value) throw new Error("useConsole must be used inside <ConsoleProvider>");
	return value;
}

export function ConsoleProvider({ client, children, flushMs = 24 }: { client: ConsoleClient; children: ReactNode; flushMs?: number }) {
	const [view, dispatch] = useReducer(viewReducer, initialViewState);
	const [connection, setConnection] = useState<ConnectionState>("connecting");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [tab, setTab] = useState<InspectorTab>("why");
	const [mode, setMode] = useState<ViewMode>("work");
	const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [observed, setObserved] = useState<ObservedEvaluation | null>(null);
	const sentAt = useRef<number | null>(null);
	const nextId = useRef(1);

	// Messages that arrive in the same moment (a fan-out registers forty items) render once.
	useEffect(() => {
		dispatch({ type: "reset" });
		setSelectedId(null);
		setObserved(null);
		sentAt.current = null;
		let queue: ConsoleMessage[] = [];
		let timer: ReturnType<typeof setTimeout> | null = null;
		const flush = () => {
			timer = null;
			const batch = queue;
			queue = [];
			for (const message of batch) dispatch({ type: "message", message });
		};
		const stop = client.connect({
			onMessage(message) {
				// The first baseline push with a record after this browser sent a change is that change's verdict.
				const pushed = message.type === "event" ? message.event.payload.event : null;
				if (sentAt.current !== null && message.type === "event" && pushed?.type === "BaselinePushed" && pushed.records.length > 0) {
					setObserved({ seq: message.event.seq, ms: performance.now() - sentAt.current });
					sentAt.current = null;
				}
				queue.push(message);
				if (timer === null) timer = setTimeout(flush, flushMs);
			},
			onConnection: setConnection,
		});
		return () => {
			stop();
			if (timer !== null) clearTimeout(timer);
		};
	}, [client, flushMs]);

	// A change the event stream does not fully describe: ask for a fresh snapshot.
	useEffect(() => {
		if (view.needsResync) void client.refresh().catch(() => undefined);
	}, [view.needsResync, client]);

	// Agents that ran before this console opened left their stream and model with the Worker, not on the socket. Read
	// them once the state is in, and again only when a fork's head moves (a push) or a re-run ends: not on every event.
	const runsKey = client.kind === "live" && view.ready ? agentRunsKey(view.workItems) : "";
	useEffect(() => {
		if (!runsKey) return;
		const items = Object.values(view.workItems)
			.filter((wi) => wi.item.source === "live")
			.slice(0, MAX_RUN_READS)
			.map((wi) => ({ id: wi.item.id, forkRepo: wi.item.forkRepo }));
		let cancelled = false;
		client.api
			.agentRuns(items)
			.then((runs) => {
				if (!cancelled) dispatch({ type: "agent-runs", runs });
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
		// `view.workItems` is read through `runsKey`, which changes exactly when the answer could.
	}, [runsKey, client]);

	const notify = useCallback((tone: Toast["tone"], text: string) => {
		const id = nextId.current++;
		setToasts((current) => [...current.slice(-3), { id, tone, text }]);
		setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000);
	}, []);

	const requestEditor = useCallback((request: Omit<EditorRequest, "nonce"> | null) => {
		setEditorRequest(request ? { ...request, nonce: nextId.current++ } : null);
	}, []);

	const markChangeSent = useCallback(() => {
		sentAt.current = performance.now();
	}, []);
	const clearChangeSent = useCallback(() => {
		sentAt.current = null;
	}, []);

	const select = useCallback((id: string | null) => setSelectedId(id), []);

	const value = useMemo<ConsoleContextValue>(
		() => ({ client, view, connection, selectedId, select, tab, setTab, mode, setMode, editorRequest, requestEditor, toasts, notify, markChangeSent, clearChangeSent, observed }),
		[client, view, connection, selectedId, select, tab, mode, editorRequest, requestEditor, toasts, notify, markChangeSent, clearChangeSent, observed],
	);
	return (
		<ConsoleContext.Provider value={value}>
			<DegradedContext.Provider value={isDegraded(view)}>{children}</DegradedContext.Provider>
		</ConsoleContext.Provider>
	);
}
