import { describe, expect, it } from "vitest";
import {
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionLaneItemRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdCommandReceiptRecord,
  SessionIdHumanInterventionRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpCloseSessionOwner,
  type SessionIdAcpCloseSessionCapabilities,
} from "./session-id-acp-close-session-owner.js";

const NOW = "2026-08-12T19:00:00.000Z";
const TASK_ID = "task_close_owner";
const RUN_ID = "run_close_owner";
const CONDUCTOR_ID = "logical_session_close_conductor";
const CONDUCTOR_TURN_ID = "session_turn_close_conductor";
const SESSION_ID = "logical_session_close_worker";
const SLOT_ID = "card_session_slot_close_worker";
const BINDING_ID = "binding_close_worker";

describe("Session-ID ACP close-session owner", () => {
  it("stages a close Control and exact Binding retirement before generation retirement", () => {
    const fixture = createFixture();
    const command = closeCommand();
    const staged = fixture.owner.stageClose(command);

    expect(staged).toEqual({
      disposition: "retirement_required",
      sessionControlAuditId: "session_control_close_1",
      bindingRetirementIntentId: "binding_retirement_close_1",
    });
    expect(fixture.controls.get("session_control_close_1")).toMatchObject({
      kind: "close",
      state: "requested",
      sessionId: SESSION_ID,
    });
    expect(fixture.retirements.get("binding_retirement_close_1")).toMatchObject({
      logicalSessionId: SESSION_ID,
      bindingId: BINDING_ID,
      bindingRevision: 1,
      sessionControlAuditId: "session_control_close_1",
      state: "pending",
    });
    expect(fixture.inbox.get("inbox_close_pending")).toMatchObject({
      state: "suppressed",
      reason: "session_closed",
    });
    expect(fixture.generations.get(SESSION_ID)).toMatchObject({ lifecycle: "current" });
    expect(fixture.slots.get(SLOT_ID)?.currentSessionId).toBe(SESSION_ID);
    expect(fixture.commandReceipts.size).toBe(0);
    expect(fixture.owner.stageClose(command)).toEqual(staged);
    expect(fixture.retirements.size).toBe(1);
  });

  it("returns closed only after released retirement and atomically retires the exact generation", () => {
    const fixture = createFixture();
    const command = closeCommand();
    const staged = fixture.owner.stageClose(command);
    if (staged.disposition !== "retirement_required") throw new Error("expected retirement stage");

    expect(() => fixture.owner.completeClose({
      command,
      bindingRetirementIntentId: staged.bindingRetirementIntentId,
    })).toThrow("session_close_binding_retirement_not_released");
    expect(fixture.generations.get(SESSION_ID)?.lifecycle).toBe("current");

    fixture.releaseRetirement(staged.bindingRetirementIntentId);
    expect(fixture.owner.completeClose({
      command,
      bindingRetirementIntentId: staged.bindingRetirementIntentId,
    })).toEqual({ status: "closed" });
    expect(fixture.controls.get(staged.sessionControlAuditId)).toMatchObject({
      state: "closed",
      settledAt: NOW,
    });
    expect(fixture.generations.get(SESSION_ID)).toMatchObject({ lifecycle: "closed", closedAt: NOW });
    expect(fixture.slots.get(SLOT_ID)).toMatchObject({ currentSessionId: undefined, latestGeneration: 1 });
    expect(fixture.commandReceipts.get(closeCommand().idempotencyKey)?.result).toEqual({ status: "closed" });
    expect(fixture.owner.stageClose(command)).toEqual({ disposition: "closed", result: { status: "closed" } });
  });

  it("fails completion closed when the current generation fence drifts after retirement release", () => {
    const fixture = createFixture();
    const command = closeCommand();
    const staged = fixture.owner.stageClose(command);
    if (staged.disposition !== "retirement_required") throw new Error("expected retirement stage");
    fixture.releaseRetirement(staged.bindingRetirementIntentId);
    fixture.slots.set(SLOT_ID, {
      ...fixture.slots.get(SLOT_ID)!,
      latestGeneration: 2,
      revision: 3,
    });

    expect(() => fixture.owner.completeClose({
      command,
      bindingRetirementIntentId: staged.bindingRetirementIntentId,
    })).toThrow("orchestration_session_not_current");
    expect(fixture.generations.get(SESSION_ID)?.lifecycle).toBe("current");
    expect(fixture.controls.get(staged.sessionControlAuditId)?.state).toBe("requested");
    expect(fixture.commandReceipts.size).toBe(0);
  });

  it("closes an unbound generation in one transaction without inventing a retirement", () => {
    const fixture = createFixture({ binding: false });
    expect(fixture.owner.stageClose(closeCommand())).toEqual({
      disposition: "closed",
      result: { status: "closed" },
    });
    expect(fixture.retirements.size).toBe(0);
    expect(fixture.generations.get(SESSION_ID)?.lifecycle).toBe("closed");
    expect([...fixture.controls.values()]).toEqual([
      expect.objectContaining({ kind: "close", state: "closed" }),
    ]);
  });

  it("replays only the exact pending command and rejects cross-command close with zero owner drift", () => {
    const fixture = createFixture();
    const first = fixture.owner.stageClose(closeCommand());
    const before = fixture.snapshot();
    expect(fixture.owner.stageClose({
      ...closeCommand(),
      commandId: "command_close_other",
      idempotencyKey: "close:other",
    })).toEqual({
      disposition: "rejected",
      result: { status: "rejected", reason: "session_close_control_unresolved" },
    });
    expect(fixture.snapshotOwners()).toEqual(before.owners);
    expect(fixture.owner.stageClose(closeCommand())).toEqual(first);
  });

  it("does not let a conflicting payload reuse poison the pending command idempotency fence", () => {
    const fixture = createFixture();
    const command = closeCommand();
    const first = fixture.owner.stageClose(command);
    expect(() => fixture.owner.stageClose({
      ...command,
      commandId: "command_close_conflicting_payload",
      sessionId: "logical_session_close_other",
    })).toThrow("orchestration_idempotency_payload_conflict");

    expect(fixture.commandReceipts.size).toBe(0);
    expect(fixture.owner.stageClose(command)).toEqual(first);
  });

  it("replays the exact pending close before re-evaluating its original Conductor turn", () => {
    const fixture = createFixture();
    const command = closeCommand();
    const first = fixture.owner.stageClose(command);
    fixture.turns.set(CONDUCTOR_TURN_ID, conductorTurnRecord("completed"));

    expect(fixture.owner.stageClose(command)).toEqual(first);
    expect(fixture.retirements.size).toBe(1);
    expect(fixture.commandReceipts.size).toBe(0);
  });

  it("rolls back Control and suppression when retirement staging fails", () => {
    const fixture = createFixture();
    fixture.failRetirementCreate = true;
    const before = fixture.snapshotOwners();
    expect(() => fixture.owner.stageClose(closeCommand())).toThrow("controlled_retirement_create_failure");
    expect(fixture.snapshotOwners()).toEqual(before);
  });

  it.each([
    ["active Turn", { activeTurn: true }],
    ["reconciling runtime", { runtimeState: "reconciling" as const }],
    ["requested Interaction", { requestedInteraction: true }],
    ["recovering Binding", { bindingStatus: "recovering" as const }],
    ["held human", { heldHuman: true }],
  ])("rejects %s before any close intent", (_label, options) => {
    const fixture = createFixture(options);
    const result = fixture.owner.stageClose(closeCommand());
    expect(result.disposition).toBe("rejected");
    expect(fixture.retirements.size).toBe(0);
    expect([...fixture.controls.values()].filter((control) => control.kind === "close")).toEqual([]);
    expect(fixture.generations.get(SESSION_ID)?.lifecycle).toBe("current");
  });
});

