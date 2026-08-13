import {
  type AcpProfileReadinessObservation,
  type CapabilityPolicy,
  type JsonObject,
  type TemplateDefinitionSnapshot,
} from "@agent-workspace/runtime-contracts";

export type AgentLoopTemplateImportMode = "create" | "new_version";

/** A renderer-selected portable template file; it has no filesystem authority. */
export type AgentLoopTemplateImportFile = Readonly<{
  fileName: string;
  bytes: Uint8Array;
}>;

export type AgentLoopTemplateExport = AgentLoopTemplateImportFile & Readonly<{
  format: "yaml" | "zip";
}>;

export type AgentLoopTemplateDraftEditor = Readonly<{
  mode: "new" | "edit";
  templateId?: string;
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
  definitionText: string;
}>;

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

/** One Host-issued portable Profile revision option; no local resolution data. */
export type AgentLoopTemplateProfileRevisionOption = Readonly<{
  title: string;
  sourceTemplateId: string;
  sourceTemplateVersionId: string;
  executionProfileId: string;
  role: "conductor" | "general" | "researcher" | "implementer" | "reviewer" | "publisher";
  profileRevisionId: string;
  providerFamily: "opencode" | "codex" | "claude-code";
  acpAgentKind: "native_acp" | "codex_acp" | "claude_agent_acp";
  protocolMajor: 1;
  model: string;
  /** True only when the current ACP Agent declared this model in a bounded session config catalog. */
  catalogObserved?: boolean;
  configIntent: JsonObject;
  requiredExtensions: readonly string[];
  capabilityPolicy: CapabilityPolicy;
  readiness: AcpProfileReadinessObservation;
}>;

export type AgentLoopTemplateStudioViewModel = Readonly<{
  generatedAt: string;
  templates: readonly AgentLoopTemplateStudioTemplate[];
  selectedTemplate?: AgentLoopTemplateStudioSelectedTemplate;
  drafts: readonly AgentLoopTemplateStudioDraft[];
  /** Absent on the pre-v3 bridge; the UI then remains honestly unavailable. */
  profileOptions?: readonly AgentLoopTemplateProfileRevisionOption[];
}>;

export type AgentLoopTemplateV3MigrationInput = Readonly<{
  sourceTemplateVersionId: string;
  expectedSourceDefinitionHash: string;
  profileSelections: readonly Readonly<{
    executionProfileId: string;
    profileRevisionId: string;
  }>[];
}>;

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

export type AgentLoopTemplateStudioUnsubscribe = () => Promise<void> | void;

export type AgentLoopTemplateStudioController = Readonly<{
  load(templateId?: string): Promise<AgentLoopTemplateStudioViewModel>;
  subscribe(onChanged: () => void): Promise<AgentLoopTemplateStudioUnsubscribe>;
  createDraft(editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor>;
  saveDraft(editor: AgentLoopTemplateDraftEditor): Promise<AgentLoopTemplateDraftEditor>;
  publishDraft(editor: AgentLoopTemplateDraftEditor): Promise<void>;
  previewImport(file: AgentLoopTemplateImportFile): Promise<AgentLoopTemplateImportPreview>;
  importPreview(importId: string, mode: AgentLoopTemplateImportMode): Promise<void>;
  discardImportPreview(importId: string): void;
  exportVersion(templateVersionId: string): Promise<AgentLoopTemplateExport>;
}>;

export type AgentLoopTemplateStudioSurfaceController =
  Omit<AgentLoopTemplateStudioController, "previewImport" | "importPreview" | "discardImportPreview" | "exportVersion">
  & Partial<Pick<AgentLoopTemplateStudioController, "previewImport" | "importPreview" | "discardImportPreview" | "exportVersion">>
  & Readonly<{
    archiveTemplate?(templateId: string, expectedRevision: number): Promise<void>;
    /** Set only after the typed v3 Template command/Store boundary is present. */
    supportsAcpTemplateV3?: true;
    /** Explicit v2 Version -> new v3 Draft intent; never mutates source bytes. */
    migrateVersionToAcpV3?(input: AgentLoopTemplateV3MigrationInput): Promise<AgentLoopTemplateDraftEditor>;
  }>;

/** Creates renderer-local form state; a new ACP Draft needs an explicit Host option selection. */
export function createAgentLoopTemplateDraftEditor(input: Readonly<{
  templateId?: string;
  baseTemplateVersionId?: string;
  title?: string;
  slug?: string;
  description?: string;
  definition?: TemplateDefinitionSnapshot;
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
    definitionText: input.definitionText ?? (input.definition ? JSON.stringify(input.definition, null, 2) : ""),
  });
}

/** Browser-only download convenience; the bytes already came from Runtime. */
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

function suggestedSlug(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "new-agent-loop";
}

function safeTemplateFileName(value: string, format: AgentLoopTemplateExport["format"]): string {
  const base = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^\.+$/, "") || "template";
  const stem = base.replace(/(?:\.agent-template)?\.(?:yaml|yml|zip)$/i, "") || "template";
  return `${stem}${format === "zip" ? ".agent-template.zip" : ".agent-template.yaml"}`;
}
