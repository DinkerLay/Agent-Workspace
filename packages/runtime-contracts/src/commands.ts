import type {
  MetaPatchProposalId,
  MetaProfileOptionId,
  MetaSessionId,
  RuntimeCommandId,
  TaskId,
  TaskRunId,
  TaskSetupDraftId,
  TemplateDraftId,
  TemplateId,
  TemplateVersionId,
  WorkspaceId,
} from "./ids";
import type { RuntimeReadModel } from "./read-models";
import type {
  MetaPatchProposalRecord,
  MetaMessageRecord,
  MetaSessionRecord,
  MetaSessionTarget,
  RuntimeCommandReceipt,
  SessionPresentation,
  TaskRecord,
  TaskRunRecord,
  TaskSetupDraftRecord,
  TemplateDraftRecord,
  TemplateDraftMetadata,
} from "./records";
import type {
  ProviderFamily,
  TaskInputValue,
  TemplateAssetTransport,
  TemplateDefinitionSnapshot,
  TemplateDefinitionV3,
  TemplatePackage,
  TemplatePackageSnapshot,
} from "./templates";
import type { AcpProviderSettingsReadModel } from "./provider-settings";

export interface RuntimeCommandBase {
  readonly commandId: RuntimeCommandId;
  readonly issuedAt: string;
}

export interface CreateTemplateDraftCommand extends RuntimeCommandBase {
  readonly type: "template.create_draft";
  readonly templateId?: TemplateId;
  /**
   * Pins this Draft's origin to one immutable Version. Runtime resolves the
   * Version itself, rather than trusting a renderer-supplied copy.
   */
  readonly baseTemplateVersionId?: TemplateVersionId;
  readonly ownerId: string;
  readonly metadata: TemplateDraftMetadata;
  readonly initialDefinition: TemplateDefinitionSnapshot;
}

export interface SaveTemplateDraftCommand extends RuntimeCommandBase {
  readonly type: "template.save_draft";
  readonly templateDraftId: TemplateDraftId;
  readonly expectedRevision: number;
  readonly metadata: TemplateDraftMetadata;
  readonly definition: TemplateDefinitionSnapshot;
}

/** Explicit user-reviewed migration; the Runtime allocates the new Draft identity. */
export interface MigrateTemplateV2ToV3DraftCommand extends RuntimeCommandBase {
  readonly type: "template.migrate_v2_to_v3_draft";
  readonly ownerId: string;
  readonly sourceTemplateVersionId: TemplateVersionId;
  readonly expectedSourceDefinitionHash: string;
  readonly metadata: TemplateDraftMetadata;
  readonly definition: TemplateDefinitionV3;
}

export interface PublishTemplateDraftCommand extends RuntimeCommandBase {
  readonly type: "template.publish_draft";
  readonly templateDraftId: TemplateDraftId;
  readonly expectedRevision: number;
  readonly templateId?: TemplateId;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
}

export interface ArchiveTemplateCommand extends RuntimeCommandBase {
  readonly type: "template.archive";
  readonly templateId: TemplateId;
  readonly expectedRevision: number;
}

export interface ImportTemplateCommand extends RuntimeCommandBase {
  readonly type: "template.import";
  readonly package: TemplatePackage;
  /** Binary data remains JSON-safe at the Runtime Bridge boundary. */
  readonly assets?: readonly TemplateAssetTransport[];
  /** Import never overwrites a version; callers must explicitly pick an outcome. */
  readonly mode: "create" | "new_version";
}

/** Export is typed user intent; it reads an immutable Version and does not modify it. */
export interface ExportTemplateCommand extends RuntimeCommandBase {
  readonly type: "template.export";
  readonly templateVersionId: TemplateVersionId;
}

/**
 * Explicit user authorization of a local directory. The Host canonicalizes
 * and validates this candidate before persisting it; Task creation never
 * receives a raw directory path.
 */
export interface AuthorizeWorkspaceCommand extends RuntimeCommandBase {
  readonly type: "workspace.authorize";
  readonly workspaceId: WorkspaceId;
  readonly directory: string;
  readonly displayName?: string;
}

export interface CreateTaskSetupDraftCommand extends RuntimeCommandBase {
  readonly type: "task_setup.create_draft";
  readonly ownerId: string;
  readonly templateVersionId: TemplateVersionId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly goal: string;
  readonly taskInputValues: readonly TaskInputValue[];
}

export interface SaveTaskSetupDraftCommand extends RuntimeCommandBase {
  readonly type: "task_setup.save_draft";
  readonly ownerId: string;
  readonly taskSetupDraftId: TaskSetupDraftId;
  readonly expectedRevision: number;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly goal: string;
  readonly taskInputValues: readonly TaskInputValue[];
}

export interface AbandonTaskSetupDraftCommand extends RuntimeCommandBase {
  readonly type: "task_setup.abandon_draft";
  readonly ownerId: string;
  readonly taskSetupDraftId: TaskSetupDraftId;
  readonly expectedRevision: number;
}

export interface CreateMetaSessionCommand extends RuntimeCommandBase {
  readonly type: "meta.create_session";
  readonly ownerId: string;
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly target: MetaSessionTarget;
}

