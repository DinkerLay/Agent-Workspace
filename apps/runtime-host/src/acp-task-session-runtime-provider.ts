import {
  assertSessionExecutionSafeValue,
  cloneAcpV3BindingRetirementIntentRecord,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionExecutionSettlement,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type { SessionExecutionRuntimeOwner } from "@agent-workspace/runtime-application";
import type {
  AcpSessionRuntimeRepositories,
  AcpV3FrozenProfileTuple,
  AcpV3FrozenProfileTupleResolver,
} from "@agent-workspace/runtime-store";

const PROVIDER_EFFECT_ID = /^provider_effect_[A-Za-z0-9_-]{1,223}$/u;
const BINDING_RETIREMENT_ID = /^binding_retirement_[A-Za-z0-9_-]{1,223}$/u;
const SESSION_EXECUTION_ATTEMPT_ID = /^session_execution_attempt_[A-Za-z0-9_-]{1,223}$/u;
const SAFE_CODE = /^acp_[a-z0-9_]{1,223}$/u;
const MINIMUM_DEADLINE_MS = 1;
const MAXIMUM_DEADLINE_MS = 10 * 60_000;

export type AcpTaskSessionRuntimeInterruptCorrelation = Readonly<{
  readonly sessionControlAuditId: string;
  readonly sessionExecutionAttemptId: string;
  readonly orchestrationSessionTurnId: string;
}>;

export type AcpTaskSessionRuntimeInterruptCorrelationResolution =
  | AcpTaskSessionRuntimeInterruptCorrelation
  | Readonly<{ readonly status: "ambiguous" }>
  | undefined;

export type AcpTaskSessionRuntimeNativeFinalCandidate = Readonly<{
  readonly candidateObservationId: string;
  readonly content: string;
  readonly contentDigest: string;
}>;

export type AcpTaskSessionRuntimeNativeTerminal = Readonly<{
  readonly terminalObservationId: string;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly receiptDigest: string;
}>;

export type AcpTaskSessionRuntimeNativeInteractionResolution = Readonly<{
  readonly interactionId: string;
  readonly choiceId: string;
  readonly expectedInteractionRevision: number;
}>;

export type AcpTaskSessionRuntimeNativeOutcome =
  | Readonly<{
      readonly status: "settled";
      readonly bindingHandle: string;
      readonly sessionExecutionAttemptId: string;
      readonly receiptDigest: string;
      readonly interactionResolution?: AcpTaskSessionRuntimeNativeInteractionResolution;
      readonly finalCandidate?: AcpTaskSessionRuntimeNativeFinalCandidate;
      readonly terminal: AcpTaskSessionRuntimeNativeTerminal;
    }>
  | Readonly<{
      readonly status: "reconciling";
      readonly bindingHandle: string;
      readonly sessionExecutionAttemptId: string;
      readonly reason: "provider_outcome_unknown";
    }>
  | Readonly<{
      readonly status: "rejected";
      readonly bindingHandle: string;
      readonly sessionExecutionAttemptId: string;
      readonly code: string;
    }>;

export type AcpTaskSessionRuntimeNativeEffectScope = Readonly<{
  readonly bindingHandle: string;
  readonly sessionExecutionAttemptId: string;
  readonly signal: AbortSignal;
}>;

export type AcpTaskSessionRuntimeNativeDeliveryReceipt = Readonly<{
  readonly bindingHandle: string;
  readonly sessionExecutionAttemptId: string;
  readonly receiptDigest: string;
}>;

/**
 * Safe provider-neutral observation for a final candidate which may precede
 * the prompt terminal. Awaiting its callback is the durability boundary: it
 * records only SR-owned Attempt state and never projects an OR `agent_final`.
 */
export type AcpTaskSessionRuntimeNativeFinalCandidateObservation = Readonly<{
  readonly bindingHandle: string;
  readonly sessionExecutionAttemptId: string;
  readonly receiptDigest: string;
  readonly candidateObservationId: string;
  readonly content: string;
  readonly contentDigest: string;
}>;

/** Safe receipt projection emitted only after the SR receipt write committed. */
export type AcpTaskSessionRuntimeDeliveryReceipt = Readonly<{
  readonly providerEffectIntentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly logicalSessionId: string;
  readonly sessionExecutionRuntimeId: string;
  readonly sessionExecutionAttemptId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly executionProfileId: string;
  readonly profileRevisionId: string;
  readonly bindingHandle: string;
  readonly inputSubmissionId: string;
  readonly orchestrationSessionTurnId: string;
  readonly receiptDigest: string;
}>;

/** Every effect method settles after abort only once its own effect is quiescent. */
export interface AcpTaskSessionRuntimeNativeBinding {
  readonly bindingHandle: string;
  readonly submitDelivery: (
    input: AcpTaskSessionRuntimeNativeEffectScope & Readonly<{ readonly content: string }>,
  ) => Promise<AcpTaskSessionRuntimeNativeOutcome>;
  readonly reconcileAttempt: (
    input: AcpTaskSessionRuntimeNativeEffectScope,
  ) => Promise<AcpTaskSessionRuntimeNativeOutcome>;
  readonly requestInterrupt?: (
    input: AcpTaskSessionRuntimeNativeEffectScope & Readonly<{ readonly sessionControlAuditId: string }>,
  ) => Promise<AcpTaskSessionRuntimeNativeOutcome>;
  readonly respondInteraction?: (
    input: AcpTaskSessionRuntimeNativeEffectScope & Readonly<{
      readonly interactionId: string;
      readonly choiceId: string;
    }>,
  ) => Promise<AcpTaskSessionRuntimeNativeOutcome>;
  readonly cancelTimedOutEffect?: (input: AcpTaskSessionRuntimeNativeEffectScope) => Promise<void>;
  /** Must resolve only after native Binding/process cleanup is confirmed. */
  readonly retire: (input: Readonly<{ readonly signal: AbortSignal }>) => Promise<void>;
  /** Must resolve only after provider-specific route/plan cleanup is confirmed. */
  readonly close: (input: Readonly<{ readonly signal: AbortSignal }>) => Promise<void>;
}

export type AcpTaskSessionRuntimeProviderResult =
  | Readonly<{
      readonly disposition: "settled";
      readonly providerEffectIntentId: string;
      readonly sessionExecutionAttemptId: string;
      readonly replayed: boolean;
      readonly settlement: SessionExecutionSettlement;
    }>
  | Readonly<{
      readonly disposition: "reconciling";
      readonly providerEffectIntentId: string;
      readonly sessionExecutionAttemptId: string;
      readonly reason:
        | "native_outcome_unknown"
        | "native_effect_rejected"
        | "native_effect_failed"
        | "native_effect_timeout"
        | "interrupt_native_binding_not_active";
    }>
  | Readonly<{
      readonly disposition: "rejected";
      readonly providerEffectIntentId: string;
      readonly sessionExecutionAttemptId: string;
      readonly code:
        | "acp_task_session_provider_effect_suppressed"
        | "acp_task_session_interrupt_correlation_missing"
        | "acp_task_session_interrupt_correlation_ambiguous"
        | "acp_task_session_interrupt_correlation_mismatch"
        | "acp_task_session_interrupt_unsupported"
        | "acp_task_session_interaction_unsupported";
    }>;

export type AcpTaskSessionRuntimeProvider = Readonly<{
  executeProviderEffect(providerEffectIntentId: string): Promise<AcpTaskSessionRuntimeProviderResult>;
  /** Task Stop retirement: requires an exact task_stop Control. */
  retireBinding(bindingRetirementIntentId: string): Promise<AcpTaskSessionRuntimeBindingRetirementResult>;
  /** Session close retirement: requires an exact current-generation close Control. */
  retireBindingForClose(bindingRetirementIntentId: string): Promise<AcpTaskSessionRuntimeBindingRetirementResult>;
  close(): Promise<void>;
}>;

export type AcpTaskSessionRuntimeProviderDiagnostic = Readonly<{
  readonly code: string;
  readonly stage: "native_open" | "native_effect_fence" | "native_effect" | "native_recovery";
}>;

export type AcpTaskSessionRuntimeBindingRetirementResult = Readonly<{
  readonly disposition: "released";
  readonly bindingRetirementIntentId: string;
  readonly bindingId: string;
  readonly replayed: boolean;
}>;

export type AcpTaskSessionRuntimeTaskStopControlResolution = Readonly<{
  readonly kind: "task_stop";
  readonly state: "requested" | "accepted";
}>;

export type AcpTaskSessionRuntimeCloseControlResolution = Readonly<{
  readonly kind: "close";
  readonly state: "requested";
}>;

export type AcpTaskSessionRuntimeProviderOptions = Readonly<{
  readonly repositories: AcpSessionRuntimeRepositories;
  readonly sessionRuntimeOwner: SessionExecutionRuntimeOwner;
  /** Reads the immutable Task/Run-owned v3 architecture tuple; a Provider may never default it. */
  readonly resolveFrozenProfileTuple: AcpV3FrozenProfileTupleResolver;
  /** Reads the OR-owned Control + Turn to current SR Attempt correlation. */
  readonly resolveInterruptCorrelation: (
    scope: Readonly<{
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionControlAuditId: string;
      readonly sessionExecutionAttemptId: string;
      readonly orchestrationSessionTurnId: string;
    }>,
  ) => AcpTaskSessionRuntimeInterruptCorrelationResolution;
  /**
   * OR-owned result seam. It is invoked after the exact SR receipt commits and
   * before the native prompt is allowed to finish publishing later facts.
   */
  readonly onDeliveryReceipt: (
    receipt: AcpTaskSessionRuntimeDeliveryReceipt,
  ) => void | Promise<void>;
  /**
   * Must honor `signal`: rejection after abort confirms no live resource;
   * late resolution returns the exact resource so this owner can retire it.
   */
  readonly openNativeBinding: (
    input: Readonly<{
      readonly binding: AcpSafeSessionBindingRecordV3;
      readonly profile: AcpV3FrozenProfileTuple;
      readonly observeDeliveryReceipt: (
        receipt: AcpTaskSessionRuntimeNativeDeliveryReceipt,
      ) => Promise<void>;
      readonly observeFinalCandidate: (
        observation: AcpTaskSessionRuntimeNativeFinalCandidateObservation,
      ) => Promise<void>;
      readonly signal: AbortSignal;
    }>,
  ) => Promise<AcpTaskSessionRuntimeNativeBinding>;
  /** Required by `retireBinding`; an absent or stale OR-owned task_stop Control fails before native effect. */
  readonly resolveTaskStopControl?: (
    scope: Readonly<{
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionControlAuditId: string;
      readonly idempotencyKey: string;
    }>,
  ) => AcpTaskSessionRuntimeTaskStopControlResolution | undefined;
  /**
   * Required only by `retireBindingForClose`. The resolver must verify the
   * OR-owned close Control and Task/Run-owned exact current generation/slot
   * against every supplied Binding/Profile field before returning a proof.
   */
  readonly resolveCloseControl?: (
    scope: Readonly<{
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionControlAuditId: string;
      readonly idempotencyKey: string;
      readonly bindingId: string;
      readonly bindingRevision: number;
      readonly executionProfileId: string;
      readonly profileRevisionId: string;
      readonly providerFamily: AcpV3BindingRetirementIntentRecord["providerFamily"];
    }>,
  ) => AcpTaskSessionRuntimeCloseControlResolution | undefined;
  /**
   * Required only for a persisted `retiring` intent. It must return true solely
   * under the supervisor-issued confirmed-dead predecessor Host authority.
   */
  readonly authorizeRetiringBindingRecovery?: (
    intent: AcpV3BindingRetirementIntentRecord,
  ) => boolean;
  readonly now?: () => string;
  /** Applies independently to open/load, submit, cancel, reconcile, retire and close. */
  readonly effectDeadlineMs: number;
  /** Host-process-only safe stage diagnostics; never persisted or bridged. */
  readonly onDiagnostic?: (diagnostic: AcpTaskSessionRuntimeProviderDiagnostic) => void;
}>;

export class AcpTaskSessionRuntimeProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpTaskSessionRuntimeProviderError";
    this.code = code;
  }
}

