import { render, waitFor as rtlWaitFor, type RenderResult } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { expect } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createMockClient, type MockClient, type MockOptions } from "@/mock/client";
import { ConsoleProvider, useConsole } from "@/state/console-context";

export type MockHarness = RenderResult & { client: MockClient };

/** Render part of the console against the mock, which runs the real reconciler. */
export async function renderWithMock(ui: ReactElement, options: Partial<MockOptions> & { beats?: number; select?: string } = {}): Promise<MockHarness> {
	const { beats = 0, select, ...mockOptions } = options;
	const client = createMockClient({ scenario: "notifications", drip: false, promoteDelayMs: 0, rerunDelayMs: null, ...mockOptions });
	const result = render(
		<TooltipProvider delayDuration={0}>
			<ConsoleProvider client={client} flushMs={1}>
				<SelectOnReady id={select} />
				{ui}
			</ConsoleProvider>
		</TooltipProvider>,
	);
	await rtlWaitFor(() => expect(client.controls.getState().ready).toBe(true));
	if (beats > 0) await client.controls.jump(beats);
	await rtlWaitFor(() => expect(client.controls.getState().busy).toBe(false));
	return Object.assign(result, { client });
}

function SelectOnReady({ id }: { id: string | undefined }) {
	const { select, selectedId, view } = useConsole();
	useEffect(() => {
		if (id && selectedId !== id && view.workItems[id]) select(id);
	}, [id, selectedId, view.workItems, select]);
	return null;
}
