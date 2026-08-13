import { randomUUID } from "node:crypto";
import {
  assertSessionExecutionSafeValue,
  canonicalJson,
  hashDefinition,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type JsonValue,
  type SessionExecutionRuntimeRecord,
  type TaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import {
  validateSessionIdAcpTaskLifecyclePreparedResult,
  type SessionIdAcpTaskCommandFence,
  type SessionIdAcpTaskLifecycleOwnerCapabilities,
  type SessionIdAcpTaskLifecyclePort,
  type SessionIdAcpTaskLifecyclePreparedResult,
  type SessionIdAcpTaskLifecycleReadCapabilities,
  type SessionIdAcpTaskPreparedBinding,
} from "@agent-workspace/runtime-application";

export type SessionIdAcpTaskLifecycleHostIdKind =
  | "binding"
  | "binding_handle"
  | "session_execution_runtime";

export type SessionIdAcpTaskLifecycleHostOptions = Readonly<{
  now?: () => string;
  createId?: (kind: SessionIdAcpTaskLifecycleHostIdKind) => string;
}>;

type PreparedEntry = Readonly<{
  commandFingerprint: string;
  prepared: SessionIdAcpTaskLifecyclePreparedResult;
  entrySnapshot: string;
  stagedAt: string;
}>;

/**
 * Provider-neutral Host adapter for the ACP-only Task lifecycle seam.
 *
 * It owns no Provider process, raw ACP identity, cleanup, or effect intent.
 * `prepare` performs owner reads plus Host-opaque ID allocation only. `stage`
 * is synchronous so the caller's canonical transaction contains both v3
 * owner writes, or neither of them.
 */
export function createSessionIdAcpTaskLifecycleHost(
  options: SessionIdAcpTaskLifecycleHostOptions = {},
): SessionIdAcpTaskLifecyclePort {
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new Error("acp_task_lifecycle_host_now_invalid");
  }
  if (options.createId !== undefined && typeof options.createId !== "function") {
    throw new Error("acp_task_lifecycle_host_create_id_invalid");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId
    ?? ((kind: SessionIdAcpTaskLifecycleHostIdKind) => `${kind}_${randomUUID()}`);
  const preparedByCommand = new Map<string, PreparedEntry>();

  return Object.freeze({ prepare, stage });

  async function prepare(input: Readonly<{
    architecture: TaskArchitectureSnapshotV3;
    commandFence: SessionIdAcpTaskCommandFence;
    owners: SessionIdAcpTaskLifecycleReadCapabilities;
  }>): Promise<SessionIdAcpTaskLifecyclePreparedResult> {
    const architecture = validateContext(input.architecture, input.commandFence);
    const commandFingerprint = fingerprint(architecture, input.commandFence);
    const replay = preparedByCommand.get(input.commandFence.commandId);
    if (replay) {
      if (replay.commandFingerprint !== commandFingerprint) {
        throw new Error("acp_task_lifecycle_command_replay_conflict");
      }
      return replay.prepared;
    }

    const profile = conductorProfile(architecture);
    const prepared = input.commandFence.operation === "resume"
      ? prepareResume(architecture, input.commandFence, input.owners)
      : prepareNew(architecture, input.commandFence, profile, input.owners, createId);
    const candidate = prepared.bindings[0]!;
    if (input.commandFence.operation !== "resume") {
      assertPendingIdsUnique(input.commandFence.commandId, candidate);
    }
    const entrySnapshot = ownerSnapshot(input.owners, candidate);
    if (input.commandFence.operation !== "resume") assertNewEntryEmpty(input.owners, candidate);
    const stagedAt = isoTimestamp(now(), "acp_task_lifecycle_host_time_invalid");
    const entry = Object.freeze({ commandFingerprint, prepared, entrySnapshot, stagedAt });
    preparedByCommand.set(input.commandFence.commandId, entry);
    return prepared;
  }

  function stage(input: Readonly<{
    architecture: TaskArchitectureSnapshotV3;
    commandFence: SessionIdAcpTaskCommandFence;
    prepared: SessionIdAcpTaskLifecyclePreparedResult;
    owners: SessionIdAcpTaskLifecycleOwnerCapabilities;
  }>): void {
    const architecture = validateContext(input.architecture, input.commandFence);
    const commandFingerprint = fingerprint(architecture, input.commandFence);
    const entry = preparedByCommand.get(input.commandFence.commandId);
    if (!entry) throw new Error("acp_task_lifecycle_stage_without_prepare");
    if (entry.commandFingerprint !== commandFingerprint) {
      throw new Error("acp_task_lifecycle_command_replay_conflict");
    }
    const prepared = validateSessionIdAcpTaskLifecyclePreparedResult(input.prepared, {
      architecture,
      commandFence: input.commandFence,
    });
    if (!sameValue(prepared, entry.prepared)) {
      throw new Error("acp_task_lifecycle_stage_prepared_conflict");
    }
    const candidate = prepared.bindings[0]!;

    if (input.commandFence.operation === "resume") {
      if (ownerSnapshot(input.owners, candidate) !== entry.entrySnapshot) {
        throw new Error("acp_task_lifecycle_entry_snapshot_changed");
      }
      assertResumeOwnership(architecture, input.commandFence, candidate, input.owners);
      return;
    }

    if (isExactStagedState(architecture, prepared, candidate, entry.stagedAt, input.owners)) return;
    if (ownerSnapshot(input.owners, candidate) !== entry.entrySnapshot) {
      throw new Error("acp_task_lifecycle_entry_snapshot_changed");
    }
    assertNewEntryEmpty(input.owners, candidate);
    const binding = newBindingRecord(architecture, prepared, candidate, entry.stagedAt);
    const runtime = newRuntimeRecord(prepared, candidate, entry.stagedAt);
    input.owners.binding.createBinding(binding, { makeCurrent: true });
    input.owners.sessionRuntime.createRuntime(runtime);
    if (!isExactStagedState(architecture, prepared, candidate, entry.stagedAt, input.owners)) {
      throw new Error("acp_task_lifecycle_stage_commit_mismatch");
    }
  }

  function assertPendingIdsUnique(commandId: string, candidate: SessionIdAcpTaskPreparedBinding): void {
    for (const [existingCommandId, entry] of preparedByCommand) {
      if (existingCommandId === commandId) continue;
      const existing = entry.prepared.bindings[0]!;
      if (existing.bindingId === candidate.bindingId
        || existing.bindingHandle === candidate.bindingHandle
        || existing.sessionExecutionRuntimeId === candidate.sessionExecutionRuntimeId) {
        throw new Error("acp_task_lifecycle_generated_id_conflict");
      }
    }
  }
}

function prepareNew(
  architecture: TaskArchitectureSnapshotV3,
  commandFence: Extract<SessionIdAcpTaskCommandFence, { operation: "start" | "restart" }>,
  profile: ReturnType<typeof conductorProfile>,
  owners: SessionIdAcpTaskLifecycleReadCapabilities,
  createId: (kind: SessionIdAcpTaskLifecycleHostIdKind) => string,
): SessionIdAcpTaskLifecyclePreparedResult {
  const candidate = {
    bindingId: "",
    bindingHandle: "",
    logicalSessionId: commandFence.conductorLogicalSessionId,
    sessionExecutionRuntimeId: "",
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
  };
  candidate.bindingId = createId("binding");
  candidate.bindingHandle = createId("binding_handle");
  candidate.sessionExecutionRuntimeId = createId("session_execution_runtime");
  const prepared = validateSessionIdAcpTaskLifecyclePreparedResult({
    schemaVersion: 3,
    operation: commandFence.operation,
    taskId: commandFence.taskId,
    runId: commandFence.runId,
    bindings: [candidate],
    providerEffectIntentIds: [],
  }, { architecture, commandFence });
  const preparedCandidate = prepared.bindings[0]!;
  if (owners.binding.getBinding(preparedCandidate.bindingId)
    || owners.sessionRuntime.getRuntime(preparedCandidate.sessionExecutionRuntimeId)) {
    throw new Error("acp_task_lifecycle_generated_id_conflict");
  }
  return prepared;
}

function prepareResume(
  architecture: TaskArchitectureSnapshotV3,
  commandFence: Extract<SessionIdAcpTaskCommandFence, { operation: "resume" }>,
  owners: SessionIdAcpTaskLifecycleReadCapabilities,
): SessionIdAcpTaskLifecyclePreparedResult {
  const current = owners.binding.getCurrentBinding(commandFence.conductorLogicalSessionId);
  if (!current) throw new Error("acp_task_lifecycle_resume_binding_missing");
  const runtime = owners.sessionRuntime.getRuntimeForSession(commandFence.conductorLogicalSessionId);
  if (!runtime) throw new Error("acp_task_lifecycle_resume_runtime_missing");
  const candidate: SessionIdAcpTaskPreparedBinding = Object.freeze({
    bindingId: current.bindingId,
    bindingHandle: current.bindingHandle,
    logicalSessionId: current.logicalSessionId,
    sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
    executionProfileId: current.executionProfileId,
    profileRevisionId: current.profileRevisionId,
    providerFamily: current.providerFamily,
  });
  assertResumeOwnership(architecture, commandFence, candidate, owners);
  return validateSessionIdAcpTaskLifecyclePreparedResult({
    schemaVersion: 3,
    operation: "resume",
    taskId: commandFence.taskId,
    runId: commandFence.runId,
    bindings: [candidate],
    providerEffectIntentIds: [],
  }, { architecture, commandFence });
}

function validateContext(
  value: TaskArchitectureSnapshotV3,
  commandFence: SessionIdAcpTaskCommandFence,
): TaskArchitectureSnapshotV3 {
  assertSessionExecutionSafeValue(commandFence, "ACP Task lifecycle command fence");
  assertCommandFenceShape(commandFence);
  assertPrefixed(commandFence.commandId, "command", "acp_task_lifecycle_command_id_invalid");
  assertPrefixed(commandFence.taskId, "task", "acp_task_lifecycle_task_id_invalid");
  assertPrefixed(commandFence.runId, "run", "acp_task_lifecycle_run_id_invalid");
  assertPrefixed(
    commandFence.conductorLogicalSessionId,
    "logical_session",
    "acp_task_lifecycle_logical_session_id_invalid",
  );
  isoTimestamp(commandFence.issuedAt, "acp_task_lifecycle_issued_at_invalid");
  positiveRevision(commandFence.expectedTaskRevision, "acp_task_lifecycle_task_revision_invalid");
  if (commandFence.operation === "resume") {
    positiveRevision(commandFence.expectedRunRevision, "acp_task_lifecycle_run_revision_invalid");
  }
  const architecture = validateTaskArchitectureSnapshotV3(value);
  if (architecture.taskId !== commandFence.taskId) {
    throw new Error("acp_task_lifecycle_architecture_scope_mismatch");
  }
  conductorProfile(architecture);
  return architecture;
}

function assertCommandFenceShape(commandFence: SessionIdAcpTaskCommandFence): void {
  const common = [
    "operation", "commandId", "issuedAt", "taskId", "expectedTaskRevision", "runId",
    "conductorLogicalSessionId",
  ];
  const operation = (commandFence as Readonly<{ operation?: unknown }>).operation;
  if (operation !== "start" && operation !== "restart" && operation !== "resume") {
    throw new Error("acp_task_lifecycle_operation_invalid");
  }
  const expected = operation === "resume" ? [...common, "expectedRunRevision"] : common;
  const actual = Object.keys(commandFence);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error("acp_task_lifecycle_command_fence_shape_invalid");
  }
}