/**
 * Host-owned provider-neutral bridge from durable Session Runtime intents to
 * one provider-specific ACP native Binding. The durable reliability/Attempt
 * repositories remain replay truth; the maps below only guard concurrent
 * calls and live native resources inside this Host epoch.
 */
export function createAcpTaskSessionRuntimeProvider(
  options: AcpTaskSessionRuntimeProviderOptions,
): AcpTaskSessionRuntimeProvider {
  validateOptions(options);
  const nativeBindings = new Map<string, Promise<AcpTaskSessionRuntimeNativeBinding>>();
  const inFlight = new Map<string, Promise<AcpTaskSessionRuntimeProviderResult>>();
  const inFlightBindingHandles = new Map<string, string>();
  const inFlightRetirements = new Map<string, Promise<AcpTaskSessionRuntimeBindingRetirementResult>>();
  const retiringBindingHandles = new Set<string>();
  const activeNativeSubmitAttempts = new Set<string>();
  const issuedInterruptControls = new Set<string>();
  const cleanedBindings = new WeakSet<object>();
  const receiptDigests = new Map<string, string>();
  const publishedReceipts = new Set<string>();
  const receiptCommits = new Map<string, Promise<void>>();
  const finalCandidateCommits = new Map<string, Promise<void>>();
  const finalCandidateFingerprints = new Map<string, string>();
  let closed = false;
  let poisonedCode: string | undefined;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    executeProviderEffect(value) {
      let providerEffectIntentId: string;
      try {
        ensureAvailable();
        providerEffectIntentId = requiredProviderEffectIntentId(value);
      } catch (error) {
        return Promise.reject(error);
      }
      const pending = inFlight.get(providerEffectIntentId);
      if (pending) return pending;
      const execution = execute(providerEffectIntentId).finally(() => {
        inFlight.delete(providerEffectIntentId);
        inFlightBindingHandles.delete(providerEffectIntentId);
      });
      inFlight.set(providerEffectIntentId, execution);
      return execution;
    },
    retireBinding(value) {
      let bindingRetirementIntentId: string;
      try {
        ensureAvailable();
        bindingRetirementIntentId = requiredBindingRetirementIntentId(value);
      } catch (error) {
        return Promise.reject(error);
      }
      const pending = inFlightRetirements.get(bindingRetirementIntentId);
      if (pending) return pending;
      const execution = executeBindingRetirement(bindingRetirementIntentId, "task_stop").finally(() => {
        inFlightRetirements.delete(bindingRetirementIntentId);
      });
      inFlightRetirements.set(bindingRetirementIntentId, execution);
      return execution;
    },
    retireBindingForClose(value) {
      let bindingRetirementIntentId: string;
      try {
        ensureAvailable();
        bindingRetirementIntentId = requiredBindingRetirementIntentId(value);
      } catch (error) {
        return Promise.reject(error);
      }
      const pending = inFlightRetirements.get(bindingRetirementIntentId);
      if (pending) return pending;
      const execution = executeBindingRetirement(bindingRetirementIntentId, "close").finally(() => {
        inFlightRetirements.delete(bindingRetirementIntentId);
      });
      inFlightRetirements.set(bindingRetirementIntentId, execution);
      return execution;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...inFlight.values(), ...inFlightRetirements.values()]);
        let cleanupFailed = false;
        for (const [bindingHandle, pending] of [...nativeBindings]) {
          let native: AcpTaskSessionRuntimeNativeBinding | undefined;
          try {
            native = await pending;
          } catch {
            cleanupFailed = true;
          }
          if (native) {
            try {
              await cleanupNativeBinding(native);
            } catch {
              cleanupFailed = true;
            }
          }
          nativeBindings.delete(bindingHandle);
        }
        if (cleanupFailed) {
          poisonedCode = "acp_task_session_cleanup_unconfirmed";
          throw safeError(poisonedCode);
        }
      })();
      return closePromise;
    },
  });

  async function executeBindingRetirement(
    bindingRetirementIntentId: string,
    cause: "task_stop" | "close",
  ): Promise<AcpTaskSessionRuntimeBindingRetirementResult> {
    let intent = requiredBindingRetirementIntent(bindingRetirementIntentId);
    if (intent.state === "released") return retirementResult(intent, true);
    if (intent.state === "unknown") throw safeError("acp_task_session_binding_retirement_unknown");

    assertBindingRetirementControl(intent, cause);
    assertCurrentRetirementFence(intent);
    if (intent.state === "retiring") {
      let authorized = false;
      try {
        authorized = options.authorizeRetiringBindingRecovery?.(intent) === true;
      } catch {
        throw safeError("acp_task_session_binding_retirement_recovery_authority_failed");
      }
      if (!authorized) throw safeError("acp_task_session_binding_retirement_in_progress");
    }
    try {
      intent = options.repositories.reliability.claimBindingRetirementIntent({
        bindingRetirementIntentId,
        expectedRevision: intent.revision,
        mode: intent.state === "pending" ? "initial" : "confirmed_dead_host_recovery",
        updatedAt: providerNow(),
      });
    } catch {
      throw safeError("acp_task_session_binding_retirement_claim_failed");
    }

    // Recheck all external owner truth after the durable claim and immediately
    // before the first operation which may create or touch a native Binding.
    retiringBindingHandles.add(intent.bindingHandle);
    await Promise.allSettled([...inFlight.entries()]
      .filter(([providerEffectIntentId]) =>
        inFlightBindingHandles.get(providerEffectIntentId) === intent.bindingHandle)
      .map(([, operation]) => operation));
    if (poisonedCode) throw safeError(poisonedCode);
    assertBindingRetirementControl(intent, cause);
    const context = assertCurrentRetirementFence(intent);
    let native: AcpTaskSessionRuntimeNativeBinding | undefined;
    try {
      native = await openBindingForRetirement(intent, context);
      await cleanupNativeBinding(native);
      nativeBindings.delete(intent.bindingHandle);
    } catch {
      nativeBindings.delete(intent.bindingHandle);
      try {
        options.repositories.reliability.settleBindingRetirementUnknown({
          bindingRetirementIntentId,
          expectedRevision: intent.revision,
          failureCode: "acp_binding_retirement_cleanup_unconfirmed",
          updatedAt: providerNow(),
        });
      } catch {
        // The provider still poisons below; a fresh Host must reconcile the
        // durable retiring row only under confirmed-dead predecessor authority.
      }
      poisonedCode = "acp_task_session_cleanup_unconfirmed";
      throw safeError(poisonedCode);
    }

    let released: AcpV3BindingRetirementIntentRecord;
    try {
      released = options.repositories.transaction((owners) => {
        const current = owners.binding.getCurrentBinding(intent.logicalSessionId);
        if (!current
          || current.bindingId !== intent.bindingId
          || current.revision !== intent.bindingRevision
          || current.bindingHandle !== intent.bindingHandle) {
          throw new Error("retirement_binding_fence_changed");
        }
        const releasedAt = providerNow();
        owners.binding.updateBinding({
          ...current,
          status: "released",
          recoverable: false,
          revision: current.revision + 1,
          updatedAt: releasedAt,
        }, current.revision);
        return owners.reliability.settleBindingRetirementReleased({
          bindingRetirementIntentId,
          expectedRevision: intent.revision,
          releasedAt,
        });
      });
    } catch {
      poisonedCode = "acp_task_session_binding_retirement_commit_failed";
      throw safeError(poisonedCode);
    }
    return retirementResult(released, false);
  }

  function requiredBindingRetirementIntent(
    bindingRetirementIntentId: string,
  ): AcpV3BindingRetirementIntentRecord {
    let persisted: AcpV3BindingRetirementIntentRecord | undefined;
    try {
      persisted = options.repositories.reliability.getBindingRetirementIntent(bindingRetirementIntentId);
    } catch {
      throw safeError("acp_task_session_binding_retirement_intent_read_failed");
    }
    if (!persisted) throw safeError("acp_task_session_binding_retirement_intent_not_found");
    try {
      return cloneAcpV3BindingRetirementIntentRecord(persisted);
    } catch {
      throw safeError("acp_task_session_binding_retirement_intent_invalid");
    }
  }

  function assertTaskStopControl(intent: AcpV3BindingRetirementIntentRecord): void {
    if (typeof options.resolveTaskStopControl !== "function") {
      throw safeError("acp_task_session_task_stop_control_resolver_required");
    }
    let resolution: AcpTaskSessionRuntimeTaskStopControlResolution | undefined;
    try {
      resolution = options.resolveTaskStopControl({
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        sessionControlAuditId: intent.sessionControlAuditId,
        idempotencyKey: intent.idempotencyKey,
      });
    } catch {
      throw safeError("acp_task_session_task_stop_control_read_failed");
    }
    try {
      assertSessionExecutionSafeValue(resolution, "ACP Task Stop control resolution");
    } catch {
      throw safeError("acp_task_session_task_stop_control_invalid");
    }
    if (!resolution || Object.keys(resolution).sort().join(",") !== "kind,state"
      || resolution.kind !== "task_stop"
      || (resolution.state !== "requested" && resolution.state !== "accepted")) {
      throw safeError("acp_task_session_task_stop_control_not_current");
    }
  }

  function assertCloseControl(intent: AcpV3BindingRetirementIntentRecord): void {
    if (typeof options.resolveCloseControl !== "function") {
      throw safeError("acp_task_session_close_control_resolver_required");
    }
    let resolution: AcpTaskSessionRuntimeCloseControlResolution | undefined;
    try {
      resolution = options.resolveCloseControl({
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        sessionControlAuditId: intent.sessionControlAuditId,
        idempotencyKey: intent.idempotencyKey,
        bindingId: intent.bindingId,
        bindingRevision: intent.bindingRevision,
        executionProfileId: intent.executionProfileId,
        profileRevisionId: intent.profileRevisionId,
        providerFamily: intent.providerFamily,
      });
    } catch {
      throw safeError("acp_task_session_close_control_read_failed");
    }
    try {
      assertSessionExecutionSafeValue(resolution, "ACP close control resolution");
    } catch {
      throw safeError("acp_task_session_close_control_invalid");
    }
    if (!resolution || Object.keys(resolution).sort().join(",") !== "kind,state"
      || resolution.kind !== "close"
      || resolution.state !== "requested") {
      throw safeError("acp_task_session_close_control_not_current");
    }
  }

  function assertBindingRetirementControl(
    intent: AcpV3BindingRetirementIntentRecord,
    cause: "task_stop" | "close",
  ): void {
    if (cause === "task_stop") assertTaskStopControl(intent);
    else assertCloseControl(intent);
  }

  function assertCurrentRetirementFence(
    intent: AcpV3BindingRetirementIntentRecord,
  ): Readonly<{ binding: AcpSafeSessionBindingRecordV3; profile: AcpV3FrozenProfileTuple }> {
    let binding: AcpSafeSessionBindingRecordV3 | undefined;
    try {
      binding = options.repositories.binding.getCurrentBinding(intent.logicalSessionId);
    } catch {
      throw safeError("acp_task_session_current_binding_read_failed");
    }
    if (!binding || binding.bindingId !== intent.bindingId) {
      throw safeError("acp_task_session_binding_not_current");
    }
    if (binding.revision !== intent.bindingRevision) throw safeError("acp_task_session_binding_revision_stale");
    if ((binding.status !== "active" && binding.status !== "recovering")
      || binding.taskId !== intent.taskId
      || binding.runId !== intent.runId
      || binding.logicalSessionId !== intent.logicalSessionId
      || binding.bindingHandle !== intent.bindingHandle
      || binding.executionProfileId !== intent.executionProfileId
      || binding.profileRevisionId !== intent.profileRevisionId
      || binding.providerFamily !== intent.providerFamily) {
      throw safeError("acp_task_session_binding_scope_mismatch");
    }
    let profile: AcpV3FrozenProfileTuple | undefined;
    try {
      profile = options.resolveFrozenProfileTuple({
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        executionProfileId: intent.executionProfileId,
      });
    } catch {
      throw safeError("acp_task_session_frozen_profile_read_failed");
    }
    if (!profile || profile.schemaVersion !== 3
      || profile.executionProfileId !== intent.executionProfileId
      || profile.profileRevisionId !== intent.profileRevisionId
      || profile.providerFamily !== intent.providerFamily) {
      throw safeError("acp_task_session_frozen_profile_mismatch");
    }
    return Object.freeze({ binding, profile });
  }

  async function openBindingForRetirement(
    intent: AcpV3BindingRetirementIntentRecord,
    context: Readonly<{ binding: AcpSafeSessionBindingRecordV3; profile: AcpV3FrozenProfileTuple }>,
  ): Promise<AcpTaskSessionRuntimeNativeBinding> {
    const existing = nativeBindings.get(intent.bindingHandle);
    if (existing) return existing;
    const pending = boundedEffect(
      (signal) => options.openNativeBinding({
        binding: context.binding,
        profile: context.profile,
        observeDeliveryReceipt: async () => {
          throw safeError("acp_task_session_retirement_receipt_forbidden");
        },
        observeFinalCandidate: async () => {
          throw safeError("acp_task_session_retirement_final_candidate_forbidden");
        },
        signal,
      }),
      "acp_task_session_native_open_timeout",
    ).then((native) => {
      if (!isNativeBinding(native) || native.bindingHandle !== intent.bindingHandle) {
        throw safeError("acp_task_session_native_binding_invalid");
      }
      return native;
    }).catch(async (error) => {
      nativeBindings.delete(intent.bindingHandle);
      if (isDeadlineError(error) && isNativeBinding(error.lateValue)) {
        try { await cleanupNativeBinding(error.lateValue); } catch { /* outer retirement path poisons */ }
      }
      throw error;
    });
    nativeBindings.set(intent.bindingHandle, pending);
    return pending;
  }

  function providerNow(): string {
    const value = options.now?.() ?? new Date().toISOString();
    if (typeof value !== "string" || new Date(value).toISOString() !== value) {
      throw safeError("acp_task_session_time_invalid");
    }
    return value;
  }

  async function execute(providerEffectIntentId: string): Promise<AcpTaskSessionRuntimeProviderResult> {
    const intent = requiredIntent(providerEffectIntentId);
    inFlightBindingHandles.set(providerEffectIntentId, intent.effect.bindingHandle);
    if (intent.state === "suppressed") {
      return rejectedResult(intent, "acp_task_session_provider_effect_suppressed");
    }
    if (retiringBindingHandles.has(intent.effect.bindingHandle)) {
      throw safeError("acp_task_session_binding_retirement_in_progress");
    }
    const initialAttempt = requiredAttempt(intent);
    if (initialAttempt.settlement) return settledResult(intent, initialAttempt.settlement, true);
    assertCurrentExecutionFence(intent, initialAttempt);

    if (intent.effect.kind === "submit_delivery") {
      if (initialAttempt.state !== "awaiting_receipt") {
        return reconcileOnly(intent);
      }
      // This owner transaction is deliberately synchronous and precedes the
      // first await which could open/load a native Binding or submit a prompt.
      markReconciliation(intent, initialAttempt);
      return dispatchNative(intent, "submit");
    }

    if (intent.effect.kind === "reconcile_attempt") {
      return reconcileOnly(intent);
    }

    if (intent.effect.kind === "request_interrupt") {
      return requestInterrupt(intent, initialAttempt);
    }

    return respondInteraction(intent, initialAttempt);
  }

  async function requestInterrupt(
    intent: SessionRuntimeProviderEffectIntentRecord,
    attempt: SessionExecutionAttemptRecord,
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    const effect = intent.effect;
    if (effect.kind !== "request_interrupt" || !intent.sessionControlAuditId) {
      throw safeError("acp_task_session_effect_kind_invalid");
    }
    let correlation: AcpTaskSessionRuntimeInterruptCorrelationResolution;
    try {
      correlation = options.resolveInterruptCorrelation({
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        sessionControlAuditId: intent.sessionControlAuditId,
        sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
        orchestrationSessionTurnId: intent.orchestrationSessionTurnId,
      });
    } catch {
      throw safeError("acp_task_session_interrupt_correlation_resolution_failed");
    }
    if (!correlation) {
      return rejectedResult(intent, "acp_task_session_interrupt_correlation_missing");
    }
    if (isAmbiguousInterruptCorrelation(correlation)) {
      return rejectedResult(intent, "acp_task_session_interrupt_correlation_ambiguous");
    }
    try {
      assertSessionExecutionSafeValue(correlation, "ACP Task interrupt correlation");
    } catch {
      throw safeError("acp_task_session_interrupt_correlation_invalid");
    }
    if (correlation.sessionControlAuditId !== intent.sessionControlAuditId
      || correlation.sessionExecutionAttemptId !== intent.sessionExecutionAttemptId
      || correlation.orchestrationSessionTurnId !== intent.orchestrationSessionTurnId) {
      return rejectedResult(intent, "acp_task_session_interrupt_correlation_mismatch");
    }
    if (attempt.settlement) return settledResult(intent, attempt.settlement, true);

    const liveBinding = nativeBindings.get(effect.bindingHandle);
    if (!liveBinding || !activeNativeSubmitAttempts.has(intent.sessionExecutionAttemptId)) {
      markReconciliationIfNeeded(intent, attempt);
      const reconciled = await reconcileOnly(intent);
      return reconciled.disposition === "reconciling"
        ? Object.freeze({ ...reconciled, reason: "interrupt_native_binding_not_active" })
        : reconciled;
    }
    if (issuedInterruptControls.has(intent.sessionControlAuditId)) {
      return reconcileOnly(intent);
    }
    issuedInterruptControls.add(intent.sessionControlAuditId);
    markReconciliationIfNeeded(intent, attempt);
    let native: AcpTaskSessionRuntimeNativeBinding;
    try {
      native = await liveBinding;
    } catch {
      return reconcilingResult(intent, "native_effect_failed");
    }
    if (!native.requestInterrupt) {
      return rejectedResult(intent, "acp_task_session_interrupt_unsupported");
    }
    return dispatchOnNative(intent, native, (signal) => native.requestInterrupt!({
      bindingHandle: effect.bindingHandle,
      sessionExecutionAttemptId: effect.sessionExecutionAttemptId,
      sessionControlAuditId: effect.sessionControlAuditId,
      signal,
    }));
  }

  async function respondInteraction(
    intent: SessionRuntimeProviderEffectIntentRecord,
    attempt: SessionExecutionAttemptRecord,
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    const effect = intent.effect;
    if (effect.kind !== "respond_interaction") throw safeError("acp_task_session_effect_kind_invalid");
    const interaction = attempt.interactions.find(({ interactionId }) => interactionId === effect.interactionId);
    if (!interaction || interaction.status !== "requested" || attempt.state !== "waiting_for_interaction") {
      return reconcileOnly(intent);
    }
    markReconciliation(intent, attempt);
    const native = await openBindingForIntent(intent);
    if (!native.respondInteraction) {
      return rejectedResult(intent, "acp_task_session_interaction_unsupported");
    }
    return dispatchOnNative(intent, native, (signal) => native.respondInteraction!({
      bindingHandle: effect.bindingHandle,
      sessionExecutionAttemptId: effect.sessionExecutionAttemptId,
      interactionId: effect.interactionId,
      choiceId: effect.choiceId,
      signal,
    }));
  }

  async function dispatchNative(
    intent: SessionRuntimeProviderEffectIntentRecord,
    action: "submit",
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    let native: AcpTaskSessionRuntimeNativeBinding;
    try {
      native = await openBindingForIntent(intent);
    } catch (error) {
      return recoverAfterNativeFailure(intent, undefined, error);
    }
    const effect = intent.effect;
    if (action !== "submit" || effect.kind !== "submit_delivery") {
      throw safeError("acp_task_session_effect_kind_invalid");
    }
    return dispatchOnNative(intent, native, async (signal) => {
      activeNativeSubmitAttempts.add(intent.sessionExecutionAttemptId);
      try {
        return await native.submitDelivery({
          bindingHandle: effect.bindingHandle,
          sessionExecutionAttemptId: effect.sessionExecutionAttemptId,
          content: effect.content,
          signal,
        });
      } finally {
        activeNativeSubmitAttempts.delete(intent.sessionExecutionAttemptId);
      }
    });
  }

  async function reconcileOnly(
    intent: SessionRuntimeProviderEffectIntentRecord,
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    const attempt = requiredAttempt(intent);
    if (attempt.settlement) return settledResult(intent, attempt.settlement, true);
    markReconciliationIfNeeded(intent, attempt);
    let native: AcpTaskSessionRuntimeNativeBinding;
    try {
      native = await openBindingForIntent(intent);
    } catch (error) {
      return recoverAfterNativeFailure(intent, undefined, error);
    }
    return dispatchOnNative(intent, native, (signal) => native.reconcileAttempt({
      bindingHandle: intent.effect.bindingHandle,
      sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
      signal,
    }));
  }

  async function dispatchOnNative(
    intent: SessionRuntimeProviderEffectIntentRecord,
    native: AcpTaskSessionRuntimeNativeBinding,
    operation: (signal: AbortSignal) => Promise<AcpTaskSessionRuntimeNativeOutcome>,
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    // Re-read exact persisted Binding/Profile immediately before every native effect.
    try {
      assertCurrentExecutionFence(intent, requiredAttempt(intent));
    } catch (error) {
      reportDiagnostic(error, "native_effect_fence");
      throw error;
    }
    let outcome: AcpTaskSessionRuntimeNativeOutcome;
    try {
      reportDiagnostic("acp_task_session_native_effect_started", "native_effect");
      outcome = await boundedEffect(operation, "acp_task_session_native_effect_timeout");
    } catch (error) {
      return recoverAfterNativeFailure(intent, native, error);
    }
    // Observation conflicts are owner/state failures, not transport ambiguity:
    // preserve their typed fail-closed result instead of treating them as a
    // retryable native failure.
    return await applyNativeOutcome(intent, outcome);
  }

  async function recoverAfterNativeFailure(
    intent: SessionRuntimeProviderEffectIntentRecord,
    native: AcpTaskSessionRuntimeNativeBinding | undefined,
    error: unknown,
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    const timedOut = isDeadlineError(error);
    reportDiagnostic(
      timedOut ? "acp_task_session_native_effect_timeout" : error,
      "native_recovery",
    );
    if (native && timedOut && native.cancelTimedOutEffect) {
      await bestEffortNative(intent, (signal) => native.cancelTimedOutEffect!({
        bindingHandle: intent.effect.bindingHandle,
        sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
        signal,
      }));
    }
    if (native) {
      const reconciliation = await bestEffortNative(intent, (signal) => native.reconcileAttempt({
        bindingHandle: intent.effect.bindingHandle,
        sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
        signal,
      }));
      if (reconciliation) {
        const result = await applyNativeOutcome(intent, reconciliation);
        if (result.disposition === "settled") return result;
      }
      if (timedOut) {
        nativeBindings.delete(native.bindingHandle);
        await cleanupNativeBinding(native);
      }
    }
    if (poisonedCode) throw safeError(poisonedCode);
    markReconciliationIfNeeded(intent, requiredAttempt(intent));
    return reconcilingResult(intent, timedOut ? "native_effect_timeout" : "native_effect_failed");
  }

  async function bestEffortNative<T>(
    intent: SessionRuntimeProviderEffectIntentRecord,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    try {
      assertCurrentExecutionFence(intent, requiredAttempt(intent));
      return await boundedEffect(operation, "acp_task_session_native_reconcile_timeout");
    } catch {
      return undefined;
    }
  }

  async function applyNativeOutcome(
    intent: SessionRuntimeProviderEffectIntentRecord,
    value: AcpTaskSessionRuntimeNativeOutcome,
  ): Promise<AcpTaskSessionRuntimeProviderResult> {
    let outcome: AcpTaskSessionRuntimeNativeOutcome;
    try {
      outcome = validateNativeOutcome(value, intent);
    } catch (error) {
      if (error instanceof AcpTaskSessionRuntimeProviderError) throw error;
      throw safeError("acp_task_session_native_outcome_invalid");
    }
    if (outcome.status === "reconciling") {
      markReconciliationIfNeeded(intent, requiredAttempt(intent));
      return reconcilingResult(intent, "native_outcome_unknown");
    }
    if (outcome.status === "rejected") {
      markReconciliationIfNeeded(intent, requiredAttempt(intent));
      return reconcilingResult(intent, "native_effect_rejected");
    }
    try {
      const binding = assertCurrentExecutionFence(intent, requiredAttempt(intent)).binding;
      await commitDeliveryReceipt(binding, {
        bindingHandle: outcome.bindingHandle,
        sessionExecutionAttemptId: outcome.sessionExecutionAttemptId,
        receiptDigest: outcome.receiptDigest,
      });
      if (outcome.interactionResolution) {
        applyInteractionResolution(intent, outcome.interactionResolution);
      }
      if (outcome.finalCandidate) applyFinalCandidate(intent, outcome.finalCandidate);
      applyTerminal(intent, outcome.terminal);
    } catch (error) {
      throw safeError("acp_task_session_observation_conflict", error);
    }
    const attempt = requiredAttempt(intent);
    if (!attempt.settlement) {
      markReconciliationIfNeeded(intent, attempt);
      return reconcilingResult(intent, "native_outcome_unknown");
    }
    return settledResult(intent, attempt.settlement, false);
  }

  function applyReceipt(intent: SessionRuntimeProviderEffectIntentRecord, receiptDigest: string): void {
    const attempt = requiredAttempt(intent);
    if (attempt.receiptDigest) {
      if (attempt.receiptDigest !== receiptDigest) {
        throw safeError("acp_task_session_receipt_conflict");
      }
      return;
    }
    options.sessionRuntimeOwner.handleDeliveryReceipt({
      ...observationScope(attempt),
      receiptDigest,
    });
  }

  async function commitDeliveryReceipt(
    binding: AcpSafeSessionBindingRecordV3,
    value: AcpTaskSessionRuntimeNativeDeliveryReceipt,
  ): Promise<void> {
    const observation = validateNativeDeliveryReceipt(value, binding);
    const intent = requiredDeliveryIntent(observation.sessionExecutionAttemptId);
    const attempt = requiredAttempt(intent);
    const current = assertCurrentExecutionFence(intent, attempt).binding;
    if (current.bindingId !== binding.bindingId
      || current.revision !== binding.revision
      || intent.effect.bindingHandle !== observation.bindingHandle) {
      throw safeError("acp_task_session_receipt_scope_mismatch");
    }

    const existingDigest = receiptDigests.get(observation.sessionExecutionAttemptId);
    if (existingDigest && existingDigest !== observation.receiptDigest) {
      throw safeError("acp_task_session_receipt_conflict");
    }
    receiptDigests.set(observation.sessionExecutionAttemptId, observation.receiptDigest);
    if (publishedReceipts.has(observation.sessionExecutionAttemptId)) return;
    const existingCommit = receiptCommits.get(observation.sessionExecutionAttemptId);
    if (existingCommit) return existingCommit;

    const commit = (async () => {
      try {
        applyReceipt(intent, observation.receiptDigest);
        await options.onDeliveryReceipt(Object.freeze({
          providerEffectIntentId: intent.providerEffectIntentId,
          taskId: intent.taskId,
          runId: intent.runId,
          logicalSessionId: intent.logicalSessionId,
          sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
          sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
          bindingId: intent.bindingId,
          bindingRevision: intent.bindingRevision,
          executionProfileId: intent.executionProfileId,
          profileRevisionId: intent.profileRevisionId,
          bindingHandle: observation.bindingHandle,
          inputSubmissionId: intent.inputSubmissionId,
          orchestrationSessionTurnId: intent.orchestrationSessionTurnId,
          receiptDigest: observation.receiptDigest,
        }));
        publishedReceipts.add(observation.sessionExecutionAttemptId);
      } catch (error) {
        throw safeError("acp_task_session_receipt_commit_failed", error);
      }
    })().finally(() => {
      receiptCommits.delete(observation.sessionExecutionAttemptId);
    });
    receiptCommits.set(observation.sessionExecutionAttemptId, commit);
    return commit;
  }

  async function commitFinalCandidate(
    binding: AcpSafeSessionBindingRecordV3,
    value: AcpTaskSessionRuntimeNativeFinalCandidateObservation,
  ): Promise<void> {
    const observation = validateNativeFinalCandidateObservation(value, binding);
    const intent = requiredDeliveryIntent(observation.sessionExecutionAttemptId);
    const attempt = requiredAttempt(intent);
    const current = assertCurrentExecutionFence(intent, attempt).binding;
    if (current.bindingId !== binding.bindingId
      || current.revision !== binding.revision
      || intent.effect.bindingHandle !== observation.bindingHandle) {
      throw safeError("acp_task_session_final_candidate_scope_mismatch");
    }
    if (!attempt.receiptDigest || attempt.receiptDigest !== observation.receiptDigest) {
      throw safeError("acp_task_session_final_candidate_receipt_mismatch");
    }

    const fingerprint = JSON.stringify([
      observation.receiptDigest,
      observation.candidateObservationId,
      observation.contentDigest,
      observation.content,
    ]);
    const existingFingerprint = finalCandidateFingerprints.get(observation.sessionExecutionAttemptId);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw safeError("acp_task_session_final_candidate_conflict");
    }
    finalCandidateFingerprints.set(observation.sessionExecutionAttemptId, fingerprint);
    const existingCommit = finalCandidateCommits.get(observation.sessionExecutionAttemptId);
    if (existingCommit) return existingCommit;
    const commit = Promise.resolve().then(() => {
      try {
        const currentAttempt = requiredAttempt(intent);
        if (!currentAttempt.receiptDigest
          || currentAttempt.receiptDigest !== observation.receiptDigest) {
          throw safeError("acp_task_session_final_candidate_receipt_mismatch");
        }
        assertCurrentExecutionFence(intent, currentAttempt);
        applyFinalCandidate(intent, observation);
      } catch (error) {
        if (error instanceof AcpTaskSessionRuntimeProviderError) throw error;
        throw safeError("acp_task_session_final_candidate_commit_failed", error);
      }
    }).finally(() => {
      finalCandidateCommits.delete(observation.sessionExecutionAttemptId);
    });
    finalCandidateCommits.set(observation.sessionExecutionAttemptId, commit);
    return commit;
  }

  function requiredDeliveryIntent(
    sessionExecutionAttemptId: string,
  ): SessionRuntimeProviderEffectIntentRecord {
    let candidates: readonly SessionRuntimeProviderEffectIntentRecord[];
    try {
      candidates = options.repositories.reliability
        .listProviderEffectIntents(sessionExecutionAttemptId)
        .filter(({ commandType, effect }) =>
          commandType === "session_runtime.submit_delivery" && effect.kind === "submit_delivery");
    } catch {
      throw safeError("acp_task_session_delivery_intent_read_failed");
    }
    if (candidates.length !== 1) {
      throw safeError("acp_task_session_delivery_intent_ambiguous");
    }
    try {
      return cloneSessionRuntimeProviderEffectIntent(candidates[0]!);
    } catch (error) {
      throw safeError("acp_task_session_provider_effect_intent_invalid", error);
    }
  }

  function applyInteractionResolution(
    intent: SessionRuntimeProviderEffectIntentRecord,
    observation: AcpTaskSessionRuntimeNativeInteractionResolution,
  ): void {
    if (intent.effect.kind !== "respond_interaction"
      || observation.interactionId !== intent.effect.interactionId
      || observation.choiceId !== intent.effect.choiceId) {
      throw safeError("acp_task_session_interaction_observation_mismatch");
    }
    const attempt = requiredAttempt(intent);
    options.sessionRuntimeOwner.handleInteractionResolved({
      ...observationScope(attempt),
      interactionId: observation.interactionId,
      choiceId: observation.choiceId,
      expectedInteractionRevision: observation.expectedInteractionRevision,
    });
  }

  function applyFinalCandidate(
    intent: SessionRuntimeProviderEffectIntentRecord,
    observation: AcpTaskSessionRuntimeNativeFinalCandidate,
  ): void {
    const attempt = requiredAttempt(intent);
    options.sessionRuntimeOwner.handleFinalCandidate({
      ...observationScope(attempt),
      candidateObservationId: observation.candidateObservationId,
      content: observation.content,
      contentDigest: observation.contentDigest,
    });
  }

  function applyTerminal(
    intent: SessionRuntimeProviderEffectIntentRecord,
    observation: AcpTaskSessionRuntimeNativeTerminal,
  ): void {
    const attempt = requiredAttempt(intent);
    options.sessionRuntimeOwner.handlePromptTerminal({
      ...observationScope(attempt),
      terminalObservationId: observation.terminalObservationId,
      outcome: observation.outcome,
      receiptDigest: observation.receiptDigest,
    });
  }

  function observationScope(attempt: SessionExecutionAttemptRecord) {
    return Object.freeze({
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      expectedAttemptRevision: attempt.revision,
      logicalSessionId: attempt.logicalSessionId,
      bindingId: attempt.bindingId,
      bindingRevision: attempt.bindingRevision,
      executionProfileId: attempt.executionProfileId,
      profileRevisionId: attempt.profileRevisionId,
    });
  }

  function markReconciliation(
    intent: SessionRuntimeProviderEffectIntentRecord,
    attempt: SessionExecutionAttemptRecord,
  ): void {
    assertAttemptScope(intent, attempt);
    try {
      options.sessionRuntimeOwner.markReconciliation({
        sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
        expectedAttemptRevision: attempt.revision,
      });
    } catch (error) {
      const current = requiredAttempt(intent);
      if (current.settlement || current.state === "reconciling") return;
      throw safeError("acp_task_session_reconciliation_transition_failed", error);
    }
  }

  function markReconciliationIfNeeded(
    intent: SessionRuntimeProviderEffectIntentRecord,
    attempt: SessionExecutionAttemptRecord,
  ): void {
    if (attempt.settlement || attempt.state === "reconciling") return;
    markReconciliation(intent, attempt);
  }

  async function openBindingForIntent(
    intent: SessionRuntimeProviderEffectIntentRecord,
  ): Promise<AcpTaskSessionRuntimeNativeBinding> {
    const existing = nativeBindings.get(intent.effect.bindingHandle);
    if (existing) return existing;
    const context = assertCurrentExecutionFence(intent, requiredAttempt(intent));
    reportDiagnostic("acp_task_session_native_open_started", "native_open");
    const pending = boundedEffect(
      (signal) => options.openNativeBinding({
        binding: context.binding,
        profile: context.profile,
        observeDeliveryReceipt: (receipt) => commitDeliveryReceipt(context.binding, receipt),
        observeFinalCandidate: (observation) => commitFinalCandidate(context.binding, observation),
        signal,
      }),
      "acp_task_session_native_open_timeout",
    ).then((native) => {
      if (!native || native.bindingHandle !== context.binding.bindingHandle
        || typeof native.submitDelivery !== "function"
        || typeof native.reconcileAttempt !== "function"
        || typeof native.retire !== "function"
        || typeof native.close !== "function") {
        throw safeError("acp_task_session_native_binding_invalid");
      }
      reportDiagnostic("acp_task_session_native_open_available", "native_open");
      return native;
    }).catch(async (error) => {
      reportDiagnostic(error, "native_open");
      nativeBindings.delete(intent.effect.bindingHandle);
      if (isDeadlineError(error) && isNativeBinding(error.lateValue)) {
        await cleanupNativeBinding(error.lateValue);
      }
      throw error;
    });
    nativeBindings.set(intent.effect.bindingHandle, pending);
    return pending;
  }

  function reportDiagnostic(
    value: unknown,
    stage: AcpTaskSessionRuntimeProviderDiagnostic["stage"],
  ): void {
    if (!options.onDiagnostic) return;
    const code = value instanceof AcpTaskSessionRuntimeProviderError
      ? value.code
      : typeof value === "string" && /^acp_[a-z0-9_]{1,223}$/u.test(value)
        ? value
        : "acp_task_session_native_effect_failed";
    try {
      options.onDiagnostic(Object.freeze({ code, stage }));
    } catch {
      // Host-only observability must never become a lifecycle decision.
    }
  }

  function requiredIntent(providerEffectIntentId: string): SessionRuntimeProviderEffectIntentRecord {
    let persisted: SessionRuntimeProviderEffectIntentRecord | undefined;
    try {
      persisted = options.repositories.reliability.getProviderEffectIntent(providerEffectIntentId);
    } catch {
      throw safeError("acp_task_session_provider_effect_intent_read_failed");
    }
    if (!persisted) throw safeError("acp_task_session_provider_effect_intent_not_found");
    try {
      return cloneSessionRuntimeProviderEffectIntent(persisted);
    } catch (error) {
      throw safeError("acp_task_session_provider_effect_intent_invalid", error);
    }
  }

  function requiredAttempt(intent: SessionRuntimeProviderEffectIntentRecord): SessionExecutionAttemptRecord {
    let attempt: SessionExecutionAttemptRecord | undefined;
    try {
      attempt = options.repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId);
    } catch {
      throw safeError("acp_task_session_attempt_read_failed");
    }
    if (!attempt) throw safeError("acp_task_session_attempt_not_found");
    assertAttemptScope(intent, attempt);
    return attempt;
  }

  function assertAttemptScope(
    intent: SessionRuntimeProviderEffectIntentRecord,
    attempt: SessionExecutionAttemptRecord,
  ): void {
    if (attempt.sessionExecutionRuntimeId !== intent.sessionExecutionRuntimeId
      || attempt.taskId !== intent.taskId
      || attempt.runId !== intent.runId
      || attempt.logicalSessionId !== intent.logicalSessionId
      || attempt.bindingId !== intent.bindingId
      || attempt.bindingRevision !== intent.bindingRevision
      || attempt.executionProfileId !== intent.executionProfileId
      || attempt.profileRevisionId !== intent.profileRevisionId
      || attempt.inputSubmissionId !== intent.inputSubmissionId
      || attempt.orchestrationSessionTurnId !== intent.orchestrationSessionTurnId) {
      throw safeError("acp_task_session_attempt_scope_mismatch");
    }
    let runtime: SessionExecutionRuntimeRecord | undefined;
    try {
      runtime = options.repositories.sessionRuntime.getRuntime(intent.sessionExecutionRuntimeId);
    } catch {
      throw safeError("acp_task_session_runtime_read_failed");
    }
    if (!runtime || runtime.taskId !== intent.taskId || runtime.runId !== intent.runId
      || runtime.logicalSessionId !== intent.logicalSessionId) {
      throw safeError("acp_task_session_runtime_scope_mismatch");
    }
    if (!attempt.settlement && runtime.activeAttemptId !== attempt.sessionExecutionAttemptId) {
      throw safeError("acp_task_session_attempt_not_current");
    }
  }

  function assertCurrentExecutionFence(
    intent: SessionRuntimeProviderEffectIntentRecord,
    attempt: SessionExecutionAttemptRecord,
  ): Readonly<{ binding: AcpSafeSessionBindingRecordV3; profile: AcpV3FrozenProfileTuple }> {
    assertAttemptScope(intent, attempt);
    let binding: AcpSafeSessionBindingRecordV3 | undefined;
    try {
      binding = options.repositories.binding.getCurrentBinding(intent.logicalSessionId);
    } catch {
      throw safeError("acp_task_session_current_binding_read_failed");
    }
    if (!binding) throw safeError("acp_task_session_current_binding_missing");
    if (binding.bindingId !== intent.bindingId) throw safeError("acp_task_session_binding_not_current");
    if (binding.revision !== intent.bindingRevision) {
      throw safeError("acp_task_session_binding_revision_stale");
    }
    if (binding.status !== "active" && binding.status !== "recovering") {
      throw safeError("acp_task_session_binding_not_usable");
    }
    if (binding.taskId !== intent.taskId || binding.runId !== intent.runId
      || binding.logicalSessionId !== intent.logicalSessionId
      || binding.executionProfileId !== intent.executionProfileId
      || binding.profileRevisionId !== intent.profileRevisionId
      || binding.bindingHandle !== intent.effect.bindingHandle) {
      throw safeError("acp_task_session_binding_scope_mismatch");
    }
    let profile: AcpV3FrozenProfileTuple | undefined;
    try {
      profile = options.resolveFrozenProfileTuple({
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        executionProfileId: intent.executionProfileId,
      });
    } catch {
      throw safeError("acp_task_session_frozen_profile_read_failed");
    }
    if (!profile) throw safeError("acp_task_session_frozen_profile_missing");
    try {
      assertSessionExecutionSafeValue(profile, "ACP Task frozen Profile tuple");
    } catch {
      throw safeError("acp_task_session_frozen_profile_invalid");
    }
    if (profile.schemaVersion !== 3
      || profile.executionProfileId !== intent.executionProfileId
      || profile.profileRevisionId !== intent.profileRevisionId
      || profile.providerFamily !== binding.providerFamily) {
      throw safeError("acp_task_session_frozen_profile_mismatch");
    }
    return Object.freeze({ binding, profile });
  }

  async function cleanupNativeBinding(native: AcpTaskSessionRuntimeNativeBinding): Promise<void> {
    if (cleanedBindings.has(native as object)) return;
    cleanedBindings.add(native as object);
    let failed = false;
    try {
      await boundedEffect(
        (signal) => native.retire({ signal }),
        "acp_task_session_native_retire_timeout",
      );
    } catch {
      failed = true;
    }
    try {
      await boundedEffect(
        (signal) => native.close({ signal }),
        "acp_task_session_native_close_timeout",
      );
    } catch {
      failed = true;
    }
    if (failed) {
      poisonedCode = "acp_task_session_cleanup_unconfirmed";
      throw safeError(poisonedCode);
    }
  }

  async function boundedEffect<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutCode: string,
  ): Promise<T> {
    const controller = new AbortController();
    let operationPromise: Promise<T>;
    try {
      operationPromise = Promise.resolve(operation(controller.signal));
    } catch (error) {
      operationPromise = Promise.reject(error);
    }
    operationPromise.catch(() => undefined);
    const first = await raceWithDeadline(
      settle(operationPromise),
      options.effectDeadlineMs,
      "deadline" as const,
    );
    if (first.kind === "fulfilled") return first.value;
    if (first.kind === "rejected") throw first.error;

    controller.abort();
    const confirmation = await raceWithDeadline(
      settle(operationPromise),
      options.effectDeadlineMs,
      "confirmation_deadline" as const,
    );
    if (confirmation.kind === "confirmation_deadline") {
      poisonedCode = "acp_task_session_cleanup_unconfirmed";
      throw safeError(poisonedCode);
    }
    if (confirmation.kind === "fulfilled") {
      throw new NativeDeadlineError(timeoutCode, confirmation.value);
    }
    throw new NativeDeadlineError(timeoutCode);
  }

  function ensureAvailable(): void {
    if (poisonedCode) throw safeError(poisonedCode);
    if (closed) throw safeError("acp_task_session_provider_closed");
  }
}

