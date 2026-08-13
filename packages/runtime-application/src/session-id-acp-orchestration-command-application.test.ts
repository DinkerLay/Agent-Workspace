import {
  hashDefinition,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdCommandReceiptRecord,
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdRelayBlockRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
  SessionIdUiCommandReceiptRecord,
} from "@agent-workspace/runtime-store";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionIdAcpOrchestrationCommandApplication,
  type SessionIdAcpOrchestrationCommandCapabilities,
} from "./session-id-acp-orchestration-command-application.js";

const NOW = "2026-08-12T12:00:00.000Z";
const TASK_ID = "task_command";
const RUN_ID = "run_command";
const CONDUCTOR_SESSION_ID = "logical_session_command_conductor";
const CONDUCTOR_TURN_ID = "session_turn_command_conductor";
const CARD_ID = "agent_card_command_worker";
const SLOT_ID = "card_session_slot_command_worker";
const WORKER_SESSION_ID = "logical_session_command_worker";
const PROFILE_ID = "profile_command_worker";
const PROFILE_REVISION_ID = "profile_revision_command_worker";

describe("Session-ID ACP-only canonical orchestration command application", () => {
  it("materializes only one v3-fenced LogicalSession and exactly replays invoke", () => {
    const fixture = createFixture();
    const command = conductorScope("invoke-1");

    expect(fixture.application.invokeAgent({ ...command, agentCardId: CARD_ID })).toEqual({
      result: { sessionId: WORKER_SESSION_ID },
      providerEffectIntentIds: [],
    });
    expect(fixture.generations.get(WORKER_SESSION_ID)).toMatchObject({
      sessionId: WORKER_SESSION_ID,
      executionProfileId: PROFILE_ID,
      lifecycle: "current",
    });
    expect(fixture.profileResolutions).toEqual([{
      taskId: TASK_ID,
      runId: RUN_ID,
      logicalSessionId: WORKER_SESSION_ID,
      executionProfileId: PROFILE_ID,
    }]);
    expect(fixture.ownerCounts()).toEqual({
      taskRun: 1,
      message: 0,
      orchestration: 0,
      human: 0,
      commandReceipt: 1,
      uiReceipt: 0,
      providerEffect: 0,
    });

    expect(fixture.application.invokeAgent({ ...command, agentCardId: CARD_ID })).toEqual({
      result: { sessionId: WORKER_SESSION_ID },
      providerEffectIntentIds: [],
    });
    expect(fixture.ownerCounts()).toMatchObject({ taskRun: 1, commandReceipt: 1 });
    expect(() => fixture.application.invokeAgent({
      ...command,
      expectedRevision: command.expectedRevision + 1,
      agentCardId: CARD_ID,
    })).toThrow(/orchestration_idempotency_payload_conflict/);
  });

  it("commits one Message/Forward/Inbox send, authorizes frozen refs, and never stages a Provider effect", () => {
    const fixture = createFixture({ materialized: true, seedReference: true });
    const command = {
      ...conductorScope("send-1"),
      sessionId: WORKER_SESSION_ID,
      payload: {
        content: "Review this exact evidence.",
        messageRefs: [{ kind: "full_message" as const, sourceMessageId: "message_reference" }],
      },
    };

    expect(fixture.application.sendToSession(command)).toEqual({
      result: { status: "accepted" },
      providerEffectIntentIds: [],
    });
    const forward = [...fixture.forwards.values()][0]!;
    const rendered = fixture.messages.get(forward.renderedMessageId)!;
    const inbox = [...fixture.inbox.values()].find((item) => item.forwardId === forward.forwardId)!;
    expect(forward).toMatchObject({
      targetSessionId: WORKER_SESSION_ID,
      decidedBySessionTurnId: CONDUCTOR_TURN_ID,
    });
    expect(rendered.content).toContain("Review this exact evidence.");
    expect(rendered.content).toContain("Immutable reference content");
    expect(inbox).toMatchObject({ state: "pending", priority: "ordinary" });
    expect(fixture.providerIntents.size).toBe(0);

    expect(fixture.application.sendToSession(command)).toEqual({
      result: { status: "accepted" },
      providerEffectIntentIds: [],
    });
    expect(fixture.forwards.size).toBe(1);

    const rejected = createFixture({ materialized: true, seedReference: true });
    const referenceInbox = [...rejected.inbox.values()].find((item) =>
      item.renderedMessageId === "message_reference")!;
    rejected.inbox.delete(referenceInbox.inboxItemId);
    const first = rejected.application.sendToSession(command);
    expect(first).toEqual({
      result: { status: "rejected", reason: "orchestration_message_reference_not_authorized" },
      providerEffectIntentIds: [],
    });
    rejected.inbox.set(referenceInbox.inboxItemId, referenceInbox);
    expect(rejected.application.sendToSession(command)).toEqual(first);
    expect(rejected.forwards.size).toBe(0);
    expect(rejected.providerIntents.size).toBe(0);
  });

  it("rejects commands unless the Card matches the exact current slot generation", () => {
    const cases: Array<(fixture: ReturnType<typeof createFixture>) => void> = [
      (fixture) => {
        fixture.slots.set(SLOT_ID, { ...fixture.slots.get(SLOT_ID)!, latestGeneration: 2 });
      },
      (fixture) => {
        fixture.generations.set(WORKER_SESSION_ID, {
          ...fixture.generations.get(WORKER_SESSION_ID)!,
          sessionId: "logical_session_command_other",
        });
      },
      (fixture) => {
        fixture.generations.set(WORKER_SESSION_ID, {
          ...fixture.generations.get(WORKER_SESSION_ID)!,
          closedAt: NOW,
        } as CardSessionGenerationRecord);
      },
    ];
    for (const [index, mutate] of cases.entries()) {
      const fixture = createFixture({ materialized: true });
      mutate(fixture);
      const before = fixture.snapshot();
      expect(fixture.application.sendToSession({
        ...conductorScope(`generation-fence-${index}`),
        sessionId: WORKER_SESSION_ID,
        payload: { content: "Must remain fenced." },
      })).toEqual({
        result: { status: "rejected", reason: "orchestration_session_not_current" },
        providerEffectIntentIds: [],
      });
      expect(withoutReceipts(fixture.snapshot())).toEqual(withoutReceipts(before));
      expect(fixture.providerIntents.size).toBe(0);
    }
  });

  it("atomically stages an exact v3 interrupt intent and recovers its drain ID on replay", () => {
    const fixture = createFixture({ materialized: true, activeWorkerTurn: true });
    const command = {
      ...conductorScope("interrupt-1"),
      sessionId: WORKER_SESSION_ID,
    };

    expect(fixture.application.interruptSession(command)).toEqual({
      result: { status: "accepted" },
      providerEffectIntentIds: ["provider_effect_command_interrupt_1"],
    });
    const control = [...fixture.controls.values()][0]!;
    const intent = fixture.providerIntents.get("provider_effect_command_interrupt_1")!;
    expect(control).toMatchObject({ kind: "conductor_interrupt", state: "requested" });
    expect(intent).toMatchObject({
      commandType: "session_runtime.request_interrupt",
      sessionControlAuditId: control.sessionControlAuditId,
      sessionExecutionAttemptId: "session_execution_attempt_command_worker",
    });
    expect(fixture.stageInterrupt).toHaveBeenCalledTimes(1);

    expect(fixture.application.interruptSession(command)).toEqual({
      result: { status: "accepted" },
      providerEffectIntentIds: [intent.providerEffectIntentId],
    });
    expect(fixture.stageInterrupt).toHaveBeenCalledTimes(1);

    const rollback = createFixture({ materialized: true, activeWorkerTurn: true });
    rollback.failInterruptStage = true;
    expect(() => rollback.application.interruptSession(command)).toThrow(/controlled_interrupt_stage_failure/);
    expect(rollback.controls.size).toBe(0);
    expect(rollback.providerIntents.size).toBe(0);
    expect(rollback.commandReceipts.size).toBe(0);
  });

  it("records an authenticated human scoped interrupt without creating Message content", () => {
    const fixture = createFixture({ materialized: true, activeWorkerTurn: true });
    const command = {
      commandId: "command_human_interrupt_1",
      taskId: TASK_ID,
      runId: RUN_ID,
      expectedRevision: 7,
      targetLogicalSessionId: WORKER_SESSION_ID,
      humanInterventionId: "human_intervention_command_interrupt_1",
      idempotencyKey: "human-interrupt:1",
      authenticatedUserId: "user_command_1",
    };

    const first = fixture.application.requestHumanInterrupt(command);
    expect(first).toEqual({
      result: {
        control: {
          sessionControlAuditId: "session_control_command_1",
          state: "requested",
        },
      },
      providerEffectIntentIds: ["provider_effect_command_interrupt_1"],
    });
    expect(fixture.interventions.get(command.humanInterventionId)).toMatchObject({
      mode: "scoped_interrupt",
      state: "accepted",
      authenticatedUserId: command.authenticatedUserId,
      affectedSessionTurnId: "session_turn_command_worker",
    });
    expect(fixture.messages.size).toBe(1); // the pre-existing active delivery only
    expect(fixture.application.requestHumanInterrupt(command)).toEqual(first);
    expect(fixture.stageInterrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps the superseded synchronous close seam fail-closed until the retirement owner drains", () => {
    const fixture = createFixture({ materialized: true, pendingOrdinary: true });
    const command = { ...conductorScope("close-1"), sessionId: WORKER_SESSION_ID };
    const unrelated = providerIntent("provider_effect_historical_submit", "session_control_historical");
    fixture.providerIntents.set(unrelated.providerEffectIntentId, unrelated);
    const before = fixture.snapshot();

    expect(fixture.application.closeSession(command)).toEqual({
      result: { status: "rejected", reason: "session_close_retirement_owner_required" },
      providerEffectIntentIds: [],
    });
    expect(withoutReceipts(fixture.snapshot())).toEqual(withoutReceipts(before));
    expect(fixture.providerIntents.get(unrelated.providerEffectIntentId)).toEqual(unrelated);
    expect(fixture.application.closeSession(command)).toEqual({
      result: { status: "rejected", reason: "session_close_retirement_owner_required" },
      providerEffectIntentIds: [],
    });
    expect(fixture.forwards.size).toBe(0);
  });

  it("blocks new sends while any exact target Control is unresolved", () => {
    const fixture = createFixture({ materialized: true, unresolvedControl: true });
    const before = fixture.snapshot();
    expect(fixture.application.sendToSession({
      ...conductorScope("send-during-close-fence"),
      sessionId: WORKER_SESSION_ID,
      payload: { content: "Must not race a pending close." },
    })).toEqual({
      result: { status: "rejected", reason: "session_send_control_unresolved" },
      providerEffectIntentIds: [],
    });
    expect(withoutReceipts(fixture.snapshot())).toEqual(withoutReceipts(before));
  });

  it("rejects close with zero writes for active/reconciling Attempt, unresolved Control, or Interaction", () => {
    const cases = [
      { runtimeState: "executing" as const, interaction: false, control: false },
      { runtimeState: "reconciling" as const, interaction: false, control: false },
      { runtimeState: "idle" as const, interaction: false, control: true },
      { runtimeState: "executing" as const, interaction: true, control: false },
    ];
    for (const [index, testCase] of cases.entries()) {
      const fixture = createFixture({
        materialized: true,
        runtimeState: testCase.runtimeState,
        unresolvedInteraction: testCase.interaction,
        unresolvedControl: testCase.control,
      });
      const before = fixture.snapshot();
      const result = fixture.application.closeSession({
        ...conductorScope(`close-rejected-${index}`),
        sessionId: WORKER_SESSION_ID,
      });
      expect(result.result).toMatchObject({ status: "rejected" });
      // Only the durable rejected command receipt may be added; no domain/effect writer changes.
      expect(withoutReceipts(fixture.snapshot())).toEqual(withoutReceipts(before));
      expect(result.providerEffectIntentIds).toEqual([]);
    }
  });

  it("enqueues the Task goal as the unique first Conductor input and replays by Message identity", () => {
    const fixture = createFixture();
    const input = { messageId: "message_command_goal", content: "Ship the ACP-only task." };
    expect(fixture.application.enqueueTaskGoal(input)).toEqual({ status: "enqueued" });
    expect(fixture.messages.get(input.messageId)).toMatchObject({ kind: "task_goal" });
    expect([...fixture.inbox.values()][0]).toMatchObject({
      sessionId: CONDUCTOR_SESSION_ID,
      sequence: 1,
      priority: "human",
      state: "pending",
    });
    expect(fixture.application.enqueueTaskGoal(input)).toEqual({ status: "enqueued" });
    expect(() => fixture.application.enqueueTaskGoal({ ...input, content: "Conflicting goal" }))
      .toThrow(/task_goal_replay_conflict/);
    expect(fixture.providerIntents.size).toBe(0);
  });

  it("keeps command commits free of collaboration content and private Provider/path fields", () => {
    const fixture = createFixture({ materialized: true, activeWorkerTurn: true });
    const result = fixture.application.interruptSession({
      ...conductorScope("interrupt-safe-shape"),
      sessionId: WORKER_SESSION_ID,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /(?:content|cwd|path|credential|nativeBindingRef|nativeRequestId|raw[A-Z_])/u,
    );
    expect(Object.keys(result).sort()).toEqual(["providerEffectIntentIds", "result"]);
  });
});

type FixtureOptions = Readonly<{
  materialized?: boolean;
  seedReference?: boolean;
  activeWorkerTurn?: boolean;
  pendingOrdinary?: boolean;
  runtimeState?: SessionExecutionRuntimeRecord["state"];
  unresolvedInteraction?: boolean;
  unresolvedControl?: boolean;
}>;

function createFixture(options: FixtureOptions = {}) {
  const slots = new Map<string, CardSessionSlotRecord>();
  const generations = new Map<string, CardSessionGenerationRecord>();
  const messages = new Map<string, SessionIdSessionMessageRecord>();
  const relayBlocks = new Map<string, SessionIdRelayBlockRecord>();
  const forwards = new Map<string, SessionIdMessageForwardRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>();
  const inputs = new Map<string, SessionIdInputSubmissionRecord>();
  const turns = new Map<string, SessionIdSessionTurnRecord>();
  const controls = new Map<string, SessionControlAuditRecord>();
  const interventions = new Map<string, SessionIdHumanInterventionRecord>();
  const commandReceipts = new Map<string, SessionIdCommandReceiptRecord>();
  const uiReceipts = new Map<string, SessionIdUiCommandReceiptRecord>();
  const runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  const attempts = new Map<string, SessionExecutionAttemptRecord>();
  const providerIntents = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  const profileResolutions: unknown[] = [];
  let id = 0;
  let failInterruptStage = false;
  const writes = {
    taskRun: 0,
    message: 0,
    orchestration: 0,
    human: 0,
    commandReceipt: 0,
    uiReceipt: 0,
    providerEffect: 0,
  };

  slots.set(SLOT_ID, slotRecord(Boolean(options.materialized)));
  if (options.materialized) generations.set(WORKER_SESSION_ID, generationRecord());
  turns.set(CONDUCTOR_TURN_ID, {
    sessionTurnId: CONDUCTOR_TURN_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: CONDUCTOR_SESSION_ID,
    inputSubmissionId: "input_command_conductor",
    trigger: "task_goal",
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });

  if (options.seedReference) {
    messages.set("message_reference", messageRecord("message_reference", "Immutable reference content"));
    inbox.set("inbox_reference", inboxRecord({
      inboxItemId: "inbox_reference",
      sessionId: CONDUCTOR_SESSION_ID,
      renderedMessageId: "message_reference",
      sequence: 1,
      state: "handled",
    }));
  }
  if (options.activeWorkerTurn) seedActiveWorkerDelivery({ messages, forwards, inbox, inputs, turns });
  if (options.pendingOrdinary) {
    messages.set("message_pending_close", messageRecord("message_pending_close", "Pending ordinary"));
    inbox.set("inbox_pending_close", inboxRecord({
      inboxItemId: "inbox_pending_close",
      sessionId: WORKER_SESSION_ID,
      renderedMessageId: "message_pending_close",
      sequence: 1,
      state: "pending",
      forwardId: "forward_pending_close",
    }));
  }
  if (options.runtimeState) {
    const active = options.runtimeState === "executing" || options.runtimeState === "reconciling";
    runtimes.set("session_execution_runtime_command_worker", {
      sessionExecutionRuntimeId: "session_execution_runtime_command_worker",
      taskId: TASK_ID,
      runId: RUN_ID,
      logicalSessionId: WORKER_SESSION_ID,
      state: options.runtimeState,
      ...(active ? { activeAttemptId: "session_execution_attempt_command_worker" } : {}),
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (active) attempts.set("session_execution_attempt_command_worker", attemptRecord(options.unresolvedInteraction));
  }
  if (options.unresolvedControl) {
    controls.set("session_control_command_unresolved", {
      sessionControlAuditId: "session_control_command_unresolved",
      taskId: TASK_ID,
      runId: RUN_ID,
      sessionId: WORKER_SESSION_ID,
      commandId: "command_command_unresolved",
      idempotencyKey: "control:unresolved",
      kind: "conductor_interrupt",
      state: "unknown",
      affectedInboxItemIds: [],
      requestedAt: NOW,
    });
  }

  const capabilities: SessionIdAcpOrchestrationCommandCapabilities = {
    taskRun: {
      findSlot: (runId, agentCardId) => [...slots.values()]
        .find((slot) => slot.runId === runId && slot.agentCardId === agentCardId),
      getSlot: (slotId) => slots.get(slotId),
      getGeneration: (sessionId) => generations.get(sessionId),
      materializeGeneration(slot, generation) {
        writes.taskRun += 1;
        slots.set(slot.cardSessionSlotId, structuredClone(slot));
        generations.set(generation.sessionId, structuredClone(generation));
      },
      retireGeneration(slot, generation) {
        writes.taskRun += 1;
        slots.set(slot.cardSessionSlotId, structuredClone(slot));
        generations.set(generation.sessionId, structuredClone(generation));
      },
      readTaskRunState: () => ({
        taskId: TASK_ID,
        runId: RUN_ID,
        taskRevision: 7,
        runStatus: "running",
        currentConductorSessionTurnId: CONDUCTOR_TURN_ID,
      }),
      getConductorSessionId: () => CONDUCTOR_SESSION_ID,
      latestPlanningFence: () => undefined,
    },
    message: {
      createMessage(message) { writes.message += 1; insert(messages, message.messageId, message); },
      getMessage: (messageId) => messages.get(messageId),
      createForward(forward) { writes.message += 1; insert(forwards, forward.forwardId, forward); },
      getForward: (forwardId) => forwards.get(forwardId),
      findForwardByIdempotencyKey: (taskId, runId, key) => [...forwards.values()]
        .find((forward) => forward.taskId === taskId && forward.runId === runId && forward.idempotencyKey === key),
      getRelayBlock: (relayBlockId) => relayBlocks.get(relayBlockId),
    },
    orchestration: {
      createInboxItem(item) { writes.orchestration += 1; insert(inbox, item.inboxItemId, item); },
      getInboxItem: (inboxItemId) => inbox.get(inboxItemId),
      listInboxItems: (sessionId) => [...inbox.values()].filter((item) => item.sessionId === sessionId),
      suppressPendingOrdinary(sessionId, reason, now) {
        const affected: string[] = [];
        for (const item of inbox.values()) {
          if (item.sessionId !== sessionId || item.state !== "pending" || item.priority !== "ordinary" || !item.forwardId) continue;
          writes.orchestration += 1;
          inbox.set(item.inboxItemId, { ...item, state: "suppressed", reason, updatedAt: now });
          affected.push(item.inboxItemId);
        }
        return affected;
      },
      getInputSubmission: (inputId) => inputs.get(inputId),
      getTurn: (turnId) => turns.get(turnId),
      listTurns: (sessionId) => [...turns.values()].filter((turn) => turn.sessionId === sessionId),
      createControlAudit(control) { writes.orchestration += 1; insert(controls, control.sessionControlAuditId, control); },
      getControlAudit: (controlId) => controls.get(controlId),
      findControlByIdempotencyKey: (taskId, runId, key) => [...controls.values()]
        .find((control) => control.taskId === taskId && control.runId === runId && control.idempotencyKey === key),
      listControlAudits: (runId, sessionId) => [...controls.values()]
        .filter((control) => control.runId === runId && (!sessionId || control.sessionId === sessionId)),
      hasBlockingAttention: () => false,
    },
    humanIntervention: {
      create(intervention) { writes.human += 1; insert(interventions, intervention.humanInterventionId, intervention); },
      get: (interventionId) => interventions.get(interventionId),
      findByIdempotencyKey: (taskId, runId, key) => [...interventions.values()]
        .find((item) => item.taskId === taskId && item.runId === runId && item.idempotencyKey === key),
      list: (runId, sessionId) => [...interventions.values()]
        .filter((item) => item.runId === runId && (!sessionId || item.targetSessionId === sessionId)),
    },
    commandReceipts: {
      createCommandReceipt(receipt) {
        writes.commandReceipt += 1;
        insert(commandReceipts, receipt.idempotencyKey, receipt);
      },
      findCommandReceipt: (taskId, runId, key) => {
        const receipt = commandReceipts.get(key);
        return receipt?.taskId === taskId && receipt.runId === runId ? receipt : undefined;
      },
      createUiCommandReceipt(receipt) { writes.uiReceipt += 1; insert(uiReceipts, receipt.commandId, receipt); },
      getUiCommandReceipt: (taskId, commandId) => {
        const receipt = uiReceipts.get(commandId);
        return receipt?.taskId === taskId ? receipt : undefined;
      },
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
    run<T>(work: (owners: SessionIdAcpOrchestrationCommandCapabilities) => T): T {
      const before = snapshotMaps({
        slots, generations, messages, relayBlocks, forwards, inbox, inputs, turns, controls,
        interventions, commandReceipts, uiReceipts, runtimes, attempts, providerIntents,
      });
      const beforeWrites = { ...writes };
      try {
        return work(capabilities);
      } catch (error) {
        restoreMaps(before, {
          slots, generations, messages, relayBlocks, forwards, inbox, inputs, turns, controls,
          interventions, commandReceipts, uiReceipts, runtimes, attempts, providerIntents,
        });
        Object.assign(writes, beforeWrites);
        throw error;
      }
    },
  };

  const stageInterrupt = vi.fn(({ sessionControlAuditId }: { sessionControlAuditId: string }) => {
    const control = controls.get(sessionControlAuditId);
    if (!control || control.state !== "requested") throw new Error("bridge_control_not_atomic");
    const existing = [...providerIntents.values()].find((intent) =>
      intent.sessionControlAuditId === sessionControlAuditId);
    if (existing) return drainable(existing, "replay");
    const intent = providerIntent("provider_effect_command_interrupt_1", sessionControlAuditId);
    providerIntents.set(intent.providerEffectIntentId, intent);
    writes.providerEffect += 1;
    if (failInterruptStage) throw new Error("controlled_interrupt_stage_failure");
    return drainable(intent, "staged");
  });

  const application = createSessionIdAcpOrchestrationCommandApplication({
    now: () => NOW,
    createId(kind) {
      id += 1;
      if (kind === "logical_session") return WORKER_SESSION_ID;
      return `${kind}_command_${id}`;
    },
    task: {
      taskId: TASK_ID,
      runId: RUN_ID,
      conductorSessionId: CONDUCTOR_SESSION_ID,
      initialConductorSessionTurnId: CONDUCTOR_TURN_ID,
      agentCards: [{
        agentCardId: CARD_ID,
        executionProfileId: PROFILE_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        providerFamily: "opencode",
      }],
    },
    transaction,
    resolveFrozenProfile(scope) {
      profileResolutions.push(structuredClone(scope));
      const generation = generations.get(scope.logicalSessionId);
      if (!generation || generation.executionProfileId !== scope.executionProfileId) return undefined;
      return {
        schemaVersion: 3,
        executionProfileId: PROFILE_ID,
        profileRevisionId: PROFILE_REVISION_ID,
        providerFamily: "opencode",
      };
    },
    interruptBridge: { stageInterrupt },
  });

  return {
    application,
    slots,
    generations,
    messages,
    forwards,
    inbox,
    inputs,
    turns,
    controls,
    interventions,
    commandReceipts,
    providerIntents,
    profileResolutions,
    stageInterrupt,
    ownerCounts: () => ({ ...writes }),
    snapshot: () => snapshotMaps({
      slots, generations, messages, forwards, inbox, inputs, turns, controls, interventions,
      commandReceipts, uiReceipts, runtimes, attempts, providerIntents,
    }),
    get failInterruptStage() { return failInterruptStage; },
    set failInterruptStage(value: boolean) { failInterruptStage = value; },
  };
}

function conductorScope(stem: string) {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedRevision: 7,
    conductorSessionId: CONDUCTOR_SESSION_ID,
    conductorSessionTurnId: CONDUCTOR_TURN_ID,
    commandId: `command_command_${stem}`,
    idempotencyKey: `command:${stem}`,
  };
}

function slotRecord(materialized: boolean): CardSessionSlotRecord {
  return {
    cardSessionSlotId: SLOT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: CARD_ID,
    ...(materialized ? { currentSessionId: WORKER_SESSION_ID } : {}),
    latestGeneration: materialized ? 1 : 0,
    revision: materialized ? 2 : 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function generationRecord(): CardSessionGenerationRecord {
  return {
    sessionId: WORKER_SESSION_ID,
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

function messageRecord(messageId: string, content: string): SessionIdSessionMessageRecord {
  return {
    messageId,
    taskId: TASK_ID,
    runId: RUN_ID,
    kind: "conductor_forward",
    content,
    canonicalContent: [{ kind: "text", text: content }],
    contentDigest: hashDefinition(content),
    createdAt: NOW,
  };
}

function forwardRecord(overrides: Partial<{
  forwardId: string;
  renderedMessageId: string;
  targetSessionId: string;
}> = {}): SessionIdMessageForwardRecord {
  return {
    forwardId: overrides.forwardId ?? "message_forward_command_active",
    taskId: TASK_ID,
    runId: RUN_ID,
    commandId: "command_command_active",
    idempotencyKey: "command:active",
    decidedBySessionTurnId: CONDUCTOR_TURN_ID,
    targetSessionId: overrides.targetSessionId ?? WORKER_SESSION_ID,
    orderedReferenceSnapshots: [],
    renderedMessageId: overrides.renderedMessageId ?? "message_command_active",
    createdAt: NOW,
  };
}

function inboxRecord(overrides: Partial<{
  inboxItemId: string;
  sessionId: string;
  renderedMessageId: string;
  sequence: number;
  state: "pending" | "held_by_human_intervention" | "leased" | "handed" | "handled" | "ambiguous" | "suppressed";
  forwardId: string;
}> = {}): SessionLaneItemRecord {
  return {
    inboxItemId: overrides.inboxItemId ?? "inbox_command_active",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: overrides.sessionId ?? WORKER_SESSION_ID,
    renderedMessageId: overrides.renderedMessageId ?? "message_command_active",
    sequence: overrides.sequence ?? 1,
    priority: "ordinary" as const,
    state: overrides.state ?? "handed",
    ...(overrides.forwardId ? { forwardId: overrides.forwardId } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedActiveWorkerDelivery(maps: Readonly<{
  messages: Map<string, SessionIdSessionMessageRecord>;
  forwards: Map<string, SessionIdMessageForwardRecord>;
  inbox: Map<string, SessionLaneItemRecord>;
  inputs: Map<string, SessionIdInputSubmissionRecord>;
  turns: Map<string, SessionIdSessionTurnRecord>;
}>): void {
  const message = messageRecord("message_command_active", "Active delivery");
  const forward = forwardRecord();
  const lane = inboxRecord({ forwardId: forward.forwardId });
  maps.messages.set(message.messageId, message);
  maps.forwards.set(forward.forwardId, forward);
  maps.inbox.set(lane.inboxItemId, lane);
  maps.inputs.set("input_command_worker", {
    inputSubmissionId: "input_command_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_SESSION_ID,
    sourceInboxItemId: lane.inboxItemId,
    contentMessageId: message.messageId,
    commandId: forward.commandId,
    idempotencyKey: "input:command-worker",
    sequence: 1,
    state: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
  });
  maps.turns.set("session_turn_command_worker", {
    sessionTurnId: "session_turn_command_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: WORKER_SESSION_ID,
    inputSubmissionId: "input_command_worker",
    sourceConductorSessionTurnId: CONDUCTOR_TURN_ID,
    trigger: "conductor_send",
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function attemptRecord(unresolvedInteraction = false): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_command_worker",
    sessionExecutionRuntimeId: "session_execution_runtime_command_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    bindingId: "binding_command_worker",
    bindingRevision: 1,
    executionProfileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    inputSubmissionId: "input_command_worker",
    orchestrationSessionTurnId: "session_turn_command_worker",
    state: unresolvedInteraction ? "waiting_for_interaction" : "active",
    interactions: unresolvedInteraction ? [{
      interactionId: "interaction_command_worker",
      promptDigest: hashDefinition("permission"),
      choices: [{ choiceId: "choice_command_allow", label: "Allow" }],
      status: "requested",
      revision: 1,
      requestedAt: NOW,
    }] : [],
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function providerIntent(
  providerEffectIntentId: string,
  sessionControlAuditId: string,
): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId,
    commandId: "command_command_interrupt_effect",
    idempotencyKey: `interrupt:${sessionControlAuditId}`,
    commandType: "session_runtime.request_interrupt",
    commandFingerprint: hashDefinition({ sessionControlAuditId }),
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: WORKER_SESSION_ID,
    sessionExecutionRuntimeId: "session_execution_runtime_command_worker",
    sessionExecutionAttemptId: "session_execution_attempt_command_worker",
    inputSubmissionId: "input_command_worker",
    orchestrationSessionTurnId: "session_turn_command_worker",
    bindingId: "binding_command_worker",
    bindingRevision: 1,
    executionProfileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    sessionControlAuditId,
    effect: {
      kind: "request_interrupt",
      bindingHandle: "binding_handle_command_worker",
      sessionExecutionAttemptId: "session_execution_attempt_command_worker",
      sessionControlAuditId,
    },
    state: "pending",
    createdAt: NOW,
  };
}

function drainable(
  intent: SessionRuntimeProviderEffectIntentRecord,
  disposition: "staged" | "replay",
) {
  return {
    disposition,
    commandType: intent.commandType,
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
  } as const;
}

function insert<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) throw new Error("controlled_duplicate_write");
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

function withoutReceipts(snapshot: ReturnType<typeof snapshotMaps>) {
  const { commandReceipts: _commandReceipts, uiReceipts: _uiReceipts, ...rest } = snapshot;
  return rest;
}
