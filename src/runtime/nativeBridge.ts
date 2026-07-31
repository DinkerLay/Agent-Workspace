import type {
  CallSessionInput,
  CallSessionResult,
  ReadSessionInput,
  ReadSessionResult,
  ReadTaskStateInput,
  ReadTaskStateResult,
  SessionEventType,
  SessionStoreEvent,
} from "../orchestration/conductor-tools";
import type { TaskSessionPlan } from "../types";
import type { OpencodeProcessStat } from "./opencode";

export type NativeRuntimeStatus = {
  available: boolean;
  mode: "browser" | "desktop";
  message: string;
  opencodePath?: string;
  opencodeVersion?: string;
  ptyAvailable?: boolean;
  ptyBackend?: string;
  conductorToolBridgeUrl?: string;
  conductorToolBridgeToken?: string;
  conductorMcpServerPath?: string;
};

export type NativeOpencodeInput = {
  cwd: string;
  message: string;
  model?: string;
};

export type NativeOpencodeResult = {
  ok: boolean;
  command: string;
  cwd: string;
  model?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
};

export type NativeTaskDraft = {
  projectPath?: string;
  projectName?: string;
  title?: string;
  summary?: string;
  templateId?: string;
  model?: string;
  labels?: string[];
  artifactPath?: string;
  outputHints?: string[];
  agentHints?: string[];
  sessionPlan?: TaskSessionPlan;
};

export type NativeTaskDraftInput = {
  message: string;
  projectPath: string;
  projectName?: string;
  model?: string;
  currentDraft?: NativeTaskDraft;
};

export type NativeTaskDraftResult = {
  ok: boolean;
  assistantMessage: string;
  draft?: NativeTaskDraft;
  draftPatch?: NativeTaskDraft;
  sessionPlan?: TaskSessionPlan;
  sessionPlanPatch?: TaskSessionPlan;
  missingFields: string[];
  assumptions: string[];
  command?: string;
  cwd?: string;
  raw?: string;
  error?: string;
};

export type NativeOpencodeAgent = {
  name: string;
  kind: string;
};

export type NativeOpencodeAgentListResult = {
  ok: boolean;
  agents: NativeOpencodeAgent[];
  stdout?: string;
  stderr?: string;
};

export type NativeOpencodeProcessInspection = {
  ok: boolean;
  processes: OpencodeProcessStat[];
  error?: string;
};

export type NativeVerificationInput = {
  cwd: string;
  runId: string;
  command: string;
  timeoutMs?: number;
};