function validateNativeOutcome(
  value: AcpTaskSessionRuntimeNativeOutcome,
  intent: SessionRuntimeProviderEffectIntentRecord,
): AcpTaskSessionRuntimeNativeOutcome {
  assertSessionExecutionSafeValue(value, "ACP Task native outcome");
  if (!value || typeof value !== "object"
    || value.bindingHandle !== intent.effect.bindingHandle
    || value.sessionExecutionAttemptId !== intent.sessionExecutionAttemptId) {
    throw safeError("acp_task_session_native_outcome_scope_mismatch");
  }
  if (value.status === "reconciling") {
    if (value.reason !== "provider_outcome_unknown") {
      throw safeError("acp_task_session_native_outcome_invalid");
    }
    return Object.freeze({ ...value });
  }
  if (value.status === "rejected") {
    if (typeof value.code !== "string" || !SAFE_CODE.test(value.code)) {
      throw safeError("acp_task_session_native_rejection_invalid");
    }
    return Object.freeze({ ...value });
  }
  if (value.status !== "settled" || !safeReceipt(value.receiptDigest)
    || !value.terminal || value.terminal.receiptDigest !== value.receiptDigest
    || !["completed", "failed", "cancelled"].includes(value.terminal.outcome)
    || !safeProviderFactId(value.terminal.terminalObservationId)) {
    throw safeError("acp_task_session_native_settlement_invalid");
  }
  if (value.terminal.outcome === "completed" && !value.finalCandidate) {
    throw safeError("acp_task_session_native_final_missing");
  }
  if (value.finalCandidate && (!safeProviderFactId(value.finalCandidate.candidateObservationId)
    || typeof value.finalCandidate.content !== "string" || !value.finalCandidate.content
    || value.finalCandidate.contentDigest !== hashDefinition(value.finalCandidate.content))) {
    throw safeError("acp_task_session_native_final_invalid");
  }
  if (value.interactionResolution && (!Number.isSafeInteger(value.interactionResolution.expectedInteractionRevision)
    || value.interactionResolution.expectedInteractionRevision < 1)) {
    throw safeError("acp_task_session_native_interaction_invalid");
  }
  return Object.freeze({
    ...value,
    ...(value.interactionResolution
      ? { interactionResolution: Object.freeze({ ...value.interactionResolution }) }
      : {}),
    ...(value.finalCandidate ? { finalCandidate: Object.freeze({ ...value.finalCandidate }) } : {}),
    terminal: Object.freeze({ ...value.terminal }),
  });
}

