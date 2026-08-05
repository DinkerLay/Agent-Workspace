import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTaskRunRepository } from "./task-run-repository.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

function createRepository() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agent_loop_tasks (
      task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      template_id TEXT NOT NULL, template_version INTEGER NOT NULL, architecture_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_loop_runs (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, conductor_session_id TEXT NOT NULL,
      session_scope TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_loop_events (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, data_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (run_id, sequence)
    ) STRICT;
    CREATE TABLE agent_loop_workbench_layouts (
      run_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_loop_user_messages (
      message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, message TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT
    ) STRICT;
    CREATE TABLE agent_loop_opencode_host_bindings (
      run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL
    ) STRICT;
  `);
  let tick = 0;
  const repository = createTaskRunRepository({
    db,
    now: () => `2026-08-02T00:00:0${tick++}.000Z`,
    randomUUID,
    deserializeTask: (row) => ({
      taskId: row.task_id,
      projectId: row.project_id,
      cwd: row.cwd,
      title: row.title,
      goal: row.goal,
      architecture: JSON.parse(row.architecture_json),
      status: row.status,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    deserializeRun: (row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      status: row.status,
      conductorSessionId: row.conductor_session_id,
      sessionScope: row.session_scope,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  });
  repository.insertTask({
    taskId: "task-1",
    projectId: "project",
    cwd: "/workspace",
    title: "Task",
    goal: "Verify atomic state.",
    templateId: "loop",
    templateVersion: 1,
    architecture: { primaryMode: "agent_loop" },
    status: "queued",
  });
  return { db, repository };
}

describe("Task/Run Repository", () => {
  it("commits a command, lifecycle transition, Run event and Timeline outbox atomically", () => {
    const { db, repository } = createRepository();
    const committed = repository.commitCommand({
      commandId: "command-start-1",
      taskId: "task-1",
      kind: "task.start_run",
      payload: { runId: "run-1" },
      expectedRevision: 1,
      mutate({ task, updateTaskStatus, insertRun, appendRunEvent, enqueueTaskEvent }) {
        const updatedTask = updateTaskStatus({ taskId: task.taskId, status: "running" });
        const run = insertRun({
          runId: "run-1",
          taskId: task.taskId,
          status: "running",
          conductorSessionId: "session-1",
        });
        appendRunEvent({ runId: run.runId, type: "conductor.started", summary: "Started.", data: {} });
        enqueueTaskEvent({
          outboxId: "outbox-start-1",
          taskId: task.taskId,
          runId: run.runId,
          cwd: task.cwd,
          type: "task.run.started",
          summary: "Started.",
          data: { runId: run.runId },
        });
        return { taskId: updatedTask.taskId, runId: run.runId };
      },
    });

    assert.equal(committed.replayed, false);
    assert.equal(repository.taskById("task-1").status, "running");
    assert.equal(repository.taskById("task-1").revision, 2);
    assert.equal(repository.runById("run-1").revision, 1);
    assert.equal(repository.listRunEvents("run-1").length, 1);
    assert.equal(repository.listPendingTaskEvents().length, 1);
    assert.equal(repository.commandById("command-start-1").status, "committed");
    db.close();
  });

  it("replays an identical command without applying its mutation twice", () => {
    const { db, repository } = createRepository();
    let mutations = 0;
    const command = {
      commandId: "command-achieve-1",
      taskId: "task-1",
      kind: "task.achieve",
      payload: {},
      expectedRevision: 1,
      mutate({ task, updateTaskStatus }) {
        mutations += 1;
        return updateTaskStatus({ taskId: task.taskId, status: "achieved" });
      },
    };

    const first = repository.commitCommand(command);
    const replay = repository.commitCommand(command);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(mutations, 1);
    assert.equal(repository.taskById("task-1").revision, 2);
    assert.throws(
      () => repository.commitCommand({ ...command, payload: { different: true } }),
      /loop_command_id_conflict/,
    );
    db.close();
  });

  it("rolls back status, command and outbox together when a mutation fails", () => {
    const { db, repository } = createRepository();
    assert.throws(
      () => repository.commitCommand({
        commandId: "command-fail-1",
        taskId: "task-1",
        kind: "task.fail",
        payload: {},
        expectedRevision: 1,
        mutate({ task, updateTaskStatus, enqueueTaskEvent }) {
          updateTaskStatus({ taskId: task.taskId, status: "running" });
          enqueueTaskEvent({
            outboxId: "outbox-fail-1",
            taskId: task.taskId,
            cwd: task.cwd,
            type: "task.run.started",
            summary: "Must roll back.",
          });
          throw new Error("crash-point");
        },
      }),
      /crash-point/,
    );
    assert.equal(repository.taskById("task-1").status, "queued");
    assert.equal(repository.taskById("task-1").revision, 1);
    assert.equal(repository.commandById("command-fail-1"), undefined);
    assert.equal(repository.listPendingTaskEvents().length, 0);
    db.close();
  });

  it("rejects stale optimistic revisions before any mutation", () => {
    const { db, repository } = createRepository();
    assert.throws(
      () => repository.commitCommand({
        commandId: "command-stale-1",
        taskId: "task-1",
        kind: "task.achieve",
        expectedRevision: 0,
        mutate() {
          throw new Error("must-not-run");
        },
      }),
      /loop_task_revision_conflict/,
    );
    assert.equal(repository.commandById("command-stale-1"), undefined);
    db.close();
  });

  it("keeps a failed Timeline publish pending and safely retries it", () => {
    const { db, repository } = createRepository();
    repository.enqueueTaskEvent({
      outboxId: "outbox-retry-1",
      taskId: "task-1",
      cwd: "/workspace",
      type: "task.created",
      summary: "Created.",
    });
    assert.throws(() => repository.flushTaskEventOutbox(() => {
      throw new Error("filesystem-unavailable");
    }), /filesystem-unavailable/);
    assert.equal(repository.listPendingTaskEvents()[0].attempts, 1);

    const received = [];
    const result = repository.flushTaskEventOutbox((event) => {
      received.push(event);
      return { id: "event-1" };
    });
    assert.equal(result.length, 1);
    assert.equal(received[0].eventId, "outbox-retry-1");
    assert.equal(repository.listPendingTaskEvents().length, 0);
    db.close();
  });

  it("persists an asynchronous command intent before its side effect and completes it idempotently", () => {
    const { db, repository } = createRepository();
    const prepared = repository.prepareCommand({
      commandId: "command-stop-1",
      taskId: "task-1",
      kind: "task.stop",
      expectedRevision: 1,
      mutate({ task, updateTaskStatus }) {
        const stopping = updateTaskStatus({ taskId: task.taskId, status: "stopping" });
        return { taskId: task.taskId, preparedRevision: stopping.revision };
      },
    });
    const replay = repository.prepareCommand({
      commandId: "command-stop-1",
      taskId: "task-1",
      kind: "task.stop",
      expectedRevision: 1,
      mutate() {
        throw new Error("must-not-run");
      },
    });
    assert.equal(prepared.status, "prepared");
    assert.equal(replay.replayed, true);
    assert.equal(repository.taskById("task-1").status, "stopping");

    const completed = repository.completePreparedCommand({
      commandId: "command-stop-1",
      mutate({ command, updateTaskStatus, enqueueTaskEvent }) {
        const task = repository.taskById(command.taskId);
        const stopped = updateTaskStatus({ taskId: task.taskId, status: "stopped" });
        enqueueTaskEvent({
          outboxId: "outbox-stop-1",
          taskId: task.taskId,
          cwd: task.cwd,
          type: "task.stopped",
          summary: "Stopped.",
        });
        return { taskId: stopped.taskId, revision: stopped.revision };
      },
    });
    const completedReplay = repository.completePreparedCommand({ commandId: "command-stop-1" });
    assert.equal(completed.status, "committed");
    assert.equal(completedReplay.replayed, true);
    assert.equal(repository.taskById("task-1").status, "stopped");
    assert.equal(repository.listPendingTaskEvents().length, 1);
    db.close();
  });

  it("lists prepared lifecycle commands for startup reconciliation", () => {
    const { db, repository } = createRepository();
    repository.prepareCommand({
      commandId: "command-stop-recover",
      taskId: "task-1",
      kind: "task.stop",
      expectedRevision: 1,
      mutate({ task, updateTaskStatus }) {
        updateTaskStatus({ taskId: task.taskId, status: "stopping" });
        return { taskId: task.taskId };
      },
    });

    assert.deepStrictEqual(
      repository.listPreparedCommands({ kinds: ["task.start_run", "task.stop", "task.delete"] })
        .map(({ commandId, kind, status }) => ({ commandId, kind, status })),
      [{ commandId: "command-stop-recover", kind: "task.stop", status: "prepared" }],
    );
    assert.deepStrictEqual(repository.listPreparedCommands({ kinds: ["task.delete"] }), []);
    db.close();
  });

  it("permanently finalizes a prepared recycle-bin deletion without retaining Task-owned records", () => {
    const { db, repository } = createRepository();
    repository.insertRun({
      runId: "run-delete-1",
      taskId: "task-1",
      status: "achieved",
      conductorSessionId: "session-delete-1",
    });
    db.prepare("INSERT INTO agent_loop_workbench_layouts (run_id, layout_json, updated_at) VALUES (?, ?, ?)")
      .run("run-delete-1", "{}", "2026-08-02T00:00:00.000Z");
    repository.appendRunEvent({ runId: "run-delete-1", type: "task.achieved", summary: "Achieved.", data: {} });
    repository.insertUserMessage({
      messageId: "message-delete-1",
      taskId: "task-1",
      runId: "run-delete-1",
      message: "Keep this Task conversation only until permanent deletion.",
    });
    repository.enqueueTaskEvent({
      outboxId: "outbox-delete-1",
      taskId: "task-1",
      runId: "run-delete-1",
      cwd: "/workspace",
      type: "task.recycled",
      summary: "Recycled.",
    });
    db.prepare("INSERT INTO agent_loop_opencode_host_bindings (run_id, task_id) VALUES (?, ?)")
      .run("run-delete-1", "task-1");
    repository.registerManagedArtifact({ taskId: "task-1", artifactPath: "reports/delivery.md" });
    repository.prepareCommand({
      commandId: "command-delete-1",
      taskId: "task-1",
      kind: "task.permanently_delete",
      payload: { artifactPaths: ["reports/delivery.md"] },
      expectedRevision: 1,
      mutate({ task, updateTaskStatus }) {
        return {
          taskId: task.taskId,
          runIds: ["run-delete-1"],
          artifactPaths: ["reports/delivery.md"],
          taskRevision: updateTaskStatus({ taskId: task.taskId, status: "deleting" }).revision,
        };
      },
    });

    const finalized = repository.finalizePreparedTaskDeletion({
      commandId: "command-delete-1",
      finalResult: {
        runtimeDirectoryRemoved: true,
        managedArtifactsDeleted: ["reports/delivery.md"],
        managedArtifactsSkipped: [],
      },
    });
    assert.equal(finalized.replayed, false);
    assert.deepEqual(finalized.result, {
      taskId: "task-1",
      runsDeleted: 1,
      deleted: true,
      runtimeDirectoryRemoved: true,
      managedArtifactsDeleted: ["reports/delivery.md"],
      managedArtifactsSkipped: [],
    });
    assert.equal(repository.taskById("task-1"), undefined);
    assert.equal(repository.runById("run-delete-1"), undefined);
    assert.equal(repository.commandById("command-delete-1"), undefined, "the Task command is removed with its Task");
    assert.deepEqual(repository.listManagedArtifacts("task-1"), []);
    assert.deepEqual(repository.deletionTombstoneByCommandId("command-delete-1")?.result, finalized.result);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_workbench_layouts").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_events").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_user_messages").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_task_event_outbox").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_loop_opencode_host_bindings").get().count, 0);

    const replay = repository.finalizePreparedTaskDeletion({ commandId: "command-delete-1" });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, finalized.result, "the deletion tombstone makes an ambiguous retry idempotent");
    db.close();
  });
});
