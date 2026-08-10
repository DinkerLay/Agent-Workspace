import {
  createId,
  type JsonObject,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeInvalidation,
  type RuntimeReadModel,
  type ArtifactPreviewReadModel,
  type TaskPermanentDeletePreview,
  type TaskPermanentDeleteResult,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeClient, RuntimeUnsubscribe } from "@agent-workspace/runtime-client";
import { toAgentLoopRuntimeViewModel, type AgentLoopRuntimeViewModel } from "./agent-loop-model";

export type AgentLoopInputSubmissionIntent = Readonly<{
  commandId: string;
  humanInterventionId: string;
  taskId: string;
  expectedRevision: number;
  targetLogicalSessionId: string;
  content: string;
}>;

export type AgentLoopInputSubmissionOutcome = Readonly<{
  state: "sent" | "interrupting";
  humanInterventionId?: string;
}>;

export type AgentLoopWorkspaceAuthorization = Readonly<{
  workspaceId: string;
  displayName: string;
  /** Optimistic local display only; the next Runtime read supplies the durable value. */
  authorizedAt: string;
}>;

export type AgentLoopRuntimeController = Readonly<{
  load(taskId?: string): Promise<AgentLoopRuntimeViewModel>;
  subscribe(onChanged: (invalidation: RuntimeInvalidation) => void): Promise<RuntimeUnsubscribe>;
  /**
   * The sole renderer route for a user-selected local directory.  The Host
   * validates and keeps the canonical directory private before returning an
   * opaque workspace id.
   */
  authorizeWorkspace(directory: string, displayName?: string): Promise<AgentLoopWorkspaceAuthorization>;
  startTask(taskId: string, expectedRevision: number): Promise<void>;
  restartTask(taskId: string, expectedRevision: number): Promise<void>;
  /** Reconnects the selected historical Run only after Runtime proves it is recoverable. */
  resumeTask(taskId: string, expectedRevision: number, runId: string): Promise<void>;
  stopTask(taskId: string, expectedRevision: number): Promise<void>;
  /** Achievement is deliberately a user command, never an Agent claim. */
  achieveTask(taskId: string, expectedRevision: number): Promise<void>;
  /** A reversible move to the Runtime-owned recycle bin. */
  archiveTask(taskId: string, expectedRevision: number): Promise<void>;
  /** Restores the same Task identity; it does not clone its Run or evidence. */
  restoreTask(taskId: string, expectedRevision: number): Promise<void>;
  /** Returns Host-validated, path-free delete choices for a recycled Task. */
  previewPermanentDelete(taskId: string, expectedRevision: number): Promise<TaskPermanentDeletePreview>;
  /** Permanently removes the Task and only explicitly selected managed artifacts. */
  permanentlyDeleteTask(taskId: string, expectedRevision: number, artifactIds: readonly string[]): Promise<TaskPermanentDeleteResult>;
  /** Reads a bounded text preview by artifact identity only. */
  previewArtifact(taskId: string, expectedRevision: number, artifactId: string): Promise<ArtifactPreviewReadModel>;
  createInputSubmissionIntent(
    taskId: string,
    expectedRevision: number,
    targetLogicalSessionId: string,
    content: string,
  ): AgentLoopInputSubmissionIntent;
  submitTaskInput(intent: AgentLoopInputSubmissionIntent): Promise<AgentLoopInputSubmissionOutcome>;
  respondAttention(input: Readonly<{
    taskId: string;
    expectedRevision: number;
    attentionId: string;
    response: string;
  }>): Promise<void>;
}>;

export type AgentLoopRuntimeControllerOptions = Readonly<{
  client: RuntimeClient;
  now?: () => string;
  /** Test seam only; production uses opaque Runtime ids. */
  createRuntimeId?: typeof createId;
}>;

type RuntimeCommandInput = RuntimeCommand extends infer Command
  ? Command extends { readonly commandId: string; readonly issuedAt: string }
    ? Omit<Command, "commandId" | "issuedAt">
    : never
  : never;

/**
 * The formal adapter for the preserved AgentLoop interaction.
 *
 * It is intentionally separate from the former generic Workbench controller:
 * AgentLoop has a selected logical Session, a Timeline, user achievement, and
 * input/attention affordances that must retain their own interaction model.
 * It still has only one side-effect boundary: RuntimeClient.
 */
