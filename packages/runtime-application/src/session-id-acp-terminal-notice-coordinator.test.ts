import { describe, expect, it } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpTerminalNoticeCoordinator,
  type SessionIdAcpTerminalNoticeCapabilities,
} from "./session-id-acp-terminal-notice-coordinator.js";

const NOW = "2026-08-12T15:00:00.000Z";
const TASK_ID = "task_notice";
const RUN_ID = "run_notice";
const SESSION_ID = "logical_session_notice_worker";
const CONDUCTOR_ID = "logical_session_notice_conductor";
const ATTEMPT_ID = "session_execution_attempt_notice";
const CONTROL_ID = "session_control_notice";
const RECEIPT = `sha256:${"f".repeat(64)}`;

describe("Session-ID ACP terminal Notice coordinator", () => {
  it("records/replays one internally rendered failed Notice after exact terminal OR state", () => {
    const fixture = createFixture("delivery_failed");
    const request = { reason: "delivery_failed" as const, sessionExecutionAttemptId: ATTEMPT_ID };

    const recorded = fixture.coordinator.acceptNotice(request);
    if (recorded.status === "not_admitted") throw new Error("notice_should_be_admitted");
    expect(recorded).toMatchObject({ status: "recorded" });
    expect(fixture.messages.get(recorded.messageId!)).toMatchObject({
      kind: "runtime_notice",
      sourceSessionId: SESSION_ID,
    });
    expect(fixture.inbox.get(recorded.inboxItemId!)).toMatchObject({
      sessionId: CONDUCTOR_ID,
      renderedMessageId: recorded.messageId,
      priority: "notice",
      state: "pending",
    });
    expect(fixture.coordinator.acceptNotice(request)).toEqual({ ...recorded, status: "replayed" });
    expect(fixture.writes()).toEqual({ message: 1, orchestration: 1 });
  });

  it("accepts only the exact interrupt Control/effect proof for confirmed or unknown Notice", () => {
    for (const reason of ["interrupt_confirmed", "interrupt_unknown"] as const) {
      const fixture = createFixture(reason);
      expect(fixture.coordinator.acceptNotice({
        reason,
        sessionExecutionAttemptId: ATTEMPT_ID,
        sessionControlAuditId: CONTROL_ID,
      })).toMatchObject({ status: "recorded" });

      const forged = createFixture(reason);
      forged.intents.clear();
      const before = forged.snapshot();
      expect(() => forged.coordinator.acceptNotice({
        reason,
        sessionExecutionAttemptId: ATTEMPT_ID,
        sessionControlAuditId: CONTROL_ID,
      })).toThrow(/interrupt_effect_missing/);
      expect(forged.snapshot()).toEqual(before);
    }
  });

  it("fails closed for OR or current-generation drift and never accepts caller content", () => {
    const stale = createFixture("delivery_failed");
    stale.slot = { ...stale.slot, latestGeneration: 2 };
    const before = stale.snapshot();
    expect(() => stale.coordinator.acceptNotice({
      reason: "delivery_failed",
      sessionExecutionAttemptId: ATTEMPT_ID,
    })).toThrow(/session_not_current/);
    expect(stale.snapshot()).toEqual(before);

    const forged = createFixture("delivery_failed");
    expect(() => forged.coordinator.acceptNotice({
      reason: "delivery_failed",
      sessionExecutionAttemptId: ATTEMPT_ID,
      // @ts-expect-error Notice content is owner-rendered.
      content: "caller text",
    })).toThrow(/input_shape_invalid/);
    expect(forged.writes()).toEqual({ message: 0, orchestration: 0 });
  });

  it("retains terminal audit but admits no consumable Notice once the Run stops", () => {
    const fixture = createFixture("delivery_failed");
    fixture.runStatus = "stopped";
    expect(fixture.coordinator.acceptNotice({
      reason: "delivery_failed",
      sessionExecutionAttemptId: ATTEMPT_ID,
    })).toEqual({ status: "not_admitted" });
    expect(fixture.writes()).toEqual({ message: 0, orchestration: 0 });
  });
});

type NoticeReason = "delivery_failed" | "interrupt_confirmed" | "interrupt_unknown";

