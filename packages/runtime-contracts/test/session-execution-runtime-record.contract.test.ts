import { describe, expect, it } from "vitest";
import {
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  type SessionExecutionAttemptRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "../src";

describe("SessionExecutionRuntime durable record validation", () => {
  it("accepts one exactly correlated completed settled attempt", () => {
    expect(cloneSessionExecutionAttemptRecord(completedAttempt())).toEqual(completedAttempt());
  });

  it("rejects extra keys at runtime, attempt and nested observation boundaries", () => {
    expect(() => cloneSessionExecutionRuntimeRecord({
      sessionExecutionRuntimeId: "session_execution_runtime_1",
      taskId: "task_1",
      runId: "run_1",
      logicalSessionId: "logical_session_worker-1",
      state: "idle",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      rawSessionId: "forbidden",
    } as never)).toThrow(/runtime_shape_invalid|private_field_forbidden/);
    expect(() => cloneSessionExecutionAttemptRecord({ ...completedAttempt(), unexpected: true } as never))
      .toThrow(/attempt_shape_invalid/);
    expect(() => cloneSessionExecutionAttemptRecord({
      ...completedAttempt(),
      finalCandidate: { ...completedAttempt().finalCandidate!, rawMessageId: "forbidden" },
    } as never)).toThrow(/final_candidate_shape_invalid|private_field_forbidden/);
  });

  it("enforces settled iff settlement and exact receipt/outcome/final correlation", () => {
    const valid = completedAttempt();
    const { settlement: _missing, ...withoutSettlement } = valid;
    expect(() => cloneSessionExecutionAttemptRecord(withoutSettlement as SessionExecutionAttemptRecord))
      .toThrow(/settled_state_mismatch/);
    expect(() => cloneSessionExecutionAttemptRecord({ ...valid, state: "reconciling" }))
      .toThrow(/settled_state_mismatch/);
    expect(() => cloneSessionExecutionAttemptRecord({
      ...valid,
      settlement: { ...valid.settlement!, receiptDigest: "sha256:other" },
    })).toThrow(/receipt_mismatch/);
    expect(() => cloneSessionExecutionAttemptRecord({
      ...valid,
      settlement: { ...valid.settlement!, outcome: "failed", finalContent: undefined, finalContentDigest: undefined },
    } as never)).toThrow(/outcome_mismatch|shape_invalid|failed_final_forbidden/);
    expect(() => cloneSessionExecutionAttemptRecord({
      ...valid,
      settlement: { ...valid.settlement!, finalContent: "forged", finalContentDigest: hashDefinition("forged") },
    })).toThrow(/final_candidate_mismatch/);
  });

  it("forbids final fields on failed and cancelled settlements", () => {
    const valid = completedAttempt();
    for (const outcome of ["failed", "cancelled"] as const) {
      expect(() => cloneSessionExecutionAttemptRecord({
        ...valid,
        finalCandidate: undefined,
        terminal: { ...valid.terminal!, outcome },
        settlement: { ...valid.settlement!, outcome },
      } as never)).toThrow(/failed_final_forbidden/);

      const { finalCandidate: _candidate, settlement: completedSettlement, ...withoutCandidate } = valid;
      const { finalContent: _content, finalContentDigest: _digest, ...withoutFinal } = completedSettlement!;
      const terminalAttempt: SessionExecutionAttemptRecord = {
        ...withoutCandidate,
        terminal: { ...valid.terminal!, outcome },
        settlement: { ...withoutFinal, outcome },
      };
      expect(cloneSessionExecutionAttemptRecord(terminalAttempt)).toEqual(terminalAttempt);
    }
  });

  it("accepts only the exact durable task-stop suppression shape", () => {
    const pending = providerEffectIntent();
    const suppressed: SessionRuntimeProviderEffectIntentRecord = {
      ...pending,
      state: "suppressed",
      suppressionReason: "task_stopped",
      suppressedAt: NOW,
    };
    expect(cloneSessionRuntimeProviderEffectIntent(suppressed)).toEqual(suppressed);
    expect(() => cloneSessionRuntimeProviderEffectIntent({
      ...pending,
      suppressionReason: "task_stopped",
      suppressedAt: NOW,
    })).toThrow(/suppression_forbidden/);
    expect(() => cloneSessionRuntimeProviderEffectIntent({
      ...suppressed,
      suppressedAt: undefined,
    } as never)).toThrow(/suppressedAt|shape_invalid/);
    expect(() => cloneSessionRuntimeProviderEffectIntent({
      ...suppressed,
      absoluteCwd: "/private/workspace",
    } as never)).toThrow(/shape_invalid|private_field_forbidden/);
  });
});

const NOW = "2026-08-12T00:00:00.000Z";
const CONTENT = "Canonical final";
const CONTENT_DIGEST = hashDefinition(CONTENT);

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
      content: CONTENT,
      contentDigest: CONTENT_DIGEST,
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
      finalContent: CONTENT,
      finalContentDigest: CONTENT_DIGEST,
      settledAt: NOW,
    },
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function providerEffectIntent(): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId: "provider_effect_1",
    commandId: "command_1",
    idempotencyKey: "submit:1",
    commandType: "session_runtime.submit_delivery",
    commandFingerprint: hashDefinition({ command: "submit" }),
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_worker-1",
    sessionExecutionRuntimeId: "session_execution_runtime_1",
    sessionExecutionAttemptId: "session_execution_attempt_1",
    inputSubmissionId: "input_1",
    orchestrationSessionTurnId: "session_turn_worker-1",
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    effect: {
      kind: "submit_delivery",
      bindingHandle: "binding_handle_worker-1",
      sessionExecutionAttemptId: "session_execution_attempt_1",
      content: "One pending delivery.",
    },
    state: "pending",
    createdAt: NOW,
  };
}
