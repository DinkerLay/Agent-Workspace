import { hashDefinition } from "@agent-workspace/runtime-contracts";
import { canonicalizeFinal, invariant } from "@agent-workspace/runtime-domain";

export type SessionIdRaceRecoveryCoordinatorOptions = Readonly<{
  now: () => string;
  task: Readonly<{
    taskId: string;
    runId: string;
    revision: number;
    conductorSessionId: string;
    activeConductorSessionTurnId: string;
  }>;
  sessions: readonly Readonly<{
    sessionId: string;
    activeSessionTurnId?: string;
  }>[];
}>;

type HumanInterventionState =
  | "interrupting"
  | "ready_to_deliver"
  | "ambiguous"
  | "cancelled_by_user"
  | "cancelled_by_task_stop";

type HumanInterventionProjection = Readonly<{
  humanInterventionId: string;
  commandId: string;
  idempotencyKey: string;
  sessionId: string;
  mode: "direct" | "interrupt_then_send" | "scoped_interrupt" | "attention_response";
  state: HumanInterventionState;
  content?: string;
  activeSessionTurnId?: string;
  conductorMessageId?: string;
  cardMessageId?: string;
  createdAt: string;
  updatedAt: string;
}>;

type RaceMessage = Readonly<{
  messageId: string;
  kind: "user_input" | "runtime_notice" | "agent_final";
  sessionId: string;
  content: string | ReturnType<typeof canonicalizeFinal>;
  createdAt: string;
}>;

type ConductorInboxProjection = Readonly<{
  inboxItemId: string;
  sequence: number;
  state: "pending" | "suppressed";
  reason?: string;
  kind: "human_intervention_for_conductor" | "session_notice_for_conductor" | "final_for_conductor";
  messageId: string;
  sessionId?: string;
  sourceSessionId?: string;
  content: string | ReturnType<typeof canonicalizeFinal>;
  causalMessageId?: string;
}>;

type CardInboxProjection = Readonly<{
  inboxItemId: string;
  sequence: number;
  sessionId: string;
  messageId: string;
  state: "held_by_human_intervention" | "pending" | "suppressed";
  reason?: string;
  humanInterventionId: string;
}>;

type ControlAuditProjection = Readonly<{
  controlAuditId: string;
  sessionId: string;
  commandId: string;
  kind: "human_interrupt" | "scoped_interrupt";
  state: "requested" | "accepted" | "confirmed" | "unknown";
  createdAt: string;
  updatedAt: string;
}>;

type ProviderOutboxProjection = Readonly<{
  outboxId: string;
  kind: "request_interrupt";
  sessionId: string;
  affectedSessionTurnId?: string;
  state: "pending" | "suppressed";
  createdAt: string;
}>;

/**
 * Focused race/recovery owner for the Session-ID production path.
 * Every public method first commits intent/facts to these owner collections;
 * Provider transport is represented only by a durable outbox projection.
 */
