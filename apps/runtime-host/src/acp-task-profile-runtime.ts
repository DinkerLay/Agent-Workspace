import { chmod, lstat, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type {
  AcpPromptSettlement,
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type {
  AcpProviderAvailabilityReport,
  AcpProviderProbeContext,
  AcpProviderProbeResult,
  AcpQualifiedBindingRuntime,
  AcpTargetCheckpointObserver,
} from "./acp-provider-composition.js";
import type {
  AcpTaskScopedMcpBinding,
  AcpTaskScopedMcpRole,
} from "./acp-task-scoped-mcp.js";
import { acpTaskRoleToolNames, isAcpTaskRole, type AcpTaskRole } from "./acp-task-role.js";

const OPAQUE_ID = /^[A-Za-z][A-Za-z0-9_-]{1,255}$/u;

export type AcpTaskPromptResult =
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

export type AcpTaskRuntimeDiagnostic = Readonly<{
  code: string;
  stage:
    | "attempt_activation"
    | "prompt"
    | "attempt_revoke"
    | "native_scope"
    | "turn_context"
    | "native_submit"
    | "native_reconciling";
}>;

/** Provider-neutral recovery seam owned by Session Runtime/durable Provider facts. */
export type AcpTaskPromptReconciler = Readonly<{
  reconcile(input: Readonly<{
    readonly bindingHandle: string;
    readonly attemptId: string;
    readonly knownObservations: readonly AcpSessionObservation[];
  }>): Promise<AcpTaskPromptResult>;
}>;

export type AcpTaskBindingRuntime<
  TProviderFamily extends string,
  TAcpAgentKind extends string,
> = Readonly<{
  readonly bindingHandle: string;
  readonly role: AcpTaskRole;
  readonly report: AcpProviderAvailabilityReport;
  submitPrompt(input: Readonly<{
    readonly attemptId: string;
    readonly content: string;
    readonly interactionRevision?: number;
    readonly turnContext?: ProviderScopedToolTurnContext;
  }>): Promise<AcpTaskPromptResult>;
  /** Never submits content; it only consumes durable/provider reconciliation facts. */
  reconcilePrompt(input: Readonly<{
    readonly attemptId: string;
  }>): Promise<AcpTaskPromptResult>;
  /** Acceptance is intent-only; terminal/late-final truth arrives from submitPrompt. */
  requestInterrupt(input: Readonly<{
    readonly attemptId: string;
  }>): Promise<Readonly<{
    readonly acceptance: "accepted";
    readonly completion: "unknown";
  }>>;
  releaseBinding(): Promise<void>;
  safeObservation(): Readonly<{
    readonly providerFamily: TProviderFamily;
    readonly acpAgentKind: TAcpAgentKind;
    readonly executionProfileId: string;
    readonly profileRevisionId: string;
    readonly role: AcpTaskRole;
    readonly available: true;
    readonly qualificationClass: "binding_behavior";
    readonly evidenceClass: "injected_host_qualification";
  }>;
  close(): Promise<void>;
}>;

export type AcpTaskReadinessRegistry = Readonly<{
  read(key: string): AcpProviderAvailabilityReport | undefined;
  record(key: string, report: AcpProviderAvailabilityReport): void;
  safeObservation(): Readonly<{ readonly availableEntryCount: number }>;
}>;

export function createAcpTaskReadinessRegistry(
  options: Readonly<{ readonly ttlMs?: number; readonly now?: () => number }>,
  createError: (suffix: string) => Error,
): AcpTaskReadinessRegistry {
  const ttlMs = boundedReadinessTtl(
    options.ttlMs ?? 5_000,
    () => createError("readiness_ttl_invalid"),
  );
  const now = options.now ?? Date.now;
  const entries = new Map<string, Readonly<{
    report: AcpProviderAvailabilityReport;
    expiresAt: number;
  }>>();
  return Object.freeze({
    read(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.report;
    },
    record(key, report) {
      if (!report.available) return;
      entries.set(key, Object.freeze({ report, expiresAt: now() + ttlMs }));
    },
    safeObservation: () => Object.freeze({ availableEntryCount: entries.size }),
  });
}

export type AcpTaskBindingDisposition = "create" | "load" | "resume";

export type AcpTaskQualificationProbeStep = Readonly<{
  readonly attemptId: string;
  readonly content: string;
  readonly interactionRevision?: number;
  readonly turnContext?: ProviderScopedToolTurnContext;
  readonly expectedFinalCandidate?: string;
}>;

export type AcpTaskQualificationProbe = AcpTaskQualificationProbeStep & Readonly<{
  readonly additionalSteps?: readonly AcpTaskQualificationProbeStep[];
}>;

export function createAcpTaskQualificationTurnContext(
  scope: AcpTaskScopedMcpRole,
  calls: string[],
  createError: (suffix: string) => Error,
): ProviderScopedToolTurnContext {
  const registration = scope.registration;
  if (!registration) throw createError("probe_tools_unavailable");
  const expected = new Set(registration.tools.map(({ name }) => name));
  return Object.freeze({
    capabilityClass: registration.capabilityClass,
    lease: Object.freeze({ qualification: true }),
    async handleCall(call: ProviderScopedToolCall) {
      if (!expected.has(call.name) || calls.includes(call.name)) {
        throw createError("probe_tool_call_invalid");
      }
      calls.push(call.name);
      return Object.freeze({
        providerCallId: call.providerCallId,
        result: Object.freeze({ probe: "accepted", tool: call.name }),
      });
    },
  });
}

export function validateAcpTaskProbeEvidence(input: Readonly<{
  settlement: AcpPromptSettlement;
  observations: readonly AcpSessionObservation[];
  expectedToolNames: readonly string[];
  actualToolNames: readonly string[];
  toolMatch: "ordered" | "exact_set";
  createError(suffix: string): Error;
}>): void {
  const receipt = input.observations.find(({ kind }) => kind === "delivery_receipt");
  const finals = input.observations.filter((entry) => entry.kind === "final_candidate");
  const terminals = input.observations.filter((entry) => entry.kind === "prompt_terminal");
  const latestFinal = finals.at(-1);
  const terminal = terminals.at(-1);
  if (!receipt || !latestFinal || latestFinal.kind !== "final_candidate" || !latestFinal.text) {
    throw input.createError("probe_receipt_final_missing");
  }
  if (
    !terminal
    || terminal.kind !== "prompt_terminal"
    || terminals.length !== 1
    || terminal.stopReason !== input.settlement.stopReason
    || input.settlement.finalCandidate !== latestFinal.text
  ) {
    throw input.createError("probe_terminal_invalid");
  }
  const toolsMatch = input.toolMatch === "ordered"
    ? sameList(input.expectedToolNames, input.actualToolNames)
    : sameExactSet(input.expectedToolNames, input.actualToolNames);
  if (!toolsMatch) throw input.createError("probe_scoped_tools_incomplete");
}

export function acpTaskQualificationPrompt(role: AcpTaskRole): string {
  if (role === "conductor") {
    return [
      "ACP qualification only. Call each scoped tool exactly once in this order:",
      "invoke_agent with {\"agentCardId\":\"agent_card_probe\"};",
      "send_to_session with {\"sessionId\":\"logical_session_probe\",\"payload\":{\"content\":\"probe\"}};",
      "interrupt_session with {\"sessionId\":\"logical_session_probe\"};",
      "close_session with {\"sessionId\":\"logical_session_probe\"}.",
      "Then reply exactly AGENT_WORKSPACE_ACP_PROBE_OK.",
    ].join(" ");
  }
  return "ACP qualification only. Do not call tools. Reply exactly AGENT_WORKSPACE_ACP_PROBE_OK.";
}

export function acpTaskQualificationBehaviors(
  providerPrefix: string,
  disposition: AcpTaskBindingDisposition,
  scopedTools: boolean,
): readonly string[] {
  return Object.freeze([
    `${providerPrefix}.binding.${disposition}`,
    `${providerPrefix}.prompt.receipt`,
    `${providerPrefix}.prompt.final`,
    `${providerPrefix}.prompt.terminal`,
    ...(scopedTools ? [`${providerPrefix}.scoped_tools.exact`] : []),
  ]);
}

export type AcpTaskQualificationWorkingDirectory = Readonly<{
  readonly directory: string;
  cleanup(): Promise<void>;
}>;

export async function createAcpTaskQualificationWorkingDirectory(input: Readonly<{
  parentDirectory: unknown;
  directoryPrefix: string;
  createError(suffix: string): Error;
  isTaskProfileError(error: unknown): boolean;
}>): Promise<AcpTaskQualificationWorkingDirectory> {
  if (
    typeof input.parentDirectory !== "string"
    || !path.isAbsolute(input.parentDirectory)
    || input.parentDirectory.includes("\0")
  ) {
    throw input.createError("qualification_cwd_parent_invalid");
  }
  let parent: string;
  try {
    parent = await realpath(path.normalize(input.parentDirectory));
    const metadata = await stat(parent);
    if (!metadata.isDirectory()) throw new Error("not_directory");
  } catch {
    throw input.createError("qualification_cwd_parent_invalid");
  }
  let directory: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      if (!directory) return;
      await rm(directory, { recursive: true, force: true });
      try {
        await lstat(directory);
      } catch (error) {
        if (isMissingFile(error)) return;
        throw input.createError("qualification_cwd_cleanup_unconfirmed");
      }
      throw input.createError("qualification_cwd_cleanup_unconfirmed");
    })();
    return cleanupPromise;
  };
  try {
    directory = await mkdtemp(path.join(parent, input.directoryPrefix));
    await chmod(directory, 0o700);
    const [metadata, canonical, entries] = await Promise.all([
      lstat(directory),
      realpath(directory),
      readdir(directory),
    ]);
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (metadata.mode & 0o777) !== 0o700
      || canonical !== directory
      || entries.length !== 0
    ) {
      throw input.createError("qualification_cwd_invalid");
    }
    return Object.freeze({ directory, cleanup });
  } catch (error) {
    try {
      await cleanup();
    } catch {
      throw input.createError("qualification_cwd_cleanup_unconfirmed");
    }
    if (input.isTaskProfileError(error)) throw error;
    throw input.createError("qualification_cwd_invalid");
  }
}