function validateNativeDeliveryReceipt(
  value: AcpTaskSessionRuntimeNativeDeliveryReceipt,
  binding: AcpSafeSessionBindingRecordV3,
): AcpTaskSessionRuntimeNativeDeliveryReceipt {
  try {
    assertSessionExecutionSafeValue(value, "ACP Task native delivery receipt");
  } catch {
    throw safeError("acp_task_session_native_receipt_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || value.bindingHandle !== binding.bindingHandle
    || typeof value.sessionExecutionAttemptId !== "string"
    || !SESSION_EXECUTION_ATTEMPT_ID.test(value.sessionExecutionAttemptId)
    || !safeReceipt(value.receiptDigest)) {
    throw safeError("acp_task_session_native_receipt_invalid");
  }
  return Object.freeze({ ...value });
}

function validateNativeFinalCandidateObservation(
  value: AcpTaskSessionRuntimeNativeFinalCandidateObservation,
  binding: AcpSafeSessionBindingRecordV3,
): AcpTaskSessionRuntimeNativeFinalCandidateObservation {
  try {
    assertSessionExecutionSafeValue(value, "ACP Task native final candidate observation");
  } catch {
    throw safeError("acp_task_session_native_final_candidate_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 6
    || value.bindingHandle !== binding.bindingHandle
    || typeof value.sessionExecutionAttemptId !== "string"
    || !SESSION_EXECUTION_ATTEMPT_ID.test(value.sessionExecutionAttemptId)
    || !safeReceipt(value.receiptDigest)
    || !safeProviderFactId(value.candidateObservationId)
    || typeof value.content !== "string" || !value.content
    || value.contentDigest !== hashDefinition(value.content)) {
    throw safeError("acp_task_session_native_final_candidate_invalid");
  }
  return Object.freeze({ ...value });
}

function validateOptions(value: AcpTaskSessionRuntimeProviderOptions): void {
  if (!value || !value.repositories || !value.sessionRuntimeOwner
    || typeof value.resolveFrozenProfileTuple !== "function"
    || typeof value.resolveInterruptCorrelation !== "function"
    || typeof value.onDeliveryReceipt !== "function"
    || typeof value.openNativeBinding !== "function"
    || (value.onDiagnostic !== undefined && typeof value.onDiagnostic !== "function")) {
    throw safeError("acp_task_session_provider_options_invalid");
  }
  if (!Number.isSafeInteger(value.effectDeadlineMs)
    || value.effectDeadlineMs < MINIMUM_DEADLINE_MS
    || value.effectDeadlineMs > MAXIMUM_DEADLINE_MS) {
    throw safeError("acp_task_session_effect_deadline_invalid");
  }
}

function requiredProviderEffectIntentId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_EFFECT_ID.test(value)) {
    throw safeError("acp_task_session_provider_effect_intent_id_invalid");
  }
  return value;
}

