import type {
  ExecutionProfileId,
  ExecutionProfileRevisionId,
  LogicalSessionId,
  ProviderSessionBindingId,
  TaskId,
  TaskRunId,
} from "./ids";
import { assertJsonValue, cloneJson, type JsonValue } from "./json";
import {
  assertBindingHandle,
  assertSessionExecutionSafeValue,
  type BindingHandle,
} from "./session-execution-runtime";
import type { ProviderFamily } from "./templates";

export type AcpV3BindingRetirementIntentState =
  | "pending"
  | "retiring"
  | "released"
  | "unknown";

/** Reliability-owned intent persisted before one per-Binding native retirement effect. */
export interface AcpV3BindingRetirementIntentRecord {
  readonly bindingRetirementIntentId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly bindingHandle: BindingHandle;
  readonly executionProfileId: ExecutionProfileId;
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly providerFamily: ProviderFamily;
  readonly sessionControlAuditId: string;
  readonly state: AcpV3BindingRetirementIntentState;
  readonly attempts: number;
  readonly failureCode?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly releasedAt?: string;
}

export function validateAcpV3BindingRetirementIntentRecord(
  value: unknown,
): AcpV3BindingRetirementIntentRecord {
  assertSessionExecutionSafeValue(value, "ACP v3 Binding retirement intent");
  const root = exactRecord(value, [
    "bindingRetirementIntentId",
    "commandId",
    "idempotencyKey",
    "taskId",
    "runId",
    "logicalSessionId",
    "bindingId",
    "bindingRevision",
    "bindingHandle",
    "executionProfileId",
    "profileRevisionId",
    "providerFamily",
    "sessionControlAuditId",
    "state",
    "attempts",
    "revision",
    "createdAt",
    "updatedAt",
  ], ["failureCode", "releasedAt"]);
  const state = enumValue(root.state, ["pending", "retiring", "released", "unknown"] as const, "state");
  const attempts = nonNegativeInteger(root.attempts, "attempts");
  if (state === "pending" && attempts !== 0) throw new Error("acp_binding_retirement_pending_attempts_invalid");
  if (state !== "pending" && attempts < 1) throw new Error("acp_binding_retirement_attempts_invalid");
  const failureCode = optionalSafeCode(root.failureCode);
  const releasedAt = optionalIsoTimestamp(root.releasedAt, "releasedAt");
  if (state === "released") {
    if (!releasedAt || failureCode) throw new Error("acp_binding_retirement_released_shape_invalid");
  } else if (releasedAt) {
    throw new Error("acp_binding_retirement_released_at_forbidden");
  }
  if (state === "unknown" && !failureCode) throw new Error("acp_binding_retirement_failure_code_required");
  if (state !== "unknown" && failureCode) throw new Error("acp_binding_retirement_failure_code_forbidden");
  const createdAt = isoTimestamp(root.createdAt, "createdAt");
  const updatedAt = isoTimestamp(root.updatedAt, "updatedAt");
  if (updatedAt < createdAt || (releasedAt && releasedAt < createdAt)) {
    throw new Error("acp_binding_retirement_time_order_invalid");
  }
  const result: AcpV3BindingRetirementIntentRecord = {
    bindingRetirementIntentId: prefixedId(root.bindingRetirementIntentId, "binding_retirement", "bindingRetirementIntentId"),
    commandId: prefixedId(root.commandId, "command", "commandId"),
    idempotencyKey: safeText(root.idempotencyKey, "idempotencyKey"),
    taskId: prefixedId(root.taskId, "task", "taskId"),
    runId: prefixedId(root.runId, "run", "runId"),
    logicalSessionId: prefixedId(root.logicalSessionId, "logical_session", "logicalSessionId"),
    bindingId: prefixedId(root.bindingId, "binding", "bindingId"),
    bindingRevision: positiveInteger(root.bindingRevision, "bindingRevision"),
    bindingHandle: bindingHandle(root.bindingHandle),
    executionProfileId: prefixedId(root.executionProfileId, "profile", "executionProfileId"),
    profileRevisionId: prefixedId(root.profileRevisionId, "profile_revision", "profileRevisionId"),
    providerFamily: enumValue(root.providerFamily, ["opencode", "codex", "claude-code"] as const, "providerFamily"),
    sessionControlAuditId: prefixedId(root.sessionControlAuditId, "session_control", "sessionControlAuditId"),
    state,
    attempts,
    ...(failureCode ? { failureCode } : {}),
    revision: positiveInteger(root.revision, "revision"),
    createdAt,
    updatedAt,
    ...(releasedAt ? { releasedAt } : {}),
  };
  assertJsonValue(result as unknown as JsonValue);
  return cloneJson(result as unknown as JsonValue) as unknown as AcpV3BindingRetirementIntentRecord;
}

export function cloneAcpV3BindingRetirementIntentRecord(
  value: AcpV3BindingRetirementIntentRecord,
): AcpV3BindingRetirementIntentRecord {
  return validateAcpV3BindingRetirementIntentRecord(value);
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acp_binding_retirement_shape_invalid");
  }
  const root = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(root, key))
    || Object.keys(root).some((key) => !allowed.has(key))) {
    throw new Error("acp_binding_retirement_shape_invalid");
  }
  return root;
}

function prefixedId(value: unknown, prefix: string, field: string): string {
  if (typeof value !== "string" || value.length > 256
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) {
    throw new Error(`acp_binding_retirement_id_invalid:${field}`);
  }
  return value;
}

function bindingHandle(value: unknown): string {
  assertBindingHandle(value);
  return value;
}

function safeText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\r\n]/u.test(value)) {
    throw new Error(`acp_binding_retirement_text_invalid:${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`acp_binding_retirement_integer_invalid:${field}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`acp_binding_retirement_integer_invalid:${field}`);
  }
  return value as number;
}

function optionalSafeCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^acp_[a-z0-9_]{1,223}$/u.test(value)) {
    throw new Error("acp_binding_retirement_failure_code_invalid");
  }
  return value;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || new Date(value).toISOString() !== value) {
    throw new Error(`acp_binding_retirement_time_invalid:${field}`);
  }
  return value;
}

function optionalIsoTimestamp(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : isoTimestamp(value, field);
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`acp_binding_retirement_enum_invalid:${field}`);
  }
  return value as T;
}
