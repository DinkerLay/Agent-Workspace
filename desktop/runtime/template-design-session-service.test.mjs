import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTemplateDesignSessionService } from "./template-design-session-service.cjs";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const testApi = isVitest ? await import("vitest") : await import("node:test");
const { describe, it } = testApi;

describe("Template Design Session Service", () => {
  it("indexes only active Draft metadata for one project root without exposing Draft JSON or capabilities", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    service.createOrGetDraft({
      draftId: "design-list-active",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });
    service.createOrGetDraft({
      draftId: "design-list-other-root",
      cwd: "/workspace/other",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });
    service.createOrGetDraft({
      draftId: "design-list-discarded",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });
    service.discardDraft({ draftId: "design-list-discarded", expectedRevision: 1 });

    const listed = service.listActiveDrafts({ cwd: "/workspace/research" });
    assert.equal(listed.length, 1);
    assert.deepEqual(Object.keys(listed[0]).sort(), [
      "baseTemplateVersion",
      "createdAt",
      "cwd",
      "draftId",
      "model",
      "name",
      "providerSessionId",
      "revision",
      "status",
      "templateId",
      "updatedAt",
    ].sort());
    assert.equal(listed[0].draftId, "design-list-active");
    assert.equal(Object.hasOwn(listed[0], "draftJson"), false);
    assert.equal(Object.hasOwn(listed[0], "capabilitySecret"), false);
    db.close();
  });

  it("persists an explicitly selected Template Meta Agent model variant without adding one to older Drafts", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    service.createOrGetDraft({
      draftId: "design-variant",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      modelVariant: "max",
      draftJson: templateDraftJson(),
    });
    service.createOrGetDraft({
      draftId: "design-no-variant",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });

    const selected = service.readDraft({ draftId: "design-variant" });
    const historical = service.readDraft({ draftId: "design-no-variant" });
    assert.equal(selected.modelVariant, "max");
    assert.equal(Object.hasOwn(historical, "modelVariant"), false);
    assert.equal(
      db.prepare("SELECT model_variant FROM agent_loop_template_design_drafts WHERE draft_id = ?").get("design-variant").model_variant,
      "max",
    );
    assert.equal(Object.hasOwn(service.listActiveDrafts({ cwd: "/workspace/research" }).find((draft) => draft.draftId === "design-no-variant"), "modelVariant"), false);
    db.close();
  });

  it("creates or reopens one durable non-Task Draft without touching Template Versions or Tasks", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE agent_loop_template_versions (
        template_id TEXT NOT NULL, version INTEGER NOT NULL, body_json TEXT NOT NULL,
        PRIMARY KEY (template_id, version)
      ) STRICT;
      CREATE TABLE agent_loop_tasks (
        task_id TEXT PRIMARY KEY, template_id TEXT NOT NULL, architecture_json TEXT NOT NULL
      ) STRICT;
    `);
    db.prepare("INSERT INTO agent_loop_template_versions (template_id, version, body_json) VALUES (?, ?, ?)")
      .run("deepsearch", 10, JSON.stringify({ immutable: true }));
    db.prepare("INSERT INTO agent_loop_tasks (task_id, template_id, architecture_json) VALUES (?, ?, ?)")
      .run("task-1", "deepsearch", JSON.stringify({ templateVersion: 10 }));
    const service = createService(db);

    const created = service.createOrGetDraft({
      draftId: "design-deepsearch-v10",
      templateId: "deepsearch",
      baseTemplateVersion: 10,
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });

    assert.equal(created.created, true);
    assert.equal(created.draft.status, "active");
    assert.equal(created.draft.revision, 1);
    assert.equal(created.draft.templateId, "deepsearch");
    assert.equal(created.draft.baseTemplateVersion, 10);
    assert.deepEqual(created.draft.draftJson, templateDraftJson());
    assert.equal("capabilitySecret" in created.draft, false, "normal Draft reads never expose the private capability");
    const capability = service.readDraftCapability({ draftId: "design-deepsearch-v10" });
    assert.equal(capability.draftId, "design-deepsearch-v10");
    assert.match(capability.capabilitySecret, /^[A-Za-z0-9_-]{32,128}$/);

    const reopened = service.createOrGetDraft({ draftId: "design-deepsearch-v10" });
    assert.equal(reopened.created, false);
    assert.deepEqual(reopened.draft, created.draft);
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT body_json FROM agent_loop_template_versions WHERE template_id = ? AND version = ?").get("deepsearch", 10).body_json),
      { immutable: true },
    );
    assert.deepEqual(
      JSON.parse(db.prepare("SELECT architecture_json FROM agent_loop_tasks WHERE task_id = ?").get("task-1").architecture_json),
      { templateVersion: 10 },
    );
    db.close();
  });

  it("keeps one active Draft through Version checkpoints and only replaces it after discard", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    const input = {
      templateId: "deepsearch",
      baseTemplateVersion: 10,
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    };

    const first = service.createOrGetActiveExistingTemplateDraft(input);
    const concurrentCompatibleOpen = service.createOrGetActiveExistingTemplateDraft(input);
    assert.equal(first.created, true);
    assert.equal(concurrentCompatibleOpen.created, false);
    assert.equal(concurrentCompatibleOpen.draft.draftId, first.draft.draftId);

    const saved = service.saveDraft({ draftId: first.draft.draftId, expectedRevision: first.draft.revision });
    const reopened = service.createOrGetActiveExistingTemplateDraft(input);
    const retry = service.createOrGetActiveExistingTemplateDraft(input);

    assert.equal(saved.draft.status, "active");
    assert.equal(reopened.created, false);
    assert.equal(reopened.draft.status, "active");
    assert.equal(reopened.draft.draftId, first.draft.draftId, "a Version checkpoint keeps the same editable Draft identity");
    assert.equal(reopened.draft.templateId, "deepsearch");
    assert.equal(reopened.draft.baseTemplateVersion, 10);
    assert.equal(retry.created, false);
    assert.equal(retry.draft.draftId, reopened.draft.draftId);
    assert.equal(service.listActiveDrafts({ cwd: "/workspace/research" }).length, 1);
    assert.equal(service.readDraft({ draftId: first.draft.draftId }).status, "active");

    const discarded = service.discardDraft({ draftId: reopened.draft.draftId, expectedRevision: reopened.draft.revision });
    const afterDiscard = service.createOrGetActiveExistingTemplateDraft(input);
    assert.equal(discarded.status, "discarded");
    assert.equal(afterDiscard.created, true);
    assert.notEqual(afterDiscard.draft.draftId, reopened.draft.draftId, "a discarded Draft is historical too");
    assert.equal(service.readDraft({ draftId: reopened.draft.draftId }).status, "discarded");
    assert.equal(service.listActiveDrafts({ cwd: "/workspace/research" }).length, 1);
    db.close();
  });

  it("applies constrained Draft JSON patches with revision checks and idempotent last-operation replay", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    const source = templateDraftJson();
    service.createOrGetDraft({
      draftId: "design-patch",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: source,
    });

    const first = service.applyStructuredPatch({
      draftId: "design-patch",
      capabilitySecret: capabilityFor(service, "design-patch"),
      expectedRevision: 1,
      operationId: "operation-worker-prompt-1",
      patch: [
        {
          op: "replace",
          path: "/agents/0/workerSystemPrompt",
          value: "Use primary sources and state uncertainty explicitly.",
        },
        {
          op: "replace",
          path: "/agents/0/dispatchProfile/description",
          value: "Use when independent, source-backed market evidence is required.",
        },
      ],
    });

    assert.equal(first.replayed, false);
    assert.equal(first.draft.revision, 2);
    assert.equal(first.draft.lastProcessedOperationId, "operation-worker-prompt-1");
    assert.equal(first.draft.draftJson.agents[0].workerSystemPrompt, "Use primary sources and state uncertainty explicitly.");
    assert.equal(source.agents[0].workerSystemPrompt, "Collect dated, primary-source evidence.", "caller JSON stays immutable");

    const replay = service.applyStructuredPatch({
      draftId: "design-patch",
      capabilitySecret: capabilityFor(service, "design-patch"),
      expectedRevision: 1,
      operationId: "operation-worker-prompt-1",
      patch: [{ op: "replace", path: "/agents/0/workerSystemPrompt", value: "ignored on replay" }],
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.draft.revision, 2, "the same operation id must not consume another revision");
    assert.equal(replay.draft.draftJson.agents[0].workerSystemPrompt, "Use primary sources and state uncertainty explicitly.");

    assert.throws(
      () => service.applyStructuredPatch({
        draftId: "design-patch",
        capabilitySecret: capabilityFor(service, "design-patch"),
        expectedRevision: 1,
        operationId: "operation-stale",
        patch: [{ op: "add", path: "/name", value: "Stale write" }],
      }),
      /template_design_draft_revision_conflict/,
    );

    const draftJsonOnly = service.applyStructuredPatch({
      draftId: "design-patch",
      capabilitySecret: capabilityFor(service, "design-patch"),
      expectedRevision: 2,
      operationId: "operation-json-status",
      patch: [{ op: "add", path: "/status", value: "saved" }],
    });
    assert.equal(draftJsonOnly.draft.status, "active", "a JSON patch cannot mutate service lifecycle state");
    assert.equal(draftJsonOnly.draft.draftJson.status, "saved");
    assert.equal(draftJsonOnly.draft.revision, 3);
    db.close();
  });

  it("rejects a malformed prompt-split Card atomically and defaults a valid Card model from its Draft", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    const emptyDraft = { ...templateDraftJson(), agents: [] };
    service.createOrGetDraft({
      draftId: "design-card-schema",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: emptyDraft,
    });
    const before = service.readDraft({ draftId: "design-card-schema" });
    const persistedBefore = db.prepare("SELECT draft_json FROM agent_loop_template_design_drafts WHERE draft_id = ?").get("design-card-schema").draft_json;
    assert.deepEqual(before.validation, { valid: true, issues: [] }, "a new Draft may intentionally start with no Cards");

    assert.throws(
      () => service.applyStructuredPatch({
        draftId: "design-card-schema",
        capabilitySecret: capabilityFor(service, "design-card-schema"),
        expectedRevision: before.revision,
        operationId: "operation-invalid-system-prompt",
        patch: [{
          op: "add",
          path: "/agents/-",
          value: {
            id: "researcher",
            name: "Researcher",
            kind: "researcher",
            mcp: [],
            skills: [],
            dispatchProfile: {
              title: "Evidence research",
              description: "Use for source-backed research.",
            },
            systemPrompt: "This alias must never be guessed as a Worker prompt.",
          },
        }],
      }),
      /loop_template_agent_card_prompt_contract_mixed/,
    );
    const rejected = service.readDraft({ draftId: "design-card-schema" });
    assert.equal(rejected.revision, before.revision, "a rejected Patch cannot consume a Draft revision");
    assert.deepEqual(rejected.draftJson, before.draftJson, "a rejected Patch cannot change Draft JSON");
    assert.equal(
      db.prepare("SELECT draft_json FROM agent_loop_template_design_drafts WHERE draft_id = ?").get("design-card-schema").draft_json,
      persistedBefore,
      "the transaction must retain the exact durable JSON after rejection",
    );

    const applied = service.applyStructuredPatch({
      draftId: "design-card-schema",
      capabilitySecret: capabilityFor(service, "design-card-schema"),
      expectedRevision: rejected.revision,
      operationId: "operation-valid-worker-prompt",
      patch: [{
        op: "add",
        path: "/agents/-",
        value: {
          id: "researcher",
          name: "Researcher",
          kind: "researcher",
          mcp: [],
          skills: [],
          dispatchProfile: {
            title: "Evidence research",
            description: "Use for source-backed research.",
          },
          workerSystemPrompt: "Collect dated, primary-source evidence and state uncertainty.",
        },
      }],
    });
    assert.equal(applied.draft.revision, before.revision + 1);
    assert.equal(applied.draft.draftJson.agents[0].model, "opencode-go/gpt-5.6-luna");
    assert.deepEqual(applied.draft.validation, { valid: true, issues: [] });
    db.close();
  });

  it("projects an invalid historical Draft as repairable and still permits discard", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    const insertDraft = (draftId) => service.createOrGetDraft({
      draftId,
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });
    const invalidAgents = [{
      id: "researcher",
      name: "Researcher",
      kind: "researcher",
      dispatchProfile: {
        title: "Evidence research",
        description: "Use for source-backed research.",
      },
      systemPrompt: "This is an invalid historic alias.",
    }];

    insertDraft("design-historical-invalid");
    db.prepare("UPDATE agent_loop_template_design_drafts SET draft_json = ? WHERE draft_id = ?")
      .run(JSON.stringify({ ...templateDraftJson(), agents: invalidAgents }), "design-historical-invalid");
    const historical = service.readDraft({ draftId: "design-historical-invalid" });
    assert.deepEqual(historical.validation, {
      valid: false,
      issues: [{ path: "/agents", code: "loop_template_agent_card_prompt_contract_mixed" }],
    });
    assert.equal(historical.draftJson.agents[0].systemPrompt, "This is an invalid historic alias.", "read projection must not repair stored JSON");

    const repaired = service.applyStructuredPatch({
      draftId: "design-historical-invalid",
      capabilitySecret: capabilityFor(service, "design-historical-invalid"),
      expectedRevision: historical.revision,
      operationId: "operation-replace-historical-agents",
      patch: [{
        op: "replace",
        path: "/agents",
        value: [{
          id: "researcher",
          name: "Researcher",
          kind: "researcher",
          mcp: [],
          skills: [],
          dispatchProfile: {
            title: "Evidence research",
            description: "Use for source-backed research.",
          },
          workerSystemPrompt: "Collect dated, primary-source evidence and state uncertainty.",
        }],
      }],
    });
    assert.deepEqual(repaired.draft.validation, { valid: true, issues: [] });
    assert.equal(repaired.draft.draftJson.agents[0].model, "opencode-go/gpt-5.6-luna");

    insertDraft("design-historical-discard");
    db.prepare("UPDATE agent_loop_template_design_drafts SET draft_json = ? WHERE draft_id = ?")
      .run(JSON.stringify({ ...templateDraftJson(), agents: invalidAgents }), "design-historical-discard");
    const discarded = service.discardDraft({ draftId: "design-historical-discard", expectedRevision: 1 });
    assert.equal(discarded.status, "discarded");
    assert.equal(discarded.validation.valid, false, "discard never needs to repair an invalid historical Draft first");
    db.close();
  });

  it("creates immutable Version checkpoints while retaining the editable Draft and Provider binding", () => {
    const db = new DatabaseSync(":memory:");
    const saveCalls = [];
    const service = createService(db, {
      saveTemplate: (draftJson, context) => {
        saveCalls.push({ draftJson: structuredClone(draftJson), context });
        draftJson.name = "callback must not mutate durable draft";
        return { id: "deepsearch", version: 11 };
      },
    });
    service.createOrGetDraft({
      draftId: "design-save",
      templateId: "deepsearch",
      baseTemplateVersion: 10,
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });
    service.bindProviderSession({
      draftId: "design-save",
      providerSessionId: "ses_meta_1",
      expectedRevision: 1,
    });
    service.applyStructuredPatch({
      draftId: "design-save",
      capabilitySecret: capabilityFor(service, "design-save"),
      expectedRevision: 2,
      operationId: "operation-charter",
      patch: [{ op: "replace", path: "/conductor/charter", value: "Choose evidence work deliberately." }],
    });

    assert.equal(saveCalls.length, 0, "create, bind, patch, and read must never create a Template Version");
    assert.equal(service.readDraft({ draftId: "design-save" }).revision, 3);

    const saved = service.saveDraft({ draftId: "design-save", expectedRevision: 3 });
    assert.equal(saveCalls.length, 1);
    assert.deepEqual(saved.savedTemplate, { id: "deepsearch", version: 11 });
    assert.equal(saved.draft.status, "active");
    assert.equal(saved.draft.revision, 4);
    assert.equal(saved.draft.lastProcessedOperationId, "operation-charter");
    assert.equal(saved.draft.draftJson.name, "DeepSearch", "callback receives a clone, not the durable Draft object");
    assert.deepEqual(
      service.readProviderSessionBinding({ providerSessionId: "ses_meta_1" }),
      { draftId: "design-save", capabilitySecret: capabilityFor(service, "design-save") },
      "saving must retain the Meta Agent Session binding",
    );
    assert.deepEqual(saveCalls[0].context, {
      draftId: "design-save",
      templateId: "deepsearch",
      baseTemplateVersion: 10,
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      revision: 3,
    });
    const continued = service.applyStructuredPatch({
      draftId: "design-save",
      capabilitySecret: capabilityFor(service, "design-save"),
      expectedRevision: saved.draft.revision,
      operationId: "operation-name-after-checkpoint",
      patch: [{ op: "replace", path: "/name", value: "DeepSearch continued" }],
    });
    assert.equal(continued.draft.status, "active");
    assert.equal(continued.draft.revision, 5);
    const checkpointTwo = service.saveDraft({ draftId: "design-save", expectedRevision: continued.draft.revision });
    assert.equal(checkpointTwo.draft.status, "active");
    assert.equal(checkpointTwo.draft.revision, 6);
    assert.equal(saveCalls.length, 2, "each explicit post-edit save creates a new immutable checkpoint");
    assert.equal(saveCalls[0].draftJson.name, "DeepSearch");
    assert.equal(saveCalls[1].draftJson.name, "DeepSearch continued");
    db.close();

    const failingDb = new DatabaseSync(":memory:");
    const failingService = createService(failingDb, {
      saveTemplate: () => { throw new Error("template_store_unavailable"); },
    });
    failingService.createOrGetDraft({
      draftId: "design-save-failure",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });
    assert.throws(
      () => failingService.saveDraft({ draftId: "design-save-failure", expectedRevision: 1 }),
      /template_store_unavailable/,
    );
    assert.equal(failingService.readDraft({ draftId: "design-save-failure" }).status, "active");
    assert.equal(failingService.readDraft({ draftId: "design-save-failure" }).revision, 1);
    failingDb.close();
  });

  it("discards a Draft without saving and prevents later mutation", () => {
    const db = new DatabaseSync(":memory:");
    let saveCount = 0;
    const service = createService(db, { saveTemplate: () => { saveCount += 1; } });
    service.createOrGetDraft({
      draftId: "design-discard",
      cwd: "/workspace/research",
      model: "opencode-go/gpt-5.6-luna",
      draftJson: templateDraftJson(),
    });

    const discarded = service.discardDraft({ draftId: "design-discard", expectedRevision: 1 });
    assert.equal(discarded.status, "discarded");
    assert.equal(discarded.revision, 2);
    assert.equal(saveCount, 0);
    assert.throws(
      () => service.applyStructuredPatch({
        draftId: "design-discard",
        capabilitySecret: capabilityFor(service, "design-discard"),
        expectedRevision: 2,
        operationId: "operation-after-discard",
        patch: [{ op: "replace", path: "/name", value: "Should not apply" }],
      }),
      /template_design_draft_not_active/,
    );
    assert.equal(service.discardDraft({ draftId: "design-discard", expectedRevision: 1 }).revision, 2, "discard retry is idempotent");
    assert.equal(saveCount, 0);
    db.close();
  });

  it("requires the durable per-Draft capability for scoped reads and patches without exposing it in the Draft projection", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    for (const draftId of ["design-private-a", "design-private-b"]) {
      service.createOrGetDraft({
        draftId,
        cwd: "/workspace/research",
        model: "opencode-go/gpt-5.6-luna",
        draftJson: templateDraftJson(),
      });
    }

    const aSecret = capabilityFor(service, "design-private-a");
    const bSecret = capabilityFor(service, "design-private-b");
    assert.notEqual(aSecret, bSecret);
    assert.equal("capabilitySecret" in service.readDraft({ draftId: "design-private-a" }), false);
    assert.equal(service.readScopedDraft({ draftId: "design-private-a", capabilitySecret: aSecret }).draftId, "design-private-a");
    assert.throws(
      () => service.readScopedDraft({ draftId: "design-private-a", capabilitySecret: bSecret }),
      /template_design_draft_capability_invalid/,
    );
    assert.throws(
      () => service.applyStructuredPatch({
        draftId: "design-private-a",
        capabilitySecret: bSecret,
        expectedRevision: 1,
        operationId: "cross-draft-write",
        patch: [{ op: "replace", path: "/name", value: "must not change" }],
      }),
      /template_design_draft_capability_invalid/,
    );
    assert.equal(service.readDraft({ draftId: "design-private-a" }).draftJson.name, "DeepSearch");
    db.close();
  });

  it("resolves a private capability only from one active provider Session binding", () => {
    const db = new DatabaseSync(":memory:");
    const service = createService(db);
    for (const draftId of ["design-bound-a", "design-bound-b"]) {
      service.createOrGetDraft({
        draftId,
        cwd: "/workspace/research",
        model: "opencode-go/gpt-5.6-luna",
        draftJson: templateDraftJson(),
      });
    }

    service.bindProviderSession({
      draftId: "design-bound-a",
      providerSessionId: "ses_template_a",
      expectedRevision: 1,
    });
    const binding = service.readProviderSessionBinding({ providerSessionId: "ses_template_a" });
    assert.deepEqual(binding, {
      draftId: "design-bound-a",
      capabilitySecret: capabilityFor(service, "design-bound-a"),
    });
    assert.equal(service.readProviderSessionBinding({ providerSessionId: "ses_not_bound" }), undefined);
    assert.throws(
      () => service.bindProviderSession({
        draftId: "design-bound-b",
        providerSessionId: "ses_template_a",
        expectedRevision: 1,
      }),
      /template_design_provider_session_already_bound/,
    );

    service.discardDraft({ draftId: "design-bound-a", expectedRevision: 2 });
    assert.equal(
      service.readProviderSessionBinding({ providerSessionId: "ses_template_a" }),
      undefined,
      "a discarded Draft can no longer authorize an old WebUI Session",
    );
    db.close();
  });

  it("reopens a file-backed Draft with its provider binding, JSON, revision, and last patch operation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-template-design-"));
    const filename = path.join(root, "template-design.sqlite");
    try {
      let db = new DatabaseSync(filename);
      let service = createService(db);
      service.createOrGetDraft({
        draftId: "design-reopen",
        templateId: "deepsearch",
        baseTemplateVersion: 10,
        cwd: "/workspace/research",
        model: "opencode-go/gpt-5.6-luna",
        draftJson: templateDraftJson(),
      });
      service.bindProviderSession({
        draftId: "design-reopen",
        providerSessionId: "ses_meta_reopen",
        expectedRevision: 1,
      });
      service.applyStructuredPatch({
        draftId: "design-reopen",
        capabilitySecret: capabilityFor(service, "design-reopen"),
        expectedRevision: 2,
        operationId: "operation-reopen",
        patch: [{ op: "replace", path: "/agents/0/dispatchProfile/title", value: "Independent evidence researcher" }],
      });
      db.close();

      let reopenedSaveCalls = 0;
      db = new DatabaseSync(filename);
      service = createService(db, { saveTemplate: () => { reopenedSaveCalls += 1; } });
      const reopened = service.createOrGetDraft({ draftId: "design-reopen" });
      assert.equal(reopened.created, false);
      assert.equal(reopenedSaveCalls, 0, "reopen is a read and must not save a Template");
      assert.equal(reopened.draft.status, "active");
      assert.equal(reopened.draft.revision, 3);
      assert.equal(reopened.draft.providerSessionId, "ses_meta_reopen");
      assert.equal(reopened.draft.lastProcessedOperationId, "operation-reopen");
      assert.equal(reopened.draft.draftJson.agents[0].dispatchProfile.title, "Independent evidence researcher");
      db.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

function createService(db, overrides = {}) {
  return createTemplateDesignSessionService({
    db,
    now: () => "2026-08-04T12:00:00.000Z",
    randomUUID,
    saveTemplate: () => ({ id: "unused", version: 1 }),
    ...overrides,
  });
}

function capabilityFor(service, draftId) {
  return service.readDraftCapability({ draftId }).capabilitySecret;
}

function templateDraftJson() {
  return {
    id: "deepsearch",
    name: "DeepSearch",
    source: "manual",
    conductor: {
      role: "Conductor",
      model: "opencode-go/gpt-5.6-luna",
      charter: "Choose bounded independent research work.",
    },
    agents: [{
      id: "searcher-0",
      name: "Searcher-0",
      kind: "researcher",
      model: "opencode-go/gpt-5.6-luna",
      mcp: [],
      skills: [],
      dispatchProfile: {
        title: "Evidence researcher",
        description: "Use for independent source-backed research.",
      },
      workerSystemPrompt: "Collect dated, primary-source evidence.",
    }],
    limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
    delivery: { artifactPath: "", ownerAgentId: "publisher" },
  };
}
