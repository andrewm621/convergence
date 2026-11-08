import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, ChevronDown, CircleAlert, CircleCheck, Clock3, FileText, History, Info, ListTodo, X } from "lucide-react";
import type { ReconciliationEvent, RecordSnapshot, WorkItemState } from "contracts";
import { SCENARIOS, type ScenarioName } from "@/client/types";
import type { MockClient } from "@/mock/client";
import { useConsole } from "@/state/console-context";
import type { ViewState } from "@/state/store";
import { acceptedDecisionChanges, calmWorkGroups, calmWorkItem, humanFacet, humanValue, isOutOfDate, type CalmWork } from "./model";
import "./calm.css";

type Section = "work" | "decisions" | "activity";
type InspectorTab = "why" | "sources" | "technical";

const SCENARIO_NAMES: Record<ScenarioName, string> = {
  notifications: "Notifications example",
  "shelter-intake": "Shelter example",
  "sales-ops": "Sales operations example",
  "delta-convergence-build": "Convergence build",
};

function fallbackDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Keep actions in the original console until the separate authorization and sidecar PRs ship. */
export function existingConsoleHref(search: string): string {
  const params = new URLSearchParams(search);
  params.set("ui", "new");
  return `?${params.toString()}`;
}

function ReadOnlyNote({ isMock }: { isMock: boolean }) {
  return <p className="calm-read-note"><Info size={15} aria-hidden="true" /> {isMock ? "Demo data, read-only preview. No real work starts or changes." : "Read-only preview. Nothing here submits a review or changes your project."}</p>;
}

function workActor(wi: WorkItemState): string {
  return wi.item.source === "seeded"
    ? "Synthetic work item, no agent"
    : `${wi.item.actor.displayName || wi.item.actor.id} · ${wi.item.actor.kind === "agent" ? "AI agent" : wi.item.actor.kind}`;
}

function WorkRow({ item, onOpen }: { item: CalmWork; onOpen: () => void }) {
  return (
    <li className="calm-item">
      <button className="calm-row" type="button" onClick={onOpen} aria-label={`Open ${item.wi.item.title}`} data-testid={`calm-row-${item.wi.item.id}`}>
        <div className="calm-row-icon" aria-hidden="true">{item.tone === "attention" ? <CircleAlert /> : item.group === "finished" ? <CircleCheck /> : <Clock3 />}</div>
        <div className="calm-row-main">
          <div className="calm-row-title">{item.wi.item.title}</div>
          <p>{item.explanation}</p>
          <div className="calm-meta">{workActor(item.wi)}<span aria-hidden="true">·</span>{item.wi.item.id}</div>
        </div>
        <span className={`calm-state calm-state-${item.tone}`}>{item.label}</span>
        <span className="calm-arrow" aria-hidden="true">›</span>
      </button>
    </li>
  );
}

function GroupList({ title, items, onOpen, secondary = false, defaultOpen = false }: {
  title: string; items: CalmWork[]; onOpen: (id: string) => void; secondary?: boolean; defaultOpen?: boolean;
}) {
  if (!items.length && secondary) return null;
  if (!secondary) return (
    <section aria-label={title} className="calm-section">
      <div className="calm-section-head"><h2>{title}</h2><span>{items.length}</span></div>
      {items.length
        ? <ul className="calm-list">{items.map((item) => <WorkRow key={item.wi.item.id} item={item} onOpen={() => onOpen(item.wi.item.id)} />)}</ul>
        : <div className="calm-empty">Nothing needs team review in the latest recorded state.</div>}
    </section>
  );
  return (
    <details className="calm-secondary-group" open={defaultOpen}>
      <summary><span>{title} <span className="calm-count">{items.length}</span></span><ChevronDown size={17} aria-hidden="true" /></summary>
      <ul className="calm-list">{items.map((item) => <WorkRow key={item.wi.item.id} item={item} onOpen={() => onOpen(item.wi.item.id)} />)}</ul>
    </details>
  );
}

