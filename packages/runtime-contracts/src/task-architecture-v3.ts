import type {
  ArchitectureSnapshotId,
  TaskId,
  TemplateId,
  TemplateVersionId,
  WorkspaceId,
} from "./ids";
import { assertJsonValue, cloneJson, hashDefinition, type JsonValue } from "./json";
import {
  validateTemplateDefinitionV3,
  type TaskInputSchema,
  type TaskInputValue,
  type TemplateDefinitionV3,
} from "./templates";

export interface WorkspaceReferenceV3 {
  readonly workspaceId: WorkspaceId;
  readonly grantDigest: string;
}

/** Explicit ACP-era snapshot; legacy cwd-bearing v2 rows migrate only in Phase 6. */
export interface TaskArchitectureSnapshotV3 {
  readonly schemaVersion: 3;
  readonly architectureSnapshotId: ArchitectureSnapshotId;
  readonly taskId: TaskId;
  readonly templateId: TemplateId;
  readonly templateVersionId: TemplateVersionId;
  readonly templateDefinitionHash: string;
  readonly definition: TemplateDefinitionV3;
  readonly taskInputValues: readonly TaskInputValue[];
  readonly taskTitle: string;
  readonly taskGoal: string;
  readonly taskGoalContent: string;
  readonly taskGoalContentDigest: string;
  readonly taskGoalCompilerVersion: "task-goal/v1";
  readonly workspace: WorkspaceReferenceV3;
  readonly createdAt: string;
}

export function validateWorkspaceReferenceV3(value: unknown): WorkspaceReferenceV3 {
  const root = exactRecord(value, ["workspaceId", "grantDigest"], "workspace_reference_v3_shape_invalid");
  const workspaceId = prefixedId(root.workspaceId, "workspace", "workspaceId");
  const grantDigest = text(root.grantDigest, "workspace_grant_digest_required");
  if (!/^sha256:[a-f0-9]{64}$/u.test(grantDigest)) throw new Error("workspace_grant_digest_invalid");
  return Object.freeze({ workspaceId, grantDigest });
}

export function validateTaskArchitectureSnapshotV3(value: unknown): TaskArchitectureSnapshotV3 {
  const root = exactRecord(value, [
    "schemaVersion",
    "architectureSnapshotId",
    "taskId",
    "templateId",
    "templateVersionId",
    "templateDefinitionHash",
    "definition",
    "taskInputValues",
    "taskTitle",
    "taskGoal",
    "taskGoalContent",
    "taskGoalContentDigest",
    "taskGoalCompilerVersion",
    "workspace",
    "createdAt",
  ], "task_architecture_v3_snapshot_shape_invalid");
  if (root.schemaVersion !== 3) throw new Error("task_architecture_v3_schema_invalid");
  const definition = validateTemplateDefinitionV3(root.definition);
  const templateDefinitionHash = text(root.templateDefinitionHash, "task_architecture_definition_hash_required");
  if (templateDefinitionHash !== hashDefinition(definition as unknown as JsonValue)) {
    throw new Error("task_architecture_definition_hash_mismatch");
  }
  if (!Array.isArray(root.taskInputValues)) throw new Error("task_architecture_input_values_invalid");
  const taskInputValues = root.taskInputValues.map((entry, index) => {
    const input = exactRecord(entry, ["fieldId", "value"], `task_architecture_input_value_invalid:${index}`);
    return Object.freeze({
      fieldId: text(input.fieldId, "task_architecture_input_field_id_required"),
      value: text(input.value, "task_architecture_input_value_required"),
    });
  });
  const fields = definition.taskInputSchema?.fields ?? [];
  const fieldIds = new Set<string>();
  for (const input of taskInputValues) {
    if (fieldIds.has(input.fieldId)) throw new Error(`task_architecture_input_duplicate:${input.fieldId}`);
    fieldIds.add(input.fieldId);
    const field = fields.find((candidate) => candidate.fieldId === input.fieldId);
    if (!field) throw new Error(`task_architecture_input_unknown:${input.fieldId}`);
    if (input.value !== input.value.replace(/\r\n?/gu, "\n").trim()) {
      throw new Error(`task_architecture_input_not_normalized:${input.fieldId}`);
    }
    if (hasForbiddenControl(input.value)) throw new Error(`task_architecture_input_control_forbidden:${input.fieldId}`);
    if (field.kind === "choice" && !field.options.some((option) => option.optionId === input.value)) {
      throw new Error(`task_architecture_choice_invalid:${input.fieldId}`);
    }
    if (field.kind === "short_text" && input.value.includes("\n")) {
      throw new Error(`task_architecture_short_text_multiline:${input.fieldId}`);
    }
    const maximum = field.kind === "short_text" ? 1_000 : 16_000;
    if (input.value.length > maximum) throw new Error(`task_architecture_input_too_long:${input.fieldId}`);
  }
  for (const field of fields) {
    if (field.required && !fieldIds.has(field.fieldId)) {
      throw new Error(`task_architecture_required_input_missing:${field.fieldId}`);
    }
  }
  const taskTitle = normalizedTaskTitle(root.taskTitle);
  const taskGoal = normalizedTaskGoal(root.taskGoal);
  const taskGoalContent = text(root.taskGoalContent, "task_architecture_goal_required");
  if (!taskGoalContent.endsWith("\n") || taskGoalContent.endsWith("\n\n")) {
    throw new Error("task_architecture_goal_invalid");
  }
  const taskGoalContentDigest = text(root.taskGoalContentDigest, "task_architecture_goal_digest_required");
  if (taskGoalContentDigest !== hashDefinition(taskGoalContent)) {
    throw new Error("task_architecture_goal_digest_mismatch");
  }
  if (root.taskGoalCompilerVersion !== "task-goal/v1") throw new Error("task_architecture_goal_compiler_invalid");
  const expectedTaskGoalContent = renderTaskGoalContentV1({
    title: taskTitle,
    goal: taskGoal,
    taskInputValues,
  }, definition.taskInputSchema);
  if (taskGoalContent !== expectedTaskGoalContent) {
    throw new Error("task_architecture_goal_compiled_content_mismatch");
  }
  const result: TaskArchitectureSnapshotV3 = {
    schemaVersion: 3,
    architectureSnapshotId: prefixedId(root.architectureSnapshotId, "architecture", "architectureSnapshotId"),
    taskId: prefixedId(root.taskId, "task", "taskId"),
    templateId: prefixedId(root.templateId, "template", "templateId"),
    templateVersionId: prefixedId(root.templateVersionId, "template_version", "templateVersionId"),
    templateDefinitionHash,
    definition,
    taskInputValues,
    taskTitle,
    taskGoal,
    taskGoalContent,
    taskGoalContentDigest,
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: validateWorkspaceReferenceV3(root.workspace),
    createdAt: isoTimestamp(root.createdAt),
  };
  assertJsonValue(result as unknown as JsonValue);
  return cloneJson(result as unknown as JsonValue) as unknown as TaskArchitectureSnapshotV3;
}

