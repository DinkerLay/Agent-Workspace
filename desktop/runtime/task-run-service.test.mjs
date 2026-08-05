import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTaskRunRepository } from "./task-run-repository.cjs";
import { createTaskRunService } from "./task-run-service.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

function fixture() {
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
    CREATE TABLE agent_loop_workbench_layouts (run_id TEXT PRIMARY KEY, layout_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE agent_loop_user_messages (
      message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT, message TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT
    ) STRICT;
  `);
  let tick = 0;
  const now = () => `2026-08-02T00:00:0${tick++}.000Z`;
  const repository = createTaskRunRepository({
    db,
    now,
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
    goal: "Exercise lifecycle service.",
    templateId: "loop",
    templateVersion: 1,
    architecture: { primaryMode: "agent_loop" },
    status: "queued",
  });
  return { db, repository, service: createTaskRunService({ repository, now, randomUUID }) };
}

describe("Task/Run Service", () => {
  it("keeps a start prepared until the native side effect is confirmed", () => {
    const { db, repository, service } = fixture();
    const prepared = service.prepareStart({
      taskId: "task-1",
      commandId: "command-start-1",
      expectedRevision: 1,
      run: { runId: "run-1", conductorSessionId: "session-1", sessionScope: "" },
    });
    assert.equal(prepared.status, "prepared");
    assert.equal(repository.taskById("task-1").status, "running");
    assert.equal(repository.commandById("command-start-1").status, "prepared");

    service.completeStart({
      commandId: "command-start-1",
      task: repository.taskById("task-1"),
      run: repository.runById("run-1"),
    });
    assert.equal(repository.commandById("command-start-1").status, "committed");
    assert.deepEqual(repository.listRunEvents("run-1").map((event) => event.type), ["conductor.started"]);
    assert.deepEqual(repository.listPendingTaskEvents().map((event) => event.type), ["task.run.started"]);
    db.close();
  });

  it("requires delivery_ready and commits Task, Run, event and outbox as one achievement", () => {
    const { db, repository, service } = fixture();
    service.prepareStart({
      taskId: "task-1",
      commandId: "command-start-1",
      expectedRevision: 1,
      run: { runId: "run-1", conductorSessionId: "session-1", sessionScope: "" },
    });
    service.completeStart({ commandId: "command-start-1", task: repository.taskById("task-1"), run: repository.runById("run-1") });
    assert.throws(
      () => service.achieve({ taskId: "task-1", commandId: "command-achieve-too-early", expectedRevision: 2 }),
      /loop_task_not_achievable/,
    );
    service.claimDelivery({
      taskId: "task-1",
      sessionId: "session-1",
      message: "The requested artifact is ready for inspection.",
    });
    const ready = repository.taskById("task-1");
    assert.deepEqual(
      repository.listPendingTaskEvents()
        .filter((event) => event.type === "task.completion_claim")
        .map((event) => ({ sessionId: event.sessionId, data: event.data })),
      [{
        sessionId: "session-1",
        data: { message: "The requested artifact is ready for inspection.", source: "conductor" },
      }],
    );
    service.achieve({ taskId: "task-1", commandId: "command-achieve-1", expectedRevision: ready.revision });
    assert.equal(repository.taskById("task-1").status, "achieved");
    assert.equal(repository.runById("run-1").status, "achieved");
    assert.ok(repository.listRunEvents("run-1").some((event) => event.type === "task.achieved"));
    assert.ok(repository.listPendingTaskEvents().some((event) => event.type === "task.achieved"));
    db.close();
  });

  it("moves an achieved Task through recycle, restore, and a guarded permanent-delete preparation", () => {
    const { db, repository, service } = fixture();
    service.prepareStart({
      taskId: "task-1",
      commandId: "command-start-recycle",
      expectedRevision: 1,
      run: { runId: "run-recycle", conductorSessionId: "session-recycle", sessionScope: "" },
    });
    service.completeStart({
      commandId: "command-start-recycle",
      task: repository.taskById("task-1"),
      run: repository.runById("run-recycle"),
    });
    service.claimDelivery({ taskId: "task-1", sessionId: "session-recycle", message: "Delivery ready." });
    service.achieve({
      taskId: "task-1",
      commandId: "command-achieve-recycle",
      expectedRevision: repository.taskById("task-1").revision,
    });

    const achieved = repository.taskById("task-1");
    const recycled = service.moveToRecycleBin({
      taskId: "task-1",
      commandId: "command-recycle",
      expectedRevision: achieved.revision,
    });
    assert.equal(repository.taskById("task-1").status, "archived");
    assert.equal(repository.runById("run-recycle").status, "achieved", "recycle keeps the original Run");
    assert.equal(recycled.runId, "run-recycle");
    assert.equal(service.moveToRecycleBin({
      taskId: "task-1",
      commandId: "command-recycle",
      expectedRevision: achieved.revision,
    }).taskRevision, recycled.taskRevision, "the same recycle command is safe to retry");

    const restored = service.restoreFromRecycleBin({
      taskId: "task-1",
      commandId: "command-restore",
      expectedRevision: repository.taskById("task-1").revision,
    });
    assert.equal(repository.taskById("task-1").status, "achieved");
    assert.equal(restored.runId, "run-recycle");
    assert.equal(repository.listRuns("task-1").length, 1, "restore does not create a replacement Run");

    assert.throws(
      () => service.preparePermanentDelete({
        taskId: "task-1",
        commandId: "command-delete-from-history",
        expectedRevision: repository.taskById("task-1").revision,
      }),
      /loop_task_not_in_recycle_bin/,
    );

    service.moveToRecycleBin({
      taskId: "task-1",
      commandId: "command-recycle-again",
      expectedRevision: repository.taskById("task-1").revision,
    });
    repository.registerManagedArtifact({ taskId: "task-1", artifactPath: "reports/delivery.md" });
    assert.throws(
      () => service.preparePermanentDelete({
        taskId: "task-1",
        commandId: "command-delete-unknown-artifact",
        expectedRevision: repository.taskById("task-1").revision,
        artifactPaths: ["keep-me.md"],
      }),
      /loop_managed_artifact_not_registered/,
    );
    assert.equal(repository.taskById("task-1").status, "archived", "invalid selection must not start deletion");

    const prepared = service.preparePermanentDelete({
      taskId: "task-1",
      commandId: "command-delete-recycle",
      expectedRevision: repository.taskById("task-1").revision,
      artifactPaths: ["reports/delivery.md"],
      artifactSnapshots: [{
        path: "reports/delivery.md",
        state: "present",
        kind: "file",
        dev: 1,
        ino: 2,
        size: 3,
        mtimeMs: 4,
        ctimeMs: 5,
      }],
    });
    assert.equal(prepared.status, "prepared");
    assert.deepEqual(prepared.result.artifactPaths, ["reports/delivery.md"]);
    assert.equal(repository.taskById("task-1").status, "deleting");
    const preparedCommand = repository.commandById("command-delete-recycle");
    assert.equal(preparedCommand.status, "prepared");
    assert.deepEqual(preparedCommand.payload, {
      artifactPaths: ["reports/delivery.md"],
      artifactSnapshots: [{
        path: "reports/delivery.md",
        state: "present",
        kind: "file",
        dev: 1,
        ino: 2,
        size: 3,
        mtimeMs: 4,
        ctimeMs: 5,
      }],
    });
    db.close();
  });
});