export type NativeVerificationResult = {
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

export type NativePtySession = {
  id: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  model?: string;
  backend: "pty" | "process";
  status: "running" | "stopping" | "stopped";
  cols: number;
  rows: number;
  stdin?: "pipe" | "ignore";
  transcript: string[];
  cursor?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: number | string | null;
  incarnationId?: string;
  generation?: string;
  requiresSnapshot?: boolean;
  output?: {
    retainedBytes: number;
    maxBytes: number;
    earliestSequence: number;
    latestSequence: number;
  };
};

export type NativeTerminalSnapshot = {
  ansi: string;
  cursor: number;
  modelSequence: number;
  cols: number;
  rows: number;
  scrollback: number;
  bufferMode?: "normal" | "alternate";
};

export type NativeTerminalAttachResult = {
  snapshot: NativeTerminalSnapshot;
  attachment: {
    ready: boolean;
    restoreRequired: boolean;
    snapshotPending?: boolean;
    deliveredCursor: number;
    acknowledgedCursor: number;
  };
  session: NativePtySession;
};

export type NativeRuntimeFile = {
  relativePath: string;
  contents: string;
};

export type NativePtyEvent =
  | {
      type: "data";
      id: string;
      chunk: string;
      cursor: number;
      incarnationId?: string;
      generation?: string;
      requiresSnapshot?: boolean;
    }
  | {
      type: "exit";
      id: string;
      status: "stopped";
      exitCode?: number | null;
      signal?: number | string | null;
      cursor: number;
      incarnationId?: string;
      generation?: string;
    };

export type NativeTerminalClientEvent =
  | {
      type: "data";
      id: string;
      chunk: string;
      startCursor: number;
      cursor: number;
      generation: string;
      incarnationId?: string;
      bufferMode?: "normal" | "alternate";
    }
  | {
      type: "restore-required";
      id: string;
      generation: string;
    };

/**
 * A lightweight durable-state invalidation. It carries no terminal bytes or
 * Provider answer; the renderer re-reads the Run from Runtime storage.
 */
export type NativeAgentLoopRuntimeEvent = {
  taskId: string;
  runId: string;
  sessionId?: string;
  type: string;
  cursor?: number;
};

export type NativeWorkspaceSessionProfileInput = {
  workspaceSessionId: string;
  taskId: string;
  provider: "opencode";
  cwd: string;
  model?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  runtimeFiles?: NativeRuntimeFile[];
};

export type NativeWorkspaceSessionActivation = {
  disposition: "created" | "adopted" | "replayed";
  workspaceSessionId: string;
  owner: {
    workspaceSessionId: string;
    taskId: string;
    ptyId: string;
    incarnationId: string;
    generation: string;
    state: string;
  };
  session?: NativePtySession;
};

export type NativeTerminalInputSource = "startup" | "user" | "user_message" | "permission_reply" | "dispatch" | "conductor_wakeup";

export type NativeTerminalInputResult = {
  disposition: "written";
  workspaceSessionId: string;
  incarnationId: string;
  source: NativeTerminalInputSource;
  result?: NativePtySession;
};

export type NativeTaskEventInput = {
  taskId: string;
  sessionId?: string;
  cwd: string;
  type: Extract<SessionEventType, "task.user_message" | "user.intervention">;
  summary: string;
  data?: Record<string, unknown>;
};

export type NativeTaskEventResult = {
  ok: boolean;
  event?: SessionStoreEvent;
  taskState?: ReadTaskStateResult;
  error?: string;
};

export type NativeOrchestrationTemplate = {
  id: string;
  family: "agent_loop" | "workflow";
  version: number;
  name: string;
  definition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type NativeTemplateBlueprint = {
  id: string;
  version: number;
  name: string;
  description: string;
  source: "seed" | "generated" | "manual";
  agentLoopTemplate: { id: string; version: number; family: "agent_loop" };
  workflowTemplate: { id: string; version: number; family: "workflow" };
  createdAt: string;
  updatedAt: string;
};

export type NativeTemplateBlueprintReference = Pick<
  NativeTemplateBlueprint,
  "id" | "version" | "name" | "description" | "source" | "agentLoopTemplate" | "workflowTemplate"
>;

export type NativeGeneratedArchitectureDraft = {
  draftId: string;
  cwd: string;
  title: string;
  goal: string;
  model: string;
  status: "generated" | "manual" | "saved";
  candidate: {
    blueprint: {
      id: string;
      name: string;
      description: string;
    };
    agentLoop: {
      id: string;
      name: string;
      definition: { conductor: { provider: "opencode"; role: string } };
    };
    workflow: {
      id: string;
      name: string;
      definition: {
        nodes: Array<{ id: string; role: string; instruction?: string; kind: "delegate" | "verify"; dependsOn: string[] }>;
        wakeOn: string[];
      };
    };
    rationale: string;
    assumptions: string[];
  };
  savedTemplates?: {
    agentLoop: { id: string; version: number; family: "agent_loop"; name: string };
    workflow: { id: string; version: number; family: "workflow"; name: string };
    blueprint: NativeTemplateBlueprintReference;
  };
  createdAt: string;
  updatedAt: string;
};

export type NativeHarnessTask = {
  taskId: string;
  projectId: string;
  cwd: string;
  title: string;
  goal: string;
  architectureId: string;
  architecture: {
    id?: string;
    primaryMode?: "agent_loop" | "workflow";
    templateBlueprint?: NativeTemplateBlueprintReference;
    agentLoopTemplate?: { id: string; version: number; family: "agent_loop"; name: string };
    nestedWorkflowTemplate?: { id: string; version: number; family: "workflow"; name: string };
    sessionPlan?: {
      provider?: "opencode";
      model?: string;
      conductor?: string;
      workflowRoles?: Array<{ id: string; role: string }>;
      loopRoles?: Array<{ id: string; role: string; kind: string }>;
      deliveryContract?: {
        evidence?: Array<{ nodeId: string; path: string; format: "markdown"; kind: "evidence" | "verification" }>;
        finalArtifact?: { path: string; format: "html" | "markdown" | "json" | "text" };
        publisher?: { id: string; role: string };
      };
    };
  };
  status: "queued" | "running" | "delivery_ready" | "achieved" | "ready_for_review" | "blocked";
  createdAt: string;
  updatedAt: string;
  latestRun?: NativeHarnessRun;
};

export type NativeHarnessRun = {
  runId: string;
  taskId: string;
  architectureId: string;
  status: "running" | "delivery_ready" | "ready_for_review" | "blocked";
  agentLoopInstanceId: string;
  workflowInstanceId: string;
  createdAt: string;
  updatedAt: string;
};

export type NativeHarnessAttention = {
  attentionId: string;
  runId: string;
  turnId: string;
  sessionId: string;
  kind: "permission" | "question";
  status: "pending" | "submitted" | "resolved";
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
};

export type NativeHarnessRunDetail = {
  task: NativeHarnessTask;
  run: NativeHarnessRun;
  instances: Array<{
    instanceId: string;
    kind: "agent_loop" | "workflow";
    parentInstanceId?: string;
    templateId: string;
    templateVersion: number;
    status: string;
    phase: string;
    details: Record<string, unknown>;
  }>;
  workflow?: { instanceId: string; status: string; phase: string };
  nodes: Array<{
    instanceId: string;
    nodeId: string;
    role: string;
    instruction?: string;
    kind?: "delegate" | "verify";
    dependencies: string[];
    status: string;
    output?: { answerText?: string; errorText?: string; artifacts?: NativeHarnessArtifact[] };
    details?: Record<string, unknown>;
  }>;
  turns: Array<{
    turnId: string;
    sessionId: string;
    purpose: "initial" | "workflow_node" | "workflow_return" | "session_return" | "remediation" | "remediation_verify";
    nodeId?: string;
    status: string;
    details?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
    updatedAt?: string;
    output?: { answerText?: string; errorText?: string; artifacts?: NativeHarnessArtifact[]; decision?: "launch_workflow" | "dispatch" | "verify" | "deliver" | "block" | "remediate"; action?: "launch_workflow" | "dispatch" | "verify" | "deliver" | "block"; remediations?: Array<{ nodeId: string; instruction: string }> };
    terminal?: NativePtySession;
  }>;
  artifacts: NativeHarnessArtifact[];
  attentions: NativeHarnessAttention[];
  events: Array<{
    runId: string;
    sequence: number;
    type: string;
    summary: string;
    data: Record<string, unknown>;
    createdAt: string;
  }>;
};

export type NativeHarnessArtifact = {
  path: string;
  absolutePath?: string;
  change: "added" | "modified";
  size: number;
  digest: string;
  previewable: boolean;
  turnId?: string;
  sessionId?: string;
  nodeId?: string;
  purpose?: string;
  exists?: boolean;
  content?: string;
  contentType?: "markdown" | "html" | "text" | "unsupported" | "missing";
};

/** The active product model. Workflow/graph types above are retained only to
 * read historical local data during the migration. */
export type NativeSessionAgentCard = {
  id: string;
  name: string;
  /** Stable capability label for Conductor context and UI; it does not route the Loop. */
  kind: "researcher" | "publisher" | "reviewer" | "general";
  role: string;
  model: string;
  /** Empty means the native Session Agent is not capability-restricted. */
  mcp: string[];
  /** Empty means the native Session Agent is not capability-restricted. */
  skills: string[];
  instructions: string;
  expectedOutput: string;
};

export type NativeAgentLoopTemplate = {
  id: string;
  version: number;
  name: string;
  source: "seed" | "generated" | "manual";
  conductor: { role: string; model: string; charter?: string };
  agents: NativeSessionAgentCard[];
  limits: { maxConcurrentSessions: number; maxDispatchesPerDecision: number };
  /** Optional delivery-path preference, not a Runtime completion gate. */
  delivery: { artifactPath: string; ownerAgentId: string };
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type NativeGeneratedAgentLoopTemplateDraft = {
  /**
   * A generation result is deliberately not persisted. The renderer must put
   * it through the normal Template editor and the user must save it.
   */
  template: Omit<NativeAgentLoopTemplate, "version" | "archivedAt" | "createdAt" | "updatedAt">;
  assistantMessage: string;
  assumptions: string[];
};

export type NativeAgentLoopTask = {
  taskId: string;
  projectId: string;
  cwd: string;
  title: string;
  goal: string;
  architecture: {
    primaryMode: "agent_loop";
    template: Pick<NativeAgentLoopTemplate, "id" | "version" | "name" | "conductor" | "agents" | "limits" | "delivery">;
    defaultModel: string;
    agentCards: NativeSessionAgentCard[];
    delivery: { artifactPath: string; ownerAgentId: string };
  };
  status: "queued" | "running" | "delivery_ready" | "stopped" | "achieved" | "archived";
  createdAt: string;
  updatedAt: string;
  latestRun?: NativeAgentLoopRun;
};

export type NativeAgentLoopRun = {
  runId: string;
  taskId: string;
  status: "running" | "recovery_required" | "delivery_ready" | "stopped" | "achieved" | "failed";
  conductorSessionId: string;
  createdAt: string;
  updatedAt: string;
};

export type NativeAgentLoopWorkbenchLayoutNode =
  | { type: "leaf"; groupId: string }
  | {
      type: "split";
      /** horizontal is a left/right split; vertical is a top/bottom split. */
      direction: "horizontal" | "vertical";
      ratio: number;
      first: NativeAgentLoopWorkbenchLayoutNode;
      second: NativeAgentLoopWorkbenchLayoutNode;
    };

export type NativeAgentLoopWorkbenchLayout = {
  version: 1;
  /** Auto-placement is used only until the user explicitly moves or splits a Group. */
  placementMode?: "auto" | "manual";
  root: NativeAgentLoopWorkbenchLayoutNode;
  groups: Record<string, { id: string; sessionIds: string[]; activeSessionId?: string; fontSize?: number }>;
  focusedGroupId: string;
};

export type NativeAgentLoopRunDetail = {
  task: NativeAgentLoopTask;
  run: NativeAgentLoopRun;
  instances: Array<{ instanceId: string; kind: "agent_loop"; status: string; phase: string; details: Record<string, unknown> }>;
  turns: Array<{
    turnId: string;
    runId: string;
    instanceId: string;
    nodeId: string;
    sessionId: string;
    purpose: "conductor" | "session_agent";
    /** Provider/dispatch outcome; intentionally independent from PTY liveness. */
    status: string;
    terminalStatus?: "live" | "stopping" | "stopped" | "not_started" | string;
    dispatchStatus?: string;
    output?: { answerText?: string };
    details: {
      card: NativeSessionAgentCard | {
        id: "conductor";
        name: string;
        kind: "conductor";
        role: string;
        model: string;
        mcp: string[];
        skills: string[];
      };
      dispatches: Array<Record<string, unknown>>;
      runtimeState?: string;
    };
    terminal?: NativePtySession;
    startedAt?: string;
    completedAt?: string;
  }>;
  artifacts: Array<{ path: string; change: "added" | "modified" | "expected"; exists: boolean; size?: number; previewable?: boolean }>;
  attentions: Array<Record<string, unknown>>;
  events: Array<{ runId: string; sequence: number; type: string; summary: string; data: Record<string, unknown>; createdAt: string }>;
  runtimeState: ReadTaskStateResult;
  workbenchLayout: NativeAgentLoopWorkbenchLayout;
  /** Present for current Runtime responses; optional for restored historical fixture data. */
  continuity?: {
    state: "connected" | "recovery_required" | "stopping" | "closed";
    terminalStatus: string;
    canSend: boolean;
    message: string;
  };
};

export type NativeAgentLoopArtifact = {
  path: string;
  absolutePath?: string;
  exists: boolean;
  size?: number;
  contentType: "markdown" | "html" | "text" | "missing";
  content?: string;
};

export type NativeTerminalDiagnosticLog = {
  sessionId: string;
  content: string;
  bytes: number;
  truncated: boolean;
};

export type NativeRuntimeBridge = {
  getRuntimeStatus(): Promise<NativeRuntimeStatus>;
  runOpencode(input: NativeOpencodeInput): Promise<NativeOpencodeResult>;
  generateTaskDraft?(input: NativeTaskDraftInput): Promise<NativeTaskDraftResult>;
  listOpencodeAgents?(): Promise<NativeOpencodeAgentListResult>;
  inspectOpencodeProcesses?(): Promise<NativeOpencodeProcessInspection>;
  runVerification?(input: NativeVerificationInput): Promise<NativeVerificationResult>;
  registerWorkspaceSessionProfile?(input: NativeWorkspaceSessionProfileInput): Promise<{
    workspaceSessionId: string;
    fingerprint: string;
    taskId: string;
  }>;
  activateWorkspaceSession?(input: {
    workspaceSessionId: string;
    operationId: string;
  }): Promise<NativeWorkspaceSessionActivation>;
  readWorkspaceSession?(input: { workspaceSessionId: string; cursor: number }): Promise<NativePtySession | undefined>;
  readWorkspaceTerminalLog?(input: {
    taskId: string;
    workspaceSessionId: string;
    maxBytes?: number;
  }): Promise<NativeTerminalDiagnosticLog | undefined>;
  attachTerminalClient?(input: { sessionId: string; clientId: string; generation: string }): Promise<NativeTerminalAttachResult | undefined>;
  acknowledgeTerminalOutput?(input: { sessionId: string; clientId: string; generation: string; cursor: number }): Promise<{
    accepted: boolean;
    reason?: string;
  }>;
  detachTerminalClient?(input: { clientId: string; generation: string }): Promise<boolean>;
  enqueueTerminalInput?(input: {
    workspaceSessionId: string;
    expectedIncarnationId: string;
    source: NativeTerminalInputSource;
    payload: string;
    idempotencyKey?: string;
  }): Promise<NativeTerminalInputResult>;
  resizeWorkspaceSession?(input: {
    workspaceSessionId: string;
    expectedIncarnationId?: string;
    cols: number;
    rows: number;
  }): Promise<NativePtySession | undefined>;
  stopWorkspaceSession?(input: {
    workspaceSessionId: string;
    expectedIncarnationId?: string;
  }): Promise<NativePtySession | undefined>;
  /**
   * Vitest fixture compatibility only. The production preload intentionally
   * does not expose these direct PTY capabilities.
   */
  startPty?(input: {
    id?: string;
    taskId?: string;
    command: string;
    args?: string[];
    cwd: string;
    model?: string;
    cols?: number;
    rows?: number;
    stdin?: "pipe" | "ignore";
    requirePty?: boolean;
    env?: Record<string, string>;
    runtimeFiles?: NativeRuntimeFile[];
  }): Promise<NativePtySession>;
  getPty?(input: { id: string }): Promise<NativePtySession | undefined>;
  readPty?(input: { id: string; cursor: number }): Promise<NativePtySession | undefined>;
  writePty?(input: { id: string; text: string }): Promise<NativePtySession | undefined>;
  resizePty?(input: { id: string; cols: number; rows: number }): Promise<NativePtySession | undefined>;
  stopPty?(input: { id: string }): Promise<NativePtySession | undefined>;
  onPtyEvent?(callback: (event: NativePtyEvent) => void): () => void;
  onTerminalClientEvent?(callback: (event: NativeTerminalClientEvent) => void): () => void;
  onAgentLoopRuntimeEvent?(callback: (event: NativeAgentLoopRuntimeEvent) => void): () => void;
  callSession?(input: CallSessionInput): Promise<CallSessionResult>;
  callSessions?(input: { taskId: string; dispatches: CallSessionInput[] }): Promise<{ ok: boolean; results: CallSessionResult[] }>;
  readTaskState?(input: ReadTaskStateInput): Promise<ReadTaskStateResult | undefined>;
  readSession?(input: ReadSessionInput): Promise<ReadSessionResult | undefined>;
  appendTaskEvent?(input: NativeTaskEventInput): Promise<NativeTaskEventResult>;
  listAgentLoopTemplates?(): Promise<NativeAgentLoopTemplate[]>;
  generateAgentLoopTemplate?(input: { cwd: string; projectName?: string; brief: string; model?: string }): Promise<NativeGeneratedAgentLoopTemplateDraft>;
  saveAgentLoopTemplate?(input: Omit<NativeAgentLoopTemplate, "version" | "archivedAt" | "createdAt" | "updatedAt">): Promise<NativeAgentLoopTemplate>;
  copyAgentLoopTemplate?(input: { templateId: string; name?: string }): Promise<NativeAgentLoopTemplate>;
  archiveAgentLoopTemplate?(input: { templateId: string }): Promise<NativeAgentLoopTemplate>;
  deleteAgentLoopTemplate?(input: { templateId: string }): Promise<{ deleted: boolean; templateId: string }>;
  validateAgentLoopProjectDirectory?(input: { path: string }): Promise<{ path: string; name: string } | undefined>;
  suggestAgentLoopProjectDirectories?(input: { prefix: string }): Promise<string[]>;
  createAgentLoopTask?(input: { taskId?: string; projectId?: string; cwd: string; title: string; goal: string; templateId?: string; templateVersion?: number }): Promise<NativeAgentLoopTask>;
  listAgentLoopTasks?(): Promise<NativeAgentLoopTask[]>;
  readAgentLoopTask?(input: { taskId: string }): Promise<NativeAgentLoopTask | undefined>;
  startAgentLoopRun?(input: { taskId: string }): Promise<NativeAgentLoopRunDetail>;
  readAgentLoopRun?(input: { runId: string }): Promise<NativeAgentLoopRunDetail | undefined>;
  readAgentLoopWorkbenchLayout?(input: { runId: string }): Promise<NativeAgentLoopWorkbenchLayout | undefined>;
  saveAgentLoopWorkbenchLayout?(input: { runId: string; layout: NativeAgentLoopWorkbenchLayout }): Promise<NativeAgentLoopWorkbenchLayout | undefined>;
  readAgentLoopArtifact?(input: { runId: string; artifactPath: string }): Promise<NativeAgentLoopArtifact>;
  markAgentLoopTaskAchieved?(input: { taskId: string }): Promise<NativeAgentLoopTask | undefined>;
  stopAgentLoopTask?(input: { taskId: string }): Promise<NativeAgentLoopTask | undefined>;
  respondAgentLoopPermission?(input: { taskId: string; sessionId: string; permissionId: string; response: "once" | "always" | "reject" }): Promise<{ ok: boolean; status: string; changed?: boolean; errorCode?: string; message?: string }>;
  respondAgentLoopQuestion?(input: { taskId: string; sessionId: string; questionId: string; answer: string }): Promise<{ ok: boolean; status: string; changed?: boolean; errorCode?: string; message?: string }>;
  deleteAgentLoopTask?(input: { taskId: string }): Promise<{ deleted: boolean; taskId: string; runsDeleted: number; runtimeDirectoryRemoved: boolean }>;
  listOrchestrationTemplates?(): Promise<NativeOrchestrationTemplate[]>;
  listOrchestrationTemplateBlueprints?(): Promise<NativeTemplateBlueprint[]>;
  saveOrchestrationTemplate?(input: {
    id: string;
    family: "agent_loop" | "workflow";
    version: number;
    name: string;
    definition: Record<string, unknown>;
  }): Promise<NativeOrchestrationTemplate>;
  createHarnessTask?(input: {
    taskId?: string;
    projectId?: string;
    cwd: string;
    title?: string;
    goal?: string;
    model?: string;
    templateBlueprintId?: string;
    templateBlueprintVersion?: number;
    agentLoopTemplateId?: string;
    agentLoopTemplateVersion?: number;
  }): Promise<NativeHarnessTask>;
  generateOrchestrationTemplateDraft?(input: {
    cwd: string;
    title: string;
    goal: string;
    model?: string;
  }): Promise<NativeGeneratedArchitectureDraft>;
  createManualOrchestrationTemplateDraft?(input: {
    cwd: string;
    title: string;
    goal?: string;
    description?: string;
    model?: string;
    agentLoop: { name?: string; conductorRole?: string };
    workflow: {
      name?: string;
      nodes: Array<{ id: string; role: string; instruction?: string; kind: "delegate" | "verify"; dependsOn: string[] }>;
    };
    rationale?: string;
    assumptions?: string[];
  }): Promise<NativeGeneratedArchitectureDraft>;
  readOrchestrationTemplateDraft?(input: { draftId: string }): Promise<NativeGeneratedArchitectureDraft | undefined>;
  saveGeneratedOrchestrationTemplateDraft?(input: { draftId: string }): Promise<NativeGeneratedArchitectureDraft>;
  listHarnessTasks?(): Promise<NativeHarnessTask[]>;
  readHarnessTask?(input: { taskId: string }): Promise<NativeHarnessTask | undefined>;
  startHarnessRun?(input: { taskId: string }): Promise<NativeHarnessRunDetail>;
  readHarnessRun?(input: { runId: string }): Promise<NativeHarnessRunDetail | undefined>;
  readHarnessArtifact?(input: { runId: string; artifactPath: string }): Promise<NativeHarnessArtifact | undefined>;
  markHarnessTaskAchieved?(input: { taskId: string }): Promise<NativeHarnessTask | undefined>;
  respondHarnessAttention?(input: { attentionId: string; response: string }): Promise<NativeHarnessRunDetail>;
};

declare global {
  interface Window {
    agentWorkspace?: {
      native: NativeRuntimeBridge;
    };
  }
}

export const browserRuntimeStatus: NativeRuntimeStatus = {
  available: false,
  mode: "browser",
  message: "浏览器模式无法直接启动本地 opencode。请使用桌面壳运行。",
};

/**
 * Harness is rendered in both the browser and Electron. Only Electron exposes
 * the durable Runtime bridge that can create Tasks or attach a native PTY.
 */
export function isNativeHarnessRuntimeAvailable(): boolean {
  return Boolean(window.agentWorkspace?.native.listOrchestrationTemplates);
}

export function isNativeAgentLoopRuntimeAvailable(): boolean {
  return Boolean(window.agentWorkspace?.native.listAgentLoopTemplates);
}

export const defaultOpencodeRunModel = "opencode-go/deepseek-v4-flash";

type LegacyTestPtyProfile = {
  workspaceSessionId: string;
  taskId: string;
  cwd: string;
  model?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  runtimeFiles?: NativeRuntimeFile[];
};

const legacyTestPtyProfiles = new Map<string, LegacyTestPtyProfile>();
const legacyTestPtyIncarnations = new Map<string, string>();

function useLegacyTestPtyBridge() {
  return import.meta.env.MODE === "test";
}

function withLegacyIncarnation(session: NativePtySession | undefined, workspaceSessionId: string) {
  if (!session) return undefined;
  const incarnationId = session.incarnationId ?? legacyTestPtyIncarnations.get(workspaceSessionId);
  return incarnationId ? { ...session, incarnationId, generation: session.generation ?? `legacy-${incarnationId}` } : session;
}

export async function getNativeRuntimeStatus(): Promise<NativeRuntimeStatus> {
  return window.agentWorkspace?.native.getRuntimeStatus() ?? browserRuntimeStatus;
}

export async function runNativeOpencode(input: NativeOpencodeInput): Promise<NativeOpencodeResult> {
  const request = {
    ...input,
    model: input.model ?? defaultOpencodeRunModel,
  };

  if (!window.agentWorkspace?.native) {
    return {
      ok: false,
      command: `opencode run --format json --model ${request.model}`,
      cwd: request.cwd,
      model: request.model,
      stdout: "",
      stderr: browserRuntimeStatus.message,
      exitCode: null,
      durationMs: 0,
      error: browserRuntimeStatus.message,
    };
  }

  return window.agentWorkspace.native.runOpencode(request);
}

export async function generateNativeTaskDraft(input: NativeTaskDraftInput): Promise<NativeTaskDraftResult> {
  const request = {
    ...input,
    model: input.model ?? defaultOpencodeRunModel,
  };

  return window.agentWorkspace?.native.generateTaskDraft?.(request) ?? {
    ok: false,
    assistantMessage: "桌面壳不可用，无法调用 opencode 生成任务配置。",
    missingFields: [],
    assumptions: [],
    error: browserRuntimeStatus.message,
  };
}

export async function listNativeOpencodeAgents(): Promise<NativeOpencodeAgentListResult> {
  return window.agentWorkspace?.native.listOpencodeAgents?.() ?? {
    ok: false,
    agents: [],
    stderr: browserRuntimeStatus.message,
  };
}

export async function inspectNativeOpencodeProcesses(): Promise<NativeOpencodeProcessInspection> {
  return window.agentWorkspace?.native.inspectOpencodeProcesses?.() ?? {
    ok: false,
    processes: [],
    error: browserRuntimeStatus.message,
  };
}

export async function runNativeVerification(input: NativeVerificationInput): Promise<NativeVerificationResult> {
  const fallback = {
    ok: false,
    command: input.command,
    cwd: input.cwd,
    runId: input.runId,
    status: "failed" as const,
    stdout: "",
    stderr: browserRuntimeStatus.message,
    exitCode: null,
    signal: null,
    durationMs: 0,
    artifactPath: `.agent-workspace/runs/${input.runId}/verification.json`,
    logPath: `.agent-workspace/runs/${input.runId}/verification.log`,
    error: browserRuntimeStatus.message,
  };

  return window.agentWorkspace?.native.runVerification?.(input) ?? fallback;
}

export async function registerNativeWorkspaceSessionProfile(
  input: NativeWorkspaceSessionProfileInput,
): Promise<{ workspaceSessionId: string; fingerprint: string; taskId: string } | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.registerWorkspaceSessionProfile) return bridge.registerWorkspaceSessionProfile(input);
  if (!useLegacyTestPtyBridge() || !bridge?.startPty) return undefined;
  legacyTestPtyProfiles.set(input.workspaceSessionId, input);
  return { workspaceSessionId: input.workspaceSessionId, fingerprint: "vitest-legacy-profile", taskId: input.taskId };
}

export async function activateNativeWorkspaceSession(input: {
  workspaceSessionId: string;
  operationId: string;
}): Promise<NativeWorkspaceSessionActivation | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.activateWorkspaceSession) return bridge.activateWorkspaceSession(input);
  if (!useLegacyTestPtyBridge() || !bridge?.startPty) return undefined;
  const profile = legacyTestPtyProfiles.get(input.workspaceSessionId);
  if (!profile) return undefined;
  const incarnationId = legacyTestPtyIncarnations.get(input.workspaceSessionId) ?? `vitest-${input.operationId}`;
  legacyTestPtyIncarnations.set(input.workspaceSessionId, incarnationId);
  const session = withLegacyIncarnation(
    await bridge.startPty({
      id: profile.workspaceSessionId,
      taskId: profile.taskId,
      command: "opencode",
      args: profile.model ? ["--model", profile.model] : [],
      cwd: profile.cwd,
      model: profile.model,
      cols: profile.cols,
      rows: profile.rows,
      stdin: "pipe",
      requirePty: true,
      env: profile.env,
      runtimeFiles: profile.runtimeFiles,
    }),
    input.workspaceSessionId,
  );
  if (!session) return undefined;
  return {
    disposition: "created",
    workspaceSessionId: input.workspaceSessionId,
    owner: {
      workspaceSessionId: input.workspaceSessionId,
      taskId: profile.taskId,
      ptyId: input.workspaceSessionId,
      incarnationId,
      generation: `legacy-${incarnationId}`,
      state: "active",
    },
    session,
  };
}

