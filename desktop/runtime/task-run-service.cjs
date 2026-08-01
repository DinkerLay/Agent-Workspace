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
        if ([TASK_STATUS.STOPPING, TASK_STATUS.DELETING].includes(task.status)) {
          throw new Error("loop_task_lifecycle_operation_in_progress");
        }
        const previousRun = latestRun(task.taskId);
        if (task.status !== TASK_STATUS.ACHIEVED && [RUN_STATUS.RUNNING, RUN_STATUS.RECOVERY_REQUIRED].includes(String(previousRun?.status))) {
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
          summary: "用户已停止当前 Task Run；原生 Session 已停止并保留历史。",
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

  function prepareDelete({ taskId, commandId = newCommandId("delete"), expectedRevision }) {
    const prepared = repository.prepareCommand({
      commandId,
      taskId,
      kind: "task.delete",
      payload: {},
      expectedRevision,
      mutate({ task, updateTaskStatus }) {
        if (task.status !== TASK_STATUS.DELETING) {
          assertTaskStatusTransition(task.status, TASK_STATUS.DELETING, "loop_task_not_deletable");
        }
        const deleting = task.status === TASK_STATUS.DELETING
          ? task
          : updateTaskStatus({ taskId: task.taskId, status: TASK_STATUS.DELETING });
        const runs = repository.listRuns(task.taskId);
        return {
          taskId: deleting.taskId,
          cwd: deleting.cwd,
          runIds: runs.map((run) => run.runId),
          taskRevision: deleting.revision,
        };
      },
    });
    return { ...prepared, commandId };
  }

  function completeDelete({ commandId }) {
    return repository.completePreparedCommand({
      commandId,
      mutate({ command, deleteTaskData }) {
        const result = deleteTaskData({ taskId: command.taskId, runIds: command.result?.runIds ?? [] });
        return { ...command.result, ...result, deleted: true };
      },
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
    completeDelete,
    completeStart,
    completeStop,
    failStart,
    markRecovered,
    markRecoveryRequired,
    prepareDelete,
    prepareStart,
    prepareStop,
    resumeForConductorInput,
  };
}

function safeKey(value) {
  const result = String(value ?? "").trim().replace(/[^A-Za-z0-9:_-]+/g, "-").slice(0, 240);
  return result || "input";
}

module.exports = { createTaskRunService };
