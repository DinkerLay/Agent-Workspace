import {
  createId,
  type SessionIdAcpTaskBindingReadModel,
  type SessionIdAcpTaskControlReadModel,
  type SessionIdAcpTaskDirectoryState,
  type SessionIdAcpTaskFileObservationReadModel,
  type SessionIdAcpTaskHumanDeliveryReadModel,
  type SessionIdAcpTaskProfileReadModel,
  type SessionIdAcpTaskReadModel,
  type SessionIdAcpTaskSessionReadModel,
  type SessionIdAcpTaskTimelineItemReadModel,
} from "@agent-workspace/runtime-contracts";

export type AgentLoopSessionIdDirectoryState = SessionIdAcpTaskDirectoryState;
export type AgentLoopSessionIdDirectoryItem = SessionIdAcpTaskReadModel["directory"][number];
export type AgentLoopSessionIdControlItem = SessionIdAcpTaskControlReadModel;
export type AgentLoopSessionIdHumanDelivery = SessionIdAcpTaskHumanDeliveryReadModel;

export type AgentLoopSessionIdPlanningFence = Readonly<{
  planningFenceId: string;
  revision: number;
  currentConductorSessionTurnId: string;
  advancedAt: string;
}>;

export type AgentLoopSessionIdContinuity = Readonly<{
  runtimeInstanceId: string;
  lineageId: string;
  recoveryState: "live" | "recovered";
  restoredAt?: string;
  continuedFromSurface?: "browser" | "electron";
}>;

export type AgentLoopSessionIdProfileV3 = SessionIdAcpTaskProfileReadModel;
export type AgentLoopSessionIdProfile = AgentLoopSessionIdProfileV3;
export type AgentLoopSessionIdTimelineItem = SessionIdAcpTaskTimelineItemReadModel;
export type AgentLoopSessionIdSession = SessionIdAcpTaskSessionReadModel;
export type AgentLoopSessionIdBinding = SessionIdAcpTaskBindingReadModel;
export type AgentLoopWorkspaceFileObservation = SessionIdAcpTaskFileObservationReadModel;

export type AgentLoopWorkspaceFilePreview = Readonly<{
  observation: AgentLoopWorkspaceFileObservation;
  content?: string;
}>;

export type AgentLoopSessionIdTaskReadModel = SessionIdAcpTaskReadModel & Readonly<{
  continuity?: AgentLoopSessionIdContinuity;
}>;

export type AgentLoopSessionIdInvalidation = Readonly<{
  taskId: string;
  reason: string;
}>;

export type AgentLoopSessionIdHumanMessageTarget =
  | Readonly<{
      targetAgentCardId: string;
      targetLogicalSessionId?: never;
    }>
  | Readonly<{
      targetLogicalSessionId: string;
      targetAgentCardId?: never;
    }>;

export type AgentLoopSessionIdUiCommand =
  | CommandEnvelope & Readonly<{
      type: "task.submit_input";
      taskId: string;
      expectedRevision: number;
      runId: string;
      targetLogicalSessionId: string;
      content: string;
    }>
  | (CommandEnvelope & AgentLoopSessionIdHumanMessageTarget & Readonly<{
      type: "session.send_human_message";
      taskId: string;
      expectedRevision: number;
      runId: string;
      humanInterventionId: string;
      idempotencyKey: string;
      content: string;
    }>)
  | CommandEnvelope & Readonly<{
      type: "session.abandon_human_message";
      taskId: string;
      expectedRevision: number;
      runId: string;
      humanInterventionId: string;
      idempotencyKey: string;
    }>
  | CommandEnvelope & Readonly<{
      type: "session.request_interrupt";
      taskId: string;
      expectedRevision: number;
      runId: string;
      targetLogicalSessionId: string;
      humanInterventionId: string;
      idempotencyKey: string;
    }>
  | CommandEnvelope & Readonly<{
      type: "session.respond_interaction";
      taskId: string;
      expectedRevision: number;
      runId: string;
      targetLogicalSessionId: string;
      interactionId: string;
      expectedInteractionRevision: number;
      choiceId: string;
    }>
  | CommandEnvelope & Readonly<{
      type: "task.stop";
      taskId: string;
      expectedRevision: number;
      runId: string;
    }>
  | CommandEnvelope & Readonly<{
      type: "workspace.preview_file";
      taskId: string;
      expectedRevision: number;
      runId: string;
      observationId: string;
    }>;

