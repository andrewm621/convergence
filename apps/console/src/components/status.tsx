import type { Actor, ReasonCode, WorkItemStatus } from "contracts";
import {
	Bot,
	CheckCheck,
	CircleDashed,
	CircleSlash,
	Cpu,
	FlaskConical,
	Gavel,
	GitMerge,
	HelpCircle,
	Hourglass,
	Loader,
	Lock,
	Play,
	RefreshCw,
	ShieldCheck,
	TriangleAlert,
	User,
	Swords,
} from "lucide-react";
import { createContext, useContext, useId } from "react";
import { Badge } from "@/components/ui/badge";
import { CLAIMS_CHECK_HINT } from "@/lib/evidence";
import { reasonText } from "@/lib/reasons";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "outline" | "primary" | "success" | "warning" | "danger" | "info" | "merged";

type StatusMeta = { label: string; tone: Tone; icon: typeof Play; description: string };

/**
 * The work-item chips. Every one is an icon plus a word: color helps, but never carries the
 * meaning alone.
 */
export const STATUS_META: Record<WorkItemStatus, StatusMeta> = {
	running: { label: "Agent working", tone: "info", icon: Play, description: "The agent is working." },
	fresh: { label: "Up to date", tone: "success", icon: ShieldCheck, description: "Nothing it depends on has changed since it was built." },
	stale: { label: "Blocked", tone: "danger", icon: TriangleAlert, description: "Stale: built on a decision that has since changed. A changed decision is not a verdict on the work." },
	conflict: { label: "Blocked", tone: "danger", icon: Swords, description: "Conflict: its claims or checks contradict an accepted decision." },
	revalidating: { label: "revalidating", tone: "info", icon: RefreshCw, description: "Re-running on the current decisions." },
	ready: { label: "Ready to merge", tone: "primary", icon: CheckCheck, description: "Cleared by the merge check. A human decides whether to merge." },
	promoted: { label: "Merged", tone: "merged", icon: GitMerge, description: "Merged into the baseline." },
	uncertain: { label: "Held", tone: "warning", icon: HelpCircle, description: "Convergence cannot tell: claims are missing or rely on something undeclared." },
	rejected: { label: "rejected", tone: "neutral", icon: CircleSlash, description: "A human rejected this work." },
};

/** True while the poller is degraded. Provided by the console; false anywhere else (tests, the mock). */
export const DegradedContext = createContext(false);

export function useDegraded(): boolean {
	return useContext(DegradedContext);
}

/**
 * What to show for a status. `excepted`: ready only because an accepted exception lifts what would block it (rule R5), so it is
 * amber and reads differently from cleanly ready work. While the poller is degraded a work item that reads `fresh` or `ready` cannot be
 * trusted (a baseline change may be sitting unread; unknown is not unaffected), so it is shown as `unconfirmed`,
 * never Fresh and never "Cleared by the merge check".
 */
export function statusMeta(status: WorkItemStatus, degraded: boolean, leftAlone = false, excepted = false): StatusMeta {
	if (degraded && (status === "fresh" || status === "ready")) {
		return { label: "unconfirmed", tone: "warning", icon: HelpCircle, description: "The poller is degraded, so Convergence cannot confirm that no decision it depends on has changed." };
	}
	// Work with no recorded dependency on what changed stays green, even while its agent is still working. Never while the
	// poller is degraded: a baseline change may be sitting unread, and unknown is not unaffected.
	if (status === "running" && leftAlone && !degraded) {
		return { label: "Left alone", tone: "success", icon: ShieldCheck, description: "No recorded dependency on what the last decision change touched. Its agent is still working." };
	}
	if (status === "ready" && excepted) {
		return { label: "Ready · exception", tone: "warning", icon: Gavel, description: "Cleared by the merge check only because of an accepted exception. Something would block it without that exception. A human still decides whether to merge." };
	}
	return STATUS_META[status];
}

/**
 * `leftAlone`: the latest decision change was evaluated against this work and left it alone (rule R2).
 * `excepted`: the gate passes only through an accepted exception. `data-status` stays "ready"; `data-excepted` marks the difference.
 */
