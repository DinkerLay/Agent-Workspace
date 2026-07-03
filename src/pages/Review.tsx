import { FileDiff, GitBranch, GitCommit, GitPullRequest } from "lucide-react";
import { GateRow, StatusPill } from "../components/common";
import type {
  Agent,
  AgentRun,
  BrowserEvidence,
  ChangedFile,
  CommitRedactionScan,
  CommitStagingEvent,
  McpToolCallEvent,
  ReviewFileSelection,
  Task,
  TerminalEvent,
} from "../types";

export function Review({
  agents,
  files,
  selectedTask,
  selectedRun,
  reviewAgentId,
  reviewFileSelections,
  commitConversationIncluded,
  commitRedactionScans,
  commitStagingEvents,
  browserEvidence,
  mcpToolEvents,
  terminalEvents,
  onReviewAgentChange,
  onToggleReviewFile,
  onToggleCommitConversation,
  onRunCommitRedactionScan,
  onStageReviewFiles,
  onRunVerificationCommand,
  onVerificationFailed,
  onApproveReview,
}: {
  agents: Agent[];
  files: ChangedFile[];
  selectedTask: Task;
  selectedRun?: AgentRun;
  reviewAgentId: string;
  reviewFileSelections: ReviewFileSelection[];
  commitConversationIncluded: boolean;
  commitRedactionScans: CommitRedactionScan[];
  commitStagingEvents: CommitStagingEvent[];
  browserEvidence: BrowserEvidence[];
  mcpToolEvents: McpToolCallEvent[];
  terminalEvents: TerminalEvent[];
  onReviewAgentChange: (agentId: string) => void;
  onToggleReviewFile: (path: string) => void;
  onToggleCommitConversation: () => void;
  onRunCommitRedactionScan: (runId: string) => void;
  onStageReviewFiles: (taskId: string) => void;
  onRunVerificationCommand: (taskId: string) => void;
  onVerificationFailed: () => void;
  onApproveReview: () => void;
}) {
  const selectedFilePaths = reviewFileSelections.filter((file) => file.selected).map((file) => file.path);
  const taskBrowserEvidence = browserEvidence.filter((item) => item.taskId === selectedTask.id);
  const taskMcpToolEvents = mcpToolEvents.filter((event) => event.taskId === selectedTask.id);
  const taskCompletionSignals = terminalEvents.filter(
    (event) =>
      event.taskId === selectedTask.id &&
      event.kind === "done-signal" &&
      (!selectedRun || event.runId === selectedRun.id),
  );
  const redactionScan = commitRedactionScans.find((scan) => scan.runId === selectedRun?.id);
  const stagingEvent = [...commitStagingEvents].reverse().find((event) => event.runId === selectedRun?.id);
  const unstagedFilePaths =
    stagingEvent?.unstagedFilePaths ?? reviewFileSelections.filter((file) => !file.selected).map((file) => file.path);
  const redactionRequired = commitConversationIncluded && Boolean(selectedRun?.transcriptPath);
  const approvalReady =
    Boolean(selectedRun) &&
    selectedRun?.verification.status === "passed" &&
    (!redactionRequired || redactionScan?.status === "passed");
  const visibleSelectedCount = files.filter((file) => isFileSelected(file.path, reviewFileSelections)).length;
  const transcriptPath = selectedRun?.transcriptPath ?? "Transcript pending";
  const commitPreview = buildCommitPreview(
    selectedRun?.commitProposal.message ??
      `Implement task outcome for ${selectedTask.id}\n\nTask: ${selectedTask.id}\nPlan-Step: mvp-board-first-shell\nAgent-Run: not-started\nVerification: pending`,
    selectedFilePaths,
    commitConversationIncluded ? selectedRun?.transcriptPath : undefined,
    commitConversationIncluded ? redactionScan?.artifactPath : undefined,
    stagingEvent?.evidencePath,
  );

  return (
    <section className="review-layout">
      <div className="panel review-main">
        <div className="section-title">
          <FileDiff size={18} />
          <span>Per-agent Review</span>
        </div>
        <div className="agent-filter">
          <button
            className={reviewAgentId === "all" ? "chip active" : "chip"}
            type="button"
            onClick={() => onReviewAgentChange("all")}
          >
            All agents
          </button>
          {agents.map((agent) => (
            <button
              className={reviewAgentId === agent.id ? "chip active" : "chip"}
              key={agent.id}
              type="button"
              onClick={() => onReviewAgentChange(agent.id)}
            >
              {agent.name}
            </button>
          ))}
        </div>
        <div className="selected-task review-task">
          <span className="eyebrow">Reviewing task</span>
          <strong>{selectedTask.title}</strong>
          <p>{selectedTask.summary}</p>
          <StatusPill status={selectedTask.status} />
        </div>
        <div className="diff-table">
          {files.map((file) => (
            <div className="diff-row" key={file.path}>
              <FileDiff size={17} />
              <div>
                <strong>{file.path}</strong>
                <small>
                  {file.status} · +{file.additions} -{file.deletions}
                </small>
              </div>
              <div className="review-file-actions">
                <StatusPill status={file.reviewed ? "reviewed" : "needs review"} />
                <button
                  aria-label={
                    isFileSelected(file.path, reviewFileSelections)
                      ? `Exclude ${file.path} from scoped commit`
                      : `Include ${file.path} in scoped commit`
                  }
                  className="small-action"
                  type="button"
                  onClick={() => onToggleReviewFile(file.path)}
                >
                  {isFileSelected(file.path, reviewFileSelections) ? "Selected" : "Excluded"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <aside className="panel commit-panel">
        <div className="section-title">
          <GitCommit size={18} />
          <span>Commit proposal</span>
        </div>
        <div className="commit-scope-box">
          <div>
            <span className="eyebrow">Scoped commit files</span>
            <strong>{visibleSelectedCount} selected</strong>
          </div>
          <span>{selectedFilePaths.length} total staged</span>
        </div>
        <textarea readOnly value={commitPreview} />
        <div className="commit-option">
          <div>
            <strong>Agent-Conversation trailer</strong>
            <small>{transcriptPath}</small>
          </div>
          <button className="small-action" type="button" onClick={onToggleCommitConversation}>
            {commitConversationIncluded ? "Disable Agent-Conversation trailer" : "Enable Agent-Conversation trailer"}
          </button>
        </div>
        <div className="evidence-box">
          <div className="section-title compact">
            <GitBranch size={16} />
            <span>Worktree / Branch</span>
          </div>
          <StatusPill status={selectedRun?.worktreeContext.isolationPolicy ?? "pending"} />
          <code>{selectedRun?.worktreeContext.branchName ?? "branch pending"}</code>
          <code>{selectedRun?.worktreeContext.worktreePath ?? "worktree pending"}</code>
          <small>{selectedRun?.worktreeContext.baselineManifestPath ?? ".agent-workspace/runs/not-started/worktree.json"}</small>
        </div>
        {selectedRun?.nativeSession ? (
          <div className="evidence-box">
            <strong>Native session state</strong>
            <StatusPill status={selectedRun.nativeSession.status} />
            <div className="task-run-grid">
              <span>Session</span>
              <strong>{selectedRun.nativeSession.id}</strong>
              <span>Backend</span>
              <strong>{selectedRun.nativeSession.backend}</strong>
              <span>Model</span>
              <strong>{selectedRun.nativeSession.model ?? "not recorded"}</strong>
              <span>Exit</span>
              <strong>{formatNativeSessionExit(selectedRun.nativeSession)}</strong>
            </div>
            <code>{formatNativeSessionCommand(selectedRun.nativeSession)}</code>
          </div>
        ) : null}
        <div className="evidence-box">
          <div className="section-title compact">
            <GitCommit size={16} />
            <span>Git staging</span>
          </div>
          <StatusPill status={stagingEvent?.status ?? `${unstagedFilePaths.length} unstaged`} />
          <p>
            {stagingEvent?.summary ??
              `${selectedFilePaths.length} scoped files are selected for staging before approval.`}
          </p>
          {stagingEvent ? <code>{stagingEvent.evidencePath}</code> : null}
          <button
            aria-label={`Stage selected files for ${selectedTask.id}`}
            className="small-action"
            type="button"
            onClick={() => onStageReviewFiles(selectedTask.id)}
          >
            Stage selected files
          </button>
        </div>
        <div className="gate-list">
          <GateRow done label="Diff reviewed for scoped files" />
          <GateRow done={Boolean(stagingEvent)} label="Scoped files staged as git evidence" />
          <GateRow done={selectedRun?.verification.status === "passed"} label="Verification evidence attached" />
          <GateRow done={taskBrowserEvidence.length > 0} label="Browser evidence attached" />
          <GateRow done={taskMcpToolEvents.length > 0} label="MCP tool evidence attached" />
          <GateRow done={taskCompletionSignals.length > 0} label="Terminal completion claim recorded" />
          <GateRow done={Boolean(selectedRun?.transcriptPath)} label="Transcript path recorded" />
          <GateRow done={commitConversationIncluded} label="Agent conversation selected for commit trailer" />
          <GateRow done={!redactionRequired || redactionScan?.status === "passed"} label="Agent conversation redaction scan passed" />
          <GateRow done={Boolean(selectedRun?.commitProposal.approved)} label="User approval before PR" />
        </div>
        <div className="evidence-box">
          <strong>Verification</strong>
          <StatusPill status={selectedRun?.verification.status ?? "pending"} />
          <code>{selectedRun?.verification.command ?? "npm test && npm run build"}</code>
          <p>{selectedRun?.verification.summary ?? "Waiting for run evidence."}</p>
          <small>{selectedRun?.verification.logPath ?? ".agent-workspace/runs/not-started/verification.log"}</small>
          <button
            aria-label={`Run verification command for ${selectedTask.id}`}
            className="small-action"
            type="button"
            onClick={() => onRunVerificationCommand(selectedTask.id)}
          >
            Run verification
          </button>
        </div>
        <div className="evidence-box">
          <strong>Browser evidence</strong>
          <StatusPill status={taskBrowserEvidence.length > 0 ? `${taskBrowserEvidence.length} captured` : "not captured"} />
          {taskBrowserEvidence.length === 0 ? <p>No browser evidence captured for this task.</p> : null}
          {taskBrowserEvidence.map((item) => (
            <div className="browser-audit-row" key={item.id}>
              <span>{item.toolName}</span>
              <small>{item.summary}</small>
              <code>{item.artifactPath}</code>
            </div>
          ))}
        </div>
        <div className="evidence-box">
          <strong>MCP tool evidence</strong>
          <StatusPill status={taskMcpToolEvents.length > 0 ? `${taskMcpToolEvents.length} recorded` : "not recorded"} />
          {taskMcpToolEvents.length === 0 ? <p>No MCP tool evidence recorded for this task.</p> : null}
          {taskMcpToolEvents.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status={event.status} />
              <span>{event.decisionSummary ?? event.summary}</span>
              <small>{`${event.serverId}.${event.toolName}`}</small>
              <small>{event.targetSurface}</small>
              <code>{event.decisionEvidencePath ?? event.evidencePath}</code>
            </div>
          ))}
        </div>
        <div className="evidence-box">
          <strong>Terminal completion claim</strong>
          <StatusPill status={taskCompletionSignals.length > 0 ? `${taskCompletionSignals.length} recorded` : "not recorded"} />
          {taskCompletionSignals.length === 0 ? (
            <p>No terminal completion claim recorded for this task.</p>
          ) : null}
          {taskCompletionSignals.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status={event.kind} />
              <StatusPill status={event.mappedStatus} />
              <span>{event.summary}</span>
              <small>{event.ruleId}</small>
              <code>{event.sourceLine}</code>
              <code>{event.evidencePath}</code>
            </div>
          ))}
        </div>
        <div className="evidence-box">
          <strong>Conversation redaction</strong>
          <StatusPill status={redactionScan?.status ?? (redactionRequired ? "not scanned" : "not required")} />
          <small>{transcriptPath}</small>
          {redactionScan ? (
            <>
              <code>{redactionScan.artifactPath}</code>
              <div className="redaction-pattern-list">
                {redactionScan.redactedPatterns.map((pattern) => (
                  <span key={pattern}>{pattern}</span>
                ))}
              </div>
            </>
          ) : (
            <p>Run the scan before uploading Agent-Conversation artifacts.</p>
          )}
          {selectedRun ? (
            <button
              aria-label={`Run Agent-Conversation redaction scan for ${selectedRun.id}`}
              className="small-action"
              type="button"
              onClick={() => onRunCommitRedactionScan(selectedRun.id)}
            >
              Run redaction scan
            </button>
          ) : null}
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={onVerificationFailed}>
            Mark verification failed
          </button>
          <button className="primary-button" disabled={!approvalReady} type="button" onClick={onApproveReview}>
            <GitPullRequest size={16} />
            Approve review
          </button>
        </div>
      </aside>
    </section>
  );
}

