import {
  assertSessionExecutionSafeValue,
  canonicalJson,
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionRuntimeRecord,
  hashDefinition,
  isTaskArchitectureSnapshotV3,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type AgentCardDefinition,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ExecutionProfileDefinitionV3,
  type JsonValue,
  type ProviderFamily,
  type SessionExecutionRuntimeRecord,
  type TaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpV3BindingRepository,
  AcpV3SessionRuntimeRepository,
  SessionIdTaskRunStore,
  TemplateTaskStore,
} from "@agent-workspace/runtime-store";

export type SessionIdAcpCardBindingIdKind =
  | "binding"
  | "binding_handle"
  | "session_execution_runtime";

export type SessionIdAcpCardBindingOwnerCapabilities = Readonly<{
  taskRun: Pick<SessionIdTaskRunStore, "getGeneration" | "getSlot" | "readTaskRunState">;
  architecture: Pick<TemplateTaskStore, "getArchitectureSnapshot">;
  binding: Pick<AcpV3BindingRepository,
    "createBinding" | "getBinding" | "getCurrentBinding" | "listBindings">;
  sessionRuntime: Pick<AcpV3SessionRuntimeRepository,
    "createRuntime" | "getRuntime" | "getRuntimeForSession">;
}>;

/** The composition root must bind every capability to one application/SQLite transaction. */
export interface SessionIdAcpCardBindingApplicationTransaction {
  run<T>(work: (owners: SessionIdAcpCardBindingOwnerCapabilities) => T): T;
}

export type SessionIdAcpCardBindingEnsureResult = Readonly<{
  disposition: "created" | "replay";
  taskId: string;
  runId: string;
  logicalSessionId: string;
  agentCardId: string;
  executionProfileId: string;
  profileRevisionId: string;
  providerFamily: ProviderFamily;
  bindingId: string;
  bindingHandle: string;
  sessionExecutionRuntimeId: string;
}>;

export type SessionIdAcpCardBindingOwnerOptions = Readonly<{
  now: () => string;
  createId: (kind: SessionIdAcpCardBindingIdKind) => string;
  transaction: SessionIdAcpCardBindingApplicationTransaction;
}>;

type CardBindingContext = Readonly<{
  architecture: TaskArchitectureSnapshotV3;
  run: Readonly<{
    taskId: string;
    runId: string;
    taskRevision: number;
    runStatus: string;
    currentConductorSessionTurnId?: string;
  }>;
  slot: CardSessionSlotRecord;
  generation: CardSessionGenerationRecord;
  card: AgentCardDefinition;
  profile: ExecutionProfileDefinitionV3;
}>;

/**
 * Materializes only the ACP-safe Binding association and stable SR required by
 * a first Card delivery. The caller supplies only the current LogicalSession
 * identity; Task/Run, Card and frozen Profile authority are owner reads.
 */