export function createSessionIdRaceRecoveryCoordinator(options: SessionIdRaceRecoveryCoordinatorOptions) {
  const task = Object.freeze({ ...options.task });
  const sessions = new Map(options.sessions.map((session) => [session.sessionId, Object.freeze({ ...session })]));
  let planningFence: Readonly<{
    planningFenceId: string;
    sourceCommandId: string;
    previousConductorSessionTurnId: string;
    currentConductorSessionTurnId: string;
    createdAt: string;
  }> | undefined;
  let taskState: "running" | "stopped" = "running";
  let sequence = 0;
  let idSequence = 0;
  const messageForwards: Array<Readonly<Record<string, unknown>>> = [];
  const humanInterventions: HumanInterventionProjection[] = [];
  const messages: RaceMessage[] = [];
  const conductorInbox: ConductorInboxProjection[] = [];
  const cardInbox: CardInboxProjection[] = [];
  const inputSubmissions: Array<Readonly<Record<string, unknown>>> = [];
  const controlAudits: ControlAuditProjection[] = [];
  const providerOutbox: ProviderOutboxProjection[] = [];
  const lateResultAudits: Array<Readonly<{
    sessionId: string;
    sessionTurnId: string;
    messageId: string;
    contentDigest: string;
    observedAt: string;
  }>> = [];
  const idempotency = new Map<string, Readonly<{ fingerprint: string; result: unknown }>>();
  const admittedNotices = new Set<string>();
  const finalByTurn = new Map<string, string>();
  const stopCommands = new Set<string>();

  const nextId = (prefix: string): string => `${prefix}_race${String(++idSequence).padStart(5, "0")}`;
  const nextSequence = (): number => ++sequence;

  function acceptTaskInput(command: Readonly<{ commandId: string; expectedRevision: number; content: string }>) {
    assertTaskMutable(command.expectedRevision);
    invariant(Boolean(command.commandId.trim()), "task_input_command_id_required");
    invariant(Boolean(command.content.trim()), "task_input_content_required");
    const idempotencyKey = `task-input:${command.commandId}`;
    const fingerprint = JSON.stringify(command);
    const replay = replayIdempotent<Readonly<{ status: "accepted" }>>(idempotencyKey, fingerprint);
    if (replay) return replay;
    const previous = planningFence?.currentConductorSessionTurnId ?? task.activeConductorSessionTurnId;
    planningFence = Object.freeze({
      planningFenceId: nextId("planning_fence"),
      sourceCommandId: command.commandId,
      previousConductorSessionTurnId: previous,
      currentConductorSessionTurnId: `session_turn_conductor_${command.commandId.replace(/[^a-zA-Z0-9-]/g, "")}`,
      createdAt: options.now(),
    });
    const result = Object.freeze({ status: "accepted" as const });
    rememberIdempotent(idempotencyKey, fingerprint, result);
    return result;
  }

  function sendToSession(command: Readonly<{
    conductorSessionTurnId: string;
    sessionId: string;
    idempotencyKey: string;
    payload: Readonly<{ content?: string }>;
  }>) {
    assertRunning();
    requireSession(command.sessionId);
    invariant(!humanInterventions.some((intervention) => intervention.sessionId === command.sessionId
      && ["interrupting", "ambiguous", "ready_to_deliver"].includes(intervention.state)), "human_intervention_path_active");
    const current = planningFence?.currentConductorSessionTurnId ?? task.activeConductorSessionTurnId;
    invariant(command.conductorSessionTurnId === current, "conductor_planning_fence_stale_turn");
    const fingerprint = JSON.stringify({ sessionId: command.sessionId, payload: command.payload, turn: current });
    const replay = replayIdempotent<Readonly<{ status: "accepted" }>>(command.idempotencyKey, fingerprint);
    if (replay) return replay;
    invariant(Boolean(command.payload.content?.trim()), "orchestration_send_payload_empty");
    messageForwards.push(Object.freeze({
      forwardId: nextId("message_forward"),
      targetSessionId: command.sessionId,
      decidedBySessionTurnId: current,
      content: command.payload.content,
      createdAt: options.now(),
    }));
    const result = Object.freeze({ status: "accepted" as const });
    rememberIdempotent(command.idempotencyKey, fingerprint, result);
    return result;
  }

  function acceptBusyHumanIntervention(command: Readonly<{
    commandId: string;
    idempotencyKey: string;
    sessionId: string;
    content: string;
    activeSessionTurnId: string;
  }>) {
    assertRunning();
    const session = requireSession(command.sessionId);
    invariant(session.activeSessionTurnId === command.activeSessionTurnId, "human_intervention_active_turn_stale");
    invariant(Boolean(command.content.trim()), "human_intervention_content_required");
    const fingerprint = JSON.stringify(command);
    const replay = replayIdempotent<Readonly<{ status: "accepted" }>>(command.idempotencyKey, fingerprint);
    if (replay) return replay;
    const now = options.now();
    const humanInterventionId = nextId("human_intervention");
    const conductorMessageId = nextId("message");
    const cardMessageId = nextId("message");
    const intervention: HumanInterventionProjection = Object.freeze({
      humanInterventionId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sessionId: command.sessionId,
      mode: "interrupt_then_send",
      state: "interrupting",
      content: command.content,
      activeSessionTurnId: command.activeSessionTurnId,
      conductorMessageId,
      cardMessageId,
      createdAt: now,
      updatedAt: now,
    });
    // The mirror is appended before the held Card item in this one logical
    // transaction, so Scheduler recovery can never expose the Card first.
    messages.push(
      Object.freeze({ messageId: conductorMessageId, kind: "user_input", sessionId: task.conductorSessionId, content: command.content, createdAt: now }),
      Object.freeze({ messageId: cardMessageId, kind: "user_input", sessionId: command.sessionId, content: command.content, createdAt: now }),
    );
    conductorInbox.push(Object.freeze({
      inboxItemId: nextId("inbox"),
      sequence: nextSequence(),
      state: "pending",
      kind: "human_intervention_for_conductor",
      messageId: conductorMessageId,
      sessionId: command.sessionId,
      content: command.content,
    }));
    cardInbox.push(Object.freeze({
      inboxItemId: nextId("inbox"),
      sequence: nextSequence(),
      sessionId: command.sessionId,
      messageId: cardMessageId,
      state: "held_by_human_intervention",
      humanInterventionId,
    }));
    const control = newControl(command.sessionId, command.commandId, "human_interrupt");
    controlAudits.push(control);
    providerOutbox.push(Object.freeze({
      outboxId: nextId("async_operation"),
      kind: "request_interrupt",
      sessionId: command.sessionId,
      affectedSessionTurnId: command.activeSessionTurnId,
      state: "pending",
      createdAt: now,
    }));
    humanInterventions.push(intervention);
    const result = Object.freeze({ status: "accepted" as const });
    rememberIdempotent(command.idempotencyKey, fingerprint, result);
    return result;
  }

  function acceptIdleHumanIntervention(command: Readonly<{
    commandId: string;
    idempotencyKey: string;
    sessionId: string;
    content: string;
    mode?: "direct" | "attention_response";
  }>) {
    assertRunning();
    const session = requireSession(command.sessionId);
    invariant(!session.activeSessionTurnId, "human_intervention_session_busy");
    invariant(Boolean(command.content.trim()), "human_intervention_content_required");
    const fingerprint = JSON.stringify(command);
    const replay = replayIdempotent<Readonly<{ status: "accepted" }>>(command.idempotencyKey, fingerprint);
    if (replay) return replay;
    const now = options.now();
    const humanInterventionId = nextId("human_intervention");
    const conductorMessageId = nextId("message");
    const cardMessageId = nextId("message");
    messages.push(
      Object.freeze({ messageId: conductorMessageId, kind: "user_input", sessionId: task.conductorSessionId, content: command.content, createdAt: now }),
      Object.freeze({ messageId: cardMessageId, kind: "user_input", sessionId: command.sessionId, content: command.content, createdAt: now }),
    );
    conductorInbox.push(Object.freeze({
      inboxItemId: nextId("inbox"),
      sequence: nextSequence(),
      state: "pending",
      kind: "human_intervention_for_conductor",
      messageId: conductorMessageId,
      sessionId: command.sessionId,
      content: command.content,
    }));
    cardInbox.push(Object.freeze({
      inboxItemId: nextId("inbox"),
      sequence: nextSequence(),
      sessionId: command.sessionId,
      messageId: cardMessageId,
      state: "pending",
      humanInterventionId,
    }));
    humanInterventions.push(Object.freeze({
      humanInterventionId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      sessionId: command.sessionId,
      mode: command.mode ?? "direct",
      state: "ready_to_deliver",
      content: command.content,
      conductorMessageId,
      cardMessageId,
      createdAt: now,
      updatedAt: now,
    }));
    const result = Object.freeze({ status: "accepted" as const });
    rememberIdempotent(command.idempotencyKey, fingerprint, result);
    return result;
  }

  function requestUserScopedInterrupt(command: Readonly<{
    commandId: string;
    expectedRevision: number;
    sessionId: string;
  }>) {
    assertTaskMutable(command.expectedRevision);
    const session = requireSession(command.sessionId);
    const key = `scoped-interrupt:${command.commandId}`;
    const fingerprint = JSON.stringify(command);
    const replay = replayIdempotent<Readonly<{ status: "accepted" }>>(key, fingerprint);
    if (replay) return replay;
    const now = options.now();
    const humanInterventionId = nextId("human_intervention");
    humanInterventions.push(Object.freeze({
      humanInterventionId,
      commandId: command.commandId,
      idempotencyKey: key,
      sessionId: command.sessionId,
      mode: "scoped_interrupt",
      state: "interrupting",
      ...(session.activeSessionTurnId ? { activeSessionTurnId: session.activeSessionTurnId } : {}),
      createdAt: now,
      updatedAt: now,
    }));
    controlAudits.push(newControl(command.sessionId, command.commandId, "scoped_interrupt"));
    providerOutbox.push(Object.freeze({
      outboxId: nextId("async_operation"),
      kind: "request_interrupt",
      sessionId: command.sessionId,
      ...(session.activeSessionTurnId ? { affectedSessionTurnId: session.activeSessionTurnId } : {}),
      state: "pending",
      createdAt: now,
    }));
    const result = Object.freeze({ status: "accepted" as const });
    rememberIdempotent(key, fingerprint, result);
    return result;
  }

  function recordInterruptOutcome(command: Readonly<{
    sessionId: string;
    outcome: "accepted" | "confirmed" | "unknown";
  }>) {
    requireSession(command.sessionId);
    const index = findLastIndex(controlAudits, (control) => control.sessionId === command.sessionId
      && (control.state === "requested" || control.state === "accepted"));
    if (index < 0) {
      const terminal = [...controlAudits].reverse().find((control) => control.sessionId === command.sessionId);
      invariant(Boolean(terminal), "session_interrupt_control_missing");
      invariant(terminal?.state === command.outcome, "session_interrupt_outcome_conflict");
      return Object.freeze({ status: "recorded" as const });
    }
    const current = controlAudits[index]!;
    const now = options.now();
    controlAudits[index] = Object.freeze({ ...current, state: command.outcome, updatedAt: now });
    if (command.outcome === "accepted") return Object.freeze({ status: "recorded" as const });
    const interventionIndex = findLastIndex(humanInterventions, (intervention) => intervention.sessionId === command.sessionId
      && intervention.state === "interrupting");
    if (interventionIndex >= 0) {
      const intervention = humanInterventions[interventionIndex]!;
      humanInterventions[interventionIndex] = Object.freeze({
        ...intervention,
        state: command.outcome === "confirmed" ? "ready_to_deliver" : "ambiguous",
        updatedAt: now,
      });
      if (command.outcome === "confirmed" && intervention.mode === "interrupt_then_send") {
        const heldIndex = cardInbox.findIndex((item) => item.humanInterventionId === intervention.humanInterventionId
          && item.state === "held_by_human_intervention");
        if (heldIndex >= 0) cardInbox[heldIndex] = Object.freeze({ ...cardInbox[heldIndex]!, state: "pending" });
      }
    }
    admitNotice({
      sessionId: command.sessionId,
      reason: command.outcome === "confirmed" ? "interrupt_confirmed" : "interrupt_unknown",
      content: command.outcome === "confirmed"
        ? "The Runtime confirmed that the requested Session Turn was interrupted."
        : "The Runtime could not determine the interrupt outcome; the Session requires reconciliation.",
    });
    return Object.freeze({ status: "recorded" as const });
  }

  function recordLateFinal(command: Readonly<{
    sessionId: string;
    sessionTurnId: string;
    messageId: string;
    content: string;
  }>) {
    requireSession(command.sessionId);
    const prior = finalByTurn.get(command.sessionTurnId);
    invariant(!prior || prior === command.messageId, "session_turn_final_already_recorded");
    if (prior) return Object.freeze({ status: "recorded" as const });
    const canonical = canonicalizeFinal({ messageId: command.messageId, content: command.content });
    const now = options.now();
    if (taskState === "stopped") {
      lateResultAudits.push(Object.freeze({
        sessionId: command.sessionId,
        sessionTurnId: command.sessionTurnId,
        messageId: command.messageId,
        contentDigest: hashDefinition(command.content),
        observedAt: now,
      }));
      finalByTurn.set(command.sessionTurnId, command.messageId);
      return Object.freeze({ status: "audited" as const });
    }
    messages.push(Object.freeze({
      messageId: command.messageId,
      kind: "agent_final",
      sessionId: command.sessionId,
      content: canonical,
      createdAt: now,
    }));
    // Causal Notice is admitted first; the late Final can never overtake it.
    admitNotice({
      sessionId: command.sessionId,
      reason: "late_final_after_interrupt",
      content: "A final arrived from the Turn that was being interrupted; review it before the held human input proceeds.",
      causalMessageId: command.messageId,
    });
    conductorInbox.push(Object.freeze({
      inboxItemId: nextId("inbox"),
      sequence: nextSequence(),
      state: "pending",
      kind: "final_for_conductor",
      messageId: command.messageId,
      sourceSessionId: command.sessionId,
      content: canonical,
    }));
    finalByTurn.set(command.sessionTurnId, command.messageId);
    return Object.freeze({ status: "recorded" as const });
  }

  function abandonHumanIntervention(command: Readonly<{ humanInterventionId: string; commandId: string }>) {
    assertRunning();
    const index = humanInterventions.findIndex((intervention) => intervention.humanInterventionId === command.humanInterventionId);
    invariant(index >= 0, "human_intervention_not_found");
    const intervention = humanInterventions[index]!;
    if (intervention.state === "cancelled_by_user") return Object.freeze({ status: "abandoned" as const });
    invariant(["interrupting", "ambiguous", "ready_to_deliver"].includes(intervention.state), "human_intervention_not_abandonable");
    humanInterventions[index] = Object.freeze({ ...intervention, state: "cancelled_by_user", updatedAt: options.now() });
    const cardIndex = cardInbox.findIndex((item) => item.humanInterventionId === intervention.humanInterventionId
      && (item.state === "held_by_human_intervention" || item.state === "pending"));
    if (cardIndex >= 0) cardInbox[cardIndex] = Object.freeze({ ...cardInbox[cardIndex]!, state: "suppressed", reason: "human_intervention_abandoned" });
    admitNotice({
      sessionId: intervention.sessionId,
      reason: "human_intervention_abandoned",
      content: "The pending human intervention was abandoned before delivery to the Card Session.",
    });
    return Object.freeze({ status: "abandoned" as const });
  }

  function acceptTaskStop(command: Readonly<{ commandId: string; expectedRevision: number }>) {
    invariant(command.expectedRevision === task.revision, "task_revision_stale");
    if (stopCommands.has(command.commandId)) return Object.freeze({ status: "stopped" as const });
    taskState = "stopped";
    stopCommands.add(command.commandId);
    suppressForStop();
    return Object.freeze({ status: "stopped" as const });
  }

  function recover() {
    if (taskState === "stopped") suppressForStop();
    return Object.freeze({ status: "recovered" as const });
  }

  function readConductorInbox(): readonly ConductorInboxProjection[] {
    return Object.freeze(conductorInbox
      .filter((item) => item.state === "pending")
      .sort((left, right) => left.sequence - right.sequence)
      .map((item) => Object.freeze({ ...item })));
  }

  function snapshot() {
    return Object.freeze({
      taskState,
      ...(planningFence ? { planningFence: Object.freeze({ ...planningFence }) } : {}),
      messageForwards: cloneRecords(messageForwards),
      humanInterventions: cloneRecords(humanInterventions),
      messages: cloneRecords(messages),
      conductorInbox: cloneRecords(conductorInbox),
      cardInbox: cloneRecords(cardInbox),
      inputSubmissions: cloneRecords(inputSubmissions),
      controlAudits: cloneRecords(controlAudits),
      providerOutbox: cloneRecords(providerOutbox),
      lateResultAudits: cloneRecords(lateResultAudits),
    });
  }

  return Object.freeze({
    acceptTaskInput,
    sendToSession,
    acceptBusyHumanIntervention,
    acceptIdleHumanIntervention,
    requestUserScopedInterrupt,
    recordInterruptOutcome,
    recordLateFinal,
    abandonHumanIntervention,
    acceptTaskStop,
    recover,
    readConductorInbox,
    snapshot,
  });

  function assertTaskMutable(expectedRevision: number): void {
    assertRunning();
    invariant(expectedRevision === task.revision, "task_revision_stale");
  }

  function assertRunning(): void {
    invariant(taskState === "running", "task_run_not_accepting_input");
  }

  function requireSession(sessionId: string) {
    const session = sessions.get(sessionId);
    invariant(Boolean(session), "orchestration_session_unknown");
    return session!;
  }

  function newControl(sessionId: string, commandId: string, kind: ControlAuditProjection["kind"]): ControlAuditProjection {
    const now = options.now();
    return Object.freeze({
      controlAuditId: nextId("session_control"),
      sessionId,
      commandId,
      kind,
      state: "requested",
      createdAt: now,
      updatedAt: now,
    });
  }

  function admitNotice(input: Readonly<{
    sessionId: string;
    reason: "interrupt_confirmed" | "interrupt_unknown" | "late_final_after_interrupt" | "human_intervention_abandoned";
    content: string;
    causalMessageId?: string;
  }>): void {
    const identity = `${input.sessionId}:${input.reason}:${input.causalMessageId ?? "none"}`;
    if (admittedNotices.has(identity) || taskState !== "running") return;
    admittedNotices.add(identity);
    const messageId = nextId("message");
    messages.push(Object.freeze({
      messageId,
      kind: "runtime_notice",
      sessionId: input.sessionId,
      content: input.content,
      createdAt: options.now(),
    }));
    conductorInbox.push(Object.freeze({
      inboxItemId: nextId("inbox"),
      sequence: nextSequence(),
      state: "pending",
      kind: "session_notice_for_conductor",
      messageId,
      sessionId: input.sessionId,
      content: input.content,
      ...(input.causalMessageId ? { causalMessageId: input.causalMessageId } : {}),
    }));
  }

  function suppressForStop(): void {
    for (let index = 0; index < humanInterventions.length; index += 1) {
      const intervention = humanInterventions[index]!;
      if (intervention.state === "cancelled_by_task_stop") continue;
      humanInterventions[index] = Object.freeze({ ...intervention, state: "cancelled_by_task_stop", updatedAt: options.now() });
    }
    for (let index = 0; index < cardInbox.length; index += 1) {
      const item = cardInbox[index]!;
      if (item.state !== "held_by_human_intervention" && item.state !== "pending") continue;
      cardInbox[index] = Object.freeze({ ...item, state: "suppressed", reason: "task_stop" });
    }
    for (let index = 0; index < conductorInbox.length; index += 1) {
      const item = conductorInbox[index]!;
      if (item.state !== "pending") continue;
      conductorInbox[index] = Object.freeze({ ...item, state: "suppressed", reason: "task_stop" });
    }
    for (let index = 0; index < providerOutbox.length; index += 1) {
      const item = providerOutbox[index]!;
      if (item.state !== "pending") continue;
      providerOutbox[index] = Object.freeze({ ...item, state: "suppressed" });
    }
  }

  function replayIdempotent<T>(key: string, fingerprint: string): T | undefined {
    invariant(Boolean(key.trim()), "orchestration_idempotency_key_required");
    const prior = idempotency.get(key);
    if (!prior) return undefined;
    invariant(prior.fingerprint === fingerprint, "orchestration_idempotency_payload_conflict");
    return prior.result as T;
  }

  function rememberIdempotent(key: string, fingerprint: string, result: unknown): void {
    idempotency.set(key, Object.freeze({ fingerprint, result }));
  }
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function cloneRecords<T extends Readonly<Record<string, unknown>>>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item }) as T));
}
