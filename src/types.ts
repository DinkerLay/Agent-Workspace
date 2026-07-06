export type View =
  | "capabilities"
  | "delivery"
  | "more"
  | "projects"
  | "mcp"
  | "watcher"
  | "workbench"
  | "backlog"
  | "loops"
  | "review"
  | "teams"
  | "terminals"
  | "browser"
  | "libraries"
  | "notifications"
  | "restore"
  | "audit"
  | "runs";

export type TaskStatus =
  | "todo"
  | "queued"
  | "running"
  | "waiting-input"
  | "pending-review"
  | "failed-verification"
  | "blocked"
  | "done";

export type TaskIntakeSource = "manual-brief" | "watcher" | "screenshot-prototype" | "prompt-context";

export type AgentStatus = "working" | "waiting" | "review" | "idle";

export type Agent = {
  id: string;
  projectId: string;
  runtimeTaskId?: string;
  clusterId: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  status: AgentStatus;
  taskId: string;
  accent: string;
  lastActive: string;
};

export type TaskSessionPlanSession = {
  idSeed?: string;
  name: string;
  role: string;
  provider?: string;
  model?: string;
  accent?: string;
  instructions?: string;
  expectedOutput?: string;
};

export type TaskSessionPlan = {
  templateId?: string;
  defaultModel?: string;
  conductor: TaskSessionPlanSession;
  workers: TaskSessionPlanSession[];
  routePolicy?: {
    allowedTargets?: string[];
    notes?: string[];
  };
  workflow?: string[];
  deliverables?: string[];
  notes?: string[];
};

export type AgentClusterLevel = "project-default" | "task";

export type AgentCluster = {
  id: string;
  projectId: string;
  runtimeTaskId?: string;
  name: string;
  level: AgentClusterLevel;
  agentIds: string[];
  taskId?: string;
  parentClusterId?: string;
  evidencePath: string;
};

export type AgentTemplate = {
  id: string;
  agentIdPrefix: string;
  name: string;
  role: string;
  provider: string;
  model: string;
  accent: string;
  systemPromptPath: string;
  worktreePolicy: "shared" | "isolated";
};

export type AgentProfileEvent = {
  id: string;
  projectId: string;
  agentId: string;
  templateId: string;
  systemPromptPath: string;
  worktreePolicy: AgentTemplate["worktreePolicy"];
  manifestPath: string;
  createdAt: string;
  summary: string;
};

export type Project = {
  id: string;
  runtimeProjectId?: string;
  name: string;
  zone: "work" | "personal" | "side-project";
  path: string;
  status: "active" | "paused" | "watching";
  defaultAgentClusterId: string;
  agentClusterIds: string[];
  agentIds: string[];
  taskIds: string[];
  commandIds: string[];
  browserProfile: string;
};

export type ProjectContextEvent = {
  id: string;
  projectId: string;
  zone: Project["zone"];
  manifestPath: string;
  browserProfile: string;
  selectedAt: string;
  summary: string;
};

export type Task = {
  id: string;
  runtimeTaskId?: string;
  title: string;
  status: TaskStatus;
  source: string;
  owner: string;
  risk: string;
  verification: string;
  summary: string;
  labels?: string[];
  templateId?: string;
  sessionPlan?: TaskSessionPlan;
};

export type TaskIntakeEvent = {
  id: string;
  taskId: string;
  runtimeTaskId?: string;
  source: TaskIntakeSource;
  title: string;
  summary: string;
  labels: string[];
  owner: string;
  templateId?: string;
  sessionPlan?: TaskSessionPlan;
  artifactPath?: string;
  evidencePath: string;
  status: "queued";
  createdAt: string;
};

export type TaskTransitionEvent = {
  id: string;
  taskId: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  summary: string;
  evidencePath: string;
  createdAt: string;
};

export type TaskArtifact = {
  id: string;
  taskId: string;
  kind: "prompt-template" | "screenshot" | "sketch" | "html" | "browser-evidence";
  label: string;
  sourceSurface: "workbench" | "browser" | "mcp";
  sourceArtifactPath: string;
  artifactPath: string;
  addedAt: string;
  summary: string;
};

export type LoopScheduleEvent = {
  id: string;
  taskId: string;
  agentId: string;
  runId: string;
  decision: "start-agent";
  rule: string;
  evidencePath: string;
  createdAt: string;
  summary: string;
};

export type ChangedFile = {
  path: string;
  agentId: string;
  status: "modified" | "added" | "deleted";
  reviewed: boolean;
  additions: number;
  deletions: number;
};

export type ReviewFileSelection = {
  path: string;
  selected: boolean;
  reviewed: boolean;
};

export type RunStatus = "running" | "pending-review" | "failed-verification" | "completed";