function conductorProfile(architecture: TaskArchitectureSnapshotV3) {
  const profile = architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === architecture.definition.conductor.executionProfileId);
  if (!profile) throw new Error("acp_task_lifecycle_conductor_profile_missing");
  return profile;
}

function assertResumeOwnership(
  architecture: TaskArchitectureSnapshotV3,
  commandFence: Extract<SessionIdAcpTaskCommandFence, { operation: "resume" }>,
  candidate: SessionIdAcpTaskPreparedBinding,
  owners: SessionIdAcpTaskLifecycleReadCapabilities,
): void {
  const profile = conductorProfile(architecture);
  const current = owners.binding.getCurrentBinding(commandFence.conductorLogicalSessionId);
  if (!current || current.bindingId !== candidate.bindingId) {
    throw new Error("acp_task_lifecycle_resume_binding_not_current");
  }
  const byId = owners.binding.getBinding(candidate.bindingId);
  if (!byId || !sameValue(byId, current)) {
    throw new Error("acp_task_lifecycle_resume_binding_lookup_mismatch");
  }
  if (current.status !== "active" || current.recoverable !== true) {
    throw new Error("acp_task_lifecycle_resume_binding_not_recoverable");
  }
  if (current.schemaVersion !== 3
    || current.taskId !== commandFence.taskId
    || current.runId !== commandFence.runId
    || current.logicalSessionId !== commandFence.conductorLogicalSessionId
    || current.agentCardId !== architecture.definition.conductor.agentCardId
    || current.executionProfileId !== profile.executionProfileId
    || current.profileRevisionId !== profile.profileRevisionId
    || current.providerFamily !== profile.providerFamily
    || current.bindingHandle !== candidate.bindingHandle) {
    throw new Error("acp_task_lifecycle_resume_binding_scope_mismatch");
  }
  const runtime = owners.sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId);
  const sessionRuntime = owners.sessionRuntime.getRuntimeForSession(commandFence.conductorLogicalSessionId);
  if (!runtime || !sessionRuntime || !sameValue(runtime, sessionRuntime)) {
    throw new Error("acp_task_lifecycle_resume_runtime_lookup_mismatch");
  }
  if (runtime.taskId !== commandFence.taskId
    || runtime.runId !== commandFence.runId
    || runtime.logicalSessionId !== commandFence.conductorLogicalSessionId) {
    throw new Error("acp_task_lifecycle_resume_runtime_scope_mismatch");
  }
  if (runtime.state !== "idle" || runtime.activeAttemptId !== undefined) {
    throw new Error("acp_task_lifecycle_resume_runtime_not_idle");
  }
}

