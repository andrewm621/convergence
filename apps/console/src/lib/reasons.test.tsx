import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReasonChip } from "@/components/status";
import { GENERIC_REASON, REASON_META, reasonMeta } from "./reasons";

describe("reason codes in plain English", () => {
	it("explains every listed code in three short lines", () => {
		const codes = Object.keys(REASON_META);
		expect(codes.length).toBeGreaterThanOrEqual(15);
		for (const code of codes) {
			const meta = reasonMeta(code);
			for (const line of [meta.summary, meta.rule, meta.next]) {
				expect(line.length, code).toBeGreaterThan(0);
				expect(line, code).not.toMatch(/\n/);
			}
		}
	});

	it("never claims more than the engine knows: no \"uses\" or \"relies on\", and unknown is not waived for receipts", () => {
		for (const code of Object.keys(REASON_META)) {
			const { summary, rule, next } = reasonMeta(code);
			expect(`${summary} ${rule} ${next}`, code).not.toMatch(/\b(uses?|relies on|rely on|relied on)\b/i);
		}
		expect(reasonMeta("NO_DEPENDENCY_ON_CHANGED_FACETS").summary).toBe("No recorded dependency of this work changed.");
		expect(reasonMeta("UNKNOWN_CONTEXT_VERSION").rule).not.toMatch(/waived/);
	});

	it("falls back to a generic line for a code with no entry", () => {
		expect(reasonMeta("SOMETHING_NEW")).toBe(GENERIC_REASON);
	});

	it("puts the explanation on the chip as a tooltip and as its accessible description, and keeps the code on screen", () => {
		render(<ReasonChip code="STALE_RECEIPT" />);
		const chip = document.querySelector("[data-reason='STALE_RECEIPT']") as HTMLElement;
		expect(chip.firstChild?.textContent).toBe("STALE_RECEIPT");
		expect(chip.getAttribute("title")).toContain("built on an older version of a decision");
		const description = document.getElementById(chip.getAttribute("aria-describedby") ?? "");
		expect(description?.textContent).toBe(chip.getAttribute("title"));
		expect(screen.getByText("STALE_RECEIPT")).toBeInTheDocument();
	});

	it("still gives an unlisted code a tooltip", () => {
		render(<ReasonChip code="SOMETHING_NEW" />);
		expect(document.querySelector("[data-reason='SOMETHING_NEW']")?.getAttribute("title")).toContain(GENERIC_REASON.summary);
	});
});