export async function canonicalAcpTaskWorkspace(
  value: unknown,
  createError: (suffix: string) => Error,
): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw createError("workspace_directory_invalid");
  }
  const normalized = path.normalize(value);
  let metadata;
  let canonical;
  try {
    [metadata, canonical] = await Promise.all([lstat(normalized), realpath(normalized)]);
  } catch {
    throw createError("workspace_directory_invalid");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== normalized) {
    throw createError("workspace_directory_invalid");
  }
  return canonical;
}

export function normalizeAcpTaskSessionConfiguration(
  value: AcpSessionConfigurationIntent,
  expectedModel: string,
  createError: (suffix: string) => Error,
): AcpSessionConfigurationIntent {
  if (!value || value.model !== expectedModel || !Array.isArray(value.options)) {
    throw createError("session_configuration_invalid");
  }
  return Object.freeze({
    model: value.model,
    options: Object.freeze(value.options.map((option) => Object.freeze({ ...option }))),
    ...(value.legacyModeId === undefined ? {} : { legacyModeId: value.legacyModeId }),
  });
}

export function normalizeAcpTaskCapabilities(
  value: readonly AcpV1Capability[],
  createError: (suffix: string) => Error,
): readonly AcpV1Capability[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    throw createError("required_capabilities_invalid");
  }
  return Object.freeze([...value]);
}

