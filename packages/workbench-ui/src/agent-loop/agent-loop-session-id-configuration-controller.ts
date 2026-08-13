import {
  createId,
  decodeTemplateArchive,
  decodeTemplateAssetTransports,
  encodeTemplateArchive,
  encodeTemplateAssetTransports,
  parseTemplatePackageYaml,
  serializeTemplatePackageYaml,
  validateTemplateDefinitionSnapshot,
  validateTemplatePackage,
  type AcpProviderSettingsReadModel,
  type AcpProviderInstallationInput,
  type ProviderFamily,
  type RuntimeCommand,
  type TaskRecord,
  type TaskSetupDraftRecord,
  type TemplateArchiveAsset,
  type TemplateDraftRecord,
  type TemplatePackage,
} from "@agent-workspace/runtime-contracts";
import type {
  AgentLoopMetaPanelController,
  AgentLoopMetaPanelViewModel,
  AgentLoopMetaScope,
} from "./AgentLoopMetaPanel";
import type {
  AgentLoopTaskSetupController,
  AgentLoopTaskSetupDraftInput,
  AgentLoopTaskSetupViewModel,
} from "./AgentLoopTaskSetupSurface";
import type {
  AgentLoopConfigurationController,
  AgentLoopCreateTaskSetupDraftInput,
} from "./agent-loop-configuration-controller";
import type {
  AgentLoopTemplateDraftEditor,
  AgentLoopTemplateExport,
  AgentLoopTemplateImportFile,
  AgentLoopTemplateImportMode,
  AgentLoopTemplateImportPreview,
  AgentLoopTemplateStudioSurfaceController,
  AgentLoopTemplateStudioViewModel,
} from "./agent-loop-template-studio-controller";

type ConfigurationCommandType =
  | "template.create_draft"
  | "template.save_draft"
  | "template.publish_draft"
  | "template.archive"
  | "template.import"
  | "template.export"
  | "task_setup.create_draft"
  | "task_setup.save_draft"
  | "task_setup.abandon_draft"
  | "meta.create_session"
  | "meta.send_message"
  | "meta.abandon_session"
  | "meta.apply_patch"
  | "meta.reject_patch"
  | "provider.probe_models"
  | "provider.discover_installation"
  | "provider.configure_installation"
  | "provider.configure_chat_models"
  | "task.create";

type SupportedConfigurationCommand = Extract<RuntimeCommand, { type: ConfigurationCommandType }>;
type ConfigurationCommandInput = SupportedConfigurationCommand extends infer Command
  ? Command extends { commandId: string; issuedAt: string }
    ? Omit<Command, "commandId" | "issuedAt">
    : never
  : never;

export type AgentLoopSessionIdConfigurationCommand = SupportedConfigurationCommand & Readonly<{
  /** Renderer-generated visible-action identity; Host ledger derives no scenario fields from it. */
  uiIntentId: string;
}>;

export type AgentLoopSessionIdConfigurationCommandResult = Readonly<{
  templateDraft?: TemplateDraftRecord;
  taskSetupDraft?: TaskSetupDraftRecord;
  task?: Pick<TaskRecord, "taskId">;
  templatePackage?: TemplatePackage;
  templateAssets?: ReturnType<typeof encodeTemplateAssetTransports>;
  providerSettings?: AcpProviderSettingsReadModel;
}>;

export type AgentLoopSessionIdConfigurationReadRequest =
  | Readonly<{ kind: "template_studio"; templateId?: string }>
  | Readonly<{ kind: "task_setup"; taskSetupDraftId: string }>
  | Readonly<{ kind: "provider_settings" }>
  | Readonly<{ kind: "meta"; scope: AgentLoopMetaScope }>;

export type AgentLoopSessionIdConfigurationReadResult =
  | Readonly<{ kind: "template_studio"; model: AgentLoopTemplateStudioViewModel }>
  | Readonly<{ kind: "task_setup"; model: AgentLoopTaskSetupViewModel }>
  | Readonly<{ kind: "provider_settings"; model: AcpProviderSettingsReadModel }>
  | Readonly<{ kind: "meta"; model: AgentLoopMetaPanelViewModel }>;

