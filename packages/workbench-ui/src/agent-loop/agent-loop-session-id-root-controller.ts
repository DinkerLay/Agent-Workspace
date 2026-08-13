import { createId } from "@agent-workspace/runtime-contracts";
import {
  createAgentLoopSessionIdConfigurationControllers,
  type AgentLoopSessionIdConfigurationCommand,
  type AgentLoopSessionIdConfigurationCommandResult,
  type AgentLoopSessionIdConfigurationControllers,
  type AgentLoopSessionIdConfigurationReadRequest,
  type AgentLoopSessionIdConfigurationReadResult,
} from "./agent-loop-session-id-configuration-controller";
import {
  createAgentLoopSessionIdRuntimeController,
  type AgentLoopSessionIdCommandResult,
  type AgentLoopSessionIdCommandTrace,
  type AgentLoopSessionIdInvalidation,
  type AgentLoopSessionIdRuntimeController,
  type AgentLoopSessionIdTaskReadModel,
  type AgentLoopSessionIdUiCommand,
  type AgentLoopWorkspaceFileObservation,
} from "./agent-loop-session-id-runtime-controller";

export type AgentLoopSessionIdFileStateAnchor = Readonly<{
  workspaceRelativePath: string;
  observedDigest?: string;
  label?: string;
}>;

export type AgentLoopSessionIdTaskSummary = Readonly<{
  taskId: string;
  title: string;
  goal: string;
  revision: number;
  status: string;
  trashedAt?: string;
  createdAt: string;
  updatedAt: string;
  activeRun?: Readonly<{
    runId: string;
    status: string;
  }>;
  availableLifecycleActions: readonly ("start" | "resume" | "restart")[];
  achievement?: Readonly<{
    achievedAt: string;
    acceptanceNote?: string;
    fileStateAnchor?: AgentLoopSessionIdFileStateAnchor;
  }>;
}>;

export type AgentLoopSessionIdTaskSetupOptions = Readonly<{
  workspaces: readonly Readonly<{
    workspaceId: string;
    displayName: string;
  }>[];
  templates: readonly Readonly<{
    templateId: string;
    title: string;
    activeTemplateVersionId?: string;
    versions: readonly Readonly<{
      templateVersionId: string;
      version: number;
    }>[];
  }>[];
}>;

export type AgentLoopSessionIdWorkspaceReadModel = Readonly<{
  generatedAt: string;
  tasks: readonly AgentLoopSessionIdTaskSummary[];
  taskSetupOptions: AgentLoopSessionIdTaskSetupOptions;
}>;

export type AgentLoopSessionIdRootInvalidation = Readonly<{
  reason: string;
  taskId?: string;
  observedAt?: string;
}>;

type LifecycleEnvelope = Readonly<{
  commandId: string;
  uiIntentId: string;
  issuedAt: string;
  taskId: string;
  expectedRevision: number;
}>;

export type AgentLoopSessionIdLifecycleCommand =
  | LifecycleEnvelope & Readonly<{
      type: "task.start";
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.resume";
      runId: string;
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.restart";
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.achieve";
      fileStateAnchor?: Readonly<{
        observationId: string;
        label?: string;
      }>;
      acceptanceNote?: string;
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.archive";
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.restore";
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.preview_permanent_delete";
    }>
  | LifecycleEnvelope & Readonly<{
      type: "task.permanently_delete";
    }>;

export type AgentLoopSessionIdPermanentDeletePreview = Readonly<{
  taskId: string;
  expectedRevision: number;
  productRecordCounts: Readonly<Record<string, number>>;
  workspaceFilesWillRemain: true;
}>;

export type AgentLoopSessionIdPermanentDeleteResult = Readonly<{
  taskId: string;
  deletedAt: string;
  workspaceFilesWillRemain: true;
}>;

export type AgentLoopSessionIdLifecycleCommandResult = Readonly<{
  task?: AgentLoopSessionIdTaskSummary;
  run?: Readonly<{
    runId: string;
    status: string;
  }>;
  permanentDeletePreview?: AgentLoopSessionIdPermanentDeletePreview;
  permanentDelete?: AgentLoopSessionIdPermanentDeleteResult;
}>;