export function createSessionIdAcpCardBindingOwner(
  options: SessionIdAcpCardBindingOwnerOptions,
) {
  validateOptions(options);
  return Object.freeze({ ensureCurrentCardBinding });

  function ensureCurrentCardBinding(value: Readonly<{
    logicalSessionId: string;
  }>): SessionIdAcpCardBindingEnsureResult {
    const logicalSessionId = validateInput(value);
    return options.transaction.run((owners) => {
      const context = resolveContext(owners, logicalSessionId);
      const entryFence = contextFence(context);
      const current = owners.binding.getCurrentBinding(logicalSessionId);
      const bindings = owners.binding.listBindings(logicalSessionId)
        .map((binding) => cloneAcpSafeSessionBindingRecordV3(binding));
      const sessionRuntime = owners.sessionRuntime.getRuntimeForSession(logicalSessionId);

      if (current) {
        if (!sessionRuntime) throw new Error("session_id_acp_card_binding_runtime_partial");
        const binding = requireExistingBinding(context, current, bindings, owners);
        const runtime = requireExistingRuntime(context, sessionRuntime, owners);
        assertContextFence(owners, logicalSessionId, entryFence);
        assertPersistedPair(owners, context, binding, runtime);
        return projectResult("replay", context, binding, runtime);
      }
      if (bindings.length > 0) {
        if (bindings.some((binding) => binding.status === "active" || binding.status === "recovering")) {
          throw new Error("session_id_acp_card_binding_history_without_current");
        }
        throw new Error("session_id_acp_card_binding_history_conflict");
      }
      if (sessionRuntime) throw new Error("session_id_acp_card_binding_runtime_partial");

      const bindingId = createdId(options.createId("binding"), /^binding_[A-Za-z0-9_-]+$/u,
        "session_id_acp_card_binding_id_invalid");
      const bindingHandle = createdId(options.createId("binding_handle"), /^binding_handle_[A-Za-z0-9_-]+$/u,
        "session_id_acp_card_binding_handle_invalid");
      const sessionExecutionRuntimeId = createdId(
        options.createId("session_execution_runtime"),
        /^session_execution_runtime_[A-Za-z0-9_-]+$/u,
        "session_id_acp_card_runtime_id_invalid",
      );
      if (owners.binding.getBinding(bindingId) || owners.sessionRuntime.getRuntime(sessionExecutionRuntimeId)) {
        throw new Error("session_id_acp_card_generated_id_conflict");
      }
      const createdAt = isoTimestamp(options.now(), "session_id_acp_card_binding_time_invalid");
      assertContextFence(owners, logicalSessionId, entryFence);
      assertStillUnbound(owners, logicalSessionId, bindingId, sessionExecutionRuntimeId);

      const binding = cloneAcpSafeSessionBindingRecordV3({
        schemaVersion: 3,
        bindingId,
        taskId: context.generation.taskId,
        runId: context.generation.runId,
        logicalSessionId,
        agentCardId: context.card.agentCardId,
        executionProfileId: context.profile.executionProfileId,
        profileRevisionId: context.profile.profileRevisionId,
        providerFamily: context.profile.providerFamily,
        bindingHandle,
        status: "active",
        recoverable: true,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      });
      const runtime = cloneSessionExecutionRuntimeRecord({
        sessionExecutionRuntimeId,
        taskId: context.generation.taskId,
        runId: context.generation.runId,
        logicalSessionId,
        state: "idle",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      });
      owners.binding.createBinding(binding, { makeCurrent: true });
      owners.sessionRuntime.createRuntime(runtime);
      assertContextFence(owners, logicalSessionId, entryFence);
      assertPersistedPair(owners, context, binding, runtime);
      return projectResult("created", context, binding, runtime);
    });
  }
}

function resolveContext(
  owners: SessionIdAcpCardBindingOwnerCapabilities,
  logicalSessionId: string,
): CardBindingContext {
  const generation = owners.taskRun.getGeneration(logicalSessionId);
  if (!generation || generation.sessionId !== logicalSessionId) {
    throw new Error("session_id_acp_card_generation_not_found");
  }
  if (generation.lifecycle !== "current" || generation.closedAt !== undefined) {
    throw new Error("session_id_acp_card_generation_not_current");
  }
  if (!Number.isSafeInteger(generation.generation) || generation.generation < 1) {
    throw new Error("session_id_acp_card_generation_invalid");
  }
  const slot = owners.taskRun.getSlot(generation.cardSessionSlotId);
  if (!slot
    || slot.cardSessionSlotId !== generation.cardSessionSlotId
    || slot.taskId !== generation.taskId
    || slot.runId !== generation.runId
    || slot.agentCardId !== generation.agentCardId
    || slot.currentSessionId !== logicalSessionId
    || slot.latestGeneration !== generation.generation) {
    throw new Error("session_id_acp_card_slot_not_current");
  }
  const architectureRead = owners.architecture.getArchitectureSnapshot(generation.taskId);
  if (!architectureRead || !isTaskArchitectureSnapshotV3(architectureRead)) {
    throw new Error("session_id_acp_card_architecture_v3_required");
  }
  const architecture = validateTaskArchitectureSnapshotV3(architectureRead);
  if (architecture.taskId !== generation.taskId) {
    throw new Error("session_id_acp_card_architecture_scope_mismatch");
  }
  let run: CardBindingContext["run"];
  try {
    run = owners.taskRun.readTaskRunState(generation.taskId, generation.runId);
  } catch {
    throw new Error("session_id_acp_card_run_scope_mismatch");
  }
  if (run.runId !== generation.runId || run.taskId !== generation.taskId) {
    throw new Error("session_id_acp_card_run_scope_mismatch");
  }
  if (run.runStatus !== "running") throw new Error("session_id_acp_card_run_not_active");
  const card = architecture.definition.agentCards.find((candidate) =>
    candidate.agentCardId === generation.agentCardId);
  if (!card || card.kind === "conductor" || card.executionProfileId !== generation.executionProfileId) {
    throw new Error("session_id_acp_card_profile_scope_mismatch");
  }
  const profile = architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === card.executionProfileId);
  if (!profile) throw new Error("session_id_acp_card_profile_scope_mismatch");
  return Object.freeze({ architecture, run, slot, generation, card, profile });
}