function requiredBindingRetirementIntentId(value: unknown): string {
  if (typeof value !== "string" || !BINDING_RETIREMENT_ID.test(value)) {
    throw safeError("acp_task_session_binding_retirement_intent_id_invalid");
  }
  return value;
}

function retirementResult(
  intent: AcpV3BindingRetirementIntentRecord,
  replayed: boolean,
): AcpTaskSessionRuntimeBindingRetirementResult {
  return Object.freeze({
    disposition: "released",
    bindingRetirementIntentId: intent.bindingRetirementIntentId,
    bindingId: intent.bindingId,
    replayed,
  });
}

function settledResult(
  intent: SessionRuntimeProviderEffectIntentRecord,
  settlement: SessionExecutionSettlement,
  replayed: boolean,
): AcpTaskSessionRuntimeProviderResult {
  return Object.freeze({
    disposition: "settled",
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    replayed,
    settlement,
  });
}

function reconcilingResult(
  intent: SessionRuntimeProviderEffectIntentRecord,
  reason: Extract<AcpTaskSessionRuntimeProviderResult, { disposition: "reconciling" }>["reason"],
): AcpTaskSessionRuntimeProviderResult {
  return Object.freeze({
    disposition: "reconciling",
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    reason,
  });
}

function rejectedResult(
  intent: SessionRuntimeProviderEffectIntentRecord,
  code: Extract<AcpTaskSessionRuntimeProviderResult, { disposition: "rejected" }>["code"],
): AcpTaskSessionRuntimeProviderResult {
  return Object.freeze({
    disposition: "rejected",
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    code,
  });
}

