import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createLoopTemplateStore } from "./loop-template-store.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Loop Template Store", () => {
  it("owns versioned Template CRUD and protects Task references", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_loop_template_versions (
        template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
        conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
        archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
      ) STRICT;
      CREATE TABLE agent_loop_tasks (
        task_id TEXT PRIMARY KEY, template_id TEXT NOT NULL
      ) STRICT;
    `);
    const store = createLoopTemplateStore({
      db,
      defaultModel: "test/model",
      now: () => "2026-08-02T00:00:00.000Z",
      randomUUID,
    });
    const input = {
      id: "research-loop",
      name: "Research Loop",
      source: "manual",
      conductor: { role: "Conductor", model: "test/model", charter: "Choose the next bounded dispatch." },
      agents: [{ id: "researcher", name: "Researcher", role: "Find evidence." }],
      limits: { maxConcurrentSessions: 2, maxDispatchesPerDecision: 2 },
      delivery: { artifactPath: "" },
    };

    assert.equal(store.saveTemplate(input).version, 1);
    assert.equal(store.saveTemplate({ ...input, name: "Research Loop v2" }).version, 2);
    assert.equal(store.listTemplates()[0].name, "Research Loop v2");

    db.prepare("INSERT INTO agent_loop_tasks (task_id, template_id) VALUES (?, ?)").run("task-1", input.id);
    assert.throws(() => store.deleteTemplate({ templateId: input.id }), /loop_template_is_referenced_by_task/);
    assert.equal(store.archiveTemplate({ templateId: input.id }).archivedAt, "2026-08-02T00:00:00.000Z");
    assert.equal(
      db.prepare("PRAGMA table_info(agent_loop_template_versions)").all().some((column) => column.name === "archived_at"),
      false,
      "archive metadata belongs to Template identity, not immutable version rows",
    );
    assert.equal(
      db.prepare("SELECT archived_at FROM agent_loop_templates WHERE template_id = ?").get(input.id).archived_at,
      "2026-08-02T00:00:00.000Z",
    );
    assert.deepEqual(store.listTemplates(), []);
    assert.equal(store.listTemplates({ includeArchived: true })[0].version, 2);
    db.close();
  });
});