export type AgentLoopSessionIdConfigurationInvalidation = Readonly<{
  reason: string;
  observedAt?: string;
}>;

export type AgentLoopSessionIdConfigurationRuntimePort = Readonly<{
  readConfiguration(request: AgentLoopSessionIdConfigurationReadRequest): Promise<AgentLoopSessionIdConfigurationReadResult>;
  command(command: AgentLoopSessionIdConfigurationCommand): Promise<AgentLoopSessionIdConfigurationCommandResult>;
  subscribeConfiguration(
    onChanged: (invalidation: AgentLoopSessionIdConfigurationInvalidation) => void,
  ): Promise<() => Promise<void> | void>;
}>;

export type AgentLoopSessionIdConfigurationCommandTrace = Readonly<{
  uiIntentId: string;
  commandId: string;
  intentKind: ConfigurationCommandType;
}>;

export type AgentLoopSessionIdConfigurationControllers = Readonly<{
  configuration: AgentLoopConfigurationController;
  templates: AgentLoopTemplateStudioSurfaceController;
  providerSettings: Readonly<{
    load(): Promise<AcpProviderSettingsReadModel>;
    discoverInstallation(providerFamily: ProviderFamily): Promise<AcpProviderSettingsReadModel>;
    configureInstallation(
      providerFamily: ProviderFamily,
      installation: AcpProviderInstallationInput,
    ): Promise<AcpProviderSettingsReadModel>;
    refreshModels(providerFamily: ProviderFamily): Promise<AcpProviderSettingsReadModel>;
    configureChatModels(
      providerFamily: ProviderFamily,
      modelIds: readonly string[],
      defaultModelId: string,
    ): Promise<AcpProviderSettingsReadModel>;
  }>;
}>;

export type AgentLoopSessionIdConfigurationControllerOptions = Readonly<{
  client: AgentLoopSessionIdConfigurationRuntimePort;
  ownerId: string;
  now?: () => string;
  createRuntimeId?: typeof createId;
  createUiIntentId?: () => string;
  onCommandTrace?: (trace: AgentLoopSessionIdConfigurationCommandTrace) => void;
}>;

/**
 * Configuration adapter for the formal root. Reads are already-scoped UI
 * projections and every mutation crosses the same typed Session-ID port with
 * one stable Renderer intent id and one stable Runtime command id.
 */