function isFileSelected(path: string, selections: ReviewFileSelection[]) {
  return selections.find((file) => file.path === path)?.selected ?? true;
}

function formatNativeSessionCommand(session: NonNullable<AgentRun["nativeSession"]>) {
  return [session.command, ...session.args].join(" ");
}

function formatNativeSessionExit(session: NonNullable<AgentRun["nativeSession"]>) {
  if (session.exitCode === undefined) return "pending";
  if (session.exitCode === null) return session.signal ? `Signal ${session.signal}` : "Exit unknown";
  return `Exit ${session.exitCode}`;
}

function buildCommitPreview(
  baseMessage: string,
  selectedFilePaths: string[],
  transcriptPath?: string,
  redactionArtifactPath?: string,
  stagingEvidencePath?: string,
) {
  const hasFiles = baseMessage.includes("\nFiles:");
  const hasConversation = baseMessage.includes("\nAgent-Conversation:");
  const hasRedaction = baseMessage.includes("\nAgent-Conversation-Redaction:");
  const hasStaging = baseMessage.includes("\nStaging-Evidence:");
  const files = hasFiles || selectedFilePaths.length === 0 ? [] : ["Files:", ...selectedFilePaths.map((path) => `- ${path}`)];
  const conversation = hasConversation || !transcriptPath ? [] : [`Agent-Conversation: ${transcriptPath}`];
  const redaction =
    hasRedaction || !redactionArtifactPath ? [] : [`Agent-Conversation-Redaction: ${redactionArtifactPath}`];
  const staging = hasStaging || !stagingEvidencePath ? [] : [`Staging-Evidence: ${stagingEvidencePath}`];
  return [baseMessage, ...files, ...conversation, ...redaction, ...staging].join("\n");
}
