import type { FacetValue } from "contracts";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { ConnectionState, ConsoleClient, ConsoleMessage } from "@/client/types";
import { DegradedContext } from "@/components/status";
import { initialViewState, isDegraded, viewReducer, type ViewState } from "./store";

export type Toast = { id: number; tone: "success" | "danger" | "info"; text: string };

/** The editor can be opened with a draft, e.g. by the mock's "Draft the decision change" beat. */
export type EditorRequest = { recordId: string; facets: Record<string, FacetValue>; prose: string; rationale: string; nonce: number };

export type InspectorTab = "why" | "receipt" | "semantic" | "changes" | "actions";

type ConsoleContextValue = {
	client: ConsoleClient;
	view: ViewState;
	connection: ConnectionState;
	selectedId: string | null;
	select(id: string | null): void;
	tab: InspectorTab;
	setTab(tab: InspectorTab): void;
	editorRequest: EditorRequest | null;
	requestEditor(request: Omit<EditorRequest, "nonce"> | null): void;
	toasts: Toast[];
	notify(tone: Toast["tone"], text: string): void;
};

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

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
	const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const nextId = useRef(1);

	// Messages that arrive in the same moment (a fan-out registers forty items) render once.
	useEffect(() => {
		dispatch({ type: "reset" });
		setSelectedId(null);
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

	const notify = useCallback((tone: Toast["tone"], text: string) => {
		const id = nextId.current++;
		setToasts((current) => [...current.slice(-3), { id, tone, text }]);
		setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000);
	}, []);

	const requestEditor = useCallback((request: Omit<EditorRequest, "nonce"> | null) => {
		setEditorRequest(request ? { ...request, nonce: nextId.current++ } : null);
	}, []);

	const select = useCallback((id: string | null) => setSelectedId(id), []);

	const value = useMemo<ConsoleContextValue>(
		() => ({ client, view, connection, selectedId, select, tab, setTab, editorRequest, requestEditor, toasts, notify }),
		[client, view, connection, selectedId, select, tab, editorRequest, requestEditor, toasts, notify],
	);
	return (
		<ConsoleContext.Provider value={value}>
			<DegradedContext.Provider value={isDegraded(view)}>{children}</DegradedContext.Provider>
		</ConsoleContext.Provider>
	);
}
