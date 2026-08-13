import type {
  ArchitectureSnapshotId,
  LogicalSessionId,
  TaskArchitectureSnapshot,
  TaskArchitectureSnapshotV2,
  TaskArchitectureSnapshotV3,
  TaskId,
  TaskRecord,
  TaskRunId,
  TaskRunRecord,
  TemplateVersionRecord,
  WorkspaceReference,
  WorkspaceReferenceV3,
  LogicalSessionRecord,
  TaskInputValue,
} from "../../runtime-contracts/src";
import {
  hashDefinition,
  validateTaskArchitectureSnapshotV3,
  validateTemplateDefinitionV3,
} from "../../runtime-contracts/src";
import { assertExpectedRevision, invariant } from "./errors";

export function createTaskArchitectureSnapshot(input: {
  readonly architectureSnapshotId: ArchitectureSnapshotId;
  readonly taskId: TaskId;
  readonly templateVersion: TemplateVersionRecord;
  readonly taskInputValues: readonly TaskInputValue[];
  readonly taskGoalContent: string;
  readonly taskGoalContentDigest: string;
  readonly taskGoalCompilerVersion: "task-goal/v1";
  readonly workspace: WorkspaceReference;
  readonly now: string;
}): TaskArchitectureSnapshotV2 {
  invariant(input.architectureSnapshotId.startsWith("architecture_"), "architecture_snapshot_id_invalid");
  invariant(input.taskId.startsWith("task_"), "task_id_invalid");
  invariant(input.workspace.workspaceId.startsWith("workspace_"), "workspace_id_invalid");
  invariant(Boolean(input.workspace.cwd.trim()), "workspace_cwd_required");
  invariant(input.taskGoalContent.endsWith("\n") && !input.taskGoalContent.endsWith("\n\n"), "task_goal_content_invalid");
  invariant(input.taskGoalCompilerVersion === "task-goal/v1", "task_goal_compiler_version_invalid");
  invariant(hashDefinition(input.taskGoalContent) === input.taskGoalContentDigest, "task_goal_content_digest_mismatch");
  invariant(input.templateVersion.definition.schemaVersion === 2, "task_architecture_v2_definition_required");
  return {
    architectureSnapshotId: input.architectureSnapshotId,
    taskId: input.taskId,
    templateId: input.templateVersion.templateId,
    templateVersionId: input.templateVersion.templateVersionId,
    templateDefinitionHash: input.templateVersion.definitionHash,
    definition: input.templateVersion.definition,
    taskInputValues: input.taskInputValues.map((value) => ({ ...value })),
    taskGoalContent: input.taskGoalContent,
    taskGoalContentDigest: input.taskGoalContentDigest,
    taskGoalCompilerVersion: input.taskGoalCompilerVersion,
    workspace: input.workspace,
    createdAt: input.now,
  };
}

/** New Tasks freeze only the portable ACP v3 definition and an opaque Workspace grant. */
export function createTaskArchitectureSnapshotV3(input: {
  readonly architectureSnapshotId: ArchitectureSnapshotId;
  readonly taskId: TaskId;
  readonly templateVersion: TemplateVersionRecord;
  readonly taskInputValues: readonly TaskInputValue[];
  readonly taskTitle: string;
  readonly taskGoal: string;
  readonly taskGoalContent: string;
  readonly taskGoalContentDigest: string;
  readonly taskGoalCompilerVersion: "task-goal/v1";
  readonly workspace: WorkspaceReferenceV3;
  readonly now: string;
}): TaskArchitectureSnapshotV3 {
  const definition = validateTemplateDefinitionV3(input.templateVersion.definition);
  return validateTaskArchitectureSnapshotV3({
    schemaVersion: 3,
    architectureSnapshotId: input.architectureSnapshotId,
    taskId: input.taskId,
    templateId: input.templateVersion.templateId,
    templateVersionId: input.templateVersion.templateVersionId,
    templateDefinitionHash: input.templateVersion.definitionHash,
    definition,
    taskInputValues: input.taskInputValues,
    taskTitle: input.taskTitle,
    taskGoal: input.taskGoal,
    taskGoalContent: input.taskGoalContent,
    taskGoalContentDigest: input.taskGoalContentDigest,
    taskGoalCompilerVersion: input.taskGoalCompilerVersion,
    workspace: input.workspace,
    createdAt: input.now,
  });
}

