function createTaskRunRepository({
  db,
  deserializeTask,
  deserializeRun,
  bindTaskRoot,
  now = () => new Date().toISOString(),
  randomUUID,
} = {}) {
  if (!db?.prepare) throw new Error("Task/Run Repository requires a database.");
  if (typeof deserializeTask !== "function" || typeof deserializeRun !== "function") {
    throw new Error("Task/Run Repository requires deserializers.");
  }
  if (typeof randomUUID !== "function") throw new Error("Task/Run Repository requires randomUUID.");

  migrateTaskRunRepository(db);

  function taskById(taskId) {
    const task = rawTaskById(taskId);
    if (!task) return undefined;
    bindTaskRoot?.({ taskId: task.taskId, cwd: task.cwd });
    return task;
  }

  // Most Task reads deliberately bind the Session Store root so a retained
  // historical Task can still be opened after an app restart.  Permanent
  // deletion is the exception: it removes that root immediately before its
  // database transaction, so finalization must never perform a normal read
  // that could recreate the directory it just removed.
  function rawTaskById(taskId) {
    const row = db.prepare("SELECT * FROM agent_loop_tasks WHERE task_id = ?").get(String(taskId));
    return row ? deserializeTask(row) : undefined;
  }

  function listTasks() {
    return db.prepare("SELECT * FROM agent_loop_tasks ORDER BY updated_at DESC").all().map(deserializeTask);
  }

  function runById(runId) {
    const row = db.prepare("SELECT * FROM agent_loop_runs WHERE run_id = ?").get(String(runId));
    return row ? deserializeRun(row) : undefined;
  }

  function latestRun(taskId) {
    const row = db.prepare("SELECT * FROM agent_loop_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(String(taskId));
    return row ? deserializeRun(row) : undefined;
  }

  function listRuns(taskId) {
    return db.prepare("SELECT * FROM agent_loop_runs WHERE task_id = ? ORDER BY created_at ASC").all(String(taskId)).map(deserializeRun);
  }

  function deleteTaskData({ taskId, runIds = listRuns(taskId).map((run) => run.runId), deleteCommands = false }) {
    const ids = [...new Set(runIds.map(String).filter(Boolean))];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      if (tableExists("agent_loop_workbench_layouts")) {
        db.prepare(`DELETE FROM agent_loop_workbench_layouts WHERE run_id IN (${placeholders})`).run(...ids);
      }
      db.prepare(`DELETE FROM agent_loop_events WHERE run_id IN (${placeholders})`).run(...ids);
      // Host bindings are owned by the OpenCode Runtime migration.  Keep the
      // repository usable in its focused tests and older databases where that
      // optional projection has not been created yet, while still removing it
      // whenever it exists in a production Runtime database.
      if (tableExists("agent_loop_opencode_host_bindings")) {
        db.prepare(`DELETE FROM agent_loop_opencode_host_bindings WHERE run_id IN (${placeholders})`).run(...ids);
      }
    }
    db.prepare("DELETE FROM agent_loop_managed_artifacts WHERE task_id = ?").run(taskId);
    if (tableExists("agent_loop_user_messages")) {
      db.prepare("DELETE FROM agent_loop_user_messages WHERE task_id = ?").run(taskId);
    }
    db.prepare("DELETE FROM agent_loop_task_event_outbox WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM agent_loop_runs WHERE task_id = ?").run(taskId);
    if (deleteCommands) db.prepare("DELETE FROM agent_loop_commands WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM agent_loop_tasks WHERE task_id = ?").run(taskId);
    return { taskId, runsDeleted: ids.length };
  }

  // A managed artifact is a narrow, explicit deletion candidate declared by
  // the immutable Task architecture.  The Runtime still validates it against
  // the Task cwd before it ever removes a filesystem entry; this registry
  // merely prevents a permanent-delete UI from naming arbitrary project
  // files.
  function registerManagedArtifact({ taskId, artifactPath, source = "template_delivery", createdAt = now() }) {
    const normalizedTaskId = requiredString(taskId, "taskId");
    const normalizedPath = requiredString(artifactPath, "artifactPath");
    db.prepare(
      `INSERT INTO agent_loop_managed_artifacts (task_id, artifact_path, source, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, artifact_path) DO NOTHING`,
    ).run(normalizedTaskId, normalizedPath, String(source || "template_delivery"), createdAt);
    return db.prepare(
      "SELECT task_id, artifact_path, source, created_at FROM agent_loop_managed_artifacts WHERE task_id = ? AND artifact_path = ?",
    ).get(normalizedTaskId, normalizedPath);
  }

  function listManagedArtifacts(taskId) {
    return db.prepare(
      "SELECT task_id, artifact_path, source, created_at FROM agent_loop_managed_artifacts WHERE task_id = ? ORDER BY artifact_path ASC",
    ).all(String(taskId)).map(deserializeManagedArtifact);
  }

  function deletionTombstoneByCommandId(commandId) {
    const row = db.prepare(
      "SELECT command_id, task_id, result_json, deleted_at FROM agent_loop_deleted_task_tombstones WHERE command_id = ?",
    ).get(String(commandId));
    return row ? deserializeDeletionTombstone(row) : undefined;
  }

  /**
   * Permanent delete is different from normal command completion: its own
   * command row must disappear with the Task, yet retrying the same command
   * after an ambiguous IPC response must not repeat filesystem cleanup.  A
   * minimal tombstone retains only the command id, Task id and final result.
   */
  function finalizePreparedTaskDeletion({ commandId, finalResult = {} }) {
    return transaction(() => {
      const tombstone = deletionTombstoneByCommandId(commandId);
      if (tombstone) return { replayed: true, result: tombstone.result };
      const command = required(commandById(commandId), "loop_command_not_found");
      if (command.status !== "prepared") throw new Error("loop_command_not_prepared");
      // `task.delete` is an in-flight intent from the prior direct-delete
      // implementation.  It can only be finalized during startup recovery;
      // no new UI path creates it.  Keeping that narrow migration avoids
      // orphaning a durable pre-change deletion command.
      if (!["task.permanently_delete", "task.delete"].includes(command.kind)) {
        throw new Error("loop_command_kind_invalid");
      }
      const task = required(rawTaskById(command.taskId), "loop_task_not_found");
      const deleted = deleteTaskData({
        taskId: task.taskId,
        runIds: command.result?.runIds ?? [],
        deleteCommands: true,
      });
      // Do not copy the prepared command payload/result into the tombstone:
      // it may contain the Task cwd, run ids, or artifact registry. The
      // tombstone exists solely to make an ambiguous permanent-delete retry
      // idempotent after all Task-owned records are gone.
      const result = {
        taskId: deleted.taskId,
        runsDeleted: deleted.runsDeleted,
        deleted: true,
        runtimeDirectoryRemoved: Boolean(finalResult?.runtimeDirectoryRemoved),
        managedArtifactsDeleted: Array.isArray(finalResult?.managedArtifactsDeleted)
          ? finalResult.managedArtifactsDeleted.map(String)
          : [],
        managedArtifactsSkipped: Array.isArray(finalResult?.managedArtifactsSkipped)
          ? finalResult.managedArtifactsSkipped
          : [],
      };
      db.prepare(
        `INSERT INTO agent_loop_deleted_task_tombstones (command_id, task_id, result_json, deleted_at)
         VALUES (?, ?, ?, ?)`,
      ).run(command.commandId, command.taskId, JSON.stringify(result), now());
      return { replayed: false, result };
    });
  }

  function insertTask(input) {
    const timestamp = input.createdAt || now();
    db.prepare(
      `INSERT INTO agent_loop_tasks
       (task_id, project_id, cwd, title, goal, template_id, template_version, architecture_json, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.taskId,
      input.projectId,
      input.cwd,
      input.title,
      input.goal,
      input.templateId,
      input.templateVersion,
      JSON.stringify(input.architecture),
      input.status,
      Number(input.revision ?? 1),
      timestamp,
      timestamp,
    );
    return taskById(input.taskId);
  }

  function insertRun(input) {
    const timestamp = input.createdAt || now();
    db.prepare(
      `INSERT INTO agent_loop_runs
       (run_id, task_id, status, conductor_session_id, session_scope, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.taskId,
      input.status,
      input.conductorSessionId,
      input.sessionScope || "",
      Number(input.revision ?? 1),
      timestamp,
      timestamp,
    );
    return runById(input.runId);
  }

  function updateTaskStatus({ taskId, status, expectedRevision, updatedAt = now() }) {
    const task = required(taskById(taskId), "loop_task_not_found");
    assertExpectedRevision(task.revision, expectedRevision);
    const updated = db.prepare(
      "UPDATE agent_loop_tasks SET status = ?, revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?",
    ).run(String(status), updatedAt, task.taskId, task.revision);
    if (!updated.changes) throw new Error("loop_task_revision_conflict");
    return taskById(task.taskId);
  }

  function updateRunStatus({ runId, status, expectedRevision, updatedAt = now() }) {
    const run = required(runById(runId), "loop_run_not_found");
    assertExpectedRevision(run.revision, expectedRevision);
    const updated = db.prepare(
      "UPDATE agent_loop_runs SET status = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?",
    ).run(String(status), updatedAt, run.runId, run.revision);
    if (!updated.changes) throw new Error("loop_run_revision_conflict");
    return runById(run.runId);
  }

  function touchTask({ taskId, expectedRevision, updatedAt = now() }) {
    const task = required(taskById(taskId), "loop_task_not_found");
    assertExpectedRevision(task.revision, expectedRevision);
    const updated = db.prepare(
      "UPDATE agent_loop_tasks SET revision = revision + 1, updated_at = ? WHERE task_id = ? AND revision = ?",
    ).run(updatedAt, task.taskId, task.revision);
    if (!updated.changes) throw new Error("loop_task_revision_conflict");
    return taskById(task.taskId);
  }

  function insertUserMessage({ messageId, taskId, runId, message, status = "pending", createdAt = now(), deliveredAt }) {
    db.prepare(
      `INSERT INTO agent_loop_user_messages
       (message_id, task_id, run_id, message, status, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(messageId, taskId, runId || null, message, status, createdAt, deliveredAt || null);
    return userMessageById(messageId);
  }

  function resetUserMessage(messageId) {
    db.prepare(
      "UPDATE agent_loop_user_messages SET status = 'pending', delivered_at = NULL WHERE message_id = ?",
    ).run(messageId);
    return userMessageById(messageId);
  }

  function userMessageById(messageId) {
    const row = db.prepare("SELECT * FROM agent_loop_user_messages WHERE message_id = ?").get(messageId);
    return row ? deserializeUserMessage(row) : undefined;
  }

  function appendRunEvent({ runId, type, summary, data, createdAt = now() }) {
    const sequence = Number(db.prepare("SELECT MAX(sequence) AS sequence FROM agent_loop_events WHERE run_id = ?").get(runId)?.sequence ?? 0) + 1;
    db.prepare(
      "INSERT INTO agent_loop_events (run_id, sequence, type, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(runId, sequence, type, summary, JSON.stringify(data ?? {}), createdAt);
    return { runId, sequence, type, summary, data: data ?? {}, createdAt };
  }

  function listRunEvents(runId) {
    return db.prepare("SELECT * FROM agent_loop_events WHERE run_id = ? ORDER BY sequence ASC").all(runId).map((row) => ({
      runId: row.run_id,
      sequence: Number(row.sequence),
      type: row.type,
      summary: row.summary,
      data: JSON.parse(row.data_json),
      createdAt: row.created_at,
    }));
  }

  function enqueueTaskEvent({ outboxId = `outbox-${randomUUID()}`, taskId, runId, sessionId, cwd, type, summary, data, createdAt = now() }) {
    db.prepare(
      `INSERT INTO agent_loop_task_event_outbox
       (outbox_id, task_id, run_id, session_id, cwd, type, summary, data_json, status, attempts, created_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL)
       ON CONFLICT(outbox_id) DO NOTHING`,
    ).run(outboxId, taskId, runId || null, sessionId || null, cwd, type, summary, JSON.stringify(data ?? {}), createdAt);
    return outboxById(outboxId);
  }

  function outboxById(outboxId) {
    const row = db.prepare("SELECT * FROM agent_loop_task_event_outbox WHERE outbox_id = ?").get(outboxId);
    return row ? deserializeOutbox(row) : undefined;
  }

  function listPendingTaskEvents() {
    return db.prepare(
      "SELECT * FROM agent_loop_task_event_outbox WHERE status = 'pending' ORDER BY created_at ASC, outbox_id ASC",
    ).all().map(deserializeOutbox);
  }

  function markTaskEventPublished(outboxId, publishedAt = now()) {
    db.prepare(
      "UPDATE agent_loop_task_event_outbox SET status = 'published', attempts = attempts + 1, published_at = ? WHERE outbox_id = ?",
    ).run(publishedAt, outboxId);
    return outboxById(outboxId);
  }

  function markTaskEventAttempted(outboxId) {
    db.prepare("UPDATE agent_loop_task_event_outbox SET attempts = attempts + 1 WHERE outbox_id = ?").run(outboxId);
  }

  function flushTaskEventOutbox(publish) {
    if (typeof publish !== "function") throw new Error("Task event outbox requires a publisher.");
    const published = [];
    for (const event of listPendingTaskEvents()) {
      try {
        const result = publish({
          eventId: event.outboxId,
          taskId: event.taskId,
          runId: event.runId,
          sessionId: event.sessionId,
          cwd: event.cwd,
          type: event.type,
          summary: event.summary,
          data: event.data,
        });
        markTaskEventPublished(event.outboxId);
        published.push({ outbox: event, event: result });
      } catch (error) {
        markTaskEventAttempted(event.outboxId);
        throw error;
      }
    }
    return published;
  }

  function commitCommand({ commandId, taskId, kind, payload = {}, expectedRevision, mutate }) {
    const normalized = normalizeCommand({ commandId, taskId, kind, payload });
    return transaction(() => {
      const existing = commandById(normalized.commandId);
      if (existing) {
        assertSameCommand(existing, normalized);
        if (existing.status === "committed") return { replayed: true, result: existing.result };
        throw new Error("loop_command_in_progress");
      }
      const task = required(taskById(normalized.taskId), "loop_task_not_found");
      assertExpectedRevision(task.revision, expectedRevision);
      const timestamp = now();
      db.prepare(
        `INSERT INTO agent_loop_commands
         (command_id, task_id, kind, payload_json, status, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      ).run(normalized.commandId, normalized.taskId, normalized.kind, normalized.payloadJson, timestamp, timestamp);
      const result = mutate({
        appendRunEvent,
        deleteTaskData,
        enqueueTaskEvent,
        insertRun,
        insertUserMessage,
        latestRun,
        runById,
        task,
        taskById,
        touchTask,
        resetUserMessage,
        updateRunStatus,
        updateTaskStatus,
      });
      db.prepare(
        "UPDATE agent_loop_commands SET status = 'committed', result_json = ?, updated_at = ? WHERE command_id = ?",
      ).run(JSON.stringify(result ?? null), now(), normalized.commandId);
      return { replayed: false, result };
    });
  }

  function prepareCommand({ commandId, taskId, kind, payload = {}, expectedRevision, mutate }) {
    const normalized = normalizeCommand({ commandId, taskId, kind, payload });
    return transaction(() => {
      const existing = commandById(normalized.commandId);
      if (existing) {
        assertSameCommand(existing, normalized);
        return { replayed: true, status: existing.status, result: existing.result };
      }
      const task = required(taskById(normalized.taskId), "loop_task_not_found");
      assertExpectedRevision(task.revision, expectedRevision);
      const timestamp = now();
      db.prepare(
        `INSERT INTO agent_loop_commands
         (command_id, task_id, kind, payload_json, status, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      ).run(normalized.commandId, normalized.taskId, normalized.kind, normalized.payloadJson, timestamp, timestamp);
      const result = mutate({
        appendRunEvent,
        enqueueTaskEvent,
        insertRun,
        insertUserMessage,
        latestRun,
        runById,
        task,
        taskById,
        touchTask,
        resetUserMessage,
        updateRunStatus,
        updateTaskStatus,
      });
      db.prepare(
        "UPDATE agent_loop_commands SET status = 'prepared', result_json = ?, updated_at = ? WHERE command_id = ?",
      ).run(JSON.stringify(result ?? null), now(), normalized.commandId);
      return { replayed: false, status: "prepared", result };
    });
  }

  function completePreparedCommand({ commandId, mutate = () => undefined }) {
    return transaction(() => {
      const command = required(commandById(commandId), "loop_command_not_found");
      if (command.status === "committed") return { replayed: true, status: command.status, result: command.result };
      if (command.status !== "prepared") throw new Error("loop_command_not_prepared");
      const completion = mutate({
        appendRunEvent,
        command,
        deleteTaskData,
        enqueueTaskEvent,
        latestRun,
        runById,
        taskById,
        touchTask,
        updateRunStatus,
        updateTaskStatus,
      });
      const result = completion === undefined ? command.result : completion;
      db.prepare(
        "UPDATE agent_loop_commands SET status = 'committed', result_json = ?, updated_at = ? WHERE command_id = ?",
      ).run(JSON.stringify(result ?? null), now(), command.commandId);
      return { replayed: false, status: "committed", result };
    });
  }

  function failPreparedCommand({ commandId, error, mutate = () => undefined }) {
    return transaction(() => {
      const command = required(commandById(commandId), "loop_command_not_found");
      if (command.status === "failed") return { replayed: true, status: command.status, result: command.result };
      if (command.status !== "prepared") throw new Error("loop_command_not_prepared");
      const compensation = mutate({
        appendRunEvent,
        command,
        deleteTaskData,
        enqueueTaskEvent,
        latestRun,
        runById,
        taskById,
        touchTask,
        updateRunStatus,
        updateTaskStatus,
      });
      const result = {
        ...(command.result && typeof command.result === "object" ? command.result : {}),
        ...(compensation && typeof compensation === "object" ? compensation : {}),
        error: String(error || "command_failed"),
      };
      db.prepare(
        "UPDATE agent_loop_commands SET status = 'failed', result_json = ?, updated_at = ? WHERE command_id = ?",
      ).run(JSON.stringify(result), now(), command.commandId);
      return { replayed: false, status: "failed", result };
    });
  }

  function commandById(commandId) {
    const row = db.prepare("SELECT * FROM agent_loop_commands WHERE command_id = ?").get(String(commandId));
    return row ? deserializeCommand(row) : undefined;
  }

  function findPreparedCommand({ taskId, kind }) {
    const row = db.prepare(
      `SELECT * FROM agent_loop_commands
       WHERE task_id = ? AND kind = ? AND status = 'prepared'
       ORDER BY updated_at DESC LIMIT 1`,
    ).get(String(taskId), String(kind));
    return row ? deserializeCommand(row) : undefined;
  }

  function listPreparedCommands({ kinds } = {}) {
    const normalizedKinds = Array.isArray(kinds)
      ? [...new Set(kinds.map(String).map((kind) => kind.trim()).filter(Boolean))]
      : [];
    if (!normalizedKinds.length) {
      return db.prepare(
        "SELECT * FROM agent_loop_commands WHERE status = 'prepared' ORDER BY created_at ASC, command_id ASC",
      ).all().map(deserializeCommand);
    }
    const placeholders = normalizedKinds.map(() => "?").join(", ");
    return db.prepare(
      `SELECT * FROM agent_loop_commands
       WHERE status = 'prepared' AND kind IN (${placeholders})
       ORDER BY created_at ASC, command_id ASC`,
    ).all(...normalizedKinds).map(deserializeCommand);
  }

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function tableExists(tableName) {
    return Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(String(tableName)));
  }

  return {
    appendRunEvent,
    commandById,
    commitCommand,
    completePreparedCommand,
    deletionTombstoneByCommandId,
    deleteTaskData,
    enqueueTaskEvent,
    flushTaskEventOutbox,
    failPreparedCommand,
    findPreparedCommand,
    finalizePreparedTaskDeletion,
    insertRun,
    insertUserMessage,
    insertTask,
    latestRun,
    listPreparedCommands,
    listManagedArtifacts,
    listPendingTaskEvents,
    listRunEvents,
    listRuns,
    listTasks,
    markTaskEventPublished,
    prepareCommand,
    registerManagedArtifact,
    resetUserMessage,
    runById,
    taskById,
    touchTask,
    transaction,
    updateRunStatus,
    updateTaskStatus,
    userMessageById,
  };
}

function migrateTaskRunRepository(db) {
  ensureColumn(db, "agent_loop_tasks", "revision", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "agent_loop_runs", "revision", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_loop_commands (
      command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_task_event_outbox (
      outbox_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, session_id TEXT, cwd TEXT NOT NULL,
      type TEXT NOT NULL, summary TEXT NOT NULL, data_json TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, published_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_managed_artifacts (
      task_id TEXT NOT NULL, artifact_path TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, artifact_path)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_loop_deleted_task_tombstones (
      command_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, result_json TEXT NOT NULL, deleted_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_loop_commands_task_status_idx
      ON agent_loop_commands (task_id, kind, status, updated_at);
    CREATE INDEX IF NOT EXISTS agent_loop_task_event_outbox_status_idx
      ON agent_loop_task_event_outbox (status, created_at);
    CREATE INDEX IF NOT EXISTS agent_loop_managed_artifacts_task_idx
      ON agent_loop_managed_artifacts (task_id, artifact_path);
  `);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => String(item.name) === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function normalizeCommand({ commandId, taskId, kind, payload }) {
  const id = requiredString(commandId, "commandId");
  const normalizedTaskId = requiredString(taskId, "taskId");
  const normalizedKind = requiredString(kind, "command.kind");
  const payloadJson = JSON.stringify(payload ?? {});
  return { commandId: id, taskId: normalizedTaskId, kind: normalizedKind, payloadJson };
}

function assertSameCommand(existing, command) {
  if (
    existing.taskId !== command.taskId
    || existing.kind !== command.kind
    || existing.payloadJson !== command.payloadJson
  ) throw new Error("loop_command_id_conflict");
}

function assertExpectedRevision(actual, expected) {
  if (expected === undefined || expected === null) return;
  if (!Number.isSafeInteger(Number(expected)) || Number(expected) !== Number(actual)) {
    throw new Error("loop_task_revision_conflict");
  }
}

function deserializeCommand(row) {
  return {
    commandId: row.command_id,
    taskId: row.task_id,
    kind: row.kind,
    payloadJson: row.payload_json,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    result: row.result_json === null ? undefined : JSON.parse(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeOutbox(row) {
  return {
    outboxId: row.outbox_id,
    taskId: row.task_id,
    runId: row.run_id || undefined,
    sessionId: row.session_id || undefined,
    cwd: row.cwd,
    type: row.type,
    summary: row.summary,
    data: JSON.parse(row.data_json),
    status: row.status,
    attempts: Number(row.attempts),
    createdAt: row.created_at,
    publishedAt: row.published_at || undefined,
  };
}

function deserializeUserMessage(row) {
  return {
    messageId: row.message_id,
    taskId: row.task_id,
    runId: row.run_id || undefined,
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at || undefined,
  };
}

function deserializeManagedArtifact(row) {
  return {
    taskId: row.task_id,
    path: row.artifact_path,
    source: row.source,
    createdAt: row.created_at,
  };
}

function deserializeDeletionTombstone(row) {
  return {
    commandId: row.command_id,
    taskId: row.task_id,
    result: JSON.parse(row.result_json),
    deletedAt: row.deleted_at,
  };
}

function required(value, errorCode) {
  if (value === undefined || value === null) throw new Error(errorCode);
  return value;
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Task/Run Repository requires ${field}.`);
  return result;
}

module.exports = { createTaskRunRepository, migrateTaskRunRepository };