export async function getNativePtySession(id: string): Promise<NativePtySession | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.readWorkspaceSession) return bridge.readWorkspaceSession({ workspaceSessionId: id, cursor: 0 });
  if (useLegacyTestPtyBridge()) return withLegacyIncarnation(await bridge?.getPty?.({ id }), id);
  return undefined;
}

export async function readNativePtySession(id: string, cursor: number): Promise<NativePtySession | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.readWorkspaceSession) return bridge.readWorkspaceSession({ workspaceSessionId: id, cursor });
  if (useLegacyTestPtyBridge()) return withLegacyIncarnation(await bridge?.readPty?.({ id, cursor }), id);
  return undefined;
}

/**
 * Reads persisted raw PTY bytes for a visible Agent Loop Session. This is a
 * diagnostic surface only: callers must not turn it into semantic state or
 * use it to infer dispatch/completion readiness.
 */
export async function readNativeWorkspaceTerminalLog(input: {
  taskId: string;
  workspaceSessionId: string;
  maxBytes?: number;
}): Promise<NativeTerminalDiagnosticLog | undefined> {
  return window.agentWorkspace?.native.readWorkspaceTerminalLog?.(input);
}

export function isNativeTerminalTransportAvailable(): boolean {
  return Boolean(
    window.agentWorkspace?.native.attachTerminalClient &&
      window.agentWorkspace?.native.acknowledgeTerminalOutput &&
      window.agentWorkspace?.native.onTerminalClientEvent,
  );
}

