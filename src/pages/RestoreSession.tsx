import { ArchiveRestore, FileClock, Link2, RotateCcw, Save, ServerCog } from "lucide-react";
import { RecordItem, StatusPill } from "../components/common";
import type { Agent, RestoreContextRecord, RestoreManifest, RestoreProcessRecord, Task } from "../types";

export function RestoreSession({
  manifest,
  selectedAgent,
  selectedTask,
  onCaptureRestoreManifest,
  onRestoreWorkspaceSession,
}: {
  manifest?: RestoreManifest;
  selectedAgent: Agent;
  selectedTask: Task;
  onCaptureRestoreManifest: () => void;
  onRestoreWorkspaceSession: () => void;
}) {
  const processRecords = manifest?.processRecords ?? [];
  const contextRecords = manifest?.contextRecords ?? [];

  return (
    <section className="restore-layout">
      <div className="panel restore-main">
        <div className="section-title">
          <ArchiveRestore size={18} />
          <span>Restore Session Manifest</span>
        </div>
        <div className="restore-target">
          <div>
            <span className="eyebrow">Current shell context</span>
            <strong>{selectedTask.title}</strong>
            <small>
              {selectedAgent.name} · {selectedAgent.provider} · {selectedAgent.model}
            </small>
          </div>
          <StatusPill status={selectedTask.status} />
        </div>

        {manifest ? (
          <>
            <div className="record-grid">
              <RecordItem label="Manifest" value={manifest.manifestPath} />
              <RecordItem label="Project" value={manifest.projectPath} />
              <RecordItem label="Active view" value={manifest.activeView} />
              <RecordItem label="Captured" value={manifest.capturedAt} />
            </div>
            <div className="restore-context-list">
              <div className="section-title compact">
                <Link2 size={17} />
                <span>Resume context</span>
              </div>
              {contextRecords.length ? (
                contextRecords.map((record) => <ContextRecordCard key={record.id} record={record} />)
              ) : (
                <div className="restore-empty">
                  <Link2 size={18} />
                  <span>No resume context records captured</span>
                </div>
              )}
            </div>
            <div className="restore-process-list">
              <div className="section-title compact">
                <ServerCog size={17} />
                <span>Process metadata</span>
              </div>
              {processRecords.map((record) => (
                <ProcessRecordCard key={record.id} record={record} />
              ))}
            </div>
          </>
        ) : (
          <div className="restore-empty">
            <FileClock size={18} />
            <span>No restore manifest captured yet</span>
          </div>
        )}

        <div className="button-row">
          <button
            aria-label="Capture restore manifest"
            className="primary-button"
            type="button"
            onClick={onCaptureRestoreManifest}
          >
            <Save size={16} />
            Capture manifest
          </button>
          <button
            aria-label="Restore workspace session"
            className="ghost-button"
            disabled={!manifest}
            type="button"
            onClick={onRestoreWorkspaceSession}
          >
            <RotateCcw size={16} />
            Restore workspace
          </button>
        </div>
      </div>

      <aside className="panel restore-guardrails">
        <div className="section-title">
          <FileClock size={18} />
          <span>Restore guardrails</span>
        </div>
        <div className="restore-rule">
          <strong>Does not rerun agent reasoning</strong>
          <span>Restore rehydrates shell state and process metadata; agent runtimes still own reasoning output.</span>
        </div>
        <div className="restore-rule">
          <strong>Does not change task state</strong>
          <span>Task cards and review gates remain owned by the task store and Review page.</span>
        </div>
        <div className="restore-rule">
          <strong>Does not write product intent</strong>
          <span>Runtime restoration belongs under .agent-workspace, not docs product-intent files.</span>
        </div>
      </aside>
    </section>
  );
}

function ContextRecordCard({ record }: { record: RestoreContextRecord }) {
  return (
    <article className="restore-context-card">
      <div className="restore-context-head">
        <strong>{record.label}</strong>
        <StatusPill status={record.status} />
      </div>
      <div className="restore-context-meta">
        <span>{record.kind}</span>
        {record.taskId ? <span>{record.taskId}</span> : null}
      </div>
      <p>{record.summary}</p>
      <code>{record.artifactPath}</code>
    </article>
  );
}

function ProcessRecordCard({ record }: { record: RestoreProcessRecord }) {
  return (
    <article className="restore-process-card">
      <div className="restore-process-head">
        <strong>{record.label}</strong>
        <StatusPill status={record.processClass} />
      </div>
      <code>{record.commandLine}</code>
      <div className="restore-process-meta">
        <span>{record.workingDir}</span>
        <span>{record.rollbackIntent}</span>
      </div>
      <code>{record.metadataPath}</code>
    </article>
  );
}