type CommandEnvelope = Readonly<{
  commandId: string;
  uiIntentId: string;
  issuedAt: string;
}>;

export type AgentLoopSessionIdCommandResult = Readonly<{
  humanIntervention?: Readonly<{
    humanInterventionId: string;
    state: "sent" | "held" | "suppressed" | "abandoned";
    targetLogicalSessionId: string;
    materializedGeneration?: number;
  }>;
  control?: Readonly<{
    sessionControlAuditId: string;
    state: "requested" | "accepted";
  }>;
  interactionResponse?: Readonly<{
    humanInterventionId: string;
    state: "accepted";
    targetLogicalSessionId: string;
    interactionId: string;
    choiceId: string;
    label: string;
  }>;
  filePreview?: AgentLoopWorkspaceFilePreview;
}>;

/** Typed ACP v3 Runtime boundary consumed by the production Workbench. */
export type AgentLoopSessionIdRuntimePort = Readonly<{
  read(input: Readonly<{ taskId: string }>): Promise<AgentLoopSessionIdTaskReadModel>;
  command(command: AgentLoopSessionIdUiCommand): Promise<AgentLoopSessionIdCommandResult>;
  subscribe(
    input: Readonly<{ taskId: string }>,
    onChanged: (invalidation: AgentLoopSessionIdInvalidation) => void,
  ): Promise<() => void>;
}>;

export type AgentLoopSessionIdHumanSendOutcome = Readonly<{
  humanInterventionId: string;
  state: "sent" | "held" | "suppressed";
  targetLogicalSessionId: string;
  materializedGeneration?: number;
}>;

export type AgentLoopSessionIdHumanAbandonOutcome = Readonly<{
  humanInterventionId: string;
  state: "abandoned";
  targetLogicalSessionId: string;
}>;

export type AgentLoopSessionIdInterruptOutcome = Readonly<{
  sessionControlAuditId: string;
  state: "requested" | "accepted";
}>;

export type AgentLoopSessionIdRuntimeController = Readonly<{
  load(): Promise<AgentLoopSessionIdTaskReadModel>;
  subscribe(onChanged: (invalidation: AgentLoopSessionIdInvalidation) => void): Promise<() => void>;
  submitTaskMessage(content: string, uiIntentId: string): Promise<void>;
  sendHumanMessage(
    target: AgentLoopSessionIdHumanMessageTarget,
    content: string,
    uiIntentId: string,
  ): Promise<AgentLoopSessionIdHumanSendOutcome>;
  abandonHumanMessage(humanInterventionId: string, uiIntentId: string): Promise<AgentLoopSessionIdHumanAbandonOutcome>;
  requestHumanInterrupt(sessionId: string, uiIntentId: string): Promise<AgentLoopSessionIdInterruptOutcome>;
  respondInteraction(sessionId: string, interactionId: string, choiceId: string, uiIntentId: string): Promise<void>;
  stopTask(uiIntentId: string): Promise<void>;
  previewFile(observationId: string, uiIntentId: string): Promise<AgentLoopWorkspaceFilePreview>;
}>;

export type AgentLoopSessionIdCommandTrace = Readonly<{
  uiIntentId: string;
  commandId: string;
  intentKind: string;
  taskId?: string;
}>;