export async function attachNativeTerminalClient(input: {
  sessionId: string;
  clientId: string;
  generation: string;
}): Promise<NativeTerminalAttachResult | undefined> {
  return window.agentWorkspace?.native.attachTerminalClient?.(input);
}

export async function acknowledgeNativeTerminalOutput(input: {
  sessionId: string;
  clientId: string;
  generation: string;
  cursor: number;
}): Promise<{ accepted: boolean; reason?: string; restoreRequired?: boolean } | undefined> {
  return window.agentWorkspace?.native.acknowledgeTerminalOutput?.(input);
}

export async function detachNativeTerminalClient(input: { clientId: string; generation: string }): Promise<boolean> {
  return (await window.agentWorkspace?.native.detachTerminalClient?.(input)) ?? false;
}

export async function enqueueNativeTerminalInput(input: {
  workspaceSessionId: string;
  expectedIncarnationId: string;
  source: NativeTerminalInputSource;
  payload: string;
  idempotencyKey?: string;
}): Promise<NativeTerminalInputResult | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.enqueueTerminalInput) return bridge.enqueueTerminalInput(input);
  if (!useLegacyTestPtyBridge()) return undefined;
  const result = await bridge?.writePty?.({ id: input.workspaceSessionId, text: input.payload });
  return {
    disposition: "written",
    workspaceSessionId: input.workspaceSessionId,
    incarnationId: input.expectedIncarnationId,
    source: input.source,
    result: withLegacyIncarnation(result, input.workspaceSessionId),
  };
}

