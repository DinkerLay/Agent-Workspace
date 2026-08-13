import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionExecutionSettlement,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdRelayBlockRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import { describe, expect, it } from "vitest";
import {
  createSessionIdAcpCanonicalSettlementCommitter,
  type SessionIdAcpCanonicalSettlementCapabilities,
} from "./session-id-acp-canonical-settlement-committer.js";

const NOW = "2026-08-12T13:00:00.000Z";
const TASK_ID = "task_canonical_final";
const RUN_ID = "run_canonical_final";
const CONDUCTOR_SESSION_ID = "logical_session_canonical_conductor";
const WORKER_SESSION_ID = "logical_session_canonical_worker";
const TURN_ID = "session_turn_canonical_worker";
const INPUT_ID = "input_canonical_worker";
const SOURCE_INBOX_ID = "inbox_canonical_source";
const RECEIPT = `sha256:${"d".repeat(64)}`;

describe("Session-ID ACP production canonical settlement committer", () => {
  it("exact-fences settled Attempt/current v3 Binding and atomically writes the one canonical Final", () => {
    const fixture = createFixture();

    expect(fixture.committer.commitCanonicalAgentFinal(fixture.settlement)).toEqual({
      status: "recorded",
      messageId: "message_canonical_1",
      inboxItemId: "inbox_item_canonical_2",
    });
    expect(fixture.messages.get("message_canonical_1")).toMatchObject({
      taskId: TASK_ID,
      runId: RUN_ID,
      sourceSessionId: WORKER_SESSION_ID,
      sourceSessionTurnId: TURN_ID,
      kind: "agent_final",
      content: "Canonical result",
    });
    expect(fixture.inputs.get(INPUT_ID)).toMatchObject({ state: "returned" });
    expect(fixture.turns.get(TURN_ID)).toMatchObject({
      state: "returned",
      finalMessageId: "message_canonical_1",
      settledAt: NOW,
    });
    expect(fixture.inbox.get(SOURCE_INBOX_ID)).toMatchObject({ state: "handled" });
    expect(fixture.inbox.get("inbox_item_canonical_2")).toMatchObject({
      sessionId: CONDUCTOR_SESSION_ID,
      renderedMessageId: "message_canonical_1",
      state: "pending",
      priority: "ordinary",
    });
    expect(fixture.writes()).toEqual({ message: 1, relay: 0, orchestration: 4, human: 0 });

    expect(fixture.committer.commitCanonicalAgentFinal(fixture.settlement)).toEqual({
      status: "replayed",
      messageId: "message_canonical_1",
      inboxItemId: "inbox_item_canonical_2",
    });
    expect(fixture.writes()).toEqual({ message: 1, relay: 0, orchestration: 4, human: 0 });
  });

  it("accepts the exact ambiguous Turn left by interrupt reconciliation and still writes Final once", () => {
    const fixture = createFixture({ turnState: "ambiguous" });
    expect(fixture.committer.commitCanonicalAgentFinal(fixture.settlement)).toMatchObject({ status: "recorded" });
    expect(fixture.turns.get(TURN_ID)).toMatchObject({ state: "returned" });
    expect(fixture.inputs.get(INPUT_ID)).toMatchObject({ state: "returned" });
    expect(fixture.inbox.get(SOURCE_INBOX_ID)).toMatchObject({ state: "handled" });
  });

  it("atomically orders a kind-aware late-Final Notice as the Final Inbox causal predecessor", () => {
    const fixture = createFixture({ turnState: "ambiguous", lateInterrupt: "human" });
    const recorded = fixture.committer.commitCanonicalAgentFinal(fixture.settlement);
    const conductorLane = [...fixture.inbox.values()]
      .filter((item) => item.sessionId === CONDUCTOR_SESSION_ID)
      .sort((left, right) => left.sequence - right.sequence);
    expect(conductorLane).toHaveLength(2);
    const [noticeInbox, finalInbox] = conductorLane;
    expect(fixture.messages.get(noticeInbox!.renderedMessageId)).toMatchObject({ kind: "runtime_notice" });
    expect(fixture.messages.get(noticeInbox!.renderedMessageId)!.content).toContain("authenticated human");
    expect(finalInbox).toMatchObject({
      renderedMessageId: recorded.messageId,
      causalPredecessorInboxItemId: noticeInbox!.inboxItemId,
    });
    expect(noticeInbox!.sequence).toBeLessThan(finalInbox!.sequence);
    expect(fixture.committer.commitCanonicalAgentFinal(fixture.settlement))
      .toEqual({ ...recorded, status: "replayed" });
    expect([...fixture.inbox.values()].filter((item) => item.sessionId === CONDUCTOR_SESSION_ID)).toHaveLength(2);
  });

  it("fails closed before writes for settlement, current Binding, generation, or run drift", () => {
    const cases: Array<Readonly<{
      mutate(fixture: Fixture): SessionExecutionSettlement;
      error: RegExp;
    }>> = [{
      mutate: (fixture) => ({ ...fixture.settlement, finalContentDigest: hashDefinition("forged") }),
      error: /final_digest_mismatch/,
    }, {
      mutate: (fixture) => {
        fixture.currentBinding = { ...fixture.currentBinding, revision: 2 };
        return fixture.settlement;
      },
      error: /current_binding_mismatch/,
    }, {
      mutate: (fixture) => {
        fixture.generations.set(WORKER_SESSION_ID, {
          ...fixture.generations.get(WORKER_SESSION_ID)!,
          lifecycle: "closed",
          closedAt: NOW,
        });
        return fixture.settlement;
      },
      error: /session_not_current/,
    }, {
      mutate: (fixture) => {
        fixture.slots.set("card_session_slot_canonical", {
          ...fixture.slots.get("card_session_slot_canonical")!,
          latestGeneration: 2,
        });
        return fixture.settlement;
      },
      error: /session_not_current/,
    }, {
      mutate: (fixture) => {
        fixture.generations.set(WORKER_SESSION_ID, {
          ...fixture.generations.get(WORKER_SESSION_ID)!,
          sessionId: "logical_session_canonical_other",
        });
        return fixture.settlement;
      },
      error: /session_not_current/,
    }, {
      mutate: (fixture) => {
        fixture.runStatus = "stopping";
        return fixture.settlement;
      },
      error: /run_not_accepting_final/,
    }];
    for (const testCase of cases) {
      const fixture = createFixture();
      const value = testCase.mutate(fixture);
      const before = fixture.snapshot();
      expect(() => fixture.committer.commitCanonicalAgentFinal(value)).toThrow(testCase.error);
      expect(fixture.snapshot()).toEqual(before);
      expect(fixture.writes()).toEqual({ message: 0, relay: 0, orchestration: 0, human: 0 });
    }
  });

  it("rolls back Message and OR mutations when the final Conductor Inbox write fails", () => {
    const fixture = createFixture();
    fixture.failConductorInbox = true;
    const before = fixture.snapshot();

    expect(() => fixture.committer.commitCanonicalAgentFinal(fixture.settlement))
      .toThrow(/controlled_conductor_inbox_failure/);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.writes()).toEqual({ message: 0, relay: 0, orchestration: 0, human: 0 });
  });

  it("rolls back the late-Final Notice when the causally linked Final Inbox write fails", () => {
    const fixture = createFixture({ turnState: "ambiguous", lateInterrupt: "conductor" });
    fixture.failFinalInbox = true;
    const before = fixture.snapshot();

    expect(() => fixture.committer.commitCanonicalAgentFinal(fixture.settlement))
      .toThrow(/controlled_final_inbox_failure/);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.writes()).toEqual({ message: 0, relay: 0, orchestration: 0, human: 0 });
  });

  it("returns only safe Workspace identities and never exposes Provider/path authority", () => {
    const fixture = createFixture();
    const result = fixture.committer.commitCanonicalAgentFinal(fixture.settlement);
    expect(JSON.stringify(result)).not.toMatch(
      /(?:content|bindingHandle|cwd|path|credential|native|raw|provider)/iu,
    );
    expect(Object.keys(fixture.committer)).toEqual(["commitCanonicalAgentFinal"]);
  });
});

