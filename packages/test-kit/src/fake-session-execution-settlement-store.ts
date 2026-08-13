import type {
  AcpSafeSessionBindingRecordV3,
  JsonValue,
  SessionExecutionAttemptRecord,
  SessionExecutionSettlement,
} from "@agent-workspace/runtime-contracts";
import {
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionSettlement,
  hashDefinition,
} from "@agent-workspace/runtime-contracts";
import type {
  AgentFinalDraft,
  SessionExecutionCanonicalSettlementCommitter,
  SessionExecutionSettlementResult,
} from "@agent-workspace/runtime-application";
import { invariant } from "@agent-workspace/runtime-domain";

type CanonicalSettlementAcceptance = Readonly<{
  sessionExecutionAttemptId: string;
  orchestrationSessionTurnId: string;
  settlementFingerprint: string;
  messageId: string;
  inboxItemId: string;
  acceptedAt: string;
}>;

type Options = Readonly<{
  now: () => string;
  createMessageId: (settlement: SessionExecutionSettlement) => string;
  /** The sole canonical write capability; production binds the existing recordAgentFinal use case. */
  recordAgentFinal: (draft: AgentFinalDraft) => SessionExecutionSettlementResult;
}>;

/**
 * Phase 1 fence fake. It owns only SR Attempt/Binding proof and an acceptance
 * receipt. Canonical Message/Turn/Input/Inbox state is never represented here;
 * the injected existing `recordAgentFinal` capability is its only write seam.
 */