function assertNewEntryEmpty(
  owners: SessionIdAcpTaskLifecycleReadCapabilities,
  candidate: SessionIdAcpTaskPreparedBinding,
): void {
  if (owners.binding.getBinding(candidate.bindingId)
    || owners.sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId)) {
    throw new Error("acp_task_lifecycle_generated_id_conflict");
  }
  if (owners.binding.getCurrentBinding(candidate.logicalSessionId)
    || owners.binding.listBindings(candidate.logicalSessionId).length !== 0
    || owners.sessionRuntime.getRuntimeForSession(candidate.logicalSessionId)
    || owners.sessionRuntime.listAttempts(candidate.sessionExecutionRuntimeId).length !== 0) {
    throw new Error("acp_task_lifecycle_new_entry_not_empty");
  }
}

function newBindingRecord(
  architecture: TaskArchitectureSnapshotV3,
  prepared: SessionIdAcpTaskLifecyclePreparedResult,
  candidate: SessionIdAcpTaskPreparedBinding,
  stagedAt: string,
): AcpSafeSessionBindingRecordV3 {
  return Object.freeze({
    schemaVersion: 3,
    bindingId: candidate.bindingId,
    taskId: prepared.taskId,
    runId: prepared.runId,
    logicalSessionId: candidate.logicalSessionId,
    agentCardId: architecture.definition.conductor.agentCardId,
    executionProfileId: candidate.executionProfileId,
    profileRevisionId: candidate.profileRevisionId,
    providerFamily: candidate.providerFamily,
    bindingHandle: candidate.bindingHandle,
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: stagedAt,
    updatedAt: stagedAt,
  });
}

