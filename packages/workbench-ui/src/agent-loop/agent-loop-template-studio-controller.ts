import {
  MANAGED_EXECUTION_CAPABILITIES,
  createId,
  decodeTemplateArchive,
  decodeTemplateAssetTransports,
  encodeTemplateArchive,
  encodeTemplateAssetTransports,
  hashDefinition,
  parseTemplatePackageYaml,
  serializeTemplatePackageYaml,
  validateTemplateDefinition,
  validateTemplatePackage,
  type RuntimeCommand,
  type RuntimeReadModel,
  type JsonValue,
  type TemplateArchiveAsset,
  type TemplateDefinition,
  type TemplateDraftRecord,
  type TemplatePackage,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeClient, RuntimeUnsubscribe } from "@agent-workspace/runtime-client";

export type AgentLoopTemplateImportMode = "create" | "new_version";

/** A renderer-selected portable template file; it has no filesystem authority. */
export type AgentLoopTemplateImportFile = Readonly<{
  fileName: string;
  bytes: Uint8Array;
}>;

export type AgentLoopTemplateExport = AgentLoopTemplateImportFile & Readonly<{
  format: "yaml" | "zip";
}>;

/**
 * Renderer-local edit state. A published Version is never edited in place:
 * `templateDraftId` identifies the separate, revision-fenced Draft.
 */
export type AgentLoopTemplateDraftEditor = Readonly<{
  mode: "new" | "edit";
  templateId?: string;
  /** Immutable Version from which this Draft was explicitly created. */
  baseTemplateVersionId?: string;
  templateDraftId?: string;
  revision?: number;
  title: string;
  slug: string;
  description: string;
  definitionText: string;
}>;

export type AgentLoopTemplateVersion = Readonly<{
  templateVersionId: string;
  version: number;
  definitionHash: string;
  assetManifestHash?: string;
  createdAt: string;
  publishedAt: string;
  /** User-owned Template content, not a Provider transcript or native identity. */
  definitionText: string;
}>;

/** The active Version projected in the library summary. */
export type AgentLoopTemplateCurrentVersion = AgentLoopTemplateVersion;

export type AgentLoopTemplateStudioTemplate = Readonly<{
  templateId: string;
  title: string;
  slug: string;
  description?: string;
  revision: number;
  archivedAt?: string;
  currentVersion?: AgentLoopTemplateCurrentVersion;
}>;

/** A focused Template read: one identity plus all immutable Version choices. */
export type AgentLoopTemplateStudioSelectedTemplate = Readonly<{
  templateId: string;
  title: string;
  slug: string;
  description?: string;
  revision: number;
  archivedAt?: string;
  activeTemplateVersionId?: string;
  versions: readonly AgentLoopTemplateVersion[];
}>;

export type AgentLoopTemplateStudioDraft = Readonly<{
  templateDraftId: string;
  templateId?: string;
  baseTemplateVersionId?: string;
  revision: number;
  title: string;
  slug: string;
  description?: string;
  definitionText: string;
  updatedAt: string;
}>;

export type AgentLoopTemplateStudioViewModel = Readonly<{
  generatedAt: string;
  templates: readonly AgentLoopTemplateStudioTemplate[];
  /** Present only after a focused Runtime read for one selected Template. */
  selectedTemplate?: AgentLoopTemplateStudioSelectedTemplate;
  /** Only the current owner’s editable Drafts are projected into this Studio. */
  drafts: readonly AgentLoopTemplateStudioDraft[];
}>;

/** A validated, short-lived candidate. Import remains a second, explicit user action. */
export type AgentLoopTemplateImportPreview = Readonly<{
  importId: string;
  fileName: string;
  byteLength: number;
  templateId: string;
  version: number;
  slug: string;
  title: string;
  description?: string;
  assetCount: number;
  availableModes: readonly AgentLoopTemplateImportMode[];
}>;

