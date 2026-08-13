import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ConductorPlanningFenceRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpRendererCommandApplication,
  type SessionIdAcpRendererCommandCapabilities,
} from "./session-id-acp-renderer-command-application.js";

const NOW = "2026-08-12T16:00:00.000Z";
const TASK_ID = "task_renderer_command";
const RUN_ID = "run_renderer_command";
const CONDUCTOR_ID = "logical_session_renderer_conductor";
const WORKER_ID = "logical_session_renderer_worker";
const CARD_ID = "agent_card_renderer_worker";
const SLOT_ID = "card_session_slot_renderer_worker";
const PROFILE_ID = "profile_renderer_worker";
const PROFILE_REVISION_ID = "profile_revision_renderer_worker";

describe("Session-ID ACP Renderer command application", () => {
  it("atomically submits Task input through Task revision + PlanningFence + Message/Inbox and replays", () => {
    const fixture = createFixture();
    const command = {
      commandId: "command_renderer_task_input",
      taskId: TASK_ID,
      runId: RUN_ID,
      expectedRevision: 7,
      targetLogicalSessionId: CONDUCTOR_ID,
      content: "Replan from this authenticated Task input.",
    };

    expect(fixture.application.submitTaskInput(command)).toEqual({
      result: { taskRevision: 8 },
      providerEffectIntentIds: [],
    });
    expect([...fixture.messages.values()]).toEqual([
      expect.objectContaining({ kind: "user_input", content: command.content }),
    ]);
    expect([...fixture.inbox.values()]).toEqual([
      expect.objectContaining({ sessionId: CONDUCTOR_ID, priority: "human", state: "pending" }),
    ]);
    expect([...fixture.fences.values()]).toEqual([
      expect.objectContaining({ sourceCommandId: command.commandId }),
    ]);
    expect(fixture.taskRevision).toBe(8);
    expect(fixture.application.submitTaskInput(command)).toEqual({
      result: { taskRevision: 8 },
      providerEffectIntentIds: [],
    });
    expect(fixture.messages.size).toBe(1);
    expect(fixture.fences.size).toBe(1);
  });

  it("materializes an idle Card generation and persists mirror-before-Card with zero Provider effect", () => {
    const fixture = createFixture();
    const command = humanCommand("idle");

    expect(fixture.application.sendHumanMessage(command)).toEqual({
      result: {
        humanIntervention: {
          humanInterventionId: command.humanInterventionId,
          state: "sent",
          targetLogicalSessionId: WORKER_ID,
          materializedGeneration: 1,
        },
      },
      providerEffectIntentIds: [],
    });
    expect(fixture.generations.get(WORKER_ID)).toMatchObject({ lifecycle: "current", generation: 1 });
    expect(fixture.interventions.get(command.humanInterventionId)).toMatchObject({
      mode: "direct_message",
      state: "accepted",
      authenticatedUserId: command.authenticatedUserId,
    });
    expect(fixture.writeOrder).toEqual([
      "materialize",
      "message:conductor",
      "message:card",
      "human",
      "inbox:conductor",
      "inbox:card",
      "receipt",
    ]);
    expect(fixture.providerIntents.size).toBe(0);
  });

  it("holds busy human content, suppresses pending sends, and exposes one exact interrupt drain ID", () => {
    const fixture = createFixture({ materialized: true, activeTurn: true, pendingOrdinary: true });
    const { targetAgentCardId: _targetAgentCardId, ...busyCommand } = humanCommand("busy");
    const command = { ...busyCommand, targetLogicalSessionId: WORKER_ID };

    const result = fixture.application.sendHumanMessage(command);
    expect(result).toEqual({
      result: {
        humanIntervention: {
          humanInterventionId: command.humanInterventionId,
          state: "held",
          targetLogicalSessionId: WORKER_ID,
        },
      },
      providerEffectIntentIds: ["provider_effect_renderer_interrupt"],
    });
    const cardInbox = [...fixture.inbox.values()].find((item) =>
      item.humanInterventionId === command.humanInterventionId && item.sessionId === WORKER_ID)!;
    expect(cardInbox).toMatchObject({ state: "held_by_human_intervention", priority: "human" });
    expect([...fixture.inbox.values()].find((item) => item.forwardId === "message_forward_renderer_pending"))
      .toMatchObject({ state: "suppressed", reason: "human_intervention" });
    expect([...fixture.messages.values()].some((message) => message.kind === "runtime_notice")).toBe(true);
    expect([...fixture.controls.values()]).toEqual([
      expect.objectContaining({ kind: "human_interrupt", state: "requested" }),
    ]);
    expect(fixture.stageInterrupt).toHaveBeenCalledTimes(1);
    expect(fixture.application.sendHumanMessage(command)).toEqual(result);
    expect(fixture.stageInterrupt).toHaveBeenCalledTimes(1);

    const rollback = createFixture({ materialized: true, activeTurn: true });
    rollback.failInterrupt = true;
    const before = rollback.snapshot();
    expect(() => rollback.application.sendHumanMessage(command)).toThrow(/controlled_interrupt_failure/);
    expect(rollback.snapshot()).toEqual(before);
  });

  it("abandons only pre-Input Card content, writes one Notice, and exactly replays", () => {
    const fixture = createFixture();
    const send = humanCommand("abandon");
    fixture.application.sendHumanMessage(send);
    const command = {
      commandId: "command_renderer_abandon",
      taskId: TASK_ID,
      runId: RUN_ID,
      expectedRevision: 7,
      humanInterventionId: send.humanInterventionId,
      idempotencyKey: "renderer:abandon",
      authenticatedUserId: send.authenticatedUserId,
    };
    const first = fixture.application.abandonHumanMessage(command);
    expect(first).toEqual({
      result: {
        humanIntervention: {
          humanInterventionId: send.humanInterventionId,
          state: "abandoned",
          targetLogicalSessionId: WORKER_ID,
        },
      },
      providerEffectIntentIds: [],
    });
    expect(fixture.interventions.get(send.humanInterventionId)).toMatchObject({ state: "abandoned" });
    expect([...fixture.inbox.values()].find((item) =>
      item.sessionId === WORKER_ID && item.humanInterventionId === send.humanInterventionId))
      .toMatchObject({ state: "suppressed", reason: "human_intervention_abandoned" });
    expect([...fixture.messages.values()].filter((message) => message.kind === "runtime_notice")).toHaveLength(1);
    expect(fixture.application.abandonHumanMessage(command)).toEqual(first);

    const handed = createFixture();
    const sent = humanCommand("handed");
    handed.application.sendHumanMessage(sent);
    const card = [...handed.inbox.values()].find((item) => item.sessionId === WORKER_ID)!;
    handed.inputs.set("input_renderer_handed", inputRecord(card));
    expect(() => handed.application.abandonHumanMessage({ ...command, humanInterventionId: sent.humanInterventionId }))
      .toThrow(/not_abandonable/);
  });
});