function createFixture(reason: NoticeReason) {
  const messages = new Map<string, SessionIdSessionMessageRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>();
  const controls = new Map<string, SessionControlAuditRecord>();
  const intents = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  const attempts = new Map<string, SessionExecutionAttemptRecord>();
  let slot = slotRecord();
  const generation = generationRecord();
  let runStatus = "running";
  const writes = { message: 0, orchestration: 0 };
  const input = inputRecord(reason);
  const turn = turnRecord(reason);
  const sourceInbox = sourceInboxRecord(reason);
  const binding = bindingRecord();
  const attempt = attemptRecord(reason);
  attempts.set(ATTEMPT_ID, attempt);
  if (reason === "interrupt_confirmed" || reason === "interrupt_unknown") {
    controls.set(CONTROL_ID, controlRecord(reason));
    const intent = interruptIntent();
    intents.set(intent.providerEffectIntentId, intent);
  }

  const capabilities: SessionIdAcpTerminalNoticeCapabilities = {
    taskRun: {
      getGeneration: (sessionId) => sessionId === SESSION_ID ? generation : undefined,
      getSlot: (slotId) => slotId === slot.cardSessionSlotId ? slot : undefined,
      getConductorSessionId: () => CONDUCTOR_ID,
      readTaskRunState: () => ({ taskId: TASK_ID, runId: RUN_ID, runStatus }),
    },
    message: {
      getMessage: (messageId) => messages.get(messageId),
      createMessage(message) {
        if (messages.has(message.messageId)) throw new Error("controlled_duplicate_message");
        writes.message += 1;
        messages.set(message.messageId, structuredClone(message));
      },
    },
    orchestration: {
      getInputSubmission: (inputId) => inputId === input.inputSubmissionId ? input : undefined,
      getTurn: (turnId) => turnId === turn.sessionTurnId ? turn : undefined,
      getInboxItem: (inboxId) => inboxId === sourceInbox.inboxItemId ? sourceInbox : inbox.get(inboxId),
      getControlAudit: (controlId) => controls.get(controlId),
      listInboxItems: (sessionId) => [...inbox.values()].filter((item) => item.sessionId === sessionId),
      createInboxItem(item) {
        if (inbox.has(item.inboxItemId)) throw new Error("controlled_duplicate_inbox");
        writes.orchestration += 1;
        inbox.set(item.inboxItemId, structuredClone(item));
      },
    },
    currentBinding: { getCurrentBinding: (sessionId) => sessionId === SESSION_ID ? binding : undefined },
    sessionExecution: { getAttempt: (attemptId) => attempts.get(attemptId) },
    providerEffects: {
      listProviderEffectIntents: (attemptId) => [...intents.values()]
        .filter((intent) => attemptId === undefined || intent.sessionExecutionAttemptId === attemptId),
    },
  };
  const transaction = {
    run<T>(work: (owners: SessionIdAcpTerminalNoticeCapabilities) => T): T {
      const beforeMessages = new Map(messages);
      const beforeInbox = new Map(inbox);
      const beforeWrites = { ...writes };
      try {
        return work(capabilities);
      } catch (error) {
        messages.clear();
        inbox.clear();
        for (const [key, value] of beforeMessages) messages.set(key, value);
        for (const [key, value] of beforeInbox) inbox.set(key, value);
        Object.assign(writes, beforeWrites);
        throw error;
      }
    },
  };
  const coordinator = createSessionIdAcpTerminalNoticeCoordinator({
    now: () => NOW,
    task: { taskId: TASK_ID, runId: RUN_ID, conductorSessionId: CONDUCTOR_ID },
    transaction,
  });
  return {
    coordinator,
    messages,
    inbox,
    intents,
    writes: () => ({ ...writes }),
    snapshot: () => ({ messages: [...messages], inbox: [...inbox] }),
    get slot() { return slot; },
    set slot(value: CardSessionSlotRecord) { slot = value; },
    get runStatus() { return runStatus; },
    set runStatus(value: string) { runStatus = value; },
  };
}

