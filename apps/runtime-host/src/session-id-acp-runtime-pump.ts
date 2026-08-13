import type {
  SessionIdAcpCardBindingEnsureResult,
  SessionIdAcpDeliveryStageResult,
  SessionIdAcpDrainableProviderEffect,
} from "@agent-workspace/runtime-application";
import type {
  SessionIdAcpProviderDrain,
  SessionIdAcpProviderDrainResult,
} from "./session-id-acp-provider-drain.js";

const LOGICAL_SESSION_ID = /^logical_session_[A-Za-z0-9_-]+$/u;
const ATTEMPT_ID = /^session_execution_attempt_[A-Za-z0-9_-]+$/u;
const PROVIDER_EFFECT_ID = /^provider_effect_[A-Za-z0-9_-]+$/u;

export type SessionIdAcpRuntimePumpResult =
  | Extract<SessionIdAcpDeliveryStageResult, { disposition: "idle" }>
  | Readonly<{
      disposition: "drained";
      stageDisposition: "staged" | "replay" | "already_staged";
      providerEffectIntentId: string;
      sessionExecutionAttemptId: string;
      providerDisposition: SessionIdAcpProviderDrainResult["disposition"];
      reconciliationRequired: boolean;
    }>;

export interface SessionIdAcpRuntimePumpDeliveryOwner {
  stageReadyDelivery(input: Readonly<{ logicalSessionId: string }>): SessionIdAcpDeliveryStageResult;
}

export interface SessionIdAcpRuntimePumpCardBindingOwner {
  ensureCurrentCardBinding(
    input: Readonly<{ logicalSessionId: string }>,
  ): SessionIdAcpCardBindingEnsureResult;
}

export interface SessionIdAcpRuntimePumpOrchestrationBridge {
  stageReconciliation(
    input: Readonly<{ sessionExecutionAttemptId: string }>,
  ): SessionIdAcpDrainableProviderEffect;
}

export type SessionIdAcpRuntimePumpOptions = Readonly<{
  deliveryOwner: SessionIdAcpRuntimePumpDeliveryOwner;
  cardBindingOwner: SessionIdAcpRuntimePumpCardBindingOwner;
  orchestrationBridge: SessionIdAcpRuntimePumpOrchestrationBridge;
  providerDrain: SessionIdAcpProviderDrain;
}>;

export type SessionIdAcpRuntimePump = Readonly<{
  pumpDelivery(input: Readonly<{ logicalSessionId: string }>): Promise<SessionIdAcpRuntimePumpResult>;
  reconcileAttempt(
    input: Readonly<{ sessionExecutionAttemptId: string }>,
  ): Promise<SessionIdAcpRuntimePumpResult>;
  drainStagedEffect(
    input: Readonly<{ providerEffectIntentId: string }>,
  ): Promise<SessionIdAcpRuntimePumpResult>;
}>;

export class SessionIdAcpRuntimePumpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SessionIdAcpRuntimePumpError";
    this.code = code;
  }
}

/**
 * Bounded Host scheduler seam. One call performs at most one Binding
 * materialization and one Provider drain; it never loops over the lane and
 * never writes owner state directly.
 */
