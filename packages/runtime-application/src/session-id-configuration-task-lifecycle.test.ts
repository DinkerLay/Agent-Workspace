import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  encodeTemplateAssetTransports,
  hashDefinition,
  isTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type MetaProfileDefinitionV2,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV2,
  type MetaProfileOptionDefinitionV3,
  type MetaProfileOptionSnapshot,
  type TemplateDefinitionV3,
  type TemplatePackage,
} from "@agent-workspace/runtime-contracts";
import { createTaskSetupDraft, createWorkspaceFileObservation } from "@agent-workspace/runtime-domain";
import {
  createRuntimeRepositories,
  createAcpSessionRuntimeRepositories,
  createAcpTemplateV3DraftMigrationRepository,
  createSessionIdCanonicalStore,
  encodeJson,
  SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";
import {
  installLegacyTemplateV2Fixture,
  LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID,
} from "@agent-workspace/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_ACP_STARTER_PACKAGES,
  installBuiltInTemplates,
  BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
} from "./built-in-templates.js";
import { createAcpV3FrozenProfileTupleResolver } from "./acp-v3-frozen-profile-resolver.js";
import {
  validateSessionIdAcpTaskLifecyclePreparedResult,
  type SessionIdAcpTaskLifecyclePort,
} from "./session-id-acp-task-lifecycle.js";
import {
  createSessionIdConfigurationTaskLifecycle,
  sessionIdMetaSystemInstructions,
  sessionIdMetaTargetContext,
} from "./session-id-configuration-task-lifecycle.js";