function createFixture(options: Readonly<{
  binding?: boolean;
  bindingStatus?: "active" | "recovering";
  activeTurn?: boolean;
  runtimeState?: "idle" | "reconciling";
  requestedInteraction?: boolean;
  heldHuman?: boolean;
  conductorTurnState?: "active" | "completed";
}> = {}) {
  const slots = new Map<string, CardSessionSlotRecord>([[SLOT_ID, slotRecord()]]);
  const generations = new Map<string, CardSessionGenerationRecord>([[SESSION_ID, generationRecord()]]);
  const controls = new Map<string, SessionControlAuditRecord>();
  const inbox = new Map<string, SessionLaneItemRecord>([["inbox_close_pending", inboxRecord()]]);
  const turns = new Map<string, SessionIdSessionTurnRecord>();
  turns.set(CONDUCTOR_TURN_ID, conductorTurnRecord(options.conductorTurnState));
  if (options.activeTurn) turns.set("session_turn_close_active", turnRecord());
  const interventions = new Map<string, SessionIdHumanInterventionRecord>();
  if (options.heldHuman) interventions.set("human_intervention_close_held", humanRecord());
  let binding = options.binding === false ? undefined : bindingRecord(options.bindingStatus);
  const runtime = runtimeRecord(options.runtimeState, options.requestedInteraction);
  const attempt = options.requestedInteraction ? attemptRecord() : undefined;
  const retirements = new Map<string, AcpV3BindingRetirementIntentRecord>();
  const commandReceipts = new Map<string, SessionIdCommandReceiptRecord>();
  let failRetirementCreate = false;
  let id = 0;

  const capabilities: SessionIdAcpCloseSessionCapabilities = {
    taskRun: {
      getSlot: (slotId) => slots.get(slotId),
      getGeneration: (logicalSessionId) => generations.get(logicalSessionId),
      retireGeneration(nextSlot, nextGeneration, expectedRevision) {
        const current = slots.get(nextSlot.cardSessionSlotId);
        if (!current || current.revision !== expectedRevision) throw new Error("slot revision conflict");
        slots.set(nextSlot.cardSessionSlotId, structuredClone(nextSlot));
        generations.set(nextGeneration.sessionId, structuredClone(nextGeneration));
      },
      readTaskRunState: () => ({
        taskId: TASK_ID,
        runId: RUN_ID,
        taskRevision: 7,
        runStatus: "running",
        currentConductorSessionTurnId: CONDUCTOR_TURN_ID,
      }),
      getConductorSessionId: () => CONDUCTOR_ID,
      latestPlanningFence: () => undefined,
    },
    orchestration: {
      getTurn: (sessionTurnId) => turns.get(sessionTurnId),
      listInboxItems: (logicalSessionId) => [...inbox.values()].filter((item) => item.sessionId === logicalSessionId),
      suppressPendingOrdinary(logicalSessionId, reason, now) {
        const ids: string[] = [];
        for (const item of inbox.values()) {
          if (item.sessionId !== logicalSessionId || item.state !== "pending" || item.priority !== "ordinary") continue;
          inbox.set(item.inboxItemId, { ...item, state: "suppressed", reason, updatedAt: now });
          ids.push(item.inboxItemId);
        }
        return ids;
      },
      listTurns: (logicalSessionId) => [...turns.values()].filter((turn) => turn.sessionId === logicalSessionId),
      createControlAudit(control) {
        if (controls.has(control.sessionControlAuditId)) throw new Error("control conflict");
        controls.set(control.sessionControlAuditId, structuredClone(control));
      },
      getControlAudit: (controlId) => controls.get(controlId),
      findControlByIdempotencyKey: (taskId, runId, key) => [...controls.values()].find((control) =>
        control.taskId === taskId && control.runId === runId && control.idempotencyKey === key),
      listControlAudits: (runId, logicalSessionId) => [...controls.values()].filter((control) =>
        control.runId === runId && (!logicalSessionId || control.sessionId === logicalSessionId)),
      updateControlAudit(control, expectedState) {
        const current = controls.get(control.sessionControlAuditId);
        if (!current || current.state !== expectedState) throw new Error("control state conflict");
        controls.set(control.sessionControlAuditId, structuredClone(control));
      },
    },
    humanIntervention: {
      list: (runId, logicalSessionId) => [...interventions.values()].filter((item) =>
        item.runId === runId && (!logicalSessionId || item.targetSessionId === logicalSessionId)),
    },
    currentBinding: {
      getBinding: (bindingId) => binding?.bindingId === bindingId ? binding : undefined,
      getCurrentBinding: (logicalSessionId) => binding?.logicalSessionId === logicalSessionId
        && (binding.status === "active" || binding.status === "recovering") ? binding : undefined,
    },
    sessionExecution: {
      getRuntimeForSession: (logicalSessionId) => logicalSessionId === SESSION_ID ? runtime : undefined,
      getAttempt: (attemptId) => attempt?.sessionExecutionAttemptId === attemptId ? attempt : undefined,
      listAttempts: () => attempt ? [attempt] : [],
    },
    reliability: {
      createBindingRetirementIntent(intent) {
        if (failRetirementCreate) throw new Error("controlled_retirement_create_failure");
        if (retirements.has(intent.bindingRetirementIntentId)) throw new Error("retirement conflict");
        retirements.set(intent.bindingRetirementIntentId, structuredClone(intent));
        return intent;
      },
      getBindingRetirementIntent: (intentId) => retirements.get(intentId),
      findBindingRetirementIntentByIdempotencyKey: ({ taskId, runId, bindingId, idempotencyKey }) =>
        [...retirements.values()].find((intent) => intent.taskId === taskId && intent.runId === runId
          && intent.bindingId === bindingId && intent.idempotencyKey === idempotencyKey),
      listBindingRetirementIntents: (logicalSessionId) => [...retirements.values()].filter((intent) =>
        !logicalSessionId || intent.logicalSessionId === logicalSessionId),
    },
    commandReceipts: {
      createCommandReceipt(receipt) {
        if (commandReceipts.has(receipt.idempotencyKey)) throw new Error("receipt conflict");
        commandReceipts.set(receipt.idempotencyKey, structuredClone(receipt));
      },
      findCommandReceipt: (taskId, runId, key) => {
        const receipt = commandReceipts.get(key);
        return receipt?.taskId === taskId && receipt.runId === runId ? receipt : undefined;
      },
    },
  };

  function snapshotOwners() {
    return structuredClone({
      slots: [...slots], generations: [...generations], controls: [...controls], inbox: [...inbox],
      retirements: [...retirements], binding,
    });
  }

  const transaction = {
    run<T>(work: (owners: SessionIdAcpCloseSessionCapabilities) => T): T {
      const before = structuredClone({
        slots: [...slots], generations: [...generations], controls: [...controls], inbox: [...inbox],
        retirements: [...retirements], commandReceipts: [...commandReceipts], binding,
      });
      try {
        return work(capabilities);
      } catch (error) {
        replace(slots, before.slots);
        replace(generations, before.generations);
        replace(controls, before.controls);
        replace(inbox, before.inbox);
        replace(retirements, before.retirements);
        replace(commandReceipts, before.commandReceipts);
        binding = before.binding;
        throw error;
      }
    },
  };
  const owner = createSessionIdAcpCloseSessionOwner({
    now: () => NOW,
    createId(kind) {
      id += 1;
      if (kind === "session_control") return "session_control_close_1";
      if (kind === "binding_retirement") return "binding_retirement_close_1";
      return `command_close_internal_${id}`;
    },
    task: {
      taskId: TASK_ID,
      runId: RUN_ID,
      conductorSessionId: CONDUCTOR_ID,
      agentCards: [{
        agentCardId: "agent_card_close_worker",
        executionProfileId: "profile_close_worker",
        profileRevisionId: "profile_revision_close_worker",
        providerFamily: "opencode",
      }],
    },
    transaction,
    resolveFrozenProfile: () => ({
      schemaVersion: 3,
      taskId: TASK_ID,
      runId: RUN_ID,
      architectureSnapshotId: "architecture_close_owner",
      logicalSessionId: SESSION_ID,
      agentCardId: "agent_card_close_worker",
      executionProfileId: "profile_close_worker",
      profileRevisionId: "profile_revision_close_worker",
      providerFamily: "opencode",
    }),
  });

  return {
    owner,
    slots,
    generations,
    controls,
    inbox,
    turns,
    retirements,
    commandReceipts,
    snapshotOwners,
    snapshot: () => ({ owners: snapshotOwners(), receipts: structuredClone([...commandReceipts]) }),
    get failRetirementCreate() { return failRetirementCreate; },
    set failRetirementCreate(value: boolean) { failRetirementCreate = value; },
    releaseRetirement(intentId: string) {
      const intent = retirements.get(intentId);
      if (!intent || !binding) throw new Error("retirement missing");
      binding = {
        ...binding,
        status: "released",
        recoverable: false,
        revision: binding.revision + 1,
        updatedAt: NOW,
      };
      retirements.set(intentId, {
        ...intent,
        state: "released",
        attempts: 1,
        revision: 3,
        updatedAt: NOW,
        releasedAt: NOW,
      });
    },
  };
}