export function createTask(input: {
  readonly taskId: TaskId;
  readonly architectureSnapshotId: ArchitectureSnapshotId;
  readonly title: string;
  readonly goal: string;
  readonly now: string;
}): TaskRecord {
  invariant(input.taskId.startsWith("task_"), "task_id_invalid");
  invariant(Boolean(input.title.trim()), "task_title_required");
  invariant(Boolean(input.goal.trim()), "task_goal_required");
  return {
    taskId: input.taskId,
    architectureSnapshotId: input.architectureSnapshotId,
    title: input.title.trim(),
    goal: input.goal.trim(),
    status: "queued",
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface StartTaskRunInput {
  readonly task: TaskRecord;
  readonly architecture: TaskArchitectureSnapshot;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly conductorLogicalSessionId: LogicalSessionId;
  readonly runNumber: number;
  readonly now: string;
}

export interface StartTaskRunResult {
  readonly task: TaskRecord;
  readonly run: TaskRunRecord;
  readonly conductorSession: LogicalSessionRecord;
}

export function startTaskRun(input: StartTaskRunInput): StartTaskRunResult {
  assertExpectedRevision(input.task.revision, input.expectedRevision);
  assertTaskNotTrashed(input.task);
  invariant(input.task.status === "queued", "task_not_startable");
  invariant(!input.task.achievement, "task_already_achieved");
  return createStartedRun(input);
}

/**
 * Restart is a user lifecycle command, never an implicit retry of a native
 * session. It creates a new Run and a new Conductor logical session only after
 * the currently active Run is terminal; Runtime Application separately proves
 * that all old Provider Bindings have been released or are unrecoverable.
 */
export function restartTaskRun(input: StartTaskRunInput & { readonly previousRun: TaskRunRecord }): StartTaskRunResult {
  assertExpectedRevision(input.task.revision, input.expectedRevision);
  assertTaskNotTrashed(input.task);
  invariant(["stopped", "blocked"].includes(input.task.status), "task_not_restartable");
  invariant(input.task.activeRunId === input.previousRun.runId, "task_active_run_mismatch");
  invariant(input.previousRun.taskId === input.task.taskId, "task_run_mismatch");
  invariant(["stopped", "failed", "cancellation_unknown"].includes(input.previousRun.status), "task_run_not_terminal");
  invariant(!input.task.achievement, "task_already_achieved");
  return createStartedRun(input);
}

function createStartedRun(input: StartTaskRunInput): StartTaskRunResult {
  invariant(input.architecture.taskId === input.task.taskId, "task_architecture_mismatch");
  invariant(input.runId.startsWith("run_"), "task_run_id_invalid");
  invariant(input.conductorLogicalSessionId.startsWith("logical_session_"), "logical_session_id_invalid");
  invariant(Number.isSafeInteger(input.runNumber) && input.runNumber > 0, "task_run_number_invalid");
  const conductor = input.architecture.definition.conductor;
  const run: TaskRunRecord = {
    runId: input.runId,
    taskId: input.task.taskId,
    conductorLogicalSessionId: input.conductorLogicalSessionId,
    status: "starting",
    runNumber: input.runNumber,
    startedAt: input.now,
    revision: 1,
  };
  const conductorSession: LogicalSessionRecord = {
    logicalSessionId: input.conductorLogicalSessionId,
    taskId: input.task.taskId,
    runId: input.runId,
    kind: "conductor",
    agentCardId: conductor.agentCardId,
    executionProfileId: conductor.executionProfileId,
    status: "unmaterialized",
    ordinal: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return {
    task: { ...input.task, status: "running", activeRunId: input.runId, revision: input.task.revision + 1, updatedAt: input.now },
    run,
    conductorSession,
  };
}

export function markTaskRunRunning(run: TaskRunRecord): TaskRunRecord {
  invariant(run.status === "starting", "task_run_not_starting");
  return { ...run, status: "running", revision: run.revision + 1 };
}

export function createCardLogicalSession(input: {
  readonly architecture: TaskArchitectureSnapshot;
  readonly runId: TaskRunId;
  readonly logicalSessionId: LogicalSessionId;
  readonly agentCardId: string;
  readonly ordinal: number;
  readonly now: string;
}): LogicalSessionRecord {
  const card = input.architecture.definition.agentCards.find((candidate) => candidate.agentCardId === input.agentCardId);
  invariant(card, "agent_card_not_in_architecture");
  invariant(input.logicalSessionId.startsWith("logical_session_"), "logical_session_id_invalid");
  invariant(Number.isSafeInteger(input.ordinal) && input.ordinal > 0, "logical_session_ordinal_invalid");
  return {
    logicalSessionId: input.logicalSessionId,
    taskId: input.architecture.taskId,
    runId: input.runId,
    kind: "card",
    agentCardId: card.agentCardId,
    executionProfileId: card.executionProfileId,
    status: "unmaterialized",
    ordinal: input.ordinal,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * User acceptance is intentionally independent from Runtime/Provider lifecycle.
 * It may be recorded for any Task and never implies that a Run or Provider has
 * completed or stopped.
 */
export function achieveTask(input: {
  readonly task: TaskRecord;
  readonly expectedRevision: number;
  readonly fileStateAnchor?: Readonly<{
    workspaceRelativePath: string;
    observedDigest: string;
    label?: string;
  }>;
  readonly acceptanceNote?: string;
  readonly now: string;
}): TaskRecord {
  assertExpectedRevision(input.task.revision, input.expectedRevision);
  assertTaskNotTrashed(input.task);
  invariant(!input.task.achievement, "task_already_achieved");
  const acceptanceNote = input.acceptanceNote?.trim();
  return {
    ...input.task,
    achievement: {
      achievedAt: input.now,
      ...(input.fileStateAnchor ? { fileStateAnchor: { ...input.fileStateAnchor } } : {}),
      ...(acceptanceNote ? { acceptanceNote } : {}),
    },
    revision: input.task.revision + 1,
    updatedAt: input.now,
  };
}

/**
 * Recycle-bin retention preserves the original Task, Runs, native bindings and
 * Workspace observation anchors. It is intentionally not a Provider-derived lifecycle or
 * completion state: only a user's explicit Achieve makes a Task recyclable.
 */
export function archiveTask(input: {
  readonly task: TaskRecord;
  readonly expectedRevision: number;
  readonly now: string;
}): TaskRecord {
  assertExpectedRevision(input.task.revision, input.expectedRevision);
  invariant(!input.task.trashedAt, "task_already_in_recycle_bin");
  invariant(Boolean(input.task.achievement), "task_not_recyclable");
  // Achieve does not stop a Provider. Runtime Application separately proves
  // all old Bindings terminal before this pure state transition is committed.
  invariant(["queued", "stopped", "blocked"].includes(input.task.status), "task_recycle_run_not_terminal");
  return {
    ...input.task,
    trashedAt: input.now,
    revision: input.task.revision + 1,
    updatedAt: input.now,
  };
}

/** Restore the exact retained Task identity; no Run or Provider Session is recreated. */
export function restoreTask(input: {
  readonly task: TaskRecord;
  readonly expectedRevision: number;
  readonly now: string;
}): TaskRecord {
  assertExpectedRevision(input.task.revision, input.expectedRevision);
  invariant(Boolean(input.task.trashedAt), "task_not_in_recycle_bin");
  const { trashedAt: _trashedAt, ...retained } = input.task;
  return {
    ...retained,
    revision: input.task.revision + 1,
    updatedAt: input.now,
  };
}

export function requestTaskStop(task: TaskRecord, run: TaskRunRecord, expectedRevision: number, now: string): { task: TaskRecord; run: TaskRunRecord } {
  assertExpectedRevision(task.revision, expectedRevision);
  assertTaskNotTrashed(task);
  invariant(task.activeRunId === run.runId, "task_active_run_mismatch");
  invariant(["running", "blocked"].includes(task.status), "task_not_stoppable");
  invariant(!["stopped", "failed"].includes(run.status), "task_run_already_terminal");
  return {
    task: { ...task, status: "stopping", revision: task.revision + 1, updatedAt: now },
    run: { ...run, status: "stopping", revision: run.revision + 1 },
  };
}

export function assertTaskNotTrashed(task: TaskRecord): void {
  invariant(!task.trashedAt, "task_in_recycle_bin");
}

export function recordTaskRunTerminal(input: {
  readonly task: TaskRecord;
  readonly run: TaskRunRecord;
  readonly outcome: "stopped" | "failed" | "cancellation_unknown";
  readonly now: string;
}): { task: TaskRecord; run: TaskRunRecord } {
  invariant(input.task.activeRunId === input.run.runId, "task_active_run_mismatch");
  invariant(input.task.status === "stopping" || input.task.status === "running", "task_not_terminalizable");
  const taskStatus = input.outcome === "stopped" ? "stopped" : "blocked" as const;
  return {
    task: { ...input.task, status: taskStatus, revision: input.task.revision + 1, updatedAt: input.now },
    run: { ...input.run, status: input.outcome, endedAt: input.now, revision: input.run.revision + 1 },
  };
}
