import {
  createConductorToolHost,
  type ConductorToolDispatchRequest,
  type ProviderConductorToolCall,
  type VerifiedConductorToolLease,
} from "@agent-workspace/conductor-tools";
import {
  assertJsonValue,
  canonicalJson,
  cloneAcpSafeSessionBindingRecordV3,
  isTaskArchitectureSnapshotV3,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type AgentCardDefinition,
  type ConductorOrchestrationToolResult,
  type ExecutionProfileDefinitionV3,
  type ProviderSessionBootstrap,
  type SessionExecutionAttemptRecord,
  type TaskArchitectureSnapshotV3,
  type WorkspaceAuthorizationRecord,
} from "@agent-workspace/runtime-contracts";
import { compileProviderSessionBootstrap } from "@agent-workspace/runtime-domain";
import type {
  ProviderScopedToolCall,
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import {
  resolveAuthorizedWorkspaceV3,
  sessionIdInitialConductorTurnId,
  type WorkspaceDirectoryResolver,
} from "@agent-workspace/runtime-application";
import type {
  AcpV3BindingRepository,
  AcpV3FrozenProfileTuple,
  AcpV3SessionRuntimeRepository,
  SessionIdMessageStore,
  SessionIdOrchestrationStore,
  SessionIdTaskRunStore,
  TemplateTaskStore,
  WorkspaceAuthorizationStore,
} from "@agent-workspace/runtime-store";
import type { AcpRuntimeHostPrivateAuthority } from "./acp-runtime-host-private-authority.js";
import type {
  SessionIdAcpApplicationReady,
  SessionIdAcpRunApplication,
} from "./session-id-acp-application-assembly.js";
import type {
  SessionIdAcpProductionCompositionOptions,
  SessionIdAcpTaskHostExecutionScope,
  SessionIdAcpTaskRole,
} from "./session-id-acp-production-composition.js";

const CONDUCTOR_TOOLS = Object.freeze([
  "invoke_agent",
  "send_to_session",
  "interrupt_session",
  "close_session",
] as const);
const ACTIVE_ATTEMPT_STATES = new Set<SessionExecutionAttemptRecord["state"]>([
  "awaiting_receipt",
  "active",
  // The common Provider marks the exact Attempt reconciling synchronously
  // before the first external prompt effect. That is a crash-safety fence, not
  // evidence that the current Host lost the live prompt or its scoped tools.
  "reconciling",
]);

type ProductionBindingInput = Parameters<
  SessionIdAcpProductionCompositionOptions["resolveTaskBindingContext"]
>[0];
export type SessionIdAcpResolvedTaskBindingContext = Awaited<ReturnType<
  SessionIdAcpProductionCompositionOptions["resolveTaskBindingContext"]
>>;

type RunApplicationCapability = Readonly<{
  commandApplication: Pick<SessionIdAcpRunApplication["commandApplication"],
    "invokeAgent" | "sendToSession" | "interruptSession">;
  closeSession: SessionIdAcpRunApplication["closeSession"];
  runtimePump: Pick<SessionIdAcpRunApplication["runtimePump"], "drainStagedEffect">;
}>;

export type SessionIdAcpTaskBindingContextRepositories = Readonly<{
  templateTask: Pick<TemplateTaskStore,
    "getTask" | "getRun" | "getArchitectureSnapshot">;
  workspaceAuthorization: Pick<WorkspaceAuthorizationStore, "getAuthorization">;
  taskRun: Pick<SessionIdTaskRunStore,
    "readTaskRunState" | "getConductorSessionId" | "getGeneration" | "getSlot">;
  message: Pick<SessionIdMessageStore, "listMessages">;
  orchestration: Pick<SessionIdOrchestrationStore,
    "getInputSubmission" | "getTurn">;
  binding: Pick<AcpV3BindingRepository,
    "getBinding" | "getCurrentBinding">;
  sessionRuntime: Pick<AcpV3SessionRuntimeRepository,
    "getRuntime" | "getRuntimeForSession" | "getAttempt" | "listAttempts">;
}>;

export type SessionIdAcpTaskBindingContextOwnerOptions = Readonly<{
  repositories: SessionIdAcpTaskBindingContextRepositories;
  workspaceDirectoryResolver: WorkspaceDirectoryResolver;
  acpApplication: Readonly<{
    createRunApplication(
      task: Parameters<SessionIdAcpApplicationReady["createRunApplication"]>[0],
    ): RunApplicationCapability;
  }>;
  privateAuthority: Pick<AcpRuntimeHostPrivateAuthority, "taskPrivateRootAuthority">;
  onRuntimeInvalidated: (reason: "provider_effect") => void;
  /** Host-process-only safe stage diagnostics; never persisted or bridged. */
  onDiagnostic?: (diagnostic: SessionIdAcpTaskBindingContextDiagnostic) => void;
}>;

export type SessionIdAcpTaskBindingContextDiagnostic = Readonly<{
  code: string;
  role: SessionIdAcpTaskRole;
  stage: "durable_binding" | "runtime" | "attempt" | "orchestration";
}>;

export type SessionIdAcpTaskBindingContextOwner = Readonly<{
  resolveTaskBindingContext(
    input: ProductionBindingInput,
  ): Promise<SessionIdAcpResolvedTaskBindingContext>;
  close(): void;
  toJSON(): Readonly<{ kind: "session_id_acp_task_binding_context_owner" }>;
}>;

type WorkspaceFence = Readonly<{
  authorization: WorkspaceAuthorizationRecord;
  authorizedWorkspaceDirectory: string;
  grantDigest: string;
}>;

type DurableBindingFence = Readonly<{
  architecture: TaskArchitectureSnapshotV3;
  binding: AcpSafeSessionBindingRecordV3;
  frozenProfile: AcpV3FrozenProfileTuple;
  profile: ExecutionProfileDefinitionV3;
  role: SessionIdAcpTaskRole;
  taskRevision: number;
  runApplicationScope: Parameters<SessionIdAcpApplicationReady["createRunApplication"]>[0];
}>;

type AttemptFence = Readonly<{
  attempt: SessionExecutionAttemptRecord;
  taskRevision: number;
}>;

type ConductorLeaseState = Readonly<{
  durable: DurableBindingFence;
  workspace: WorkspaceFence;
  attemptId: string;
  runApplication: RunApplicationCapability;
  taskRevision: number;
}>;

/**
 * Host-only resolver for the production ACP Task composition.
 *
 * It owns no durable rows and no Provider process. Every returned tool endpoint
 * is branded by an in-process WeakMap and re-reads the exact Task/Run, Binding,
 * SR Attempt and OR Turn/Input fence before an owner or filesystem effect.
 */
export function createSessionIdAcpTaskBindingContextOwner(
  options: SessionIdAcpTaskBindingContextOwnerOptions,
): SessionIdAcpTaskBindingContextOwner {
  validateOptions(options);
  const conductorLeases = new WeakMap<object, ConductorLeaseState>();
  let closed = false;

  const owner: SessionIdAcpTaskBindingContextOwner = Object.freeze({
    resolveTaskBindingContext,
    close() {
      closed = true;
    },
    toJSON() {
      return Object.freeze({ kind: "session_id_acp_task_binding_context_owner" as const });
    },
  });
  return owner;

  async function resolveTaskBindingContext(
    input: ProductionBindingInput,
  ): Promise<SessionIdAcpResolvedTaskBindingContext> {
    ensureOpen();
    const normalized = normalizeInput(input);
    const entry = resolveDurableBindingFence(normalized.binding, normalized.frozenProfile, false);
    const workspace = await resolveWorkspaceFence(entry.architecture);
    ensureOpen();
    assertSameDurableFence(entry, resolveDurableBindingFence(
      normalized.binding,
      normalized.frozenProfile,
      false,
    ));
    assertWorkspaceRecord(workspace, entry.architecture);
    const runApplication = options.acpApplication.createRunApplication(entry.runApplicationScope);
    assertRunApplication(runApplication);
    assertSameDurableFence(entry, resolveDurableBindingFence(
      normalized.binding,
      normalized.frozenProfile,
      false,
    ));
    assertWorkspaceRecord(workspace, entry.architecture);

    const hostScope = createHostScope(
      workspace.authorizedWorkspaceDirectory,
      options.privateAuthority.taskPrivateRootAuthority,
    );
    const promptBootstrap = immutablePromptBootstrap(compileProviderSessionBootstrap({
      architecture: entry.architecture,
      session: {
        kind: entry.role === "conductor" ? "conductor" : "card",
        agentCardId: entry.binding.agentCardId,
        executionProfileId: entry.binding.executionProfileId,
      },
    }));
    const result: SessionIdAcpResolvedTaskBindingContext = {
      profile: entry.profile,
      role: entry.role,
      hostScope,
      resolvePromptBootstrap(value) {
        const attemptId = exactAttemptInput(value);
        const attempt = resolveAttemptFence(entry, workspace, attemptId);
        const attempts = options.repositories.sessionRuntime.listAttempts(
          attempt.attempt.sessionExecutionRuntimeId,
        );
        if (!attempts.some((candidate) => candidate.sessionExecutionAttemptId === attemptId)
          || attempts.some((candidate) => candidate.sessionExecutionRuntimeId !== attempt.attempt.sessionExecutionRuntimeId
            || candidate.taskId !== entry.binding.taskId
            || candidate.runId !== entry.binding.runId
            || candidate.logicalSessionId !== entry.binding.logicalSessionId)) {
          rejectAttemptFence(entry.role, "attempt", "attempt_history_fence_mismatch");
        }
        return attempts.some((candidate) => candidate.receiptDigest !== undefined)
          ? undefined
          : promptBootstrap;
      },
      resolveTurnContext(value) {
        const attemptId = exactAttemptInput(value);
        const attempt = resolveAttemptFence(entry, workspace, attemptId);
        if (entry.role === "conductor") {
          return conductorTurnContext(entry, workspace, attempt, runApplication);
        }
        return undefined;
      },
    };
    return Object.freeze(result);
  }

  function conductorTurnContext(
    durable: DurableBindingFence,
    workspace: WorkspaceFence,
    attempt: AttemptFence,
    runApplication: RunApplicationCapability,
  ): ProviderScopedToolTurnContext {
    const lease = Object.freeze({});
    const state: ConductorLeaseState = Object.freeze({
      durable,
      workspace,
      attemptId: attempt.attempt.sessionExecutionAttemptId,
      runApplication,
      taskRevision: attempt.taskRevision,
    });
    conductorLeases.set(lease, state);
    const toolHost = createConductorToolHost({
      verifyLease(value) {
        return verifyConductorLease(value);
      },
      async dispatch(request) {
        verifyConductorLease(lease);
        return await dispatchConductorCommand(state, request);
      },
    });
    return Object.freeze({
      capabilityClass: "runtime_orchestration" as const,
      lease,
      handleCall(call: ProviderScopedToolCall) {
        return toolHost.handleProviderToolCall({
          providerCallId: call.providerCallId,
          name: conductorToolName(call.name),
          arguments: call.arguments,
          lease: call.lease,
        });
      },
    });
  }

  function verifyConductorLease(value: unknown): VerifiedConductorToolLease {
    ensureOpen();
    if (!value || typeof value !== "object") throw new Error("conductor_tool_lease_invalid");
    const state = conductorLeases.get(value);
    if (!state) throw new Error("conductor_tool_lease_invalid");
    const attempt = resolveAttemptFence(
      state.durable,
      state.workspace,
      state.attemptId,
    );
    if (attempt.taskRevision !== state.taskRevision) {
      throw new Error("conductor_tool_lease_stale");
    }
    return Object.freeze({
      role: "conductor" as const,
      taskId: state.durable.binding.taskId,
      runId: state.durable.binding.runId,
      conductorSessionId: state.durable.binding.logicalSessionId,
      conductorSessionTurnId: attempt.attempt.orchestrationSessionTurnId,
      taskRevision: state.taskRevision,
      bindingRevision: state.durable.binding.revision,
    });
  }

  async function dispatchConductorCommand(
    state: ConductorLeaseState,
    request: ConductorToolDispatchRequest,
  ): Promise<ConductorOrchestrationToolResult> {
    const base = Object.freeze({
      taskId: request.scope.taskId,
      runId: request.scope.runId,
      expectedRevision: request.scope.taskRevision,
      conductorSessionId: request.scope.conductorSessionId,
      conductorSessionTurnId: request.scope.conductorSessionTurnId,
      commandId: request.commandId,
      idempotencyKey: request.idempotencyKey,
    });
    if (request.name === "close_session") {
      const result = await state.runApplication.closeSession({
        ...base,
        sessionId: request.arguments.sessionId,
      });
      options.onRuntimeInvalidated("provider_effect");
      return result;
    }
    let commit;
    switch (request.name) {
      case "invoke_agent":
        commit = state.runApplication.commandApplication.invokeAgent({
          ...base,
          agentCardId: request.arguments.agentCardId,
        });
        break;
      case "send_to_session":
        commit = state.runApplication.commandApplication.sendToSession({
          ...base,
          sessionId: request.arguments.sessionId,
          payload: request.arguments.payload,
        });
        break;
      case "interrupt_session":
        commit = state.runApplication.commandApplication.interruptSession({
          ...base,
          sessionId: request.arguments.sessionId,
        });
        break;
    }
    options.onRuntimeInvalidated("provider_effect");
    for (const providerEffectIntentId of commit.providerEffectIntentIds) {
      await state.runApplication.runtimePump.drainStagedEffect({ providerEffectIntentId });
    }
    return commit.result;
  }

  function resolveAttemptFence(
    durable: DurableBindingFence,
    workspace: WorkspaceFence,
    attemptId: string,
  ): AttemptFence {
    ensureOpen();
    let current: DurableBindingFence;
    try {
      current = resolveDurableBindingFence(
        durable.binding,
        durable.frozenProfile,
        true,
      );
      assertSameDurableFence(durable, current, durable.role);
      assertWorkspaceRecord(workspace, current.architecture, durable.role);
    } catch (error) {
      rejectAttemptFence(durable.role, "durable_binding", diagnosticCode(error));
    }
    const runtime = options.repositories.sessionRuntime.getRuntimeForSession(
      durable.binding.logicalSessionId,
    );
    if (!runtime
      || runtime.taskId !== durable.binding.taskId
      || runtime.runId !== durable.binding.runId
      || runtime.logicalSessionId !== durable.binding.logicalSessionId
      || (runtime.state !== "executing" && runtime.state !== "reconciling")
      || runtime.activeAttemptId !== attemptId) {
      rejectAttemptFence(durable.role, "runtime", "runtime_fence_mismatch");
    }
    const runtimeById = options.repositories.sessionRuntime.getRuntime(
      runtime.sessionExecutionRuntimeId,
    );
    if (!runtimeById || !sameJson(runtime, runtimeById)) {
      rejectAttemptFence(durable.role, "runtime", "runtime_identity_mismatch");
    }
    const attempt = options.repositories.sessionRuntime.getAttempt(attemptId);
    if (!attempt
      || attempt.sessionExecutionRuntimeId !== runtime.sessionExecutionRuntimeId
      || attempt.taskId !== durable.binding.taskId
      || attempt.runId !== durable.binding.runId
      || attempt.logicalSessionId !== durable.binding.logicalSessionId
      || attempt.bindingId !== durable.binding.bindingId
      || attempt.bindingRevision !== durable.binding.revision
      || attempt.executionProfileId !== durable.profile.executionProfileId
      || attempt.profileRevisionId !== durable.profile.profileRevisionId
      || !ACTIVE_ATTEMPT_STATES.has(attempt.state)
      || (attempt.state === "reconciling" && runtime.state !== "reconciling")
      || (runtime.state === "reconciling" && attempt.state !== "reconciling")
      || attempt.finalCandidate !== undefined
      || attempt.terminal !== undefined
      || attempt.settlement !== undefined) {
      rejectAttemptFence(durable.role, "attempt", "attempt_fence_mismatch");
    }
    const input = options.repositories.orchestration.getInputSubmission(attempt.inputSubmissionId);
    const turn = options.repositories.orchestration.getTurn(attempt.orchestrationSessionTurnId);
    const pending = input?.state === "pending" && turn?.state === "pending";
    const accepted = input?.state === "accepted" && turn?.state === "active";
    if (!input || !turn || (!pending && !accepted)
      || input.taskId !== attempt.taskId
      || input.runId !== attempt.runId
      || input.sessionId !== attempt.logicalSessionId
      || turn.taskId !== attempt.taskId
      || turn.runId !== attempt.runId
      || turn.sessionId !== attempt.logicalSessionId
      || turn.inputSubmissionId !== attempt.inputSubmissionId) {
      rejectAttemptFence(durable.role, "orchestration", "orchestration_fence_mismatch");
    }
    return Object.freeze({ attempt, taskRevision: current.taskRevision });
  }

  function rejectAttemptFence(
    role: SessionIdAcpTaskRole,
    stage: SessionIdAcpTaskBindingContextDiagnostic["stage"],
    code: string,
  ): never {
    try {
      options.onDiagnostic?.(Object.freeze({ code, role, stage }));
    } catch {
      // Diagnostics must never change the owner decision or expose a new failure path.
    }
    throw staleToolLease(role);
  }

  function resolveDurableBindingFence(
    suppliedBinding: AcpSafeSessionBindingRecordV3,
    suppliedFrozenProfile: AcpV3FrozenProfileTuple,
    requireRunning: boolean,
  ): DurableBindingFence {
    const binding = cloneAcpSafeSessionBindingRecordV3(suppliedBinding);
    const frozenProfile = normalizeFrozenProfile(suppliedFrozenProfile);
    const task = options.repositories.templateTask.getTask(binding.taskId);
    const run = options.repositories.templateTask.getRun(binding.runId);
    const snapshot = options.repositories.templateTask.getArchitectureSnapshot(binding.taskId);
    if (!task || !run || !snapshot || !isTaskArchitectureSnapshotV3(snapshot)) {
      throw new Error("session_id_acp_task_context_v3_scope_required");
    }
    const architecture = validateTaskArchitectureSnapshotV3(snapshot);
    let runState;
    try {
      runState = options.repositories.taskRun.readTaskRunState(binding.taskId, binding.runId);
    } catch {
      throw new Error("session_id_acp_task_context_run_not_current");
    }
    const accepting = requireRunning
      ? run.status === "running" && runState.runStatus === "running"
      : (run.status === "starting" || run.status === "running")
        && (runState.runStatus === "starting" || runState.runStatus === "running");
    if (task.taskId !== binding.taskId
      || task.architectureSnapshotId !== architecture.architectureSnapshotId
      || task.activeRunId !== binding.runId
      || task.status !== "running"
      || run.taskId !== binding.taskId
      || run.runId !== binding.runId
      || run.conductorLogicalSessionId !== options.repositories.taskRun.getConductorSessionId(
        binding.taskId,
        binding.runId,
      )
      || runState.taskId !== binding.taskId
      || runState.runId !== binding.runId
      || runState.taskRevision !== task.revision
      || !accepting) {
      throw new Error("session_id_acp_task_context_run_not_current");
    }
    const card = resolveBoundCard(architecture, run.conductorLogicalSessionId, binding);
    const role = roleForCard(card);
    const profileSource = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === card.executionProfileId);
    if (!profileSource) throw new Error("session_id_acp_task_context_profile_missing");
    const profile = immutableProfile(profileSource);
    assertRolePolicy(card, profile, role);
    if (binding.status !== "active" && binding.status !== "recovering") {
      throw new Error("session_id_acp_task_context_binding_not_current");
    }
    if (!binding.recoverable
      || binding.agentCardId !== card.agentCardId
      || binding.executionProfileId !== profile.executionProfileId
      || binding.profileRevisionId !== profile.profileRevisionId
      || binding.providerFamily !== profile.providerFamily
      || frozenProfile.schemaVersion !== 3
      || frozenProfile.executionProfileId !== profile.executionProfileId
      || frozenProfile.profileRevisionId !== profile.profileRevisionId
      || frozenProfile.providerFamily !== profile.providerFamily) {
      throw new Error("session_id_acp_task_context_profile_fence_mismatch");
    }
    const byId = options.repositories.binding.getBinding(binding.bindingId);
    const current = options.repositories.binding.getCurrentBinding(binding.logicalSessionId);
    if (!byId || !current || !sameJson(binding, byId) || !sameJson(binding, current)) {
      throw new Error("session_id_acp_task_context_binding_not_current");
    }
    const runtime = options.repositories.sessionRuntime.getRuntimeForSession(binding.logicalSessionId);
    const runtimeById = runtime
      ? options.repositories.sessionRuntime.getRuntime(runtime.sessionExecutionRuntimeId)
      : undefined;
    if (!runtime
      || !runtimeById
      || runtime.taskId !== binding.taskId
      || runtime.runId !== binding.runId
      || runtime.logicalSessionId !== binding.logicalSessionId
      || !sameJson(runtime, runtimeById)) {
      throw new Error("session_id_acp_task_context_runtime_mismatch");
    }
    const taskGoals = options.repositories.message.listMessages(binding.runId)
      .filter((message) => message.kind === "task_goal");
    if (taskGoals.length !== 1
      || taskGoals[0]!.taskId !== binding.taskId
      || taskGoals[0]!.runId !== binding.runId
      || taskGoals[0]!.content !== architecture.taskGoalContent
      || taskGoals[0]!.contentDigest !== architecture.taskGoalContentDigest) {
      throw new Error("session_id_acp_task_context_goal_scope_mismatch");
    }
    const agentCards = architecture.definition.agentCards.map((candidate) => {
      const candidateProfile = architecture.definition.executionProfiles.find((entry) =>
        entry.executionProfileId === candidate.executionProfileId);
      if (!candidateProfile) throw new Error("session_id_acp_task_context_profile_missing");
      return Object.freeze({
        agentCardId: candidate.agentCardId,
        executionProfileId: candidateProfile.executionProfileId,
        profileRevisionId: candidateProfile.profileRevisionId,
        providerFamily: candidateProfile.providerFamily,
      });
    });
    return Object.freeze({
      architecture,
      binding,
      frozenProfile,
      profile,
      role,
      taskRevision: task.revision,
      runApplicationScope: Object.freeze({
        taskId: task.taskId,
        runId: run.runId,
        conductorSessionId: run.conductorLogicalSessionId,
        initialConductorSessionTurnId: sessionIdInitialConductorTurnId(
          run.runId,
          taskGoals[0]!.messageId,
        ),
        agentCards: Object.freeze(agentCards),
      }),
    });
  }

  function resolveBoundCard(
    architecture: TaskArchitectureSnapshotV3,
    conductorSessionId: string,
    binding: AcpSafeSessionBindingRecordV3,
  ): AgentCardDefinition {
    if (binding.logicalSessionId === conductorSessionId) {
      if (binding.agentCardId !== architecture.definition.conductor.agentCardId) {
        throw new Error("session_id_acp_task_context_conductor_scope_mismatch");
      }
      return architecture.definition.conductor;
    }
    const generation = options.repositories.taskRun.getGeneration(binding.logicalSessionId);
    if (!generation
      || generation.sessionId !== binding.logicalSessionId
      || generation.taskId !== binding.taskId
      || generation.runId !== binding.runId
      || generation.agentCardId !== binding.agentCardId
      || generation.executionProfileId !== binding.executionProfileId
      || generation.lifecycle !== "current"
      || generation.closedAt !== undefined) {
      throw new Error("session_id_acp_task_context_generation_not_current");
    }
    const slot = options.repositories.taskRun.getSlot(generation.cardSessionSlotId);
    if (!slot
      || slot.taskId !== binding.taskId
      || slot.runId !== binding.runId
      || slot.agentCardId !== binding.agentCardId
      || slot.currentSessionId !== binding.logicalSessionId
      || slot.latestGeneration !== generation.generation) {
      throw new Error("session_id_acp_task_context_slot_not_current");
    }
    const card = architecture.definition.agentCards.find((candidate) =>
      candidate.agentCardId === binding.agentCardId);
    if (!card || card.kind === "conductor") {
      throw new Error("session_id_acp_task_context_card_scope_mismatch");
    }
    return card;
  }

  async function resolveWorkspaceFence(
    architecture: TaskArchitectureSnapshotV3,
  ): Promise<WorkspaceFence> {
    const authorization = options.repositories.workspaceAuthorization.getAuthorization(
      architecture.workspace.workspaceId,
    );
    if (!authorization) throw new Error("session_id_acp_task_context_workspace_unauthorized");
    let reference;
    try {
      reference = await resolveAuthorizedWorkspaceV3(
        options.workspaceDirectoryResolver,
        authorization,
      );
    } catch {
      throw new Error("session_id_acp_task_context_workspace_grant_drift");
    }
    if (reference.workspaceId !== architecture.workspace.workspaceId
      || reference.grantDigest !== architecture.workspace.grantDigest) {
      throw new Error("session_id_acp_task_context_workspace_grant_drift");
    }
    return Object.freeze({
      authorization: Object.freeze({ ...authorization }),
      authorizedWorkspaceDirectory: authorization.canonicalDirectory,
      grantDigest: reference.grantDigest,
    });
  }

  function assertWorkspaceRecord(
    workspace: WorkspaceFence,
    architecture: TaskArchitectureSnapshotV3,
    role?: SessionIdAcpTaskRole,
  ): void {
    const current = options.repositories.workspaceAuthorization.getAuthorization(
      architecture.workspace.workspaceId,
    );
    if (!current
      || !sameJson(current, workspace.authorization)
      || current.canonicalDirectory !== workspace.authorizedWorkspaceDirectory) {
      throw staleToolLeaseForRole(role);
    }
    const digest = options.workspaceDirectoryResolver.digestGrant(Object.freeze({
      schemaVersion: 1 as const,
      workspaceId: current.workspaceId,
      canonicalDirectory: current.canonicalDirectory,
      authorizedAt: current.authorizedAt,
    }));
    if (digest !== workspace.grantDigest || digest !== architecture.workspace.grantDigest) {
      throw staleToolLeaseForRole(role);
    }
  }

  function ensureOpen(): void {
    if (closed) throw new Error("session_id_acp_task_context_owner_closed");
  }
}