export type AgentLoopSessionIdRuntimeControllerOptions = Readonly<{
  client: AgentLoopSessionIdRuntimePort;
  taskId: string;
  now?: () => string;
  createRuntimeId?: typeof createId;
  onCommandTrace?: (trace: AgentLoopSessionIdCommandTrace) => void;
}>;

/**
 * Converts rendered user actions into target Runtime commands. It never
 * infers lifecycle from a selected tab and exposes no invoke action. A first
 * authenticated human message may address an unmaterialized Card explicitly;
 * Runtime owns the resulting generation and message transaction.
 */
export function createAgentLoopSessionIdRuntimeController(
  options: AgentLoopSessionIdRuntimeControllerOptions,
): AgentLoopSessionIdRuntimeController {
  const now = options.now ?? (() => new Date().toISOString());
  const createRuntimeId = options.createRuntimeId ?? createId;
  const pendingCommands = new Map<string, AgentLoopSessionIdUiCommand>();

  const readTask = async (): Promise<AgentLoopSessionIdTaskReadModel> => {
    const model = await options.client.read({ taskId: options.taskId });
    if (model.taskId !== options.taskId) throw new Error("agent_loop_session_id_task_mismatch");
    return model;
  };

  const issue = async <Command extends AgentLoopSessionIdUiCommand>(
    key: string,
    createCommand: () => Promise<Command>,
    uiIntentIdValue: string,
    validateResult?: (result: AgentLoopSessionIdCommandResult, command: Command) => void,
  ) => {
    const existing = pendingCommands.get(key);
    const uiIntentId = requiredText(uiIntentIdValue, "ui intent id");
    const command = (existing ?? await createCommand()) as Command;
    if (!existing) pendingCommands.set(key, command);
    if (command.uiIntentId !== uiIntentId) throw new Error("agent_loop_ui_intent_retry_conflict");
    options.onCommandTrace?.(Object.freeze({
      uiIntentId: command.uiIntentId,
      commandId: command.commandId,
      intentKind: command.type,
      taskId: command.taskId,
    }));
    const result = await options.client.command(command);
    validateResult?.(result, command);
    if (pendingCommands.get(key) === command) pendingCommands.delete(key);
    return Object.freeze({ command, result });
  };

  const currentSession = (task: AgentLoopSessionIdTaskReadModel, logicalSessionId: string): AgentLoopSessionIdSession => {
    const session = task.sessions.find((candidate) => candidate.logicalSessionId === logicalSessionId);
    if (!session || session.kind !== "card" || session.lifecycle !== "current") {
      throw new Error("agent_loop_session_id_current_card_required");
    }
    return session;
  };

  return Object.freeze({
    load: readTask,
    async subscribe(onChanged) {
      return options.client.subscribe({ taskId: options.taskId }, onChanged);
    },
    async submitTaskMessage(content, uiIntentId) {
      const normalized = requiredText(content, "task message");
      await issue(`task.submit_input:${normalized}`, async () => {
        const task = await readTask();
        return Object.freeze({
          type: "task.submit_input" as const,
          commandId: createRuntimeId("command"),
          uiIntentId,
          issuedAt: now(),
          taskId: task.taskId,
          expectedRevision: task.revision,
          runId: task.runId,
          targetLogicalSessionId: task.conductorLogicalSessionId,
          content: normalized,
        });
      }, uiIntentId);
    },
    async sendHumanMessage(target, content, uiIntentId) {
      const normalized = requiredText(content, "human message");
      const hasLogicalSession = typeof target.targetLogicalSessionId === "string"
        && Boolean(target.targetLogicalSessionId.trim());
      const hasAgentCard = typeof target.targetAgentCardId === "string" && Boolean(target.targetAgentCardId.trim());
      if (hasLogicalSession === hasAgentCard) throw new Error("agent_loop_human_intervention_target_invalid");
      const normalizedTarget: AgentLoopSessionIdHumanMessageTarget = hasLogicalSession
        ? { targetLogicalSessionId: requiredText(target.targetLogicalSessionId!, "logical session id") }
        : { targetAgentCardId: requiredText(target.targetAgentCardId!, "agent card id") };
      const targetKey = normalizedTarget.targetLogicalSessionId
        ? `session:${normalizedTarget.targetLogicalSessionId}`
        : `card:${normalizedTarget.targetAgentCardId}`;
      const { command, result } = await issue(
        `session.send_human_message:${targetKey}:${normalized}`,
        async () => {
          const task = await readTask();
          if (typeof normalizedTarget.targetLogicalSessionId === "string") {
            currentSession(task, normalizedTarget.targetLogicalSessionId);
          } else {
            const card = task.directory.find((candidate) => candidate.agentCardId === normalizedTarget.targetAgentCardId);
            if (!card || card.state !== "no_session" || card.currentLogicalSessionId) {
              throw new Error("agent_loop_session_id_unmaterialized_card_required");
            }
          }
          const commandId = createRuntimeId("command");
          return Object.freeze({
            type: "session.send_human_message" as const,
            commandId,
            uiIntentId,
            issuedAt: now(),
            taskId: task.taskId,
            expectedRevision: task.revision,
            runId: task.runId,
            ...normalizedTarget,
            humanInterventionId: createRuntimeId("human_intervention"),
            idempotencyKey: commandId,
            content: normalized,
          });
        },
        uiIntentId,
        (candidate, issued) => {
          if (!candidate.humanIntervention
            || candidate.humanIntervention.humanInterventionId !== issued.humanInterventionId
            || !candidate.humanIntervention.targetLogicalSessionId) {
            throw new Error("agent_loop_human_intervention_result_unavailable");
          }
          if (issued.targetLogicalSessionId
            && candidate.humanIntervention.targetLogicalSessionId !== issued.targetLogicalSessionId) {
            throw new Error("agent_loop_human_intervention_result_target_mismatch");
          }
        },
      );
      if (result.humanIntervention!.state === "abandoned") {
        throw new Error("agent_loop_human_intervention_result_state_invalid");
      }
      return Object.freeze({
        humanInterventionId: command.humanInterventionId,
        state: result.humanIntervention!.state,
        targetLogicalSessionId: result.humanIntervention!.targetLogicalSessionId,
        ...(result.humanIntervention!.materializedGeneration === undefined
          ? {}
          : { materializedGeneration: result.humanIntervention!.materializedGeneration }),
      });
    },
    async abandonHumanMessage(humanInterventionIdValue, uiIntentId) {
      const humanInterventionId = requiredText(humanInterventionIdValue, "human intervention id");
      const { result } = await issue(
        `session.abandon_human_message:${humanInterventionId}`,
        async () => {
          const task = await readTask();
          const delivery = task.sessions.flatMap((session) => session.humanDeliveries
            .map((candidate) => ({ session, delivery: candidate })))
            .find((candidate) => candidate.delivery.humanInterventionId === humanInterventionId);
          if (!delivery || !["pending", "held"].includes(delivery.delivery.cardState)) {
            throw new Error("agent_loop_human_intervention_not_abandonable");
          }
          const commandId = createRuntimeId("command");
          return Object.freeze({
            type: "session.abandon_human_message" as const,
            commandId,
            uiIntentId,
            issuedAt: now(),
            taskId: task.taskId,
            expectedRevision: task.revision,
            runId: task.runId,
            humanInterventionId,
            idempotencyKey: commandId,
          });
        },
        uiIntentId,
        (candidate, issued) => {
          if (candidate.humanIntervention?.humanInterventionId !== issued.humanInterventionId
            || candidate.humanIntervention.state !== "abandoned"
            || !candidate.humanIntervention.targetLogicalSessionId) {
            throw new Error("agent_loop_human_abandon_result_unavailable");
          }
        },
      );
      return Object.freeze({
        humanInterventionId: result.humanIntervention!.humanInterventionId,
        state: "abandoned" as const,
        targetLogicalSessionId: result.humanIntervention!.targetLogicalSessionId,
      });
    },
    async requestHumanInterrupt(sessionId, uiIntentId) {
      const { result } = await issue(
        `session.request_interrupt:${sessionId}`,
        async () => {
          const task = await readTask();
          currentSession(task, sessionId);
          const commandId = createRuntimeId("command");
          return Object.freeze({
            type: "session.request_interrupt" as const,
            commandId,
            uiIntentId,
            issuedAt: now(),
            taskId: task.taskId,
            expectedRevision: task.revision,
            runId: task.runId,
            targetLogicalSessionId: sessionId,
            humanInterventionId: createRuntimeId("human_intervention"),
            idempotencyKey: commandId,
          });
        },
        uiIntentId,
        (candidate) => {
          if (!candidate.control) throw new Error("agent_loop_session_control_result_unavailable");
        },
      );
      return Object.freeze(result.control!);
    },
    async respondInteraction(sessionId, interactionId, choiceId, uiIntentId) {
      const normalizedInteractionId = requiredText(interactionId, "interaction id");
      const normalizedChoiceId = requiredText(choiceId, "interaction choice id");
      await issue(
        `session.respond_interaction:${sessionId}:${normalizedInteractionId}:${normalizedChoiceId}`,
        async () => {
          const task = await readTask();
          const session = currentSession(task, sessionId);
          const interaction = session.interactions.find((candidate) => (
            candidate.interactionId === normalizedInteractionId
          ));
          if (!interaction || !interaction.choices.some((choice) => choice.choiceId === normalizedChoiceId)) {
            throw new Error("agent_loop_session_interaction_unavailable");
          }
          return Object.freeze({
            type: "session.respond_interaction" as const,
            commandId: createRuntimeId("command"),
            uiIntentId,
            issuedAt: now(),
            taskId: task.taskId,
            expectedRevision: task.revision,
            runId: task.runId,
            targetLogicalSessionId: sessionId,
            interactionId: normalizedInteractionId,
            expectedInteractionRevision: interaction.interactionRevision,
            choiceId: normalizedChoiceId,
          });
        },
        uiIntentId,
        (candidate, issued) => {
          if (!candidate.interactionResponse
            || candidate.interactionResponse.state !== "accepted"
            || candidate.interactionResponse.targetLogicalSessionId !== issued.targetLogicalSessionId
            || candidate.interactionResponse.interactionId !== issued.interactionId
            || candidate.interactionResponse.choiceId !== issued.choiceId) {
            throw new Error("agent_loop_session_interaction_result_unavailable");
          }
        },
      );
    },
    async stopTask(uiIntentId) {
      await issue("task.stop", async () => {
        const task = await readTask();
        return Object.freeze({
          type: "task.stop" as const,
          commandId: createRuntimeId("command"),
          uiIntentId,
          issuedAt: now(),
          taskId: task.taskId,
          expectedRevision: task.revision,
          runId: task.runId,
        });
      }, uiIntentId);
    },
    async previewFile(observationId, uiIntentId) {
      const { result } = await issue(
        `workspace.preview_file:${observationId}`,
        async () => {
          const task = await readTask();
          if (!task.files.some((file) => file.observationId === observationId)) {
            throw new Error("agent_loop_workspace_observation_not_found");
          }
          return Object.freeze({
            type: "workspace.preview_file" as const,
            commandId: createRuntimeId("command"),
            uiIntentId,
            issuedAt: now(),
            taskId: task.taskId,
            expectedRevision: task.revision,
            runId: task.runId,
            observationId,
          });
        },
        uiIntentId,
        (candidate) => {
          if (!candidate.filePreview) throw new Error("agent_loop_workspace_preview_unavailable");
        },
      );
      return result.filePreview!;
    },
  });
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}