export function normalizeAcpTaskRole(
  value: unknown,
  createError: (suffix: string) => Error,
): AcpTaskRole {
  if (!isAcpTaskRole(value)) throw createError("task_role_invalid");
  return value;
}

export function normalizeAcpTaskBindingDisposition(
  value: unknown,
  createError: (suffix: string) => Error,
): AcpTaskBindingDisposition {
  if (value !== "create" && value !== "load" && value !== "resume") {
    throw createError("binding_disposition_invalid");
  }
  return value;
}

export function assertAcpTaskProfile(input: Readonly<{
  profile: ExecutionProfileDefinitionV3;
  role: AcpTaskRole;
  providerFamily: string;
  acpAgentKind: string;
  createError(suffix: string): Error;
}>): void {
  if (
    !input.profile
    || input.profile.providerFamily !== input.providerFamily
    || input.profile.acpAgentKind !== input.acpAgentKind
    || input.profile.protocolMajor !== 1
  ) {
    throw input.createError("profile_mismatch");
  }
  const actual = input.profile.capabilityPolicy?.allowedTools;
  const expected = acpTaskRoleToolNames(input.role);
  if (!Array.isArray(actual)
    || actual.some((tool) => typeof tool !== "string")
    || new Set(actual).size !== actual.length
    || actual.length !== expected.length
    || expected.some((tool) => !actual.includes(tool))) {
    throw input.createError("profile_role_tools_mismatch");
  }
}

