import { createHash } from "node:crypto";
import type { AcpPromptSettlement, AcpSessionObservation } from "@agent-workspace/provider-acp";
import {
  renderProviderSessionBootstrap,
  type ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import {
  hashDefinition,
  type ProviderSessionBootstrap,
} from "@agent-workspace/runtime-contracts";
import type { AcpV3FrozenProfileTuple } from "@agent-workspace/runtime-store";
import type {
  AcpTaskSessionRuntimeNativeBinding,
  AcpTaskSessionRuntimeNativeOutcome,
} from "./acp-task-session-runtime-provider.js";
import type { AcpProviderAvailabilityReport } from "./acp-provider-composition.js";
import type { AcpTaskRuntimeDiagnostic } from "./acp-task-profile-runtime.js";

const ATTEMPT_ID = /^session_execution_attempt_[A-Za-z0-9_-]{1,223}$/u;
const BINDING_HANDLE = /^binding_handle_[A-Za-z0-9_-]{1,223}$/u;
const SAFE_PROFILE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,255}$/u;
const SESSION_CONTROL_AUDIT_ID = /^session_control_[A-Za-z0-9_-]{1,223}$/u;
const SAFE_CONTENT_MAX = 50_000;

export type AcpTaskNativeDriver = Readonly<{
  readonly providerFamily: "opencode" | "codex" | "claude-code";
  readonly acpAgentKind: "native_acp" | "codex_acp" | "claude_agent_acp";
  readonly errorPrefix:
    | "opencode_acp_task_runtime"
    | "codex_acp_task_runtime"
    | "claude_code_acp_task_runtime";
  readonly providerFactNamespace: "opencode" | "codex" | "claude_code";
}>;

export const OPENCODE_ACP_TASK_NATIVE_DRIVER: AcpTaskNativeDriver = Object.freeze({
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  errorPrefix: "opencode_acp_task_runtime",
  providerFactNamespace: "opencode",
});

export const CLAUDE_CODE_ACP_TASK_NATIVE_DRIVER: AcpTaskNativeDriver = Object.freeze({
  providerFamily: "claude-code",
  acpAgentKind: "claude_agent_acp",
  errorPrefix: "claude_code_acp_task_runtime",
  providerFactNamespace: "claude_code",
});

export const CODEX_ACP_TASK_NATIVE_DRIVER: AcpTaskNativeDriver = Object.freeze({
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  errorPrefix: "codex_acp_task_runtime",
  providerFactNamespace: "codex",
});

export type AcpTaskProviderPromptResult =
  | Readonly<{
      readonly state: "settled";
      readonly settlement: AcpPromptSettlement;
      readonly observations: readonly AcpSessionObservation[];
    }>
  | Readonly<{
      readonly state: "reconciling";
      readonly reason: "provider_outcome_unknown";
      readonly resendAllowed: false;
      readonly observations: readonly AcpSessionObservation[];
    }>;

export type AcpTaskProviderBindingRuntime = Readonly<{
  readonly bindingHandle: string;
  readonly role: string;
  readonly report: AcpProviderAvailabilityReport;
  submitPrompt(input: Readonly<{
    readonly attemptId: string;
    readonly content: string;
    readonly interactionRevision?: number;
    readonly turnContext?: ProviderScopedToolTurnContext;
  }>): Promise<AcpTaskProviderPromptResult>;
  reconcilePrompt(input: Readonly<{ readonly attemptId: string }>): Promise<AcpTaskProviderPromptResult>;
  requestInterrupt(input: Readonly<{ readonly attemptId: string }>): Promise<Readonly<{
    readonly acceptance: "accepted";
    readonly completion: "unknown";
  }>>;
  releaseBinding(): Promise<void>;
  safeObservation(): Readonly<{
    readonly providerFamily: string;
    readonly acpAgentKind: string;
    readonly executionProfileId: string;
    readonly profileRevisionId: string;
    readonly role: string;
    readonly available: true;
    readonly qualificationClass: "binding_behavior";
    readonly evidenceClass: "injected_host_qualification";
  }>;
}>;

export type AcpTaskProviderProfileAdapter = Readonly<{
  readonly role: string;
  safeObservation(): Readonly<{ readonly role: string }>;
  close(): Promise<void>;
}>;

export type AcpTaskSessionRuntimeNativeBindingOptions = Readonly<{
  readonly driver: AcpTaskNativeDriver;
  readonly adapter: AcpTaskProviderProfileAdapter;
  readonly runtime: AcpTaskProviderBindingRuntime;
  readonly profile: AcpV3FrozenProfileTuple;
  readonly resolveTurnContext?: (
    input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
  ) => ProviderScopedToolTurnContext | undefined;
  readonly resolvePromptBootstrap?: (
    input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
  ) => ProviderSessionBootstrap | undefined;
  readonly onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
}>;

export class AcpTaskSessionRuntimeNativeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpTaskSessionRuntimeNativeError";
    this.code = code;
  }
}

/** Provider-neutral projection for every ACP-backed Task Binding. */
export function createAcpTaskSessionRuntimeNativeBinding(
  options: AcpTaskSessionRuntimeNativeBindingOptions,
): AcpTaskSessionRuntimeNativeBinding {
  const driver = normalizeDriver(options?.driver);
  if (!options?.adapter || !options.runtime
    || typeof options.runtime.submitPrompt !== "function"
    || typeof options.runtime.reconcilePrompt !== "function"
    || typeof options.runtime.requestInterrupt !== "function"
    || typeof options.runtime.releaseBinding !== "function"
    || typeof options.runtime.safeObservation !== "function"
    || typeof options.adapter.close !== "function") {
    throw safeError(driver, "native_options_invalid");
  }
  if (options.resolveTurnContext !== undefined
    && typeof options.resolveTurnContext !== "function") {
    throw safeError(driver, "turn_context_resolver_invalid");
  }
  if (options.resolvePromptBootstrap !== undefined
    && typeof options.resolvePromptBootstrap !== "function") {
    throw safeError(driver, "prompt_bootstrap_resolver_invalid");
  }
  const bindingHandle = requiredBindingHandle(driver, options.runtime.bindingHandle);
  assertExactProfileFence(driver, options);

  const interactionRevisions = new Map<string, number>();
  const turnContexts = new Map<string, ProviderScopedToolTurnContext>();
  let nextInteractionRevision = 0;
  let retirePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    bindingHandle,
    async submitDelivery(input) {
      let attemptId: string;
      let content: string;
      try {
        assertNativeEffectScope(driver, input, bindingHandle);
        attemptId = requiredAttemptId(driver, input.sessionExecutionAttemptId);
        content = resolvePromptContent(attemptId, safeContent(driver, input.content));
      } catch (error) {
        reportNativeDiagnostic(options.onDiagnostic, "native_scope", error);
        throw error;
      }
      let turnContext: ProviderScopedToolTurnContext | undefined;
      try {
        turnContext = resolveTurnContext(attemptId);
      } catch (error) {
        reportNativeDiagnostic(options.onDiagnostic, "turn_context", error);
        throw error;
      }
      let result: AcpTaskProviderPromptResult;
      try {
        result = await submitPromptWithAbort(
          input.signal,
          attemptId,
          () => options.runtime.submitPrompt({
            attemptId,
            content,
            interactionRevision: interactionRevision(attemptId),
            ...(turnContext ? { turnContext } : {}),
          }),
        );
      } catch (error) {
        reportNativeDiagnostic(options.onDiagnostic, "native_submit", error);
        throw error;
      }
      if (result.state === "reconciling") {
        reportNativeDiagnostic(options.onDiagnostic, "native_reconciling", result.reason);
      }
      return taskSessionNativeOutcome(driver, result, bindingHandle, attemptId);
    },
    async reconcileAttempt(input) {
      assertNativeEffectScope(driver, input, bindingHandle);
      const attemptId = requiredAttemptId(driver, input.sessionExecutionAttemptId);
      return taskSessionNativeOutcome(
        driver,
        await options.runtime.reconcilePrompt({ attemptId }),
        bindingHandle,
        attemptId,
      );
    },
    async requestInterrupt(input) {
      assertNativeEffectScope(driver, input, bindingHandle);
      const attemptId = requiredAttemptId(driver, input.sessionExecutionAttemptId);
      if (typeof input.sessionControlAuditId !== "string"
        || !SESSION_CONTROL_AUDIT_ID.test(input.sessionControlAuditId)) {
        throw safeError(driver, "interrupt_correlation_invalid");
      }
      assertInterruptReceipt(driver, await options.runtime.requestInterrupt({ attemptId }));
      return reconcilingOutcome(bindingHandle, attemptId);
    },
    async cancelTimedOutEffect(input) {
      assertNativeEffectScope(driver, input, bindingHandle);
      assertInterruptReceipt(driver, await options.runtime.requestInterrupt({
        attemptId: requiredAttemptId(driver, input.sessionExecutionAttemptId),
      }));
    },
    retire(input) {
      assertEffectSignal(driver, input?.signal);
      retirePromise ??= options.runtime.releaseBinding();
      return retirePromise;
    },
    close(input) {
      assertEffectSignal(driver, input?.signal);
      closePromise ??= (async () => {
        turnContexts.clear();
        interactionRevisions.clear();
        await options.adapter.close();
      })();
      return closePromise;
    },
  } satisfies AcpTaskSessionRuntimeNativeBinding);

  async function submitPromptWithAbort(
    signal: AbortSignal,
    attemptId: string,
    submit: () => Promise<AcpTaskProviderPromptResult>,
  ): Promise<AcpTaskProviderPromptResult> {
    if (signal.aborted) throw safeError(driver, "effect_aborted");
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= options.runtime.requestInterrupt({ attemptId }).then((receipt) => {
        assertInterruptReceipt(driver, receipt);
      });
      cancellation.catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    let outcome: AcpTaskProviderPromptResult | undefined;
    let failure: unknown;
    try {
      outcome = await submit();
    } catch (error) {
      failure = error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    if (cancellation) {
      try {
        await cancellation;
      } catch {
        throw safeError(driver, "abort_unconfirmed");
      }
    }
    if (failure) throw failure;
    if (!outcome) throw safeError(driver, "outcome_missing");
    return outcome;
  }

  function interactionRevision(attemptId: string): number {
    const existing = interactionRevisions.get(attemptId);
    if (existing !== undefined) return existing;
    nextInteractionRevision += 1;
    interactionRevisions.set(attemptId, nextInteractionRevision);
    return nextInteractionRevision;
  }

  function resolveTurnContext(attemptId: string): ProviderScopedToolTurnContext | undefined {
    const existing = turnContexts.get(attemptId);
    if (existing) return existing;
    const resolved = options.resolveTurnContext?.({ sessionExecutionAttemptId: attemptId });
    if (resolved) turnContexts.set(attemptId, resolved);
    return resolved;
  }

  function resolvePromptContent(attemptId: string, content: string): string {
    const bootstrap = options.resolvePromptBootstrap?.({
      sessionExecutionAttemptId: attemptId,
    });
    if (!bootstrap) return content;
    let rendered: string;
    try {
      rendered = renderProviderSessionBootstrap(bootstrap);
    } catch {
      throw safeError(driver, "prompt_bootstrap_invalid");
    }
    return safeContent(driver, `${rendered}\n\nCurrent assignment:\n${content}`);
  }
}