type FixtureOptions = Readonly<{
  materialized?: boolean;
  activeTurn?: boolean;
  pendingOrdinary?: boolean;
}>;

function createFixture(options: FixtureOptions = {}) {
  const slots = new Map<string, CardSessionSlotRecord>([[SLOT_ID, slotRecord(Boolean(options.materialized))]]);
  const generations = new Map<string, CardSessionGenerationRecord>();
  const fences = new Map<string, ConductorPlanningFenceRecord>();
  const messages = new Map<string, SessionIdSessionMessageRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>();
  const inputs = new Map<string, SessionIdInputSubmissionRecord>();
  const turns = new Map<string, SessionIdSessionTurnRecord>();
  const controls = new Map<string, SessionControlAuditRecord>();
  const interventions = new Map<string, SessionIdHumanInterventionRecord>();
  const receipts = new Map<string, SessionIdUiCommandReceiptRecord>();
  const runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  const attempts = new Map<string, SessionExecutionAttemptRecord>();
  const providerIntents = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  const writeOrder: string[] = [];
  let taskRevision = 7;
  let id = 0;
  let failInterrupt = false;
  if (options.materialized) generations.set(WORKER_ID, generationRecord());
  if (options.activeTurn) seedActive({ messages, inbox, inputs, turns, runtimes, attempts });
  if (options.pendingOrdinary) {
    messages.set("message_renderer_pending", message("message_renderer_pending", "conductor_forward", "Pending send"));
    inbox.set("inbox_renderer_pending", {
      inboxItemId: "inbox_renderer_pending",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_ID,
      renderedMessageId: "message_renderer_pending",
      sequence: 2,
      priority: "ordinary",
      state: "pending",
      forwardId: "message_forward_renderer_pending",
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  const capabilities: SessionIdAcpRendererCommandCapabilities = {
    taskRun: {
      findSlot: (runId, cardId) => [...slots.values()].find((slot) => slot.runId === runId && slot.agentCardId === cardId),
      getSlot: (slotId) => slots.get(slotId),
      getGeneration: (sessionId) => generations.get(sessionId),
      materializeGeneration(slot, generation) {
        writeOrder.push("materialize");
        slots.set(slot.cardSessionSlotId, structuredClone(slot));
        generations.set(generation.sessionId, structuredClone(generation));
      },
      createPlanningFence(fence) { fences.set(fence.planningFenceId, structuredClone(fence)); },
      latestPlanningFence: () => [...fences.values()].at(-1),
      readTaskRunState: () => ({
        taskId: TASK_ID,
        runId: RUN_ID,
        taskRevision,
        runStatus: "running",
        currentConductorSessionTurnId: "session_turn_renderer_conductor_active",
      }),
      getConductorSessionId: () => CONDUCTOR_ID,
      acceptTaskInput(value) {
        if (value.expectedRevision !== taskRevision) throw new Error("task_revision_stale");
        taskRevision = value.nextRevision;
      },
    },
    message: {
      createMessage(value) {
        const lane = value.sourceHumanInterventionId
          ? messages.size === 0 ? "conductor" : "card"
          : value.kind === "runtime_notice" ? "notice" : "task";
        writeOrder.push(`message:${lane}`);
        insert(messages, value.messageId, value);
      },
      getMessage: (messageId) => messages.get(messageId),
    },
    orchestration: {
      createInboxItem(value) {
        const lane = value.sessionId === CONDUCTOR_ID ? "conductor" : "card";
        writeOrder.push(`inbox:${lane}`);
        insert(inbox, value.inboxItemId, value);
      },
      getInboxItem: (inboxId) => inbox.get(inboxId),
      listInboxItems: (sessionId) => [...inbox.values()].filter((item) => item.sessionId === sessionId),
      updateInboxItem(value, expected) {
        if (inbox.get(value.inboxItemId)?.state !== expected) throw new Error("inbox_state_conflict");
        inbox.set(value.inboxItemId, structuredClone(value));
      },
      findInputByInboxItem: (inboxId) => [...inputs.values()].find((input) => input.sourceInboxItemId === inboxId),
      listTurns: (sessionId) => [...turns.values()].filter((turn) => turn.sessionId === sessionId),
      createControlAudit(value) { insert(controls, value.sessionControlAuditId, value); },
      getControlAudit: (controlId) => controls.get(controlId),
      listControlAudits: (runId, sessionId) => [...controls.values()]
        .filter((control) => control.runId === runId && (!sessionId || control.sessionId === sessionId)),
    },
    humanIntervention: {
      create(value) { writeOrder.push("human"); insert(interventions, value.humanInterventionId, value); },
      get: (interventionId) => interventions.get(interventionId),
      update(value) { interventions.set(value.humanInterventionId, structuredClone(value)); },
      findByIdempotencyKey: (taskId, runId, key) => [...interventions.values()]
        .find((item) => item.taskId === taskId && item.runId === runId && item.idempotencyKey === key),
      list: (runId, sessionId) => [...interventions.values()]
        .filter((item) => item.runId === runId && (!sessionId || item.targetSessionId === sessionId)),
    },
    commandReceipts: {
      createUiCommandReceipt(value) { writeOrder.push("receipt"); insert(receipts, value.commandId, value); },
      getUiCommandReceipt: (taskId, commandId) => receipts.get(commandId)?.taskId === taskId
        ? receipts.get(commandId)
        : undefined,
    },
    sessionExecution: {
      getRuntimeForSession: (sessionId) => [...runtimes.values()].find((runtime) => runtime.logicalSessionId === sessionId),
      getAttempt: (attemptId) => attempts.get(attemptId),
    },
    providerEffects: {
      listProviderEffectIntents: (attemptId) => [...providerIntents.values()]
        .filter((intent) => attemptId === undefined || intent.sessionExecutionAttemptId === attemptId),
    },
  };
  const transaction = {
    run<T>(work: (owners: SessionIdAcpRendererCommandCapabilities) => T): T {
      const before = snapshot({ slots, generations, fences, messages, inbox, inputs, turns, controls, interventions, receipts,
        runtimes, attempts, providerIntents });
      const beforeRevision = taskRevision;
      const beforeOrder = [...writeOrder];
      try {
        return work(capabilities);
      } catch (error) {
        restore(before, { slots, generations, fences, messages, inbox, inputs, turns, controls, interventions, receipts,
          runtimes, attempts, providerIntents });
        taskRevision = beforeRevision;
        writeOrder.splice(0, writeOrder.length, ...beforeOrder);
        throw error;
      }
    },
  };
  const stageInterrupt = vi.fn(({ sessionControlAuditId }: { sessionControlAuditId: string }) => {
    const control = controls.get(sessionControlAuditId)!;
    const intent = interruptIntent(control);
    providerIntents.set(intent.providerEffectIntentId, intent);
    if (failInterrupt) throw new Error("controlled_interrupt_failure");
    return {
      disposition: "staged" as const,
      commandType: intent.commandType,
      providerEffectIntentId: intent.providerEffectIntentId,
      sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
      sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    };
  });
  const application = createSessionIdAcpRendererCommandApplication({
    now: () => NOW,
    createId(kind) {
      id += 1;
      if (kind === "logical_session") return WORKER_ID;
      return `${kind}_renderer_${id}`;
    },
    task: {
      taskId: TASK_ID,
      runId: RUN_ID,
      conductorSessionId: CONDUCTOR_ID,
      agentCards: [{
        agentCardId: CARD_ID,
        executionProfileId: PROFILE_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        providerFamily: "opencode",
      }],
    },
    transaction,
    resolveFrozenProfile: () => ({
      schemaVersion: 3,
      executionProfileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      providerFamily: "opencode",
    }),
    interruptBridge: { stageInterrupt },
  });
  return {
    application,
    slots,
    generations,
    fences,
    messages,
    inbox,
    inputs,
    turns,
    controls,
    interventions,
    providerIntents,
    writeOrder,
    stageInterrupt,
    snapshot: () => snapshot({ slots, generations, fences, messages, inbox, inputs, turns, controls, interventions, receipts,
      runtimes, attempts, providerIntents }),
    get taskRevision() { return taskRevision; },
    get failInterrupt() { return failInterrupt; },
    set failInterrupt(value: boolean) { failInterrupt = value; },
  };
}

function humanCommand(stem: string) {
  return {
    commandId: `command_renderer_human_${stem}`,
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedRevision: 7,
    targetAgentCardId: CARD_ID,
    humanInterventionId: `human_intervention_renderer_${stem}`,
    idempotencyKey: `renderer:human:${stem}`,
    authenticatedUserId: "user_renderer",
    content: `Authenticated human content ${stem}.`,
  };
}

function slotRecord(materialized: boolean): CardSessionSlotRecord {
  return {
    cardSessionSlotId: SLOT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: CARD_ID,
    ...(materialized ? { currentSessionId: WORKER_ID } : {}),
    latestGeneration: materialized ? 1 : 0,
    revision: materialized ? 2 : 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function generationRecord(): CardSessionGenerationRecord {
  return {
    sessionId: WORKER_ID,
    cardSessionSlotId: SLOT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: CARD_ID,
    executionProfileId: PROFILE_ID,
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
}

function message(messageId: string, kind: SessionIdSessionMessageRecord["kind"], content: string): SessionIdSessionMessageRecord {
  return {
    messageId,
    taskId: TASK_ID,
    runId: RUN_ID,
    kind,
    content,
    canonicalContent: [{ kind: "text", text: content }],
    contentDigest: hashDefinition(content),
    createdAt: NOW,
  };
}

function inputRecord(item: SessionLaneItemRecord): SessionIdInputSubmissionRecord {
  return {
    inputSubmissionId: "input_renderer_handed",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_ID,
    sourceInboxItemId: item.inboxItemId,
    contentMessageId: item.renderedMessageId,
    commandId: "command_renderer_handed",
    idempotencyKey: "renderer:handed",
    sequence: item.sequence,
    state: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedActive(maps: Readonly<{
  messages: Map<string, SessionIdSessionMessageRecord>;
  inbox: Map<string, SessionLaneItemRecord>;
  inputs: Map<string, SessionIdInputSubmissionRecord>;
  turns: Map<string, SessionIdSessionTurnRecord>;
  runtimes: Map<string, SessionExecutionRuntimeRecord>;
  attempts: Map<string, SessionExecutionAttemptRecord>;
}>): void {
  maps.messages.set("message_renderer_active", message("message_renderer_active", "conductor_forward", "Active work"));
  maps.inbox.set("inbox_renderer_active", {
    inboxItemId: "inbox_renderer_active",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_ID,
    renderedMessageId: "message_renderer_active",
    sequence: 1,
    priority: "ordinary",
    state: "handed",
    forwardId: "message_forward_renderer_active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  maps.inputs.set("input_renderer_active", {
    ...inputRecord(maps.inbox.get("inbox_renderer_active")!),
    inputSubmissionId: "input_renderer_active",
    state: "accepted",
  });
  maps.turns.set("session_turn_renderer_active", {
    sessionTurnId: "session_turn_renderer_active",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_ID,
    inputSubmissionId: "input_renderer_active",
    sourceConductorSessionTurnId: "session_turn_renderer_conductor_active",
    trigger: "conductor_send",
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  maps.runtimes.set("session_execution_runtime_renderer", {
    sessionExecutionRuntimeId: "session_execution_runtime_renderer",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_ID,
    state: "executing",
    activeAttemptId: "session_execution_attempt_renderer",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
  maps.attempts.set("session_execution_attempt_renderer", {
    sessionExecutionAttemptId: "session_execution_attempt_renderer",
    sessionExecutionRuntimeId: "session_execution_runtime_renderer",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_ID,
    bindingId: "binding_renderer",
    bindingRevision: 1,
    executionProfileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    inputSubmissionId: "input_renderer_active",
    orchestrationSessionTurnId: "session_turn_renderer_active",
    state: "active",
    receiptDigest: `sha256:${"a".repeat(64)}`,
    receiptObservedAt: NOW,
    interactions: [],
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function interruptIntent(control: SessionControlAuditRecord): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId: "provider_effect_renderer_interrupt",
    commandId: "command_acp_renderer_interrupt",
    idempotencyKey: "acp:renderer:interrupt",
    commandType: "session_runtime.request_interrupt",
    commandFingerprint: hashDefinition({ control: control.sessionControlAuditId }),
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_renderer",
    sessionExecutionAttemptId: "session_execution_attempt_renderer",
    bindingId: "binding_renderer",
    bindingRevision: 1,
    executionProfileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    inputSubmissionId: "input_renderer_active",
    orchestrationSessionTurnId: "session_turn_renderer_active",
    sessionControlAuditId: control.sessionControlAuditId,
    effect: {
      kind: "request_interrupt",
      bindingHandle: "binding_handle_renderer",
      sessionExecutionAttemptId: "session_execution_attempt_renderer",
      sessionControlAuditId: control.sessionControlAuditId,
    },
    state: "pending",
    createdAt: NOW,
  };
}

function insert<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) throw new Error("controlled_duplicate_write");
  map.set(key, structuredClone(value));
}

function snapshot(maps: Record<string, Map<string, unknown>>) {
  return Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, [...map.entries()].map(([id, value]) =>
    [id, structuredClone(value)])]));
}

function restore(snapshotValue: ReturnType<typeof snapshot>, maps: Record<string, Map<string, unknown>>): void {
  for (const [key, entries] of Object.entries(snapshotValue)) {
    maps[key]!.clear();
    for (const [id, value] of entries as [string, unknown][]) maps[key]!.set(id, structuredClone(value));
  }
}
