import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
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
  createSessionIdAcpInteractionResponseOwner,
  projectSessionIdAcpPendingInteractions,
  type SessionIdAcpInteractionResponseCapabilities,
} from "./session-id-acp-interaction-response-owner.js";

const NOW = "2026-08-12T17:00:00.000Z";
const TASK_ID = "task_interaction_response";
const RUN_ID = "run_interaction_response";
const CONDUCTOR_ID = "logical_session_interaction_conductor";
const SESSION_ID = "logical_session_interaction_worker";
const ATTEMPT_ID = "session_execution_attempt_interaction";
const INTERACTION_ID = "interaction_permission";
const CHOICE_ID = "choice_allow_once";
const LABEL = "Allow once";

describe("Session-ID ACP Interaction response owner", () => {
  it("atomically mirrors only the persisted safe label and stages one exact response intent", () => {
    const fixture = createFixture();
    const command = interactionCommand();
    const beforeTurnCount = fixture.turns.size;
    const beforeInputCount = fixture.inputs.size;

    const first = fixture.owner.respondToInteraction(command);
    expect(first).toEqual({
      result: {
        interactionResponse: {
          humanInterventionId: "human_intervention_interaction_1",
          state: "accepted",
          targetLogicalSessionId: SESSION_ID,
          interactionId: INTERACTION_ID,
          choiceId: CHOICE_ID,
          label: LABEL,
        },
      },
      providerEffectIntentIds: ["provider_effect_interaction_response"],
    });
    expect([...fixture.messages.values()].filter((message) => message.kind === "user_input")).toEqual([
      expect.objectContaining({ kind: "user_input", content: LABEL, sourceSessionTurnId: "session_turn_interaction" }),
      expect.objectContaining({ kind: "user_input", content: LABEL, sourceSessionTurnId: "session_turn_interaction" }),
    ]);
    expect([...fixture.inbox.values()].filter((item) => item.sessionId === CONDUCTOR_ID)).toEqual([
      expect.objectContaining({ priority: "human", state: "pending" }),
    ]);
    expect(fixture.interventions.get("human_intervention_interaction_1")).toMatchObject({
      mode: "attention_response",
      state: "accepted",
      affectedSessionTurnId: "session_turn_interaction",
      authenticatedUserId: "user_interaction",
    });
    expect(fixture.turns.size).toBe(beforeTurnCount);
    expect(fixture.inputs.size).toBe(beforeInputCount);
    expect(fixture.stageInteractionResponse).toHaveBeenCalledWith({
      sessionExecutionAttemptId: ATTEMPT_ID,
      interactionId: INTERACTION_ID,
      expectedInteractionRevision: 1,
      choiceId: CHOICE_ID,
    });
    expect(fixture.owner.respondToInteraction(command)).toEqual(first);
    expect(fixture.stageInteractionResponse).toHaveBeenCalledTimes(1);
  });

  it("replays the exact receipt after the active Runtime has already settled", () => {
    const fixture = createFixture();
    const command = interactionCommand();
    const first = fixture.owner.respondToInteraction(command);
    fixture.runtime = { ...fixture.runtime, state: "idle", activeAttemptId: undefined, revision: 3 };
    expect(fixture.owner.respondToInteraction(command)).toEqual(first);
    expect(fixture.stageInteractionResponse).toHaveBeenCalledTimes(1);
  });

  it("rolls back Human/Message/Inbox when v3 intent staging fails", () => {
    const fixture = createFixture();
    fixture.failStage = true;
    const before = fixture.snapshot();
    expect(() => fixture.owner.respondToInteraction(interactionCommand()))
      .toThrow(/controlled_interaction_stage_failure/);
    expect(fixture.snapshot()).toEqual(before);
  });

  it("rejects stale choice/revision/current-generation drift before any write or effect", () => {
    const cases: Array<(command: ReturnType<typeof interactionCommand>, fixture: ReturnType<typeof createFixture>) => void> = [
      (command) => { command.expectedInteractionRevision = 2; },
      (command) => { command.choiceId = "choice_unknown"; },
      (_command, fixture) => { fixture.slot = { ...fixture.slot, latestGeneration: 2 }; },
    ];
    for (const mutate of cases) {
      const fixture = createFixture();
      const command = interactionCommand();
      mutate(command, fixture);
      const before = fixture.snapshot();
      expect(() => fixture.owner.respondToInteraction(command)).toThrow();
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.stageInteractionResponse).not.toHaveBeenCalled();
    }
  });

  it("projects only safe requested choices and interaction revision for Renderer", () => {
    const fixture = createFixture();
    const model = projectSessionIdAcpPendingInteractions({
      logicalSessionId: SESSION_ID,
      runtime: fixture.runtime,
      attempt: fixture.attempt,
    });
    expect(model).toEqual([{
      targetLogicalSessionId: SESSION_ID,
      interactionId: INTERACTION_ID,
      interactionRevision: 1,
      choices: [{ choiceId: CHOICE_ID, label: LABEL }],
    }]);
    expect(JSON.stringify(model)).not.toMatch(/prompt|binding|attempt|request|native|raw|cwd/iu);
  });
});

