import { createHash, randomUUID } from "node:crypto";
import type { AcpSessionObservation } from "@agent-workspace/provider-acp";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import {
  assertBindingHandle,
  assertInteractionChoiceId,
  assertInteractionId,
  assertJsonValue,
  assertSessionExecutionSafeValue,
  canonicalJson,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  CONDUCTOR_ORCHESTRATION_TOOL_NAMES,
  hashDefinition,
  validateAcpSafeSessionBindingRecordV3,
  type AcpSafeSessionBindingRecordV3,
  type ExecutionProfileDefinitionV3,
  type JsonObject,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  FinalCandidateObservationInput,
  InteractionRequestedObservationInput,
  SessionExecutionRuntimeOwner,
} from "@agent-workspace/runtime-application";
import type {
  AcpV3BindingRepository,
  AcpV3FrozenProfileTuple,
  AcpV3FrozenProfileTupleResolver,
  AcpV3SessionRuntimeRepository,
} from "@agent-workspace/runtime-store";
import type { AcpTaskPromptReconciler } from "./acp-task-profile-runtime.js";
import type {
  CodexAcpNativeAttemptInput,
} from "./acp-codex-task-profile.js";
import type {
  SessionIdAcpProductionExecutionObservation,
  SessionIdAcpProductionFinalCandidateObservation,
  SessionIdAcpProductionTaskFactoryContext,
  SessionIdAcpTaskRole,
} from "./session-id-acp-production-composition.js";

const ATTEMPT_ID = /^session_execution_attempt_[A-Za-z0-9_-]{1,223}$/u;
const TOOL_HANDLE = /^tool_handle_[A-Za-z0-9_-]{1,244}$/u;
const PROFILE_ID = /^profile_[A-Za-z0-9_-]+$/u;
const PROFILE_REVISION_ID = /^profile_revision_[A-Za-z0-9_-]+$/u;
const ACTIVE_ATTEMPT_STATES = Object.freeze([
  "awaiting_receipt",
  "active",
  "waiting_for_interaction",
  "candidate_observed",
] as const);
const OBSERVATION_KEYS = Object.freeze([
  "bindingId",
  "bindingHandle",
  "logicalSessionId",
  "executionProfileId",
  "profileRevisionId",
  "providerFamily",
  "role",
  "observation",
]);
const ROLE_TOOLS = Object.freeze({
  conductor: CONDUCTOR_ORCHESTRATION_TOOL_NAMES,
  publisher: Object.freeze([]),
  worker: Object.freeze([]),
  reviewer: Object.freeze([]),
} satisfies Readonly<Record<SessionIdAcpTaskRole, readonly string[]>>);

type QualificationExpectation = Readonly<{
  readonly name: string;
  readonly arguments: JsonObject;
}>;

const QUALIFICATION_EXPECTATIONS = Object.freeze({
  conductor: Object.freeze([
    Object.freeze({
      name: "invoke_agent",
      arguments: Object.freeze({ agentCardId: "agent_card_qualification" }),
    }),
    Object.freeze({
      name: "send_to_session",
      arguments: Object.freeze({
        sessionId: "logical_session_qualification",
        payload: Object.freeze({ content: "qualification" }),
      }),
    }),
    Object.freeze({
      name: "interrupt_session",
      arguments: Object.freeze({ sessionId: "logical_session_qualification" }),
    }),
    Object.freeze({
      name: "close_session",
      arguments: Object.freeze({ sessionId: "logical_session_qualification" }),
    }),
  ]),
  publisher: Object.freeze([]),
  worker: Object.freeze([]),
  reviewer: Object.freeze([]),
} satisfies Readonly<Record<SessionIdAcpTaskRole, readonly QualificationExpectation[]>>);

export type SessionIdAcpProductionHumanOnlyDiagnostic =
  | Readonly<{
      readonly kind: "agent_message_chunk";
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionExecutionAttemptId: string;
      readonly role: SessionIdAcpTaskRole;
      readonly text: string;
    }>
  | Readonly<{
      readonly kind: "agent_thought_chunk";
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionExecutionAttemptId: string;
      readonly role: SessionIdAcpTaskRole;
      readonly text: string;
    }>
  | Readonly<{
      readonly kind: "tool_status";
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionExecutionAttemptId: string;
      readonly activityKey: string;
      readonly role: SessionIdAcpTaskRole;
      readonly title?: string;
      readonly status?: "pending" | "in_progress" | "completed" | "failed";
    }>;

