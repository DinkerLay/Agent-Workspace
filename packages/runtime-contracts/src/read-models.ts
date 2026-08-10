import type {
  ArtifactReference,
  AttentionRecord,
  InputSubmissionRecord,
  InvocationRecord,
  HumanInterventionRecord,
  MetaPatchProposalRecord,
  MetaMessageRecord,
  MetaSessionRecord,
  MetaSessionMode,
  MetaTurnStatus,
  LogicalSessionRecord,
  ProviderSessionBindingRecord,
  MessageForwardBatchRecord,
  MessageForwardRecord,
  RelayBlockRecord,
  SessionInboxItemRecord,
  SessionMessageRecord,
  SessionTurnRecord,
  SessionPresentation,
  TaskRecord,
  TaskRunRecord,
  TaskSetupDraftRecord,
  TemplateDraftRecord,
  TemplateRecord,
  TemplateVersionRecord,
} from "./records";
import type {
  ArtifactId,
  AttentionId,
  HumanInterventionId,
  InputSubmissionId,
  InvocationId,
  LogicalSessionId,
  MetaProfileOptionId,
  MetaMessageId,
  MetaPatchProposalId,
  MetaSessionId,
  MetaTurnId,
  MessageForwardId,
  ProviderSessionBindingId,
  RuntimeCommandId,
  SessionTurnId,
  TaskId,
  TaskRunId,
  TemplateId,
  TemplateVersionId,
  WorkspaceId,
} from "./ids";
import type { ProviderCapability, TemplateDefinition } from "./templates";
import type { ProviderKind } from "./templates";

/**
 * A renderer may ask for one focused Runtime projection in addition to the
 * library summaries.  Selecting a Template is explicit so Version history is
 * not accidentally loaded for every library row.
 */
export interface RuntimeReadRequest {
  readonly workspaceId?: WorkspaceId;
  readonly taskId?: TaskId;
  readonly taskRunId?: TaskRunId;
  readonly templateId?: TemplateId;
}

export interface TemplateLibraryReadModel {
  readonly templates: readonly {
    readonly template: TemplateRecord;
    readonly activeVersion?: TemplateVersionRecord;
  }[];
  /** Drafts are renderer-readable but only Template Design service may mutate them. */
  readonly drafts: readonly TemplateDraftRecord[];
}

/**
 * Renderer-safe immutable Template Version content.  This intentionally
 * excludes Template assets (including bytes), Provider/native identities,
 * credentials, transcripts, and Task-local workspace data.
 */
export interface TemplateVersionReadModel {
  readonly templateVersionId: TemplateVersionId;
  readonly templateId: TemplateId;
  readonly version: number;
  readonly definition: TemplateDefinition;
  readonly definitionHash: string;
  readonly assetManifestHash?: string;
  readonly createdAt: string;
  readonly publishedAt: string;
}

/** A focused Template identity plus its complete immutable Version history. */
export interface TemplateSelectionReadModel {
  readonly template: TemplateRecord;
  readonly versions: readonly TemplateVersionReadModel[];
}

export interface TaskLibraryReadModel {
  readonly tasks: readonly TaskRecord[];
}

/**
 * Renderer-safe proof that a workspace may be selected for a new Task. The
 * canonical directory remains Host-private and is deliberately absent.
 */
export interface WorkspaceAuthorizationReadModel {
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly authorizedAt: string;
}

export interface WorkspaceLibraryReadModel {
  readonly authorizations: readonly WorkspaceAuthorizationReadModel[];
}

/** Configuration-only state; it contains no Task transcript, cwd or Provider-native identity. */
export interface ConfigurationReadModel {
  readonly metaProfileOptions: readonly MetaProfileOptionReadModel[];
  /** Host-owned, side-effect-free capability evidence keyed by a frozen profile digest. */
  readonly executionProfileReadiness: readonly ExecutionProfileReadinessReadModel[];
  readonly taskSetupDrafts: readonly TaskSetupDraftRecord[];
  readonly metaSessions: readonly MetaSessionRecord[];
  readonly metaMessages: readonly MetaMessageRecord[];
  readonly metaPatchProposals: readonly MetaPatchProposalRecord[];
  /** Safe Meta execution state; frozen context, profile and transport details stay Host-private. */
  readonly metaTurns: readonly MetaTurnReadModel[];
}

export interface ExecutionProfileReadinessReadModel {
  readonly templateVersionId: TemplateVersionId;
  readonly executionProfileId: string;
  readonly status: "checking" | "available" | "unavailable" | "version_mismatch" | "capability_missing";
  readonly unavailableReasons: readonly ExecutionProfileReadinessReason[];
  readonly missingCapabilities: readonly ProviderCapability[];
}