export function CalmInbox({ view, onOpen }: { view: ViewState; onOpen: (id: string) => void }) {
  const buckets = calmWorkGroups(view);
  return (
    <div data-testid="calm-inbox" className="calm-stack">
      <div className="calm-page-head">
        <p className="calm-overline">PROJECT WORK</p>
        <h1>Work</h1>
        <p>{buckets.review.length > 0
          ? `${buckets.review.length} item${buckets.review.length === 1 ? "" : "s"} need${buckets.review.length === 1 ? "s" : ""} team review.`
          : "No recorded items need team review right now."}</p>
      </div>
      {isOutOfDate(view) && <div role="status" className="calm-warning"><CircleAlert size={17} aria-hidden="true" /> Project updates are delayed. These statuses may not reflect the latest changes.</div>}
      <GroupList title="Needs team review" items={buckets.review} onOpen={onOpen} />
      <GroupList title="Moving along" items={buckets.moving} onOpen={onOpen} secondary />
      <GroupList title="Finished" items={buckets.finished} onOpen={onOpen} secondary />
      {Object.keys(view.workItems).length === 0 && <p className="calm-help">No work has been registered in this project yet. This read-only preview does not start agents or create work items.</p>}
      <p className="calm-help">Personal assignments are not available in the current Convergence protocol. This is a team queue, not an inbox assigned to your account.</p>
    </div>
  );
}

function SourceList({ wi, view }: { wi: WorkItemState; view: ViewState }) {
  const changes = acceptedDecisionChanges(view, wi);
  return (
    <div className="calm-stack-small">
      <p>These details come from recorded project decisions and accepted work relationships, not an AI explanation.</p>
      {changes.length > 0
        ? changes.map((change) => (
          <div className="calm-source-row" key={change.recordId + ":" + change.facetKey}>
            <strong>{humanFacet(change.facetKey)}</strong>
            <p>{change.recordId}, version {change.fromVersion} → version {change.toVersion}</p>
            <p>{humanValue(change.before)} → {humanValue(change.after)}</p>
          </div>
        ))
        : <p>No changed accepted decision facets can be shown for this item from the current snapshot.</p>}
      <h3>Recorded context at registration or revalidation</h3>
      {wi.receipt.accepted.length
        ? <ul className="calm-simple-list">{wi.receipt.accepted.map((entry) => (
          <li key={entry.recordId}>{entry.recordId} · version {entry.version}</li>
        ))}</ul>
        : <p>No accepted decisions were listed in the recorded context.</p>}
      <p className="calm-small-note">A receipt records a versioned basis. Initial registration alone is not evidence that a running agent received, read, or followed the material.</p>
    </div>
  );
}

function TechnicalDetails({ wi, view }: { wi: WorkItemState; view: ViewState }) {
  const deps = view.dependencies.filter((d) => d.workItemId === wi.item.id);
  return (
    <div className="calm-stack-small">
      <p>Protocol v0.1 values shown without modification. Only accepted dependencies govern the existing reconciliation rules.</p>
      <dl className="calm-kv">
        <dt>Work item</dt><dd>{wi.item.id}</dd>
        <dt>Normative status</dt><dd>{wi.item.status}</dd>
        <dt>Repository fork</dt><dd>{wi.item.forkRepo}</dd>
        <dt>Latest observed fork head</dt><dd className="calm-mono">{wi.headSha ?? "Not yet observed"}</dd>
        <dt>Receipt baseline</dt><dd className="calm-mono">{wi.receipt.baselineCommit}</dd>
        <dt>Context packet hash</dt><dd className="calm-mono">{wi.receipt.contextPacketHash}</dd>
        <dt>Ledger head</dt><dd>{view.ledgerHead.seq}</dd>
        <dt>Poller</dt><dd>{isOutOfDate(view) ? "Behind or needs resync" : view.poller ? "Reported healthy" : "Health not reported"}</dd>
      </dl>
      <h3>Recorded dependencies</h3>
      {deps.length ? <ul className="calm-simple-list">{deps.map((dep, index) => (
        <li key={index}><span className="calm-mono">{dep.recordId}</span> · {dep.status} · {dep.facetKeys.length ? dep.facetKeys.join(", ") : "whole record"} · {dep.basis}</li>
      ))}</ul> : <p>No declared, accepted, or proposed dependency records are available.</p>}
      <h3>Checks and claims</h3>
      {wi.evidence.length ? <ul className="calm-simple-list">{wi.evidence.map((e, index) => (
        <li key={index}>{e.check} · {e.pass ? "passed" : "failed"} · {e.kind === "delta-claims-check" ? "claims comparison, not a test" : e.kind ?? "recorded check"} · head {e.headSha.slice(0, 10)}</li>
      ))}</ul> : <p>No check results recorded for this item.</p>}
      <p className="calm-small-note">Agent claims are self-reported. A claims comparison is not equivalent to an independently executed test. No action or merge can be approved from this view.</p>
    </div>
  );
}

