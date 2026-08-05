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

    const v1 = store.saveTemplate(input);
    const v2 = store.saveTemplate({ ...input, name: "Research Loop v2" });
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(store.listTemplates()[0].name, "Research Loop v2");
    assert.deepEqual(
      store.listTemplateVersions({ templateId: input.id }).map((template) => ({ version: template.version, name: template.name })),
      [
        { version: 2, name: "Research Loop v2" },
        { version: 1, name: "Research Loop" },
      ],
      "history reads the immutable Versions in newest-first order",
    );
    assert.equal(store.templateById(input.id, 1).name, "Research Loop", "an exact historical Version remains readable after a later save");

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
    assert.equal(store.listTemplateVersions({ templateId: input.id })[1].archivedAt, "2026-08-02T00:00:00.000Z", "archive state is projected without mutating Version bodies");
    db.close();
  });

  it("persists the explicit Conductor and Worker card contracts without rewriting legacy cards", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_loop_template_versions (
        template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
        conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
      ) STRICT;
      CREATE TABLE agent_loop_tasks (
        task_id TEXT PRIMARY KEY, template_id TEXT NOT NULL
      ) STRICT;
    `);
    const store = createLoopTemplateStore({
      db,
      defaultModel: "test/model",
      now: () => "2026-08-04T00:00:00.000Z",
      randomUUID,
    });
    const legacy = store.saveTemplate({
      id: "contract-loop",
      name: "Contract loop",
      source: "manual",
      conductor: { role: "Conductor", model: "test/model", charter: "Choose a bounded dispatch." },
      agents: [{
        id: "legacy-researcher",
        name: "Legacy Researcher",
        kind: "researcher",
        role: "Find evidence.",
        model: "test/model",
        mcp: [],
        skills: [],
        instructions: "Cite dates.",
        expectedOutput: "Evidence memo.",
      }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "" },
    });
    const legacyJson = db.prepare("SELECT agents_json FROM agent_loop_template_versions WHERE template_id = ? AND version = ?").get(legacy.id, legacy.version).agents_json;

    const loadedLegacy = store.templateById(legacy.id, legacy.version);
    assert.equal(loadedLegacy.agents[0].instructions, "Cite dates.");
    assert.equal(Object.hasOwn(loadedLegacy.agents[0], "dispatchProfile"), false);
    assert.equal(
      db.prepare("SELECT agents_json FROM agent_loop_template_versions WHERE template_id = ? AND version = ?").get(legacy.id, legacy.version).agents_json,
      legacyJson,
      "loading a legacy version must not rewrite its stored card JSON",
    );

    const split = store.saveTemplate({
      ...legacy,
      agents: [{
        id: "researcher",
        name: "Researcher",
        kind: "researcher",
        model: "test/model",
        mcp: ["websearch"],
        skills: ["research"],
        dispatchProfile: {
          title: "Primary-source research",
          description: "Use this Card when the Conductor needs independently verifiable evidence.",
        },
        workerSystemPrompt: "Collect primary sources, record dates, and distinguish facts from inferences.",
      }],
    });

    assert.equal(split.version, 2);
    assert.deepEqual(split.agents[0].dispatchProfile, {
      title: "Primary-source research",
      description: "Use this Card when the Conductor needs independently verifiable evidence.",
    });
    assert.equal(split.agents[0].workerSystemPrompt, "Collect primary sources, record dates, and distinguish facts from inferences.");
    assert.equal(Object.hasOwn(split.agents[0], "instructions"), false);
    assert.equal(
      db.prepare("SELECT agents_json FROM agent_loop_template_versions WHERE template_id = ? AND version = ?").get(legacy.id, legacy.version).agents_json,
      legacyJson,
      "a later Version must not alter the previous legacy Version",
    );

    assert.throws(
      () => store.saveTemplate({ ...legacy, agents: [{ ...split.agents[0], workerSystemPrompt: undefined }] }),
      /loop_template_agent_card_prompt_contract_incomplete/,
    );
    db.close();
  });

  it("persists only explicitly selected Provider model variants on Conductor and Card contracts", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_loop_template_versions (
        template_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL,
        conductor_json TEXT NOT NULL, agents_json TEXT NOT NULL, limits_json TEXT NOT NULL, delivery_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (template_id, version)
      ) STRICT;
      CREATE TABLE agent_loop_tasks (task_id TEXT PRIMARY KEY, template_id TEXT NOT NULL) STRICT;
    `);
    const store = createLoopTemplateStore({
      db,
      defaultModel: "opencode-go/gpt-5.6-luna",
      now: () => "2026-08-05T00:00:00.000Z",
      randomUUID,
    });

    const saved = store.saveTemplate({
      id: "variant-loop",
      name: "Variant Loop",
      source: "manual",
      conductor: {
        role: "Conductor",
        model: "opencode-go/gpt-5.6-luna",
        modelVariant: "max",
        charter: "Choose the next bounded dispatch.",
      },
      agents: [{
        id: "researcher",
        name: "Researcher",
        kind: "researcher",
        model: "opencode-go/gpt-5.6-luna",
        modelVariant: "high",
        mcp: [],
        skills: [],
        dispatchProfile: { title: "Research", description: "Use for bounded evidence research." },
        workerSystemPrompt: "Collect primary evidence.",
      }],
      limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
      delivery: { artifactPath: "" },
    });

    assert.equal(saved.conductor.modelVariant, "max");
    assert.equal(saved.agents[0].modelVariant, "high");
    const stored = db.prepare("SELECT conductor_json, agents_json FROM agent_loop_template_versions WHERE template_id = ?").get(saved.id);
    assert.equal(JSON.parse(stored.conductor_json).modelVariant, "max");
    assert.equal(JSON.parse(stored.agents_json)[0].modelVariant, "high");

    const withoutVariant = store.saveTemplate({
      ...saved,
      conductor: { ...saved.conductor, modelVariant: "" },
      agents: [{ ...saved.agents[0], modelVariant: undefined }],
    });
    assert.equal(Object.hasOwn(withoutVariant.conductor, "modelVariant"), false);
    assert.equal(Object.hasOwn(withoutVariant.agents[0], "modelVariant"), false);
    db.close();
  });
});