function reportNativeDiagnostic(
  sink: ((diagnostic: AcpTaskRuntimeDiagnostic) => void) | undefined,
  stage: AcpTaskRuntimeDiagnostic["stage"],
  error: unknown,
): void {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : error instanceof Error
      ? error.message
      : error;
  const code = typeof candidate === "string" && /^[a-z][a-z0-9_]{2,127}$/u.test(candidate)
    ? candidate
    : "acp_task_native_failure";
  try {
    sink?.(Object.freeze({ code, stage }));
  } catch {
    // Diagnostics remain observational and may never affect native recovery.
  }
}

function assertExactProfileFence(
  driver: AcpTaskNativeDriver,
  options: AcpTaskSessionRuntimeNativeBindingOptions,
): void {
  const profile = options.profile;
  const observation = options.runtime.safeObservation();
  const report = options.runtime.report;
  const adapterObservation = options.adapter.safeObservation();
  if (!profile || profile.schemaVersion !== 3 || profile.providerFamily !== driver.providerFamily
    || typeof profile.executionProfileId !== "string"
    || !SAFE_PROFILE_ID.test(profile.executionProfileId)
    || typeof profile.profileRevisionId !== "string"
    || !SAFE_PROFILE_ID.test(profile.profileRevisionId)
    || observation.providerFamily !== driver.providerFamily
    || observation.acpAgentKind !== driver.acpAgentKind
    || observation.executionProfileId !== profile.executionProfileId
    || observation.profileRevisionId !== profile.profileRevisionId
    || observation.available !== true
    || observation.qualificationClass !== "binding_behavior"
    || observation.evidenceClass !== "injected_host_qualification"
    || report.providerFamily !== driver.providerFamily
    || report.acpAgentKind !== driver.acpAgentKind
    || report.profileRevisionId !== profile.profileRevisionId
    || report.available !== true
    || report.qualificationClass !== "binding_behavior"
    || report.evidenceClass !== "injected_host_qualification"
    || observation.role !== options.runtime.role
    || report.role !== options.runtime.role
    || adapterObservation.role !== options.runtime.role
    || options.adapter.role !== options.runtime.role) {
    throw safeError(driver, "profile_mismatch");
  }
}