export type AgentLoopTemplateStudioController = Readonly<{
  load(templateId?: string): Promise<AgentLoopTemplateStudioViewModel>;
  subscribe(onChanged: () => void): Promise<RuntimeUnsubscribe>;
  createDraft(editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor>;
  saveDraft(editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor>;
  /** Publishes a new immutable Version only after persisting the current Draft. */
  publishDraft(editor: AgentLoopTemplateDraftEditor): Promise<void>;
  previewImport(file: AgentLoopTemplateImportFile): Promise<AgentLoopTemplateImportPreview>;
  importPreview(importId: string, mode: AgentLoopTemplateImportMode): Promise<void>;
  discardImportPreview(importId: string): void;
  exportVersion(templateVersionId: string): Promise<AgentLoopTemplateExport>;
}>;

export type AgentLoopTemplateStudioControllerOptions = Readonly<{
  client: RuntimeClient;
  ownerId: string;
  now?: () => string;
  /** Test seam only; production receives opaque Runtime ids from the contract. */
  createRuntimeId?: typeof createId;
}>;

type RuntimeCommandInput = RuntimeCommand extends infer Command
  ? Command extends { readonly commandId: string; readonly issuedAt: string }
    ? Omit<Command, "commandId" | "issuedAt">
    : never
  : never;

type TemplateImportCandidate = Readonly<{
  package: TemplatePackage;
  assets: readonly TemplateArchiveAsset[];
  availableModes: readonly AgentLoopTemplateImportMode[];
}>;

/**
 * The only side-effect adapter for the AgentLoop Template Studio.
 *
 * It deliberately does not depend on the generic Workbench controller, legacy
 * native bridge, Provider SDK, PTY, or filesystem. The browser merely hands a
 * selected file’s bytes here; Runtime remains the sole Template writer.
 */
export function createAgentLoopTemplateStudioController(
  options: AgentLoopTemplateStudioControllerOptions,
): AgentLoopTemplateStudioController {
  const now = options.now ?? (() => new Date().toISOString());
  const createRuntimeId = options.createRuntimeId ?? createId;
  const pendingCommandIds = new Map<string, string>();
  const importCandidates = new Map<string, TemplateImportCandidate>();

  const issue = async <Result>(key: string, command: RuntimeCommandInput): Promise<Result> => {
    const commandId = pendingCommandIds.get(key) ?? createRuntimeId("command");
    pendingCommandIds.set(key, commandId);
    try {
      const result = await options.client.command(withCommandEnvelope(command, now, commandId));
      pendingCommandIds.delete(key);
      return result as Result;
    } catch (error) {
      // The next explicit retry gets the same command id. Runtime can then
      // reconcile an ambiguous transport outcome instead of duplicating a
      // Version or import.
      throw error;
    }
  };

  const findOwnedEditingDraft = async (
    slug: string,
    templateId?: string,
    baseTemplateVersionId?: string,
    required = true,
  ): Promise<TemplateDraftRecord | undefined> => {
    const model = await options.client.read();
    const matching = model.templateLibrary.drafts.filter((draft) =>
      draft.ownerId === options.ownerId
      && draft.status === "editing"
      && draft.metadata.slug === slug
      && draft.templateId === templateId
      && draft.baseTemplateVersionId === baseTemplateVersionId,
    );
    if (matching.length === 1) return matching[0];
    if (!required && matching.length === 0) return undefined;
    throw new Error(matching.length > 1 ? "agent_loop_template_draft_ambiguous" : "agent_loop_template_draft_unavailable");
  };

  const requireDraft = async (templateDraftId: string): Promise<TemplateDraftRecord> => {
    const model = await options.client.read();
    const draft = model.templateLibrary.drafts.find((candidate) =>
      candidate.templateDraftId === templateDraftId
      && candidate.ownerId === options.ownerId
      && candidate.status === "editing",
    );
    if (!draft) throw new Error("agent_loop_template_draft_unavailable");
    return draft;
  };

  const requireBaseVersion = async (editor: AgentLoopTemplateDraftEditor) => {
    if (!editor.baseTemplateVersionId) return undefined;
    if (!editor.templateId) throw new Error("agent_loop_template_base_version_template_required");
    const model = await options.client.read({ templateId: editor.templateId });
    const selected = model.template;
    if (!selected || selected.template.templateId !== editor.templateId) {
      throw new Error("agent_loop_template_version_history_unavailable");
    }
    const version = selected.versions.find((candidate) =>
      candidate.templateVersionId === editor.baseTemplateVersionId,
    );
    if (!version) throw new Error("agent_loop_template_base_version_unavailable");
    return version;
  };

  const createDraft = async (editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor> => {
    const normalized = normalizeEditor(editor);
    // Validate before any mutation so an invalid editor never leaves a new
    // durable Draft behind.  A Version-derived Draft itself is then created
    // from Runtime's immutable definition, followed by a fenced save only if
    // the user already changed that local editor.
    const desiredDefinition = parseDraftDefinition(normalized.definitionText);
    const baseVersion = await requireBaseVersion(normalized);
    const existing = await findOwnedEditingDraft(
      normalized.slug,
      normalized.templateId,
      normalized.baseTemplateVersionId,
      false,
    );
    if (existing) return editorFromDraft(existing);

    await issue<void>(`template.create_draft:${normalized.templateId ?? "new"}:${normalized.baseTemplateVersionId ?? "new"}:${normalized.slug}`, {
      type: "template.create_draft",
      ...(normalized.templateId ? { templateId: normalized.templateId } : {}),
      ...(baseVersion ? { baseTemplateVersionId: baseVersion.templateVersionId } : {}),
      ownerId: options.ownerId,
      metadata: draftMetadata(normalized),
      initialDefinition: baseVersion?.definition ?? desiredDefinition,
    });
    const created = await findOwnedEditingDraft(
      normalized.slug,
      normalized.templateId,
      normalized.baseTemplateVersionId,
    );
    if (!created) throw new Error("agent_loop_template_draft_unavailable");
    const persisted = editorFromDraft(created);
    return draftMatchesEditor(created, normalized, desiredDefinition)
      ? persisted
      : saveDraft(Object.freeze({ ...persisted, ...normalized }));
  };

  const saveDraft = async (editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor> => {
    if (!editor.templateDraftId || editor.revision === undefined) {
      throw new Error("agent_loop_template_draft_not_saved");
    }
    const normalized = normalizeEditor(editor);
    await issue<void>(`template.save_draft:${editor.templateDraftId}:${editor.revision}`, {
      type: "template.save_draft",
      templateDraftId: editor.templateDraftId,
      expectedRevision: editor.revision,
      metadata: draftMetadata(normalized),
      definition: parseDraftDefinition(normalized.definitionText),
    });
    return editorFromDraft(await requireDraft(editor.templateDraftId));
  };

  return Object.freeze({
    async load(templateId) {
      return toAgentLoopTemplateStudioViewModel(
        await options.client.read(templateId ? { templateId } : {}),
        options.ownerId,
      );
    },
    async subscribe(onChanged) {
      return options.client.subscribe({}, () => onChanged());
    },
    createDraft,
    saveDraft,
    async publishDraft(editor) {
      // Saving first is intentional: Publish operates only on a durable Draft
      // revision, never on a renderer-only textarea value.
      const durableDraft = editor.templateDraftId ? await saveDraft(editor) : await createDraft(editor);
      if (!durableDraft.templateDraftId || durableDraft.revision === undefined) {
        throw new Error("agent_loop_template_draft_publish_fence_missing");
      }
      assertManagedProfileReady(parseDraftDefinition(durableDraft.definitionText));
      await issue<void>(`template.publish_draft:${durableDraft.templateDraftId}:${durableDraft.revision}`, {
        type: "template.publish_draft",
        templateDraftId: durableDraft.templateDraftId,
        expectedRevision: durableDraft.revision,
        ...(durableDraft.templateId ? { templateId: durableDraft.templateId } : {}),
        slug: durableDraft.slug,
        title: durableDraft.title,
        ...(durableDraft.description ? { description: durableDraft.description } : {}),
      });
    },
    async previewImport(file) {
      const decoded = decodePortableTemplate(file);
      const templatePackage = validateTemplatePackage(decoded.package);
      assertManagedProfileReady(templatePackage.definition);
      const library = await options.client.read();
      const identityExists = library.templateLibrary.templates.some(({ template }) =>
        template.templateId === templatePackage.template.templateId,
      );
      const availableModes = Object.freeze(identityExists
        ? ["new_version"] as const
        : ["create"] as const);
      const importId = `template_import_preview_${createRuntimeId("command").slice("command_".length)}`;
      importCandidates.set(importId, Object.freeze({
        package: templatePackage,
        assets: Object.freeze(decoded.assets.map(copyAsset)),
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
      await issue<void>(`template.import:${importId}:${mode}`, {
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
    async exportVersion(templateVersionId) {
      const result = await issue<Awaited<ReturnType<RuntimeClient["command"]>>>(
        `template.export:${templateVersionId}`,
        { type: "template.export", templateVersionId },
      );
      if (!result.templatePackage) throw new Error("agent_loop_template_export_result_missing");
      const assets = decodeTemplateAssetTransports(result.templateAssets);
      const baseName = `${result.templatePackage.template.slug}-v${result.templatePackage.template.version}`;
      if (assets.length === 0) {
        return Object.freeze({
          fileName: safeTemplateFileName(baseName, "yaml"),
          bytes: new TextEncoder().encode(serializeTemplatePackageYaml(result.templatePackage)),
          format: "yaml" as const,
        });
      }
      return Object.freeze({
        fileName: safeTemplateFileName(baseName, "zip"),
        bytes: encodeTemplateArchive({ package: result.templatePackage, assets }),
        format: "zip" as const,
      });
    },
  });
}

/** Creates a v2-only Draft form; it deliberately does not mint a Version. */
export function createAgentLoopTemplateDraftEditor(input: Readonly<{
  templateId?: string;
  baseTemplateVersionId?: string;
  title?: string;
  slug?: string;
  description?: string;
  definition?: TemplateDefinition;
  /** A prior Runtime-projected JSON definition; validation happens on save. */
  definitionText?: string;
}> = {}): AgentLoopTemplateDraftEditor {
  const title = input.title?.trim() || "Untitled Agent Loop";
  return Object.freeze({
    mode: input.templateId ? "edit" : "new",
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(input.baseTemplateVersionId ? { baseTemplateVersionId: input.baseTemplateVersionId } : {}),
    title,
    slug: input.slug?.trim() || suggestedSlug(title),
    description: input.description ?? "",
    definitionText: input.definitionText ?? JSON.stringify(input.definition ?? defaultV2Definition(), null, 2),
  });
}

/** Pure Runtime read-model projection for the dedicated AgentLoop Template Studio. */
export function toAgentLoopTemplateStudioViewModel(
  model: RuntimeReadModel,
  ownerId: string,
): AgentLoopTemplateStudioViewModel {
  const templates = model.templateLibrary.templates.map(({ template, activeVersion }) => Object.freeze({
    templateId: template.templateId,
    title: template.title,
    slug: template.slug,
    ...(template.description ? { description: template.description } : {}),
    revision: template.revision,
    ...(template.archivedAt ? { archivedAt: template.archivedAt } : {}),
    ...(activeVersion ? {
      currentVersion: Object.freeze({
        templateVersionId: activeVersion.templateVersionId,
        version: activeVersion.version,
        definitionHash: activeVersion.definitionHash,
        ...(activeVersion.assetManifestHash ? { assetManifestHash: activeVersion.assetManifestHash } : {}),
        createdAt: activeVersion.createdAt,
        publishedAt: activeVersion.publishedAt,
        definitionText: JSON.stringify(activeVersion.definition, null, 2),
      }),
    } : {}),
  }));
  const selectedTemplate = model.template ? Object.freeze({
    templateId: model.template.template.templateId,
    title: model.template.template.title,
    slug: model.template.template.slug,
    ...(model.template.template.description ? { description: model.template.template.description } : {}),
    revision: model.template.template.revision,
    ...(model.template.template.archivedAt ? { archivedAt: model.template.template.archivedAt } : {}),
    ...(model.template.template.activeVersionId ? { activeTemplateVersionId: model.template.template.activeVersionId } : {}),
    versions: Object.freeze(model.template.versions.map((version) => toAgentLoopTemplateVersion(version))),
  }) : undefined;
  const drafts = model.templateLibrary.drafts
    .filter((draft) => draft.ownerId === ownerId && draft.status === "editing")
    .map((draft) => Object.freeze({
      templateDraftId: draft.templateDraftId,
      ...(draft.templateId ? { templateId: draft.templateId } : {}),
      ...(draft.baseTemplateVersionId ? { baseTemplateVersionId: draft.baseTemplateVersionId } : {}),
      revision: draft.revision,
      title: draft.metadata.title,
      // A Draft may intentionally prepare a future identity slug. Do not
      // replace that user-authored value with the active Version's slug.
      slug: draft.metadata.slug ?? suggestedSlug(draft.metadata.title),
      ...(draft.metadata.description ? { description: draft.metadata.description } : {}),
      definitionText: JSON.stringify(draft.definition, null, 2),
      updatedAt: draft.updatedAt,
    }));
  return Object.freeze({
    generatedAt: model.generatedAt,
    templates: Object.freeze(templates),
    ...(selectedTemplate ? { selectedTemplate } : {}),
    drafts: Object.freeze(drafts),
  });
}

function toAgentLoopTemplateVersion(version: Readonly<{
  templateVersionId: string;
  version: number;
  definitionHash: string;
  assetManifestHash?: string;
  createdAt: string;
  publishedAt: string;
  definition: TemplateDefinition;
}>): AgentLoopTemplateVersion {
  return Object.freeze({
    templateVersionId: version.templateVersionId,
    version: version.version,
    definitionHash: version.definitionHash,
    ...(version.assetManifestHash ? { assetManifestHash: version.assetManifestHash } : {}),
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
    definitionText: JSON.stringify(version.definition, null, 2),
  });
}

/** Browser-side convenience only; it never crosses the Runtime boundary. */
export function downloadAgentLoopTemplateExport(
  templateExport: AgentLoopTemplateExport,
  documentRef: Document = document,
): void {
  const bytes = new Uint8Array(templateExport.bytes);
  const blob = new Blob([bytes.buffer], {
    type: templateExport.format === "zip" ? "application/zip" : "application/yaml;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = documentRef.createElement("a");
  link.href = url;
  link.download = safeTemplateFileName(templateExport.fileName, templateExport.format);
  link.style.display = "none";
  documentRef.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function editorFromDraft(draft: TemplateDraftRecord): AgentLoopTemplateDraftEditor {
  return Object.freeze({
    mode: "edit",
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(draft.baseTemplateVersionId ? { baseTemplateVersionId: draft.baseTemplateVersionId } : {}),
    templateDraftId: draft.templateDraftId,
    revision: draft.revision,
    title: draft.metadata.title,
    slug: draft.metadata.slug ?? suggestedSlug(draft.metadata.title),
    description: draft.metadata.description ?? "",
    definitionText: JSON.stringify(draft.definition, null, 2),
  });
}

function draftMatchesEditor(
  draft: TemplateDraftRecord,
  editor: AgentLoopTemplateDraftEditor,
  definition: TemplateDefinition,
): boolean {
  return draft.metadata.title === editor.title
    && (draft.metadata.slug ?? suggestedSlug(draft.metadata.title)) === editor.slug
    && (draft.metadata.description ?? "") === editor.description
    && hashDefinition(draft.definition as unknown as JsonValue) === hashDefinition(definition as unknown as JsonValue);
}

function normalizeEditor(editor: AgentLoopTemplateDraftEditor): AgentLoopTemplateDraftEditor {
  return Object.freeze({
    ...editor,
    title: requiredText(editor.title, "template_title"),
    slug: requiredSlug(editor.slug),
    description: editor.description.trim(),
  });
}

function draftMetadata(editor: AgentLoopTemplateDraftEditor) {
  return {
    title: editor.title,
    slug: editor.slug,
    ...(editor.description ? { description: editor.description } : {}),
  };
}

function parseDraftDefinition(source: string): TemplateDefinition {
  try {
    return validateTemplateDefinition(JSON.parse(source) as unknown);
  } catch (error) {
    throw new Error(`agent_loop_template_definition_invalid:${messageFor(error)}`);
  }
}

function assertManagedProfileReady(definition: TemplateDefinition): void {
  const ready = definition.executionProfiles.every((profile) =>
    configuredProfileValue(profile.model)
    && configuredProfileValue(profile.providerVersion)
    && configuredProfileValue(profile.protocolFingerprint)
    && MANAGED_EXECUTION_CAPABILITIES.every((capability) => profile.capabilityPolicy.requiredCapabilities.includes(capability)),
  );
  if (!ready) throw new Error("agent_loop_template_execution_profile_incomplete");
}

function configuredProfileValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "configure-me" && normalized !== "select-provider";
}

function decodePortableTemplate(file: AgentLoopTemplateImportFile): Readonly<{
  package: TemplatePackage;
  assets: readonly TemplateArchiveAsset[];
}> {
  const fileName = file.fileName.trim().toLowerCase();
  if (fileName.endsWith(".zip")) {
    const archive = decodeTemplateArchive(file.bytes);
    return { package: archive.package, assets: archive.assets };
  }
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) {
    return {
      package: parseTemplatePackageYaml(new TextDecoder().decode(file.bytes)),
      assets: [],
    };
  }
  throw new Error("agent_loop_template_import_format_unsupported");
}

function copyAsset(asset: TemplateArchiveAsset): TemplateArchiveAsset {
  return {
    path: asset.path,
    bytes: Uint8Array.from(asset.bytes),
    ...(asset.contentType ? { contentType: asset.contentType } : {}),
  };
}

function defaultV2Definition(): TemplateDefinition {
  return validateTemplateDefinition({
    schemaVersion: 2,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_default",
      systemPrompt: "Coordinate the task from durable Runtime evidence and dispatch bounded card work.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "general",
      title: "Worker",
      executionProfileId: "profile_default",
      systemPrompt: "Complete only the scoped objective and return verifiable results.",
      capabilityRefs: [],
      dispatchProfile: {
        title: "Scoped work",
        description: "Use for one bounded assignment with explicit acceptance criteria.",
      },
    }],
    executionProfiles: [{
      executionProfileId: "profile_default",
      provider: "codex",
      model: "configure-me",
      providerVersion: "configure-me",
      protocolFingerprint: "configure-me",
      capabilityPolicy: {
        requiredCapabilities: [...MANAGED_EXECUTION_CAPABILITIES],
        allowedTools: [],
        permissionMode: "ask",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    }],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{
      artifactPath: "artifacts/result.md",
      ownerAgentCardId: "agent_card_worker",
      description: "The worker’s verifiable result.",
    }],
  });
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function requiredSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error("agent_loop_template_slug_invalid");
  }
  return normalized;
}

function suggestedSlug(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "new-agent-loop";
}

function safeTemplateFileName(value: string, format: AgentLoopTemplateExport["format"]): string {
  const base = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^\.+$/, "") || "template";
  const stem = base.replace(/(?:\.agent-template)?\.(?:yaml|yml|zip)$/i, "") || "template";
  return `${stem}${format === "zip" ? ".agent-template.zip" : ".agent-template.yaml"}`;
}

function withCommandEnvelope(command: RuntimeCommandInput, now: () => string, commandId: string): RuntimeCommand {
  return { ...command, commandId, issuedAt: now() } as RuntimeCommand;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