function newRuntimeRecord(
  prepared: SessionIdAcpTaskLifecyclePreparedResult,
  candidate: SessionIdAcpTaskPreparedBinding,
  stagedAt: string,
): SessionExecutionRuntimeRecord {
  return Object.freeze({
    sessionExecutionRuntimeId: candidate.sessionExecutionRuntimeId,
    taskId: prepared.taskId,
    runId: prepared.runId,
    logicalSessionId: candidate.logicalSessionId,
    state: "idle",
    revision: 1,
    createdAt: stagedAt,
    updatedAt: stagedAt,
  });
}

function isExactStagedState(
  architecture: TaskArchitectureSnapshotV3,
  prepared: SessionIdAcpTaskLifecyclePreparedResult,
  candidate: SessionIdAcpTaskPreparedBinding,
  stagedAt: string,
  owners: SessionIdAcpTaskLifecycleReadCapabilities,
): boolean {
  const binding = owners.binding.getBinding(candidate.bindingId);
  const runtime = owners.sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId);
  if (!binding && !runtime) return false;
  if (!binding || !runtime
    || !sameValue(binding, newBindingRecord(architecture, prepared, candidate, stagedAt))
    || !sameValue(runtime, newRuntimeRecord(prepared, candidate, stagedAt))) {
    throw new Error("acp_task_lifecycle_stage_replay_conflict");
  }
  const current = owners.binding.getCurrentBinding(candidate.logicalSessionId);
  const sessionBindings = owners.binding.listBindings(candidate.logicalSessionId);
  const sessionRuntime = owners.sessionRuntime.getRuntimeForSession(candidate.logicalSessionId);
  if (!current
    || current.bindingId !== candidate.bindingId
    || sessionBindings.length !== 1
    || sessionBindings[0]!.bindingId !== candidate.bindingId
    || !sessionRuntime
    || sessionRuntime.sessionExecutionRuntimeId !== candidate.sessionExecutionRuntimeId
    || owners.sessionRuntime.listAttempts(candidate.sessionExecutionRuntimeId).length !== 0) {
    throw new Error("acp_task_lifecycle_stage_replay_conflict");
  }
  return true;
}