export function createAgentLoopRuntimeController(options: AgentLoopRuntimeControllerOptions): AgentLoopRuntimeController {
  const now = options.now ?? (() => new Date().toISOString());
  const createRuntimeId = options.createRuntimeId ?? createId;
  const pendingCommandIds = new Map<string, string>();
  const pendingWorkspaceIds = new Map<string, string>();

  const issue = async <Result = void>(key: string, command: RuntimeCommandInput): Promise<Result> => {
    const commandId = pendingCommandIds.get(key) ?? createRuntimeId("command");
    pendingCommandIds.set(key, commandId);
    try {
      const result = await options.client.command(withCommandEnvelope(command, now, commandId));
      pendingCommandIds.delete(key);
      return result as Result;
    } catch (error) {
      // Keep the exact command identity for an ambiguous transport retry. The
      // caller can explicitly retry the same user action without creating a
      // second lifecycle mutation.
      throw error;
    }
  };

  const requireTask = async (taskId: string) => {
    const readModel = await options.client.read({ taskId });
    if (!readModel.task || readModel.task.task.taskId !== taskId) {
      throw new Error("agent_loop_task_read_model_unavailable");
    }
    return readModel.task;
  };

  return Object.freeze({
    async load(taskId?: string) {
      return toAgentLoopRuntimeViewModel(await options.client.read(taskId ? { taskId } : {}));
    },
    async subscribe(onChanged) {
      return options.client.subscribe({}, onChanged);
    },
    async authorizeWorkspace(directory, displayName) {
      const normalizedDirectory = requiredText(directory, "workspace directory");
      const normalizedName = optionalText(displayName);
      const key = `workspace.authorize:${normalizedDirectory}:${normalizedName ?? ""}`;
      const workspaceId = pendingWorkspaceIds.get(key) ?? createRuntimeId("workspace");
      pendingWorkspaceIds.set(key, workspaceId);
      try {
        await issue(key, {
          type: "workspace.authorize",
          workspaceId,
          directory: normalizedDirectory,
          ...(normalizedName ? { displayName: normalizedName } : {}),
        });
      } finally {
        if (!pendingCommandIds.has(key)) pendingWorkspaceIds.delete(key);
      }
      return Object.freeze({
        workspaceId,
        displayName: normalizedName ?? normalizedDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "已授权项目",
        authorizedAt: now(),
      });
    },
    async startTask(taskId, expectedRevision) {
      await issue(`task.start:${taskId}:${expectedRevision}`, {
        type: "task.start",
        taskId,
        expectedRevision,
      });
    },
    async restartTask(taskId, expectedRevision) {
      await issue(`task.restart:${taskId}:${expectedRevision}`, {
        type: "task.restart",
        taskId,
        expectedRevision,
      });
    },
    async resumeTask(taskId, expectedRevision, runId) {
      await issue(`task.resume:${taskId}:${expectedRevision}:${runId}`, {
        type: "task.resume",
        taskId,
        expectedRevision,
        runId,
      });
    },
    async stopTask(taskId, expectedRevision) {
      const task = await requireTask(taskId);
      if (!task.activeRun) throw new Error("agent_loop_task_run_unavailable_for_stop");
      await issue(`task.stop:${taskId}:${expectedRevision}`, {
        type: "task.stop",
        taskId,
        expectedRevision,
        runId: task.activeRun.runId,
        bindingIds: task.bindings.map((binding) => binding.bindingId),
      });
    },
    async achieveTask(taskId, expectedRevision) {
      await issue(`task.achieve:${taskId}:${expectedRevision}`, {
        type: "task.achieve",
        taskId,
        expectedRevision,
        acceptedArtifactIds: [],
      });
    },
    async archiveTask(taskId, expectedRevision) {
      await issue(`task.archive:${taskId}:${expectedRevision}`, {
        type: "task.archive",
        taskId,
        expectedRevision,
      });
    },
    async restoreTask(taskId, expectedRevision) {
      await issue(`task.restore:${taskId}:${expectedRevision}`, {
        type: "task.restore",
        taskId,
        expectedRevision,
      });
    },
    async previewPermanentDelete(taskId, expectedRevision) {
      const result = await issue<RuntimeCommandResult>(`task.preview_permanent_delete:${taskId}:${expectedRevision}`, {
        type: "task.preview_permanent_delete",
        taskId,
        expectedRevision,
      });
      if (!result.permanentDeletePreview) throw new Error("agent_loop_permanent_delete_preview_unavailable");
      return result.permanentDeletePreview;
    },
    async permanentlyDeleteTask(taskId, expectedRevision, artifactIds) {
      const result = await issue<RuntimeCommandResult>(
        `task.permanently_delete:${taskId}:${expectedRevision}:${[...artifactIds].join(",")}`,
        {
          type: "task.permanently_delete",
          taskId,
          expectedRevision,
          artifactIds,
        },
      );
      if (!result.permanentDelete) throw new Error("agent_loop_permanent_delete_result_unavailable");
      return result.permanentDelete;
    },
    async previewArtifact(taskId, expectedRevision, artifactId) {
      const result = await issue<RuntimeCommandResult>(`artifact.preview:${taskId}:${expectedRevision}:${artifactId}`, {
        type: "artifact.preview",
        taskId,
        expectedRevision,
        artifactId,
      });
      if (!result.artifactPreview) throw new Error("agent_loop_artifact_preview_unavailable");
      return result.artifactPreview;
    },
    createInputSubmissionIntent(taskId, expectedRevision, targetLogicalSessionId, content) {
      const normalized = requiredText(content, "task input");
      return Object.freeze({
        commandId: createRuntimeId("command"),
        humanInterventionId: createRuntimeId("human_intervention"),
        taskId,
        expectedRevision,
        targetLogicalSessionId,
        content: normalized,
      });
    },
    async submitTaskInput(intent) {
      const task = await requireTask(intent.taskId);
      if (task.task.revision !== intent.expectedRevision) {
        throw new Error("agent_loop_task_revision_stale");
      }
      const run = task.activeRun;
      if (!run) throw new Error("agent_loop_task_run_unavailable_for_input");
      const target = task.logicalSessions.find((session) =>
        session.logicalSessionId === intent.targetLogicalSessionId && session.runId === run.runId,
      );
      if (!target) throw new Error("agent_loop_target_logical_session_unavailable");
      if (target.kind === "conductor") {
        await options.client.command(withCommandEnvelope({
          type: "task.submit_input",
          taskId: intent.taskId,
          expectedRevision: intent.expectedRevision,
          runId: run.runId,
          targetLogicalSessionId: target.logicalSessionId,
          content: intent.content,
        }, now, intent.commandId));
        return Object.freeze({ state: "sent" });
      }
      const result = await options.client.command(withCommandEnvelope({
        type: "session.send_human_message",
        taskId: intent.taskId,
        expectedRevision: intent.expectedRevision,
        runId: run.runId,
        humanInterventionId: intent.humanInterventionId,
        idempotencyKey: intent.commandId,
        targetLogicalSessionId: target.logicalSessionId,
        content: intent.content,
      }, now, intent.commandId));
      const intervention = result.readModel?.task?.humanInterventions.find((entry) => entry.humanInterventionId === intent.humanInterventionId);
      if (!intervention) throw new Error("agent_loop_human_intervention_result_unavailable");
      return Object.freeze({
        state: intervention.state === "sent" ? "sent" : "interrupting",
        humanInterventionId: intervention.humanInterventionId,
      });
    },
    async respondAttention(input) {
      const task = await requireTask(input.taskId);
      if (task.task.revision !== input.expectedRevision) {
        throw new Error("agent_loop_task_revision_stale");
      }
      const attention = task.attentions.find((item) => item.attentionId === input.attentionId);
      if (!attention) throw new Error("agent_loop_attention_not_found");
      await issue(`attention.respond:${input.taskId}:${input.expectedRevision}:${input.attentionId}`, {
        type: "attention.respond",
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
        attentionId: input.attentionId,
        bindingId: attention.bindingId,
        bindingRevision: attention.bindingRevision,
        nativeRequestId: attention.nativeRequestId,
        ...(attention.activeInputSubmissionId ? { activeInputSubmissionId: attention.activeInputSubmissionId } : {}),
        ...(attention.activeInvocationId ? { activeInvocationId: attention.activeInvocationId } : {}),
        response: { text: requiredText(input.response, "attention response") } satisfies JsonObject,
      });
    },
  });
}

function withCommandEnvelope(command: RuntimeCommandInput, now: () => string, commandId: string): RuntimeCommand {
  return {
    ...command,
    commandId,
    issuedAt: now(),
  } as RuntimeCommand;
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
