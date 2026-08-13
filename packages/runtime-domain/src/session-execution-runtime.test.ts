import { describe, expect, it } from "vitest";
import { hashDefinition } from "@agent-workspace/runtime-contracts";
import {
  createSessionExecutionRuntime,
  recordSessionExecutionFinalCandidate,
  recordSessionExecutionInteraction,
  recordSessionExecutionInteractionChoice,
  recordSessionExecutionReceipt,
  recordSessionExecutionTerminal,
  startSessionExecutionAttempt,
} from "./session-execution-runtime";

describe("SessionExecutionRuntime state machine", () => {
  it("separates an SR attempt from the correlated OR SessionTurn and enforces one active attempt", () => {
    const runtime = createSessionExecutionRuntime(runtimeInput());
    const started = startSessionExecutionAttempt(runtime, attemptInput());

    expect(started.attempt).toMatchObject({
      sessionExecutionAttemptId: "session_execution_attempt_1",
      orchestrationSessionTurnId: "session_turn_or_1",
      state: "awaiting_receipt",
    });
    expect(started.attempt).not.toHaveProperty("sessionTurn");
    expect(() => startSessionExecutionAttempt(started.runtime, {
      ...attemptInput(),
      sessionExecutionAttemptId: "session_execution_attempt_2",
    })).toThrow(/session_execution_attempt_already_active/);
  });

  it("pairs an exact final candidate and terminal even when terminal arrives first", () => {
    const started = startSessionExecutionAttempt(createSessionExecutionRuntime(runtimeInput()), attemptInput());
    const received = recordSessionExecutionReceipt(started.attempt, {
      receiptDigest: "sha256:receipt-1",
      observedAt: "2026-08-11T00:00:02.000Z",
    });
    const terminalFirst = recordSessionExecutionTerminal(received, {
      terminalObservationId: "provider_fact_terminal-1",
      outcome: "completed",
      receiptDigest: "sha256:receipt-1",
      observedAt: "2026-08-11T00:00:04.000Z",
    });

    expect(terminalFirst.state).toBe("reconciling");
    expect(terminalFirst.settlement).toBeUndefined();

    const paired = recordSessionExecutionFinalCandidate(terminalFirst, {
      candidateObservationId: "provider_fact_candidate-1",
      content: "Completed result",
      contentDigest: hashDefinition("Completed result"),
      observedAt: "2026-08-11T00:00:03.000Z",
    });
    expect(paired.state).toBe("settled");
    expect(paired.settlement).toMatchObject({
      outcome: "completed",
      finalContent: "Completed result",
      finalContentDigest: hashDefinition("Completed result"),
      orchestrationSessionTurnId: "session_turn_or_1",
    });
    expect(() => recordSessionExecutionFinalCandidate(paired, {
      candidateObservationId: "provider_fact_candidate-2",
      content: "Conflicting result",
      contentDigest: "sha256:final-2",
      observedAt: "2026-08-11T00:00:05.000Z",
    })).toThrow(/session_execution_final_candidate_conflict|session_execution_attempt_settled/);
  });

  it("requires the explicit delivery receipt and settles once when receipt arrives last", () => {
    const started = startSessionExecutionAttempt(createSessionExecutionRuntime(runtimeInput()), attemptInput());
    const candidate = recordSessionExecutionFinalCandidate(started.attempt, {
      candidateObservationId: "provider_fact_candidate-1",
      content: "Completed result",
      contentDigest: hashDefinition("Completed result"),
      observedAt: "2026-08-11T00:00:02.000Z",
    });
    const terminal = recordSessionExecutionTerminal(candidate, {
      terminalObservationId: "provider_fact_terminal-1",
      outcome: "completed",
      observedAt: "2026-08-11T00:00:03.000Z",
    });

    expect(terminal.state).toBe("reconciling");
    expect(terminal.settlement).toBeUndefined();
    const settled = recordSessionExecutionReceipt(terminal, {
      receiptDigest: "sha256:receipt-1",
      observedAt: "2026-08-11T00:00:04.000Z",
    });
    expect(settled.settlement).toMatchObject({
      outcome: "completed",
      receiptDigest: "sha256:receipt-1",
    });
    expect(recordSessionExecutionReceipt(settled, {
      receiptDigest: "sha256:receipt-1",
      observedAt: "2026-08-11T00:00:05.000Z",
    })).toBe(settled);
  });

  it("keeps an unknown terminal without a proven receipt reconciling", () => {
    const started = startSessionExecutionAttempt(createSessionExecutionRuntime(runtimeInput()), attemptInput());
    const unknown = recordSessionExecutionTerminal(started.attempt, {
      terminalObservationId: "provider_fact_terminal-unknown",
      outcome: "unknown",
      observedAt: "2026-08-11T00:00:03.000Z",
    });

    expect(unknown.state).toBe("reconciling");
    expect(unknown.receiptDigest).toBeUndefined();
    expect(unknown.terminal?.receiptDigest).toBeUndefined();
    expect(unknown.settlement).toBeUndefined();

    const received = recordSessionExecutionReceipt(unknown, {
      receiptDigest: "sha256:receipt-1",
      observedAt: "2026-08-11T00:00:04.000Z",
    });
    const candidate = recordSessionExecutionFinalCandidate(received, {
      candidateObservationId: "provider_fact_candidate-reconciled",
      content: "Reconciled result",
      contentDigest: hashDefinition("Reconciled result"),
      observedAt: "2026-08-11T00:00:05.000Z",
    });
    const reconciled = recordSessionExecutionTerminal(candidate, {
      terminalObservationId: "provider_fact_terminal-reconciled",
      outcome: "completed",
      observedAt: "2026-08-11T00:00:06.000Z",
    });
    expect(reconciled.settlement).toMatchObject({
      outcome: "completed",
      receiptDigest: "sha256:receipt-1",
      finalContent: "Reconciled result",
    });
  });

  it("fences interaction choices to the exact attempt and opaque interaction IDs", () => {
    const first = startSessionExecutionAttempt(createSessionExecutionRuntime(runtimeInput()), attemptInput()).attempt;
    const requested = recordSessionExecutionInteraction(first, {
      interactionId: "interaction_permission-1",
      promptDigest: "sha256:permission-prompt",
      choices: [{ choiceId: "choice_allow-once", label: "Allow once" }],
      observedAt: "2026-08-11T00:00:02.000Z",
    });

    expect(JSON.stringify(requested)).not.toMatch(/native|requestId|optionId|cwd/);
    expect(() => recordSessionExecutionInteraction(requested, {
      interactionId: "interaction_permission-2",
      promptDigest: "sha256:permission-prompt-2",
      choices: [{ choiceId: "choice_deny-once", label: "Deny once" }],
      observedAt: "2026-08-11T00:00:02.500Z",
    })).toThrow(/session_execution_interaction_already_requested/);
    expect(() => recordSessionExecutionInteractionChoice(requested, {
      sessionExecutionAttemptId: "session_execution_attempt_other",
      interactionId: "interaction_permission-1",
      choiceId: "choice_allow-once",
      expectedInteractionRevision: 1,
      respondedAt: "2026-08-11T00:00:03.000Z",
    })).toThrow(/session_execution_interaction_attempt_mismatch/);
    expect(() => recordSessionExecutionInteractionChoice(requested, {
      sessionExecutionAttemptId: "session_execution_attempt_1",
      interactionId: "interaction_permission-1",
      choiceId: "choice_provider-option-raw",
      expectedInteractionRevision: 1,
      respondedAt: "2026-08-11T00:00:03.000Z",
    })).toThrow(/session_execution_interaction_choice_invalid/);

    const firstResolved = recordSessionExecutionInteractionChoice(requested, {
      sessionExecutionAttemptId: "session_execution_attempt_1",
      interactionId: "interaction_permission-1",
      choiceId: "choice_allow-once",
      expectedInteractionRevision: 1,
      respondedAt: "2026-08-11T00:00:03.000Z",
    });
    const secondRequested = recordSessionExecutionInteraction(firstResolved, {
      interactionId: "interaction_permission-2",
      promptDigest: "sha256:permission-prompt-2",
      choices: [{ choiceId: "choice_deny-once", label: "Deny once" }],
      observedAt: "2026-08-11T00:00:04.000Z",
    });
    expect(secondRequested.interactions).toEqual([
      expect.objectContaining({ interactionId: "interaction_permission-1", status: "responded" }),
      expect.objectContaining({ interactionId: "interaction_permission-2", status: "requested" }),
    ]);
    expect(recordSessionExecutionInteraction(secondRequested, {
      interactionId: "interaction_permission-2",
      promptDigest: "sha256:permission-prompt-2",
      choices: [{ choiceId: "choice_deny-once", label: "Deny once" }],
      observedAt: "2026-08-11T00:00:05.000Z",
    })).toBe(secondRequested);
  });
});

function runtimeInput() {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_1",
    taskId: "task_1",
    runId: "run_1",
    logicalSessionId: "logical_session_1",
    now: "2026-08-11T00:00:00.000Z",
  } as const;
}

function attemptInput() {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_1",
    bindingId: "binding_1",
    bindingRevision: 1,
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker-1",
    inputSubmissionId: "input_1",
    orchestrationSessionTurnId: "session_turn_or_1",
    now: "2026-08-11T00:00:01.000Z",
  } as const;
}