export async function resizeNativePtySession(
  id: string,
  size: { cols: number; rows: number },
  expectedIncarnationId?: string,
): Promise<NativePtySession | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.resizeWorkspaceSession) {
    return bridge.resizeWorkspaceSession({ workspaceSessionId: id, expectedIncarnationId, ...size });
  }
  if (useLegacyTestPtyBridge()) return withLegacyIncarnation(await bridge?.resizePty?.({ id, ...size }), id);
  return undefined;
}

export async function stopNativePtySession(
  id: string,
  expectedIncarnationId?: string,
): Promise<NativePtySession | undefined> {
  const bridge = window.agentWorkspace?.native;
  if (bridge?.stopWorkspaceSession) return bridge.stopWorkspaceSession({ workspaceSessionId: id, expectedIncarnationId });
  if (useLegacyTestPtyBridge()) return withLegacyIncarnation(await bridge?.stopPty?.({ id }), id);
  return undefined;
}

export function subscribeNativePtyEvents(callback: (event: NativePtyEvent) => void): () => void {
  return window.agentWorkspace?.native.onPtyEvent?.(callback) ?? (() => undefined);
}

export function subscribeNativeTerminalClientEvents(callback: (event: NativeTerminalClientEvent) => void): () => void {
  return window.agentWorkspace?.native.onTerminalClientEvent?.(callback) ?? (() => undefined);
}