function closeCommand() {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedRevision: 7,
    conductorSessionId: CONDUCTOR_ID,
    conductorSessionTurnId: CONDUCTOR_TURN_ID,
    commandId: "command_close_owner",
    idempotencyKey: "close:owner",
    sessionId: SESSION_ID,
  };
}

function slotRecord(): CardSessionSlotRecord {
  return {
    cardSessionSlotId: SLOT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_close_worker",
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
    cardSessionSlotId: SLOT_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_close_worker",
    executionProfileId: "profile_close_worker",
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
}

function bindingRecord(status: "active" | "recovering" = "active"): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: BINDING_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    agentCardId: "agent_card_close_worker",
    executionProfileId: "profile_close_worker",
    profileRevisionId: "profile_revision_close_worker",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_close_worker",
    status,
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeRecord(
  state: "idle" | "reconciling" = "idle",
  requestedInteraction = false,
): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_close_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    state: requestedInteraction ? "executing" : state,
    ...(requestedInteraction || state === "reconciling"
      ? { activeAttemptId: "session_execution_attempt_close_worker" }
      : {}),
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function attemptRecord(): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_close_worker",
    sessionExecutionRuntimeId: "session_execution_runtime_close_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: SESSION_ID,
    bindingId: BINDING_ID,
    bindingRevision: 1,
    executionProfileId: "profile_close_worker",
    profileRevisionId: "profile_revision_close_worker",
    inputSubmissionId: "input_close_worker",
    orchestrationSessionTurnId: "session_turn_close_worker",
    state: "waiting_for_interaction",
    receiptDigest: `sha256:${"a".repeat(64)}`,
    receiptObservedAt: NOW,
    interactions: [{
      interactionId: "interaction_close_worker",
      revision: 1,
      promptDigest: `sha256:${"b".repeat(64)}`,
      status: "requested",
      choices: [{ choiceId: "choice_close_worker", label: "Continue" }],
      requestedAt: NOW,
    }],
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function conductorTurnRecord(state: "active" | "completed" = "active"): SessionIdSessionTurnRecord {
  return {
    sessionTurnId: CONDUCTOR_TURN_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: CONDUCTOR_ID,
    inputSubmissionId: "input_close_conductor",
    trigger: "task_goal",
    state,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function turnRecord(): SessionIdSessionTurnRecord {
  return {
    sessionTurnId: "session_turn_close_active",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    inputSubmissionId: "input_close_active",
    sourceConductorSessionTurnId: CONDUCTOR_TURN_ID,
    trigger: "conductor_send",
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function humanRecord(): SessionIdHumanInterventionRecord {
  return {
    humanInterventionId: "human_intervention_close_held",
    taskId: TASK_ID,
    runId: RUN_ID,
    commandId: "command_close_human",
    idempotencyKey: "close:human",
    targetSessionId: SESSION_ID,
    mode: "direct_message",
    state: "held",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function inboxRecord(): SessionLaneItemRecord {
  return {
    inboxItemId: "inbox_close_pending",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    renderedMessageId: "message_close_pending",
    sequence: 1,
    priority: "ordinary",
    state: "pending",
    forwardId: "message_forward_close_pending",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function replace<K, V>(map: Map<K, V>, entries: readonly (readonly [K, V])[]): void {
  map.clear();
  for (const [key, value] of entries) map.set(key, value);
}