export class InMemorySessionExecutionCanonicalSettlementCommitter implements
  SessionExecutionCanonicalSettlementCommitter {
  #attempts = new Map<string, SessionExecutionAttemptRecord>();
  #bindings = new Map<string, AcpSafeSessionBindingRecordV3>();
  #currentBindingByLogicalSession = new Map<string, string>();
  #acceptances = new Map<string, CanonicalSettlementAcceptance>();
  #inTransaction = false;

  constructor(private readonly options: Options) {}

  seedAttempt(attempt: SessionExecutionAttemptRecord): void {
    const valid = cloneSessionExecutionAttemptRecord(attempt);
    if (this.#attempts.has(valid.sessionExecutionAttemptId)) throw new Error("session_execution_settlement_attempt_duplicate");
    this.#attempts.set(valid.sessionExecutionAttemptId, valid);
  }

  seedBinding(binding: AcpSafeSessionBindingRecordV3): void {
    const valid = cloneAcpSafeSessionBindingRecordV3(binding);
    if (this.#bindings.has(valid.bindingId)) throw new Error("session_execution_settlement_binding_duplicate");
    this.#bindings.set(valid.bindingId, valid);
  }

  setCurrentBinding(logicalSessionId: string, bindingId: string): void {
    const binding = this.#bindings.get(bindingId);
    invariant(Boolean(binding) && binding!.logicalSessionId === logicalSessionId,
      "session_execution_settlement_current_binding_scope_mismatch");
    invariant(binding!.status === "active" || binding!.status === "recovering",
      "session_execution_settlement_current_binding_not_live");
    this.#currentBindingByLogicalSession.set(logicalSessionId, bindingId);
  }

  commitCanonicalAgentFinal(value: SessionExecutionSettlement): SessionExecutionSettlementResult {
    const settlement = cloneSessionExecutionSettlement(value);
    invariant(settlement.outcome === "completed", "session_execution_settlement_not_completed");
    return this.#atomic(() => {
      const attempt = this.#attempts.get(settlement.sessionExecutionAttemptId);
      invariant(Boolean(attempt), "session_execution_settlement_attempt_not_found");
      const persistedAttempt = cloneSessionExecutionAttemptRecord(attempt!);
      invariant(persistedAttempt.state === "settled" && Boolean(persistedAttempt.settlement),
        "session_execution_settlement_attempt_not_settled");
      const settlementFingerprint = fingerprint(settlement);
      invariant(fingerprint(persistedAttempt.settlement!) === settlementFingerprint,
        "session_execution_settlement_attempt_settlement_mismatch");

      const currentBindingId = this.#currentBindingByLogicalSession.get(settlement.logicalSessionId);
      const currentBinding = currentBindingId ? this.#bindings.get(currentBindingId) : undefined;
      invariant(Boolean(currentBinding), "session_execution_settlement_current_binding_not_found");
      const binding = cloneAcpSafeSessionBindingRecordV3(currentBinding!);
      invariant(binding.status === "active" || binding.status === "recovering",
        "session_execution_settlement_current_binding_not_live");
      invariant(binding.bindingId === settlement.bindingId
        && binding.revision === settlement.bindingRevision
        && binding.taskId === settlement.taskId
        && binding.runId === settlement.runId
        && binding.logicalSessionId === settlement.logicalSessionId
        && binding.executionProfileId === settlement.executionProfileId
        && binding.profileRevisionId === settlement.profileRevisionId,
      "session_execution_settlement_current_binding_mismatch");

      const acceptance = this.#acceptances.get(settlement.sessionExecutionAttemptId);
      const acceptanceForTurn = [...this.#acceptances.values()].find((candidate) =>
        candidate.orchestrationSessionTurnId === settlement.orchestrationSessionTurnId);
      if (acceptance || acceptanceForTurn) {
        invariant(Boolean(acceptance) && acceptance === acceptanceForTurn
          && acceptance!.settlementFingerprint === settlementFingerprint,
        "session_execution_settlement_replay_conflict");
        return Object.freeze({
          status: "replayed" as const,
          messageId: acceptance!.messageId,
          inboxItemId: acceptance!.inboxItemId,
        });
      }

      const messageId = this.options.createMessageId(settlement);
      const result = this.options.recordAgentFinal(Object.freeze({
        runId: settlement.runId,
        sessionId: settlement.logicalSessionId,
        inputSubmissionId: settlement.inputSubmissionId,
        sessionTurnId: settlement.orchestrationSessionTurnId,
        messageId,
        content: settlement.finalContent!,
      }));
      invariant(result.messageId === messageId, "session_execution_settlement_canonical_message_mismatch");
      invariant(Boolean(result.inboxItemId), "session_execution_settlement_canonical_inbox_missing");
      this.#acceptances.set(settlement.sessionExecutionAttemptId, Object.freeze({
        sessionExecutionAttemptId: settlement.sessionExecutionAttemptId,
        orchestrationSessionTurnId: settlement.orchestrationSessionTurnId,
        settlementFingerprint,
        messageId: result.messageId,
        inboxItemId: result.inboxItemId,
        acceptedAt: this.options.now(),
      }));
      return Object.freeze({
        status: result.status,
        messageId: result.messageId,
        inboxItemId: result.inboxItemId,
      });
    });
  }

  snapshot(): Readonly<{
    attempts: readonly SessionExecutionAttemptRecord[];
    bindings: readonly AcpSafeSessionBindingRecordV3[];
    currentBindings: readonly Readonly<{ logicalSessionId: string; bindingId: string }>[];
    settlementAcceptances: readonly CanonicalSettlementAcceptance[];
  }> {
    return Object.freeze({
      attempts: sorted(this.#attempts, "sessionExecutionAttemptId", cloneSessionExecutionAttemptRecord),
      bindings: sorted(this.#bindings, "bindingId", cloneAcpSafeSessionBindingRecordV3),
      currentBindings: Object.freeze([...this.#currentBindingByLogicalSession.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([logicalSessionId, bindingId]) => Object.freeze({ logicalSessionId, bindingId }))),
      settlementAcceptances: sorted(this.#acceptances, "sessionExecutionAttemptId", clone),
    });
  }

  #atomic<T>(work: () => T): T {
    if (this.#inTransaction) throw new Error("session_execution_settlement_nested_transaction_forbidden");
    const acceptances = new Map(this.#acceptances);
    this.#inTransaction = true;
    try {
      return work();
    } catch (error) {
      this.#acceptances = acceptances;
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }
}

function fingerprint(value: SessionExecutionSettlement): string {
  return hashDefinition(value as unknown as JsonValue);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sorted<T>(map: Map<string, T>, key: keyof T, cloneValue: (value: T) => T): readonly T[] {
  return Object.freeze([...map.values()]
    .sort((left, right) => String(left[key]).localeCompare(String(right[key])))
    .map(cloneValue));
}