export type ExecutionProfileReadinessReason =
  | "provider_not_composed"
  | "provider_probe_pending"
  | "provider_probe_failed"
  | "provider_unavailable"
  | "provider_mismatch"
  | "provider_version_mismatch"
  | "protocol_fingerprint_mismatch"
  | `capability_${ProviderCapability}_unavailable`;

export interface MetaTurnReadModel {
  readonly metaTurnId: MetaTurnId;
  readonly metaSessionId: MetaSessionId;
  readonly userMetaMessageId: MetaMessageId;
  readonly assistantMetaMessageId: MetaMessageId;
  readonly metaPatchProposalId: MetaPatchProposalId;
  readonly mode: MetaSessionMode;
  readonly targetRevision: number;
  readonly status: MetaTurnStatus;
  readonly attempts: number;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MetaProfileOptionReadModel {
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly availability: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly profile: Readonly<{
    provider: ProviderKind;
    model: string;
    providerVersion: string;
    protocolFingerprint: string;
  }>;
}

/**
 * A renderer-safe, durable-fact projection for the preserved AgentLoop
 * Timeline.  It intentionally contains no raw Provider event/payload, PTY
 * transcript, credential, native session id, or lifecycle decision API.
 *
 * `user_achieved` records only an explicit user decision.  Provider facts and
 * agent results remain evidence in the Timeline; they never imply Achieve.
 */
export type TaskTimelineItemKind =
  | "task_created"
  | "run_started"
  | "input_submitted"
  | "provider_input_received"
  | "provider_input_rejected"
  | "provider_transport_unknown"
  | "invocation_requested"
  | "invocation_state_changed"
  | "message_created"
  | "relay_block_extracted"
  | "message_forwarded"
  | "human_intervention_changed"
  | "inbox_state_changed"
  | "session_turn_changed"
  | "attention_requested"
  | "attention_state_changed"
  | "provider_binding_observed"
  | "provider_binding_unavailable"
  | "provider_turn_started"
  | "provider_turn_completed"
  | "provider_turn_failed"
  | "provider_interrupt_confirmed"
  | "provider_terminal"
  | "provider_unavailable"
  | "provider_activity"
  | "artifact_verified"
  | "user_achieved";

export interface TaskTimelineItem {
  readonly timelineItemId: string;
  readonly kind: TaskTimelineItemKind;
  readonly occurredAt: string;
  readonly taskId: TaskId;
  readonly runId?: TaskRunId;
  readonly logicalSessionId?: LogicalSessionId;
  readonly bindingId?: ProviderSessionBindingId;
  readonly inputSubmissionId?: InputSubmissionId;
  readonly invocationId?: InvocationId;
  readonly sessionTurnId?: SessionTurnId;
  readonly forwardId?: MessageForwardId;
  readonly humanInterventionId?: HumanInterventionId;
  readonly attentionId?: AttentionId;
  readonly artifactId?: ArtifactId;
  readonly title: string;
  readonly detail?: string;
  readonly status?: string;
}

/**
 * Renderer-safe identity for a Host-verified workspace file. The private
 * workspace-relative path is intentionally absent: renderers can display or
 * request an Artifact only by this managed identity.
 */
export interface ManagedArtifactReadModel {
  readonly artifactId: ArtifactId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly displayName: string;
  readonly contentDigest: string;
  readonly sourceInvocationId?: InvocationId;
  readonly verifiedAt: string;
}

export type ProviderActivityReadModelStatus = "running" | "completed" | "failed";

/**
 * Renderer-safe human-only execution presentation. It is derived from bounded
 * Provider activity facts, is never collaboration content, and carries no
 * native identity, cwd, credential, raw arguments, or unbounded tool output.
 */
export interface ProviderActivityReadModel {
  readonly activityId: string;
  readonly provider: ProviderKind;
  readonly bindingId: ProviderSessionBindingId;
  readonly logicalSessionId: LogicalSessionId;
  readonly inputSubmissionId?: InputSubmissionId;
  readonly invocationId?: InvocationId;
  readonly sessionTurnId?: SessionTurnId;
  readonly category: "assistant_progress" | "tool" | "change" | "web";
  readonly status: ProviderActivityReadModelStatus;
  readonly title: string;
  readonly detail?: string;
  readonly content?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export type ArtifactPreviewState = "available" | "missing" | "changed" | "too_large" | "unsupported";

/** A bounded, text-only preview. No path, native handle or binary bytes cross the Runtime bridge. */
export interface ArtifactPreviewReadModel {
  readonly artifactId: ArtifactId;
  readonly taskId: TaskId;
  readonly displayName: string;
  readonly state: ArtifactPreviewState;
  readonly byteLength?: number;
  readonly contentType?: "text/plain" | "text/markdown" | "text/html";
  readonly content?: string;
  readonly truncated?: boolean;
}

export type TaskPermanentDeleteArtifactState = "deletable" | "missing" | "changed" | "too_large" | "unsupported";

/** Safe delete confirmation data for a Task already in the recycle bin. */
export interface TaskPermanentDeletePreview {
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly artifacts: readonly {
    readonly artifactId: ArtifactId;
    readonly displayName: string;
    readonly state: TaskPermanentDeleteArtifactState;
    readonly byteLength?: number;
  }[];
}

export type TaskPermanentDeleteSkipReason = "missing" | "changed" | "unsupported";

/** Result of an explicit permanent delete. It never returns a filesystem path. */
export interface TaskPermanentDeleteResult {
  readonly taskId: TaskId;
  readonly deletedArtifactIds: readonly ArtifactId[];
  readonly skippedArtifacts: readonly {
    readonly artifactId: ArtifactId;
    readonly reason: TaskPermanentDeleteSkipReason;
  }[];
  readonly deletedAt: string;
}

export interface TaskRuntimeReadModel {
  readonly task: TaskRecord;
  /**
   * Cached Host readiness for the Conductor profile frozen in this Task's
   * architecture snapshot. Absence is fail-closed and must never trigger a
   * Provider probe from a read path.
   */
  readonly conductorExecutionProfileReadiness?: ExecutionProfileReadinessReadModel;
  readonly activeRun?: TaskRunRecord;
  readonly logicalSessions: readonly LogicalSessionRecord[];
  readonly bindings: readonly ProviderSessionBindingRecord[];
  readonly inputs: readonly InputSubmissionRecord[];
  readonly invocations: readonly InvocationRecord[];
  readonly sessionTurns: readonly SessionTurnRecord[];
  /**
   * The authenticated user projection is assembled by the Store. No Provider
   * payload or native identity is included. RelayBlocks remain source-message
   * candidates; only MessageForward records establish cross-Session delivery.
   */
  readonly messages: readonly SessionMessageRecord[];
  readonly relayBlocks: readonly RelayBlockRecord[];
  readonly messageForwards: readonly MessageForwardRecord[];
  readonly messageForwardBatches: readonly MessageForwardBatchRecord[];
  readonly humanInterventions: readonly HumanInterventionRecord[];
  readonly inboxItems: readonly SessionInboxItemRecord[];
  readonly attentions: readonly AttentionRecord[];
  /** Human-only Provider execution projection; never routable Session content. */
  readonly providerActivities: readonly ProviderActivityReadModel[];
  readonly artifacts: readonly ManagedArtifactReadModel[];
  readonly presentations: readonly SessionPresentation[];
  readonly timeline: readonly TaskTimelineItem[];
}

/** Renderer-safe projection. No raw stream, credential, cwd authority or SDK object is exposed. */
export interface RuntimeReadModel {
  readonly generatedAt: string;
  readonly configuration: ConfigurationReadModel;
  readonly workspaceId?: WorkspaceId;
  readonly workspaceLibrary: WorkspaceLibraryReadModel;
  readonly templateLibrary: TemplateLibraryReadModel;
  /** Present only when RuntimeReadRequest.templateId selected an existing Template. */
  readonly template?: TemplateSelectionReadModel;
  readonly taskLibrary: TaskLibraryReadModel;
  readonly task?: TaskRuntimeReadModel;
}

export type RuntimeInvalidationReason =
  | "workspace_changed"
  | "template_changed"
  | "configuration_changed"
  | "task_changed"
  | "run_changed"
  | "message_changed"
  | "inbox_changed"
  | "input_changed"
  | "invocation_changed"
  | "attention_changed"
  | "artifact_changed"
  | "presentation_changed"
  | "provider_fact_reconciled";

export interface RuntimeInvalidation {
  readonly type: "runtime.invalidated";
  readonly sequence: number;
  readonly occurredAt: string;
  readonly reasons: readonly RuntimeInvalidationReason[];
  readonly workspaceId?: WorkspaceId;
  readonly taskId?: TaskId;
  readonly runId?: TaskRunId;
  readonly commandId?: RuntimeCommandId;
}

export interface RuntimeHostStatusEvent {
  readonly type: "runtime.host_status";
  readonly occurredAt: string;
  readonly available: boolean;
  readonly reason?: string;
}

export type RuntimeEvent = RuntimeInvalidation | RuntimeHostStatusEvent;