export type VerificationStatus = "pending" | "passed" | "failed";

export type VerificationEvidence = {
  command: string;
  status: VerificationStatus;
  summary: string;
  logPath: string;
};

export type VerificationCommandEvent = {
  id: string;
  taskId: string;
  runId: string;
  command: string;
  status: "passed" | "failed";
  artifactPath: string;
  logPath: string;
  createdAt: string;
  summary: string;
};

export type CommitProposal = {
  policy: "proposal-first";
  approved: boolean;
  message: string;
};

export type ReviewApprovalEvent = {
  id: string;
  taskId: string;
  runId: string;
  verificationStatus: VerificationStatus;
  selectedFilePaths: string[];
  redactionArtifactPath?: string;
  commitProposalPath: string;
  evidencePath: string;
  approvedAt: string;
  summary: string;
};

export type ReviewGateEvent = {
  id: string;
  taskId: string;
  runId: string;
  status: "blocked";
  reason: "verification-required" | "redaction-required";
  evidencePath: string;
  createdAt: string;
  summary: string;
};

export type CommitStagingEvent = {
  id: string;
  taskId: string;
  runId: string;
  status: "staged";
  stagedFilePaths: string[];
  unstagedFilePaths: string[];
  evidencePath: string;
  createdAt: string;
  summary: string;
};

export type PullRequestHandoffEvent = {
  id: string;
  taskId: string;
  runId: string;
  branchName: string;
  approvalEvidencePath: string;
  commitProposalPath: string;
  prDraftPath: string;
  status: "draft-ready";
  createdAt: string;
  summary: string;
};

export type WorktreeContext = {
  isolationPolicy: "shared" | "isolated";
  branchName: string;
  worktreePath: string;
  baselineManifestPath: string;
};

export type RuntimePolicy = {
  permissionMode: "ask-before-write" | "read-only" | "auto-approved";
  sandboxMode: "workspace-write" | "read-only" | "danger-full-access";
  effort: "low" | "medium" | "high";
  cliCommand: string;
  policyPath: string;
};

export type CommitRedactionScan = {
  runId: string;
  status: "passed";
  transcriptPath: string;
  artifactPath: string;
  redactedPatterns: string[];
};

export type NativeSessionEvidence = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  backend: "pty" | "process";
  status: "running" | "stopping" | "stopped";
  model?: string;
  exitCode?: number | null;
  signal?: number | string | null;
  transcriptPreview?: string[];
};

export type NativeVerificationEvidence = {
  ok: boolean;
  command: string;
  cwd: string;
  runId: string;
  status: "passed" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: number | string | null;
  durationMs: number;
  artifactPath: string;
  logPath: string;
  error?: string;
};

export type AgentRun = {
  id: string;
  taskId: string;
  agentId: string;
  status: RunStatus;
  startGitSha: string;
  startedAt: string;
  promptPath: string;
  transcriptPath: string;
  diffPath: string;
  verificationPath: string;
  commitPath: string;
  changedFilePaths: string[];
  transcriptPreview: string[];
  nativeSession?: NativeSessionEvidence;
  verification: VerificationEvidence;
  commitProposal: CommitProposal;
  worktreeContext: WorktreeContext;
  runtimePolicy: RuntimePolicy;
};

export type RuntimeEvent = {
  id: string;
  service: "run-store" | "pty-service" | "git-service" | "filesystem-watch";
  action: string;
  summary: string;
  evidence: string;
};

export type TerminalEventKind = "tool-call" | "file-write" | "prompt-wait" | "done-signal" | "process-signal";

export type TerminalEvent = {
  id: string;
  taskId: string;
  runId: string;
  kind: TerminalEventKind;
  ruleId: string;
  mappedStatus: TaskStatus | RunStatus;
  sourceLine: string;
  evidencePath: string;
  createdAt: string;
  summary: string;
};

export type CapabilityPhase = "mvp-core" | "mvp-extension" | "advanced" | "deferred";

export type ProductCapability = {
  id: string;
  title: string;
  phase: CapabilityPhase;
  surface: View;
  contractId: string;
  job: string;
  primaryAction: string;
  stateOwner: string;
  evidence: string;
  interactionPath: string[];
  nextStep: string;
};

export type McpTool = {
  name: string;
  purpose: string;
  permission: "read" | "write" | "confirm";
  evidence: string;
  targetSurface: View;
};

export type McpToolCallStatus = "routed" | "confirmation-required" | "approved" | "denied";

export type McpToolCallDecision = "approved" | "denied";

export type McpToolCallEvent = {
  id: string;
  taskId: string;
  serverId: string;
  toolName: string;
  permission: McpTool["permission"];
  status: McpToolCallStatus;
  evidencePath: string;
  targetSurface: View;
  summary: string;
  decision?: McpToolCallDecision;
  decisionEvidencePath?: string;
  decidedAt?: string;
  decisionSummary?: string;
};

