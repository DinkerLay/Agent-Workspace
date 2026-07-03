import type { PrototypeState } from "../types";

export type AuditTrailEntry = {
  id: string;
  surface: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  evidencePath: string;
  createdAt: string;
  taskId?: string;
  runId?: string;
  sourceLabel?: string;
  sourceEventId?: string;
  sourceEvidencePath?: string;
  sourceSummary?: string;
};

const FALLBACK_TIME = "0000-00-00T00:00:00Z";

export function buildWorkspaceAuditTrail(state: PrototypeState): AuditTrailEntry[] {
  const entries: AuditTrailEntry[] = [
    ...state.projectContextEvents.map((event) => ({
      id: event.id,
      surface: "Projects",
      kind: "Project context",
      title: event.summary,
      summary: `Zone ${event.zone}; browser profile ${event.browserProfile}`,
      status: "selected",
      evidencePath: event.manifestPath,
      createdAt: event.selectedAt,
    })),
    ...state.agentProfileEvents.map((event) => ({
      id: event.id,
      surface: "Projects",
      kind: "Agent profile",
      title: event.summary,
      summary: `${event.templateId}; ${event.worktreePolicy} worktree; prompt ${event.systemPromptPath}`,
      status: "profile-created",
      evidencePath: event.manifestPath,
      createdAt: event.createdAt,
    })),
    ...state.watchEvents.map((event) => ({
      id: event.id,
      surface: "Plan Watcher",
      kind: "Filesystem watch",
      title: event.summary,
      summary: event.impact,
      status: event.status,
      evidencePath: event.evidencePath,
      createdAt: event.detectedAt,
      taskId: event.plannerTaskId,
    })),
    ...state.taskIntakeEvents.map((event) => ({
      id: event.id,
      surface: "Task Board",
      kind: "Task intake",
      title: `Captured ${event.title}`,
      summary: `${event.source}; labels ${event.labels.join(", ") || "none"}; artifact ${
        event.artifactPath ?? "none"
      }`,
      status: event.status,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.taskTransitionEvents.map((event) => ({
      id: event.id,
      surface: "Task Board",
      kind: "Task transition",
      title: event.summary,
      summary: `${event.fromStatus} -> ${event.toStatus}`,
      status: event.toStatus,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.taskArtifacts.map((artifact) => ({
      id: artifact.id,
      surface: "Task Board",
      kind: "Task artifact",
      title: artifact.summary,
      summary: `${artifact.sourceSurface}; source ${artifact.sourceArtifactPath}`,
      status: artifact.kind,
      evidencePath: artifact.artifactPath,
      createdAt: artifact.addedAt,
      taskId: artifact.taskId,
    })),
    ...state.loopScheduleEvents.map((event) => ({
      id: event.id,
      surface: "Loop Console",
      kind: "Loop schedule",
      title: event.summary,
      summary: `${event.rule}; run ${event.runId}`,
      status: event.decision,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.runs.map((run) => ({
      id: `run-${run.id}`,
      surface: "Runs",
      kind: "AgentRun",
      title: `AgentRun ${run.id}`,
      summary: `${run.agentId} ${run.status}; verification ${run.verification.status}`,
      status: run.status,
      evidencePath: run.transcriptPath,
      createdAt: run.startedAt,
      taskId: run.taskId,
    })),
    ...state.runs.map((run) => ({
      id: `run-policy-${run.id}`,
      surface: "Runs",
      kind: "Runtime policy",
      title: `Runtime policy ${run.id}`,
      summary: `${run.runtimePolicy.permissionMode}; ${run.runtimePolicy.sandboxMode}; effort ${run.runtimePolicy.effort}; command ${run.runtimePolicy.cliCommand}`,
      status: run.runtimePolicy.permissionMode,
      evidencePath: run.runtimePolicy.policyPath,
      createdAt: run.startedAt,
      taskId: run.taskId,
    })),
    ...state.terminalEvents.map((event) => ({
      id: event.id,
      surface: "Runs",
      kind: "Terminal event",
      title: event.summary,
      summary: `${event.ruleId}; ${event.kind} -> ${event.mappedStatus}; source ${event.sourceLine}`,
      status: event.kind,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.verificationEvents.map((event) => ({
      id: event.id,
      surface: "Review",
      kind: "Verification command",
      title: `Verification ${event.status} for ${event.runId}`,
      summary: `${event.command}; log ${event.logPath}`,
      status: event.status,
      evidencePath: event.artifactPath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.commitStagingEvents.map((event) => ({
      id: event.id,
      surface: "Review",
      kind: "Git staging",
      title: event.summary,
      summary: `${event.runId}; staged ${event.stagedFilePaths.length}; unstaged ${event.unstagedFilePaths.length}`,
      status: event.status,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.reviewApprovalEvents.map((event) => ({
      id: event.id,
      surface: "Review",
      kind: "Review approval",
      title: event.summary,
      summary: `${event.runId}; commit ${event.commitProposalPath}`,
      status: "approved",
      evidencePath: event.evidencePath,
      createdAt: event.approvedAt,
      taskId: event.taskId,
    })),
    ...state.reviewGateEvents.map((event) => ({
      id: event.id,
      surface: "Review",
      kind: "Review gate",
      title: event.summary,
      summary: `${event.runId}; ${event.reason}`,
      status: event.status,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.pullRequestHandoffEvents.map((event) => ({
      id: event.id,
      surface: "Runs",
      kind: "PR handoff",
      title: event.summary,
      summary: `${event.branchName}; commit ${event.commitProposalPath}`,
      status: event.status,
      evidencePath: event.prDraftPath,
      createdAt: event.createdAt,
      taskId: event.taskId,
    })),
    ...state.runtimeEvents.map((event, index) => ({
      id: event.id,
      surface: "Runtime Adapter",
      kind: "Runtime event",
      title: `${event.service}.${event.action}`,
      summary: event.summary,
      status: event.service,
      evidencePath: event.evidence,
      createdAt: fallbackTime(index),
    })),
    ...state.devCommandEvents.map((event) => ({
      id: event.id,
      surface: "Dev Terminals",
      kind: "Command lifecycle",
      title: event.summary,
      summary: `${event.action}; log ${event.logPath}`,
      status: event.status,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
    })),
    ...state.mcpToolEvents.map((event, index) => ({
      id: event.id,
      surface: "MCP Gateway",
      kind: "MCP tool call",
      title: event.decisionSummary ?? event.summary,
      summary: `${event.serverId}.${event.toolName}; ${event.permission}; evidence ${event.evidencePath}`,
      status: event.status,
      evidencePath: event.decisionEvidencePath ?? event.evidencePath,
      createdAt: event.decidedAt ?? fallbackTime(index),
      taskId: event.taskId,
    })),
    ...state.teamRuns.map((run, index) => ({
      id: run.id,
      surface: "Teams",
      kind: "TeamRun",
      title: `TeamRun ${run.id}`,
      summary: `Active node index ${run.activeNodeIndex}; cycle ${run.cycle}/${run.maxCycles}`,
      status: run.status,
      evidencePath: run.evidencePath,
      createdAt: fallbackTime(index),
    })),
    ...state.browserEvidence.map((event) => ({
      id: event.id,
      surface: "Browser",
      kind: "Browser evidence",
      title: event.summary,
      summary: `${event.toolName} evidence for ${event.taskId}`,
      status: event.toolName,
      evidencePath: event.artifactPath,
      createdAt: event.capturedAt,
      taskId: event.taskId,
    })),
    ...state.notificationEvents.map((event) => ({
      id: event.id,
      surface: "Notifications",
      kind: "Notification",
      title: event.summary,
      summary: `${event.destination}; ${event.acknowledged ? "acknowledged" : "unacknowledged"}${
        event.sourceEventId ? `; source ${event.sourceLabel ? `${event.sourceLabel} ` : ""}${event.sourceEventId}` : ""
      }`,
      status: event.level,
      evidencePath: event.evidencePath,
      createdAt: event.createdAt,
      taskId: event.taskId,
      sourceLabel: event.sourceLabel,
      sourceEventId: event.sourceEventId,
      sourceEvidencePath: event.sourceEvidencePath,
      sourceSummary: event.sourceSummary,
    })),
    ...state.promptLibrarySaves.map((event) => ({
      id: event.id,
      surface: "Libraries",
      kind: "Prompt save",
      title: `Saved Scratchpad draft for ${event.taskId}`,
      summary: `${event.sourceDraftPath} -> ${event.targetPath}`,
      status: "saved",
      evidencePath: event.artifactPath,
      createdAt: event.savedAt,
      taskId: event.taskId,
    })),
    ...state.commitRedactionScans.map((scan, index) => {
      const run = state.runs.find((item) => item.id === scan.runId);
      return {
        id: `redaction-${scan.runId}`,
        surface: "Review",
        kind: "Redaction scan",
        title: `Agent-Conversation redaction for ${scan.runId}`,
        summary: `${scan.runId}; transcript ${scan.transcriptPath}; patterns ${scan.redactedPatterns.join(", ")}`,
        status: scan.status,
        evidencePath: scan.artifactPath,
        createdAt: fallbackTime(index),
        taskId: run?.taskId,
        runId: scan.runId,
      };
    }),
    ...(state.restoreManifest
      ? [
          {
            id: state.restoreManifest.id,
            surface: "Restore",
            kind: "Restore manifest",
            title: `Restore manifest ${state.restoreManifest.id}`,
            summary: `${state.restoreManifest.activeView}; ${state.restoreManifest.processRecords.length} process records; ${state.restoreManifest.contextRecords.length} context records`,
            status: "captured",
            evidencePath: state.restoreManifest.manifestPath,
            createdAt: state.restoreManifest.capturedAt,
            taskId: state.restoreManifest.selectedTaskId,
          },
        ]
      : []),
  ];

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function fallbackTime(index: number) {
  return `${FALLBACK_TIME}-${String(index).padStart(3, "0")}`;
}