function normalizeInput(input: ProductionBindingInput): Readonly<{
  binding: AcpSafeSessionBindingRecordV3;
  frozenProfile: AcpV3FrozenProfileTuple;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !sameKeys(input, ["binding", "frozenProfile"])) {
    throw new Error("session_id_acp_task_context_input_invalid");
  }
  return Object.freeze({
    binding: cloneAcpSafeSessionBindingRecordV3(input.binding),
    frozenProfile: normalizeFrozenProfile(input.frozenProfile),
  });
}

function normalizeFrozenProfile(value: AcpV3FrozenProfileTuple): AcpV3FrozenProfileTuple {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value, ["schemaVersion", "executionProfileId", "profileRevisionId", "providerFamily"])
    || value.schemaVersion !== 3
    || typeof value.executionProfileId !== "string"
    || typeof value.profileRevisionId !== "string"
    || !["opencode", "codex", "claude-code"].includes(value.providerFamily)) {
    throw new Error("session_id_acp_task_context_frozen_profile_invalid");
  }
  return Object.freeze({ ...value });
}

function roleForCard(card: AgentCardDefinition): SessionIdAcpTaskRole {
  if (card.kind === "conductor") return "conductor";
  if (card.kind === "publisher") return "publisher";
  if (card.kind === "reviewer") return "reviewer";
  return "worker";
}