export interface AbandonMetaSessionCommand extends RuntimeCommandBase {
  readonly type: "meta.abandon_session";
  readonly ownerId: string;
  readonly metaSessionId: MetaSessionId;
  readonly expectedRevision: number;
}

export interface SendMetaMessageCommand extends RuntimeCommandBase {
  readonly type: "meta.send_message";
  readonly ownerId: string;
  readonly metaSessionId: MetaSessionId;
  readonly expectedSessionRevision: number;
  readonly expectedTargetRevision: number;
  readonly idempotencyKey: string;
  readonly content: string;
}

export interface ApplyMetaPatchCommand extends RuntimeCommandBase {
  readonly type: "meta.apply_patch";
  readonly ownerId: string;
  readonly metaSessionId: MetaSessionId;
  readonly metaPatchProposalId: MetaPatchProposalId;
  readonly expectedTargetRevision: number;
}

export interface RejectMetaPatchCommand extends RuntimeCommandBase {
  readonly type: "meta.reject_patch";
  readonly ownerId: string;
  readonly metaSessionId: MetaSessionId;
  readonly metaPatchProposalId: MetaPatchProposalId;
}

export interface CreateTaskCommand extends RuntimeCommandBase {
  readonly type: "task.create";
  readonly ownerId: string;
  readonly workspaceId: WorkspaceId;
  readonly taskSetupDraftId: TaskSetupDraftId;
  readonly expectedTaskSetupRevision: number;
}

export interface StartTaskCommand extends RuntimeCommandBase {
  readonly type: "task.start";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
}

/** User intent to begin a fresh Run after the active Run has reached a terminal release. */
export interface RestartTaskCommand extends RuntimeCommandBase {
  readonly type: "task.restart";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
}

export interface ResumeTaskCommand extends RuntimeCommandBase {
  readonly type: "task.resume";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
}

/** Explicit Host-owned ACP discovery. Reads never launch a Provider. */
export interface ProbeAcpProviderModelsCommand extends RuntimeCommandBase {
  readonly type: "provider.probe_models";
  readonly providerFamily: ProviderFamily;
}

export interface DiscoverAcpProviderInstallationCommand extends RuntimeCommandBase {
  readonly type: "provider.discover_installation";
  readonly providerFamily: ProviderFamily;
}

export type AcpProviderInstallationInput =
  | Readonly<{
      kind: "opencode";
      commandPath: string;
      authFilePath: string;
    }>
  | Readonly<{
      kind: "codex";
      codexPath: string;
      nodePath: string;
      authFilePath: string;
    }>
  | Readonly<{
      kind: "claude-code";
      claudePath: string;
      nodePath: string;
      settingsFilePath: string;
    }>;

/** Saves Host-private machine paths. Existing Sessions are never retargeted. */
export interface ConfigureAcpProviderInstallationCommand extends RuntimeCommandBase {
  readonly type: "provider.configure_installation";
  readonly providerFamily: ProviderFamily;
  readonly installation: AcpProviderInstallationInput;
}

/** Future Chat choices only; existing Templates/Sessions remain frozen. */
export interface ConfigureAcpProviderChatModelsCommand extends RuntimeCommandBase {
  readonly type: "provider.configure_chat_models";
  readonly providerFamily: ProviderFamily;
  readonly modelIds: readonly string[];
  readonly defaultModelId: string;
}

/** No generic append-event/raw-provider/PTY/filesystem escape hatch exists. */
export type RuntimeCommand =
  | CreateTemplateDraftCommand
  | SaveTemplateDraftCommand
  | MigrateTemplateV2ToV3DraftCommand
  | PublishTemplateDraftCommand
  | ArchiveTemplateCommand
  | ImportTemplateCommand
  | ExportTemplateCommand
  | AuthorizeWorkspaceCommand
  | CreateTaskSetupDraftCommand
  | SaveTaskSetupDraftCommand
  | AbandonTaskSetupDraftCommand
  | CreateMetaSessionCommand
  | AbandonMetaSessionCommand
  | SendMetaMessageCommand
  | ApplyMetaPatchCommand
  | RejectMetaPatchCommand
  | CreateTaskCommand
  | StartTaskCommand
  | RestartTaskCommand
  | ResumeTaskCommand
  | ProbeAcpProviderModelsCommand
  | DiscoverAcpProviderInstallationCommand
  | ConfigureAcpProviderInstallationCommand
  | ConfigureAcpProviderChatModelsCommand;

export interface RuntimeCommandResult {
  readonly receipt: RuntimeCommandReceipt;
  readonly readModel?: RuntimeReadModel;
  readonly task?: TaskRecord;
  readonly run?: TaskRunRecord;
  readonly taskSetupDraft?: TaskSetupDraftRecord;
  readonly templateDraft?: TemplateDraftRecord;
  readonly metaSession?: MetaSessionRecord;
  readonly metaMessage?: MetaMessageRecord;
  readonly metaPatchProposal?: MetaPatchProposalRecord;
  readonly templatePackage?: TemplatePackageSnapshot;
  readonly templateAssets?: readonly TemplateAssetTransport[];
  readonly presentation?: SessionPresentation;
  readonly providerSettings?: AcpProviderSettingsReadModel;
}