export function StatusChip({ status, leftAlone = false, excepted = false, className }: { status: WorkItemStatus; leftAlone?: boolean; excepted?: boolean; className?: string }) {
	const degraded = useDegraded();
	const meta = statusMeta(status, degraded, leftAlone, excepted);
	const Icon = meta.icon;
	return (
		<Badge
			tone={meta.tone}
			data-status={status}
			data-unconfirmed={meta.label === "unconfirmed" ? "" : undefined}
			data-excepted={meta.label === "Ready · exception" ? "" : undefined}
			title={meta.description}
			className={cn("font-semibold", className)}
		>
			<Icon className={cn(status === "revalidating" && "motion-safe:animate-spin")} aria-hidden />
			{meta.label}
		</Badge>
	);
}

const ACTOR_ICON = { human: User, agent: Bot, system: Cpu } as const;

/** An agent named only by a letter ("Agent B") means nothing on screen: nothing defines it, and the work's title already says what it is. */
const LETTERED_AGENT = /^Agent [A-Z]$/;

/** `label` replaces the display name, e.g. with the model that runs an agent. The actor kind stays in the screen-reader text. */
export function ActorChip({ actor, label, className }: { actor: Pick<Actor, "kind" | "displayName">; label?: string; className?: string }) {
	const Icon = ACTOR_ICON[actor.kind];
	return (
		<Badge tone={actor.kind === "human" ? "primary" : "outline"} data-actor={actor.kind} className={className}>
			<Icon aria-hidden />
			<span className="sr-only">{actor.kind}: </span>
			{label ?? (LETTERED_AGENT.test(actor.displayName) ? "Agent" : actor.displayName)}
		</Badge>
	);
}

/** Synthetic work for the fan-out beat is always labelled. */
export function SeededBadge({ className }: { className?: string }) {
	return (
		<Badge tone="outline" dashed className={cn("uppercase tracking-wide", className)} title="Synthetic work item. No model is behind it.">
			<CircleDashed aria-hidden />
			seeded
		</Badge>
	);
}

export type EpistemicKind = "recorded" | "asserted" | "verified" | "claims-checked" | "awaiting";

/**
 * How much to trust a link in the Why chain. Accepted records and Resolutions are `recorded`;
 * an agent's claims are `agent-asserted, unverified`; Convergence-run checks are `test-verified`;
 * anything nobody has decided reads `Awaiting human` and never wears a success badge.
 */
export const EPISTEMIC_META: Record<EpistemicKind, { text: string; tone: Tone; icon: typeof Lock; dashed: boolean; hint: string }> = {
	recorded: { text: "recorded", tone: "primary", icon: Lock, dashed: false, hint: "An accepted decision or a human sign-off, in the audit log." },
	asserted: { text: "agent-asserted, unverified", tone: "warning", icon: Bot, dashed: true, hint: "The agent's own word. Convergence has not checked it." },
	verified: { text: "test-verified", tone: "info", icon: FlaskConical, dashed: false, hint: "A check Convergence ran itself at this head." },
	"claims-checked": { text: "claims-checked, not tested", tone: "info", icon: ShieldCheck, dashed: true, hint: CLAIMS_CHECK_HINT },
	awaiting: { text: "Awaiting human", tone: "neutral", icon: Hourglass, dashed: true, hint: "Nobody has decided this yet." },
};

export function EpistemicChip({ kind, className }: { kind: EpistemicKind; className?: string }) {
	const meta = EPISTEMIC_META[kind];
	const Icon = meta.icon;
	return (
		<Badge tone={meta.tone} dashed={meta.dashed} data-epistemic={kind} title={meta.hint} className={className}>
			<Icon aria-hidden />
			{meta.text}
		</Badge>
	);
}

/** The code stays on screen (it is searchable); its tooltip says what it means, the rule behind it, and what to do next. */
export function ReasonChip({ code, className }: { code: ReasonCode | string; className?: string }) {
	const describedBy = useId();
	const text = reasonText(code);
	return (
		<Badge tone="outline" className={cn("font-mono text-[11px] font-medium", className)} data-reason={code} title={text} aria-describedby={describedBy}>
			{code}
			<span id={describedBy} className="sr-only">
				{text}
			</span>
		</Badge>
	);
}

export function RunningDot({ label = "Agent working" }: { label?: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-info">
			<Loader className="size-3 motion-safe:animate-spin" aria-hidden />
			{label}
		</span>
	);
}