const NOW = "2026-08-11T03:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session-ID configuration and Task lifecycle owner", () => {
  it("migrates an immutable v2 Version to one Host-issued v3 editing Draft under the command receipt", async () => {
    const harness = createHarness();
    const sourceBytes = harness.store.one<{ definition_json: string }>(
      "SELECT definition_json FROM template_versions WHERE template_version_id = ?",
      harness.legacyVersion.templateVersionId,
    )!.definition_json;
    const definition = structuredClone(
      BUILT_IN_ACP_STARTER_PACKAGES.find(
        ({ package: candidate }) => candidate.template.slug === "opencode-acp-starter",
      )!.package.definition,
    ) as TemplateDefinitionV3;
    const command = {
      type: "template.migrate_v2_to_v3_draft",
      commandId: "command_template_migrate_v2_to_v3",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      sourceTemplateVersionId: harness.legacyVersion.templateVersionId,
      expectedSourceDefinitionHash: harness.legacyVersion.definitionHash,
      metadata: {
        title: "Explicit ACP v3 migration",
        slug: "explicit-acp-v3-migration",
        description: "User-validated portable ACP definition.",
      },
      definition,
    } as const;

    const first = await harness.lifecycle.execute(command);
    expect(Object.keys(first).sort()).toEqual(["receipt", "templateDraft"]);
    expect(first.receipt.commandId).toBe(command.commandId);
    expect(first.templateDraft).toMatchObject({
      templateId: harness.legacyVersion.templateId,
      baseTemplateVersionId: harness.legacyVersion.templateVersionId,
      ownerId: command.ownerId,
      status: "editing",
      revision: 1,
      metadata: command.metadata,
      definition: { schemaVersion: 3 },
    });
    expect(await harness.lifecycle.execute(command)).toEqual(first);
    expect(harness.repositories.templateTask.listDrafts()).toEqual([first.templateDraft]);
    const published = await harness.lifecycle.execute({
      type: "template.publish_draft",
      commandId: "command_template_publish_migrated_v3",
      issuedAt: NOW,
      templateDraftId: first.templateDraft!.templateDraftId,
      expectedRevision: first.templateDraft!.revision,
      templateId: harness.legacyVersion.templateId,
      slug: "explicit-acp-v3-migration",
      title: "Explicit ACP v3 migration",
      description: "Published only after explicit validation.",
    });
    expect(published.templateVersion?.definition).toEqual(definition);
    expect(harness.repositories.templateTask.getTemplateVersion(
      published.templateVersion!.templateVersionId,
    )?.definition).toEqual(definition);
    const exported = await harness.lifecycle.execute({
      type: "template.export",
      commandId: "command_template_export_migrated_v3",
      issuedAt: NOW,
      templateVersionId: published.templateVersion!.templateVersionId,
    });
    expect(exported.templatePackage).toMatchObject({
      schemaVersion: 3,
      definition: { schemaVersion: 3 },
    });
    expect(harness.store.one<{ definition_json: string }>(
      "SELECT definition_json FROM template_versions WHERE template_version_id = ?",
      harness.legacyVersion.templateVersionId,
    )!.definition_json).toBe(sourceBytes);
    harness.close();
  });

  it("defines Meta validation issues as unresolved after the complete proposed patch", () => {
    const instructions = sessionIdMetaSystemInstructions("template_design");
    expect(instructions).toContain("validationIssues must list only problems that remain after applying every proposed operation");
    expect(instructions).toContain("return an empty validationIssues array");
  });

  it("keeps direct-v2 Meta options readable but rejects every new Meta Session effect", async () => {
    const harness = createHarness(LEGACY_META_OPTION);
    const templateDraft = (await harness.lifecycle.execute({
      type: "template.create_draft",
      commandId: "command_template_draft_legacy_meta",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      baseTemplateVersionId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
      metadata: { title: "Legacy Meta fence", slug: "legacy-meta-fence" },
      initialDefinition: harness.version.definition,
    })).templateDraft!;

    await expect(harness.lifecycle.execute({
      type: "meta.create_session",
      commandId: "command_legacy_meta_create",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      metaProfileOptionId: LEGACY_META_OPTION.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: templateDraft.templateDraftId },
    })).rejects.toThrow("meta_profile_v2_read_only");
    expect(harness.repositories.configuration.listMetaSessions()).toEqual([]);
    expect(harness.metaReadinessChecks).toEqual([]);

    harness.store.run(
      `INSERT INTO meta_sessions(
        meta_session_id, owner_id, mode, target_kind, target_id, meta_profile_option_id,
        meta_profile_json, state, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "meta_session_legacy-lifecycle",
      "user_lifecycle",
      "template_design",
      "template_draft",
      templateDraft.templateDraftId,
      LEGACY_META_OPTION.metaProfileOptionId,
      encodeJson(LEGACY_META_PROFILE),
      "active",
      1,
      NOW,
      NOW,
    );
    await expect(harness.lifecycle.execute({
      type: "meta.send_message",
      commandId: "command_legacy_meta_send",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      metaSessionId: "meta_session_legacy-lifecycle",
      expectedSessionRevision: 1,
      expectedTargetRevision: templateDraft.revision,
      idempotencyKey: "legacy-meta-send",
      content: "This must never reach a direct Provider.",
    })).rejects.toThrow("meta_profile_v2_read_only");
    expect(harness.repositories.configuration.listMetaMessages("meta_session_legacy-lifecycle")).toEqual([]);
    expect(harness.repositories.configuration.listMetaTurns("meta_session_legacy-lifecycle")).toEqual([]);
    harness.close();
  });

  it("owns Template archive/import/export and excludes archived identities from Task Setup", async () => {
    const harness = createHarness();
    if (harness.legacyVersion.definition.schemaVersion !== 2) throw new Error("legacy_template_fixture_required");
    const packageValue: TemplatePackage = {
      schemaVersion: 2,
      kind: "agent-workspace/template",
      template: {
        templateId: "template_portable-target",
        version: 1,
        slug: "portable-target",
        title: "Portable target",
        definitionHash: hashDefinition(harness.legacyVersion.definition as never),
      },
      definition: harness.legacyVersion.definition,
    };
    const assets = encodeTemplateAssetTransports([{ path: "prompts/card.md", bytes: new TextEncoder().encode("Target prompt") }]);

    await harness.lifecycle.execute({
      type: "template.import", commandId: "command_template_import_target", issuedAt: NOW,
      package: packageValue, assets, mode: "create",
    });
    const imported = harness.lifecycle.read().templateLibrary.find(({ template }) =>
      template.templateId === packageValue.template.templateId)!;
    expect(harness.lifecycle.read().taskSetupOptions.templates.map((template) => template.templateId))
      .toContain(packageValue.template.templateId);

    const exported = await harness.lifecycle.execute({
      type: "template.export", commandId: "command_template_export_target", issuedAt: NOW,
      templateVersionId: imported.activeVersion!.templateVersionId,
    });
    expect(exported.templatePackage).toMatchObject({
      schemaVersion: 2,
      template: { templateId: packageValue.template.templateId, version: 1 },
    });
    expect(exported.templateAssets).toEqual(assets);

    const archived = await harness.lifecycle.execute({
      type: "template.archive", commandId: "command_template_archive_target", issuedAt: NOW,
      templateId: imported.template.templateId, expectedRevision: imported.template.revision,
    });
    expect(archived.template).toMatchObject({ templateId: imported.template.templateId, archivedAt: NOW });
    expect(harness.lifecycle.read().templateLibrary.find(({ template }) => template.templateId === imported.template.templateId))
      .toBeDefined();
    expect(harness.lifecycle.read().taskSetupOptions.templates.map((template) => template.templateId))
      .not.toContain(imported.template.templateId);
    await expect(harness.lifecycle.execute({
      type: "task_setup.create_draft", commandId: "command_archived_template_setup", issuedAt: NOW,
      ownerId: "user_lifecycle", templateVersionId: imported.activeVersion!.templateVersionId,
      workspaceId: "workspace_lifecycle", title: "Archived", goal: "Must be rejected", taskInputValues: [],
    })).rejects.toThrow("template_v2_read_only");

    await expect(harness.lifecycle.execute({
      type: "template.import", commandId: "command_template_import_conflict", issuedAt: NOW,
      package: {
        ...packageValue,
        definition: {
          ...packageValue.definition,
          agentCards: packageValue.definition.agentCards.map((card, index) =>
            index === 0 ? { ...card, title: `${card.title} changed` } : card),
        },
      },
      assets, mode: "new_version",
    })).rejects.toThrow("template_import_definition_hash_mismatch");
    harness.close();
  });

  it("persists isolated configuration and makes explicit Create freeze a queued Task without starting it", async () => {
    const harness = createHarness();
    await harness.lifecycle.execute({
      type: "workspace.authorize",
      commandId: "command_workspace_authorize",
      issuedAt: NOW,
      workspaceId: "workspace_authorized_command",
      directory: path.dirname(harness.workspaceRoot),
      displayName: "Authorized through lifecycle",
    });
    expect(harness.lifecycle.read().taskSetupOptions.workspaces).toContainEqual({
      workspaceId: "workspace_authorized_command",
      displayName: "Authorized through lifecycle",
    });
    const templateDraft = (await harness.lifecycle.execute({
      type: "template.create_draft",
      commandId: "command_template_draft",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      baseTemplateVersionId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
      metadata: { title: "Lifecycle draft", slug: "lifecycle-draft" },
      initialDefinition: harness.version.definition,
    })).templateDraft!;
    const templateMeta = (await harness.lifecycle.execute({
      type: "meta.create_session",
      commandId: "command_template_meta",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      metaProfileOptionId: META_OPTION.metaProfileOptionId,
      target: { kind: "template_draft", templateDraftId: templateDraft.templateDraftId },
    })).metaSession!;
    const templateContext = sessionIdMetaTargetContext(
      templateMeta,
      templateDraft.revision,
      harness.repositories.templateTask,
      harness.repositories.configuration,
    );
    expect(templateContext).toMatchObject({
      mode: "template_design",
      templateDraft: { definition: { conductor: { agentCardId: expect.stringMatching(/^agent_card_/) } } },
    });
    const templateContextWire = JSON.stringify(templateContext);
    for (const forbidden of [
      "capabilityRefs",
      "allowedTools",
      "providerVersion",
      "protocolFingerprint",
      "workspaceId",
      '"cwd"',
    ]) expect(templateContextWire).not.toContain(forbidden);
    const setup = (await harness.lifecycle.execute({
      type: "task_setup.create_draft",
      commandId: "command_setup",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      templateVersionId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
      workspaceId: "workspace_lifecycle",
      title: "Lifecycle Task",
      goal: "Prove Create and Start remain separate.",
      taskInputValues: [],
    })).taskSetupDraft!;
    const setupMeta = (await harness.lifecycle.execute({
      type: "meta.create_session",
      commandId: "command_setup_meta",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      metaProfileOptionId: META_OPTION.metaProfileOptionId,
      target: { kind: "task_setup_draft", taskSetupDraftId: setup.taskSetupDraftId },
    })).metaSession!;

    const createCommand = {
      type: "task.create",
      commandId: "command_create",
      issuedAt: NOW,
      ownerId: "user_lifecycle",
      workspaceId: "workspace_lifecycle",
      taskSetupDraftId: setup.taskSetupDraftId,
      expectedTaskSetupRevision: setup.revision,
    } as const;
    const created = await harness.lifecycle.execute(createCommand);

    const taskId = created.task!.taskId;
    expect(taskId).toMatch(/^task_lifecycle_/u);
    expect(created.task).toMatchObject({ taskId, status: "queued" });
    expect(created.task).not.toHaveProperty("activeRunId");
    expect(created.taskSetupDraft).toMatchObject({ state: "consumed", createdTaskId: taskId });
    expect(created.metaSession).toMatchObject({ metaSessionId: setupMeta.metaSessionId, state: "consumed" });
    expect(harness.repositories.configuration.getMetaSession(templateMeta.metaSessionId)).toMatchObject({ state: "active" });
    const snapshot = harness.repositories.templateTask.getArchitectureSnapshot(taskId)!;
    expect(snapshot).toMatchObject({
      schemaVersion: 3,
      templateVersionId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
      templateDefinitionHash: harness.version.definitionHash,
      workspace: { workspaceId: "workspace_lifecycle", grantDigest: `sha256:${"a".repeat(64)}` },
      taskGoalCompilerVersion: "task-goal/v1",
    });
    expect(snapshot.taskGoalContent).toContain("Prove Create and Start remain separate.");
    expect(harness.repositories.templateTask.countRuns(taskId)).toBe(0);
    expect(await harness.lifecycle.execute(createCommand)).toEqual(created);
    expect(harness.repositories.templateTask.listTasks()).toHaveLength(1);
    expect(harness.taskIdTransactionChecks).toEqual([true]);
    expect(harness.canonical.binding.listBindings("run_missing")).toEqual([]);
    expect(harness.canonical.message.listMessages("run_missing")).toEqual([]);
    expect(harness.lifecycle.read({ taskId })).toMatchObject({
      taskLibrary: [{ taskId, status: "queued" }],
      currentTask: { task: { taskId } },
      configuration: {
        templateDrafts: [expect.objectContaining({ templateDraftId: templateDraft.templateDraftId })],
        taskSetupDrafts: [expect.objectContaining({ taskSetupDraftId: setup.taskSetupDraftId, state: "consumed" })],
      },
    });
    expect(harness.metaReadinessChecks).toEqual([
      `${META_OPTION.metaProfileOptionId}:${META_PROFILE.profileRevisionId}`,
      `${META_OPTION.metaProfileOptionId}:${META_PROFILE.profileRevisionId}`,
    ]);
    const acceptedWithoutAnchor = await harness.lifecycle.execute({
      type: "task.achieve",
      commandId: "command_create_achieve_without_anchor",
      issuedAt: NOW,
      taskId,
      expectedRevision: created.task!.revision,
      acceptanceNote: "Accept without a file anchor.",
    });
    expect(acceptedWithoutAnchor.task?.achievement).toEqual({
      achievedAt: NOW,
      acceptanceNote: "Accept without a file anchor.",
    });
    expect(JSON.stringify(acceptedWithoutAnchor)).not.toContain("acceptedArtifactIds");
    harness.close();
  });

  it("lists and mutates only explicitly registered Session-ID Tasks", async () => {
    const harness = createHarness();
    harness.store.run(
      `INSERT INTO task_architecture_snapshots(
         architecture_snapshot_id, task_id, template_id, template_version_id,
         template_definition_hash, definition_json, workspace_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "architecture_legacy_unowned", "task_legacy_unowned", harness.legacyVersion.templateId,
      harness.legacyVersion.templateVersionId, harness.legacyVersion.definitionHash,
      JSON.stringify(harness.legacyVersion.definition),
      JSON.stringify({ workspaceId: "workspace_lifecycle", cwd: harness.workspaceRoot }), NOW,
    );
    harness.store.run(
      `INSERT INTO tasks(
         task_id, architecture_snapshot_id, title, goal, status, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?)`,
      "task_legacy_unowned", "architecture_legacy_unowned", "Legacy", "Must remain superseded.", NOW, NOW,
    );
    expect(harness.repositories.templateTask.getTask("task_legacy_unowned")).toBeDefined();
    expect(harness.lifecycle.read().taskLibrary).toEqual([]);
    expect(harness.lifecycle.read({ taskId: "task_legacy_unowned" }).currentTask).toBeUndefined();
    await expect(harness.lifecycle.execute({
      type: "task.achieve", commandId: "command_legacy_mutation", issuedAt: NOW,
      taskId: "task_legacy_unowned", expectedRevision: 1,
    })).rejects.toThrow("task_not_found");

    const target = await createQueuedTask(harness, "task_registered_target");
    expect(harness.lifecycle.read().taskLibrary.map((task) => task.taskId)).toEqual([target.taskId]);
    expect(harness.canonical.taskRun.ownsTask(target.taskId)).toBe(true);
    expect(harness.repositories.templateTask.getTask("task_legacy_unowned")).toBeDefined();
    harness.close();
  });

  it("starts one fresh Run with one Conductor Binding, unmaterialized Slots and the exact unique task_goal", async () => {
    const harness = createHarness();
    const task = await createQueuedTask(harness, "task_start");
    const command = {
      type: "task.start" as const,
      commandId: "command_start",
      issuedAt: NOW,
      taskId: task.taskId,
      expectedRevision: task.revision,
    };

    const started = await harness.lifecycle.execute(command);
    const replayed = await harness.lifecycle.execute(command);
    expect(replayed).toEqual(started);
    expect(started.task).toMatchObject({ status: "running", activeRunId: started.run!.runId });
    expect(started.run).toMatchObject({ status: "starting", runNumber: 1 });
    expect(harness.repositories.templateTask.countRuns(task.taskId)).toBe(1);
    const binding = harness.acpRepositories.binding.getCurrentBinding(started.run!.conductorLogicalSessionId)!;
    expect(binding).toEqual(expect.objectContaining({
      schemaVersion: 3,
      logicalSessionId: started.run!.conductorLogicalSessionId,
      agentCardId: harness.version.definition.conductor.agentCardId,
      status: "active",
      recoverable: true,
    }));
    expect(harness.canonical.binding.listBindings(started.run!.runId)).toEqual([]);
    expect(harness.canonical.reliability.listProviderEffects(started.run!.conductorLogicalSessionId)).toEqual([]);
    for (const card of harness.version.definition.agentCards) {
      expect(harness.canonical.taskRun.findSlot(started.run!.runId, card.agentCardId)).toMatchObject({
        latestGeneration: 0,
        revision: 1,
      });
      expect(harness.canonical.taskRun.findSlot(started.run!.runId, card.agentCardId)).not.toHaveProperty("currentSessionId");
    }
    const worker = harness.version.definition.agentCards[0]!;
    const workerSlot = harness.canonical.taskRun.findSlot(started.run!.runId, worker.agentCardId)!;
    harness.canonical.taskRun.materializeGeneration({
      ...workerSlot,
      currentSessionId: "logical_session_lifecycle_worker_g1",
      latestGeneration: 1,
      revision: workerSlot.revision + 1,
      updatedAt: NOW,
    }, {
      sessionId: "logical_session_lifecycle_worker_g1",
      cardSessionSlotId: workerSlot.cardSessionSlotId,
      taskId: task.taskId,
      runId: started.run!.runId,
      agentCardId: worker.agentCardId,
      executionProfileId: worker.executionProfileId,
      generation: 1,
      lifecycle: "current",
      createdAt: NOW,
    });
    expect(harness.canonical.taskRun.getGeneration("logical_session_lifecycle_worker_g1"))
      .toMatchObject({ executionProfileId: worker.executionProfileId, lifecycle: "current" });
    const snapshot = harness.repositories.templateTask.getArchitectureSnapshot(task.taskId)!;
    expect(harness.canonical.message.listMessages(started.run!.runId)).toEqual([
      expect.objectContaining({
        kind: "task_goal",
        content: snapshot.taskGoalContent,
        contentDigest: snapshot.taskGoalContentDigest,
      }),
    ]);
    expect(harness.canonical.orchestration.listInboxItems(started.run!.conductorLogicalSessionId)).toEqual([
      expect.objectContaining({ sequence: 1, priority: "human", state: "pending" }),
    ]);
    expect(harness.providerEffects).toEqual([]);

    expect(harness.lifecycle.activateRun({
      taskId: task.taskId,
      runId: started.run!.runId,
      conductorBindingId: binding.bindingId,
    })).toMatchObject({ status: "running", revision: 2 });
    harness.close();
  });

  it("fails closed before every Run, legacy Binding and Provider-effect write when the ACP seam is absent", async () => {
    const harness = createHarness(META_OPTION, false);
    const task = await createQueuedTask(harness, "task_start_without_acp_seam");
    const command = {
      type: "task.start" as const,
      commandId: "command_start_without_acp_seam",
      issuedAt: NOW,
      taskId: task.taskId,
      expectedRevision: task.revision,
    };

    await expect(harness.lifecycle.execute(command)).rejects.toThrow("acp_task_lifecycle_not_configured");
    expect(harness.repositories.templateTask.countRuns(task.taskId)).toBe(0);
    expect(harness.repositories.templateTask.getTask(task.taskId)).toEqual(task);
    expect(harness.repositories.command.get(command.commandId)).toBeUndefined();
    for (const table of [
      "session_id_card_session_slots",
      "session_id_logical_sessions",
      "session_id_provider_bindings",
      "session_id_provider_effect_outbox",
      "session_id_acp_v3_bindings",
      "session_id_acp_v3_execution_runtimes",
      "session_id_acp_v3_provider_effect_intents",
    ]) {
      expect(harness.store.one<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count).toBe(0);
    }
    harness.close();
  });

  it("rejects eager Provider effects and extra resume Bindings before lifecycle state is written", async () => {
    const eagerLifecycle: SessionIdAcpTaskLifecyclePort = {
      async prepare({ architecture, commandFence }) {
        const profile = architecture.definition.executionProfiles.find((candidate) =>
          candidate.executionProfileId === architecture.definition.conductor.executionProfileId)!;
        return Object.freeze({
          schemaVersion: 3,
          operation: commandFence.operation,
          taskId: commandFence.taskId,
          runId: commandFence.runId,
          bindings: Object.freeze([Object.freeze({
            bindingId: "binding_eager_forbidden",
            bindingHandle: "binding_handle_eager_forbidden",
            logicalSessionId: commandFence.conductorLogicalSessionId,
            sessionExecutionRuntimeId: "session_execution_runtime_eager_forbidden",
            executionProfileId: profile.executionProfileId,
            profileRevisionId: profile.profileRevisionId,
            providerFamily: profile.providerFamily,
          })]),
          providerEffectIntentIds: Object.freeze(["provider_effect_eager_forbidden"]),
        });
      },
      stage() {
        throw new Error("eager_stage_must_not_run");
      },
    };
    const harness = createHarness(META_OPTION, true, eagerLifecycle);
    const task = await createQueuedTask(harness, "task_start_eager_effect");
    await expect(harness.lifecycle.execute({
      type: "task.start",
      commandId: "command_start_eager_effect",
      issuedAt: NOW,
      taskId: task.taskId,
      expectedRevision: task.revision,
    })).rejects.toThrow("acp_task_lifecycle_eager_effect_forbidden");
    expect(harness.repositories.templateTask.countRuns(task.taskId)).toBe(0);
    expect(harness.repositories.command.get("command_start_eager_effect")).toBeUndefined();
    for (const table of [
      "session_id_card_session_slots",
      "session_id_logical_sessions",
      "session_id_provider_bindings",
      "session_id_provider_effect_outbox",
      "session_id_acp_v3_bindings",
      "session_id_acp_v3_execution_runtimes",
      "session_id_acp_v3_provider_effect_intents",
    ]) {
      expect(harness.store.one<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count).toBe(0);
    }

    const architecture = harness.repositories.templateTask.getArchitectureSnapshot(task.taskId)!;
    if (!isTaskArchitectureSnapshotV3(architecture)) throw new Error("test_v3_architecture_required");
    const conductorProfile = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === architecture.definition.conductor.executionProfileId)!;
    const worker = architecture.definition.agentCards[0]!;
    const workerProfile = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === worker.executionProfileId)!;
    const resumeFence = {
      operation: "resume",
      commandId: "command_resume_extra_binding",
      issuedAt: NOW,
      taskId: task.taskId,
      expectedTaskRevision: task.revision,
      runId: "run_extra_binding",
      expectedRunRevision: 1,
      conductorLogicalSessionId: "logical_session_conductor_extra_binding",
    } as const;
    expect(() => validateSessionIdAcpTaskLifecyclePreparedResult({
      schemaVersion: 3,
      operation: "resume",
      taskId: task.taskId,
      runId: resumeFence.runId,
      bindings: [{
        bindingId: "binding_conductor_extra_binding",
        bindingHandle: "binding_handle_conductor_extra_binding",
        logicalSessionId: resumeFence.conductorLogicalSessionId,
        sessionExecutionRuntimeId: "session_execution_runtime_conductor_extra_binding",
        executionProfileId: conductorProfile.executionProfileId,
        profileRevisionId: conductorProfile.profileRevisionId,
        providerFamily: conductorProfile.providerFamily,
      }, {
        bindingId: "binding_worker_extra_binding",
        bindingHandle: "binding_handle_worker_extra_binding",
        logicalSessionId: "logical_session_worker_extra_binding",
        sessionExecutionRuntimeId: "session_execution_runtime_worker_extra_binding",
        executionProfileId: workerProfile.executionProfileId,
        profileRevisionId: workerProfile.profileRevisionId,
        providerFamily: workerProfile.providerFamily,
      }],
      providerEffectIntentIds: [],
    }, { architecture, commandFence: resumeFence })).toThrow("acp_task_lifecycle_conductor_binding_mismatch");
    harness.close();
  });

  it("rolls back the canonical lifecycle transaction when stage does not produce an active recoverable Binding", async () => {
    const invalidStageLifecycle: SessionIdAcpTaskLifecyclePort = {
      async prepare({ architecture, commandFence }) {
        const profile = architecture.definition.executionProfiles.find((candidate) =>
          candidate.executionProfileId === architecture.definition.conductor.executionProfileId)!;
        return {
          schemaVersion: 3,
          operation: commandFence.operation,
          taskId: commandFence.taskId,
          runId: commandFence.runId,
          bindings: [{
            bindingId: "binding_invalid_stage",
            bindingHandle: "binding_handle_invalid_stage",
            logicalSessionId: commandFence.conductorLogicalSessionId,
            sessionExecutionRuntimeId: "session_execution_runtime_invalid_stage",
            executionProfileId: profile.executionProfileId,
            profileRevisionId: profile.profileRevisionId,
            providerFamily: profile.providerFamily,
          }],
          providerEffectIntentIds: [],
        };
      },
      stage({ architecture, prepared, owners }) {
        const candidate = prepared.bindings[0]!;
        owners.binding.createBinding({
          schemaVersion: 3,
          bindingId: candidate.bindingId,
          taskId: prepared.taskId,
          runId: prepared.runId,
          logicalSessionId: candidate.logicalSessionId,
          agentCardId: architecture.definition.conductor.agentCardId,
          executionProfileId: candidate.executionProfileId,
          profileRevisionId: candidate.profileRevisionId,
          providerFamily: candidate.providerFamily,
          bindingHandle: candidate.bindingHandle,
          status: "recovering",
          recoverable: true,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }, { makeCurrent: true });
        owners.sessionRuntime.createRuntime({
          sessionExecutionRuntimeId: candidate.sessionExecutionRuntimeId,
          taskId: prepared.taskId,
          runId: prepared.runId,
          logicalSessionId: candidate.logicalSessionId,
          state: "idle",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        });
      },
    };
    const harness = createHarness(META_OPTION, true, invalidStageLifecycle);
    const task = await createQueuedTask(harness, "task_start_invalid_stage");
    await expect(harness.lifecycle.execute({
      type: "task.start",
      commandId: "command_start_invalid_stage",
      issuedAt: NOW,
      taskId: task.taskId,
      expectedRevision: task.revision,
    })).rejects.toThrow("acp_task_lifecycle_binding_stage_mismatch");
    expect(harness.repositories.templateTask.countRuns(task.taskId)).toBe(0);
    expect(harness.repositories.command.get("command_start_invalid_stage")).toBeUndefined();
    for (const table of [
      "session_id_card_session_slots",
      "session_id_logical_sessions",
      "session_id_acp_v3_bindings",
      "session_id_acp_v3_execution_runtimes",
      "session_id_acp_v3_provider_effect_intents",
    ]) {
      expect(harness.store.one<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count).toBe(0);
    }
    harness.close();
  });

  it("resumes only recoverable original Bindings, restarts only terminal Runs, and Achieve never stops an active Run", async () => {
    const resumeHarness = createHarness();
    const resumeTask = await createQueuedTask(resumeHarness, "task_resume");
    const started = await resumeHarness.lifecycle.execute({
      type: "task.start", commandId: "command_resume_start", issuedAt: NOW,
      taskId: resumeTask.taskId, expectedRevision: resumeTask.revision,
    });
    const binding = resumeHarness.acpRepositories.binding.getCurrentBinding(started.run!.conductorLogicalSessionId)!;
    const startedTaskRecord = resumeHarness.repositories.templateTask.getTask(started.task!.taskId)!;
    const blocked = { ...startedTaskRecord, status: "blocked" as const, revision: startedTaskRecord.revision + 1, updatedAt: NOW };
    resumeHarness.repositories.templateTask.updateTask(blocked, startedTaskRecord.revision);
    expect(resumeHarness.lifecycle.read({ taskId: blocked.taskId }).currentTask?.lifecycle).toEqual({
      canResume: true,
      canRestart: false,
      restartBlockedReason: "task_run_not_terminal",
    });
    const resumed = await resumeHarness.lifecycle.execute({
      type: "task.resume", commandId: "command_resume", issuedAt: NOW,
      taskId: blocked.taskId, runId: started.run!.runId, expectedRevision: blocked.revision,
    });
    expect(resumed.run).toMatchObject({ runId: started.run!.runId, conductorLogicalSessionId: started.run!.conductorLogicalSessionId });
    expect(resumeHarness.repositories.templateTask.countRuns(blocked.taskId)).toBe(1);
    expect(resumeHarness.acpRepositories.binding.listBindings(started.run!.conductorLogicalSessionId)).toHaveLength(1);
    expect(resumed.acpTaskRuntime?.bindings).toEqual([
      expect.objectContaining({ bindingId: binding.bindingId, logicalSessionId: binding.logicalSessionId }),
    ]);
    expect(resumeHarness.canonical.reliability.listProviderEffects(started.run!.conductorLogicalSessionId)).toEqual([]);

    const observation = createWorkspaceFileObservation({
      workspaceFileObservationId: "workspace_file_observation_resume_result",
      taskId: blocked.taskId,
      runId: started.run!.runId,
      workspaceRelativePath: "reports/result.md",
      content: "# Accepted result\n",
      source: "unverified",
      now: NOW,
    });
    resumeHarness.canonical.workspace.createObservation(observation);
    const achieved = await resumeHarness.lifecycle.execute({
      type: "task.achieve", commandId: "command_achieve", issuedAt: NOW,
      taskId: blocked.taskId, expectedRevision: resumed.task!.revision,
      fileStateAnchor: { observationId: observation.workspaceFileObservationId, label: "Final report" },
      acceptanceNote: "Accepted independently.",
    });
    expect(achieved.task).toMatchObject({
      status: "running",
      activeRunId: started.run!.runId,
      achievement: {
        fileStateAnchor: {
          workspaceRelativePath: "reports/result.md",
          observedDigest: observation.contentDigest,
          label: "Final report",
        },
        acceptanceNote: "Accepted independently.",
      },
    });
    expect(JSON.stringify(achieved)).not.toContain("acceptedArtifactIds");
    expect(resumeHarness.repositories.templateTask.getRun(started.run!.runId)).toMatchObject({ status: "starting" });
    resumeHarness.close();

    const restartHarness = createHarness();
    const restartTask = await createQueuedTask(restartHarness, "task_restart");
    const first = await restartHarness.lifecycle.execute({
      type: "task.start", commandId: "command_restart_start", issuedAt: NOW,
      taskId: restartTask.taskId, expectedRevision: restartTask.revision,
    });
    const firstBinding = restartHarness.acpRepositories.binding.getCurrentBinding(first.run!.conductorLogicalSessionId)!;
    restartHarness.acpRepositories.binding.updateBinding({
      ...firstBinding,
      status: "unrecoverable",
      recoverable: false,
      revision: firstBinding.revision + 1,
      updatedAt: NOW,
    }, firstBinding.revision);
    const firstTaskRecord = restartHarness.repositories.templateTask.getTask(first.task!.taskId)!;
    const stoppedTask = { ...firstTaskRecord, status: "stopped" as const, revision: firstTaskRecord.revision + 1, updatedAt: NOW };
    const stoppedRun = { ...first.run!, status: "stopped" as const, revision: first.run!.revision + 1, endedAt: NOW };
    restartHarness.repositories.transaction(() => {
      restartHarness.repositories.templateTask.updateTask(stoppedTask, firstTaskRecord.revision);
      restartHarness.repositories.templateTask.updateRun(stoppedRun);
    });
    expect(restartHarness.lifecycle.read({ taskId: stoppedTask.taskId }).currentTask?.lifecycle).toEqual({
      canResume: false,
      resumeBlockedReason: "task_not_resumable",
      canRestart: true,
    });
    const restarted = await restartHarness.lifecycle.execute({
      type: "task.restart", commandId: "command_restart", issuedAt: NOW,
      taskId: stoppedTask.taskId, expectedRevision: stoppedTask.revision,
    });
    expect(restarted.run).toMatchObject({ runNumber: 2, status: "starting" });
    expect(restarted.run!.runId).not.toBe(first.run!.runId);
    expect(restarted.run!.conductorLogicalSessionId).not.toBe(first.run!.conductorLogicalSessionId);
    expect(restartHarness.repositories.templateTask.getRun(first.run!.runId)).toEqual(stoppedRun);
    expect(restartHarness.canonical.message.listMessages(restarted.run!.runId)).toEqual([
      expect.objectContaining({ kind: "task_goal" }),
    ]);
    restartHarness.close();
  });

  it("archives only an achieved quiescent Task and restores the exact retained identity", async () => {
    const harness = createHarness();
    const task = await createQueuedTask(harness, "task_retention_archive");
    await expect(harness.lifecycle.execute({
      type: "task.archive", commandId: "command_archive_unachieved", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: task.revision,
    })).rejects.toThrow("task_not_recyclable");

    const achieved = await harness.lifecycle.execute({
      type: "task.achieve", commandId: "command_archive_achieve", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: task.revision,
    });
    const archived = await harness.lifecycle.execute({
      type: "task.archive", commandId: "command_archive", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: achieved.task!.revision,
    });
    expect(archived.task).toMatchObject({ taskId: task.taskId, trashedAt: NOW });
    const replay = await harness.lifecycle.execute({
      type: "task.archive", commandId: "command_archive", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: achieved.task!.revision,
    });
    expect(replay).toEqual(archived);

    const beforeRestoreRuns = harness.repositories.templateTask.countRuns(task.taskId);
    const restored = await harness.lifecycle.execute({
      type: "task.restore", commandId: "command_restore", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: archived.task!.revision,
    });
    expect(restored.task).toMatchObject({ taskId: task.taskId, achievement: { achievedAt: NOW } });
    expect(restored.task).not.toHaveProperty("trashedAt");
    expect(harness.repositories.templateTask.countRuns(task.taskId)).toBe(beforeRestoreRuns);
    harness.close();
  });

  it("rejects archive until every retained Session-ID Binding and Run is terminal", async () => {
    const harness = createHarness();
    const task = await createQueuedTask(harness, "task_retention_busy");
    const started = await harness.lifecycle.execute({
      type: "task.start", commandId: "command_retention_busy_start", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: task.revision,
    });
    const achieved = await harness.lifecycle.execute({
      type: "task.achieve", commandId: "command_retention_busy_achieve", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: started.task!.revision,
    });
    await expect(harness.lifecycle.execute({
      type: "task.archive", commandId: "command_retention_busy_archive", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: achieved.task!.revision,
    })).rejects.toThrow("task_retention_not_quiescent");

    const binding = harness.acpRepositories.binding.getCurrentBinding(started.run!.conductorLogicalSessionId)!;
    harness.acpRepositories.binding.updateBinding({
      ...binding,
      status: "released",
      recoverable: false,
      revision: binding.revision + 1,
      updatedAt: NOW,
    }, binding.revision);
    const currentTask = harness.repositories.templateTask.getTask(task.taskId)!;
    const currentRun = harness.repositories.templateTask.getRun(started.run!.runId)!;
    const executionRuntime = harness.acpRepositories.sessionRuntime.getRuntimeForSession(
      started.run!.conductorLogicalSessionId,
    )!;
    harness.repositories.transaction(() => {
      harness.repositories.templateTask.updateTask({
        ...currentTask, status: "stopped", revision: currentTask.revision + 1, updatedAt: NOW,
      }, currentTask.revision);
      harness.repositories.templateTask.updateRun({
        ...currentRun, status: "stopped", endedAt: NOW, revision: currentRun.revision + 1,
      });
      harness.acpRepositories.sessionRuntime.updateRuntime({
        ...executionRuntime,
        state: "closed",
        revision: executionRuntime.revision + 1,
        updatedAt: NOW,
      }, executionRuntime.revision);
      harness.canonical.taskRun.retireConductorSession({
        taskId: task.taskId,
        runId: started.run!.runId,
        logicalSessionId: started.run!.conductorLogicalSessionId,
        closedAt: NOW,
      });
      harness.store.run(
        `UPDATE session_id_session_inbox_items
         SET state = 'handled', updated_at = ? WHERE task_id = ?`,
        NOW, task.taskId,
      );
    });
    const terminalTask = harness.repositories.templateTask.getTask(task.taskId)!;
    const archived = await harness.lifecycle.execute({
      type: "task.archive", commandId: "command_retention_terminal_archive", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: terminalTask.revision,
    });
    expect(archived.task?.trashedAt).toBe(NOW);
    const retainedRun = harness.repositories.templateTask.getRun(started.run!.runId);
    const restored = await harness.lifecycle.execute({
      type: "task.restore", commandId: "command_retention_terminal_restore", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: archived.task!.revision,
    });
    expect(restored.task).toMatchObject({ taskId: task.taskId, activeRunId: started.run!.runId });
    expect(harness.repositories.templateTask.getRun(started.run!.runId)).toEqual(retainedRun);
    harness.close();
  });

  it("previews and permanently deletes only the target product graph while preserving Workspace files", async () => {
    const harness = createHarness();
    mkdirSync(harness.workspaceRoot, { recursive: true });
    const sentinelPath = path.join(harness.workspaceRoot, "sentinel.md");
    writeFileSync(sentinelPath, "keep me\n", "utf8");
    const task = await createQueuedTask(harness, "task_retention_delete");
    const observation = createWorkspaceFileObservation({
      workspaceFileObservationId: "workspace_file_observation_retention_delete",
      taskId: task.taskId,
      workspaceRelativePath: "sentinel.md",
      content: "keep me\n",
      source: "unverified",
      now: NOW,
    });
    harness.canonical.workspace.createObservation(observation);
    const achieved = await harness.lifecycle.execute({
      type: "task.achieve", commandId: "command_retention_delete_achieve", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: task.revision,
      fileStateAnchor: { observationId: observation.workspaceFileObservationId },
    });
    const archived = await harness.lifecycle.execute({
      type: "task.archive", commandId: "command_retention_delete_archive", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: achieved.task!.revision,
    });
    await expect(harness.lifecycle.execute({
      type: "task.preview_permanent_delete", commandId: "command_retention_delete_stale", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: archived.task!.revision - 1,
    })).rejects.toThrow("task_revision_stale");
    const preview = await harness.lifecycle.execute({
      type: "task.preview_permanent_delete", commandId: "command_retention_delete_preview", issuedAt: NOW,
      taskId: task.taskId, expectedRevision: archived.task!.revision,
    });
    expect(preview.permanentDeletePreview).toMatchObject({
      taskId: task.taskId,
      expectedRevision: archived.task!.revision,
      workspaceFilesWillRemain: true,
      productRecordCounts: { workspaceFileObservations: 1 },
    });
    expect(JSON.stringify(preview.permanentDeletePreview)).not.toContain("sentinel.md");

    const command = {
      type: "task.permanently_delete" as const,
      commandId: "command_retention_delete",
      issuedAt: NOW,
      taskId: task.taskId,
      expectedRevision: archived.task!.revision,
    };
    expect(command).not.toHaveProperty("artifactIds");
    const deleted = await harness.lifecycle.execute(command);
    expect(deleted.permanentDelete).toEqual({
      taskId: task.taskId,
      deletedAt: NOW,
      workspaceFilesWillRemain: true,
    });
    expect(await harness.lifecycle.execute(command)).toEqual(deleted);
    expect(harness.repositories.templateTask.getTask(task.taskId)).toBeUndefined();
    expect(harness.repositories.configuration.getTaskSetupDraft(`task_setup_draft_${task.taskId}`)?.createdTaskId).toBeUndefined();
    expect(harness.canonical.workspace.listObservations(task.taskId)).toEqual([]);
    expect(harness.canonical.retention.getPermanentDeleteTombstone(command.commandId)).toMatchObject({
      taskId: task.taskId,
      result: deleted.permanentDelete,
    });
    expect(readFileSync(sentinelPath, "utf8")).toBe("keep me\n");
    harness.close();
  });
});