export function cloneTaskArchitectureSnapshotV3(value: TaskArchitectureSnapshotV3): TaskArchitectureSnapshotV3 {
  return validateTaskArchitectureSnapshotV3(value);
}

export function isTaskArchitectureSnapshotV3(
  value: unknown,
): value is TaskArchitectureSnapshotV3 {
  return Boolean(value && typeof value === "object" && "schemaVersion" in value
    && (value as Readonly<{ schemaVersion?: unknown }>).schemaVersion === 3);
}

/** Shared task-goal/v1 renderer; callers validate/normalize inputs before use. */
export function renderTaskGoalContentV1(
  input: Readonly<{ title: string; goal: string; taskInputValues: readonly TaskInputValue[] }>,
  schema?: TaskInputSchema,
): string {
  const byFieldId = new Map(input.taskInputValues.map((value) => [value.fieldId, value.value] as const));
  const fieldBlocks = (schema?.fields ?? []).flatMap((field) => {
    const value = byFieldId.get(field.fieldId);
    if (value === undefined) return [];
    const renderedValue = field.kind === "choice"
      ? `${field.options.find((option) => option.optionId === value)!.label} [${value}]`
      : value;
    return [`[${field.fieldId}] ${field.label}\n${renderedValue}`];
  });
  const renderedInputs = fieldBlocks.length === 0 ? "(none)" : fieldBlocks.join("\n\n");
  return `Task title: ${input.title}\nTask goal:\n${input.goal}\nTask inputs:\n${renderedInputs}\n`;
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const root = value as Record<string, unknown>;
  const actual = Object.keys(root);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(code);
  return root;
}

function prefixedId(value: unknown, prefix: string, field: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value)) {
    throw new Error(`task_architecture_v3_id_invalid:${field}`);
  }
  return value;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function isoTimestamp(value: unknown): string {
  const timestamp = text(value, "task_architecture_created_at_required");
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error("task_architecture_created_at_invalid");
  }
  return timestamp;
}

function normalizedTaskTitle(value: unknown): string {
  const title = text(value, "task_architecture_task_title_required");
  if (title !== title.trim() || /[\u0000-\u001F\u007F]/u.test(title) || title.length > 300) {
    throw new Error("task_architecture_task_title_invalid");
  }
  return title;
}

function normalizedTaskGoal(value: unknown): string {
  const goal = text(value, "task_architecture_task_goal_required");
  if (goal !== goal.trim() || goal.includes("\r") || hasForbiddenControl(goal) || goal.length > 16_000) {
    throw new Error("task_architecture_task_goal_invalid");
  }
  return goal;
}

function hasForbiddenControl(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value);
}