export function requiredAcpTaskOpaqueId(
  value: unknown,
  createError: () => Error,
): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw createError();
  return value;
}

export async function runAcpTaskQualificationProbe(input: Readonly<{
  context: AcpProviderProbeContext;
  probeScope: AcpTaskScopedMcpRole;
  providerWorkingDirectory: string;
  requiredBehaviors: readonly string[];
  sessionConfiguration: AcpSessionConfigurationIntent;
  expectedModel: string;
  createQualificationAttemptId(): string;
  createQualificationProbe?: () => AcpTaskQualificationProbe;
  probeObservations: readonly AcpSessionObservation[];
  qualificationAttemptIds: Set<string>;
  toolMatch: "ordered" | "exact_set";
  createError(suffix: string): Error;
  setScopeBinding(binding: AcpTaskScopedMcpBinding | undefined): void;
  recordQualificationPromptEffect(): void;
  onAttemptActive?: (input: Readonly<{
    readonly context: AcpProviderProbeContext;
    readonly attemptId: string;
    readonly maxPermissionResponses: number;
  }>) => void;
  onAttemptInactive?: () => void;
}>): Promise<AcpProviderProbeResult> {
  const { context, probeScope } = input;
  let scopedBinding: AcpTaskScopedMcpBinding | undefined;
  if (probeScope.registration) {
    if (!context.reverseRpcLease) throw input.createError("probe_reverse_rpc_missing");
    scopedBinding = await probeScope.openBindingRoute({
      bindingHandle: context.bindingHandle,
      reverseRpcLease: context.reverseRpcLease,
    });
    input.setScopeBinding(scopedBinding);
  } else if (context.reverseRpcLease) {
    throw input.createError("probe_reverse_rpc_forbidden");
  }
  const binding = await context.client.ensureBinding({
    bindingHandle: context.bindingHandle,
    disposition: "create",
    workspaceDirectory: input.providerWorkingDirectory,
    mcpServers: scopedBinding?.mcpServers ?? Object.freeze([]),
    configuration: input.sessionConfiguration,
  });
  if (binding.bindingHandle !== context.bindingHandle || binding.model !== input.expectedModel) {
    throw input.createError("probe_binding_observation_invalid");
  }
  if (scopedBinding) {
    await scopedBinding.waitForToolDiscovery();
  }
  const customProbe = input.createQualificationProbe?.();
  const probeSteps: readonly AcpTaskQualificationProbeStep[] = customProbe
    ? Object.freeze([customProbe, ...(customProbe.additionalSteps ?? [])])
    : Object.freeze([Object.freeze({
        attemptId: input.createQualificationAttemptId(),
        content: acpTaskQualificationPrompt(probeScope.role),
      })]);
  const expectedToolNames = probeScope.registration?.tools.map(({ name }) => name) ?? [];
  const isMultiStep = probeSteps.length > 1;
  if (isMultiStep && probeSteps.length !== expectedToolNames.length) {
    throw input.createError("probe_step_count_invalid");
  }
  const toolCalls: string[] = [];
  const stepAttemptIds = new Set<string>();
  let lastSettlement: AcpPromptSettlement | undefined;
  for (const [stepIndex, step] of probeSteps.entries()) {
    const attemptId = requiredAcpTaskOpaqueId(
      step.attemptId,
      () => input.createError("probe_attempt_id_invalid"),
    );
    if (stepAttemptIds.has(attemptId)) {
      throw input.createError("probe_attempt_id_reused");
    }
    stepAttemptIds.add(attemptId);
    input.qualificationAttemptIds.add(attemptId);
    const stepToolCalls: string[] = [];
    if (scopedBinding && probeScope.registration) {
      const qualificationTurnContext = step.turnContext
        ? observeAcpTaskQualificationTurnContext(step.turnContext, stepToolCalls)
        : createAcpTaskQualificationTurnContext(
            probeScope,
            stepToolCalls,
            input.createError,
          );
      await scopedBinding.activateAttempt({
        attemptId,
        interactionRevision: step.interactionRevision ?? 1,
        turnContext: qualificationTurnContext,
      });
    } else if (step.turnContext) {
      throw input.createError("probe_turn_context_forbidden");
    }
    let settlement: AcpPromptSettlement;
    const stepExpectedToolNames = isMultiStep
      ? Object.freeze([expectedToolNames[stepIndex]!])
      : expectedToolNames;
    try {
      input.onAttemptActive?.({
        context,
        attemptId,
        maxPermissionResponses: stepExpectedToolNames.length,
      });
      input.recordQualificationPromptEffect();
      settlement = await context.client.submitPrompt({
        bindingHandle: context.bindingHandle,
        attemptId,
        content: step.content,
      });
    } finally {
      input.onAttemptInactive?.();
      await revokeAcpTaskScopedAttempt(scopedBinding);
    }
    const observations = input.probeObservations.filter((entry) => entry.attemptId === attemptId);
    validateAcpTaskProbeEvidence({
      settlement,
      observations,
      expectedToolNames: stepExpectedToolNames,
      actualToolNames: stepToolCalls,
      toolMatch: input.toolMatch,
      createError: input.createError,
    });
    if (step.expectedFinalCandidate !== undefined
      && settlement.finalCandidate?.trim() !== step.expectedFinalCandidate) {
      throw input.createError("qualification_result_not_consumed");
    }
    toolCalls.push(...stepToolCalls);
    lastSettlement = settlement;
  }
  if (!lastSettlement) throw input.createError("probe_steps_missing");
  return Object.freeze({
    passedBehaviors: input.requiredBehaviors,
    modelCatalog: binding.modelCatalog,
    bindingEstablished: true,
    safeObservations: Object.freeze({
      bindingRecovered: false,
      promptReceipt: true,
      finalObserved: true,
      terminalObserved: true,
      scopedToolCallCount: toolCalls.length,
      stopReason: lastSettlement.stopReason,
    }),
  });
}

