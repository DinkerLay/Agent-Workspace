const {
  RUN_STATUS,
  TASK_STATUS,
  assertTaskStatusTransition,
} = require("./agent-loop-state-model.cjs");

function createTaskRunService({ repository, now = () => new Date().toISOString(), randomUUID } = {}) {
  if (!repository?.commitCommand || !repository?.prepareCommand) {
    throw new Error("Task/Run Service requires the Task/Run Repository.");
  }
  if (typeof randomUUID !== "function") throw new Error("Task/Run Service requires randomUUID.");

  function prepareStart({ taskId, commandId = newCommandId("start"), expectedRevision, run }) {
    const prepared = repository.prepareCommand({
      commandId,
      taskId,
      kind: "task.start_run",
      payload: {},
      expectedRevision,
      mutate({ task, latestRun, insertRun, updateTaskStatus }) {
        if (task.status === TASK_STATUS.ARCHIVED) throw new Error("loop_task_is_archived");
        // An achieved Task keeps its original Run and Provider Session binding
        // specifically so the user can explicitly pull that exact conversation
        // back. Starting here would fabricate a new Run identity instead.
        if (task.status === TASK_STATUS.ACHIEVED) throw new Error("loop_task_requires_resume_achieved");
        if ([TASK_STATUS.STOPPING, TASK_STATUS.DELETING].includes(task.status)) {
          throw new Error("loop_task_lifecycle_operation_in_progress");
        }
        const previousRun = latestRun(task.taskId);
        if ([RUN_STATUS.RUNNING, RUN_STATUS.RECOVERY_REQUIRED].includes(String(previousRun?.status))) {
          throw new Error(previousRun?.status === RUN_STATUS.RECOVERY_REQUIRED ? "loop_run_requires_recovery" : "loop_run_already_running");
        }
        assertTaskStatusTransition(task.status, TASK_STATUS.RUNNING, "loop_task_not_startable");
        const nextRun = insertRun({ ...run, taskId: task.taskId, status: RUN_STATUS.RUNNING, createdAt: run.createdAt || now() });
        const nextTask = updateTaskStatus({ taskId: task.taskId, status: TASK_STATUS.RUNNING });
        return {
          taskId: nextTask.taskId,
          taskRevision: nextTask.revision,
          runId: nextRun.runId,
          runRevision: nextRun.revision,
        };
      },
    });
    return { ...prepared, commandId };
  }

  function completeStart({ commandId, task, run }) {
    return repository.completePreparedCommand({
      commandId,
      mutate({ appendRunEvent, enqueueTaskEvent }) {
        appendRunEvent({
          runId: run.runId,
          type: "conductor.started",
          summary: "Conductor 已启动，等待其异步派发原生 Session Agent。",
          data: { sessionId: run.conductorSessionId },
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.run.started`,
          taskId: task.taskId,
          runId: run.runId,
          cwd: task.cwd,
          type: "task.run.started",
          summary: "Agent Loop 已启动；Conductor 正在形成首次派发决策。",
          data: { runId: run.runId },
        });
        return { taskId: task.taskId, runId: run.runId };
      },
    });
  }

  function failStart({ commandId, task, run, reason }) {
    return repository.failPreparedCommand({
      commandId,
      error: reason,
      mutate({ appendRunEvent, enqueueTaskEvent, taskById, updateRunStatus, updateTaskStatus }) {
        const currentRun = repository.runById(run.runId);
        if (currentRun && currentRun.status !== RUN_STATUS.FAILED) {
          updateRunStatus({ runId: currentRun.runId, status: RUN_STATUS.FAILED });
        }
        const currentTask = taskById(task.taskId);
        if (currentTask && currentTask.status === TASK_STATUS.RUNNING) {
          assertTaskStatusTransition(currentTask.status, TASK_STATUS.QUEUED);
          updateTaskStatus({ taskId: currentTask.taskId, status: TASK_STATUS.QUEUED });
        }
        appendRunEvent({
          runId: run.runId,
          type: "conductor.start.failed",
          summary: "Conductor 未能启动；Task 保持可重试。",
          data: { reason },
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.run.start_failed`,
          taskId: task.taskId,
          runId: run.runId,
          cwd: task.cwd,
          type: "task.run.start_failed",
          summary: "Conductor 未能启动；未创建可用运行时 Session。",
          data: { runId: run.runId, reason },
        });
        return { taskId: task.taskId, runId: run.runId, failed: true };
      },
    });
  }

  function resumeForConductorInput({ taskId, cause, inputId }) {
    const task = repository.taskById(taskId);
    if (!task || task.status !== TASK_STATUS.DELIVERY_READY) return undefined;
    const run = repository.latestRun(task.taskId);
    if (!run) throw new Error("loop_run_not_found");
    const commandId = `runtime:${run.runId}:continue:${safeKey(inputId || `${cause || "input"}:${task.revision}`)}`;
    const result = repository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "task.continue",
      payload: { cause: String(cause || "conductor_input"), inputId: inputId ? String(inputId) : undefined },
      expectedRevision: task.revision,
      mutate({ appendRunEvent, task: currentTask, updateRunStatus, updateTaskStatus }) {
        assertTaskStatusTransition(currentTask.status, TASK_STATUS.RUNNING);
        const currentRun = repository.latestRun(currentTask.taskId);
        updateRunStatus({ runId: currentRun.runId, status: RUN_STATUS.RUNNING });
        const nextTask = updateTaskStatus({ taskId: currentTask.taskId, status: TASK_STATUS.RUNNING });
        appendRunEvent({
          runId: currentRun.runId,
          type: "task.continued",
          summary: "新的 Conductor 输入已开启下一次决策；Task 回到运行中。",
          data: { cause: String(cause || "conductor_input"), inputId: inputId ? String(inputId) : undefined },
        });
        return { taskId: nextTask.taskId, runId: currentRun.runId };
      },
    });
    return result.result;
  }

  function claimDelivery({ taskId, sessionId, message = "", summary }) {
    const task = repository.taskById(taskId);
    if (!task) return undefined;
    const run = repository.latestRun(task.taskId);
    if (!run) throw new Error("loop_run_not_found");
    if (![TASK_STATUS.RUNNING, TASK_STATUS.DELIVERY_READY].includes(task.status)) return { taskId: task.taskId, runId: run.runId };
    if (task.status === TASK_STATUS.DELIVERY_READY) return { taskId: task.taskId, runId: run.runId };
    const commandId = `runtime:${run.runId}:delivery-claim:${task.revision}`;
    const committed = repository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "task.claim_delivery",
      payload: { sessionId: String(sessionId || run.conductorSessionId || ""), message: String(message), summary: summary ? String(summary) : undefined },
      expectedRevision: task.revision,
      mutate({ appendRunEvent, enqueueTaskEvent, task: currentTask, updateRunStatus, updateTaskStatus }) {
        assertTaskStatusTransition(currentTask.status, TASK_STATUS.DELIVERY_READY);
        updateRunStatus({ runId: run.runId, status: RUN_STATUS.RUNNING });
        const nextTask = updateTaskStatus({ taskId: currentTask.taskId, status: TASK_STATUS.DELIVERY_READY });
        const claimSummary = summary
          ? String(summary)
          : "Task completion claimed by Conductor";
        appendRunEvent({
          runId: run.runId,
          type: "conductor.delivery_claim",
          summary: "Conductor 已提交当前交付主张；Runtime 已记录此时的语义事实，未裁决内容是否正确。",
          data: { message: String(message), source: "conductor" },
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.completion_claim`,
          taskId: currentTask.taskId,
          runId: run.runId,
          sessionId: String(sessionId || run.conductorSessionId || ""),
          cwd: currentTask.cwd,
          type: "task.completion_claim",
          summary: claimSummary,
          data: { message: String(message), source: "conductor" },
        });
        return { taskId: nextTask.taskId, runId: run.runId };
      },
    });
    return committed.result;
  }

  function achieve({ taskId, commandId = newCommandId("achieve"), expectedRevision }) {
    const task = repository.taskById(taskId);
    if (!task) throw new Error("loop_task_not_found");
    if (task.status === TASK_STATUS.ACHIEVED) return { taskId: task.taskId, runId: repository.latestRun(task.taskId)?.runId };
    const committed = repository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "task.achieve",
      payload: {},
      expectedRevision,
      mutate({ appendRunEvent, enqueueTaskEvent, latestRun, task: currentTask, updateRunStatus, updateTaskStatus }) {
        assertTaskStatusTransition(currentTask.status, TASK_STATUS.ACHIEVED, "loop_task_not_achievable");
        const run = latestRun(currentTask.taskId);
        const nextTask = updateTaskStatus({ taskId: currentTask.taskId, status: TASK_STATUS.ACHIEVED });
        if (run) {
          updateRunStatus({ runId: run.runId, status: RUN_STATUS.ACHIEVED });
          appendRunEvent({
            runId: run.runId,
            type: "task.achieved",
            summary: "用户已确认当前交付，Task 进入 achieved 历史。",
            data: {},
          });
        }
        enqueueTaskEvent({
          outboxId: `${commandId}:task.achieved`,
          taskId: currentTask.taskId,
          runId: run?.runId,
          cwd: currentTask.cwd,
          type: "task.achieved",
          summary: "用户已确认当前 Task 完成。",
          data: { runId: run?.runId },
        });
        return { taskId: nextTask.taskId, runId: run?.runId };
      },
    });
    return committed.result;
  }

  /**
   * Resume is deliberately narrower than start: the Runtime has already
   * reconciled the exact original Provider Session, then this one Task/Run
   * transaction records the lifecycle decision.  The service never creates a
   * Run or a Session while resuming an achieved Task.
   */
  function resumeAchieved({ taskId, commandId = newCommandId("resume-achieved"), expectedRevision, runId, conductorSessionId, providerSessionId }) {
    if (!Number.isSafeInteger(Number(expectedRevision))) throw new Error("loop_task_expected_revision_required");
    const normalizedRunId = requiredString(runId, "runId");
    const normalizedConductorSessionId = requiredString(conductorSessionId, "conductorSessionId");
    const normalizedProviderSessionId = requiredString(providerSessionId, "providerSessionId");
    const task = repository.taskById(taskId);
    if (!task) throw new Error("loop_task_not_found");
    const committed = repository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "task.resume_achieved",
      payload: {
        runId: normalizedRunId,
        conductorSessionId: normalizedConductorSessionId,
        providerSessionId: normalizedProviderSessionId,
      },
      expectedRevision,
      mutate({ appendRunEvent, enqueueTaskEvent, latestRun, task: currentTask, updateRunStatus, updateTaskStatus }) {
        if (currentTask.status !== TASK_STATUS.ACHIEVED) throw new Error("loop_task_not_achieved");
        const run = latestRun(currentTask.taskId);
        if (!run || run.runId !== normalizedRunId) throw new Error("loop_achieved_run_is_not_current");
        if (run.status !== RUN_STATUS.ACHIEVED) throw new Error("loop_achieved_run_not_resumable");
        if (String(run.conductorSessionId ?? "") !== normalizedConductorSessionId) {
          throw new Error("loop_achieved_conductor_session_mismatch");
        }
        assertTaskStatusTransition(currentTask.status, TASK_STATUS.RUNNING, "loop_task_not_resumable");
        updateRunStatus({ runId: run.runId, status: RUN_STATUS.RUNNING });
        const nextTask = updateTaskStatus({ taskId: currentTask.taskId, status: TASK_STATUS.RUNNING });
        appendRunEvent({
          runId: run.runId,
          type: "task.resumed",
          summary: "用户已拉回已完成任务；原 Conductor Provider Session 已验证可继续。",
          data: {
            cause: "user_resume_achieved",
            conductorSessionId: normalizedConductorSessionId,
            provider: "opencode",
            providerSessionId: normalizedProviderSessionId,
          },
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.resumed`,
          taskId: nextTask.taskId,
          runId: run.runId,
          sessionId: normalizedConductorSessionId,
          cwd: nextTask.cwd,
          type: "task.resumed",
          summary: "用户已拉回已完成 Task；原 Conductor Session 已恢复为运行中。",
          data: {
            runId: run.runId,
            conductorSessionId: normalizedConductorSessionId,
            provider: "opencode",
            providerSessionId: normalizedProviderSessionId,
          },
        });
        return { taskId: nextTask.taskId, runId: run.runId, taskRevision: nextTask.revision };
      },
    });
    return committed.result;
  }

  function prepareStop({ taskId, commandId = newCommandId("stop"), expectedRevision }) {
    const prepared = repository.prepareCommand({
      commandId,
      taskId,
      kind: "task.stop",
      payload: {},
      expectedRevision,
      mutate({ latestRun, task, updateTaskStatus }) {
        if (task.status === TASK_STATUS.STOPPED) return { taskId: task.taskId, alreadyStopped: true };
        if (![TASK_STATUS.RUNNING, TASK_STATUS.DELIVERY_READY, TASK_STATUS.STOPPING].includes(task.status)) {
          throw new Error("loop_task_not_stoppable");
        }
        const run = latestRun(task.taskId);
        if (!run) throw new Error("loop_run_not_found");
        const stopping = task.status === TASK_STATUS.STOPPING
          ? task
          : updateTaskStatus({ taskId: task.taskId, status: TASK_STATUS.STOPPING });
        return { taskId: stopping.taskId, runId: run.runId, taskRevision: stopping.revision };
      },
    });
    return { ...prepared, commandId };
  }

  function completeStop({ commandId, task, run }) {
    return repository.completePreparedCommand({
      commandId,
      mutate({ appendRunEvent, enqueueTaskEvent, taskById, updateRunStatus, updateTaskStatus }) {
        const currentTask = taskById(task.taskId);
        if (!currentTask) return { taskId: task.taskId, runId: run.runId };
        if (currentTask.status !== TASK_STATUS.STOPPING) return { taskId: currentTask.taskId, runId: run.runId };
        assertTaskStatusTransition(currentTask.status, TASK_STATUS.STOPPED);
        const currentRun = repository.runById(run.runId);
        if (currentRun && currentRun.status !== RUN_STATUS.STOPPED) {
          updateRunStatus({ runId: currentRun.runId, status: RUN_STATUS.STOPPED });
        }
        const stopped = updateTaskStatus({ taskId: currentTask.taskId, status: TASK_STATUS.STOPPED });
        appendRunEvent({
          runId: run.runId,
          type: "task.stopped",
          summary: "用户已停止当前 Task Run；活动 Session 已中止并保留历史。",
          data: {},
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.stopped`,
          taskId: stopped.taskId,
          runId: run.runId,
          cwd: stopped.cwd,
          type: "task.stopped",
          summary: "用户已停止当前 Task；可稍后启动新的 Run。",
          data: { runId: run.runId },
        });
        return { taskId: stopped.taskId, runId: run.runId, taskRevision: stopped.revision };
      },
    });
  }

  /**
   * Recycle is a synchronous Task lifecycle mutation.  It deliberately
   * preserves the original Run, Session bindings and Session Store tree; the
   * restore command returns to achieved so the existing exact-session resume
   * gate remains unchanged.
   */
  function moveToRecycleBin({ taskId, commandId = newCommandId("move-to-recycle-bin"), expectedRevision }) {
    const committed = repository.commitCommand({
      commandId,
      taskId,
      kind: "task.move_to_recycle_bin",
      payload: {},
      expectedRevision,
      mutate({ appendRunEvent, enqueueTaskEvent, latestRun, task, updateTaskStatus }) {
        if (task.status !== TASK_STATUS.ACHIEVED) throw new Error("loop_task_not_recyclable");
        assertTaskStatusTransition(task.status, TASK_STATUS.ARCHIVED, "loop_task_not_recyclable");
        const nextTask = updateTaskStatus({ taskId: task.taskId, status: TASK_STATUS.ARCHIVED });
        const run = latestRun(task.taskId);
        if (run) {
          appendRunEvent({
            runId: run.runId,
            type: "task.recycled",
            summary: "Task 已移入回收站；原 Task、Run 与 Session 绑定仍可放回。",
            data: {},
          });
        }
        enqueueTaskEvent({
          outboxId: `${commandId}:task.recycled`,
          taskId: nextTask.taskId,
          runId: run?.runId,
          cwd: nextTask.cwd,
          type: "task.recycled",
          summary: "Task 已移入回收站；不会删除项目文件或原 Session 绑定。",
          data: { runId: run?.runId },
        });
        return { taskId: nextTask.taskId, runId: run?.runId, taskRevision: nextTask.revision };
      },
    });
    return committed.result;
  }

  function restoreFromRecycleBin({ taskId, commandId = newCommandId("restore-from-recycle-bin"), expectedRevision }) {
    const committed = repository.commitCommand({
      commandId,
      taskId,
      kind: "task.restore_from_recycle_bin",
      payload: {},
      expectedRevision,
      mutate({ appendRunEvent, enqueueTaskEvent, latestRun, task, updateTaskStatus }) {
        if (task.status !== TASK_STATUS.ARCHIVED) throw new Error("loop_task_not_in_recycle_bin");
        assertTaskStatusTransition(task.status, TASK_STATUS.ACHIEVED, "loop_task_not_restorable");
        const nextTask = updateTaskStatus({ taskId: task.taskId, status: TASK_STATUS.ACHIEVED });
        const run = latestRun(task.taskId);
        if (run) {
          appendRunEvent({
            runId: run.runId,
            type: "task.restored_from_recycle_bin",
            summary: "Task 已从回收站放回已完成历史；可按原 Session 拉回继续。",
            data: {},
          });
        }
        enqueueTaskEvent({
          outboxId: `${commandId}:task.restored`,
          taskId: nextTask.taskId,
          runId: run?.runId,
          cwd: nextTask.cwd,
          type: "task.restored_from_recycle_bin",
          summary: "Task 已放回已完成历史；未创建新的 Run 或 Provider Session。",
          data: { runId: run?.runId },
        });
        return { taskId: nextTask.taskId, runId: run?.runId, taskRevision: nextTask.revision };
      },
    });
    return committed.result;
  }

  function preparePermanentDelete({ taskId, commandId = newCommandId("permanently-delete"), expectedRevision, artifactPaths = [], artifactSnapshots = [] }) {
    const normalizedArtifactPaths = uniqueArtifactPaths(artifactPaths);
    // Artifact identities are an internal Runtime capability, never Renderer
    // command input. They are written beside the selected paths so a prepared
    // permanent-delete command can be retried without re-authorizing a path.
    const normalizedArtifactSnapshots = normalizeArtifactSnapshots(artifactSnapshots, normalizedArtifactPaths);
    const prepared = repository.prepareCommand({
      commandId,
      taskId,
      kind: "task.permanently_delete",
      payload: {
        artifactPaths: normalizedArtifactPaths,
        artifactSnapshots: normalizedArtifactSnapshots,
      },
      expectedRevision,
      mutate({ task, updateTaskStatus }) {
        if (task.status === TASK_STATUS.DELETING) throw new Error("loop_task_lifecycle_operation_in_progress");
        if (task.status !== TASK_STATUS.ARCHIVED) throw new Error("loop_task_not_in_recycle_bin");
        assertTaskStatusTransition(task.status, TASK_STATUS.DELETING, "loop_task_not_deletable");
        const registeredArtifacts = repository.listManagedArtifacts(task.taskId);
        const registeredPaths = new Set(registeredArtifacts.map((artifact) => artifact.path));
        for (const artifactPath of normalizedArtifactPaths) {
          if (!registeredPaths.has(artifactPath)) throw new Error("loop_managed_artifact_not_registered");
        }
        const deleting = updateTaskStatus({ taskId: task.taskId, status: TASK_STATUS.DELETING });
        const runs = repository.listRuns(task.taskId);
        return {
          taskId: deleting.taskId,
          cwd: deleting.cwd,
          runIds: runs.map((run) => run.runId),
          artifactPaths: normalizedArtifactPaths,
          managedArtifacts: registeredArtifacts,
          taskRevision: deleting.revision,
        };
      },
    });
    return { ...prepared, commandId };
  }

  function completePermanentDelete({ commandId, cleanup }) {
    return repository.finalizePreparedTaskDeletion({
      commandId,
      finalResult: cleanup,
    });
  }

  function markRecoveryRequired({ task, run, reason }) {
    const current = repository.runById(run.runId);
    if (!current || [RUN_STATUS.STOPPED, RUN_STATUS.ACHIEVED, RUN_STATUS.FAILED].includes(current.status)) return current;
    if (current.status === RUN_STATUS.RECOVERY_REQUIRED) return current;
    const commandId = `runtime:${run.runId}:recovery-required:${current.revision}`;
    repository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "run.require_recovery",
      payload: { reason: String(reason || "conductor_terminal_unavailable") },
      expectedRevision: task.revision,
      mutate({ appendRunEvent, enqueueTaskEvent, touchTask, updateRunStatus }) {
        updateRunStatus({ runId: run.runId, status: RUN_STATUS.RECOVERY_REQUIRED });
        touchTask({ taskId: task.taskId });
        appendRunEvent({
          runId: run.runId,
          type: "conductor.recovery_required",
          summary: "原 Conductor 终端不可用；Runtime 已保留待处理消息，下一次发送会自动尝试续接。",
          data: { reason: String(reason || "conductor_terminal_unavailable") },
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.run.recovery_required`,
          taskId: task.taskId,
          runId: run.runId,
          sessionId: run.conductorSessionId,
          cwd: task.cwd,
          type: "task.run.recovery_required",
          summary: "当前 Run 的终端暂不可用；继续发送会自动尝试续接。",
          data: { runId: run.runId, reason: String(reason || "conductor_terminal_unavailable") },
        });
        return { taskId: task.taskId, runId: run.runId };
      },
    });
    return repository.runById(run.runId);
  }

  function markRecovered({ task, run, conductorSessionId, cause, pendingMessageIds = [] }) {
    const currentRun = repository.runById(run.runId);
    if (!currentRun) throw new Error("loop_run_not_found");
    const commandId = `runtime:${run.runId}:recovered:${currentRun.revision}`;
    repository.commitCommand({
      commandId,
      taskId: task.taskId,
      kind: "run.recovered",
      payload: { cause: String(cause || "runtime"), pendingMessageIds: pendingMessageIds.map(String) },
      expectedRevision: task.revision,
      mutate({ appendRunEvent, enqueueTaskEvent, touchTask, updateRunStatus }) {
        updateRunStatus({ runId: run.runId, status: RUN_STATUS.RUNNING });
        touchTask({ taskId: task.taskId });
        appendRunEvent({
          runId: run.runId,
          type: "conductor.recovered",
          summary: "Runtime 已续接当前 Task Run；新的 Conductor 终端会读取保留的 Task 历史和待发送消息。",
          data: { conductorSessionId, cause, pendingMessageIds },
        });
        enqueueTaskEvent({
          outboxId: `${commandId}:task.run.recovered`,
          taskId: task.taskId,
          runId: run.runId,
          sessionId: conductorSessionId,
          cwd: task.cwd,
          type: "task.run.recovered",
          summary: "继续任务时原 Conductor 不可用；Runtime 已启动新的终端实例并保留当前 Task Run。",
          data: { runId: run.runId, conductorSessionId, cause },
        });
        return { taskId: task.taskId, runId: run.runId };
      },
    });
    return repository.runById(run.runId);
  }

  function newCommandId(kind) {
    return `command:${kind}:${randomUUID()}`;
  }

  return {
    achieve,
    claimDelivery,
    completePermanentDelete,
    completeStart,
    completeStop,
    failStart,
    markRecovered,
    markRecoveryRequired,
    moveToRecycleBin,
    preparePermanentDelete,
    prepareStart,
    prepareStop,
    resumeAchieved,
    resumeForConductorInput,
    restoreFromRecycleBin,
  };
}

