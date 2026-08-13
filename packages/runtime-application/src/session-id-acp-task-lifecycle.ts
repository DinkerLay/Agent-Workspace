import {
  assertSessionExecutionSafeValue,
  type ProviderFamily,
  type TaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpSessionRuntimeOwnerRepositories,
} from "@agent-workspace/runtime-store";

export type SessionIdAcpTaskLifecycleOwnerCapabilities = Pick<
  AcpSessionRuntimeOwnerRepositories,
  "binding" | "sessionRuntime"
>;

export type SessionIdAcpTaskLifecycleReadCapabilities = Readonly<{
  binding: Pick<SessionIdAcpTaskLifecycleOwnerCapabilities["binding"],
    "getBinding" | "getCurrentBinding" | "listBindings">;
  sessionRuntime: Pick<SessionIdAcpTaskLifecycleOwnerCapabilities["sessionRuntime"],
    "getRuntime" | "getRuntimeForSession" | "getAttempt" | "listAttempts">;
}>;

export type SessionIdAcpTaskCommandFence =
  | Readonly<{
      operation: "start" | "restart";
      commandId: string;
      issuedAt: string;
      taskId: string;
      expectedTaskRevision: number;
      runId: string;
      conductorLogicalSessionId: string;
    }>
  | Readonly<{
      operation: "resume";
      commandId: string;
      issuedAt: string;
      taskId: string;
      expectedTaskRevision: number;
      runId: string;
      expectedRunRevision: number;
      conductorLogicalSessionId: string;
    }>;

export type SessionIdAcpTaskPreparedBinding = Readonly<{
  bindingId: string;
  bindingHandle: string;
  logicalSessionId: string;
  sessionExecutionRuntimeId: string;
  executionProfileId: string;
  profileRevisionId: string;
  providerFamily: ProviderFamily;
}>;

/** Safe application result only; raw ACP IDs, cwd and resolution material are forbidden. */
export type SessionIdAcpTaskLifecyclePreparedResult = Readonly<{
  schemaVersion: 3;
  operation: SessionIdAcpTaskCommandFence["operation"];
  taskId: string;
  runId: string;
  bindings: readonly SessionIdAcpTaskPreparedBinding[];
  providerEffectIntentIds: readonly string[];
}>;

/**
 * ACP-only lifecycle seam. `prepare` is read-only and must not perform an ACP
 * or other external effect. `stage` is synchronous and runs inside the
 * canonical lifecycle transaction; it may write only the supplied owner
 * scopes. Provider effects are created later by the owning Runtime command.
 */
export type SessionIdAcpTaskLifecyclePort = Readonly<{
  prepare(input: Readonly<{
    architecture: TaskArchitectureSnapshotV3;
    commandFence: SessionIdAcpTaskCommandFence;
    owners: SessionIdAcpTaskLifecycleReadCapabilities;
  }>): Promise<SessionIdAcpTaskLifecyclePreparedResult>;
  stage(input: Readonly<{
    architecture: TaskArchitectureSnapshotV3;
    commandFence: SessionIdAcpTaskCommandFence;
    prepared: SessionIdAcpTaskLifecyclePreparedResult;
    owners: SessionIdAcpTaskLifecycleOwnerCapabilities;
  }>): void;
}>;

