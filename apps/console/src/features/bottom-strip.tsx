import type { AgentActivity } from "contracts";
import { verifyChain } from "delta-core";
import { Activity, AlertTriangle, Info, MessageSquareText, ShieldCheck, ShieldX, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ReasonChip } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { formatTime, shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConsole } from "@/state/console-context";
import { agentModelOf, summarizeLedgerLine } from "@/state/derive";

const KIND_META: Record<AgentActivity["kind"], { icon: typeof Terminal; label: string; className: string }> = {
	tool: { icon: Terminal, label: "tool", className: "text-muted-foreground" },
	text: { icon: MessageSquareText, label: "says", className: "text-foreground" },
	status: { icon: Info, label: "status", className: "text-info" },
	error: { icon: AlertTriangle, label: "error", className: "text-danger" },
};

export function BottomStrip() {
	return (
		<div className="grid h-[212px] shrink-0 grid-cols-2 divide-x border-t bg-card">
			<ActivityStream />
			<LedgerTail />
		</div>
	);
}

function StripHeader({ icon: Icon, title, children }: { icon: typeof Activity; title: string; children?: React.ReactNode }) {
	return (
		<div className="flex h-9 shrink-0 items-center gap-2 border-b px-4">
			<Icon className="size-3.5 text-muted-foreground" aria-hidden />
			<h2 className="text-xs font-semibold tracking-wide uppercase">{title}</h2>
			<div className="ml-auto flex items-center gap-2">{children}</div>
		</div>
	);
}

/** Live agent output, newest at the bottom. It sticks to the bottom unless you scroll up to read. */
function ActivityStream() {
	const { view, select } = useConsole();
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);

	useEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [view.activity.length]);

	return (
		<section aria-label="Agent activity" className="flex min-h-0 flex-col">
			<StripHeader icon={Activity} title="Agent activity">
				<span className="text-xs text-muted-foreground">{view.activity.length} lines</span>
			</StripHeader>
			<div
				ref={scroller}
				role="log"
				aria-live="off"
				className="min-h-0 flex-1 overflow-y-auto px-4 py-2 font-mono text-xs"
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
			>
				{view.activity.length === 0 ? (
					<p className="font-sans text-[13px] text-muted-foreground">No agent output yet. When agents run, their stream appears here.</p>
				) : (
					view.activity.map((line, index) => {
						const meta = KIND_META[line.kind];
						const Icon = meta.icon;
						const wi = view.workItems[line.workItemId];
						return (
							<div key={`${index}:${line.ts}:${line.text}`} className="row-in flex items-baseline gap-2 py-0.5 leading-5">
								<span className="shrink-0 text-muted-foreground tabular-nums">{formatTime(line.ts)}</span>
								<button type="button" onClick={() => select(line.workItemId)} className="shrink-0 rounded px-1 font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
									{line.workItemId}
								</button>
								{wi && <span className="shrink-0 text-muted-foreground">{agentModelOf(view.ledger, wi.item.id) ?? wi.item.actor.displayName}</span>}
								<Icon className={cn("size-3 shrink-0 translate-y-0.5", meta.className)} aria-hidden />
								<span className="sr-only">{meta.label}: </span>
								<span className={cn("min-w-0 break-words", meta.className)}>{line.text}</span>
							</div>
						);
					})
				)}
			</div>
		</section>
	);
}

type Chain = { state: "checking" } | { state: "ok"; length: number } | { state: "broken"; seq: number };

function useChainVerdict(): Chain {
	const { view } = useConsole();
	const [verdict, setVerdict] = useState<Chain>({ state: "checking" });
	const ledger = view.ledger;
	useEffect(() => {
		let cancelled = false;
		const first = ledger[0];
		if (!first) {
			setVerdict({ state: "ok", length: 0 });
			return;
		}
		verifyChain(ledger, { seq: first.seq - 1, hash: first.prevHash }).then((result) => {
			if (cancelled) return;
			setVerdict(result.ok ? { state: "ok", length: result.length } : { state: "broken", seq: result.brokenAtSeq });
		});
		return () => {
			cancelled = true;
		};
	}, [ledger]);
	return verdict;
}

/** The append-only, hash-chained ledger, newest first. The badge re-derives every hash in the browser. */
function LedgerTail() {
	const { view, select } = useConsole();
	const verdict = useChainVerdict();
	const lines = useMemo(() => [...view.ledger].reverse().slice(0, 60), [view.ledger]);

	return (
		<section aria-label="Ledger tail" className="flex min-h-0 flex-col">
			<StripHeader icon={ShieldCheck} title="Ledger">
				{verdict.state === "ok" && view.ledger.length > 0 && (
					<Badge tone="success" title="Every line's hash and its link to the previous line were re-derived in this browser." data-testid="chain-verified">
						<ShieldCheck aria-hidden /> chain verified · {verdict.length} lines
					</Badge>
				)}
				{verdict.state === "broken" && (
					<Badge tone="danger" data-testid="chain-broken">
						<ShieldX aria-hidden /> chain broken at #{verdict.seq}
					</Badge>
				)}
				{verdict.state === "checking" && <Badge tone="neutral">verifying</Badge>}
			</StripHeader>
			<ol className="min-h-0 flex-1 overflow-y-auto px-4 py-1.5" aria-label="Ledger lines">
				{lines.length === 0 ? (
					<li className="py-1 text-[13px] text-muted-foreground">The ledger is empty. Every observation and effect will be appended here, hash-chained.</li>
				) : (
					lines.map((entry) => {
						const summary = summarizeLedgerLine(entry);
						const shown = summary.reasonCodes.slice(0, 3);
						return (
							<li key={entry.seq} data-seq={entry.seq} data-type={entry.type} className="row-in flex items-center gap-2 py-[3px] text-xs leading-5">
								<span className="w-9 shrink-0 text-right font-mono text-muted-foreground tabular-nums">#{entry.seq}</span>
								<span className="shrink-0 text-muted-foreground tabular-nums">{formatTime(entry.ts)}</span>
								<span className="shrink-0 font-semibold" title={summary.hint}>
									{summary.label}
								</span>
								{summary.workItemId && (
									<button type="button" onClick={() => select(summary.workItemId)} className="shrink-0 rounded px-1 font-mono font-semibold outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50">
										{summary.workItemId}
									</button>
								)}
								<span className="min-w-0 truncate text-muted-foreground" title={summary.detail}>
									{summary.detail}
								</span>
								<span className="ml-auto flex shrink-0 items-center gap-1" title={summary.effectTypes.join(" · ")}>
									{summary.noAction && <ReasonChip code="NO_ACTION" className="px-1.5 py-0 text-[10.5px]" />}
									{shown.map((code) => (
										<ReasonChip key={code} code={code} className="px-1.5 py-0 text-[10.5px]" />
									))}
									{summary.reasonCodes.length > shown.length && <span className="text-muted-foreground">+{summary.reasonCodes.length - shown.length}</span>}
									<span className="w-14 text-right font-mono text-[10.5px] text-muted-foreground" title={entry.hash}>
										{shortHash(entry.hash, 7)}
									</span>
								</span>
							</li>
						);
					})
				)}
			</ol>
		</section>
	);
}
