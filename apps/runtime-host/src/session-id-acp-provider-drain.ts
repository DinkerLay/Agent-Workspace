import {
  assertSessionExecutionSafeValue,
  canonicalJson,
  cloneSessionExecutionSettlement,
  cloneSessionRuntimeProviderEffectIntent,
  type JsonValue,
  type SessionExecutionSettlement,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdAcpDeliverySettlementResult,
  SessionIdAcpEffectObservation,
  SessionIdAcpEffectObservationResult,
} from "@agent-workspace/runtime-application";
import type {
  AcpTaskSessionRuntimeProvider,
  AcpTaskSessionRuntimeProviderResult,
} from "./acp-task-session-runtime-provider.js";

export interface SessionIdAcpProviderDrainEffectReadCapability {
  getProviderEffectIntent(
    providerEffectIntentId: string,
  ): SessionRuntimeProviderEffectIntentRecord | undefined;
  listProviderEffectIntents(
    sessionExecutionAttemptId?: string,
  ): readonly SessionRuntimeProviderEffectIntentRecord[];
}

export interface SessionIdAcpProviderDrainResultOwner {
  acceptEffectObservation(
    observation: SessionIdAcpEffectObservation,
  ): SessionIdAcpEffectObservationResult;
  acceptSettlement(
    settlement: SessionExecutionSettlement,
  ): SessionIdAcpDeliverySettlementResult;
}

export type SessionIdAcpProviderDrainResult = Readonly<{
  disposition: "settled" | "reconciling" | "rejected";
  providerEffectIntentId: string;
  sessionExecutionAttemptId: string;
  commandType: SessionRuntimeProviderEffectIntentRecord["commandType"];
  reconciliationRequired: boolean;
}>;

export type SessionIdAcpProviderDrain = Readonly<{
  drain(input: Readonly<{ providerEffectIntentId: string }>): Promise<SessionIdAcpProviderDrainResult>;
}>;

export type SessionIdAcpProviderDrainOptions = Readonly<{
  provider: Pick<AcpTaskSessionRuntimeProvider, "executeProviderEffect">;
  providerEffects: SessionIdAcpProviderDrainEffectReadCapability;
  resultOwner: SessionIdAcpProviderDrainResultOwner;
}>;

export class SessionIdAcpProviderDrainError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SessionIdAcpProviderDrainError";
    this.code = code;
  }
}

/**
 * Host-owned drain from one already-durable ACP-v3 effect intent to the
 * provider-neutral Session Runtime and canonical OR result owner.
 *
 * It does not own any row. In particular, it never translates ACP facts into
 * a legacy outbox or writes Input/Turn/Control itself.
 */