function uniqueArtifactPaths(value) {
  if (!Array.isArray(value)) throw new Error("loop_managed_artifact_paths_invalid");
  const paths = value.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (paths.some((item) => item.split(/[\\/]+/).includes("..") || item.startsWith("/") || item.includes("\0"))) {
    throw new Error("loop_managed_artifact_path_invalid");
  }
  return [...new Set(paths)].sort();
}

function normalizeArtifactSnapshots(value, artifactPaths) {
  if (!Array.isArray(value)) throw new Error("loop_managed_artifact_snapshots_invalid");
  const selectedPaths = new Set(artifactPaths);
  const snapshots = new Map();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("loop_managed_artifact_snapshot_invalid");
    }
    const artifactPath = String(item.path ?? "").trim();
    if (!selectedPaths.has(artifactPath) || snapshots.has(artifactPath)) {
      throw new Error("loop_managed_artifact_snapshot_path_invalid");
    }
    if (item.state === "missing") {
      snapshots.set(artifactPath, { path: artifactPath, state: "missing" });
      continue;
    }
    if (item.state !== "present" || !["file", "symlink"].includes(item.kind)) {
      throw new Error("loop_managed_artifact_snapshot_invalid");
    }
    const snapshot = { path: artifactPath, state: "present", kind: item.kind };
    for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) {
      if (!Object.prototype.hasOwnProperty.call(item, field)) continue;
      if (typeof item[field] !== "number" || !Number.isFinite(item[field])) {
        throw new Error("loop_managed_artifact_snapshot_invalid");
      }
      snapshot[field] = item[field];
    }
    snapshots.set(artifactPath, snapshot);
  }
  return artifactPaths.flatMap((artifactPath) => {
    const snapshot = snapshots.get(artifactPath);
    return snapshot ? [snapshot] : [];
  });
}

function safeKey(value) {
  const result = String(value ?? "").trim().replace(/[^A-Za-z0-9:_-]+/g, "-").slice(0, 240);
  return result || "input";
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Task/Run Service requires ${field}.`);
  return result;
}

module.exports = { createTaskRunService };