type Harness = ReturnType<typeof createHarness>;

function createHarness(
  metaOption: MetaProfileOptionSnapshot = META_OPTION,
  withAcpTaskLifecycle = true,
  acpTaskLifecycleOverride?: SessionIdAcpTaskLifecyclePort,
) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-session-id-lifecycle-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const store = new SqliteRuntimeStore({ path: path.join(root, "runtime.sqlite"), now: () => NOW });
  const repositories = createRuntimeRepositories(store);
  const canonical = createSessionIdCanonicalStore(store);
  installBuiltInTemplates(repositories, NOW);
  installLegacyTemplateV2Fixture(repositories.templateTask, NOW);
  const version = repositories.templateTask.getTemplateVersion(BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID)!;
  const legacyVersion = repositories.templateTask.getTemplateVersion(LEGACY_CODEX_STARTER_TEMPLATE_VERSION_ID)!;
  repositories.workspace.createAuthorization({
    workspaceId: "workspace_lifecycle",
    canonicalDirectory: workspaceRoot,
    displayName: "Lifecycle workspace",
    authorizedAt: NOW,
  });
  const counters = new Map<string, number>();
  let transactionDepth = 0;
  const taskIdTransactionChecks: boolean[] = [];
  const stableCreateId = (kind: string) => {
    if (kind === "task") taskIdTransactionChecks.push(transactionDepth > 0);
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_lifecycle_${next}`;
  };
  const providerEffects: unknown[] = [];
  const metaReadinessChecks: string[] = [];
  const acpRepositories = createAcpSessionRuntimeRepositories(store, {
    resolveFrozenProfileTuple: createAcpV3FrozenProfileTupleResolver({
      templates: repositories.templateTask,
      taskRun: canonical.taskRun,
    }),
  });
  const acpTaskLifecycle: SessionIdAcpTaskLifecyclePort = {
    async prepare({ architecture, commandFence, owners }) {
      if (commandFence.operation === "resume") {
        const binding = owners.binding.getCurrentBinding(commandFence.conductorLogicalSessionId);
        if (!binding) throw new Error("fake_acp_conductor_binding_missing");
        const runtime = owners.sessionRuntime.getRuntimeForSession(commandFence.conductorLogicalSessionId);
        if (!runtime) throw new Error("fake_acp_conductor_runtime_missing");
        return Object.freeze({
          schemaVersion: 3,
          operation: commandFence.operation,
          taskId: commandFence.taskId,
          runId: commandFence.runId,
          bindings: Object.freeze([Object.freeze({
            bindingId: binding.bindingId,
            bindingHandle: binding.bindingHandle,
            logicalSessionId: binding.logicalSessionId,
            sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
            executionProfileId: binding.executionProfileId,
            profileRevisionId: binding.profileRevisionId,
            providerFamily: binding.providerFamily,
          })]),
          providerEffectIntentIds: Object.freeze([]),
        });
      }
      const profile = architecture.definition.executionProfiles.find((candidate) =>
        candidate.executionProfileId === architecture.definition.conductor.executionProfileId)!;
      return Object.freeze({
        schemaVersion: 3,
        operation: commandFence.operation,
        taskId: commandFence.taskId,
        runId: commandFence.runId,
        bindings: Object.freeze([Object.freeze({
          bindingId: stableCreateId("binding"),
          bindingHandle: stableCreateId("binding_handle"),
          logicalSessionId: commandFence.conductorLogicalSessionId,
          sessionExecutionRuntimeId: stableCreateId("session_execution_runtime"),
          executionProfileId: profile.executionProfileId,
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
        })]),
        providerEffectIntentIds: Object.freeze([]),
      });
    },
    stage({ architecture, prepared, owners }) {
      if (prepared.operation === "resume") return;
      for (const candidate of prepared.bindings) {
        const binding: AcpSafeSessionBindingRecordV3 = {
          schemaVersion: 3,
          bindingId: candidate.bindingId,
          taskId: prepared.taskId,
          runId: prepared.runId,
          logicalSessionId: candidate.logicalSessionId,
          agentCardId: architecture.definition.conductor.agentCardId,
          executionProfileId: candidate.executionProfileId,
          profileRevisionId: candidate.profileRevisionId,
          providerFamily: candidate.providerFamily,
          bindingHandle: candidate.bindingHandle,
          status: "active",
          recoverable: true,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        };
        owners.binding.createBinding(binding, { makeCurrent: true });
        owners.sessionRuntime.createRuntime({
          sessionExecutionRuntimeId: candidate.sessionExecutionRuntimeId,
          taskId: prepared.taskId,
          runId: prepared.runId,
          logicalSessionId: candidate.logicalSessionId,
          state: "idle",
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
    },
  };
  const lifecycle = createSessionIdConfigurationTaskLifecycle({
    now: () => NOW,
    createId: stableCreateId,
    transaction: (work) => repositories.transaction(() => {
      transactionDepth += 1;
      try {
        return work();
      } finally {
        transactionDepth -= 1;
      }
    }),
    templates: repositories.templateTask,
    templateV3Migration: createAcpTemplateV3DraftMigrationRepository(store),
    configuration: repositories.configuration,
    workspaces: repositories.workspace,
    commands: repositories.command,
    taskRun: canonical.taskRun,
    workspaceFiles: canonical.workspace,
    retention: canonical.retention,
    canonicalizeWorkspaceDirectory: async (directory) => ({
      canonicalDirectory: directory,
      defaultDisplayName: path.basename(directory),
    }),
    resolveWorkspace: async (authorization) => ({
      workspaceId: authorization.workspaceId,
      grantDigest: `sha256:${"a".repeat(64)}`,
    }),
    resolveMetaProfileOption: (id) => {
      if (id !== metaOption.metaProfileOptionId) throw new Error("meta_profile_option_not_found");
      return metaOption;
    },
    assertMetaProfileReady: async (profile, optionId) => {
      if (!("profileRevisionId" in profile)) throw new Error("meta_profile_v2_read_only");
      metaReadinessChecks.push(`${optionId}:${profile.profileRevisionId}`);
    },
    ...(withAcpTaskLifecycle ? {
      acpTaskLifecycle: acpTaskLifecycleOverride ?? acpTaskLifecycle,
      acpTaskOwners: acpRepositories,
    } : {}),
    createConductorLane: (scope) => Object.freeze({
      enqueueTaskGoal(input: Readonly<{ messageId: string; content: string }>) {
        canonical.message.createMessage(Object.freeze({
          messageId: input.messageId,
          taskId: scope.taskId,
          runId: scope.runId,
          kind: "task_goal" as const,
          content: input.content,
          canonicalContent: Object.freeze([{ kind: "text" as const, text: input.content }]),
          contentDigest: hashDefinition(input.content),
          createdAt: NOW,
        }));
        canonical.orchestration.createInboxItem(Object.freeze({
          inboxItemId: stableCreateId("inbox_item"),
          taskId: scope.taskId,
          runId: scope.runId,
          sessionId: scope.conductorSessionId,
          renderedMessageId: input.messageId,
          sequence: canonical.orchestration.listInboxItems(scope.conductorSessionId).length + 1,
          priority: "human" as const,
          state: "pending" as const,
          createdAt: NOW,
          updatedAt: NOW,
        }));
        return Object.freeze({ status: "enqueued" as const });
      },
    }),
  });
  return {
    store, repositories, canonical, acpRepositories, lifecycle, version, legacyVersion, workspaceRoot,
    providerEffects, metaReadinessChecks, taskIdTransactionChecks,
    close: () => store.close(),
  };
}

async function createQueuedTask(harness: Harness, taskId: string) {
  const setup = createTaskSetupDraft({
    taskSetupDraftId: `task_setup_draft_${taskId}`,
    ownerId: "user_lifecycle",
    templateVersionId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
    workspaceId: "workspace_lifecycle",
    title: `Title ${taskId}`,
    goal: `Goal ${taskId}`,
    schema: harness.version.definition.taskInputSchema,
    taskInputValues: [],
    now: NOW,
  });
  harness.repositories.configuration.createTaskSetupDraft(setup);
  return (await harness.lifecycle.execute({
    type: "task.create",
    commandId: `command_create_${taskId}`,
    issuedAt: NOW,
    ownerId: "user_lifecycle",
    workspaceId: "workspace_lifecycle",
    taskSetupDraftId: setup.taskSetupDraftId,
    expectedTaskSetupRevision: setup.revision,
  })).task!;
}

const META_PROFILE: MetaProfileDefinitionV3 = {
  metaProfileId: "meta_profile_lifecycle",
  profileRevisionId: "profile_revision_meta-lifecycle",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "gpt-5.6-sol",
  configIntent: { reasoningEffort: "high" },
  requiredExtensions: [],
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

const META_OPTION: MetaProfileOptionDefinitionV3 = {
  metaProfileOptionId: "meta_profile_option_lifecycle",
  title: "Lifecycle Meta",
  profile: META_PROFILE,
  readiness: {
    profileRevisionId: META_PROFILE.profileRevisionId,
    providerFamily: META_PROFILE.providerFamily,
    acpAgentKind: META_PROFILE.acpAgentKind,
    role: META_PROFILE.role,
    status: "available",
    reasons: [],
    missingCapabilities: [],
    missingExtensions: [],
    model: META_PROFILE.model,
    observedProtocolMajor: 1,
    observedAgent: { name: "codex-acp", version: "current" },
    observedCapabilities: [],
    observedExtensions: [],
  },
};

const LEGACY_META_PROFILE: MetaProfileDefinitionV2 = {
  metaProfileId: "meta_profile_legacy-lifecycle",
  provider: "codex",
  model: "legacy-direct",
  providerVersion: "preserved",
  protocolFingerprint: "preserved",
  capabilityPolicy: META_PROFILE.capabilityPolicy,
};

const LEGACY_META_OPTION: MetaProfileOptionDefinitionV2 = {
  metaProfileOptionId: "meta_profile_option_legacy-lifecycle",
  title: "Legacy direct Meta",
  availability: "available",
  profile: LEGACY_META_PROFILE,
};