export type McpServer = {
  id: string;
  name: string;
  phase: CapabilityPhase;
  status: "mocked" | "planned";
  stateOwner: string;
  futureStore: string;
  guardrails: string[];
  tools: McpTool[];
};

export type RuntimeContract = {
  id: string;
  name: string;
  purpose: string;
  schedulerOwns: string[];
  agentOwns: string[];
  futureStore: string;
};

export type DevCommand = {
  id: string;
  name: string;
  kind: "frontend" | "backend" | "worker" | "database";
  command: string;
  status: "running" | "stopped" | "failed";
  port?: number;
  log: string;
};

export type DevCommandEvent = {
  id: string;
  commandId: string;
  action: "start" | "stop";
  status: DevCommand["status"];
  summary: string;
  evidencePath: string;
  logPath: string;
  createdAt: string;
};

export type TeamWorkflow = {
  id: string;
  name: string;
  status: "ready" | "running" | "blocked";
  nodes: string[];
  handoff: string;
  maxCycles: number;
};

export type TeamRun = {
  id: string;
  workflowId: string;
  status: "running" | "completed" | "blocked";
  activeNodeIndex: number;
  cycle: number;
  maxCycles: number;
  handoffPayload: string;
  evidencePath: string;
};

export type BrowserTool = {
  name: string;
  purpose: string;
  evidence: string;
};

export type BrowserEvidence = {
  id: string;
  taskId: string;
  toolName: string;
  summary: string;
  artifactPath: string;
  capturedAt: string;
};

export type NotificationEvent = {
  id: string;
  taskId: string;
  level: TaskStatus;
  destination: "sidebar" | "desktop" | "mobile";
  acknowledged: boolean;
  summary: string;
  evidencePath: string;
  createdAt: string;
  sourceEventId?: string;
  sourceLabel?: string;
  sourceEvidencePath?: string;
  sourceSummary?: string;
};

export type WatchSource = {
  id: string;
  label: string;
  root: "research" | "spec" | "plans";
  path: string;
  status: "watching" | "paused";
  purpose: string;
  eventCount: number;
};

export type WatchEvent = {
  id: string;
  sourceId: string;
  path: string;
  changeType: "created" | "modified";
  status: "detected" | "task-created";
  summary: string;
  impact: string;
  detectedAt: string;
  evidencePath: string;
  plannerTaskId?: string;
};

export type RestoreProcessClass = "agent-pty" | "dev-command";

export type RestoreProcessRecord = {
  id: string;
  label: string;
  processClass: RestoreProcessClass;
  workingDir: string;
  commandLine: string;
  rollbackIntent: string;
  metadataPath: string;
};

export type RestoreContextKind =
  | "active-run"
  | "browser-evidence"
  | "redaction-scan"
  | "mcp-audit"
  | "team-run"
  | "notification";

export type RestoreContextRecord = {
  id: string;
  kind: RestoreContextKind;
  label: string;
  status: string;
  summary: string;
  artifactPath: string;
  taskId?: string;
};

export type RestoreManifest = {
  id: string;
  projectPath: string;
  activeView: View;
  selectedTaskId: string;
  selectedAgentClusterId: string;
  selectedAgentId: string;
  capturedAt: string;
  manifestPath: string;
  processRecords: RestoreProcessRecord[];
  contextRecords: RestoreContextRecord[];
};

export type LibraryItem = {
  id: string;
  kind: "prompt" | "skill";
  name: string;
  scope: "project" | "personal" | "runtime";
  target: string;
};

export type PromptLibrarySave = {
  id: string;
  taskId: string;
  sourceDraftPath: string;
  targetPath: string;
  artifactPath: string;
  savedAt: string;
};

export type ScratchpadItem = {
  id: string;
  kind: "prompt-template" | "screenshot" | "sketch" | "html";
  label: string;
  summary: string;
  insertText: string;
  artifactPath: string;
};