export type SessionIdAcpProductionRuntimeInvalidation = Readonly<{
  readonly reason: "session_execution_changed";
  readonly taskId: string;
  readonly runId: string;
  readonly logicalSessionId: string;
}>;

export type SessionIdAcpProductionPolicyOwnerOptions = Readonly<{
  readonly bindings: Pick<AcpV3BindingRepository, "getBinding" | "getCurrentBinding">;
  readonly sessionRuntime: Pick<
    AcpV3SessionRuntimeRepository,
    "getRuntime" | "getRuntimeForSession" | "getAttempt"
  >;
  readonly resolveFrozenProfile: AcpV3FrozenProfileTupleResolver;
  readonly sessionRuntimeOwner: Pick<
    SessionExecutionRuntimeOwner,
    "handleInteractionRequested" | "handleFinalCandidate"
  >;
  readonly onHumanOnlyDiagnostic: (
    value: SessionIdAcpProductionHumanOnlyDiagnostic,
  ) => void | Promise<void>;
  readonly onRuntimeInvalidation: (
    value: SessionIdAcpProductionRuntimeInvalidation,
  ) => void | Promise<void>;
}>;

export type SessionIdAcpProductionPolicyOwner = Readonly<{
  readonly openCode: Readonly<{
    readonly resolveReconciler: (
      context: SessionIdAcpProductionTaskFactoryContext,
    ) => AcpTaskPromptReconciler | undefined;
  }>;
  readonly claudeCode: Readonly<{
    readonly resolveReconciler: (
      context: SessionIdAcpProductionTaskFactoryContext,
    ) => AcpTaskPromptReconciler | undefined;
  }>;
  readonly codex: Readonly<{
    readonly createReadinessProbe: (input: Readonly<{
      readonly profile: ExecutionProfileDefinitionV3;
      readonly role: SessionIdAcpTaskRole;
    }>) => CodexAcpNativeAttemptInput;
    readonly createQualificationProbe: (
      context: SessionIdAcpProductionTaskFactoryContext,
    ) => CodexAcpNativeAttemptInput;
    readonly resolveReconciler: (
      context: SessionIdAcpProductionTaskFactoryContext,
    ) => AcpTaskPromptReconciler | undefined;
  }>;
  readonly observeExecution: (
    observation: SessionIdAcpProductionExecutionObservation,
  ) => Promise<void>;
  readonly observeFinalCandidate: (
    observation: SessionIdAcpProductionFinalCandidateObservation,
  ) => Promise<void>;
}>;

/**
 * Pure production Codex qualification policy.  This narrow capability is
 * shared by the normal production owner and the release-parent qualification
 * child; it owns no repositories, durable state, Provider wire, or Task
 * Binding.
 */
export type SessionIdAcpProductionTaskProbePolicy = Readonly<{
  readonly createReadinessProbe: (input: Readonly<{
    readonly profile: ExecutionProfileDefinitionV3;
    readonly role: SessionIdAcpTaskRole;
  }>) => CodexAcpNativeAttemptInput;
  readonly createQualificationProbe: (
    context: SessionIdAcpProductionTaskFactoryContext,
  ) => CodexAcpNativeAttemptInput;
}>;

export function createSessionIdAcpProductionTaskProbePolicy():
SessionIdAcpProductionTaskProbePolicy {
  return Object.freeze({
    createReadinessProbe(input: Readonly<{
      readonly profile: ExecutionProfileDefinitionV3;
      readonly role: SessionIdAcpTaskRole;
    }>): CodexAcpNativeAttemptInput {
      validateCodexProfileRole(input?.profile, input?.role);
      return createCodexProbe("readiness", input.role);
    },
    createQualificationProbe(
      context: SessionIdAcpProductionTaskFactoryContext,
    ): CodexAcpNativeAttemptInput {
      const scope = validateFactoryContext(context, "codex");
      validateCodexProfileRole(scope.profile, scope.role);
      return createCodexProbe("qualification", scope.role);
    },
  });
}

/**
 * Production-only policy boundary shared by the two ACP Task factories. It
 * owns no Provider wire and accepts only read/interaction capabilities from
 * their canonical owners.
 */