function assertRolePolicy(
  card: AgentCardDefinition,
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
): void {
  const expected = role === "conductor"
    ? CONDUCTOR_TOOLS
    : [];
  if (!sameSet(profile.capabilityPolicy.allowedTools, expected)) {
    throw new Error("session_id_acp_task_context_role_policy_mismatch");
  }
}

function immutableProfile(value: ExecutionProfileDefinitionV3): ExecutionProfileDefinitionV3 {
  return deepFreeze({
    executionProfileId: value.executionProfileId,
    profileRevisionId: value.profileRevisionId,
    providerFamily: value.providerFamily,
    acpAgentKind: value.acpAgentKind,
    protocolMajor: value.protocolMajor,
    model: value.model,
    configIntent: structuredClone(value.configIntent),
    requiredExtensions: [...value.requiredExtensions],
    capabilityPolicy: {
      requiredCapabilities: [...value.capabilityPolicy.requiredCapabilities],
      allowedTools: [...value.capabilityPolicy.allowedTools],
      permissionMode: value.capabilityPolicy.permissionMode,
      maxConcurrentTurns: value.capabilityPolicy.maxConcurrentTurns,
      maxNativeChildren: value.capabilityPolicy.maxNativeChildren,
    },
  });
}

function createHostScope(
  authorizedWorkspaceDirectory: string,
  privateRootAuthority: AcpRuntimeHostPrivateAuthority["taskPrivateRootAuthority"],
): SessionIdAcpTaskHostExecutionScope {
  const scope: SessionIdAcpTaskHostExecutionScope = {
    authorizedWorkspaceDirectory,
    privateRootAuthority,
  };
  Object.defineProperty(scope, "toJSON", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: () => Object.freeze({ kind: "session_id_acp_task_host_execution_scope" as const }),
  });
  return Object.freeze(scope);
}