export function subscribeNativeAgentLoopRuntimeEvents(callback: (event: NativeAgentLoopRuntimeEvent) => void): () => void {
  return window.agentWorkspace?.native.onAgentLoopRuntimeEvent?.(callback) ?? (() => undefined);
}

export async function callNativeSession(input: CallSessionInput): Promise<CallSessionResult> {
  return (
    window.agentWorkspace?.native.callSession?.(input) ?? {
      ok: false,
      dispatchId: "",
      taskId: input.taskId,
      toSessionId: input.toSessionId,
      status: "failed",
      deliveryState: "failed",
      targetSessionState: "unknown",
      resultState: "none",
      turnPolicy: "recover_or_stop",
      errorCode: "route_validation_failed",
      message: browserRuntimeStatus.message,
      error: browserRuntimeStatus.message,
    }
  );
}

export async function readNativeSession(input: ReadSessionInput): Promise<ReadSessionResult | undefined> {
  return window.agentWorkspace?.native.readSession?.(input);
}

export async function readNativeTaskState(input: ReadTaskStateInput): Promise<ReadTaskStateResult | undefined> {
  return window.agentWorkspace?.native.readTaskState?.(input);
}

export async function appendNativeTaskEvent(input: NativeTaskEventInput): Promise<NativeTaskEventResult> {
  return (
    window.agentWorkspace?.native.appendTaskEvent?.(input) ?? {
      ok: false,
      error: browserRuntimeStatus.message,
    }
  );
}