export function createSessionIdAcpProductionPolicyOwner(
  options: SessionIdAcpProductionPolicyOwnerOptions,
): SessionIdAcpProductionPolicyOwner {
  validateOwnerOptions(options);
  const taskProbePolicy = createSessionIdAcpProductionTaskProbePolicy();

  const openCode = Object.freeze({
    resolveReconciler(context: SessionIdAcpProductionTaskFactoryContext) {
      const scope = validateFactoryContext(context, "opencode");
      if (scope.bindingDisposition === "create") return undefined;
      return createConservativeAcpTaskReconciler(scope.binding.bindingHandle);
    },
  });

  const codex = Object.freeze({
    ...taskProbePolicy,
    resolveReconciler(context: SessionIdAcpProductionTaskFactoryContext) {
      const scope = validateFactoryContext(context, "codex");
      validateCodexProfileRole(scope.profile, scope.role);
      if (scope.bindingDisposition === "create") return undefined;
      return createConservativeAcpTaskReconciler(scope.binding.bindingHandle);
    },
  });
  const claudeCode = Object.freeze({
    resolveReconciler(context: SessionIdAcpProductionTaskFactoryContext) {
      const scope = validateFactoryContext(context, "claude-code");
      if (scope.bindingDisposition === "create") return undefined;
      return createConservativeAcpTaskReconciler(scope.binding.bindingHandle);
    },
  });

  return Object.freeze({
    openCode,
    codex,
    claudeCode,
    observeFinalCandidate: async (
      value: SessionIdAcpProductionFinalCandidateObservation,
    ): Promise<void> => {
      const observation = snapshotExecutionObservation(value);
      if (observation.observation.kind !== "final_candidate") {
        throw safeError("acp_production_final_candidate_observation_invalid");
      }
      const fence = resolveCurrentObservationFence(options, observation);
      const content = observation.observation.text;
      const ownerInput: FinalCandidateObservationInput = Object.freeze({
        sessionExecutionAttemptId: fence.attempt.sessionExecutionAttemptId,
        expectedAttemptRevision: fence.attempt.revision,
        logicalSessionId: fence.binding.logicalSessionId,
        bindingId: fence.binding.bindingId,
        bindingRevision: fence.binding.revision,
        executionProfileId: fence.binding.executionProfileId,
        profileRevisionId: fence.binding.profileRevisionId,
        candidateObservationId: nativeCandidateObservationId(
          fence.binding.providerFamily,
          fence.attempt.sessionExecutionAttemptId,
        ),
        content,
        contentDigest: hashDefinition(content),
      });
      options.sessionRuntimeOwner.handleFinalCandidate(ownerInput);
      await options.onRuntimeInvalidation(invalidationFor(fence.binding));
    },
    observeExecution: async (value: SessionIdAcpProductionExecutionObservation): Promise<void> => {
      const observation = snapshotExecutionObservation(value);
      const fence = resolveCurrentObservationFence(options, observation);
      if (observation.observation.kind === "interaction_requested") {
        const ownerInput: InteractionRequestedObservationInput = Object.freeze({
          sessionExecutionAttemptId: fence.attempt.sessionExecutionAttemptId,
          expectedAttemptRevision: fence.attempt.revision,
          logicalSessionId: fence.binding.logicalSessionId,
          bindingId: fence.binding.bindingId,
          bindingRevision: fence.binding.revision,
          executionProfileId: fence.binding.executionProfileId,
          profileRevisionId: fence.binding.profileRevisionId,
          interactionId: observation.observation.interactionId,
          promptDigest: observation.observation.promptDigest,
          choices: Object.freeze(observation.observation.choices.map((choice) => Object.freeze({
            choiceId: choice.choiceId,
            label: choice.name,
          }))),
        });
        options.sessionRuntimeOwner.handleInteractionRequested(ownerInput);
        await options.onRuntimeInvalidation(invalidationFor(fence.binding));
        return;
      }
      if (observation.observation.kind === "agent_message_chunk"
        || observation.observation.kind === "agent_thought_chunk") {
        await options.onHumanOnlyDiagnostic(Object.freeze({
          kind: observation.observation.kind,
          taskId: fence.binding.taskId,
          runId: fence.binding.runId,
          logicalSessionId: fence.binding.logicalSessionId,
          sessionExecutionAttemptId: fence.attempt.sessionExecutionAttemptId,
          role: observation.role,
          text: observation.observation.text,
        }));
        await options.onRuntimeInvalidation(invalidationFor(fence.binding));
        return;
      }
      if (observation.observation.kind === "tool_status") {
        await options.onHumanOnlyDiagnostic(Object.freeze({
          kind: "tool_status" as const,
          taskId: fence.binding.taskId,
          runId: fence.binding.runId,
          logicalSessionId: fence.binding.logicalSessionId,
          sessionExecutionAttemptId: fence.attempt.sessionExecutionAttemptId,
          activityKey: `activity_key_${createHash("sha256")
            .update(observation.observation.toolCallHandle)
            .digest("hex")}`,
          role: observation.role,
          ...(observation.observation.title === undefined
            ? {}
            : { title: observation.observation.title }),
          ...(observation.observation.status === undefined
            ? {}
            : { status: observation.observation.status }),
        }));
        await options.onRuntimeInvalidation(invalidationFor(fence.binding));
      }
      // Receipt is already committed by the common SR receipt owner before
      // this callback. Final/terminal are committed from the canonical native
      // settlement, never from this activity/permission router.
    },
  });
}

