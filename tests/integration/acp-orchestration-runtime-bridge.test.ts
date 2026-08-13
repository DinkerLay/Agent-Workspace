import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
} from "@agent-workspace/runtime-contracts";
import {
  createSessionExecutionRuntimeOwner,
  createSessionExecutionSettlementCoordinator,
  createSessionIdAcpOrchestrationBridge,
} from "@agent-workspace/runtime-application";
import type {
  AcpSessionRuntimeOwnerRepositories,
  AcpSessionRuntimeRepositories,
} from "@agent-workspace/runtime-store";
import {
  InMemorySessionExecutionCanonicalSettlementCommitter,
  InMemorySessionExecutionRepository,
} from "@agent-workspace/test-kit";
import {
  createAcpTaskSessionRuntimeProvider,
  type AcpTaskSessionRuntimeNativeBinding,
} from "../../apps/runtime-host/src/acp-task-session-runtime-provider.js";

const NOW = "2026-08-12T00:00:00.000Z";
const CONTENT = "Execute through the provider-neutral ACP seam.";
const FINAL = "One canonical ACP final.";
const RECEIPT = `sha256:${"a".repeat(64)}`;

describe("ACP OR -> SR application integration", () => {
  it("drains the exact v3 intent ID and commits one canonical final across replay", async () => {
    const records = new InMemorySessionExecutionRepository();
    const binding = bindingRecord();
    const repositories = createOwnerRepositories(records, binding);
    const owner = createSessionExecutionRuntimeOwner({
      repository: records,
      commandTransaction: records,
      now: monotonicNow(),
      createRuntimeId: () => "session_execution_runtime_worker-1",
      createAttemptId: () => "session_execution_attempt_worker-1",
      createProviderEffectIntentId: () => "provider_effect_worker-1",
    });
    const recordAgentFinal = vi.fn(() => Object.freeze({
      status: "recorded" as const,
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    }));
    const committer = new InMemorySessionExecutionCanonicalSettlementCommitter({
      now: () => NOW,
      createMessageId: () => "message_final-1",
      recordAgentFinal,
    });
    const settlementCoordinator = createSessionExecutionSettlementCoordinator({ committer });
    const input = Object.freeze({
      inputSubmissionId: "input_worker-1",
      taskId: "task_1",
      runId: "run_1",
      sessionId: "logical_session_worker-1",
      sourceInboxItemId: "inbox_worker-1",
      contentMessageId: "message_worker-1",
      commandId: "command_or-worker-1",
      idempotencyKey: "or-input:worker-1",
      sequence: 1,
      state: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const turn = Object.freeze({
      sessionTurnId: "session_turn_worker-1",
      taskId: input.taskId,
      runId: input.runId,
      sessionId: input.sessionId,
      inputSubmissionId: input.inputSubmissionId,
      sourceConductorSessionTurnId: "session_turn_conductor-1",
      trigger: "conductor_send" as const,
      state: "pending" as const,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const message = Object.freeze({
      messageId: input.contentMessageId,
      taskId: input.taskId,
      runId: input.runId,
      sourceSessionId: "logical_session_conductor-1",
      sourceSessionTurnId: "session_turn_conductor-1",
      kind: "conductor_forward" as const,
      content: CONTENT,
      canonicalContent: Object.freeze([{ kind: "text" as const, text: CONTENT }]),
      contentDigest: hashDefinition(CONTENT),
      createdAt: NOW,
    });
    const bridge = createSessionIdAcpOrchestrationBridge({
      orchestrationRead: {
        getInputSubmission: (id) => id === input.inputSubmissionId ? input : undefined,
        findTurnByInputSubmission: (id) => id === input.inputSubmissionId ? turn : undefined,
        getControlAudit: () => undefined,
      },
      messageRead: { getMessage: (id) => id === message.messageId ? message : undefined },
      taskRunRead: {
        getGeneration: (id) => id === input.sessionId ? Object.freeze({
          sessionId: input.sessionId,
          cardSessionSlotId: "card_session_slot_worker",
          taskId: input.taskId,
          runId: input.runId,
          agentCardId: binding.agentCardId,
          executionProfileId: binding.executionProfileId,
          generation: 1,
          lifecycle: "current" as const,
          createdAt: NOW,
        }) : undefined,
        getSlot: (id) => id === "card_session_slot_worker" ? Object.freeze({
          cardSessionSlotId: id,
          taskId: input.taskId,
          runId: input.runId,
          agentCardId: binding.agentCardId,
          currentSessionId: input.sessionId,
          latestGeneration: 1,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }) : undefined,
        getConductorSessionId: () => "logical_session_conductor-1",
        readTaskRunState: () => ({ taskId: input.taskId, runId: input.runId, runStatus: "running" }),
      },
      currentBindingRead: repositories.binding,
      resolveFrozenProfileTuple: () => PROFILE,
      providerEffectRead: {
        findByIdempotencyKey: ({ taskId, runId, commandType, idempotencyKey }) =>
          records.snapshot().providerEffects.find((intent) =>
            intent.taskId === taskId
              && intent.runId === runId
              && intent.commandType === commandType
              && intent.idempotencyKey === idempotencyKey),
      },
      sessionRuntimeOwner: owner,
      settlementCoordinator,
    });
    const native = fakeNativeBinding();
    const provider = createAcpTaskSessionRuntimeProvider({
      repositories,
      sessionRuntimeOwner: owner,
      resolveFrozenProfileTuple: () => PROFILE,
      resolveInterruptCorrelation: () => undefined,
      onDeliveryReceipt: async () => undefined,
      openNativeBinding: async () => native,
      effectDeadlineMs: 1_000,
    });

    const staged = bridge.stageDelivery({ inputSubmissionId: input.inputSubmissionId });
    expect(repositories.reliability.getProviderEffectIntent(staged.providerEffectIntentId))
      .toMatchObject({ providerEffectIntentId: "provider_effect_worker-1", state: "pending" });
    const first = await provider.executeProviderEffect(staged.providerEffectIntentId);
    expect(first).toMatchObject({
      disposition: "settled",
      providerEffectIntentId: staged.providerEffectIntentId,
      sessionExecutionAttemptId: staged.sessionExecutionAttemptId,
      replayed: false,
      settlement: { finalContent: FINAL },
    });
    if (first.disposition !== "settled") throw new Error("expected controlled ACP settlement");
    committer.seedBinding(binding);
    committer.setCurrentBinding(binding.logicalSessionId, binding.bindingId);
    committer.seedAttempt(records.getAttempt(first.sessionExecutionAttemptId)!);
    expect(bridge.acceptSettlement(first.settlement)).toEqual({
      status: "recorded",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });

    const replayStage = bridge.stageDelivery({ inputSubmissionId: input.inputSubmissionId });
    expect(replayStage).toEqual({ ...staged, disposition: "replay" });
    const replay = await provider.executeProviderEffect(replayStage.providerEffectIntentId);
    expect(replay).toMatchObject({ disposition: "settled", replayed: true });
    if (replay.disposition !== "settled") throw new Error("expected controlled ACP settlement replay");
    expect(bridge.acceptSettlement(replay.settlement)).toMatchObject({ status: "replayed" });
    expect(native.submitDelivery).toHaveBeenCalledTimes(1);
    expect(recordAgentFinal).toHaveBeenCalledTimes(1);
    expect(records.snapshot().providerEffects).toHaveLength(1);

    await provider.close();
  });
});

const PROFILE = Object.freeze({
  schemaVersion: 3 as const,
  executionProfileId: "profile_worker",
  profileRevisionId: "profile_revision_worker-1",
  providerFamily: "opencode" as const,
});

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return Object.freeze({
    schemaVersion: 3,
    bindingId: "binding_worker-1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    agentCardId: "agent_card_worker",
    executionProfileId: PROFILE.executionProfileId,
    profileRevisionId: PROFILE.profileRevisionId,
    providerFamily: PROFILE.providerFamily,
    bindingHandle: "binding_handle_worker-1",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function createOwnerRepositories(
  records: InMemorySessionExecutionRepository,
  currentBinding: AcpSafeSessionBindingRecordV3,
): AcpSessionRuntimeRepositories {
  const owners: AcpSessionRuntimeOwnerRepositories = {
    binding: {
      createBinding: () => { throw new Error("unexpected binding write"); },
      getBinding: (bindingId) => bindingId === currentBinding.bindingId ? currentBinding : undefined,
      getCurrentBinding: (logicalSessionId) => logicalSessionId === currentBinding.logicalSessionId
        ? currentBinding
        : undefined,
      listBindings: (logicalSessionId) => logicalSessionId === currentBinding.logicalSessionId
        ? Object.freeze([currentBinding])
        : Object.freeze([]),
      listBindingsForRun: (taskId, runId) => taskId === currentBinding.taskId && runId === currentBinding.runId
        ? Object.freeze([currentBinding])
        : Object.freeze([]),
      updateBinding: () => { throw new Error("unexpected binding write"); },
    },
    sessionRuntime: {
      createRuntime: (runtime) => records.insertRuntime(runtime),
      getRuntime: (id) => records.getRuntime(id),
      getRuntimeForSession: (id) => records.findRuntimeByLogicalSessionId(id),
      updateRuntime: (runtime, revision) => records.updateRuntime(runtime, revision),
      createAttempt: (attempt) => records.insertAttempt(attempt),
      getAttempt: (id) => records.getAttempt(id),
      listAttempts: (runtimeId) => records.snapshot().attempts
        .filter((attempt) => attempt.sessionExecutionRuntimeId === runtimeId),
      updateAttempt: (attempt, revision) => records.updateAttempt(attempt, revision),
    },
    reliability: {
      createProviderEffectIntent(intent) {
        records.insert(intent);
        return intent;
      },
      getProviderEffectIntent: (id) => records.snapshot().providerEffects
        .find((intent) => intent.providerEffectIntentId === id),
      listProviderEffectIntents: (attemptId) => records.snapshot().providerEffects
        .filter((intent) => attemptId === undefined || intent.sessionExecutionAttemptId === attemptId),
      suppressUnhandedProviderEffectIntents: () => Object.freeze([]),
      createBindingRetirementIntent: () => { throw new Error("unexpected retirement write"); },
      getBindingRetirementIntent: () => undefined,
      findBindingRetirementIntentByIdempotencyKey: () => undefined,
      listBindingRetirementIntents: () => Object.freeze([]),
      claimBindingRetirementIntent: () => { throw new Error("unexpected retirement claim"); },
      settleBindingRetirementReleased: () => { throw new Error("unexpected retirement settlement"); },
      settleBindingRetirementUnknown: () => { throw new Error("unexpected retirement settlement"); },
    },
    directDrain: {
      inventory: emptyDrainInventory,
      assertDrained: emptyDrainInventory,
      sealDrainedForCutover: emptyDrainInventory,
    },
  };
  return Object.freeze({
    ...owners,
    transaction: <T>(work: (capabilities: AcpSessionRuntimeOwnerRepositories) => T): T => work(owners),
  });
}

function fakeNativeBinding(): AcpTaskSessionRuntimeNativeBinding {
  const submitDelivery = vi.fn(async (
    { sessionExecutionAttemptId }: Parameters<AcpTaskSessionRuntimeNativeBinding["submitDelivery"]>[0],
  ) => Object.freeze({
    status: "settled" as const,
    bindingHandle: "binding_handle_worker-1",
    sessionExecutionAttemptId,
    receiptDigest: RECEIPT,
    finalCandidate: Object.freeze({
      candidateObservationId: "provider_fact_candidate-1",
      content: FINAL,
      contentDigest: hashDefinition(FINAL),
    }),
    terminal: Object.freeze({
      terminalObservationId: "provider_fact_terminal-1",
      outcome: "completed" as const,
      receiptDigest: RECEIPT,
    }),
  }));
  const native: AcpTaskSessionRuntimeNativeBinding = Object.freeze({
    bindingHandle: "binding_handle_worker-1",
    submitDelivery,
    reconcileAttempt: async (
      { sessionExecutionAttemptId }: Parameters<AcpTaskSessionRuntimeNativeBinding["reconcileAttempt"]>[0],
    ) => Object.freeze({
      status: "reconciling" as const,
      bindingHandle: "binding_handle_worker-1",
      sessionExecutionAttemptId,
      reason: "provider_outcome_unknown" as const,
    }),
    retire: async () => undefined,
    close: async () => undefined,
  });
  return native;
}

function emptyDrainInventory() {
  return Object.freeze({
    total: 0,
    safe: 0,
    blocking: 0,
    bindings: Object.freeze([]),
    historicalUninspectedProtocolTables: Object.freeze([]),
  });
}

function monotonicNow(): () => string {
  let tick = 0;
  return () => new Date(Date.parse(NOW) + tick++).toISOString();
}