export function createSessionIdAcpRuntimePump(
  options: SessionIdAcpRuntimePumpOptions,
): SessionIdAcpRuntimePump {
  validateOptions(options);
  const deliveryInFlight = new Map<string, Promise<SessionIdAcpRuntimePumpResult>>();
  const reconciliationInFlight = new Map<string, Promise<SessionIdAcpRuntimePumpResult>>();

  return Object.freeze({
    async pumpDelivery(value: Readonly<{ logicalSessionId: string }>) {
      const logicalSessionId = exactInput(value, "logicalSessionId", LOGICAL_SESSION_ID);
      const active = deliveryInFlight.get(logicalSessionId);
      if (active) return await active;
      const operation = pumpOneDelivery(logicalSessionId).finally(() => {
        deliveryInFlight.delete(logicalSessionId);
      });
      deliveryInFlight.set(logicalSessionId, operation);
      return await operation;
    },
    async reconcileAttempt(value: Readonly<{ sessionExecutionAttemptId: string }>) {
      const sessionExecutionAttemptId = exactInput(
        value,
        "sessionExecutionAttemptId",
        ATTEMPT_ID,
      );
      const active = reconciliationInFlight.get(sessionExecutionAttemptId);
      if (active) return await active;
      const operation = reconcileOneAttempt(sessionExecutionAttemptId).finally(() => {
        reconciliationInFlight.delete(sessionExecutionAttemptId);
      });
      reconciliationInFlight.set(sessionExecutionAttemptId, operation);
      return await operation;
    },
    async drainStagedEffect(value: Readonly<{ providerEffectIntentId: string }>) {
      const providerEffectIntentId = exactInput(
        value,
        "providerEffectIntentId",
        PROVIDER_EFFECT_ID,
      );
      const drained = await options.providerDrain.drain({ providerEffectIntentId });
      assertDrainScope(drained, providerEffectIntentId);
      return projectDrain("already_staged", drained);
    },
  });

  async function pumpOneDelivery(logicalSessionId: string): Promise<SessionIdAcpRuntimePumpResult> {
    let staged = options.deliveryOwner.stageReadyDelivery({ logicalSessionId });
    if (staged.disposition === "idle" && staged.reason === "binding_not_ready") {
      const ensured = options.cardBindingOwner.ensureCurrentCardBinding({ logicalSessionId });
      if (ensured.logicalSessionId !== logicalSessionId) {
        throw safeError("session_id_acp_runtime_pump_binding_scope_mismatch");
      }
      staged = options.deliveryOwner.stageReadyDelivery({ logicalSessionId });
      if (staged.disposition === "idle" && staged.reason === "binding_not_ready") {
        throw safeError("session_id_acp_runtime_pump_binding_not_ready");
      }
    }
    if (staged.disposition === "idle") return Object.freeze({ ...staged });
    const drained = await options.providerDrain.drain({
      providerEffectIntentId: staged.providerEffectIntentId,
    });
    assertStagedDrainScope(
      staged,
      drained,
      "session_runtime.submit_delivery",
    );
    return projectDrain(staged.disposition, drained);
  }

  async function reconcileOneAttempt(
    sessionExecutionAttemptId: string,
  ): Promise<SessionIdAcpRuntimePumpResult> {
    const staged = options.orchestrationBridge.stageReconciliation({
      sessionExecutionAttemptId,
    });
    if (staged.commandType !== "session_runtime.reconcile_attempt"
      || staged.sessionExecutionAttemptId !== sessionExecutionAttemptId) {
      throw safeError("session_id_acp_runtime_pump_reconciliation_scope_mismatch");
    }
    const drained = await options.providerDrain.drain({
      providerEffectIntentId: staged.providerEffectIntentId,
    });
    assertStagedDrainScope(staged, drained, staged.commandType);
    return projectDrain(staged.disposition, drained);
  }
}

function validateOptions(value: SessionIdAcpRuntimePumpOptions): void {
  if (!value || typeof value !== "object"
    || typeof value.deliveryOwner?.stageReadyDelivery !== "function"
    || typeof value.cardBindingOwner?.ensureCurrentCardBinding !== "function"
    || typeof value.orchestrationBridge?.stageReconciliation !== "function"
    || typeof value.providerDrain?.drain !== "function") {
    throw safeError("session_id_acp_runtime_pump_options_invalid");
  }
}

function exactInput(value: unknown, key: string, pattern: RegExp): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("session_id_acp_runtime_pump_input_invalid");
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !(key in root)
    || typeof root[key] !== "string" || !pattern.test(root[key])) {
    throw safeError("session_id_acp_runtime_pump_input_invalid");
  }
  return root[key];
}

function assertStagedDrainScope(
  staged: Readonly<{
    providerEffectIntentId: string;
    sessionExecutionAttemptId: string;
  }>,
  drained: SessionIdAcpProviderDrainResult,
  expectedCommandType: SessionIdAcpProviderDrainResult["commandType"],
): void {
  if (drained.providerEffectIntentId !== staged.providerEffectIntentId
    || drained.sessionExecutionAttemptId !== staged.sessionExecutionAttemptId
    || drained.commandType !== expectedCommandType) {
    throw safeError("session_id_acp_runtime_pump_drain_scope_mismatch");
  }
}

function assertDrainScope(
  drained: SessionIdAcpProviderDrainResult,
  providerEffectIntentId: string,
): void {
  if (drained.providerEffectIntentId !== providerEffectIntentId) {
    throw safeError("session_id_acp_runtime_pump_drain_scope_mismatch");
  }
}

function projectDrain(
  stageDisposition: "staged" | "replay" | "already_staged",
  drained: SessionIdAcpProviderDrainResult,
): SessionIdAcpRuntimePumpResult {
  return Object.freeze({
    disposition: "drained" as const,
    stageDisposition,
    providerEffectIntentId: drained.providerEffectIntentId,
    sessionExecutionAttemptId: drained.sessionExecutionAttemptId,
    providerDisposition: drained.disposition,
    reconciliationRequired: drained.reconciliationRequired,
  });
}

function safeError(code: string): SessionIdAcpRuntimePumpError {
  return new SessionIdAcpRuntimePumpError(code);
}
