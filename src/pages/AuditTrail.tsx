import { ArrowRight, History, ShieldCheck } from "lucide-react";
import { StatusPill } from "../components/common";
import type { AuditTrailEntry } from "../lib/auditTrail";

export function AuditTrail({
  entries,
  onOpenEntryContext,
}: {
  entries: AuditTrailEntry[];
  onOpenEntryContext: (entryId: string) => void;
}) {
  const surfaces = new Set(entries.map((entry) => entry.surface));
  const taskLinkedCount = entries.filter((entry) => entry.taskId).length;

  return (
    <section className="audit-layout">
      <div className="panel audit-main">
        <div className="section-title">
          <History size={18} />
          <span>Workspace audit trail</span>
        </div>
        <p>
          Read-only shell evidence across task, loop, run, review, browser, MCP, restore, and workspace context
          surfaces.
        </p>
        <div className="audit-summary-grid">
          <div>
            <span>Evidence records</span>
            <strong>{entries.length}</strong>
          </div>
          <div>
            <span>Surfaces</span>
            <strong>{surfaces.size}</strong>
          </div>
          <div>
            <span>Task-linked</span>
            <strong>{taskLinkedCount}</strong>
          </div>
        </div>
        <div className="audit-stream">
          {entries.map((entry) => (
            <article className="audit-event" key={entry.id}>
              <div className="audit-event-head">
                <div>
                  <span className="eyebrow">{entry.surface} / {entry.kind}</span>
                  <strong>{entry.title}</strong>
                </div>
                <StatusPill status={entry.status} />
              </div>
              <p>{entry.summary}</p>
              <div className="audit-meta">
                <span>{entry.createdAt}</span>
                {entry.taskId ? <span>{entry.taskId}</span> : null}
                {entry.runId ? <span>{entry.runId}</span> : null}
              </div>
              <code>{entry.evidencePath}</code>
              {entry.sourceEventId ? (
                <div className="audit-source">
                  <strong>{entry.sourceLabel ?? "Source event"}</strong>
                  <span>{entry.sourceEventId}</span>
                  {entry.sourceSummary ? <small>{entry.sourceSummary}</small> : null}
                  {entry.sourceEvidencePath ? <code>{entry.sourceEvidencePath}</code> : null}
                </div>
              ) : null}
              <button
                aria-label={`Open audit context ${entry.id}`}
                className="small-action"
                type="button"
                onClick={() => onOpenEntryContext(entry.id)}
              >
                <ArrowRight size={14} />
                Open context
              </button>
            </article>
          ))}
        </div>
      </div>

      <aside className="panel audit-guardrail">
        <div className="section-title">
          <ShieldCheck size={18} />
          <span>Read-only shell evidence</span>
        </div>
        <div className="evidence-box">
          <strong>No scheduling side effects</strong>
          <p>This page does not create AgentRun records, move task cards, or approve Review.</p>
        </div>
        <div className="evidence-box">
          <strong>Source of truth</strong>
          <p>It aggregates existing shell-owned event streams and artifact pointers under .agent-workspace/.</p>
        </div>
        <div className="evidence-box">
          <strong>Runs stays run-scoped</strong>
          <p>Use Runs for transcript, diff, verification, and commit context of one AgentRun.</p>
        </div>
      </aside>
    </section>
  );
}
