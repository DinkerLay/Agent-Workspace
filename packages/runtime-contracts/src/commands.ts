import type {
  AgentCardId,
  AttentionId,
  ArtifactId,
  HumanInterventionId,
  InputSubmissionId,
  InvocationId,
  LogicalSessionId,
  MetaPatchProposalId,
  MetaProfileOptionId,
  MetaSessionId,
  ProviderSessionBindingId,
  PresentationLeaseId,
  RelayBlockId,
  RuntimeCommandId,
  SessionMessageId,
  SessionTurnId,
  TaskId,
  TaskRunId,
  TaskSetupDraftId,
  TemplateDraftId,
  TemplateId,
  TemplateVersionId,
  WorkspaceId,
} from "./ids";
import type { JsonObject } from "./json";
import type {
  ArtifactPreviewReadModel,
  RuntimeReadModel,
  TaskPermanentDeletePreview,
  TaskPermanentDeleteResult,
} from "./read-models";
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
  TemplateDraftMetadata,
} from "./records";
import type { TaskInputValue, TemplateAssetTransport, TemplateDefinition, TemplatePackage } from "./templates";

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
  readonly initialDefinition: TemplateDefinition;
}

export interface SaveTemplateDraftCommand extends RuntimeCommandBase {
  readonly type: "template.save_draft";
  readonly templateDraftId: TemplateDraftId;
  readonly expectedRevision: number;
  readonly metadata: TemplateDraftMetadata;
  readonly definition: TemplateDefinition;
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
  readonly taskId: TaskId;
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

export interface SubmitTaskInputCommand extends RuntimeCommandBase {
  readonly type: "task.submit_input";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly targetLogicalSessionId: LogicalSessionId;
  readonly content: string;
}

/**
 * A caller can intentionally disclose a complete Message, or route only one
 * of its already-extracted RelayBlocks. It can never submit provider-native
 * text, Artifact bytes, paths, or an arbitrary context reference.
 */
export type MessageSelection =
  | {
      readonly kind: "full_message";
      readonly sourceMessageId: SessionMessageId;
    }
  | {
      readonly kind: "relay_block";
      readonly sourceMessageId: SessionMessageId;
      readonly relayBlockId: RelayBlockId;
    };

export interface InvokeAgentCommand extends RuntimeCommandBase {
  readonly type: "invocation.invoke_agent";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  /** The scoped parent Session that is allowed to create this child invocation. */
  readonly sourceLogicalSessionId: LogicalSessionId;
  readonly decidedBySessionTurnId: SessionTurnId;
  readonly idempotencyKey: string;
  readonly invocationId: InvocationId;
  readonly agentCardId: AgentCardId;
  readonly instruction: string;
  readonly messageSelections: readonly MessageSelection[];
  readonly acceptanceCriteria: readonly string[];
  readonly requestedArtifacts?: readonly string[];
  readonly priority?: "low" | "normal" | "high";
}

/**
 * A normal Agent-to-Agent relay. Unlike invoke_agent it creates neither a
 * child Invocation nor a Provider-to-Provider connection.
 */
export interface RelayMessageCommand extends RuntimeCommandBase {
  readonly type: "session.relay_message";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly sourceLogicalSessionId: LogicalSessionId;
  readonly decidedBySessionTurnId: SessionTurnId;
  readonly idempotencyKey: string;
  readonly targetAgentCardId: AgentCardId;
  readonly messageSelections: readonly MessageSelection[];
}

export interface PublishMessageCommand extends RuntimeCommandBase {
  readonly type: "session.publish_message";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly sourceLogicalSessionId: LogicalSessionId;
  readonly decidedBySessionTurnId: SessionTurnId;
  readonly idempotencyKey: string;
  readonly fanoutKey: string;
  readonly targetAgentCardIds: readonly AgentCardId[];
  readonly messageSelections: readonly MessageSelection[];
}

/** Authenticated user intent; Runtime, not Renderer, establishes initiator=human. */
export interface SendHumanMessageCommand extends RuntimeCommandBase {
  readonly type: "session.send_human_message";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly humanInterventionId: HumanInterventionId;
  readonly idempotencyKey: string;
  readonly targetLogicalSessionId: LogicalSessionId;
  readonly content: string;
}

export interface RequestSessionInterruptCommand extends RuntimeCommandBase {
  readonly type: "session.request_interrupt";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly idempotencyKey: string;
  readonly targetLogicalSessionId: LogicalSessionId;
  readonly sessionTurnId: SessionTurnId;
}

export interface RespondAttentionCommand extends RuntimeCommandBase {
  readonly type: "attention.respond";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly attentionId: AttentionId;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly nativeRequestId: string;
  readonly activeInputSubmissionId?: InputSubmissionId;
  readonly activeInvocationId?: InvocationId;
  readonly response: JsonObject;
}

export interface StopTaskCommand extends RuntimeCommandBase {
  readonly type: "task.stop";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly bindingIds: readonly ProviderSessionBindingId[];
}

export interface AchieveTaskCommand extends RuntimeCommandBase {
  readonly type: "task.achieve";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly acceptedArtifactIds: readonly string[];
  readonly acceptanceNote?: string;
}

/** Move an explicitly Achieved, quiescent Task to the preserved recycle bin. */
export interface ArchiveTaskCommand extends RuntimeCommandBase {
  readonly type: "task.archive";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
}

/** Restore the same Task, Run, bindings and Artifact records from recycle bin. */
export interface RestoreTaskCommand extends RuntimeCommandBase {
  readonly type: "task.restore";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
}

/**
 * Renderer asks for a safe, path-free view of every managed Artifact that
 * could be selected for permanent deletion. The Host validates current bytes;
 * the command never accepts a filesystem path.
 */
export interface PreviewTaskPermanentDeleteCommand extends RuntimeCommandBase {
  readonly type: "task.preview_permanent_delete";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
}

/**
 * Deletes Runtime Task state and, only for the selected registered Artifact
 * identities, asks the Host to remove unchanged workspace files. Empty
 * selection intentionally preserves all files while deleting Task history.
 */
export interface PermanentlyDeleteTaskCommand extends RuntimeCommandBase {
  readonly type: "task.permanently_delete";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly artifactIds: readonly ArtifactId[];
}

/** Safe content preview of one already registered Artifact identity. */
export interface PreviewArtifactCommand extends RuntimeCommandBase {
  readonly type: "artifact.preview";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly artifactId: ArtifactId;
}

/**
 * Conductor-scoped request to verify one file that a returned Invocation was
 * explicitly asked to produce and declared in its canonical final Message.
 * Runtime derives the Artifact identity and all remaining provenance.
 */
export interface VerifyRequestedArtifactCommand extends RuntimeCommandBase {
  readonly type: "artifact.verify_requested";
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly runId: TaskRunId;
  readonly sourceLogicalSessionId: LogicalSessionId;
  readonly decidedBySessionTurnId: SessionTurnId;
  readonly idempotencyKey: string;
  readonly sourceInvocationId: InvocationId;
  readonly workspaceRelativePath: string;
}

export interface OpenSessionPresentationCommand extends RuntimeCommandBase {
  readonly type: "presentation.open";
  readonly taskId: TaskId;
  readonly bindingId: ProviderSessionBindingId;
}

export interface ReleaseSessionPresentationCommand extends RuntimeCommandBase {
  readonly type: "presentation.release";
  readonly presentationLeaseId: PresentationLeaseId;
}

/** No generic append-event/raw-provider/PTY/filesystem escape hatch exists. */
export type RuntimeCommand =
  | CreateTemplateDraftCommand
  | SaveTemplateDraftCommand
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
  | SubmitTaskInputCommand
  | InvokeAgentCommand
  | RelayMessageCommand
  | PublishMessageCommand
  | SendHumanMessageCommand
  | RequestSessionInterruptCommand
  | RespondAttentionCommand
  | StopTaskCommand
  | AchieveTaskCommand
  | ArchiveTaskCommand
  | RestoreTaskCommand
  | PreviewTaskPermanentDeleteCommand
  | PermanentlyDeleteTaskCommand
  | VerifyRequestedArtifactCommand
  | PreviewArtifactCommand
  | OpenSessionPresentationCommand
  | ReleaseSessionPresentationCommand;

export interface RuntimeCommandResult {
  readonly receipt: RuntimeCommandReceipt;
  readonly artifactId?: ArtifactId;
  readonly readModel?: RuntimeReadModel;
  readonly task?: TaskRecord;
  readonly run?: TaskRunRecord;
  readonly taskSetupDraft?: TaskSetupDraftRecord;
  readonly metaSession?: MetaSessionRecord;
  readonly metaMessage?: MetaMessageRecord;
  readonly metaPatchProposal?: MetaPatchProposalRecord;
  readonly templatePackage?: TemplatePackage;
  readonly templateAssets?: readonly TemplateAssetTransport[];
  readonly presentation?: SessionPresentation;
  readonly artifactPreview?: ArtifactPreviewReadModel;
  readonly permanentDeletePreview?: TaskPermanentDeletePreview;
  readonly permanentDelete?: TaskPermanentDeleteResult;
}