export function createSessionIdAcpProviderDrain(
  options: SessionIdAcpProviderDrainOptions,
): SessionIdAcpProviderDrain {
  validateOptions(options);
  const inFlight = new Map<string, Promise<SessionIdAcpProviderDrainResult>>();
  // A native submit/reconcile/interaction is exclusive within its durable
  // Attempt. Interrupt is deliberately excluded so it can stop an active
  // submit; exact interrupt replay remains covered by the intent singleflight.
  const serializedAttemptTails = new Map<string, Promise<void>>();

  return Object.freeze({
    async drain(value: Readonly<{ providerEffectIntentId: string }>) {
      const providerEffectIntentId = exactDrainInput(value);
      const active = inFlight.get(providerEffectIntentId);
      if (active) return await active;
      const intent = requiredIntent(providerEffectIntentId);
      const execution = intent.commandType === "session_runtime.request_interrupt"
        ? execute(intent)
        : enqueueSerializedAttempt(intent);
      const operation = execution.finally(() => {
        inFlight.delete(providerEffectIntentId);
      });
      inFlight.set(providerEffectIntentId, operation);
      return await operation;
    },
  });

  function enqueueSerializedAttempt(
    intent: SessionRuntimeProviderEffectIntentRecord,
  ): Promise<SessionIdAcpProviderDrainResult> {
    const attemptId = intent.sessionExecutionAttemptId;
    const predecessor = serializedAttemptTails.get(attemptId);
    const execution = predecessor
      ? predecessor.then(() => execute(requireUnchangedIntent(intent)))
      : execute(intent);
    const tail = execution.then(() => undefined, () => undefined);
    serializedAttemptTails.set(attemptId, tail);
    void tail.then(() => {
      if (serializedAttemptTails.get(attemptId) === tail) {
        serializedAttemptTails.delete(attemptId);
      }
    });
    return execution;
  }

  async function execute(
    intent: SessionRuntimeProviderEffectIntentRecord,
  ): Promise<SessionIdAcpProviderDrainResult> {
    let providerResult: AcpTaskSessionRuntimeProviderResult;
    try {
      providerResult = await options.provider.executeProviderEffect(intent.providerEffectIntentId);
    } catch {
      throw safeError("session_id_acp_provider_drain_execution_failed");
    }
    const result = validateProviderResult(providerResult, intent);

    if (result.disposition === "settled") {
      const settlement = cloneSessionExecutionSettlement(result.settlement);
      assertSettlementScope(settlement, intent);
      try {
        options.resultOwner.acceptSettlement(settlement);
      } catch {
        throw safeError("session_id_acp_provider_drain_result_commit_failed");
      }
      return drainResult("settled", intent, false);
    }

    if (intent.commandType === "session_runtime.request_interrupt") {
      return commitInterruptResult(intent, result);
    }

    if (result.disposition === "rejected") {
      // Interaction rejection belongs to the interaction owner. It must not be
      // reinterpreted as a delivery rejection or mutate OR delivery state.
      if (intent.commandType !== "session_runtime.respond_interaction") {
        throw safeError("session_id_acp_provider_drain_result_kind_mismatch");
      }
      return drainResult("rejected", intent, false);
    }

    const delivery = requiredDeliveryIntent(intent.sessionExecutionAttemptId);
    const provenPreReceiptRejection = intent.commandType === "session_runtime.submit_delivery"
      && result.reason === "native_effect_rejected";
    commitObservation({
      kind: provenPreReceiptRejection ? "delivery_rejected" : "delivery_unknown",
      providerEffectIntentId: delivery.providerEffectIntentId,
      sessionExecutionAttemptId: delivery.sessionExecutionAttemptId,
    });
    return drainResult(
      provenPreReceiptRejection ? "rejected" : "reconciling",
      intent,
      !provenPreReceiptRejection,
    );
  }

  function commitInterruptResult(
    intent: SessionRuntimeProviderEffectIntentRecord,
    result: Exclude<AcpTaskSessionRuntimeProviderResult, { disposition: "settled" }>,
  ): SessionIdAcpProviderDrainResult {
    if (result.disposition === "rejected") {
      commitObservation(interruptObservation("interrupt_rejected", intent));
      return drainResult("rejected", intent, false);
    }
    if (result.reason === "native_outcome_unknown") {
      // The exact current native Binding accepted the control call; the final
      // cancellation outcome remains a later reconciliation fact.
      commitObservation(interruptObservation("interrupt_accepted", intent));
      return drainResult("reconciling", intent, true);
    }
    if (result.reason === "native_effect_rejected") {
      commitObservation(interruptObservation("interrupt_rejected", intent));
      return drainResult("rejected", intent, false);
    }
    commitObservation(interruptObservation("interrupt_unknown", intent));
    return drainResult("reconciling", intent, true);
  }

  function commitObservation(observation: SessionIdAcpEffectObservation): void {
    try {
      options.resultOwner.acceptEffectObservation(observation);
    } catch {
      throw safeError("session_id_acp_provider_drain_result_commit_failed");
    }
  }

  function requiredIntent(providerEffectIntentId: string): SessionRuntimeProviderEffectIntentRecord {
    let persisted: SessionRuntimeProviderEffectIntentRecord | undefined;
    try {
      persisted = options.providerEffects.getProviderEffectIntent(providerEffectIntentId);
    } catch {
      throw safeError("session_id_acp_provider_drain_effect_read_failed");
    }
    if (!persisted) throw safeError("session_id_acp_provider_drain_effect_not_found");
    try {
      const intent = cloneSessionRuntimeProviderEffectIntent(persisted);
      if (intent.providerEffectIntentId !== providerEffectIntentId) {
        throw safeError("session_id_acp_provider_drain_effect_scope_mismatch");
      }
      assertDurableAttemptScope(intent);
      return intent;
    } catch (error) {
      if (error instanceof SessionIdAcpProviderDrainError) throw error;
      throw safeError("session_id_acp_provider_drain_effect_invalid");
    }
  }

  function requireUnchangedIntent(
    expected: SessionRuntimeProviderEffectIntentRecord,
  ): SessionRuntimeProviderEffectIntentRecord {
    const current = requiredIntent(expected.providerEffectIntentId);
    if (!sameIntent(current, expected)) {
      throw safeError("session_id_acp_provider_drain_effect_changed");
    }
    return current;
  }

  function assertDurableAttemptScope(intent: SessionRuntimeProviderEffectIntentRecord): void {
    let persisted: readonly SessionRuntimeProviderEffectIntentRecord[];
    try {
      persisted = options.providerEffects.listProviderEffectIntents(
        intent.sessionExecutionAttemptId,
      );
    } catch {
      throw safeError("session_id_acp_provider_drain_effect_read_failed");
    }
    let candidates: readonly SessionRuntimeProviderEffectIntentRecord[];
    try {
      candidates = persisted.map((candidate) =>
        cloneSessionRuntimeProviderEffectIntent(candidate));
    } catch {
      throw safeError("session_id_acp_provider_drain_effect_invalid");
    }
    const exact = candidates.filter((candidate) =>
      candidate.providerEffectIntentId === intent.providerEffectIntentId);
    if (exact.length !== 1 || !sameIntent(exact[0]!, intent)) {
      throw safeError("session_id_acp_provider_drain_effect_read_inconsistent");
    }
    if (candidates.some((candidate) => !sameAttemptScope(candidate, intent))) {
      throw safeError("session_id_acp_provider_drain_attempt_scope_conflict");
    }
  }

  function requiredDeliveryIntent(
    sessionExecutionAttemptId: string,
  ): SessionRuntimeProviderEffectIntentRecord {
    let candidates: readonly SessionRuntimeProviderEffectIntentRecord[];
    try {
      candidates = options.providerEffects.listProviderEffectIntents(sessionExecutionAttemptId);
    } catch {
      throw safeError("session_id_acp_provider_drain_effect_read_failed");
    }
    const deliveries = candidates.map((candidate) => {
      try {
        return cloneSessionRuntimeProviderEffectIntent(candidate);
      } catch {
        throw safeError("session_id_acp_provider_drain_effect_invalid");
      }
    }).filter((candidate) => candidate.commandType === "session_runtime.submit_delivery"
      && candidate.effect.kind === "submit_delivery"
      && candidate.sessionExecutionAttemptId === sessionExecutionAttemptId);
    if (deliveries.length !== 1) {
      throw safeError("session_id_acp_provider_drain_delivery_intent_ambiguous");
    }
    return deliveries[0]!;
  }
}

