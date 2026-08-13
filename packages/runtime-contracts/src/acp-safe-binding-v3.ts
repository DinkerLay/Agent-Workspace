import type {
  AgentCardId,
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

export type AcpSafeSessionBindingStatusV3 = "active" | "recovering" | "released" | "unrecoverable";

/** ACP-era Binding association. Raw ACP identity and resolved Workspace path stay Host-private. */
export interface AcpSafeSessionBindingRecordV3 {
  readonly schemaVersion: 3;
  readonly bindingId: ProviderSessionBindingId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly agentCardId: AgentCardId;
  readonly executionProfileId: ExecutionProfileId;
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly providerFamily: ProviderFamily;
  readonly bindingHandle: BindingHandle;
  readonly status: AcpSafeSessionBindingStatusV3;
  readonly recoverable: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function validateAcpSafeSessionBindingRecordV3(value: unknown): AcpSafeSessionBindingRecordV3 {
  assertSessionExecutionSafeValue(value, "ACP-safe binding v3");
  const root = exactRecord(value, [
    "schemaVersion",
    "bindingId",
    "taskId",
    "runId",
    "logicalSessionId",
    "agentCardId",
    "executionProfileId",
    "profileRevisionId",
    "providerFamily",
    "bindingHandle",
    "status",
    "recoverable",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  if (root.schemaVersion !== 3) throw new Error("acp_safe_binding_v3_schema_invalid");
  const status = enumValue(root.status, ["active", "recovering", "released", "unrecoverable"] as const, "status");
  if (typeof root.recoverable !== "boolean") throw new Error("acp_safe_binding_v3_recoverable_invalid");
  if ((status === "released" || status === "unrecoverable") && root.recoverable) {
    throw new Error("acp_safe_binding_v3_terminal_recoverable_invalid");
  }
  const createdAt = isoTimestamp(root.createdAt, "createdAt");
  const updatedAt = isoTimestamp(root.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw new Error("acp_safe_binding_v3_time_order_invalid");
  const result: AcpSafeSessionBindingRecordV3 = {
    schemaVersion: 3,
    bindingId: prefixedId(root.bindingId, "binding", "bindingId"),
    taskId: prefixedId(root.taskId, "task", "taskId"),
    runId: prefixedId(root.runId, "run", "runId"),
    logicalSessionId: prefixedId(root.logicalSessionId, "logical_session", "logicalSessionId"),
    agentCardId: prefixedId(root.agentCardId, "agent_card", "agentCardId"),
    executionProfileId: prefixedId(root.executionProfileId, "profile", "executionProfileId"),
    profileRevisionId: prefixedId(root.profileRevisionId, "profile_revision", "profileRevisionId"),
    providerFamily: enumValue(root.providerFamily, ["opencode", "codex", "claude-code"] as const, "providerFamily"),
    bindingHandle: bindingHandle(root.bindingHandle),
    status,
    recoverable: root.recoverable,
    revision: positiveRevision(root.revision),
    createdAt,
    updatedAt,
  };
  assertJsonValue(result as unknown as JsonValue);
  return cloneJson(result as unknown as JsonValue) as unknown as AcpSafeSessionBindingRecordV3;
}

export function cloneAcpSafeSessionBindingRecordV3(
  value: AcpSafeSessionBindingRecordV3,
): AcpSafeSessionBindingRecordV3 {
  return validateAcpSafeSessionBindingRecordV3(value);
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("acp_safe_binding_v3_shape_invalid");
  }
  const root = value as Record<string, unknown>;
  const actual = Object.keys(root);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error("acp_safe_binding_v3_shape_invalid");
  }
  return root;
}

function prefixedId(value: unknown, prefix: string, field: string): string {
  if (typeof value !== "string" || value.length > 256 || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) {
    throw new Error(`acp_safe_binding_v3_id_invalid:${field}`);
  }
  return value;
}

function bindingHandle(value: unknown): string {
  assertBindingHandle(value);
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("acp_safe_binding_v3_revision_invalid");
  return value as number;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`acp_safe_binding_v3_time_invalid:${field}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`acp_safe_binding_v3_time_invalid:${field}`);
  }
  return value;
}

function enumValue<const T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`acp_safe_binding_v3_enum_invalid:${field}`);
  }
  return value as T;
}