function ownerSnapshot(
  owners: SessionIdAcpTaskLifecycleReadCapabilities,
  candidate: SessionIdAcpTaskPreparedBinding,
): string {
  return canonicalJson({
    bindingById: (owners.binding.getBinding(candidate.bindingId) ?? null) as unknown as JsonValue,
    currentBinding: (owners.binding.getCurrentBinding(candidate.logicalSessionId) ?? null) as unknown as JsonValue,
    sessionBindings: owners.binding.listBindings(candidate.logicalSessionId) as unknown as JsonValue,
    runtimeById: (owners.sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId) ?? null) as unknown as JsonValue,
    sessionRuntime: (owners.sessionRuntime.getRuntimeForSession(candidate.logicalSessionId) ?? null) as unknown as JsonValue,
    attempts: owners.sessionRuntime.listAttempts(candidate.sessionExecutionRuntimeId) as unknown as JsonValue,
  });
}

function fingerprint(
  architecture: TaskArchitectureSnapshotV3,
  commandFence: SessionIdAcpTaskCommandFence,
): string {
  return hashDefinition({ architecture, commandFence } as unknown as JsonValue);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

function assertPrefixed(value: string, prefix: string, code: string): void {
  if (typeof value !== "string"
    || value.length > 256
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) throw new Error(code);
}

function positiveRevision(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(code);
}

function isoTimestamp(value: string, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return value;
}