export type AgentLoopSessionIdRootRuntimePort = Readonly<{
  readWorkspace(): Promise<AgentLoopSessionIdWorkspaceReadModel>;
  readTask(request: Readonly<{ taskId: string }>): Promise<AgentLoopSessionIdTaskReadModel>;
  readConfiguration(request: AgentLoopSessionIdConfigurationReadRequest): Promise<AgentLoopSessionIdConfigurationReadResult>;
  command(
    command: AgentLoopSessionIdUiCommand | AgentLoopSessionIdLifecycleCommand | AgentLoopSessionIdConfigurationCommand,
  ): Promise<AgentLoopSessionIdCommandResult | AgentLoopSessionIdLifecycleCommandResult | AgentLoopSessionIdConfigurationCommandResult>;
  subscribe(
    request: Readonly<{ taskId?: string }>,
    onChanged: (invalidation: AgentLoopSessionIdRootInvalidation) => void,
  ): Promise<() => Promise<void> | void>;
}>;

export type AgentLoopSessionIdRootController = Readonly<{
  configuration: AgentLoopSessionIdConfigurationControllers;
  loadWorkspace(): Promise<AgentLoopSessionIdWorkspaceReadModel>;
  subscribe(onChanged: (invalidation: AgentLoopSessionIdRootInvalidation) => void): Promise<() => Promise<void> | void>;
  task(taskId: string): AgentLoopSessionIdRuntimeController;
  startTask(taskId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  resumeTask(taskId: string, runId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  restartTask(taskId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  archiveTask(taskId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  restoreTask(taskId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  previewPermanentDelete(taskId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  permanentlyDeleteTask(taskId: string, expectedRevision: number, uiIntentId: string): Promise<AgentLoopSessionIdLifecycleCommandResult>;
  achieveTask(input: Readonly<{
    taskId: string;
    expectedRevision: number;
    uiIntentId: string;
    fileObservation?: AgentLoopWorkspaceFileObservation;
    acceptanceNote?: string;
  }>): Promise<AgentLoopSessionIdLifecycleCommandResult>;
}>;

export type AgentLoopSessionIdRootControllerOptions = Readonly<{
  client: AgentLoopSessionIdRootRuntimePort;
  ownerId: string;
  now?: () => string;
  createRuntimeId?: typeof createId;
  createUiIntentId?: () => string;
  onCommandTrace?: (trace: AgentLoopSessionIdCommandTrace) => void;
}>;

/**
 * Formal Session-ID Renderer controller. Configuration Create remains owned by
 * the Task Setup controller; this boundary only starts or accepts an existing
 * Task and delegates active-Run actions to the Session-ID Task controller.
 */
export function createAgentLoopSessionIdRootController(
  options: AgentLoopSessionIdRootControllerOptions,
): AgentLoopSessionIdRootController {
  const now = options.now ?? (() => new Date().toISOString());
  const createRuntimeId = options.createRuntimeId ?? createId;
  const taskControllers = new Map<string, AgentLoopSessionIdRuntimeController>();
  const pending = new Map<string, AgentLoopSessionIdLifecycleCommand>();
  const configuration = createAgentLoopSessionIdConfigurationControllers({
    ownerId: requiredText(options.ownerId, "owner id"),
    now,
    createRuntimeId,
    ...(options.createUiIntentId ? { createUiIntentId: options.createUiIntentId } : {}),
    onCommandTrace: options.onCommandTrace,
    client: {
      readConfiguration: (request) => options.client.readConfiguration(request),
      command: async (command) => options.client.command(command) as Promise<AgentLoopSessionIdConfigurationCommandResult>,
      subscribeConfiguration: (onChanged) => options.client.subscribe({}, onChanged),
    },
  });

  const issue = async (
    key: string,
    uiIntentId: string,
    createCommand: () => AgentLoopSessionIdLifecycleCommand,
  ): Promise<AgentLoopSessionIdLifecycleCommandResult> => {
    const normalizedUiIntentId = requiredText(uiIntentId, "ui intent id");
    const command = pending.get(key) ?? createCommand();
    if (!pending.has(key)) pending.set(key, command);
    if (command.uiIntentId !== normalizedUiIntentId) throw new Error("agent_loop_ui_intent_retry_conflict");
    options.onCommandTrace?.(Object.freeze({
      uiIntentId: normalizedUiIntentId,
      commandId: command.commandId,
      intentKind: command.type,
      taskId: command.taskId,
    }));
    const result = await options.client.command(command) as AgentLoopSessionIdLifecycleCommandResult;
    if (pending.get(key) === command) pending.delete(key);
    return result;
  };

  return Object.freeze({
    configuration,
    async loadWorkspace() {
      return validateWorkspace(await options.client.readWorkspace());
    },
    subscribe(onChanged) {
      return options.client.subscribe({}, onChanged);
    },
    task(taskIdValue) {
      const taskId = requiredText(taskIdValue, "task id");
      const existing = taskControllers.get(taskId);
      if (existing) return existing;
      const controller = createAgentLoopSessionIdRuntimeController({
        taskId,
        now,
        createRuntimeId,
        onCommandTrace: options.onCommandTrace,
        client: {
          read: (request) => options.client.readTask(request),
          command: async (command) => options.client.command(command) as Promise<AgentLoopSessionIdCommandResult>,
          subscribe: (request, onChanged) => options.client.subscribe(request, (invalidation) => {
            onChanged(Object.freeze({ taskId: request.taskId, reason: invalidation.reason } satisfies AgentLoopSessionIdInvalidation));
          }).then((unsubscribe) => () => { void unsubscribe(); }),
        },
      });
      taskControllers.set(taskId, controller);
      return controller;
    },
    startTask(taskIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      requiredRevision(expectedRevision);
      return issue(`task.start:${taskId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.start" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision,
      }));
    },
    resumeTask(taskIdValue, runIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      const runId = requiredText(runIdValue, "run id");
      requiredRevision(expectedRevision);
      return issue(`task.resume:${taskId}:${runId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.resume" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        runId,
        expectedRevision,
      }));
    },
    restartTask(taskIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      requiredRevision(expectedRevision);
      return issue(`task.restart:${taskId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.restart" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision,
      }));
    },
    archiveTask(taskIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      requiredRevision(expectedRevision);
      return issue(`task.archive:${taskId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.archive" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision,
      }));
    },
    restoreTask(taskIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      requiredRevision(expectedRevision);
      return issue(`task.restore:${taskId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.restore" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision,
      }));
    },
    previewPermanentDelete(taskIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      requiredRevision(expectedRevision);
      return issue(`task.preview_permanent_delete:${taskId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.preview_permanent_delete" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision,
      }));
    },
    permanentlyDeleteTask(taskIdValue, expectedRevision, uiIntentId) {
      const taskId = requiredText(taskIdValue, "task id");
      requiredRevision(expectedRevision);
      return issue(`task.permanently_delete:${taskId}:${expectedRevision}`, uiIntentId, () => Object.freeze({
        type: "task.permanently_delete" as const,
        commandId: createRuntimeId("command"),
        uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision,
      }));
    },
    achieveTask(input) {
      const taskId = requiredText(input.taskId, "task id");
      requiredRevision(input.expectedRevision);
      const anchor = input.fileObservation ? Object.freeze({
        observationId: requiredText(input.fileObservation.observationId, "workspace observation id"),
        label: input.fileObservation.workspaceRelativePath,
      }) : undefined;
      const acceptanceNote = optionalText(input.acceptanceNote);
      const fingerprint = JSON.stringify([taskId, input.expectedRevision, anchor, acceptanceNote]);
      return issue(`task.achieve:${fingerprint}`, input.uiIntentId, () => Object.freeze({
        type: "task.achieve" as const,
        commandId: createRuntimeId("command"),
        uiIntentId: input.uiIntentId,
        issuedAt: now(),
        taskId,
        expectedRevision: input.expectedRevision,
        ...(anchor ? { fileStateAnchor: anchor } : {}),
        ...(acceptanceNote ? { acceptanceNote } : {}),
      }));
    },
  });
}

function validateWorkspace(model: AgentLoopSessionIdWorkspaceReadModel): AgentLoopSessionIdWorkspaceReadModel {
  if (!model || typeof model.generatedAt !== "string" || !Array.isArray(model.tasks)) {
    throw new Error("agent_loop_session_id_workspace_read_invalid");
  }
  const taskIds = new Set<string>();
  for (const task of model.tasks) {
    requiredText(task.taskId, "task id");
    if (taskIds.has(task.taskId)) throw new Error("agent_loop_session_id_task_duplicate");
    taskIds.add(task.taskId);
  }
  return model;
}

function requiredRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error("task revision_invalid");
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