function exactAttemptInput(value: Readonly<{ sessionExecutionAttemptId: string }>): string {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value, ["sessionExecutionAttemptId"])
    || typeof value.sessionExecutionAttemptId !== "string"
    || !/^session_execution_attempt_[A-Za-z0-9_-]+$/u.test(value.sessionExecutionAttemptId)) {
    throw new Error("session_id_acp_task_context_attempt_input_invalid");
  }
  return value.sessionExecutionAttemptId;
}

function conductorToolName(value: string): ProviderConductorToolCall["name"] {
  switch (value) {
    case "invoke_agent": return "invoke_agent";
    case "send_to_session": return "send_to_session";
    case "interrupt_session": return "interrupt_session";
    case "close_session": return "close_session";
    default: throw new Error("orchestration_tool_name_invalid");
  }
}

function assertSameDurableFence(
  expected: DurableBindingFence,
  actual: DurableBindingFence,
  staleRole?: SessionIdAcpTaskRole,
): void {
  if (expected.role !== actual.role
    || expected.taskRevision !== actual.taskRevision
    || !sameJson(expected.binding, actual.binding)
    || !sameJson(expected.frozenProfile, actual.frozenProfile)
    || !sameJson(expected.profile, actual.profile)
    || !sameJson(expected.runApplicationScope, actual.runApplicationScope)) {
    throw staleRole
      ? staleToolLease(staleRole)
      : new Error("session_id_acp_task_context_durable_fence_drift");
  }
}