function slotRecord(): CardSessionSlotRecord {
  return {
    cardSessionSlotId: "card_session_slot_notice",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_notice",
    currentSessionId: SESSION_ID,
    latestGeneration: 1,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function generationRecord(): CardSessionGenerationRecord {
  return {
    sessionId: SESSION_ID,
    cardSessionSlotId: "card_session_slot_notice",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_notice",
    executionProfileId: "profile_notice",
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_notice",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    agentCardId: "agent_card_notice",
    executionProfileId: "profile_notice",
    profileRevisionId: "profile_revision_notice",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_notice",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function inputRecord(reason: NoticeReason): SessionIdInputSubmissionRecord {
  return {
    inputSubmissionId: "input_notice",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    sourceInboxItemId: "inbox_notice_source",
    contentMessageId: "message_notice_source",
    commandId: "command_notice_source",
    idempotencyKey: "notice:source",
    sequence: 1,
    state: reason === "interrupt_unknown" ? "accepted" : reason === "interrupt_confirmed" ? "cancelled" : "failed",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function turnRecord(reason: NoticeReason): SessionIdSessionTurnRecord {
  return {
    sessionTurnId: "session_turn_notice",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    inputSubmissionId: "input_notice",
    sourceConductorSessionTurnId: "session_turn_notice_conductor",
    trigger: "conductor_send",
    state: reason === "interrupt_unknown" ? "ambiguous" : reason === "interrupt_confirmed" ? "interrupted" : "failed",
    createdAt: NOW,
    updatedAt: NOW,
    ...(reason === "interrupt_unknown" ? {} : { settledAt: NOW }),
  };
}

function sourceInboxRecord(reason: NoticeReason): SessionLaneItemRecord {
  return {
    inboxItemId: "inbox_notice_source",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    renderedMessageId: "message_notice_source",
    sequence: 1,
    priority: "ordinary",
    state: reason === "interrupt_unknown" ? "handed" : "handled",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function attemptRecord(reason: NoticeReason): SessionExecutionAttemptRecord {
  const settlement = reason === "delivery_failed" ? {
    sessionExecutionRuntimeId: "session_execution_runtime_notice",
    sessionExecutionAttemptId: ATTEMPT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    bindingId: "binding_notice",
    bindingRevision: 1,
    executionProfileId: "profile_notice",
    profileRevisionId: "profile_revision_notice",
    inputSubmissionId: "input_notice",
    orchestrationSessionTurnId: "session_turn_notice",
    outcome: "failed" as const,
    receiptDigest: RECEIPT,
    settledAt: NOW,
  } : reason === "interrupt_confirmed" ? {
    sessionExecutionRuntimeId: "session_execution_runtime_notice",
    sessionExecutionAttemptId: ATTEMPT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    bindingId: "binding_notice",
    bindingRevision: 1,
    executionProfileId: "profile_notice",
    profileRevisionId: "profile_revision_notice",
    inputSubmissionId: "input_notice",
    orchestrationSessionTurnId: "session_turn_notice",
    outcome: "cancelled" as const,
    receiptDigest: RECEIPT,
    settledAt: NOW,
  } : undefined;
  return {
    sessionExecutionAttemptId: ATTEMPT_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_notice",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    bindingId: "binding_notice",
    bindingRevision: 1,
    executionProfileId: "profile_notice",
    profileRevisionId: "profile_revision_notice",
    inputSubmissionId: "input_notice",
    orchestrationSessionTurnId: "session_turn_notice",
    state: settlement ? "settled" : "reconciling",
    receiptDigest: RECEIPT,
    receiptObservedAt: NOW,
    interactions: [],
    ...(settlement ? {
      terminal: {
        terminalObservationId: "provider_fact_terminal_notice",
        outcome: settlement.outcome,
        receiptDigest: RECEIPT,
        observedAt: NOW,
      },
      settlement,
    } : {}),
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function controlRecord(reason: "interrupt_confirmed" | "interrupt_unknown"): SessionControlAuditRecord {
  return {
    sessionControlAuditId: CONTROL_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    commandId: "command_notice_interrupt",
    idempotencyKey: "notice:interrupt",
    kind: "conductor_interrupt",
    state: reason === "interrupt_confirmed" ? "confirmed" : "unknown",
    affectedInboxItemIds: [],
    requestedAt: NOW,
    settledAt: NOW,
    ...(reason === "interrupt_unknown" ? { reason: "provider_outcome_unknown" } : {}),
  };
}

function interruptIntent(): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId: "provider_effect_notice_interrupt",
    commandId: "command_acp_notice_interrupt",
    idempotencyKey: "acp:notice:interrupt",
    commandType: "session_runtime.request_interrupt",
    commandFingerprint: hashDefinition({ control: CONTROL_ID }),
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_notice",
    sessionExecutionAttemptId: ATTEMPT_ID,
    bindingId: "binding_notice",
    bindingRevision: 1,
    executionProfileId: "profile_notice",
    profileRevisionId: "profile_revision_notice",
    inputSubmissionId: "input_notice",
    orchestrationSessionTurnId: "session_turn_notice",
    sessionControlAuditId: CONTROL_ID,
    effect: {
      kind: "request_interrupt",
      bindingHandle: "binding_handle_notice",
      sessionExecutionAttemptId: ATTEMPT_ID,
      sessionControlAuditId: CONTROL_ID,
    },
    state: "pending",
    createdAt: NOW,
  };
}