function createCodexProbe(
  kind: "readiness" | "qualification",
  role: SessionIdAcpTaskRole,
): CodexAcpNativeAttemptInput {
  const expectations = QUALIFICATION_EXPECTATIONS[role];
  const qualificationTokens = expectations.map(
    () => `CODEX_QUALIFICATION_${randomUUID().replaceAll("-", "")}`,
  );
  const turnContext = createQualificationTurnContext(role, expectations, qualificationTokens);
  const steps = expectations.map((expectation, index) => Object.freeze({
    attemptId: `session_execution_attempt_codex_${kind}_${randomUUID().replaceAll("-", "")}`,
    content: qualificationPrompt(role, Object.freeze([expectation]), qualificationTokens[index]),
    interactionRevision: 1,
    ...(turnContext ? { turnContext } : {}),
    expectedFinalCandidate: qualificationTokens[index]!,
  }));
  if (steps.length > 0) {
    const [first, ...additionalSteps] = steps;
    return Object.freeze({
      attemptId: first!.attemptId,
      content: first!.content,
      interactionRevision: first!.interactionRevision,
      ...(first!.turnContext ? { turnContext: first!.turnContext } : {}),
      ...(additionalSteps.length > 0
        ? { additionalSteps: Object.freeze(additionalSteps) }
        : {}),
      qualificationExpectedFinalCandidate: first!.expectedFinalCandidate,
    });
  }
  return Object.freeze({
    attemptId: `session_execution_attempt_codex_${kind}_${randomUUID().replaceAll("-", "")}`,
    content: qualificationPrompt(role, expectations),
    // Reverse-RPC Attempt leases use positive, monotonically increasing
    // interaction revisions. Qualification is a real scoped Attempt, so its
    // first revision must obey the same fence as production Turns.
    interactionRevision: 1,
  });
}

function createQualificationTurnContext(
  role: SessionIdAcpTaskRole,
  expectations: readonly QualificationExpectation[],
  qualificationTokens: readonly string[],
): ProviderScopedToolTurnContext | undefined {
  if (expectations.length === 0) return undefined;
  const capabilityClass = "runtime_orchestration";
  const lease = Object.freeze({
    kind: "session_id_acp_qualification_lease" as const,
    role,
  });
  const providerCallIds = new Set<string>();
  let nextCall = 0;
  return Object.freeze({
    capabilityClass,
    lease,
    async handleCall(call: ProviderScopedToolCall) {
      if (!call || call.lease !== lease) {
        throw safeError("acp_production_qualification_lease_stale");
      }
      const providerCallId = requiredText(
        call.providerCallId,
        256,
        false,
        "acp_production_qualification_call_id_invalid",
      );
      if (providerCallIds.has(providerCallId)) {
        throw safeError("acp_production_qualification_call_replayed");
      }
      const expected = expectations[nextCall];
      try {
        assertJsonValue(call.arguments);
      } catch {
        throw safeError("acp_production_qualification_call_invalid");
      }
      if (!expected
        || call.name !== expected.name
        || canonicalJson(call.arguments) !== canonicalJson(expected.arguments)) {
        throw safeError("acp_production_qualification_call_invalid");
      }
      providerCallIds.add(providerCallId);
      nextCall += 1;
      const qualificationToken = qualificationTokens[nextCall - 1];
      if (!qualificationToken) {
        throw safeError("acp_production_qualification_token_missing");
      }
      return Object.freeze({
        providerCallId,
        result: Object.freeze({
          kind: "session_id_acp_qualification_simulated" as const,
          toolName: expected.name,
          qualificationToken,
        }),
      });
    },
  });
}