function taskSessionNativeOutcome(
  driver: AcpTaskNativeDriver,
  value: AcpTaskProviderPromptResult,
  bindingHandle: string,
  attemptId: string,
): AcpTaskSessionRuntimeNativeOutcome {
  if (!value || value.state === "reconciling") return reconcilingOutcome(bindingHandle, attemptId);
  const settlement = value.settlement;
  if (settlement.bindingHandle !== bindingHandle || settlement.attemptId !== attemptId
    || typeof settlement.receiptDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(settlement.receiptDigest)
    || !Number.isSafeInteger(settlement.finalCandidateGroupCount)
    || settlement.finalCandidateGroupCount < 0
    || (settlement.finalCandidate !== undefined
      && (settlement.finalCandidateGroupCount < 1 || !isSafeContent(settlement.finalCandidate)))
    || (settlement.stopReason === "end_turn" && !settlement.finalCandidate)) {
    throw safeError(driver, "settlement_invalid");
  }
  const outcome = settlement.stopReason === "end_turn"
    ? "completed" as const
    : settlement.stopReason === "cancelled"
      ? "cancelled" as const
      : "failed" as const;
  const finalCandidate = settlement.finalCandidate;
  return Object.freeze({
    status: "settled" as const,
    bindingHandle,
    sessionExecutionAttemptId: attemptId,
    receiptDigest: settlement.receiptDigest,
    ...(finalCandidate
      ? { finalCandidate: Object.freeze({
          candidateObservationId: safeProviderFactId(driver, "candidate", attemptId),
          content: finalCandidate,
          contentDigest: hashDefinition(finalCandidate),
        }) }
      : {}),
    terminal: Object.freeze({
      terminalObservationId: safeProviderFactId(driver, "terminal", attemptId),
      outcome,
      receiptDigest: settlement.receiptDigest,
    }),
  });
}

function assertInterruptReceipt(
  driver: AcpTaskNativeDriver,
  value: Readonly<{ readonly acceptance: "accepted"; readonly completion: "unknown" }>,
): void {
  if (!value || value.acceptance !== "accepted" || value.completion !== "unknown") {
    throw safeError(driver, "interrupt_receipt_invalid");
  }
}

function isSafeContent(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= SAFE_CONTENT_MAX
    && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}

function reconcilingOutcome(
  bindingHandle: string,
  sessionExecutionAttemptId: string,
): AcpTaskSessionRuntimeNativeOutcome {
  return Object.freeze({
    status: "reconciling" as const,
    bindingHandle,
    sessionExecutionAttemptId,
    reason: "provider_outcome_unknown" as const,
  });
}

function safeProviderFactId(
  driver: AcpTaskNativeDriver,
  kind: "candidate" | "terminal",
  attemptId: string,
): string {
  const digest = createHash("sha256")
    .update(`agent-workspace:${driver.providerFactNamespace}-provider-fact\0`, "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(attemptId, "utf8")
    .digest("hex");
  return `provider_fact_${driver.providerFactNamespace}_${kind}_${digest}`;
}

function assertNativeEffectScope(
  driver: AcpTaskNativeDriver,
  input: Readonly<{
    readonly bindingHandle: string;
    readonly sessionExecutionAttemptId: string;
    readonly signal: AbortSignal;
  }>,
  bindingHandle: string,
): void {
  if (!input || input.bindingHandle !== bindingHandle) throw safeError(driver, "binding_mismatch");
  requiredAttemptId(driver, input.sessionExecutionAttemptId);
  assertEffectSignal(driver, input.signal);
}

function assertEffectSignal(driver: AcpTaskNativeDriver, signal: AbortSignal | undefined): void {
  if (!signal || typeof signal.aborted !== "boolean") throw safeError(driver, "abort_signal_invalid");
  if (signal.aborted) throw safeError(driver, "effect_aborted");
}

function requiredBindingHandle(driver: AcpTaskNativeDriver, value: unknown): string {
  if (typeof value !== "string" || !BINDING_HANDLE.test(value)) {
    throw safeError(driver, "binding_handle_invalid");
  }
  return value;
}

function requiredAttemptId(driver: AcpTaskNativeDriver, value: unknown): string {
  if (typeof value !== "string" || !ATTEMPT_ID.test(value)) throw safeError(driver, "attempt_id_invalid");
  return value;
}

function safeContent(driver: AcpTaskNativeDriver, value: unknown): string {
  if (!isSafeContent(value)) throw safeError(driver, "content_invalid");
  return value;
}

function normalizeDriver(value: unknown): AcpTaskNativeDriver {
  if (value === OPENCODE_ACP_TASK_NATIVE_DRIVER) return OPENCODE_ACP_TASK_NATIVE_DRIVER;
  if (value === CODEX_ACP_TASK_NATIVE_DRIVER) return CODEX_ACP_TASK_NATIVE_DRIVER;
  if (value === CLAUDE_CODE_ACP_TASK_NATIVE_DRIVER) return CLAUDE_CODE_ACP_TASK_NATIVE_DRIVER;
  throw new AcpTaskSessionRuntimeNativeError("acp_task_runtime_native_driver_invalid");
}

function safeError(driver: AcpTaskNativeDriver, suffix: string): AcpTaskSessionRuntimeNativeError {
  return new AcpTaskSessionRuntimeNativeError(`${driver.errorPrefix}_${suffix}`);
}