type Fixture = ReturnType<typeof createFixture>;
type FixtureOptions = Readonly<{
  turnState?: "active" | "ambiguous";
  lateInterrupt?: "human" | "conductor";
}>;

function createFixture(options: FixtureOptions = {}) {
  const messages = new Map<string, SessionIdSessionMessageRecord>();
  const relayBlocks = new Map<string, SessionIdRelayBlockRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>();
  const inputs = new Map<string, SessionIdInputSubmissionRecord>();
  const turns = new Map<string, SessionIdSessionTurnRecord>();
  const interventions = new Map<string, SessionIdHumanInterventionRecord>();
  const slots = new Map<string, CardSessionSlotRecord>();
  const generations = new Map<string, CardSessionGenerationRecord>();
  const runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  const attempts = new Map<string, SessionExecutionAttemptRecord>();
  const controls = new Map<string, SessionControlAuditRecord>();
  const providerEffects = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  let id = 0;
  let runStatus = "running";
  let failConductorInbox = false;
  let failFinalInbox = false;
  const writeCounts = { message: 0, relay: 0, orchestration: 0, human: 0 };

  const settlement: SessionExecutionSettlement = Object.freeze({
    sessionExecutionRuntimeId: "session_execution_runtime_canonical",
    sessionExecutionAttemptId: "session_execution_attempt_canonical",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    bindingId: "binding_canonical",
    bindingRevision: 1,
    executionProfileId: "profile_canonical",
    profileRevisionId: "profile_revision_canonical",
    inputSubmissionId: INPUT_ID,
    orchestrationSessionTurnId: TURN_ID,
    outcome: "completed",
    receiptDigest: RECEIPT,
    finalContent: "Canonical result",
    finalContentDigest: hashDefinition("Canonical result"),
    settledAt: NOW,
  });
  let currentBinding: AcpSafeSessionBindingRecordV3 = Object.freeze({
    schemaVersion: 3,
    bindingId: settlement.bindingId,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    agentCardId: "agent_card_canonical",
    executionProfileId: settlement.executionProfileId,
    profileRevisionId: settlement.profileRevisionId,
    providerFamily: "opencode",
    bindingHandle: "binding_handle_canonical",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  slots.set("card_session_slot_canonical", {
    cardSessionSlotId: "card_session_slot_canonical",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: currentBinding.agentCardId,
    currentSessionId: WORKER_SESSION_ID,
    latestGeneration: 1,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
  generations.set(WORKER_SESSION_ID, {
    sessionId: WORKER_SESSION_ID,
    cardSessionSlotId: "card_session_slot_canonical",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: currentBinding.agentCardId,
    executionProfileId: settlement.executionProfileId,
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  });
  messages.set("message_canonical_source", {
    messageId: "message_canonical_source",
    taskId: TASK_ID,
    runId: RUN_ID,
    kind: "conductor_forward",
    content: "Do the work",
    canonicalContent: [{ kind: "text", text: "Do the work" }],
    contentDigest: hashDefinition("Do the work"),
    createdAt: NOW,
  });
  inbox.set(SOURCE_INBOX_ID, {
    inboxItemId: SOURCE_INBOX_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_SESSION_ID,
    renderedMessageId: "message_canonical_source",
    sequence: 1,
    priority: "ordinary",
    state: "handed",
    forwardId: "message_forward_canonical_source",
    createdAt: NOW,
    updatedAt: NOW,
  });
  inputs.set(INPUT_ID, {
    inputSubmissionId: INPUT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_SESSION_ID,
    sourceInboxItemId: SOURCE_INBOX_ID,
    contentMessageId: "message_canonical_source",
    commandId: "command_canonical_source",
    idempotencyKey: "input:canonical",
    sequence: 1,
    state: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
  });
  turns.set(TURN_ID, {
    sessionTurnId: TURN_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_SESSION_ID,
    inputSubmissionId: INPUT_ID,
    sourceConductorSessionTurnId: "session_turn_canonical_conductor",
    trigger: "conductor_send",
    state: options.turnState ?? "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  runtimes.set(settlement.sessionExecutionRuntimeId, {
    sessionExecutionRuntimeId: settlement.sessionExecutionRuntimeId,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    state: "idle",
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  });
  attempts.set(settlement.sessionExecutionAttemptId, {
    sessionExecutionAttemptId: settlement.sessionExecutionAttemptId,
    sessionExecutionRuntimeId: settlement.sessionExecutionRuntimeId,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    bindingId: settlement.bindingId,
    bindingRevision: settlement.bindingRevision,
    executionProfileId: settlement.executionProfileId,
    profileRevisionId: settlement.profileRevisionId,
    inputSubmissionId: INPUT_ID,
    orchestrationSessionTurnId: TURN_ID,
    state: "settled",
    receiptDigest: RECEIPT,
    receiptObservedAt: NOW,
    interactions: [],
    finalCandidate: {
      candidateObservationId: "provider_fact_candidate_canonical",
      content: settlement.finalContent!,
      contentDigest: settlement.finalContentDigest!,
      observedAt: NOW,
    },
    terminal: {
      terminalObservationId: "provider_fact_terminal_canonical",
      outcome: "completed",
      receiptDigest: RECEIPT,
      observedAt: NOW,
    },
    settlement,
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (options.lateInterrupt) {
    controls.set("session_control_canonical_late", {
      sessionControlAuditId: "session_control_canonical_late",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      commandId: "command_canonical_late_interrupt",
      idempotencyKey: "canonical:late-interrupt",
      kind: options.lateInterrupt === "human" ? "human_interrupt" : "conductor_interrupt",
      state: "unknown",
      affectedInboxItemIds: [],
      requestedAt: NOW,
      settledAt: NOW,
      reason: "provider_terminal_won",
    });
    const effect = interruptIntent();
    providerEffects.set(effect.providerEffectIntentId, effect);
  }

  const capabilities: SessionIdAcpCanonicalSettlementCapabilities = {
    taskRun: {
      getGeneration: (sessionId) => generations.get(sessionId),
      getSlot: (slotId) => slots.get(slotId),
      getConductorSessionId: () => CONDUCTOR_SESSION_ID,
      readTaskRunState: () => ({ taskId: TASK_ID, runId: RUN_ID, runStatus }),
    },
    message: {
      createMessage(message) { writeCounts.message += 1; insert(messages, message.messageId, message); },
      getMessage: (messageId) => messages.get(messageId),
      findFinalByTurn: (turnId) => [...messages.values()]
        .find((message) => message.kind === "agent_final" && message.sourceSessionTurnId === turnId),
      createRelayBlock(block) { writeCounts.relay += 1; insert(relayBlocks, block.relayBlockId, block); },
    },
    orchestration: {
      getInboxItem: (inboxId) => inbox.get(inboxId),
      listInboxItems: (sessionId) => [...inbox.values()].filter((item) => item.sessionId === sessionId),
      createInboxItem(item) {
        if (failConductorInbox && item.sessionId === CONDUCTOR_SESSION_ID) {
          throw new Error("controlled_conductor_inbox_failure");
        }
        if (failFinalInbox && item.sessionId === CONDUCTOR_SESSION_ID && item.priority === "ordinary") {
          throw new Error("controlled_final_inbox_failure");
        }
        writeCounts.orchestration += 1;
        insert(inbox, item.inboxItemId, item);
      },
      updateInboxItem: (item, expected) => updateState(inbox, item.inboxItemId, item, expected, writeCounts),
      getInputSubmission: (inputId) => inputs.get(inputId),
      updateInputSubmission: (input, expected) => updateState(inputs, input.inputSubmissionId, input, expected, writeCounts),
      getTurn: (turnId) => turns.get(turnId),
      updateTurn: (turn, expected) => updateState(turns, turn.sessionTurnId, turn, expected, writeCounts),
      listControlAudits: (runId, sessionId) => [...controls.values()]
        .filter((control) => control.runId === runId && (!sessionId || control.sessionId === sessionId)),
    },
    humanIntervention: {
      get: (interventionId) => interventions.get(interventionId),
      update(intervention) { writeCounts.human += 1; interventions.set(intervention.humanInterventionId, intervention); },
    },
    currentBinding: {
      getCurrentBinding: (sessionId) => sessionId === WORKER_SESSION_ID ? currentBinding : undefined,
    },
    sessionExecution: {
      getRuntime: (runtimeId) => runtimes.get(runtimeId),
      getAttempt: (attemptId) => attempts.get(attemptId),
    },
    providerEffects: {
      listProviderEffectIntents: (attemptId) => [...providerEffects.values()]
        .filter((intent) => attemptId === undefined || intent.sessionExecutionAttemptId === attemptId),
    },
  };
  const transaction = {
    run<T>(work: (owners: SessionIdAcpCanonicalSettlementCapabilities) => T): T {
      const before = snapshotMaps({ messages, relayBlocks, inbox, inputs, turns, interventions });
      const beforeCounts = { ...writeCounts };
      try {
        return work(capabilities);
      } catch (error) {
        restoreMaps(before, { messages, relayBlocks, inbox, inputs, turns, interventions });
        Object.assign(writeCounts, beforeCounts);
        throw error;
      }
    },
  };
  const committer = createSessionIdAcpCanonicalSettlementCommitter({
    now: () => NOW,
    createId(kind) {
      id += 1;
      return `${kind}_canonical_${id}`;
    },
    task: { taskId: TASK_ID, runId: RUN_ID, conductorSessionId: CONDUCTOR_SESSION_ID },
    transaction,
  });

  return {
    committer,
    settlement,
    messages,
    inbox,
    inputs,
    turns,
    slots,
    generations,
    writes: () => ({ ...writeCounts }),
    snapshot: () => snapshotMaps({ messages, relayBlocks, inbox, inputs, turns, interventions }),
    get currentBinding() { return currentBinding; },
    set currentBinding(value: AcpSafeSessionBindingRecordV3) { currentBinding = value; },
    get runStatus() { return runStatus; },
    set runStatus(value: string) { runStatus = value; },
    get failConductorInbox() { return failConductorInbox; },
    set failConductorInbox(value: boolean) { failConductorInbox = value; },
    get failFinalInbox() { return failFinalInbox; },
    set failFinalInbox(value: boolean) { failFinalInbox = value; },
  };
}

function interruptIntent(): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId: "provider_effect_canonical_late",
    commandId: "command_acp_canonical_late",
    idempotencyKey: "acp:canonical:late",
    commandType: "session_runtime.request_interrupt",
    commandFingerprint: hashDefinition({ control: "session_control_canonical_late" }),
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_canonical",
    sessionExecutionAttemptId: "session_execution_attempt_canonical",
    bindingId: "binding_canonical",
    bindingRevision: 1,
    executionProfileId: "profile_canonical",
    profileRevisionId: "profile_revision_canonical",
    inputSubmissionId: INPUT_ID,
    orchestrationSessionTurnId: TURN_ID,
    sessionControlAuditId: "session_control_canonical_late",
    effect: {
      kind: "request_interrupt",
      bindingHandle: "binding_handle_canonical",
      sessionExecutionAttemptId: "session_execution_attempt_canonical",
      sessionControlAuditId: "session_control_canonical_late",
    },
    state: "pending",
    createdAt: NOW,
  };
}

function insert<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) throw new Error("controlled_duplicate_write");
  map.set(key, structuredClone(value));
}

function updateState<T extends { state: string }>(
  map: Map<string, T>,
  key: string,
  value: T,
  expected: T["state"],
  counts: { orchestration: number },
): void {
  const current = map.get(key);
  if (!current || current.state !== expected) throw new Error("controlled_state_conflict");
  counts.orchestration += 1;
  map.set(key, structuredClone(value));
}

function snapshotMaps<T extends Record<string, Map<string, unknown>>>(maps: T) {
  return Object.fromEntries(Object.entries(maps).map(([key, map]) => [
    key,
    [...map.entries()].map(([id, value]) => [id, structuredClone(value)]),
  ]));
}

function restoreMaps(
  snapshot: ReturnType<typeof snapshotMaps>,
  maps: Record<string, Map<string, unknown>>,
): void {
  for (const [key, entries] of Object.entries(snapshot)) {
    const map = maps[key]!;
    map.clear();
    for (const [id, value] of entries as [string, unknown][]) map.set(id, structuredClone(value));
  }
}