export type PrototypeState = {
  activeView: View;
  projects: Project[];
  selectedProjectId: string;
  projectContextEvents: ProjectContextEvent[];
  agentClusters: AgentCluster[];
  selectedAgentClusterId: string;
  agents: Agent[];
  agentTemplates: AgentTemplate[];
  agentProfileEvents: AgentProfileEvent[];
  selectedAgentId: string;
  reviewAgentId: string;
  reviewFileSelections: ReviewFileSelection[];
  commitConversationIncluded: boolean;
  commitRedactionScans: CommitRedactionScan[];
  commitStagingEvents: CommitStagingEvent[];
  reviewApprovalEvents: ReviewApprovalEvent[];
  reviewGateEvents: ReviewGateEvent[];
  pullRequestHandoffEvents: PullRequestHandoffEvent[];
  verificationEvents: VerificationCommandEvent[];
  tasks: Task[];
  taskIntakeEvents: TaskIntakeEvent[];
  taskTransitionEvents: TaskTransitionEvent[];
  taskArtifacts: TaskArtifact[];
  runs: AgentRun[];
  devCommands: DevCommand[];
  devCommandEvents: DevCommandEvent[];
  selectedMcpServerId: string;
  mcpToolEvents: McpToolCallEvent[];
  selectedTeamWorkflowId: string;
  teamRuns: TeamRun[];
  activePromptTemplateId?: string;
  attachedSkillIds: string[];
  promptLibrarySaves: PromptLibrarySave[];
  activeBrowserToolName: string;
  browserEvidence: BrowserEvidence[];
  notificationEvents: NotificationEvent[];
  watchSources: WatchSource[];
  watchEvents: WatchEvent[];
  restoreManifest?: RestoreManifest;
  runtimeEvents: RuntimeEvent[];
  terminalEvents: TerminalEvent[];
  loopScheduleEvents: LoopScheduleEvent[];
  selectedTaskId: string;
  terminalLines: string[];
  prompt: string;
  scratchpadItems: ScratchpadItem[];
  scratchpadAttachmentIds: string[];
  scratchpadDraftPath: string;
  scratchpadSavedAt: string;
};

export type PrototypeAction =
  | { type: "set-view"; view: View }
  | { type: "select-project"; projectId: string }
  | { type: "open-runtime-project"; projectPath: string; projectName: string }
  | { type: "select-mcp-server"; serverId: string }
  | { type: "request-mcp-tool-call"; serverId: string; toolName: string }
  | { type: "resolve-mcp-tool-call"; eventId: string; decision: McpToolCallDecision }
  | { type: "add-agent-from-template"; templateId: string }
  | { type: "select-agent-cluster"; clusterId: string }
  | { type: "select-agent"; agentId: string }
  | { type: "select-review-agent"; agentId: string }
  | { type: "toggle-review-file"; path: string }
  | { type: "toggle-commit-conversation" }
  | { type: "run-commit-redaction-scan"; taskId: string }
  | { type: "stage-review-files"; taskId: string }
  | { type: "run-verification-command"; taskId: string }
  | { type: "create-pr-handoff"; runId: string }
  | { type: "select-task"; taskId: string }
  | { type: "clear-selected-task" }
  | { type: "set-prompt"; prompt: string }
  | { type: "send-prompt" }
  | { type: "insert-scratchpad-item"; itemId: string }
  | { type: "attach-scratchpad-artifact"; itemId: string }
  | { type: "save-scratchpad-draft" }
  | { type: "start-agent"; taskId: string }
  | { type: "start-dev-command"; commandId: string }
  | { type: "stop-dev-command"; commandId: string }
  | { type: "select-team-workflow"; workflowId: string }
  | { type: "start-team-run" }
  | { type: "advance-team-run" }
  | { type: "inject-library-prompt"; itemId: string }
  | { type: "attach-library-skill"; itemId: string }
  | { type: "select-browser-tool"; toolName: string }
  | { type: "capture-browser-evidence" }
  | { type: "create-planner-task-from-watch"; eventId: string }
  | {
      type: "create-task-from-intake";
      title: string;
      summary: string;
      labels: string[];
      intakeSource: TaskIntakeSource;
      owner: string;
      templateId: string;
      model: string;
      artifactPath?: string;
      sessionPlan?: TaskSessionPlan;
    }
  | { type: "route-notification" }
  | { type: "open-notification-context"; eventId: string }
  | { type: "acknowledge-notification"; eventId: string }
  | { type: "open-audit-entry-context"; entryId: string }
  | { type: "capture-restore-manifest" }
  | { type: "restore-workspace-session" }
  | {
      type: "runtime-started-agent";
      taskId: string;
      agentId: string;
      run: AgentRun;
      terminalLines: string[];
      runtimeEvents: RuntimeEvent[];
    }
  | {
      type: "attach-native-session-evidence";
      taskId: string;
      agentId: string;
      session: Omit<NativeSessionEvidence, "transcriptPreview"> & { transcript?: string[] };
    }
  | {
      type: "attach-native-verification-evidence";
      taskId: string;
      runId: string;
      result: NativeVerificationEvidence;
    }
  | { type: "runtime-start-failed"; reason: string }
  | { type: "apply-terminal-signal"; eventId: string }
  | { type: "agent-claims-done"; taskId: string }
  | { type: "verification-failed"; taskId: string }
  | { type: "approve-review"; taskId: string }
  | { type: "advance-task"; taskId: string };
