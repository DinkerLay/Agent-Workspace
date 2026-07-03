import {
  FileDiff,
  GitBranch,
  GitCommit,
  GitPullRequest,
  HardDrive,
  History,
  ListChecks,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { GateRow, RecordItem, StatusPill } from "../components/common";
import type {
  Agent,
  AgentRun,
  BrowserEvidence,
  CommitRedactionScan,
  CommitStagingEvent,
  McpToolCallEvent,
  PullRequestHandoffEvent,
  ReviewApprovalEvent,
  ReviewFileSelection,
  TerminalEvent,
  Task,
  VerificationCommandEvent,
} from "../types";

export function Runs({
  runs,
  selectedTask,
  selectedAgent,
  reviewFileSelections,
  commitConversationIncluded,
  browserEvidence,
  commitRedactionScans,
  commitStagingEvents,
  verificationEvents,
  terminalEvents,
  mcpToolEvents,
  reviewApprovalEvents,
  pullRequestHandoffEvents,
  onCreatePullRequestHandoff,
}: {
  runs: AgentRun[];
  selectedTask: Task;
  selectedAgent: Agent;
  reviewFileSelections: ReviewFileSelection[];
  commitConversationIncluded: boolean;
  browserEvidence: BrowserEvidence[];
  commitRedactionScans: CommitRedactionScan[];
  commitStagingEvents: CommitStagingEvent[];
  verificationEvents: VerificationCommandEvent[];
  terminalEvents: TerminalEvent[];
  mcpToolEvents: McpToolCallEvent[];
  reviewApprovalEvents: ReviewApprovalEvent[];
  pullRequestHandoffEvents: PullRequestHandoffEvent[];
  onCreatePullRequestHandoff: (runId: string) => void;
}) {
  const taskRuns = runs.filter((run) => run.taskId === selectedTask.id);
  const selectedRun = taskRuns.find((run) => run.status !== "completed") ?? taskRuns[taskRuns.length - 1] ?? runs[0];
  const scopedFilePaths = reviewFileSelections.filter((file) => file.selected).map((file) => file.path);
  const excludedFileCount = reviewFileSelections.length - scopedFilePaths.length;
  const taskBrowserEvidence = browserEvidence.filter((item) => item.taskId === selectedTask.id);
  const taskMcpToolEvents = mcpToolEvents.filter((event) => event.taskId === selectedTask.id);
  const redactionScan = commitRedactionScans.find((scan) => scan.runId === selectedRun.id);
  const redactionRequired = commitConversationIncluded && Boolean(selectedRun.transcriptPath);
  const selectedRunVerificationEvents = verificationEvents.filter((event) => event.runId === selectedRun.id);
  const selectedRunTerminalEvents = terminalEvents.filter((event) => event.runId === selectedRun.id);
  const selectedRunStagingEvents = commitStagingEvents.filter((event) => event.runId === selectedRun.id);
  const selectedRunApprovalEvents = reviewApprovalEvents.filter((event) => event.runId === selectedRun.id);
  const selectedRunPrHandoffEvents = pullRequestHandoffEvents.filter((event) => event.runId === selectedRun.id);

  return (
    <section className="runs-layout">
      <div className="panel run-record">
        <div className="section-title">
          <HardDrive size={18} />
          <span>AgentRun record</span>
        </div>
        <div className="run-history">
          {runs.map((run) => (
            <div className={run.id === selectedRun.id ? "run-history-row active" : "run-history-row"} key={run.id}>
              <History size={16} />
              <span>{run.id}</span>
              <StatusPill status={run.status} />
            </div>
          ))}
        </div>
        <div className="record-grid">
          <RecordItem label="runId" value={selectedRun.id} />
          <RecordItem label="agentSessionId" value={selectedRun.agentId || selectedAgent.id} />
          <RecordItem label="taskId" value={selectedRun.taskId} />
          <RecordItem label="startGitSha" value={selectedRun.startGitSha} />
          <RecordItem label="promptPath" value={selectedRun.promptPath} />
          <RecordItem label="transcriptPath" value={selectedRun.transcriptPath} />
          <RecordItem label="diffPath" value={selectedRun.diffPath} />
          <RecordItem label="verificationPath" value={selectedRun.verificationPath} />
        </div>
      </div>

      <aside className="panel run-flow">
        <div className="section-title">
          <ListChecks size={18} />
          <span>Completion audit</span>
        </div>
        <GateRow done label="Task has plan step id" />
        <GateRow done label="Baseline captured" />
        <GateRow done={selectedRun.verification.status === "passed"} label="Verification command passed" />
        <GateRow done={taskBrowserEvidence.length > 0} label="Browser evidence captured" />
        <GateRow done={taskMcpToolEvents.length > 0} label="MCP tool evidence recorded" />
        <GateRow done={selectedRunStagingEvents.length > 0} label="Scoped files staged" />
        <GateRow done={!redactionRequired || redactionScan?.status === "passed"} label="Agent conversation redaction passed" />
        <GateRow done={selectedRun.commitProposal.message.length > 0} label="Commit context complete" />
        <GateRow done={selectedRun.commitProposal.approved} label="Reviewer approved Done" />

        <div className="evidence-box">
          <div className="section-title compact">
            <GitBranch size={16} />
            <span>Worktree context</span>
          </div>
          <StatusPill status={selectedRun.worktreeContext.isolationPolicy} />
          <code>{selectedRun.worktreeContext.branchName}</code>
          <code>{selectedRun.worktreeContext.worktreePath}</code>
          <small>{selectedRun.worktreeContext.baselineManifestPath}</small>
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <ShieldCheck size={16} />
            <span>Launch policy</span>
          </div>
          <StatusPill status={selectedRun.runtimePolicy.permissionMode} />
          <code>{selectedRun.runtimePolicy.policyPath}</code>
          <div className="task-run-grid">
            <span>Permission</span>
            <strong>{selectedRun.runtimePolicy.permissionMode}</strong>
            <span>Sandbox</span>
            <strong>{selectedRun.runtimePolicy.sandboxMode}</strong>
            <span>Effort</span>
            <strong>{selectedRun.runtimePolicy.effort}</strong>
            <span>CLI command</span>
            <strong>{selectedRun.runtimePolicy.cliCommand}</strong>
          </div>
        </div>

        {selectedRun.nativeSession ? (
          <div className="evidence-box">
            <div className="section-title compact">
              <ScrollText size={16} />
              <span>Native session state</span>
            </div>
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
            {nativeSessionTranscriptPreview(selectedRun.nativeSession).length > 0 ? (
              <pre>{nativeSessionTranscriptPreview(selectedRun.nativeSession).join("\n")}</pre>
            ) : (
              <p>No native transcript preview recorded.</p>
            )}
          </div>
        ) : null}

        <div className="evidence-box">
          <div className="section-title compact">
            <ScrollText size={16} />
            <span>Terminal diagnostics evidence</span>
          </div>
          {selectedRunTerminalEvents.length === 0 ? <p>No terminal diagnostics recorded for this run.</p> : null}
          {selectedRunTerminalEvents.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status={event.kind} />
              <span>{event.summary}</span>
              <small>{event.ruleId}</small>
              <small>{`${event.kind} -> ${event.mappedStatus}`}</small>
              <code>{event.evidencePath}</code>
            </div>
          ))}
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <ListChecks size={16} />
            <span>Verification evidence</span>
          </div>
          <StatusPill status={selectedRun.verification.status} />
          <code>{selectedRun.verification.command}</code>
          <p>{selectedRun.verification.summary}</p>
          <small>{selectedRun.verification.logPath}</small>
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <ListChecks size={16} />
            <span>Verification command history</span>
          </div>
          {selectedRunVerificationEvents.length === 0 ? <p>No verification command event recorded for this run.</p> : null}
          {selectedRunVerificationEvents.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status={event.status} />
              <span>{event.command}</span>
              <small>{event.summary}</small>
              <code>{event.artifactPath}</code>
            </div>
          ))}
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <GitCommit size={16} />
            <span>Commit proposal</span>
          </div>
          <StatusPill status={selectedRun.commitProposal.approved ? "approved" : selectedRun.commitProposal.policy} />
          <pre>{selectedRun.commitProposal.message}</pre>
          <small>{selectedRun.commitPath}</small>
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <GitCommit size={16} />
            <span>Review approval history</span>
          </div>
          {selectedRunApprovalEvents.length === 0 ? <p>No review approval event recorded for this run.</p> : null}
          {selectedRunApprovalEvents.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status="approved" />
              <span>{event.summary}</span>
              <small>{event.approvedAt}</small>
              <small>{`${event.selectedFilePaths.length} scoped files`}</small>
              <code>{event.evidencePath}</code>
            </div>
          ))}
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <GitCommit size={16} />
            <span>Git staging evidence</span>
          </div>
          {selectedRunStagingEvents.length === 0 ? <p>No git staging event recorded for this run.</p> : null}
          {selectedRunStagingEvents.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status={event.status} />
              <span>{event.summary}</span>
              <small>{`${event.stagedFilePaths.length} staged files`}</small>
              <small>{`${event.unstagedFilePaths.length} unstaged files`}</small>
              <code>{event.evidencePath}</code>
            </div>
          ))}
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <GitPullRequest size={16} />
            <span>PR handoff</span>
          </div>
          <button
            aria-label={`Prepare PR handoff for ${selectedRun.id}`}
            className="small-action"
            type="button"
            onClick={() => onCreatePullRequestHandoff(selectedRun.id)}
          >
            Prepare PR handoff
          </button>
          {selectedRunPrHandoffEvents.length === 0 ? <p>No PR handoff draft recorded for this run.</p> : null}
          {selectedRunPrHandoffEvents.map((event) => (
            <div className="browser-audit-row" key={event.id}>
              <StatusPill status={event.status} />
              <span>{event.summary}</span>
              <small>{event.branchName}</small>
              <small>{event.approvalEvidencePath}</small>
              <code>{event.prDraftPath}</code>
            </div>
          ))}
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <GitCommit size={16} />
            <span>Commit scope</span>
          </div>
          <strong>{scopedFilePaths.length} selected files</strong>
          <small>{excludedFileCount} excluded</small>
          {scopedFilePaths.map((path) => (
            <code key={path}>{path}</code>
          ))}
          <div className="run-commit-trailer">
            <strong>Agent-Conversation trailer</strong>
            <StatusPill status={commitConversationIncluded ? "selected" : "not selected"} />
            <small>{commitConversationIncluded ? selectedRun.transcriptPath : "Transcript remains recorded but not attached"}</small>
          </div>
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <GitCommit size={16} />
            <span>Conversation redaction</span>
          </div>
          <StatusPill status={redactionScan?.status ?? (redactionRequired ? "not scanned" : "not required")} />
          <small>{selectedRun.transcriptPath}</small>
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
            <p>No Agent-Conversation redaction scan recorded for this run.</p>
          )}
        </div>

        <div className="evidence-box">
          <div className="section-title compact">
            <ListChecks size={16} />
            <span>Browser evidence</span>
          </div>
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
          <div className="section-title compact">
            <ListChecks size={16} />
            <span>MCP tool evidence</span>
          </div>
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
      </aside>

      <aside className="panel run-flow">
        <div className="section-title">
          <ScrollText size={18} />
          <span>Transcript / Diff context</span>
        </div>
        <div className="evidence-box">
          <strong>Transcript preview</strong>
          {selectedRun.transcriptPreview.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className="evidence-box">
          <div className="section-title compact">
            <FileDiff size={16} />
            <span>Changed files</span>
          </div>
          {selectedRun.changedFilePaths.map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      </aside>
    </section>
  );
}

function formatNativeSessionCommand(session: NonNullable<AgentRun["nativeSession"]>) {
  return [session.command, ...session.args].join(" ");
}

function formatNativeSessionExit(session: NonNullable<AgentRun["nativeSession"]>) {
  if (session.exitCode === undefined) return "pending";
  if (session.exitCode === null) return session.signal ? `Signal ${session.signal}` : "Exit unknown";
  return `Exit ${session.exitCode}`;
}

function nativeSessionTranscriptPreview(session: NonNullable<AgentRun["nativeSession"]>) {
  return session.transcriptPreview ?? [];
}
