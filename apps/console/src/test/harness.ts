import { WsMessage } from "contracts";
import type { ConsoleMessage } from "@/client/types";
import { createMockClient, type MockClient, type MockOptions } from "@/mock/client";
import { initialViewState, viewReducer, type ViewState } from "@/state/store";

/** A mock client wired to a plain reducer, no React: for testing the data path on its own. */
export async function startMock(options: Partial<MockOptions> = {}) {
	const client = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null, ...options });
	let view: ViewState = initialViewState;
	const messages: ConsoleMessage[] = [];
	const stop = client.connect({
		onConnection() {},
		onMessage(message) {
			messages.push(message);
			view = viewReducer(view, { type: "message", message });
		},
	});
	await waitFor(() => client.controls.getState().ready);

	return {
		client,
		messages,
		stop,
		get view() {
			return view;
		},
		get beats() {
			return client.controls.getState().beats;
		},
		async next(count = 1) {
			for (let i = 0; i < count; i++) {
				await client.controls.next();
				await waitFor(() => !client.controls.getState().busy);
			}
		},
		async jump(to: number) {
			await client.controls.jump(to);
			await waitFor(() => !client.controls.getState().busy);
		},
		async prev() {
			await client.controls.prev();
			await waitFor(() => !client.controls.getState().busy);
		},
		status(id: string) {
			return view.workItems[id]?.item.status;
		},
	};
}

export async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Every message the mock sends must be a valid `WsMessage` once the optional `meta` side-channel is removed. */
export function assertContractMessages(messages: ConsoleMessage[]) {
	for (const message of messages) {
		const { meta: _meta, ...rest } = message as ConsoleMessage & { meta?: unknown };
		void _meta;
		const parsed = WsMessage.safeParse(rest);
		if (!parsed.success) throw new Error(`mock sent a message that is not a WsMessage: ${parsed.error.message}`);
	}
}

export type { MockClient };