function validateOptions(value: SessionIdAcpProviderDrainOptions): void {
  if (!value || typeof value !== "object"
    || typeof value.provider?.executeProviderEffect !== "function"
    || typeof value.providerEffects?.getProviderEffectIntent !== "function"
    || typeof value.providerEffects?.listProviderEffectIntents !== "function"
    || typeof value.resultOwner?.acceptEffectObservation !== "function"
    || typeof value.resultOwner?.acceptSettlement !== "function") {
    throw safeError("session_id_acp_provider_drain_options_invalid");
  }
}

function sameAttemptScope(
  left: SessionRuntimeProviderEffectIntentRecord,
  right: SessionRuntimeProviderEffectIntentRecord,
): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.logicalSessionId === right.logicalSessionId
    && left.sessionExecutionRuntimeId === right.sessionExecutionRuntimeId
    && left.sessionExecutionAttemptId === right.sessionExecutionAttemptId
    && left.bindingId === right.bindingId
    && left.bindingRevision === right.bindingRevision
    && left.executionProfileId === right.executionProfileId
    && left.profileRevisionId === right.profileRevisionId
    && left.inputSubmissionId === right.inputSubmissionId
    && left.orchestrationSessionTurnId === right.orchestrationSessionTurnId
    && left.effect.bindingHandle === right.effect.bindingHandle
    && left.effect.sessionExecutionAttemptId === right.effect.sessionExecutionAttemptId;
}