function qualificationPrompt(
  role: SessionIdAcpTaskRole,
  expectations: readonly QualificationExpectation[],
  expectedResultToken?: string,
): string {
  if (expectations.length === 0) {
    return `Qualification-only ${role} probe. Do not call any tool. Reply exactly QUALIFICATION_OK.`;
  }
  const first = expectations[0]!;
  return [
    `Call ${first.name} exactly once with ${canonicalJson(first.arguments)}.`,
    "Do not simulate or describe the call.",
    expectedResultToken
      ? `After it returns, reply exactly ${expectedResultToken}.`
      : "After it returns, reply exactly QUALIFICATION_OK.",
  ].join("\n");
}

function createConservativeAcpTaskReconciler(
  bindingHandle: string,
): AcpTaskPromptReconciler {
  return Object.freeze({
    async reconcile(input) {
      if (!input || input.bindingHandle !== bindingHandle || !ATTEMPT_ID.test(input.attemptId)
        || !Array.isArray(input.knownObservations)) {
        throw safeError("acp_production_reconciler_scope_mismatch");
      }
      const observations = Object.freeze(input.knownObservations.map((observation) => {
        const snapshot = snapshotAcpObservation(observation);
        if (snapshot.bindingHandle !== bindingHandle || snapshot.attemptId !== input.attemptId) {
          throw safeError("acp_production_reconciler_scope_mismatch");
        }
        return snapshot;
      }));
      return Object.freeze({
        state: "reconciling" as const,
        reason: "provider_outcome_unknown" as const,
        resendAllowed: false as const,
        observations,
      });
    },
  });
}

function validateFactoryContext(
  context: SessionIdAcpProductionTaskFactoryContext,
  providerFamily: "opencode" | "codex" | "claude-code",
): Readonly<{
  readonly binding: AcpSafeSessionBindingRecordV3;
  readonly frozenProfile: AcpV3FrozenProfileTuple;
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: SessionIdAcpTaskRole;
  readonly bindingDisposition: "create" | "load" | "resume";
}> {
  let binding: AcpSafeSessionBindingRecordV3;
  try {
    binding = validateAcpSafeSessionBindingRecordV3(context?.binding);
    assertJsonValue(context.profile);
    assertSessionExecutionSafeValue(context.profile);
  } catch {
    throw safeError("acp_production_policy_context_invalid");
  }
  const frozenProfile = validateFrozenProfile(context.frozenProfile);
  const role = requiredRole(context.role);
  if (context.bindingDisposition !== "create"
    && context.bindingDisposition !== "load"
    && context.bindingDisposition !== "resume") {
    throw safeError("acp_production_policy_context_invalid");
  }
  const expectedAgentKind = providerFamily === "opencode"
    ? "native_acp"
    : providerFamily === "codex"
      ? "codex_acp"
      : "claude_agent_acp";
  if (binding.providerFamily !== providerFamily
    || (binding.status !== "active" && binding.status !== "recovering")
    || binding.recoverable !== true
    || context.profile.providerFamily !== providerFamily
    || context.profile.acpAgentKind !== expectedAgentKind
    || context.profile.protocolMajor !== 1
    || binding.executionProfileId !== frozenProfile.executionProfileId
    || binding.profileRevisionId !== frozenProfile.profileRevisionId
    || binding.providerFamily !== frozenProfile.providerFamily
    || context.profile.executionProfileId !== frozenProfile.executionProfileId
    || context.profile.profileRevisionId !== frozenProfile.profileRevisionId) {
    throw safeError("acp_production_policy_context_invalid");
  }
  return Object.freeze({
    binding,
    frozenProfile,
    profile: context.profile,
    role,
    bindingDisposition: context.bindingDisposition,
  });
}

function validateCodexProfileRole(
  profile: ExecutionProfileDefinitionV3,
  roleValue: SessionIdAcpTaskRole,
): void {
  const role = requiredRole(roleValue);
  try {
    assertJsonValue(profile);
    assertSessionExecutionSafeValue(profile);
  } catch {
    throw safeError("acp_production_codex_probe_profile_invalid");
  }
  if (!profile
    || profile.providerFamily !== "codex"
    || profile.acpAgentKind !== "codex_acp"
    || profile.protocolMajor !== 1
    || !PROFILE_ID.test(profile.executionProfileId)
    || !PROFILE_REVISION_ID.test(profile.profileRevisionId)) {
    throw safeError("acp_production_codex_probe_profile_invalid");
  }
  const actual = profile.capabilityPolicy?.allowedTools;
  const expected = ROLE_TOOLS[role];
  if (!Array.isArray(actual)
    || actual.length !== expected.length
    || actual.some((tool, index) => tool !== expected[index])) {
    throw safeError("acp_production_codex_probe_role_policy_mismatch");
  }
}