function safeReceipt(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isAmbiguousInterruptCorrelation(
  value: Exclude<AcpTaskSessionRuntimeInterruptCorrelationResolution, undefined>,
): value is Readonly<{ readonly status: "ambiguous" }> {
  return "status" in value && value.status === "ambiguous";
}

function safeProviderFactId(value: unknown): value is string {
  return typeof value === "string" && /^provider_fact_[A-Za-z0-9_-]{1,223}$/u.test(value);
}

class NativeDeadlineError extends Error {
  readonly lateValue: unknown;

  constructor(code: string, lateValue?: unknown) {
    super(code);
    this.name = "NativeDeadlineError";
    this.lateValue = lateValue;
  }
}

function isDeadlineError(value: unknown): value is NativeDeadlineError {
  return value instanceof NativeDeadlineError;
}

function isNativeBinding(value: unknown): value is AcpTaskSessionRuntimeNativeBinding {
  return Boolean(value && typeof value === "object"
    && "bindingHandle" in value
    && "submitDelivery" in value
    && "reconcileAttempt" in value
    && "retire" in value
    && "close" in value
    && typeof value.bindingHandle === "string"
    && typeof value.submitDelivery === "function"
    && typeof value.reconcileAttempt === "function"
    && typeof value.retire === "function"
    && typeof value.close === "function");
}

function settle<T>(value: Promise<T>): Promise<
  | Readonly<{ kind: "fulfilled"; value: T }>
  | Readonly<{ kind: "rejected"; error: unknown }>
> {
  return value.then(
    (result) => Object.freeze({ kind: "fulfilled" as const, value: result }),
    (error) => Object.freeze({ kind: "rejected" as const, error }),
  );
}

async function raceWithDeadline<T, const K extends "deadline" | "confirmation_deadline">(
  value: Promise<T>,
  milliseconds: number,
  kind: K,
): Promise<T | Readonly<{ kind: K }>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<Readonly<{ kind: K }>>((resolve) => {
        timeout = setTimeout(() => resolve(Object.freeze({ kind })), milliseconds);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function safeError(code: string, _cause?: unknown): AcpTaskSessionRuntimeProviderError {
  return new AcpTaskSessionRuntimeProviderError(code);
}
