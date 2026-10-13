import type { Actor, ReasonCode, WorkItemStatus } from "contracts";
import {
	Bot,
	CheckCheck,
	CircleDashed,
	CircleSlash,
	Cpu,
	FlaskConical,
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
import { createContext, useContext } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "outline" | "primary" | "success" | "warning" | "danger" | "info" | "merged";

type StatusMeta = { label: string; tone: Tone; icon: typeof Play; description: string };

/**
 * The work-item chips. Every one is an icon plus a word: color helps, but never carries the
 * meaning alone.
 */
export const STATUS_META: Record<WorkItemStatus, StatusMeta> = {
	running: { label: "running", tone: "info", icon: Play, description: "The agent is working." },
	fresh: { label: "fresh", tone: "success", icon: ShieldCheck, description: "Built on the current decisions." },
	stale: { label: "stale", tone: "danger", icon: TriangleAlert, description: "Built on a decision that has since changed." },
	conflict: { label: "conflict", tone: "danger", icon: Swords, description: "Its claims or checks contradict an accepted decision." },
	revalidating: { label: "revalidating", tone: "info", icon: RefreshCw, description: "Re-running on the current decisions." },
	ready: { label: "ready", tone: "primary", icon: CheckCheck, description: "Cleared by the gate. A human decides whether to promote." },
	promoted: { label: "promoted", tone: "merged", icon: GitMerge, description: "Merged into the baseline." },
	uncertain: { label: "uncertain", tone: "warning", icon: HelpCircle, description: "Delta Convergence cannot tell: claims are missing or rely on something undeclared." },
	rejected: { label: "rejected", tone: "neutral", icon: CircleSlash, description: "A human rejected this work." },
};

/** True while the poller is degraded. Provided by the console; false anywhere else (tests, the mock). */
export const DegradedContext = createContext(false);

export function useDegraded(): boolean {
	return useContext(DegradedContext);
}

/**
 * What to show for a status. While the poller is degraded a work item that reads `fresh` cannot be
 * trusted (a baseline change may be sitting unread), so it is shown as `unconfirmed`, never Fresh.
 */
export function statusMeta(status: WorkItemStatus, degraded: boolean): StatusMeta {
	if (degraded && status === "fresh") {
		return { label: "unconfirmed", tone: "warning", icon: HelpCircle, description: "The poller is degraded, so Delta Convergence cannot confirm this is still built on the current decisions." };
	}
	return STATUS_META[status];
}

export function StatusChip({ status, className }: { status: WorkItemStatus; className?: string }) {
	const degraded = useDegraded();
	const meta = statusMeta(status, degraded);
	const Icon = meta.icon;
	return (
		<Badge tone={meta.tone} data-status={status} data-unconfirmed={degraded && status === "fresh" ? "" : undefined} title={meta.description} className={cn("font-semibold", className)}>
			<Icon className={cn(status === "revalidating" && "motion-safe:animate-spin")} aria-hidden />
			{meta.label}
		</Badge>
	);
}

const ACTOR_ICON = { human: User, agent: Bot, system: Cpu } as const;

export function ActorChip({ actor, className }: { actor: Pick<Actor, "kind" | "displayName">; className?: string }) {
	const Icon = ACTOR_ICON[actor.kind];
	return (
		<Badge tone={actor.kind === "human" ? "primary" : "outline"} data-actor={actor.kind} className={className}>
			<Icon aria-hidden />
			<span className="sr-only">{actor.kind}: </span>
			{actor.displayName}
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

export type EpistemicKind = "recorded" | "asserted" | "verified" | "awaiting";

/**
 * How much to trust a link in the Why chain. Accepted records and Resolutions are `recorded`;
 * an agent's claims are `agent-asserted, unverified`; Delta Convergence-run checks are `test-verified`;
 * anything nobody has decided reads `Awaiting human` and never wears a success badge.
 */
export const EPISTEMIC_META: Record<EpistemicKind, { text: string; tone: Tone; icon: typeof Lock; dashed: boolean; hint: string }> = {
	recorded: { text: "recorded", tone: "primary", icon: Lock, dashed: false, hint: "An accepted decision or a human resolution, on the ledger." },
	asserted: { text: "agent-asserted, unverified", tone: "warning", icon: Bot, dashed: true, hint: "The agent's own word. Delta Convergence has not checked it." },
	verified: { text: "test-verified", tone: "info", icon: FlaskConical, dashed: false, hint: "A check Delta Convergence ran itself at this head." },
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

export function ReasonChip({ code, className }: { code: ReasonCode | string; className?: string }) {
	return (
		<Badge tone="outline" className={cn("font-mono text-[11px] font-medium", className)} data-reason={code}>
			{code}
		</Badge>
	);
}

export function RunningDot({ label = "agent running" }: { label?: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs text-info">
			<Loader className="size-3 motion-safe:animate-spin" aria-hidden />
			{label}
		</span>
	);
}