export function createAgentLoopSessionIdConfigurationControllers(
  options: AgentLoopSessionIdConfigurationControllerOptions,
): AgentLoopSessionIdConfigurationControllers {
  const now = options.now ?? (() => new Date().toISOString());
  const createRuntimeId = options.createRuntimeId ?? createId;
  const createUiIntentId = options.createUiIntentId ?? (() => {
    const commandId = createRuntimeId("command");
    if (!commandId.startsWith("command_") || commandId.length === "command_".length) {
      throw new Error("agent_loop_ui_intent_entropy_invalid");
    }
    return `ui_intent_${commandId.slice("command_".length)}`;
  });
  const pending = new Map<string, AgentLoopSessionIdConfigurationCommand>();
  const durableTemplateFingerprints = new Map<string, string>();
  const importCandidates = new Map<string, Readonly<{
    package: TemplatePackage;
    assets: readonly TemplateArchiveAsset[];
    availableModes: readonly AgentLoopTemplateImportMode[];
  }>>();

  const issue = async (
    key: string,
    input: ConfigurationCommandInput | ((commandId: string) => ConfigurationCommandInput),
  ): Promise<AgentLoopSessionIdConfigurationCommandResult> => {
    let command = pending.get(key);
    if (!command) {
      const commandId = createRuntimeId("command");
      const body = typeof input === "function" ? input(commandId) : input;
      command = Object.freeze({
        ...body,
        commandId,
        uiIntentId: requiredText(createUiIntentId(), "ui intent id"),
        issuedAt: now(),
      }) as AgentLoopSessionIdConfigurationCommand;
      pending.set(key, command);
    }
    options.onCommandTrace?.(Object.freeze({
      uiIntentId: command.uiIntentId,
      commandId: command.commandId,
      intentKind: command.type,
    }));
    const result = await options.client.command(command);
    if (pending.get(key) === command) pending.delete(key);
    return result;
  };

  const readTemplateStudio = async (templateId?: string) => {
    const result = await options.client.readConfiguration({
      kind: "template_studio",
      ...(templateId ? { templateId: requiredText(templateId, "template id") } : {}),
    });
    if (result.kind !== "template_studio") throw new Error("agent_loop_session_id_configuration_read_mismatch");
    for (const draft of result.model.drafts) {
      durableTemplateFingerprints.set(draft.templateDraftId, templateEditorFingerprint({
        templateDraftId: draft.templateDraftId,
        revision: draft.revision,
        title: draft.title,
        slug: draft.slug,
        description: draft.description ?? "",
        definitionText: draft.definitionText,
      }));
    }
    return result.model;
  };

  const readTaskSetup = async (taskSetupDraftId: string) => {
    const result = await options.client.readConfiguration({
      kind: "task_setup",
      taskSetupDraftId: requiredText(taskSetupDraftId, "task setup draft id"),
    });
    if (result.kind !== "task_setup") throw new Error("agent_loop_session_id_configuration_read_mismatch");
    return result.model;
  };

  const readMeta = async (scope: AgentLoopMetaScope) => {
    const result = await options.client.readConfiguration({ kind: "meta", scope });
    if (result.kind !== "meta") throw new Error("agent_loop_session_id_configuration_read_mismatch");
    return result.model;
  };

  const readProviderSettings = async () => {
    const result = await options.client.readConfiguration({ kind: "provider_settings" });
    if (result.kind !== "provider_settings") throw new Error("agent_loop_session_id_configuration_read_mismatch");
    return result.model;
  };

  const meta: AgentLoopMetaPanelController = Object.freeze({
    load: readMeta,
    subscribe(onChanged) {
      return options.client.subscribeConfiguration(() => onChanged());
    },
    async createSession(input) {
      const target = metaTarget(input.scope);
      await issue(`meta.create_session:${targetKey(target)}:${input.metaProfileOptionId}`, {
        type: "meta.create_session",
        ownerId: options.ownerId,
        metaProfileOptionId: requiredText(input.metaProfileOptionId, "meta profile option id"),
        target,
      });
    },
    async sendMessage(input) {
      const content = requiredText(input.content, "meta message");
      const key = JSON.stringify(["meta.send_message", input.metaSessionId, input.expectedSessionRevision, input.scope.draftRevision, content]);
      await issue(key, (commandId) => ({
        type: "meta.send_message",
        ownerId: options.ownerId,
        metaSessionId: requiredText(input.metaSessionId, "meta session id"),
        expectedSessionRevision: input.expectedSessionRevision,
        expectedTargetRevision: input.scope.draftRevision,
        idempotencyKey: commandId,
        content,
      }));
    },
    async applyPatch(input) {
      const model = await readMeta(input.scope);
      const sessionId = requiredText(model.session?.metaSessionId ?? "", "meta session id");
      if (!model.proposals.some((proposal) => proposal.proposalId === input.proposalId)) {
        throw new Error("agent_loop_meta_patch_proposal_unavailable");
      }
      await issue(`meta.apply_patch:${input.proposalId}:${input.expectedDraftRevision}`, {
        type: "meta.apply_patch",
        ownerId: options.ownerId,
        metaSessionId: sessionId,
        metaPatchProposalId: requiredText(input.proposalId, "meta proposal id"),
        expectedTargetRevision: input.expectedDraftRevision,
      });
    },
    async rejectPatch(input) {
      const model = await readMeta(input.scope);
      const sessionId = requiredText(model.session?.metaSessionId ?? "", "meta session id");
      if (!model.proposals.some((proposal) => proposal.proposalId === input.proposalId)) {
        throw new Error("agent_loop_meta_patch_proposal_unavailable");
      }
      await issue(`meta.reject_patch:${input.proposalId}`, {
        type: "meta.reject_patch",
        ownerId: options.ownerId,
        metaSessionId: sessionId,
        metaPatchProposalId: requiredText(input.proposalId, "meta proposal id"),
      });
    },
    async abandonSession(input) {
      await issue(`meta.abandon_session:${input.metaSessionId}:${input.expectedSessionRevision}`, {
        type: "meta.abandon_session",
        ownerId: options.ownerId,
        metaSessionId: requiredText(input.metaSessionId, "meta session id"),
        expectedRevision: input.expectedSessionRevision,
      });
    },
  });

  const taskSetup = (taskSetupDraftIdValue: string): AgentLoopTaskSetupController => {
    const taskSetupDraftId = requiredText(taskSetupDraftIdValue, "task setup draft id");
    const load = () => readTaskSetup(taskSetupDraftId);
    return Object.freeze({
      load,
      subscribe(onChanged) {
        return options.client.subscribeConfiguration(() => onChanged());
      },
      async saveDraft(input: AgentLoopTaskSetupDraftInput) {
        assertBoundSetup(input.taskSetupDraftId, taskSetupDraftId);
        const view = await load();
        if (view.draft.revision !== input.expectedRevision) throw new Error("agent_loop_task_setup_revision_stale");
        await issue(`task_setup.save_draft:${taskSetupDraftId}:${input.expectedRevision}`, {
          type: "task_setup.save_draft",
          ownerId: options.ownerId,
          taskSetupDraftId,
          expectedRevision: input.expectedRevision,
          workspaceId: requiredText(input.workspaceId, "workspace id"),
          title: requiredText(input.title, "task title"),
          goal: requiredText(input.goal, "task goal"),
          taskInputValues: Object.freeze(view.draft.schemaFields.flatMap((field) => {
            const value = input.schemaValues[field.fieldId]?.trim();
            return value ? [Object.freeze({ fieldId: field.fieldId, value })] : [];
          })),
        });
        return load();
      },
      async createTask(input) {
        assertBoundSetup(input.taskSetupDraftId, taskSetupDraftId);
        const view = await load();
        if (view.draft.revision !== input.expectedRevision) throw new Error("agent_loop_task_setup_revision_stale");
        if (view.draft.state !== "draft") throw new Error("agent_loop_task_setup_draft_not_editable");
        const key = `task.create:${taskSetupDraftId}:${input.expectedRevision}`;
        const result = await issue(key, {
          type: "task.create",
          ownerId: options.ownerId,
          workspaceId: requiredText(view.draft.workspaceId ?? "", "workspace id"),
          taskSetupDraftId,
          expectedTaskSetupRevision: input.expectedRevision,
        });
        return requiredText(result.task?.taskId ?? "", "created task id");
      },
      async abandonDraft(input) {
        assertBoundSetup(input.taskSetupDraftId, taskSetupDraftId);
        await issue(`task_setup.abandon_draft:${taskSetupDraftId}:${input.expectedRevision}`, {
          type: "task_setup.abandon_draft",
          ownerId: options.ownerId,
          taskSetupDraftId,
          expectedRevision: input.expectedRevision,
        });
      },
    });
  };

  const configuration: AgentLoopConfigurationController = Object.freeze({
    meta,
    async createTaskSetupDraft(input: AgentLoopCreateTaskSetupDraftInput) {
      const result = await issue(
        `task_setup.create_draft:${input.templateVersionId}:${input.workspaceId}:${input.title}:${input.goal}`,
        {
          type: "task_setup.create_draft",
          ownerId: options.ownerId,
          templateVersionId: requiredText(input.templateVersionId, "template version id"),
          workspaceId: requiredText(input.workspaceId, "workspace id"),
          title: requiredText(input.title, "task title"),
          goal: requiredText(input.goal, "task goal"),
          taskInputValues: [],
        },
      );
      return requiredText(result.taskSetupDraft?.taskSetupDraftId ?? "", "task setup draft id");
    },
    taskSetup,
  });

  const templates: AgentLoopTemplateStudioSurfaceController = Object.freeze({
    supportsAcpTemplateV3: true,
    load: readTemplateStudio,
    subscribe(onChanged) {
      return options.client.subscribeConfiguration(() => onChanged());
    },
    async createDraft(editor) {
      const normalized = normalizeEditor(editor);
      const desiredDefinition = parseDefinition(normalized.definitionText);
      const result = await issue(`template.create_draft:${normalized.templateId ?? "new"}:${normalized.baseTemplateVersionId ?? "new"}:${normalized.slug}`, {
        type: "template.create_draft",
        ...(normalized.templateId ? { templateId: normalized.templateId } : {}),
        ...(normalized.baseTemplateVersionId ? { baseTemplateVersionId: normalized.baseTemplateVersionId } : {}),
        ownerId: options.ownerId,
        metadata: templateMetadata(normalized),
        initialDefinition: desiredDefinition,
      });
      const created = editorFromDraft(requiredDraft(result.templateDraft));
      if (normalized.baseTemplateVersionId
        && JSON.stringify(parseDefinition(created.definitionText)) !== JSON.stringify(desiredDefinition)) {
        return saveTemplateEditor(Object.freeze({
          ...created,
          title: normalized.title,
          slug: normalized.slug,
          description: normalized.description,
          definitionText: normalized.definitionText,
        }));
      }
      rememberDurableTemplate(created);
      return created;
    },
    async saveDraft(editor) {
      return saveTemplateEditor(editor);
    },
    async publishDraft(editor) {
      if (!editor.templateDraftId || editor.revision === undefined) {
        throw new Error("agent_loop_template_draft_publish_fence_missing");
      }
      const durable = normalizeEditor(editor);
      if (durableTemplateFingerprints.get(editor.templateDraftId) !== templateEditorFingerprint(durable)) {
        throw new Error("agent_loop_template_draft_unsaved_changes");
      }
      await issue(`template.publish_draft:${editor.templateDraftId}:${editor.revision}`, {
        type: "template.publish_draft",
        templateDraftId: editor.templateDraftId,
        expectedRevision: editor.revision,
        ...(durable.templateId ? { templateId: durable.templateId } : {}),
        slug: durable.slug,
        title: durable.title,
        ...(durable.description ? { description: durable.description } : {}),
      });
    },
    async archiveTemplate(templateId, expectedRevision) {
      await issue(`template.archive:${templateId}:${expectedRevision}`, {
        type: "template.archive",
        templateId: requiredText(templateId, "template id"),
        expectedRevision,
      });
    },
    async previewImport(file: AgentLoopTemplateImportFile): Promise<AgentLoopTemplateImportPreview> {
      const decoded = decodePortableTemplate(file);
      const templatePackage = validateTemplatePackage(decoded.package);
      const library = await readTemplateStudio();
      const identityExists = library.templates.some((template) =>
        template.templateId === templatePackage.template.templateId);
      const availableModes = Object.freeze(identityExists
        ? ["new_version"] as const
        : ["create"] as const);
      const importId = `template_import_preview_${createRuntimeId("command").slice("command_".length)}`;
      importCandidates.set(importId, Object.freeze({
        package: templatePackage,
        assets: Object.freeze(decoded.assets.map(copyTemplateAsset)),
        availableModes,
      }));
      return Object.freeze({
        importId,
        fileName: file.fileName,
        byteLength: file.bytes.byteLength,
        templateId: templatePackage.template.templateId,
        version: templatePackage.template.version,
        slug: templatePackage.template.slug,
        title: templatePackage.template.title,
        ...(templatePackage.template.description ? { description: templatePackage.template.description } : {}),
        assetCount: decoded.assets.length,
        availableModes,
      });
    },
    async importPreview(importId, mode) {
      const candidate = importCandidates.get(importId);
      if (!candidate) throw new Error("agent_loop_template_import_preview_unavailable");
      if (!candidate.availableModes.includes(mode)) throw new Error("agent_loop_template_import_mode_unavailable");
      await issue(`template.import:${importId}:${mode}`, {
        type: "template.import",
        package: candidate.package,
        ...(candidate.assets.length ? { assets: encodeTemplateAssetTransports(candidate.assets) } : {}),
        mode,
      });
      importCandidates.delete(importId);
    },
    discardImportPreview(importId) {
      importCandidates.delete(importId);
    },
    async exportVersion(templateVersionId): Promise<AgentLoopTemplateExport> {
      const result = await issue(`template.export:${templateVersionId}`, {
        type: "template.export",
        templateVersionId: requiredText(templateVersionId, "template version id"),
      });
      if (!result.templatePackage) throw new Error("agent_loop_template_export_result_missing");
      const assets = decodeTemplateAssetTransports(result.templateAssets);
      const baseName = `${result.templatePackage.template.slug}-v${result.templatePackage.template.version}`;
      return assets.length === 0
        ? Object.freeze({
          fileName: safeTemplateFileName(baseName, "yaml"),
          bytes: new TextEncoder().encode(serializeTemplatePackageYaml(result.templatePackage)),
          format: "yaml" as const,
        })
        : Object.freeze({
          fileName: safeTemplateFileName(baseName, "zip"),
          bytes: encodeTemplateArchive({ package: result.templatePackage, assets }),
          format: "zip" as const,
        });
    },
  });

  async function saveTemplateEditor(editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor> {
    if (!editor.templateDraftId || editor.revision === undefined) throw new Error("agent_loop_template_draft_not_saved");
    const normalized = normalizeEditor(editor);
    const result = await issue(`template.save_draft:${editor.templateDraftId}:${editor.revision}`, {
      type: "template.save_draft",
      templateDraftId: editor.templateDraftId,
      expectedRevision: editor.revision,
      metadata: templateMetadata(normalized),
      definition: parseDefinition(normalized.definitionText),
    });
    const saved = editorFromDraft(requiredDraft(result.templateDraft));
    rememberDurableTemplate(saved);
    return saved;
  }

  function rememberDurableTemplate(editor: AgentLoopTemplateDraftEditor): void {
    if (!editor.templateDraftId || editor.revision === undefined) return;
    durableTemplateFingerprints.set(editor.templateDraftId, templateEditorFingerprint(editor));
  }

  const providerSettings = Object.freeze({
    load: readProviderSettings,
    async discoverInstallation(providerFamily: ProviderFamily) {
      const result = await issue(`provider.discover_installation:${providerFamily}`, {
        type: "provider.discover_installation",
        providerFamily,
      });
      return result.providerSettings ?? readProviderSettings();
    },
    async configureInstallation(
      providerFamily: ProviderFamily,
      installation: AcpProviderInstallationInput,
    ) {
      const result = await issue(`provider.configure_installation:${providerFamily}:${JSON.stringify(installation)}`, {
        type: "provider.configure_installation",
        providerFamily,
        installation,
      });
      return result.providerSettings ?? readProviderSettings();
    },
    async refreshModels(providerFamily: ProviderFamily) {
      const result = await issue(`provider.probe_models:${providerFamily}`, {
        type: "provider.probe_models",
        providerFamily,
      });
      return result.providerSettings ?? readProviderSettings();
    },
    async configureChatModels(providerFamily: ProviderFamily, modelIds: readonly string[], defaultModelId: string) {
      const exactModelIds = Object.freeze(modelIds.map((modelId) => requiredText(modelId, "provider model id")));
      const exactDefaultModelId = requiredText(defaultModelId, "provider default model id");
      const result = await issue(`provider.configure_chat_models:${providerFamily}:${JSON.stringify(exactModelIds)}:${exactDefaultModelId}`, {
        type: "provider.configure_chat_models",
        providerFamily,
        modelIds: exactModelIds,
        defaultModelId: exactDefaultModelId,
      });
      return result.providerSettings ?? readProviderSettings();
    },
  });

  return Object.freeze({ configuration, templates, providerSettings });
}

function templateEditorFingerprint(editor: Readonly<{
  templateDraftId?: string;
  revision?: number;
  title: string;
  slug: string;
  description: string;
  definitionText: string;
}>): string {
  return JSON.stringify([
    editor.templateDraftId,
    editor.revision,
    editor.title,
    editor.slug,
    editor.description,
    editor.definitionText,
  ]);
}

function metaTarget(scope: AgentLoopMetaScope) {
  return scope.kind === "template_design"
    ? { kind: "template_draft" as const, templateDraftId: scope.draftId }
    : { kind: "task_setup_draft" as const, taskSetupDraftId: scope.draftId };
}

function targetKey(target: ReturnType<typeof metaTarget>): string {
  return target.kind === "template_draft" ? target.templateDraftId : target.taskSetupDraftId;
}

function normalizeEditor(editor: AgentLoopTemplateDraftEditor): AgentLoopTemplateDraftEditor {
  const slug = editor.slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error("agent_loop_template_slug_invalid");
  return Object.freeze({ ...editor, title: requiredText(editor.title, "template title"), slug, description: editor.description.trim() });
}

function templateMetadata(editor: AgentLoopTemplateDraftEditor) {
  return Object.freeze({ title: editor.title, slug: editor.slug, ...(editor.description ? { description: editor.description } : {}) });
}

function parseDefinition(source: string) {
  try {
    return validateTemplateDefinitionSnapshot(JSON.parse(source) as unknown);
  } catch (error) {
    throw new Error(`agent_loop_template_definition_invalid:${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredDraft(draft: TemplateDraftRecord | undefined): TemplateDraftRecord {
  if (!draft) throw new Error("agent_loop_template_draft_result_unavailable");
  return draft;
}

function editorFromDraft(draft: TemplateDraftRecord): AgentLoopTemplateDraftEditor {
  return Object.freeze({
    mode: "edit",
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(draft.baseTemplateVersionId ? { baseTemplateVersionId: draft.baseTemplateVersionId } : {}),
    templateDraftId: draft.templateDraftId,
    revision: draft.revision,
    title: draft.metadata.title,
    slug: draft.metadata.slug ?? "untitled-agent-loop",
    description: draft.metadata.description ?? "",
    definitionText: JSON.stringify(draft.definition, null, 2),
  });
}

function assertBoundSetup(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("agent_loop_task_setup_draft_scope_mismatch");
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function decodePortableTemplate(file: AgentLoopTemplateImportFile): Readonly<{
  package: TemplatePackage;
  assets: readonly TemplateArchiveAsset[];
}> {
  const fileName = file.fileName.trim().toLowerCase();
  if (fileName.endsWith(".zip")) {
    const archive = decodeTemplateArchive(file.bytes);
    return Object.freeze({ package: archive.package, assets: archive.assets });
  }
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) {
    return Object.freeze({
      package: parseTemplatePackageYaml(new TextDecoder().decode(file.bytes)),
      assets: Object.freeze([]),
    });
  }
  throw new Error("agent_loop_template_import_format_unsupported");
}

function copyTemplateAsset(asset: TemplateArchiveAsset): TemplateArchiveAsset {
  return Object.freeze({
    path: asset.path,
    bytes: Uint8Array.from(asset.bytes),
    ...(asset.contentType ? { contentType: asset.contentType } : {}),
  });
}

function safeTemplateFileName(baseName: string, extension: "yaml" | "zip"): string {
  const safe = baseName.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${safe || "agent-template"}.agent-template.${extension}`;
}