function snapshotExecutionObservation(
  value: SessionIdAcpProductionExecutionObservation,
): SessionIdAcpProductionExecutionObservation {
  try {
    assertJsonValue(value);
    assertSessionExecutionSafeValue(value);
  } catch {
    throw safeError("acp_production_execution_observation_invalid");
  }
  if (!value || !hasExactKeys(value, OBSERVATION_KEYS)) {
    throw safeError("acp_production_execution_observation_invalid");
  }
  const role = requiredRole(value.role);
  const observation = snapshotAcpObservation(value.observation);
  return Object.freeze({
    bindingId: value.bindingId,
    bindingHandle: value.bindingHandle,
    logicalSessionId: value.logicalSessionId,
    executionProfileId: value.executionProfileId,
    profileRevisionId: value.profileRevisionId,
    providerFamily: value.providerFamily,
    role,
    observation,
  });
}

function resolveCurrentObservationFence(
  options: SessionIdAcpProductionPolicyOwnerOptions,
  value: SessionIdAcpProductionExecutionObservation,
): Readonly<{
  readonly binding: AcpSafeSessionBindingRecordV3;
  readonly runtime: SessionExecutionRuntimeRecord;
  readonly attempt: SessionExecutionAttemptRecord;
}> {
  try {
    const binding = validateAcpSafeSessionBindingRecordV3(
      requiredValue(options.bindings.getBinding(value.bindingId)),
    );
    const currentBinding = validateAcpSafeSessionBindingRecordV3(
      requiredValue(options.bindings.getCurrentBinding(value.logicalSessionId)),
    );
    if (!sameCurrentBinding(binding, currentBinding)
      || (binding.status !== "active" && binding.status !== "recovering")
      || binding.recoverable !== true
      || value.bindingId !== binding.bindingId
      || value.bindingHandle !== binding.bindingHandle
      || value.logicalSessionId !== binding.logicalSessionId
      || value.executionProfileId !== binding.executionProfileId
      || value.profileRevisionId !== binding.profileRevisionId
      || value.providerFamily !== binding.providerFamily
      || value.observation.bindingHandle !== binding.bindingHandle) {
      throw safeError("acp_production_execution_observation_fence_stale");
    }

    const frozenProfile = validateFrozenProfile(requiredValue(options.resolveFrozenProfile(Object.freeze({
      taskId: binding.taskId,
      runId: binding.runId,
      logicalSessionId: binding.logicalSessionId,
      executionProfileId: binding.executionProfileId,
    }))));
    if (frozenProfile.executionProfileId !== binding.executionProfileId
      || frozenProfile.profileRevisionId !== binding.profileRevisionId
      || frozenProfile.providerFamily !== binding.providerFamily) {
      throw safeError("acp_production_execution_observation_fence_stale");
    }

    const attempt = cloneSessionExecutionAttemptRecord(
      requiredValue(options.sessionRuntime.getAttempt(value.observation.attemptId)),
    );
    const runtimeById = cloneSessionExecutionRuntimeRecord(
      requiredValue(options.sessionRuntime.getRuntime(attempt.sessionExecutionRuntimeId)),
    );
    const currentRuntime = cloneSessionExecutionRuntimeRecord(
      requiredValue(options.sessionRuntime.getRuntimeForSession(binding.logicalSessionId)),
    );
    if (!sameCurrentRuntime(runtimeById, currentRuntime)
      || currentRuntime.state !== "executing"
      || currentRuntime.activeAttemptId !== attempt.sessionExecutionAttemptId
      || !isActiveAttemptState(attempt.state)
      || attempt.sessionExecutionAttemptId !== value.observation.attemptId
      || attempt.sessionExecutionRuntimeId !== currentRuntime.sessionExecutionRuntimeId
      || attempt.taskId !== binding.taskId
      || attempt.runId !== binding.runId
      || attempt.logicalSessionId !== binding.logicalSessionId
      || attempt.bindingId !== binding.bindingId
      || attempt.bindingRevision !== binding.revision
      || attempt.executionProfileId !== binding.executionProfileId
      || attempt.profileRevisionId !== binding.profileRevisionId) {
      throw safeError("acp_production_execution_observation_fence_stale");
    }
    return Object.freeze({ binding, runtime: currentRuntime, attempt });
  } catch {
    throw safeError("acp_production_execution_observation_fence_stale");
  }
}