function requireExistingBinding(
  context: CardBindingContext,
  value: AcpSafeSessionBindingRecordV3,
  bindings: readonly AcpSafeSessionBindingRecordV3[],
  owners: SessionIdAcpCardBindingOwnerCapabilities,
): AcpSafeSessionBindingRecordV3 {
  const binding = cloneAcpSafeSessionBindingRecordV3(value);
  const byId = owners.binding.getBinding(binding.bindingId);
  if (!byId || !sameValue(binding, cloneAcpSafeSessionBindingRecordV3(byId))) {
    throw new Error("session_id_acp_card_binding_lookup_mismatch");
  }
  if (bindings.length !== 1 || !sameValue(bindings[0], binding)) {
    throw new Error("session_id_acp_card_binding_lineage_ambiguous");
  }
  if (binding.status !== "active" || binding.recoverable !== true) {
    throw new Error("session_id_acp_card_binding_not_active");
  }
  if (binding.taskId !== context.generation.taskId
    || binding.runId !== context.generation.runId
    || binding.logicalSessionId !== context.generation.sessionId
    || binding.agentCardId !== context.card.agentCardId
    || binding.executionProfileId !== context.profile.executionProfileId
    || binding.profileRevisionId !== context.profile.profileRevisionId
    || binding.providerFamily !== context.profile.providerFamily) {
    throw new Error("session_id_acp_card_existing_binding_scope_mismatch");
  }
  return binding;
}

function requireExistingRuntime(
  context: CardBindingContext,
  value: SessionExecutionRuntimeRecord,
  owners: SessionIdAcpCardBindingOwnerCapabilities,
): SessionExecutionRuntimeRecord {
  const runtime = cloneSessionExecutionRuntimeRecord(value);
  const byId = owners.sessionRuntime.getRuntime(runtime.sessionExecutionRuntimeId);
  if (!byId || !sameValue(runtime, cloneSessionExecutionRuntimeRecord(byId))) {
    throw new Error("session_id_acp_card_runtime_lookup_mismatch");
  }
  if (runtime.taskId !== context.generation.taskId
    || runtime.runId !== context.generation.runId
    || runtime.logicalSessionId !== context.generation.sessionId) {
    throw new Error("session_id_acp_card_existing_runtime_scope_mismatch");
  }
  if (runtime.state !== "idle" || runtime.activeAttemptId !== undefined) {
    throw new Error("session_id_acp_card_existing_runtime_not_idle");
  }
  return runtime;
}