export async function listNativeAgentLoopTemplates(): Promise<NativeAgentLoopTemplate[]> {
  return (await window.agentWorkspace?.native.listAgentLoopTemplates?.()) ?? [];
}

export async function generateNativeAgentLoopTemplate(input: {
  cwd: string;
  projectName?: string;
  brief: string;
  model?: string;
}): Promise<NativeGeneratedAgentLoopTemplateDraft | undefined> {
  return window.agentWorkspace?.native.generateAgentLoopTemplate?.({
    ...input,
    model: input.model ?? defaultOpencodeRunModel,
  });
}

export async function saveNativeAgentLoopTemplate(
  input: Omit<NativeAgentLoopTemplate, "version" | "archivedAt" | "createdAt" | "updatedAt">,
): Promise<NativeAgentLoopTemplate | undefined> {
  return window.agentWorkspace?.native.saveAgentLoopTemplate?.(input);
}

export async function copyNativeAgentLoopTemplate(templateId: string, name?: string): Promise<NativeAgentLoopTemplate | undefined> {
  return window.agentWorkspace?.native.copyAgentLoopTemplate?.({ templateId, name });
}

export async function archiveNativeAgentLoopTemplate(templateId: string): Promise<NativeAgentLoopTemplate | undefined> {
  return window.agentWorkspace?.native.archiveAgentLoopTemplate?.({ templateId });
}

export async function deleteNativeAgentLoopTemplate(templateId: string): Promise<{ deleted: boolean; templateId: string } | undefined> {
  return window.agentWorkspace?.native.deleteAgentLoopTemplate?.({ templateId });
}

export async function validateNativeAgentLoopProjectDirectory(path: string): Promise<{ path: string; name: string } | undefined> {
  return window.agentWorkspace?.native.validateAgentLoopProjectDirectory?.({ path });
}

export async function suggestNativeAgentLoopProjectDirectories(prefix: string): Promise<string[]> {
  return (await window.agentWorkspace?.native.suggestAgentLoopProjectDirectories?.({ prefix })) ?? [];
}

export async function createNativeAgentLoopTask(input: {
  taskId?: string;
  projectId?: string;
  cwd: string;
  title: string;
  goal: string;
  templateId?: string;
  templateVersion?: number;
}): Promise<NativeAgentLoopTask | undefined> {
  return window.agentWorkspace?.native.createAgentLoopTask?.(input);
}

export async function listNativeAgentLoopTasks(): Promise<NativeAgentLoopTask[]> {
  return (await window.agentWorkspace?.native.listAgentLoopTasks?.()) ?? [];
}

export async function readNativeAgentLoopTask(taskId: string): Promise<NativeAgentLoopTask | undefined> {
  return window.agentWorkspace?.native.readAgentLoopTask?.({ taskId });
}

export async function startNativeAgentLoopRun(taskId: string): Promise<NativeAgentLoopRunDetail | undefined> {
  return window.agentWorkspace?.native.startAgentLoopRun?.({ taskId });
}

export async function readNativeAgentLoopRun(runId: string): Promise<NativeAgentLoopRunDetail | undefined> {
  return window.agentWorkspace?.native.readAgentLoopRun?.({ runId });
}