function PlainWhy({ item, view }: { item: CalmWork; view: ViewState }) {
  const wi = item.wi;
  return (
    <div className="calm-stack-small">
      <h3>{item.label}</h3><p>{item.explanation}</p>
      {item.changes.length > 0 && <p>We can show the specific recorded decision settings that changed below. The system cannot infer how well an agent understood them.</p>}
      {item.changes.map((change) => (
        <div className="calm-source-row" key={change.recordId + ":" + change.facetKey}>
          <strong>{humanFacet(change.facetKey)}</strong>
          <div className="calm-inspector-compare"><span>Earlier: {humanValue(change.before)}</span><span>Current: {humanValue(change.after)}</span></div>
        </div>
      ))}
      {isOutOfDate(view) && <div className="calm-warning">The project monitor is behind. Treat this explanation as potentially out of date until the stream catches up.</div>}
      <p className="calm-small-note">{wi.item.status === "ready"
        ? "Recorded Ready is not an automatic merge. A human must request promotion and the server checks freshness at the current heads again."
        : wi.item.status === "stale"
          ? "Changed decisions do not prove the code is wrong. A human must choose how to resolve the mismatch."
          : "This view explains recorded status only. It does not submit decisions, override checks, or merge code."}</p>
    </div>
  );
}

export function CalmInspector({ view, item, onClose }: { view: ViewState; item: CalmWork; onClose: () => void }) {
  const [tab, setTab] = useState<InspectorTab>("why");
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
      if (nodes.length === 0) return;
      const first = nodes[0]!, last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previouslyFocused?.focus(); };
  }, [onClose]);

  const panels: Record<InspectorTab, ReactNode> = {
    why: <PlainWhy item={item} view={view} />,
    sources: <SourceList wi={item.wi} view={view} />,
    technical: <TechnicalDetails wi={item.wi} view={view} />,
  };

  return (
    <div className="calm-overlay" data-testid="calm-inspector">
      <div className="calm-scrim" aria-hidden="true" onClick={onClose} />
      <aside className="calm-inspector" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="calm-inspector-title">
        <div className="calm-inspector-head">
          <div><p className="calm-overline">EXPLANATION</p><h2 id="calm-inspector-title">Why this matters</h2><p>{item.wi.item.title}</p></div>
          <button className="calm-icon-btn" type="button" ref={closeRef} onClick={onClose} aria-label="Close explanation"><X size={19} /></button>
        </div>
        <div className="calm-inspector-tabs" role="tablist" aria-label="Explanation depth">
          {([
            ["why", "Explanation"], ["sources", "Sources"], ["technical", "Technical details"],
          ] as const).map(([key, label]) => (
            <button type="button" role="tab" key={key} id={`calm-tab-${key}`} aria-selected={tab === key} aria-controls={`calm-panel-${key}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>
        <div className="calm-inspector-body" id={`calm-panel-${tab}`} role="tabpanel" aria-labelledby={`calm-tab-${tab}`}>{panels[tab]}</div>
      </aside>
    </div>
  );
}

function WorkDetail({ view, item, onBack, onInspect }: { view: ViewState; item: CalmWork; onBack: () => void; onInspect: () => void }) {
  return (
    <div className="calm-stack" data-testid="calm-work-detail">
      <button className="calm-link-btn" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Back to work</button>
      <div className="calm-page-head">
        <p className="calm-overline">WORK ITEM · {item.wi.item.id}</p>
        <h1>{item.wi.item.title}</h1>
        <p>{workActor(item.wi)} · {item.wi.item.source === "seeded" ? "Demo fixture" : "Recorded work"}</p>
      </div>
      {isOutOfDate(view) && <div role="status" className="calm-warning"><CircleAlert size={17} aria-hidden="true" /> Updates are delayed. This summary may be out of date.</div>}
      <section className="calm-hero" aria-label="Current work status">
        <p className="calm-overline">WHAT NEEDS ATTENTION</p>
        <h2>{item.label}</h2>
        <p>{item.explanation}</p>
        {item.changes.length > 0 && <div className="calm-comparisons">
          {item.changes.map((change) => (
            <div className="calm-comparison" key={change.recordId + ":" + change.facetKey}>
              <h3>{humanFacet(change.facetKey)}</h3>
              <div className="calm-comparison-columns">
                <div><small>When work started</small><strong>{humanValue(change.before)}</strong></div>
                <div><small>Current decision</small><strong>{humanValue(change.after)}</strong></div>
              </div>
            </div>
          ))}
        </div>}
        <button type="button" className="calm-main-btn" onClick={onInspect}><FileText size={16} aria-hidden="true" /> Why this matters</button>
      </section>
      <section className="calm-next">
        <h2>What happens next?</h2>
        <p>{item.group === "finished"
          ? "This work is finished in the recorded state. You can inspect the full history in Activity."
          : "A human can use Convergence's existing review workflow to resolve or advance this work. No action is taken from this preview."}</p>
        <p className="calm-assignment">Next reviewer: <strong>Not assigned in v0.1 data</strong></p>
        <a className="calm-action-link" href={existingConsoleHref(window.location.search)}>Open existing console for available actions</a>
        <p className="calm-small-note">Permissions and any merge are checked by the existing server. The calm view does not approve, revalidate or merge anything.</p>
      </section>
    </div>
  );
}

function DecisionPage({ view }: { view: ViewState }) {
  const rows = Object.entries(view.records)
    .flatMap(([id, history]) => {
      if (history.current === null) return [];
      const record = history.versions[String(history.current)];
      return record ? [{ id, record }] : [];
    }).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <div className="calm-stack" data-testid="calm-decisions">
      <div className="calm-page-head"><p className="calm-overline">ACCEPTED CONTEXT</p><h1>Decisions</h1><p>Project decisions currently recorded as accepted. Unaccepted proposals do not govern work.</p></div>
      {!rows.length && <div className="calm-empty">No accepted project decisions are available.</div>}
      {rows.map(({ id, record }) => <DecisionCard key={id} record={record} />)}
    </div>
  );
}

function DecisionCard({ record }: { record: RecordSnapshot }) {
  return (
    <article className="calm-decision">
      <header><div><h2>{record.recordId.replace(/-/g, " ")}</h2><p>Accepted version {record.version} · Decision owner: {record.authority}</p></div><BookOpen size={19} aria-hidden="true" /></header>
      <dl className="calm-decision-values">{Object.entries(record.facets).map(([key, value]) => (
        <div key={key}><dt>{humanFacet(key)}</dt><dd>{humanValue(value)}</dd></div>
      ))}</dl>
      <details className="calm-tech-inline"><summary>Technical record details</summary><p className="calm-mono">Record: {record.recordId}@{record.version}</p><p className="calm-mono">Blob hash: {record.blobHash}</p><p className="calm-mono">Facet hash: {record.facetHash}</p></details>
    </article>
  );
}

function activityDescription(entry: ReconciliationEvent): string {
  const event = entry.payload.event;
  switch (event.type) {
    case "BaselinePushed": return event.records.length ? `Project decisions updated (${event.records.map((record) => record.recordId).join(", ")})` : "Project files updated";
    case "WorkItemRegistered": return `Work added: ${event.item.title}`;
    case "ForkPushed": return `Work changes recorded for ${event.workItemId}`;
    case "EvidenceRecorded": return `Check recorded for ${event.evidence.workItemId}`;
    case "DependencyDecided": return `A human ${event.decision === "accepted" ? "accepted" : "rejected"} a proposed work relationship`;
    case "ReceiptIssued": return `Updated recorded context for ${event.workItemId}`;
    case "ResolutionRecorded": return `Human resolution recorded for ${event.resolution.workItemId}`;
    case "PromotionRequested": return `Merge requested for ${event.workItemId}`;
    case "PromotionMerged": return `Work merged: ${event.workItemId}`;
    case "AgentRunStarted": return `Agent started work on ${event.workItemId}`;
    case "AgentRunFinished": return `Agent run ${event.outcome} for ${event.workItemId}`;
  }
}

function ActivityPage({ view }: { view: ViewState }) {
  return (
    <div className="calm-stack" data-testid="calm-activity">
      <div className="calm-page-head"><p className="calm-overline">RECORDED HISTORY</p><h1>Activity</h1><p>What Convergence recorded, newest first. Agent statements are not independent proof.</p></div>
      {!view.ledger.length && <div className="calm-empty">Nothing has been recorded yet.</div>}
      <ol className="calm-activity-list">{[...view.ledger].reverse().slice(0, 60).map((entry) => (
        <li key={entry.seq}><span className="calm-activity-dot" aria-hidden="true" /><div><strong>{activityDescription(entry)}</strong><p>{fallbackDate(entry.ts)}</p><details className="calm-tech-inline"><summary>Technical ledger entry</summary><p className="calm-mono">Sequence {entry.seq} · {entry.type}</p><p className="calm-mono">Hash {entry.hash}</p></details></div></li>
      ))}</ol>
      {view.ledger.length >= 60 && <p className="calm-small-note">Only the most recent 60 entries in the received ledger window appear here. This is not a full ledger export.</p>}
    </div>
  );
}

export function CalmShell({ scenario, onScenario, controls }: { scenario: ScenarioName; onScenario: (scenario: ScenarioName) => void; controls: boolean }) {
  const { view, connection, client } = useConsole();
  const [section, setSection] = useState<Section>("work");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const isMock = client.kind === "mock";
  const mock = isMock ? client as MockClient : null;
  const selected = selectedId && view.workItems[selectedId] ? calmWorkItem(view, view.workItems[selectedId]) : null;
  const closeInspector = () => setInspectorOpen(false);

  useEffect(() => { setSelectedId(null); setSection("work"); setInspectorOpen(false); }, [scenario]);

  const nav: { id: Section; label: string; icon: ReactNode }[] = [
    { id: "work", label: "Work", icon: <ListTodo size={18} aria-hidden="true" /> },
    { id: "decisions", label: "Decisions", icon: <BookOpen size={18} aria-hidden="true" /> },
    { id: "activity", label: "Activity", icon: <History size={18} aria-hidden="true" /> },
  ];
  return (
    <div className="calm-layout" data-testid="calm-shell">
      <aside className="calm-sidebar">
        <div className="calm-brand"><span className="calm-brand-mark" aria-hidden="true">C</span><strong>Convergence</strong></div>
        <div className="calm-project-picker">
          <label htmlFor="calm-scenario">Project</label>
          {isMock ? <select id="calm-scenario" value={scenario} onChange={(e) => onScenario(e.target.value as ScenarioName)}>
            {SCENARIOS.map((id) => <option key={id} value={id}>{SCENARIO_NAMES[id]}</option>)}
          </select> : <p>{SCENARIO_NAMES[scenario]}</p>}
        </div>
        <nav className="calm-primary-nav" aria-label="Primary">
          {nav.map((entry) => <button key={entry.id} type="button" aria-current={section === entry.id ? "page" : undefined}
            onClick={() => { setSection(entry.id); setSelectedId(null); setInspectorOpen(false); }}>
            {entry.icon}<span>{entry.label}</span>
          </button>)}
        </nav>
        <p className="calm-side-note">A calmer view of your existing project decisions and work. Governance still comes from v0.1.</p>
      </aside>
      <div className="calm-main">
        <header className="calm-topbar">
          <span>{SCENARIO_NAMES[scenario]}</span>
          <span className="calm-readonly">{isMock ? "Demo · read-only" : "Read-only view"}</span>
        </header>
        <main className="calm-content">
          {!view.ready ? <div role="status" className="calm-empty">{connection === "offline" ? "Connection lost. Unable to load the latest project state." : "Loading the recorded project state…"}</div>
            : section === "work"
              ? selected
                ? <WorkDetail view={view} item={selected} onBack={() => setSelectedId(null)} onInspect={() => setInspectorOpen(true)} />
                : <CalmInbox view={view} onOpen={(id) => setSelectedId(id)} />
              : section === "decisions" ? <DecisionPage view={view} /> : <ActivityPage view={view} />}
          <div className="calm-footer"><ReadOnlyNote isMock={isMock} /></div>
        </main>
        {mock && controls && <div className="calm-demo-toolbar" aria-label="Demo controls">
          <span>Demo controls</span>
          <button type="button" onClick={() => void mock.controls.jump(4)}>Show changed decisions</button>
          <button type="button" onClick={() => void mock.controls.next()}>Next step</button>
          <button type="button" onClick={() => void mock.controls.jump(0)}>Reset demo</button>
        </div>}
      </div>
      {inspectorOpen && selected && <CalmInspector view={view} item={selected} onClose={closeInspector} />}
    </div>
  );
}