function snapshotAcpObservation(value: AcpSessionObservation): AcpSessionObservation {
  try {
    assertJsonValue(value);
    assertSessionExecutionSafeValue(value);
    assertBindingHandle(value.bindingHandle);
  } catch {
    throw safeError("acp_production_execution_observation_invalid");
  }
  if (!ATTEMPT_ID.test(value.attemptId)) {
    throw safeError("acp_production_execution_observation_invalid");
  }
  const base = Object.freeze({
    bindingHandle: value.bindingHandle,
    attemptId: value.attemptId,
  });
  if (value.kind === "delivery_receipt") {
    return Object.freeze({
      ...base,
      kind: "delivery_receipt" as const,
      receiptDigest: requiredText(
        value.receiptDigest,
        512,
        false,
        "acp_production_execution_observation_invalid",
      ),
    });
  }
  if (value.kind === "agent_message_chunk" || value.kind === "agent_thought_chunk") {
    return Object.freeze({
      ...base,
      kind: value.kind,
      text: requiredText(
        value.text,
        65_536,
        true,
        "acp_production_execution_observation_invalid",
      ),
    });
  }
  if (value.kind === "tool_status") {
    if (!TOOL_HANDLE.test(value.toolCallHandle)
      || (value.status !== undefined
        && !["pending", "in_progress", "completed", "failed"].includes(value.status))) {
      throw safeError("acp_production_execution_observation_invalid");
    }
    const title = value.title === undefined
      ? undefined
      : requiredSingleLineText(
          value.title,
          512,
          "acp_production_execution_observation_invalid",
        );
    return Object.freeze({
      ...base,
      kind: "tool_status" as const,
      toolCallHandle: value.toolCallHandle,
      ...(title === undefined ? {} : { title }),
      ...(value.status === undefined ? {} : { status: value.status }),
    });
  }
  if (value.kind === "interaction_requested") {
    try {
      assertInteractionId(value.interactionId);
    } catch {
      throw safeError("acp_production_execution_observation_invalid");
    }
    if (!TOOL_HANDLE.test(value.toolCallHandle)
      || !Array.isArray(value.choices)
      || value.choices.length < 1
      || value.choices.length > 64) {
      throw safeError("acp_production_execution_observation_invalid");
    }
    const choiceIds = new Set<string>();
    const choices = Object.freeze(value.choices.map((choice) => {
      try {
        assertInteractionChoiceId(choice.choiceId);
      } catch {
        throw safeError("acp_production_execution_observation_invalid");
      }
      if (choiceIds.has(choice.choiceId)
        || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(choice.kind)) {
        throw safeError("acp_production_execution_observation_invalid");
      }
      choiceIds.add(choice.choiceId);
      return Object.freeze({
        choiceId: choice.choiceId,
        name: requiredSingleLineText(
          choice.name,
          160,
          "acp_production_execution_observation_invalid",
        ),
        kind: choice.kind,
      });
    }));
    return Object.freeze({
      ...base,
      kind: "interaction_requested" as const,
      interactionId: value.interactionId,
      toolCallHandle: value.toolCallHandle,
      promptDigest: requiredText(
        value.promptDigest,
        512,
        false,
        "acp_production_execution_observation_invalid",
      ),
      choices,
    });
  }
  if (value.kind === "final_candidate") {
    return Object.freeze({
      ...base,
      kind: "final_candidate" as const,
      text: requiredText(
        value.text,
        1_048_576,
        true,
        "acp_production_execution_observation_invalid",
      ),
    });
  }
  if (!["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]
    .includes(value.stopReason)) {
    throw safeError("acp_production_execution_observation_invalid");
  }
  return Object.freeze({
    ...base,
    kind: "prompt_terminal" as const,
    stopReason: value.stopReason,
    receiptDigest: requiredText(
      value.receiptDigest,
      512,
      false,
      "acp_production_execution_observation_invalid",
    ),
  });
}

function validateOwnerOptions(options: SessionIdAcpProductionPolicyOwnerOptions): void {
  if (!options
    || !hasExactKeys(options, [
      "bindings",
      "sessionRuntime",
      "resolveFrozenProfile",
      "sessionRuntimeOwner",
      "onHumanOnlyDiagnostic",
      "onRuntimeInvalidation",
    ])
    || !hasExactKeys(options.bindings, ["getBinding", "getCurrentBinding"])
    || !hasExactKeys(options.sessionRuntime, ["getRuntime", "getRuntimeForSession", "getAttempt"])
    || !hasExactKeys(options.sessionRuntimeOwner, [
      "handleInteractionRequested",
      "handleFinalCandidate",
    ])
    || typeof options.bindings.getBinding !== "function"
    || typeof options.bindings.getCurrentBinding !== "function"
    || typeof options.sessionRuntime.getRuntime !== "function"
    || typeof options.sessionRuntime.getRuntimeForSession !== "function"
    || typeof options.sessionRuntime.getAttempt !== "function"
    || typeof options.resolveFrozenProfile !== "function"
    || typeof options.sessionRuntimeOwner.handleInteractionRequested !== "function"
    || typeof options.sessionRuntimeOwner.handleFinalCandidate !== "function"
    || typeof options.onHumanOnlyDiagnostic !== "function"
    || typeof options.onRuntimeInvalidation !== "function") {
    throw safeError("acp_production_policy_owner_options_invalid");
  }
}

function nativeCandidateObservationId(
  providerFamily: AcpSafeSessionBindingRecordV3["providerFamily"],
  attemptId: string,
): string {
  if (providerFamily !== "opencode" && providerFamily !== "codex") {
    throw safeError("acp_production_final_candidate_provider_invalid");
  }
  const digest = createHash("sha256")
    .update(`agent-workspace:${providerFamily}-provider-fact\0`, "utf8")
    .update("candidate", "utf8")
    .update("\0", "utf8")
    .update(attemptId, "utf8")
    .digest("hex");
  return `provider_fact_${providerFamily}_candidate_${digest}`;
}

function validateFrozenProfile(value: AcpV3FrozenProfileTuple): AcpV3FrozenProfileTuple {
  if (!value
    || !hasExactKeys(value, [
      "schemaVersion",
      "executionProfileId",
      "profileRevisionId",
      "providerFamily",
    ])
    || value.schemaVersion !== 3
    || !PROFILE_ID.test(value.executionProfileId)
    || !PROFILE_REVISION_ID.test(value.profileRevisionId)
    || !["opencode", "codex", "claude-code"].includes(value.providerFamily)) {
    throw safeError("acp_production_policy_frozen_profile_invalid");
  }
  return Object.freeze({ ...value });
}

function sameCurrentBinding(
  left: AcpSafeSessionBindingRecordV3,
  right: AcpSafeSessionBindingRecordV3,
): boolean {
  return left.bindingId === right.bindingId
    && left.revision === right.revision
    && left.bindingHandle === right.bindingHandle
    && left.taskId === right.taskId
    && left.runId === right.runId
    && left.logicalSessionId === right.logicalSessionId
    && left.agentCardId === right.agentCardId
    && left.executionProfileId === right.executionProfileId
    && left.profileRevisionId === right.profileRevisionId
    && left.providerFamily === right.providerFamily
    && left.status === right.status
    && left.recoverable === right.recoverable;
}

function sameCurrentRuntime(
  left: SessionExecutionRuntimeRecord,
  right: SessionExecutionRuntimeRecord,
): boolean {
  return left.sessionExecutionRuntimeId === right.sessionExecutionRuntimeId
    && left.revision === right.revision
    && left.taskId === right.taskId
    && left.runId === right.runId
    && left.logicalSessionId === right.logicalSessionId
    && left.state === right.state
    && left.activeAttemptId === right.activeAttemptId;
}

function invalidationFor(
  binding: AcpSafeSessionBindingRecordV3,
): SessionIdAcpProductionRuntimeInvalidation {
  return Object.freeze({
    reason: "session_execution_changed" as const,
    taskId: binding.taskId,
    runId: binding.runId,
    logicalSessionId: binding.logicalSessionId,
  });
}

function requiredRole(value: unknown): SessionIdAcpTaskRole {
  if (value !== "conductor" && value !== "publisher" && value !== "worker" && value !== "reviewer") {
    throw safeError("acp_production_policy_role_invalid");
  }
  return value;
}

function isActiveAttemptState(value: SessionExecutionAttemptRecord["state"]): boolean {
  return ACTIVE_ATTEMPT_STATES.some((state) => state === value);
}

function requiredText(
  value: unknown,
  maximum: number,
  allowEmpty: boolean,
  code: string,
): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || value.includes("\0")) {
    throw safeError(code);
  }
  return value;
}

function requiredSingleLineText(value: unknown, maximum: number, code: string): string {
  const text = requiredText(value, maximum, false, code);
  if (/\r|\n/u.test(text)) throw safeError(code);
  return text;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function requiredValue<T>(value: T | undefined): T {
  if (value === undefined) throw safeError("acp_production_execution_observation_fence_stale");
  return value;
}

function safeError(code: string): Error {
  const error = new Error(code);
  error.name = "SessionIdAcpProductionPolicyError";
  return error;
}