export async function readNativeAgentLoopWorkbenchLayout(runId: string): Promise<NativeAgentLoopWorkbenchLayout | undefined> {
  return window.agentWorkspace?.native.readAgentLoopWorkbenchLayout?.({ runId });
}

export async function saveNativeAgentLoopWorkbenchLayout(
  runId: string,
  layout: NativeAgentLoopWorkbenchLayout,
): Promise<NativeAgentLoopWorkbenchLayout | undefined> {
  return window.agentWorkspace?.native.saveAgentLoopWorkbenchLayout?.({ runId, layout });
}

export async function readNativeAgentLoopArtifact(runId: string, artifactPath: string): Promise<NativeAgentLoopArtifact | undefined> {
  return window.agentWorkspace?.native.readAgentLoopArtifact?.({ runId, artifactPath });
}

export async function markNativeAgentLoopTaskAchieved(taskId: string): Promise<NativeAgentLoopTask | undefined> {
  return window.agentWorkspace?.native.markAgentLoopTaskAchieved?.({ taskId });
}

export async function stopNativeAgentLoopTask(taskId: string): Promise<NativeAgentLoopTask | undefined> {
  return window.agentWorkspace?.native.stopAgentLoopTask?.({ taskId });
}

export async function respondNativeAgentLoopPermission(input: {
  taskId: string;
  sessionId: string;
  permissionId: string;
  response: "once" | "always" | "reject";
}): Promise<{ ok: boolean; status: string; changed?: boolean; errorCode?: string; message?: string } | undefined> {
  return window.agentWorkspace?.native.respondAgentLoopPermission?.(input);
}

export async function respondNativeAgentLoopQuestion(input: {
  taskId: string;
  sessionId: string;
  questionId: string;
  answer: string;
}): Promise<{ ok: boolean; status: string; changed?: boolean; errorCode?: string; message?: string } | undefined> {
  return window.agentWorkspace?.native.respondAgentLoopQuestion?.(input);
}

export async function deleteNativeAgentLoopTask(taskId: string): Promise<{
  deleted: boolean;
  taskId: string;
  runsDeleted: number;
  runtimeDirectoryRemoved: boolean;
} | undefined> {
  return window.agentWorkspace?.native.deleteAgentLoopTask?.({ taskId });
}

export async function listNativeOrchestrationTemplates(): Promise<NativeOrchestrationTemplate[]> {
  return (await window.agentWorkspace?.native.listOrchestrationTemplates?.()) ?? [];
}

export async function listNativeOrchestrationTemplateBlueprints(): Promise<NativeTemplateBlueprint[]> {
  return (await window.agentWorkspace?.native.listOrchestrationTemplateBlueprints?.()) ?? [];
}

export async function saveNativeOrchestrationTemplate(input: {
  id: string;
  family: "agent_loop" | "workflow";
  version: number;
  name: string;
  definition: Record<string, unknown>;
}): Promise<NativeOrchestrationTemplate | undefined> {
  return window.agentWorkspace?.native.saveOrchestrationTemplate?.(input);
}

export async function createNativeHarnessTask(input: {
  taskId?: string;
  projectId?: string;
  cwd: string;
  title?: string;
  goal?: string;
  model?: string;
  templateBlueprintId?: string;
  templateBlueprintVersion?: number;
  agentLoopTemplateId?: string;
  agentLoopTemplateVersion?: number;
}): Promise<NativeHarnessTask | undefined> {
  return window.agentWorkspace?.native.createHarnessTask?.(input);
}

export async function generateNativeOrchestrationTemplateDraft(input: {
  cwd: string;
  title: string;
  goal: string;
  model?: string;
}): Promise<NativeGeneratedArchitectureDraft | undefined> {
  return window.agentWorkspace?.native.generateOrchestrationTemplateDraft?.(input);
}

export async function createNativeManualOrchestrationTemplateDraft(input: {
  cwd: string;
  title: string;
  goal?: string;
  description?: string;
  model?: string;
  agentLoop: { name?: string; conductorRole?: string };
  workflow: {
    name?: string;
    nodes: Array<{ id: string; role: string; instruction?: string; kind: "delegate" | "verify"; dependsOn: string[] }>;
  };
  rationale?: string;
  assumptions?: string[];
}): Promise<NativeGeneratedArchitectureDraft | undefined> {
  return window.agentWorkspace?.native.createManualOrchestrationTemplateDraft?.(input);
}

export async function saveNativeGeneratedOrchestrationTemplateDraft(
  draftId: string,
): Promise<NativeGeneratedArchitectureDraft | undefined> {
  return window.agentWorkspace?.native.saveGeneratedOrchestrationTemplateDraft?.({ draftId });
}

export async function listNativeHarnessTasks(): Promise<NativeHarnessTask[]> {
  return (await window.agentWorkspace?.native.listHarnessTasks?.()) ?? [];
}

export async function startNativeHarnessRun(taskId: string): Promise<NativeHarnessRunDetail | undefined> {
  return window.agentWorkspace?.native.startHarnessRun?.({ taskId });
}

export async function readNativeHarnessRun(runId: string): Promise<NativeHarnessRunDetail | undefined> {
  return window.agentWorkspace?.native.readHarnessRun?.({ runId });
}

export async function readNativeHarnessArtifact(
  runId: string,
  artifactPath: string,
): Promise<NativeHarnessArtifact | undefined> {
  return window.agentWorkspace?.native.readHarnessArtifact?.({ runId, artifactPath });
}

export async function markNativeHarnessTaskAchieved(taskId: string): Promise<NativeHarnessTask | undefined> {
  return window.agentWorkspace?.native.markHarnessTaskAchieved?.({ taskId });
}

export async function respondNativeHarnessAttention(
  attentionId: string,
  response: string,
): Promise<NativeHarnessRunDetail | undefined> {
  return window.agentWorkspace?.native.respondHarnessAttention?.({ attentionId, response });
}
