import { describe, expect, it } from "vitest";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type SessionExecutionAttemptRecord,
} from "@agent-workspace/runtime-contracts";
import type { AgentFinalDraft } from "./session-id-orchestration-application";
import { InMemorySessionExecutionCanonicalSettlementCommitter } from "../../test-kit/src";
import { createSessionExecutionSettlementCoordinator } from "./session-execution-settlement-coordinator";

describe("SessionExecution settlement coordinator", () => {
  it("fences persisted SR/Binding state and delegates exactly once to canonical recordAgentFinal", () => {
    const canonicalCalls: AgentFinalDraft[] = [];
    const committer = createCommitter((draft) => {
      canonicalCalls.push(draft);
      return Object.freeze({
        status: "recorded" as const,
        messageId: draft.messageId,
        inboxItemId: "inbox_final-1",
      });
    });
    const attempt = completedAttempt();
    committer.seedBinding(bindingRecord());
    committer.setCurrentBinding(attempt.logicalSessionId, attempt.bindingId);
    committer.seedAttempt(attempt);
    const coordinator = createSessionExecutionSettlementCoordinator({ committer });

    const beforeForgedProfile = committer.snapshot();
    expect(() => coordinator.acceptSettlement({
      ...attempt.settlement!,
      profileRevisionId: "profile_revision_worker-2",
    })).toThrow(/attempt_settlement_mismatch|current_binding_mismatch/);
    expect(committer.snapshot()).toEqual(beforeForgedProfile);
    expect(canonicalCalls).toEqual([]);

    expect(coordinator.acceptSettlement(attempt.settlement!)).toEqual({
      status: "recorded",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });
    expect(coordinator.acceptSettlement(attempt.settlement!)).toEqual({
      status: "replayed",
      messageId: "message_final-1",
      inboxItemId: "inbox_final-1",
    });
    expect(canonicalCalls).toEqual([{
      runId: attempt.runId,
      sessionId: attempt.logicalSessionId,
      inputSubmissionId: attempt.inputSubmissionId,
      sessionTurnId: attempt.orchestrationSessionTurnId,
      messageId: "message_final-1",
      content: FINAL_CONTENT,
    }]);
    expect(committer.snapshot().settlementAcceptances).toHaveLength(1);
  });

  it("never calls canonical recordAgentFinal for stale A1, missing Attempt, or forged settlement", () => {
    const canonicalCalls: AgentFinalDraft[] = [];
    const committer = createCommitter((draft) => {
      canonicalCalls.push(draft);
      return Object.freeze({ status: "recorded" as const, messageId: draft.messageId, inboxItemId: "inbox_final-1" });
    });
    const attemptA1 = completedAttempt();
    committer.seedAttempt(attemptA1);
    committer.seedBinding({ ...bindingRecord(), status: "released", recoverable: false });
    committer.seedBinding({
      ...bindingRecord(),
      bindingId: "binding_2",
      bindingHandle: "binding_handle_worker-2",
      profileRevisionId: "profile_revision_worker-2",
      revision: 2,
    });
    committer.setCurrentBinding(attemptA1.logicalSessionId, "binding_2");
    const coordinator = createSessionExecutionSettlementCoordinator({ committer });
    const before = committer.snapshot();

    expect(() => coordinator.acceptSettlement(attemptA1.settlement!)).toThrow(/current_binding_mismatch/);
    expect(() => coordinator.acceptSettlement({
      ...attemptA1.settlement!,
      sessionExecutionAttemptId: "session_execution_attempt_missing",
    })).toThrow(/attempt_not_found/);
    expect(() => coordinator.acceptSettlement({
      ...attemptA1.settlement!,
      receiptDigest: "sha256:forged-receipt",
    })).toThrow(/attempt_settlement_mismatch|receipt_mismatch/);
    expect(committer.snapshot()).toEqual(before);
    expect(canonicalCalls).toEqual([]);
  });
});

const NOW = "2026-08-12T00:00:00.000Z";
const FINAL_CONTENT = "Canonical final";
const FINAL_DIGEST = hashDefinition(FINAL_CONTENT);

function createCommitter(
  recordAgentFinal: (draft: AgentFinalDraft) => Readonly<{
    status: "recorded" | "replayed";
    messageId: string;
    inboxItemId: string;
  }>,
): InMemorySessionExecutionCanonicalSettlementCommitter {
  return new InMemorySessionExecutionCanonicalSettlementCommitter({
    now: () => "2026-08-12T00:00:05.000Z",
    createMessageId: () => "message_final-1",
    recordAgentFinal,
  });
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_worker-1",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function completedAttempt(): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_1",
    sessionExecutionRuntimeId: "session_execution_runtime_1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    inputSubmissionId: "input_1",
    orchestrationSessionTurnId: "session_turn_worker-1",
    state: "settled",
    receiptDigest: "sha256:receipt-1",
    receiptObservedAt: NOW,
    interactions: [],
    finalCandidate: {
      candidateObservationId: "provider_fact_candidate-1",
      content: FINAL_CONTENT,
      contentDigest: FINAL_DIGEST,
      observedAt: NOW,
    },
    terminal: {
      terminalObservationId: "provider_fact_terminal-1",
      outcome: "completed",
      receiptDigest: "sha256:receipt-1",
      observedAt: NOW,
    },
    settlement: {
      sessionExecutionRuntimeId: "session_execution_runtime_1",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      taskId: "task_1",
      runId: "run_1",
      logicalSessionId: "logical_session_worker-1",
      bindingId: "binding_1",
      bindingRevision: 1,
      executionProfileId: "profile_worker",
      profileRevisionId: "profile_revision_worker-1",
      inputSubmissionId: "input_1",
      orchestrationSessionTurnId: "session_turn_worker-1",
      outcome: "completed",
      receiptDigest: "sha256:receipt-1",
      finalContent: FINAL_CONTENT,
      finalContentDigest: FINAL_DIGEST,
      settledAt: NOW,
    },
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
