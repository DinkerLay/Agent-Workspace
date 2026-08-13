import type {
  AgentCardId,
  CanonicalContent,
  ExecutionProfileId,
  FinalForConductor,
  LogicalSessionId,
  RuntimeCommandId,
  SendToSessionPayload,
  SessionMessageId,
  SessionTurnId,
  TaskId,
  TaskRunId,
} from "@agent-workspace/runtime-contracts";
import {
  canonicalizeFinal,
  createSessionIdOrchestrationKernel,
  invariant,
  projectFinalForConductor,
} from "@agent-workspace/runtime-domain";

/**
 * The Host owns this immutable scope. It is deliberately wider than the four
 * public tool schemas: none of these reliability fields are model supplied.
 */
export type SessionIdOrchestrationTaskScope = Readonly<{
  taskId: TaskId;
  runId: TaskRunId;
  revision: number;
  conductorSessionId: LogicalSessionId;
  conductorSessionTurnId: SessionTurnId;
  agentCards: readonly Readonly<{
    agentCardId: AgentCardId;
    executionProfileId: ExecutionProfileId;
  }>[];
}>;

export type ScopedConductorCommand = Readonly<{
  taskId: TaskId;
  runId: TaskRunId;
  expectedRevision: number;
  conductorSessionId: LogicalSessionId;
  conductorSessionTurnId: SessionTurnId;
  commandId?: RuntimeCommandId;
  idempotencyKey: string;
}>;

export type InvokeAgentApplicationCommand = ScopedConductorCommand & Readonly<{
  agentCardId: AgentCardId;
}>;

export type SendToSessionApplicationCommand = ScopedConductorCommand & Readonly<{
  sessionId: LogicalSessionId;
  payload: SendToSessionPayload;
}>;

export type InterruptSessionApplicationCommand = ScopedConductorCommand & Readonly<{
  sessionId: LogicalSessionId;
}>;

export type CloseSessionApplicationCommand = ScopedConductorCommand & Readonly<{
  sessionId: LogicalSessionId;
}>;

export type AgentFinalDraft = Readonly<{
  runId: TaskRunId;
  sessionId: LogicalSessionId;
  inputSubmissionId: string;
  sessionTurnId: SessionTurnId;
  messageId: SessionMessageId;
  content: string;
}>;

export type SessionIdProviderEffect =
  | Readonly<{
      kind: "ensure_binding";
      taskId: TaskId;
      runId: TaskRunId;
      sessionId: LogicalSessionId;
      idempotencyKey: string;
    }>
  | Readonly<{
      kind: "request_interrupt";
      taskId: TaskId;
      runId: TaskRunId;
      sessionId: LogicalSessionId;
      sessionTurnId: SessionTurnId;
      idempotencyKey: string;
    }>;

export type SessionIdProviderEffectReceipt = Readonly<{
  status: "accepted" | "rejected";
  reason?: string;
}>;

export type SessionIdOrchestrationApplicationOptions = Readonly<{
  now: () => string;
  createId: (kind: string) => string;
  task: SessionIdOrchestrationTaskScope;
  providerEffects: Readonly<{
    submit: (effect: SessionIdProviderEffect) => Promise<SessionIdProviderEffectReceipt>;
  }>;
}>;

type ApplicationMessage = Readonly<{
  messageId: SessionMessageId;
  taskId: TaskId;
  runId: TaskRunId;
  sessionId: LogicalSessionId;
  kind: "conductor_forward" | "agent_final";
  content: string;
  canonicalContent?: CanonicalContent;
  sourceSessionTurnId?: SessionTurnId;
  createdAt: string;
}>;

type ProviderOutboxItem = Readonly<{
  outboxId: string;
  effect: SessionIdProviderEffect;
  state: "pending" | "accepted" | "rejected" | "suppressed";
  attempts: number;
  createdAt: string;
  settledAt?: string;
  reason?: string;
}>;

