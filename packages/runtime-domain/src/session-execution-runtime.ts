import type {
  SessionExecutionAttemptRecord,
  SessionExecutionFinalCandidate,
  SessionExecutionInteraction,
  SessionExecutionRuntimeRecord,
  SessionExecutionSettlement,
  SessionExecutionTerminal,
} from "@agent-workspace/runtime-contracts";
import {
  assertInteractionChoiceId,
  assertInteractionId,
  assertSessionExecutionSafeValue,
  hashDefinition,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors";

export function createSessionExecutionRuntime(input: Readonly<{
  sessionExecutionRuntimeId: string;
  taskId: string;
  runId: string;
  logicalSessionId: string;
  now: string;
}>): SessionExecutionRuntimeRecord {
  assertSessionExecutionSafeValue(input);
  invariant(input.sessionExecutionRuntimeId.startsWith("session_execution_runtime_"), "session_execution_runtime_id_invalid");
  invariant(input.taskId.startsWith("task_"), "session_execution_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "session_execution_run_id_invalid");
  invariant(input.logicalSessionId.startsWith("logical_session_"), "session_execution_logical_session_id_invalid");
  return Object.freeze({
    sessionExecutionRuntimeId: input.sessionExecutionRuntimeId,
    taskId: input.taskId,
    runId: input.runId,
    logicalSessionId: input.logicalSessionId,
    state: "idle",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function startSessionExecutionAttempt(
  runtime: SessionExecutionRuntimeRecord,
  input: Readonly<{
    sessionExecutionAttemptId: string;
    bindingId: string;
    bindingRevision: number;
    executionProfileId: string;
    profileRevisionId: string;
    inputSubmissionId: string;
    orchestrationSessionTurnId: string;
    now: string;
  }>,
): Readonly<{ runtime: SessionExecutionRuntimeRecord; attempt: SessionExecutionAttemptRecord }> {
  assertSessionExecutionSafeValue(input);
  invariant(runtime.state !== "closed", "session_execution_runtime_closed");
  invariant(!runtime.activeAttemptId, "session_execution_attempt_already_active");
  invariant(runtime.state === "idle", "session_execution_runtime_not_idle");
  invariant(input.sessionExecutionAttemptId.startsWith("session_execution_attempt_"), "session_execution_attempt_id_invalid");
  invariant(input.bindingId.startsWith("binding_"), "session_execution_binding_id_invalid");
  invariant(Number.isSafeInteger(input.bindingRevision) && input.bindingRevision > 0, "session_execution_binding_revision_invalid");
  invariant(input.executionProfileId.startsWith("profile_"), "session_execution_profile_id_invalid");
  invariant(input.profileRevisionId.startsWith("profile_revision_"), "session_execution_profile_revision_id_invalid");
  invariant(input.inputSubmissionId.startsWith("input_"), "session_execution_input_id_invalid");
  invariant(input.orchestrationSessionTurnId.startsWith("session_turn_"), "session_execution_or_turn_id_invalid");

  const attempt: SessionExecutionAttemptRecord = Object.freeze({
    sessionExecutionAttemptId: input.sessionExecutionAttemptId,
    sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
    taskId: runtime.taskId,
    runId: runtime.runId,
    logicalSessionId: runtime.logicalSessionId,
    bindingId: input.bindingId,
    bindingRevision: input.bindingRevision,
    executionProfileId: input.executionProfileId,
    profileRevisionId: input.profileRevisionId,
    inputSubmissionId: input.inputSubmissionId,
    orchestrationSessionTurnId: input.orchestrationSessionTurnId,
    state: "awaiting_receipt",
    interactions: Object.freeze([]),
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return Object.freeze({
    runtime: Object.freeze({
      ...runtime,
      state: "executing",
      activeAttemptId: attempt.sessionExecutionAttemptId,
      revision: runtime.revision + 1,
      updatedAt: input.now,
    }),
    attempt,
  });
}

export function recordSessionExecutionReceipt(
  attempt: SessionExecutionAttemptRecord,
  input: Readonly<{ receiptDigest: string; observedAt: string }>,
): SessionExecutionAttemptRecord {
  assertSessionExecutionSafeValue(input);
  if (attempt.receiptDigest) {
    invariant(attempt.receiptDigest === input.receiptDigest, "session_execution_receipt_conflict");
    return attempt;
  }
  assertAttemptMutable(attempt);
  invariant(Boolean(input.receiptDigest.trim()), "session_execution_receipt_digest_required");
  if (attempt.terminal) {
    if (attempt.terminal.receiptDigest) {
      invariant(attempt.terminal.receiptDigest === input.receiptDigest, "session_execution_receipt_terminal_mismatch");
    }
  }
  const terminal = attempt.terminal && !attempt.terminal.receiptDigest
    ? Object.freeze({ ...attempt.terminal, receiptDigest: input.receiptDigest })
    : attempt.terminal;
  return settleIfPossible(updateAttempt(attempt, {
    receiptDigest: input.receiptDigest,
    receiptObservedAt: input.observedAt,
    ...(terminal ? { terminal } : {}),
    state: deriveUnsettledState({ ...attempt, receiptDigest: input.receiptDigest, terminal }),
  }, input.observedAt));
}

export function recordSessionExecutionInteraction(
  attempt: SessionExecutionAttemptRecord,
  input: Readonly<{
    interactionId: string;
    promptDigest: string;
    choices: readonly Readonly<{ choiceId: string; label: string }>[];
    observedAt: string;
  }>,
): SessionExecutionAttemptRecord {
  assertSessionExecutionSafeValue(input);
  assertInteractionId(input.interactionId);
  input.choices.forEach((choice) => assertInteractionChoiceId(choice.choiceId));
  invariant(input.choices.length > 0, "session_execution_interaction_choices_required");
  invariant(new Set(input.choices.map((choice) => choice.choiceId)).size === input.choices.length, "session_execution_interaction_choice_duplicate");
  const existing = attempt.interactions.find((interaction) => interaction.interactionId === input.interactionId);
  if (existing) {
    invariant(
      existing.promptDigest === input.promptDigest
        && JSON.stringify(existing.choices) === JSON.stringify(input.choices),
      "session_execution_interaction_conflict",
    );
    return attempt;
  }
  assertAttemptMutable(attempt);
  invariant(
    !attempt.interactions.some((interaction) => interaction.status === "requested"),
    "session_execution_interaction_already_requested",
  );
  const interaction: SessionExecutionInteraction = Object.freeze({
    interactionId: input.interactionId,
    promptDigest: requiredText(input.promptDigest, "session_execution_interaction_prompt_digest_required"),
    choices: Object.freeze(input.choices.map((choice) => Object.freeze({
      choiceId: choice.choiceId,
      label: requiredText(choice.label, "session_execution_interaction_choice_label_required"),
    }))),
    status: "requested",
    revision: 1,
    requestedAt: input.observedAt,
  });
  return updateAttempt(attempt, {
    interactions: Object.freeze([...attempt.interactions, interaction]),
    state: "waiting_for_interaction",
  }, input.observedAt);
}

export function recordSessionExecutionInteractionChoice(
  attempt: SessionExecutionAttemptRecord,
  input: Readonly<{
    sessionExecutionAttemptId: string;
    interactionId: string;
    choiceId: string;
    expectedInteractionRevision: number;
    respondedAt: string;
  }>,
): SessionExecutionAttemptRecord {
  assertSessionExecutionSafeValue(input);
  invariant(input.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId, "session_execution_interaction_attempt_mismatch");
  const interaction = attempt.interactions.find((candidate) => candidate.interactionId === input.interactionId);
  invariant(Boolean(interaction), "session_execution_interaction_not_found");
  invariant(interaction!.choices.some((choice) => choice.choiceId === input.choiceId), "session_execution_interaction_choice_invalid");
  if (interaction!.status === "responded") {
    invariant(interaction!.selectedChoiceId === input.choiceId, "session_execution_interaction_choice_conflict");
    invariant(
      input.expectedInteractionRevision === interaction!.revision
        || input.expectedInteractionRevision === interaction!.revision - 1,
      "session_execution_interaction_revision_stale",
    );
    return attempt;
  }
  invariant(interaction!.revision === input.expectedInteractionRevision, "session_execution_interaction_revision_stale");
  assertAttemptMutable(attempt);
  const responded: SessionExecutionInteraction = Object.freeze({
    ...interaction!,
    status: "responded",
    selectedChoiceId: input.choiceId,
    revision: interaction!.revision + 1,
    respondedAt: input.respondedAt,
  });
  return settleIfPossible(updateAttempt(attempt, {
    interactions: Object.freeze(attempt.interactions.map((candidate) =>
      candidate.interactionId === responded.interactionId ? responded : candidate)),
    state: deriveUnsettledState({
      ...attempt,
      interactions: attempt.interactions.map((candidate) =>
        candidate.interactionId === responded.interactionId ? responded : candidate),
    }),
  }, input.respondedAt));
}

export function recordSessionExecutionFinalCandidate(
  attempt: SessionExecutionAttemptRecord,
  input: Readonly<SessionExecutionFinalCandidate>,
): SessionExecutionAttemptRecord {
  assertSessionExecutionSafeValue(input);
  if (attempt.finalCandidate) {
    invariant(
      attempt.finalCandidate.candidateObservationId === input.candidateObservationId
        && attempt.finalCandidate.contentDigest === input.contentDigest
        && attempt.finalCandidate.content === input.content,
      "session_execution_final_candidate_conflict",
    );
    return attempt;
  }
  assertAttemptMutable(attempt);
  const finalCandidate: SessionExecutionFinalCandidate = Object.freeze({
    candidateObservationId: requiredText(input.candidateObservationId, "session_execution_candidate_observation_id_required"),
    content: requiredText(input.content, "session_execution_final_content_required"),
    contentDigest: requiredText(input.contentDigest, "session_execution_final_digest_required"),
    observedAt: input.observedAt,
  });
  invariant(finalCandidate.candidateObservationId.startsWith("provider_fact_"), "session_execution_candidate_observation_id_invalid");
  invariant(finalCandidate.contentDigest === hashDefinition(finalCandidate.content), "session_execution_final_digest_mismatch");
  return settleIfPossible(updateAttempt(attempt, {
    finalCandidate,
    state: deriveUnsettledState({ ...attempt, finalCandidate }),
  }, input.observedAt));
}

export function recordSessionExecutionTerminal(
  attempt: SessionExecutionAttemptRecord,
  input: Readonly<SessionExecutionTerminal>,
): SessionExecutionAttemptRecord {
  assertSessionExecutionSafeValue(input);
  if (attempt.terminal) {
    const replay = attempt.terminal.terminalObservationId === input.terminalObservationId
      && attempt.terminal.outcome === input.outcome
      && attempt.terminal.receiptDigest === input.receiptDigest;
    if (replay) return attempt;
    invariant(
      attempt.terminal.outcome === "unknown" && input.outcome !== "unknown",
      "session_execution_terminal_conflict",
    );
  }
  assertAttemptMutable(attempt);
  const terminal: SessionExecutionTerminal = Object.freeze({
    terminalObservationId: requiredText(input.terminalObservationId, "session_execution_terminal_observation_id_required"),
    outcome: input.outcome,
    ...(input.receiptDigest === undefined && attempt.receiptDigest === undefined ? {} : {
      receiptDigest: requiredText(input.receiptDigest ?? attempt.receiptDigest!, "session_execution_terminal_receipt_digest_required"),
    }),
    observedAt: input.observedAt,
  });
  invariant(terminal.terminalObservationId.startsWith("provider_fact_"), "session_execution_terminal_observation_id_invalid");
  invariant(["completed", "failed", "cancelled", "unknown"].includes(terminal.outcome), "session_execution_terminal_outcome_invalid");
  if (attempt.receiptDigest && terminal.receiptDigest) {
    invariant(attempt.receiptDigest === terminal.receiptDigest, "session_execution_receipt_terminal_mismatch");
  }
  return settleIfPossible(updateAttempt(attempt, {
    terminal,
    state: deriveUnsettledState({ ...attempt, terminal }),
  }, input.observedAt));
}

export function markSessionExecutionReconciliation(
  runtime: SessionExecutionRuntimeRecord,
  attempt: SessionExecutionAttemptRecord,
  now: string,
): Readonly<{ runtime: SessionExecutionRuntimeRecord; attempt: SessionExecutionAttemptRecord }> {
  invariant(runtime.activeAttemptId === attempt.sessionExecutionAttemptId, "session_execution_attempt_not_current");
  assertAttemptMutable(attempt);
  return Object.freeze({
    runtime: markSessionExecutionRuntimeReconciling(runtime, attempt, now),
    attempt: updateAttempt(attempt, { state: "reconciling" }, now),
  });
}

export function markSessionExecutionRuntimeReconciling(
  runtime: SessionExecutionRuntimeRecord,
  attempt: SessionExecutionAttemptRecord,
  now: string,
): SessionExecutionRuntimeRecord {
  invariant(runtime.activeAttemptId === attempt.sessionExecutionAttemptId, "session_execution_attempt_not_current");
  if (runtime.state === "reconciling") return runtime;
  return Object.freeze({ ...runtime, state: "reconciling", revision: runtime.revision + 1, updatedAt: now });
}

export function markSessionExecutionRuntimeExecuting(
  runtime: SessionExecutionRuntimeRecord,
  attempt: SessionExecutionAttemptRecord,
  now: string,
): SessionExecutionRuntimeRecord {
  invariant(runtime.activeAttemptId === attempt.sessionExecutionAttemptId, "session_execution_attempt_not_current");
  invariant(!attempt.settlement && attempt.state !== "reconciling" && attempt.state !== "settled",
    "session_execution_attempt_not_executing");
  if (runtime.state === "executing") return runtime;
  invariant(runtime.state === "reconciling", "session_execution_runtime_not_reconciling");
  return Object.freeze({ ...runtime, state: "executing", revision: runtime.revision + 1, updatedAt: now });
}

export function settleSessionExecutionRuntime(
  runtime: SessionExecutionRuntimeRecord,
  attempt: SessionExecutionAttemptRecord,
): SessionExecutionRuntimeRecord {
  invariant(runtime.activeAttemptId === attempt.sessionExecutionAttemptId, "session_execution_attempt_not_current");
  invariant(Boolean(attempt.settlement), "session_execution_attempt_not_settled");
  const { activeAttemptId: _retiredAttemptId, ...retiredRuntime } = runtime;
  return Object.freeze({
    ...retiredRuntime,
    state: "idle",
    revision: runtime.revision + 1,
    updatedAt: attempt.settlement!.settledAt,
  });
}

function settleIfPossible(attempt: SessionExecutionAttemptRecord): SessionExecutionAttemptRecord {
  const terminal = attempt.terminal;
  if (!terminal || terminal.outcome === "unknown") return attempt;
  if (!attempt.receiptDigest) return attempt;
  if (terminal.receiptDigest) {
    invariant(attempt.receiptDigest === terminal.receiptDigest, "session_execution_receipt_terminal_mismatch");
  }
  if (attempt.interactions.some((interaction) => interaction.status === "requested")) return attempt;
  if (terminal.outcome === "completed" && !attempt.finalCandidate) return attempt;
  const settlement: SessionExecutionSettlement = Object.freeze({
    sessionExecutionRuntimeId: attempt.sessionExecutionRuntimeId,
    sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
    taskId: attempt.taskId,
    runId: attempt.runId,
    logicalSessionId: attempt.logicalSessionId,
    bindingId: attempt.bindingId,
    bindingRevision: attempt.bindingRevision,
    executionProfileId: attempt.executionProfileId,
    profileRevisionId: attempt.profileRevisionId,
    inputSubmissionId: attempt.inputSubmissionId,
    orchestrationSessionTurnId: attempt.orchestrationSessionTurnId,
    outcome: terminal.outcome,
    receiptDigest: attempt.receiptDigest,
    ...(terminal.outcome === "completed" ? {
      finalContent: attempt.finalCandidate!.content,
      finalContentDigest: attempt.finalCandidate!.contentDigest,
    } : {}),
    settledAt: latestTimestamp([
      terminal.observedAt,
      attempt.finalCandidate?.observedAt,
      attempt.receiptObservedAt,
    ]),
  });
  return Object.freeze({
    ...attempt,
    state: "settled",
    settlement,
    updatedAt: settlement.settledAt,
  });
}

function deriveUnsettledState(attempt: Partial<SessionExecutionAttemptRecord>): SessionExecutionAttemptRecord["state"] {
  if (attempt.terminal?.outcome === "unknown") return "reconciling";
  if (attempt.terminal && !attempt.receiptDigest) return "reconciling";
  if (attempt.terminal?.outcome === "completed" && !attempt.finalCandidate) return "reconciling";
  if (attempt.interactions?.some((interaction) => interaction.status === "requested")) return "waiting_for_interaction";
  if (attempt.finalCandidate) return "candidate_observed";
  if (attempt.receiptDigest) return "active";
  return "awaiting_receipt";
}

function updateAttempt(
  attempt: SessionExecutionAttemptRecord,
  changes: Partial<SessionExecutionAttemptRecord>,
  updatedAt: string,
): SessionExecutionAttemptRecord {
  return Object.freeze({ ...attempt, ...changes, revision: attempt.revision + 1, updatedAt });
}

function assertAttemptMutable(attempt: SessionExecutionAttemptRecord): void {
  invariant(attempt.state !== "settled", "session_execution_attempt_settled");
}

function requiredText(value: string, code: string): string {
  invariant(typeof value === "string" && Boolean(value.trim()), code);
  return value;
}

function latestTimestamp(values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined).sort().at(-1)!;
}