function interactionCommand() {
  return {
    commandId: "command_interaction_response",
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedRevision: 7,
    targetLogicalSessionId: SESSION_ID,
    interactionId: INTERACTION_ID,
    expectedInteractionRevision: 1,
    choiceId: CHOICE_ID,
  };
}

function createFixture() {
  const messages = new Map<string, SessionIdSessionMessageRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>();
  const inputs = new Map<string, SessionIdInputSubmissionRecord>();
  const turns = new Map<string, SessionIdSessionTurnRecord>();
  const interventions = new Map<string, SessionIdHumanInterventionRecord>();
  const receipts = new Map<string, SessionIdUiCommandReceiptRecord>();
  const intents = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  let slot = slotRecord();
  const generation = generationRecord();
  const binding = bindingRecord();
  let runtime = runtimeRecord();
  const attempt = attemptRecord();
  let identity = 0;
  let failStage = false;
  seedOr({ messages, inbox, inputs, turns });

  const capabilities: SessionIdAcpInteractionResponseCapabilities = {
    taskRun: {
      getGeneration: (sessionId) => sessionId === SESSION_ID ? generation : undefined,
      getSlot: (slotId) => slotId === slot.cardSessionSlotId ? slot : undefined,
      getConductorSessionId: () => CONDUCTOR_ID,
      readTaskRunState: () => ({ taskId: TASK_ID, runId: RUN_ID, taskRevision: 7, runStatus: "running" }),
    },
    message: {
      createMessage(value) { insert(messages, value.messageId, value); },
      getMessage: (messageId) => messages.get(messageId),
    },
    orchestration: {
      getInputSubmission: (inputId) => inputs.get(inputId),
      getTurn: (turnId) => turns.get(turnId),
      getInboxItem: (inboxId) => inbox.get(inboxId),
      listInboxItems: (sessionId) => [...inbox.values()].filter((item) => item.sessionId === sessionId),
      createInboxItem(value) { insert(inbox, value.inboxItemId, value); },
    },
    humanIntervention: {
      create(value) { insert(interventions, value.humanInterventionId, value); },
      findByIdempotencyKey: (taskId, runId, key) => [...interventions.values()]
        .find((item) => item.taskId === taskId && item.runId === runId && item.idempotencyKey === key),
    },
    commandReceipts: {
      createUiCommandReceipt(value) { insert(receipts, value.commandId, value); },
      getUiCommandReceipt: (taskId, commandId) => receipts.get(commandId)?.taskId === taskId
        ? receipts.get(commandId)
        : undefined,
    },
    currentBinding: { getCurrentBinding: (sessionId) => sessionId === SESSION_ID ? binding : undefined },
    sessionExecution: {
      getRuntimeForSession: (sessionId) => sessionId === SESSION_ID ? runtime : undefined,
      getAttempt: (attemptId) => attemptId === ATTEMPT_ID ? attempt : undefined,
    },
    providerEffects: {
      getProviderEffectIntent: (intentId) => intents.get(intentId),
    },
  };
  const transaction = {
    run<T>(work: (owners: SessionIdAcpInteractionResponseCapabilities) => T): T {
      const before = snapshot({ messages, inbox, inputs, turns, interventions, receipts, intents });
      try {
        return work(capabilities);
      } catch (error) {
        restore(before, { messages, inbox, inputs, turns, interventions, receipts, intents });
        throw error;
      }
    },
  };
  const stageInteractionResponse = vi.fn((request: Readonly<{
    sessionExecutionAttemptId: string;
    interactionId: string;
    expectedInteractionRevision: number;
    choiceId: string;
  }>) => {
    const intent = responseIntent(request);
    intents.set(intent.providerEffectIntentId, intent);
    if (failStage) throw new Error("controlled_interaction_stage_failure");
    return {
      disposition: "staged" as const,
      commandType: intent.commandType,
      providerEffectIntentId: intent.providerEffectIntentId,
      sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
      sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    };
  });
  const owner = createSessionIdAcpInteractionResponseOwner({
    now: () => NOW,
    createId(kind) { identity += 1; return `${kind}_interaction_${identity}`; },
    authenticatedUserId: "user_interaction",
    task: { taskId: TASK_ID, runId: RUN_ID, conductorSessionId: CONDUCTOR_ID },
    transaction,
    interactionBridge: { stageInteractionResponse },
  });
  return {
    owner,
    messages,
    inbox,
    inputs,
    turns,
    interventions,
    stageInteractionResponse,
    get runtime() { return runtime; },
    set runtime(value: SessionExecutionRuntimeRecord) { runtime = value; },
    attempt,
    snapshot: () => snapshot({ messages, inbox, inputs, turns, interventions, receipts, intents }),
    get slot() { return slot; },
    set slot(value: CardSessionSlotRecord) { slot = value; },
    get failStage() { return failStage; },
    set failStage(value: boolean) { failStage = value; },
  };
}