function observeAcpTaskQualificationTurnContext(
  context: ProviderScopedToolTurnContext,
  calls: string[],
): ProviderScopedToolTurnContext {
  return Object.freeze({
    capabilityClass: context.capabilityClass,
    lease: context.lease,
    async handleCall(call: ProviderScopedToolCall) {
      const result = await context.handleCall(call);
      calls.push(call.name);
      return result;
    },
  });
}

export function createAcpTaskBindingRuntime<
  TProviderFamily extends string,
  TAcpAgentKind extends string,
>(input: Readonly<{
  profile: Readonly<{
    readonly executionProfileId: string;
    readonly profileRevisionId: string;
  }>;
  role: AcpTaskRole;
  providerFamily: TProviderFamily;
  acpAgentKind: TAcpAgentKind;
  generic: Pick<
    AcpQualifiedBindingRuntime,
    "bindingHandle" | "client" | "report" | "releaseBinding" | "close"
  >;
  getScopeBinding(): AcpTaskScopedMcpBinding | undefined;
  turnObservations: Map<string, AcpSessionObservation[]>;
  qualificationAttemptIds: ReadonlySet<string>;
  reconciler?: AcpTaskPromptReconciler;
  checkpointObserver?: AcpTargetCheckpointObserver;
  createError(suffix: string): Error;
  recordBusinessPromptEffect(): void;
  preparePrivateWorkingDirectory(): Promise<void>;
  releasePrivateWorkingDirectory(): Promise<void>;
  onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
}>): AcpTaskBindingRuntime<TProviderFamily, TAcpAgentKind> {
  let activeAttemptId: string | undefined;
  let released = false;
  let closed = false;
  let poisoned = false;
  let closePromise: Promise<void> | undefined;
  const promptResults = new Map<string, AcpTaskPromptResult>();
  const unresolvedAttemptIds = new Set<string>();
  const reconcileInFlight = new Map<string, Promise<AcpTaskPromptResult>>();

  return Object.freeze({
    bindingHandle: input.generic.bindingHandle,
    role: input.role,
    report: input.generic.report,
    async submitPrompt(turn) {
      if (closed) throw input.createError("task_binding_closed");
      if (poisoned) throw input.createError("task_binding_poisoned");
      if (released) throw input.createError("task_binding_released");
      const attemptId = requiredOpaqueId(
        turn?.attemptId,
        () => input.createError("task_attempt_id_invalid"),
      );
      if (typeof turn.content !== "string") throw input.createError("task_prompt_invalid");
      if (input.qualificationAttemptIds.has(attemptId)) {
        throw input.createError("task_qualification_attempt_reserved");
      }
      const existing = promptResults.get(attemptId);
      if (existing) return existing;
      if (unresolvedAttemptIds.size > 0) {
        throw input.createError("task_reconciliation_required");
      }
      if (activeAttemptId) throw input.createError("task_attempt_already_active");
      const scopeBinding = input.getScopeBinding();
      if (scopeBinding) {
        if (!turn.turnContext) throw input.createError("task_turn_context_required");
        try {
          await scopeBinding.activateAttempt({
            attemptId,
            interactionRevision: boundedRevision(
              turn.interactionRevision ?? 1,
              () => input.createError("interaction_revision_invalid"),
            ),
            turnContext: turn.turnContext,
            ...(input.checkpointObserver
              ? { checkpointObserver: input.checkpointObserver }
              : {}),
          });
        } catch (error) {
          reportRuntimeDiagnostic(input.onDiagnostic, "attempt_activation", error);
          throw error;
        }
      } else if (turn.turnContext) {
        throw input.createError("task_turn_context_forbidden");
      }
      activeAttemptId = attemptId;
      input.turnObservations.delete(attemptId);
      let result: AcpTaskPromptResult;
      try {
        input.recordBusinessPromptEffect();
        const settlement = await input.generic.client.submitPrompt({
          bindingHandle: input.generic.bindingHandle,
          attemptId,
          content: turn.content,
        });
        result = Object.freeze({
          state: "settled",
          settlement,
          observations: snapshotObservations(input.turnObservations, attemptId),
        });
      } catch (error) {
        reportRuntimeDiagnostic(input.onDiagnostic, "prompt", error);
        result = reconcilingResult(snapshotObservations(input.turnObservations, attemptId));
      } finally {
        activeAttemptId = undefined;
        try {
          await revokeAcpTaskScopedAttempt(scopeBinding);
        } catch (error) {
          reportRuntimeDiagnostic(input.onDiagnostic, "attempt_revoke", error);
          result = reconcilingResult(snapshotObservations(input.turnObservations, attemptId));
        }
      }
      promptResults.set(attemptId, result!);
      if (result!.state === "reconciling") unresolvedAttemptIds.add(attemptId);
      return result!;
    },
    reconcilePrompt(request) {
      if (closed) return Promise.reject(input.createError("task_binding_closed"));
      if (poisoned) return Promise.reject(input.createError("task_binding_poisoned"));
      if (released) return Promise.reject(input.createError("task_binding_released"));
      const attemptId = requiredOpaqueId(
        request?.attemptId,
        () => input.createError("task_attempt_id_invalid"),
      );
      const existing = promptResults.get(attemptId);
      if (existing?.state === "settled") {
        input.checkpointObserver?.observe({
          kind: "task_reconcile_settled",
          bindingHandle: input.generic.bindingHandle,
          attemptId,
          role: input.role,
        });
        return Promise.resolve(existing);
      }
      const reconciler = input.reconciler;
      if (!existing && !reconciler) {
        return Promise.reject(input.createError("task_reconcile_unavailable"));
      }
      const current = existing ?? reconcilingResult(
        snapshotObservations(input.turnObservations, attemptId),
      );
      if (!reconciler) return Promise.resolve(current);
      const inFlight = reconcileInFlight.get(attemptId);
      if (inFlight) return inFlight;
      const pending = (async () => {
        let next: AcpTaskPromptResult = current;
        try {
          next = normalizeReconciledPromptResult(
            await reconciler.reconcile({
              bindingHandle: input.generic.bindingHandle,
              attemptId,
              knownObservations: current.observations,
            }),
            input.generic.bindingHandle,
            attemptId,
            current.observations,
          );
        } catch {
          next = current;
        }
        promptResults.set(attemptId, next);
        if (next.state === "settled") {
          unresolvedAttemptIds.delete(attemptId);
          input.checkpointObserver?.observe({
            kind: "task_reconcile_settled",
            bindingHandle: input.generic.bindingHandle,
            attemptId,
            role: input.role,
          });
        } else {
          unresolvedAttemptIds.add(attemptId);
        }
        return next;
      })().finally(() => {
        reconcileInFlight.delete(attemptId);
      });
      reconcileInFlight.set(attemptId, pending);
      return pending;
    },
    async requestInterrupt(request) {
      if (closed) throw input.createError("task_binding_closed");
      if (poisoned) throw input.createError("task_binding_poisoned");
      const attemptId = requiredOpaqueId(
        request?.attemptId,
        () => input.createError("task_attempt_id_invalid"),
      );
      if (activeAttemptId !== attemptId) {
        throw input.createError("task_interrupt_attempt_mismatch");
      }
      await revokeAcpTaskScopedAttempt(input.getScopeBinding());
      const receipt = await input.generic.client.requestInterrupt({
        bindingHandle: input.generic.bindingHandle,
        attemptId,
      });
      if (receipt.acceptance !== "accepted") {
        throw input.createError("task_interrupt_receipt_invalid");
      }
      input.checkpointObserver?.observe({
        kind: "task_cancel_accepted",
        bindingHandle: input.generic.bindingHandle,
        attemptId,
        role: input.role,
      });
      return Object.freeze({ acceptance: "accepted" as const, completion: "unknown" as const });
    },
    async releaseBinding() {
      if (closed) throw input.createError("task_binding_closed");
      if (released) return;
      if (activeAttemptId) throw input.createError("task_release_active_attempt");
      const scopeBinding = input.getScopeBinding();
      let cleanupConfirmed = await runAcpTaskOwnedCleanup([
        () => revokeAcpTaskScopedAttempt(scopeBinding),
        () => scopeBinding?.close() ?? Promise.resolve(),
        () => input.generic.releaseBinding(),
      ]);
      let processCleanupConfirmed = true;
      try {
        await input.generic.close();
      } catch {
        processCleanupConfirmed = false;
        cleanupConfirmed = false;
      }
      if (processCleanupConfirmed) {
        try {
          await input.releasePrivateWorkingDirectory();
        } catch {
          cleanupConfirmed = false;
        }
      }
      if (!cleanupConfirmed) {
        poisoned = true;
        if (processCleanupConfirmed) closed = true;
        throw input.createError("task_cleanup_unconfirmed");
      }
      released = true;
      closed = true;
    },
    safeObservation: () => Object.freeze({
      providerFamily: input.providerFamily,
      acpAgentKind: input.acpAgentKind,
      executionProfileId: input.profile.executionProfileId,
      profileRevisionId: input.profile.profileRevisionId,
      role: input.role,
      available: true as const,
      qualificationClass: "binding_behavior" as const,
      evidenceClass: "injected_host_qualification" as const,
    }),
    close() {
      closePromise ??= (async () => {
        if (closed) return;
        closed = true;
        const scopeBinding = input.getScopeBinding();
        let cleanupConfirmed = await runAcpTaskOwnedCleanup([
          () => scopeBinding?.close() ?? Promise.resolve(),
        ]);
        let processCleanupConfirmed = true;
        try {
          await input.generic.close();
        } catch {
          processCleanupConfirmed = false;
          cleanupConfirmed = false;
        }
        if (processCleanupConfirmed) {
          try {
            await input.preparePrivateWorkingDirectory();
          } catch {
            cleanupConfirmed = false;
          }
        }
        if (!cleanupConfirmed) {
          poisoned = true;
          throw input.createError("task_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
}

function reportRuntimeDiagnostic(
  sink: ((diagnostic: AcpTaskRuntimeDiagnostic) => void) | undefined,
  stage: AcpTaskRuntimeDiagnostic["stage"],
  error: unknown,
): void {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : error instanceof Error
      ? error.message
      : undefined;
  const code = typeof candidate === "string" && /^[a-z][a-z0-9_]{2,127}$/u.test(candidate)
    ? candidate
    : "acp_task_runtime_failure";
  try {
    sink?.(Object.freeze({ code, stage }));
  } catch {
    // A diagnostic sink may not affect Task execution or recovery semantics.
  }
}

export async function runAcpTaskOwnedCleanup(
  actions: readonly (() => Promise<void>)[],
): Promise<boolean> {
  let confirmed = true;
  for (const action of actions) {
    try {
      await action();
    } catch {
      confirmed = false;
    }
  }
  return confirmed;
}

export function acpTaskReportHasUnconfirmedCleanup(
  report: AcpProviderAvailabilityReport,
): boolean {
  return report.unavailableReasons.some((reason) => (
    (reason.includes("cleanup") && (reason.includes("unconfirmed") || reason.includes("timeout")))
    || reason.includes("process_exit_unconfirmed")
  ));
}

export async function revokeAcpTaskScopedAttempt(
  binding: AcpTaskScopedMcpBinding | undefined,
): Promise<void> {
  if (binding) await binding.revokeAttempt();
}

function snapshotObservations(
  observations: ReadonlyMap<string, readonly AcpSessionObservation[]>,
  attemptId: string,
): readonly AcpSessionObservation[] {
  return Object.freeze([...(observations.get(attemptId) ?? [])]);
}

function reconcilingResult(
  observations: readonly AcpSessionObservation[],
): AcpTaskPromptResult {
  return Object.freeze({
    state: "reconciling" as const,
    reason: "provider_outcome_unknown" as const,
    resendAllowed: false as const,
    observations: Object.freeze([...observations]),
  });
}

function normalizeReconciledPromptResult(
  value: AcpTaskPromptResult,
  bindingHandle: string,
  attemptId: string,
  fallbackObservations: readonly AcpSessionObservation[],
): AcpTaskPromptResult {
  if (!value || !Array.isArray(value.observations)) {
    return reconcilingResult(fallbackObservations);
  }
  const observations = value.observations.every((observation) => (
    observation?.bindingHandle === bindingHandle && observation.attemptId === attemptId
  ))
    ? Object.freeze([...value.observations])
    : Object.freeze([...fallbackObservations]);
  if (value.state !== "settled") return reconcilingResult(observations);
  const settlement = value.settlement;
  if (
    !settlement
    || settlement.bindingHandle !== bindingHandle
    || settlement.attemptId !== attemptId
    || typeof settlement.receiptDigest !== "string"
    || !Number.isSafeInteger(settlement.finalCandidateGroupCount)
    || settlement.finalCandidateGroupCount < 0
  ) {
    return reconcilingResult(observations);
  }
  return Object.freeze({
    state: "settled" as const,
    settlement: Object.freeze({ ...settlement }),
    observations,
  });
}

function requiredOpaqueId(value: unknown, error: () => Error): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw error();
  return value;
}

function boundedRevision(value: unknown, error: () => Error): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw error();
  return value as number;
}

function boundedReadinessTtl(value: unknown, error: () => Error): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 5 * 60_000) {
    throw error();
  }
  return value as number;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameExactSet(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length
    && new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