function assertStillUnbound(
  owners: SessionIdAcpCardBindingOwnerCapabilities,
  logicalSessionId: string,
  bindingId: string,
  runtimeId: string,
): void {
  if (owners.binding.getBinding(bindingId) || owners.sessionRuntime.getRuntime(runtimeId)) {
    throw new Error("session_id_acp_card_generated_id_conflict");
  }
  if (owners.binding.getCurrentBinding(logicalSessionId)
    || owners.binding.listBindings(logicalSessionId).length !== 0
    || owners.sessionRuntime.getRuntimeForSession(logicalSessionId)) {
    throw new Error("session_id_acp_card_entry_fence_changed");
  }
}

function assertPersistedPair(
  owners: SessionIdAcpCardBindingOwnerCapabilities,
  context: CardBindingContext,
  expectedBinding: AcpSafeSessionBindingRecordV3,
  expectedRuntime: SessionExecutionRuntimeRecord,
): void {
  const current = owners.binding.getCurrentBinding(context.generation.sessionId);
  const binding = current
    ? requireExistingBinding(context, current, owners.binding.listBindings(context.generation.sessionId), owners)
    : undefined;
  const sessionRuntime = owners.sessionRuntime.getRuntimeForSession(context.generation.sessionId);
  const runtime = sessionRuntime ? requireExistingRuntime(context, sessionRuntime, owners) : undefined;
  if (!binding || !runtime || !sameValue(binding, expectedBinding) || !sameValue(runtime, expectedRuntime)) {
    throw new Error("session_id_acp_card_binding_pair_commit_mismatch");
  }
}

function assertContextFence(
  owners: SessionIdAcpCardBindingOwnerCapabilities,
  logicalSessionId: string,
  expectedFence: string,
): void {
  let actualFence: string;
  try {
    actualFence = contextFence(resolveContext(owners, logicalSessionId));
  } catch {
    throw new Error("session_id_acp_card_entry_fence_changed");
  }
  if (actualFence !== expectedFence) {
    throw new Error("session_id_acp_card_entry_fence_changed");
  }
}

function contextFence(context: CardBindingContext): string {
  return hashDefinition({
    architecture: context.architecture,
    run: context.run,
    slot: context.slot,
    generation: context.generation,
  } as unknown as JsonValue);
}

function projectResult(
  disposition: "created" | "replay",
  context: CardBindingContext,
  binding: AcpSafeSessionBindingRecordV3,
  runtime: SessionExecutionRuntimeRecord,
): SessionIdAcpCardBindingEnsureResult {
  const result: SessionIdAcpCardBindingEnsureResult = Object.freeze({
    disposition,
    taskId: context.generation.taskId,
    runId: context.generation.runId,
    logicalSessionId: context.generation.sessionId,
    agentCardId: context.card.agentCardId,
    executionProfileId: context.profile.executionProfileId,
    profileRevisionId: context.profile.profileRevisionId,
    providerFamily: context.profile.providerFamily,
    bindingId: binding.bindingId,
    bindingHandle: binding.bindingHandle,
    sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
  });
  assertSessionExecutionSafeValue(result, "ACP Card Binding ensure result");
  return result;
}

function validateInput(value: unknown): string {
  assertSessionExecutionSafeValue(value, "ACP Card Binding ensure input");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !("logicalSessionId" in value)) {
    throw new Error("session_id_acp_card_binding_input_shape_invalid");
  }
  const logicalSessionId = (value as Readonly<{ logicalSessionId?: unknown }>).logicalSessionId;
  if (typeof logicalSessionId !== "string"
    || logicalSessionId.length > 256
    || !/^logical_session_[A-Za-z0-9_-]+$/u.test(logicalSessionId)) {
    throw new Error("session_id_acp_card_logical_session_id_invalid");
  }
  return logicalSessionId;
}

function validateOptions(options: SessionIdAcpCardBindingOwnerOptions): void {
  if (!options || typeof options !== "object"
    || typeof options.now !== "function"
    || typeof options.createId !== "function"
    || !options.transaction
    || typeof options.transaction.run !== "function") {
    throw new Error("session_id_acp_card_binding_options_invalid");
  }
}

function createdId(value: string, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || value.length > 256 || !pattern.test(value)) throw new Error(code);
  return value;
}

function isoTimestamp(value: string, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}