function slotRecord(): CardSessionSlotRecord {
  return {
    cardSessionSlotId: "card_session_slot_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_interaction",
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
    cardSessionSlotId: "card_session_slot_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_interaction",
    executionProfileId: "profile_interaction",
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    agentCardId: "agent_card_interaction",
    executionProfileId: "profile_interaction",
    profileRevisionId: "profile_revision_interaction",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_interaction",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeRecord(): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    state: "executing",
    activeAttemptId: ATTEMPT_ID,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function attemptRecord(): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: ATTEMPT_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    bindingId: "binding_interaction",
    bindingRevision: 1,
    executionProfileId: "profile_interaction",
    profileRevisionId: "profile_revision_interaction",
    inputSubmissionId: "input_interaction",
    orchestrationSessionTurnId: "session_turn_interaction",
    state: "waiting_for_interaction",
    receiptDigest: `sha256:${"a".repeat(64)}`,
    receiptObservedAt: NOW,
    interactions: [{
      interactionId: INTERACTION_ID,
      promptDigest: `sha256:${"b".repeat(64)}`,
      choices: [{ choiceId: CHOICE_ID, label: LABEL }],
      status: "requested",
      revision: 1,
      requestedAt: NOW,
    }],
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedOr(maps: Readonly<{
  messages: Map<string, SessionIdSessionMessageRecord>;
  inbox: Map<string, SessionLaneItemRecord>;
  inputs: Map<string, SessionIdInputSubmissionRecord>;
  turns: Map<string, SessionIdSessionTurnRecord>;
}>): void {
  const content = "Needs one safe choice";
  maps.messages.set("message_interaction_source", {
    messageId: "message_interaction_source",
    taskId: TASK_ID,
    runId: RUN_ID,
    kind: "conductor_forward",
    content,
    canonicalContent: [{ kind: "text", text: content }],
    contentDigest: hashDefinition(content),
    createdAt: NOW,
  });
  maps.inbox.set("inbox_interaction_source", {
    inboxItemId: "inbox_interaction_source",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    renderedMessageId: "message_interaction_source",
    sequence: 1,
    priority: "ordinary",
    state: "handed",
    createdAt: NOW,
    updatedAt: NOW,
  });
  maps.inputs.set("input_interaction", {
    inputSubmissionId: "input_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    sourceInboxItemId: "inbox_interaction_source",
    contentMessageId: "message_interaction_source",
    commandId: "command_interaction_source",
    idempotencyKey: "interaction:source",
    sequence: 1,
    state: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
  });
  maps.turns.set("session_turn_interaction", {
    sessionTurnId: "session_turn_interaction",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    inputSubmissionId: "input_interaction",
    sourceConductorSessionTurnId: "session_turn_interaction_conductor",
    trigger: "conductor_send",
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function responseIntent(request: Readonly<{
  sessionExecutionAttemptId: string;
  interactionId: string;
  choiceId: string;
}>): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId: "provider_effect_interaction_response",
    commandId: "command_acp_interaction_response",
    idempotencyKey: "acp:interaction:response",
    commandType: "session_runtime.respond_interaction",
    commandFingerprint: hashDefinition(request),
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_interaction",
    sessionExecutionAttemptId: ATTEMPT_ID,
    bindingId: "binding_interaction",
    bindingRevision: 1,
    executionProfileId: "profile_interaction",
    profileRevisionId: "profile_revision_interaction",
    inputSubmissionId: "input_interaction",
    orchestrationSessionTurnId: "session_turn_interaction",
    interactionId: request.interactionId,
    effect: {
      kind: "respond_interaction",
      bindingHandle: "binding_handle_interaction",
      sessionExecutionAttemptId: ATTEMPT_ID,
      interactionId: request.interactionId,
      choiceId: request.choiceId,
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

function restore(value: ReturnType<typeof snapshot>, maps: Record<string, Map<string, unknown>>): void {
  for (const [key, entries] of Object.entries(value)) {
    maps[key]!.clear();
    for (const [id, item] of entries as [string, unknown][]) maps[key]!.set(id, structuredClone(item));
  }
}