function sameIntent(
  left: SessionRuntimeProviderEffectIntentRecord,
  right: SessionRuntimeProviderEffectIntentRecord,
): boolean {
  return canonicalJson(left as unknown as JsonValue) === canonicalJson(right as unknown as JsonValue);
}

function exactDrainInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("session_id_acp_provider_drain_input_invalid");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !("providerEffectIntentId" in root)
    || typeof root.providerEffectIntentId !== "string"
    || !/^provider_effect_[A-Za-z0-9_-]+$/u.test(root.providerEffectIntentId)) {
    throw safeError("session_id_acp_provider_drain_input_invalid");
  }
  return root.providerEffectIntentId;
}

function validateProviderResult(
  value: AcpTaskSessionRuntimeProviderResult,
  intent: SessionRuntimeProviderEffectIntentRecord,
): AcpTaskSessionRuntimeProviderResult {
  try {
    assertSessionExecutionSafeValue(value, "ACP provider drain result");
  } catch {
    throw safeError("session_id_acp_provider_drain_result_invalid");
  }
  if (value.providerEffectIntentId !== intent.providerEffectIntentId
    || value.sessionExecutionAttemptId !== intent.sessionExecutionAttemptId) {
    throw safeError("session_id_acp_provider_drain_result_scope_mismatch");
  }
  const root = value as unknown as Record<string, unknown>;
  const expected = value.disposition === "settled"
    ? ["disposition", "providerEffectIntentId", "sessionExecutionAttemptId", "replayed", "settlement"]
    : value.disposition === "reconciling"
      ? ["disposition", "providerEffectIntentId", "sessionExecutionAttemptId", "reason"]
      : ["disposition", "providerEffectIntentId", "sessionExecutionAttemptId", "code"];
  if (Object.keys(root).length !== expected.length
    || Object.keys(root).some((key) => !expected.includes(key))) {
    throw safeError("session_id_acp_provider_drain_result_invalid");
  }
  return value;
}

function assertSettlementScope(
  settlement: SessionExecutionSettlementLike,
  intent: SessionRuntimeProviderEffectIntentRecord,
): void {
  if (settlement.sessionExecutionRuntimeId !== intent.sessionExecutionRuntimeId
    || settlement.sessionExecutionAttemptId !== intent.sessionExecutionAttemptId
    || settlement.taskId !== intent.taskId
    || settlement.runId !== intent.runId
    || settlement.logicalSessionId !== intent.logicalSessionId
    || settlement.bindingId !== intent.bindingId
    || settlement.bindingRevision !== intent.bindingRevision
    || settlement.executionProfileId !== intent.executionProfileId
    || settlement.profileRevisionId !== intent.profileRevisionId
    || settlement.inputSubmissionId !== intent.inputSubmissionId
    || settlement.orchestrationSessionTurnId !== intent.orchestrationSessionTurnId) {
    throw safeError("session_id_acp_provider_drain_settlement_scope_mismatch");
  }
}

type SessionExecutionSettlementLike = ReturnType<typeof cloneSessionExecutionSettlement>;

function interruptObservation(
  kind: "interrupt_accepted" | "interrupt_unknown" | "interrupt_rejected",
  intent: SessionRuntimeProviderEffectIntentRecord,
): SessionIdAcpEffectObservation {
  return Object.freeze({
    kind,
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
  });
}

function drainResult(
  disposition: SessionIdAcpProviderDrainResult["disposition"],
  intent: SessionRuntimeProviderEffectIntentRecord,
  reconciliationRequired: boolean,
): SessionIdAcpProviderDrainResult {
  return Object.freeze({
    disposition,
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    commandType: intent.commandType,
    reconciliationRequired,
  });
}

function safeError(code: string): SessionIdAcpProviderDrainError {
  return new SessionIdAcpProviderDrainError(code);
}