function assertRunApplication(value: RunApplicationCapability): void {
  if (!value || typeof value !== "object"
    || typeof value.commandApplication?.invokeAgent !== "function"
    || typeof value.commandApplication?.sendToSession !== "function"
    || typeof value.commandApplication?.interruptSession !== "function"
    || typeof value.closeSession !== "function"
    || typeof value.runtimePump?.drainStagedEffect !== "function") {
    throw new Error("session_id_acp_task_context_run_application_invalid");
  }
}

function staleToolLease(role: SessionIdAcpTaskRole): Error {
  return role === "conductor"
    ? new Error("conductor_tool_lease_stale")
    : new Error("session_id_acp_task_context_tool_lease_stale");
}

function staleToolLeaseForRole(role: SessionIdAcpTaskRole | undefined): Error {
  return role ? staleToolLease(role) : new Error("session_id_acp_task_context_workspace_grant_drift");
}

function validateOptions(value: SessionIdAcpTaskBindingContextOwnerOptions): void {
  if (!value || typeof value !== "object"
    || typeof value.repositories?.templateTask?.getTask !== "function"
    || typeof value.repositories.templateTask.getRun !== "function"
    || typeof value.repositories.templateTask.getArchitectureSnapshot !== "function"
    || typeof value.repositories.workspaceAuthorization?.getAuthorization !== "function"
    || typeof value.repositories.taskRun?.readTaskRunState !== "function"
    || typeof value.repositories.taskRun.getConductorSessionId !== "function"
    || typeof value.repositories.taskRun.getGeneration !== "function"
    || typeof value.repositories.taskRun.getSlot !== "function"
    || typeof value.repositories.message?.listMessages !== "function"
    || typeof value.repositories.orchestration?.getInputSubmission !== "function"
    || typeof value.repositories.orchestration.getTurn !== "function"
    || typeof value.repositories.binding?.getBinding !== "function"
    || typeof value.repositories.binding.getCurrentBinding !== "function"
    || typeof value.repositories.sessionRuntime?.getRuntime !== "function"
    || typeof value.repositories.sessionRuntime.getRuntimeForSession !== "function"
    || typeof value.repositories.sessionRuntime.getAttempt !== "function"
    || typeof value.repositories.sessionRuntime.listAttempts !== "function"
    || typeof value.workspaceDirectoryResolver?.canonicalizeDirectory !== "function"
    || typeof value.workspaceDirectoryResolver.digestGrant !== "function"
    || typeof value.acpApplication?.createRunApplication !== "function"
    || !value.privateAuthority?.taskPrivateRootAuthority
    || typeof value.privateAuthority.taskPrivateRootAuthority.toJSON !== "function"
    || typeof value.onRuntimeInvalidated !== "function"
    || (value.onDiagnostic !== undefined && typeof value.onDiagnostic !== "function")) {
    throw new Error("session_id_acp_task_context_options_invalid");
  }
}

function diagnosticCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "durable_binding_fence_failed";
  return /^[a-z][a-z0-9_]{2,127}$/u.test(code)
    ? code
    : "durable_binding_fence_failed";
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function sameKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function sameJson(left: unknown, right: unknown): boolean {
  assertJsonValue(left);
  assertJsonValue(right);
  return canonicalJson(left) === canonicalJson(right);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function immutablePromptBootstrap(value: ProviderSessionBootstrap): ProviderSessionBootstrap {
  return deepFreeze(structuredClone(value));
}