export function validateSessionIdAcpTaskLifecyclePreparedResult(
  value: unknown,
  input: Readonly<{
    architecture: TaskArchitectureSnapshotV3;
    commandFence: SessionIdAcpTaskCommandFence;
  }>,
): SessionIdAcpTaskLifecyclePreparedResult {
  assertSessionExecutionSafeValue(value, "ACP Task lifecycle prepared result");
  const root = exactRecord(value, [
    "schemaVersion", "operation", "taskId", "runId", "bindings", "providerEffectIntentIds",
  ], "acp_task_lifecycle_prepared_shape_invalid");
  if (root.schemaVersion !== 3
    || root.operation !== input.commandFence.operation
    || root.taskId !== input.commandFence.taskId
    || root.runId !== input.commandFence.runId
    || input.architecture.taskId !== input.commandFence.taskId) {
    throw new Error("acp_task_lifecycle_prepared_scope_mismatch");
  }
  if (!Array.isArray(root.bindings) || root.bindings.length === 0) {
    throw new Error("acp_task_lifecycle_prepared_binding_required");
  }
  const bindings = root.bindings.map((entry) => validateBinding(entry, input));
  assertUnique(bindings.map((entry) => entry.bindingId), "acp_task_lifecycle_binding_id_duplicate");
  assertUnique(bindings.map((entry) => entry.bindingHandle), "acp_task_lifecycle_binding_handle_duplicate");
  assertUnique(
    bindings.map((entry) => entry.sessionExecutionRuntimeId),
    "acp_task_lifecycle_runtime_id_duplicate",
  );
  if (bindings.length !== 1
    || bindings[0]!.logicalSessionId !== input.commandFence.conductorLogicalSessionId
    || bindings[0]!.executionProfileId !== input.architecture.definition.conductor.executionProfileId) {
    throw new Error("acp_task_lifecycle_conductor_binding_mismatch");
  }
  if (!Array.isArray(root.providerEffectIntentIds)) {
    throw new Error("acp_task_lifecycle_effect_ids_invalid");
  }
  if (root.providerEffectIntentIds.length !== 0) {
    throw new Error("acp_task_lifecycle_eager_effect_forbidden");
  }
  return Object.freeze({
    schemaVersion: 3,
    operation: input.commandFence.operation,
    taskId: input.commandFence.taskId,
    runId: input.commandFence.runId,
    bindings: Object.freeze(bindings),
    providerEffectIntentIds: Object.freeze([]),
  });
}

function validateBinding(
  value: unknown,
  input: Readonly<{
    architecture: TaskArchitectureSnapshotV3;
    commandFence: SessionIdAcpTaskCommandFence;
  }>,
): SessionIdAcpTaskPreparedBinding {
  const root = exactRecord(value, [
    "bindingId", "bindingHandle", "logicalSessionId", "sessionExecutionRuntimeId",
    "executionProfileId", "profileRevisionId", "providerFamily",
  ], "acp_task_lifecycle_prepared_binding_shape_invalid");
  const executionProfileId = prefixedId(
    root.executionProfileId,
    "profile",
    "acp_task_lifecycle_execution_profile_id_invalid",
  );
  const profile = input.architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === executionProfileId);
  if (!profile
    || root.profileRevisionId !== profile.profileRevisionId
    || root.providerFamily !== profile.providerFamily) {
    throw new Error("acp_task_lifecycle_frozen_profile_mismatch");
  }
  const bindingHandle = prefixedId(root.bindingHandle, "binding_handle", "acp_task_lifecycle_binding_handle_invalid");
  return Object.freeze({
    bindingId: prefixedId(root.bindingId, "binding", "acp_task_lifecycle_binding_id_invalid"),
    bindingHandle,
    logicalSessionId: prefixedId(
      root.logicalSessionId,
      "logical_session",
      "acp_task_lifecycle_logical_session_id_invalid",
    ),
    sessionExecutionRuntimeId: prefixedId(
      root.sessionExecutionRuntimeId,
      "session_execution_runtime",
      "acp_task_lifecycle_runtime_id_invalid",
    ),
    executionProfileId,
    profileRevisionId: prefixedId(
      root.profileRevisionId,
      "profile_revision",
      "acp_task_lifecycle_profile_revision_id_invalid",
    ),
    providerFamily: root.providerFamily as ProviderFamily,
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const root = value as Record<string, unknown>;
  const actual = Object.keys(root);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(code);
  return root;
}

function prefixedId(value: unknown, prefix: string, code: string): string {
  if (typeof value !== "string"
    || value.length > 256
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) throw new Error(code);
  return value;
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}