type BindingProjection = Readonly<{
  sessionId: LogicalSessionId;
  state: "effect_accepted";
  acceptedAt: string;
}>;

type ActiveTurnProjection = Readonly<{
  sessionId: LogicalSessionId;
  sessionTurnId: SessionTurnId;
  sourceConductorSessionTurnId: SessionTurnId;
  state: "active" | "interrupt_requested" | "interrupt_confirmed" | "interrupt_unknown" | "returned";
  updatedAt: string;
}>;

type ControlProjection = Readonly<{
  controlId: string;
  sessionId: LogicalSessionId;
  sessionTurnId: SessionTurnId;
  commandId: string;
  idempotencyKey: string;
  state: "requested" | "accepted" | "confirmed" | "unknown" | "rejected";
  updatedAt: string;
}>;

export type ConductorFinalInput = FinalForConductor & Readonly<{
  kind: "final_for_conductor";
}>;

/**
 * Application path for Session-ID orchestration.
 *
 * This factory intentionally does not compose the superseded application path.
 * Its in-memory owners model one application transaction: domain facts and a
 * durable effect intent are committed together, while Provider submission is
 * performed only by drainOutbox after the command has returned.
 */
export function createSessionIdOrchestrationApplication(options: SessionIdOrchestrationApplicationOptions) {
  const task = Object.freeze({
    ...options.task,
    agentCards: Object.freeze(options.task.agentCards.map((card) => Object.freeze({ ...card }))),
  });
  const kernel = createSessionIdOrchestrationKernel({
    now: options.now,
    taskIdForRun: () => task.taskId,
    createSessionId: () => options.createId("logical_session"),
    executionProfileIdForAgentCard: ({ agentCardId }) => requiredAgentCard(agentCardId).executionProfileId,
  });
  const messages: ApplicationMessage[] = [];
  const outbox: ProviderOutboxItem[] = [];
  const bindings: BindingProjection[] = [];
  const sessions = new Map<LogicalSessionId, TaskRunId>();
  const sendKeys = new Set<string>();
  const finalByTurn = new Map<SessionTurnId, FinalForConductor>();
  const conductorInputs: ConductorFinalInput[] = [];
  const activeTurns = new Map<LogicalSessionId, ActiveTurnProjection>();
  const controls: ControlProjection[] = [];
  const controlReplay = new Map<string, Readonly<{ fingerprint: string; result: Readonly<{ status: "accepted" }> }>>();

  function requiredAgentCard(agentCardId: AgentCardId) {
    const card = task.agentCards.find((candidate) => candidate.agentCardId === agentCardId);
    invariant(Boolean(card), "orchestration_agent_card_not_in_architecture");
    return card!;
  }

  function invokeAgent(command: InvokeAgentApplicationCommand): Readonly<{ sessionId: LogicalSessionId }> {
    assertConductorScope(command);
    requiredAgentCard(command.agentCardId);
    const result = kernel.invokeAgent({
      runId: command.runId,
      agentCardId: command.agentCardId,
      idempotencyKey: command.idempotencyKey,
    });
    sessions.set(result.sessionId, command.runId);
    return result;
  }

  function sendToSession(command: SendToSessionApplicationCommand): Readonly<{ status: "accepted" }> {
    assertConductorScope(command);
    assertSessionScope(command.runId, command.sessionId);

    const alreadyCommitted = sendKeys.has(command.idempotencyKey);
    const needsBindingIntent = !alreadyCommitted && !hasBindingOrIntent(command.sessionId);
    // Allocate the complete external-effect intent before asking the domain
    // owner to commit. This keeps a failing ID allocator on the pre-commit
    // side of the transaction boundary.
    const bindingIntent = needsBindingIntent ? Object.freeze({
      outboxId: options.createId("async_operation"),
      effect: Object.freeze({
        kind: "ensure_binding" as const,
        taskId: task.taskId,
        runId: task.runId,
        sessionId: command.sessionId,
        idempotencyKey: `ensure_binding:${command.sessionId}`,
      }),
      state: "pending" as const,
      attempts: 0,
      createdAt: options.now(),
    }) : undefined;
    const before = kernel.snapshot();
    const result = kernel.sendToSession({
      runId: command.runId,
      sessionId: command.sessionId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.commandId ?? options.createId("command"),
      decidedBySessionTurnId: command.conductorSessionTurnId,
      payload: command.payload,
    });

    // A successful kernel command has atomically committed Forward, Message
    // and Inbox. Mirror only the newly committed immutable facts and enqueue
    // the external effect in the same synchronous application commit.
    if (!alreadyCommitted) {
      const after = kernel.snapshot();
      const message = after.messages[before.messages.length];
      invariant(Boolean(message), "orchestration_send_message_commit_missing");
      messages.push(Object.freeze({
        messageId: message!.messageId,
        taskId: task.taskId,
        runId: command.runId,
        sessionId: command.sessionId,
        kind: "conductor_forward",
        content: message!.content,
        createdAt: message!.createdAt,
      }));
      if (bindingIntent) outbox.push(bindingIntent);
      sendKeys.add(command.idempotencyKey);
    }
    return result;
  }

  function recordSessionTurnActive(input: Readonly<{
    runId: TaskRunId;
    sessionId: LogicalSessionId;
    sessionTurnId: SessionTurnId;
    sourceConductorSessionTurnId: SessionTurnId;
  }>): Readonly<{ status: "recorded" }> {
    invariant(input.runId === task.runId, "orchestration_scope_run_mismatch");
    assertSessionScope(input.runId, input.sessionId);
    const previous = activeTurns.get(input.sessionId);
    invariant(!previous || previous.sessionTurnId === input.sessionTurnId || previous.state === "returned" || previous.state === "interrupt_confirmed", "session_turn_already_active");
    activeTurns.set(input.sessionId, Object.freeze({
      sessionId: input.sessionId,
      sessionTurnId: input.sessionTurnId,
      sourceConductorSessionTurnId: input.sourceConductorSessionTurnId,
      state: "active",
      updatedAt: options.now(),
    }));
    return Object.freeze({ status: "recorded" as const });
  }

  function interruptSession(command: InterruptSessionApplicationCommand): Readonly<{ status: "accepted" }> {
    assertConductorScope(command);
    assertSessionScope(command.runId, command.sessionId);
    const active = activeTurns.get(command.sessionId);
    invariant(Boolean(active), "session_interrupt_active_turn_required");
    invariant(active?.state === "active", "session_interrupt_active_turn_required");
    invariant(active?.sourceConductorSessionTurnId === command.conductorSessionTurnId, "session_interrupt_turn_not_owned_by_conductor");
    const fingerprint = JSON.stringify({ sessionId: command.sessionId, sessionTurnId: active.sessionTurnId });
    const prior = controlReplay.get(command.idempotencyKey);
    if (prior) {
      invariant(prior.fingerprint === fingerprint, "orchestration_idempotency_payload_conflict");
      return prior.result;
    }
    const commandId = command.commandId ?? options.createId("command");
    controls.push(Object.freeze({
      controlId: options.createId("session_control"),
      sessionId: command.sessionId,
      sessionTurnId: active.sessionTurnId,
      commandId,
      idempotencyKey: command.idempotencyKey,
      state: "requested",
      updatedAt: options.now(),
    }));
    activeTurns.set(command.sessionId, Object.freeze({ ...active, state: "interrupt_requested", updatedAt: options.now() }));
    outbox.push(Object.freeze({
      outboxId: options.createId("async_operation"),
      effect: Object.freeze({
        kind: "request_interrupt",
        taskId: task.taskId,
        runId: task.runId,
        sessionId: command.sessionId,
        sessionTurnId: active.sessionTurnId,
        idempotencyKey: command.idempotencyKey,
      }),
      state: "pending",
      attempts: 0,
      createdAt: options.now(),
    }));
    const result = Object.freeze({ status: "accepted" as const });
    controlReplay.set(command.idempotencyKey, Object.freeze({ fingerprint, result }));
    return result;
  }

  function recordInterruptOutcome(input: Readonly<{
    runId: TaskRunId;
    sessionId: LogicalSessionId;
    sessionTurnId: SessionTurnId;
    outcome: "confirmed" | "unknown";
  }>): Readonly<{ status: "recorded" }> {
    invariant(input.runId === task.runId, "orchestration_scope_run_mismatch");
    const active = activeTurns.get(input.sessionId);
    invariant(active?.sessionTurnId === input.sessionTurnId, "session_interrupt_turn_mismatch");
    const controlIndex = controls.findIndex((control) => control.sessionId === input.sessionId
      && control.sessionTurnId === input.sessionTurnId);
    invariant(controlIndex >= 0, "session_interrupt_control_missing");
    const control = controls[controlIndex]!;
    if (control.state === input.outcome) return Object.freeze({ status: "recorded" as const });
    invariant(control.state === "requested" || control.state === "accepted", "session_interrupt_outcome_conflict");
    controls[controlIndex] = Object.freeze({ ...control, state: input.outcome, updatedAt: options.now() });
    activeTurns.set(input.sessionId, Object.freeze({
      ...active,
      state: input.outcome === "confirmed" ? "interrupt_confirmed" : "interrupt_unknown",
      updatedAt: options.now(),
    }));
    return Object.freeze({ status: "recorded" as const });
  }

  function closeSession(command: CloseSessionApplicationCommand): Readonly<{ status: "closed" }> {
    assertConductorScope(command);
    assertSessionScope(command.runId, command.sessionId);
    const active = activeTurns.get(command.sessionId);
    invariant(!active || active.state === "returned" || active.state === "interrupt_confirmed", "session_close_active_or_ambiguous");
    const result = kernel.closeSession({
      runId: command.runId,
      sessionId: command.sessionId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.commandId,
    });
    for (let index = 0; index < outbox.length; index += 1) {
      const item = outbox[index]!;
      if (item.effect.sessionId !== command.sessionId || item.state !== "pending") continue;
      outbox[index] = Object.freeze({ ...item, state: "suppressed", settledAt: options.now(), reason: "session_closed" });
    }
    return result;
  }

  async function drainOutbox(): Promise<void> {
    // FIFO effect draining preserves the ordering of committed lane intents.
    for (let index = 0; index < outbox.length; index += 1) {
      const item = outbox[index]!;
      if (item.state !== "pending") continue;
      const effect = item.effect;
      const receipt = await options.providerEffects.submit(effect);
      const settledAt = options.now();
      outbox[index] = Object.freeze({
        ...item,
        state: receipt.status,
        attempts: item.attempts + 1,
        settledAt,
        ...(receipt.reason ? { reason: receipt.reason } : {}),
      });
      if (effect.kind === "request_interrupt") {
        const controlIndex = controls.findIndex((control) => control.sessionId === effect.sessionId
          && control.sessionTurnId === effect.sessionTurnId);
        if (controlIndex >= 0) {
          const control = controls[controlIndex]!;
          controls[controlIndex] = Object.freeze({
            ...control,
            state: receipt.status === "accepted" ? "accepted" : "rejected",
            updatedAt: settledAt,
          });
        }
      }
      if (effect.kind === "ensure_binding" && receipt.status === "accepted" && !bindings.some((binding) => binding.sessionId === effect.sessionId)) {
        bindings.push(Object.freeze({
          sessionId: effect.sessionId,
          state: "effect_accepted",
          acceptedAt: settledAt,
        }));
      }
    }
  }

  function recordAgentFinal(draft: AgentFinalDraft): Readonly<{ status: "recorded" }> {
    invariant(draft.runId === task.runId, "orchestration_scope_run_mismatch");
    assertSessionScope(draft.runId, draft.sessionId);
    invariant(!finalByTurn.has(draft.sessionTurnId), "session_turn_final_already_recorded");
    invariant(Boolean(draft.inputSubmissionId.trim()), "input_submission_id_required");
    invariant(Boolean(draft.content.trim()), "agent_final_content_required");

    const content = canonicalizeFinal({ messageId: draft.messageId, content: draft.content });
    const envelope = projectFinalForConductor({
      messageId: draft.messageId,
      sourceSessionId: draft.sessionId,
      content,
    });
    messages.push(Object.freeze({
      messageId: draft.messageId,
      taskId: task.taskId,
      runId: draft.runId,
      sessionId: draft.sessionId,
      kind: "agent_final",
      content: draft.content,
      canonicalContent: content,
      sourceSessionTurnId: draft.sessionTurnId,
      createdAt: options.now(),
    }));
    finalByTurn.set(draft.sessionTurnId, envelope);
    const active = activeTurns.get(draft.sessionId);
    if (active?.sessionTurnId === draft.sessionTurnId) {
      activeTurns.set(draft.sessionId, Object.freeze({ ...active, state: "returned", updatedAt: options.now() }));
    }
    conductorInputs.push(Object.freeze({ kind: "final_for_conductor", ...envelope }));
    return Object.freeze({ status: "recorded" as const });
  }

  function readConductorInputs(): readonly ConductorFinalInput[] {
    return Object.freeze(conductorInputs.map((input) => Object.freeze({ ...input })));
  }

  function snapshot() {
    const state = kernel.snapshot();
    return Object.freeze({
      ...state,
      messages: Object.freeze(messages.map((message) => Object.freeze({ ...message }))),
      messageForwards: state.forwards,
      bindings: Object.freeze(bindings.map((binding) => Object.freeze({ ...binding }))),
      outbox: Object.freeze(outbox.map((item) => Object.freeze({ ...item }))),
      activeTurns: Object.freeze([...activeTurns.values()].map((turn) => Object.freeze({ ...turn }))),
      controls: Object.freeze(controls.map((control) => Object.freeze({ ...control }))),
    });
  }

  return Object.freeze({
    invokeAgent,
    sendToSession,
    recordSessionTurnActive,
    interruptSession,
    recordInterruptOutcome,
    closeSession,
    drainOutbox,
    recordAgentFinal,
    readConductorInputs,
    snapshot,
  });

  function assertConductorScope(command: ScopedConductorCommand): void {
    invariant(command.taskId === task.taskId, "orchestration_scope_task_mismatch");
    invariant(command.runId === task.runId, "orchestration_scope_run_mismatch");
    invariant(Number.isSafeInteger(command.expectedRevision), "orchestration_scope_revision_invalid");
    invariant(command.expectedRevision === task.revision, "orchestration_scope_revision_stale");
    invariant(command.conductorSessionId === task.conductorSessionId, "orchestration_scope_conductor_session_mismatch");
    invariant(command.conductorSessionTurnId === task.conductorSessionTurnId, "orchestration_scope_turn_stale");
    invariant(Boolean(command.idempotencyKey.trim()), "orchestration_idempotency_key_required");
  }

  function assertSessionScope(runId: TaskRunId, sessionId: LogicalSessionId): void {
    const sessionRunId = sessions.get(sessionId);
    invariant(Boolean(sessionRunId), "orchestration_session_unknown");
    invariant(sessionRunId === runId, "orchestration_session_scope_mismatch");
  }

  function hasBindingOrIntent(sessionId: LogicalSessionId): boolean {
    return bindings.some((binding) => binding.sessionId === sessionId)
      || outbox.some((item) => item.effect.sessionId === sessionId && item.state !== "rejected");
  }
}
