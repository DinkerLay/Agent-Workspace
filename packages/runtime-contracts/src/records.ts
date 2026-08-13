import type {
  AgentCardId,
  ArchitectureSnapshotId,
  AttentionId,
  EvidenceReferenceId,
  ExecutionProfileId,
  InputSubmissionId,
  LogicalSessionId,
  MetaPatchProposalId,
  MetaMessageId,
  MetaProfileOptionId,
  MetaSessionId,
  PresentationLeaseId,
  ProviderFactId,
  ProviderSessionBindingId,
  RuntimeCommandId,
  SessionTurnId,
  TaskId,
  TaskRunId,
  TaskSetupDraftId,
  TemplateDraftId,
  TemplateId,
  TemplateVersionId,
  WorkspaceId,
} from "./ids";
import { canonicalJson, hashDefinition, type JsonObject, type JsonValue } from "./json";
import type {
  ExecutionProfileDefinition,
  MetaProfileDefinitionV2,
  MetaProfileDefinitionV3,
  MetaProfileSnapshot,
  ProviderCapability,
  ProviderKind,
  TaskInputValue,
  TemplateDefinitionSnapshot,
} from "./templates";
import type { TaskArchitectureSnapshotV3 } from "./task-architecture-v3";

export type IsoTimestamp = string;

export interface TemplateRecord {
  readonly templateId: TemplateId;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly activeVersionId?: TemplateVersionId;
  readonly archivedAt?: IsoTimestamp;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface TemplateVersionRecord {
  readonly templateVersionId: TemplateVersionId;
  readonly templateId: TemplateId;
  readonly version: number;
  readonly definition: TemplateDefinitionSnapshot;
  readonly definitionHash: string;
  /** Always persisted by the Store; optional only for pre-store domain construction. */
  readonly assetManifestHash?: string;
  readonly createdAt: IsoTimestamp;
  readonly publishedAt: IsoTimestamp;
}

/** Immutable binary payload owned by exactly one Template Version. */
export interface TemplateAssetRecord {
  readonly templateVersionId: TemplateVersionId;
  readonly path: string;
  readonly contentType?: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly bytes: Uint8Array;
  readonly createdAt: IsoTimestamp;
}

export interface TemplateDraftRecord {
  readonly templateDraftId: TemplateDraftId;
  readonly templateId?: TemplateId;
  readonly baseTemplateVersionId?: TemplateVersionId;
  /** Durable editing metadata for a not-yet-published Template identity. */
  readonly metadata: TemplateDraftMetadata;
  readonly definition: TemplateDefinitionSnapshot;
  readonly status: "editing" | "published" | "discarded";
  readonly revision: number;
  readonly ownerId: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface TemplateDraftMetadata {
  readonly title: string;
  readonly slug?: string;
  readonly description?: string;
}

export type TaskSetupDraftState = "draft" | "consumed" | "abandoned";

export interface TaskSetupDraftRecord {
  readonly taskSetupDraftId: TaskSetupDraftId;
  readonly ownerId: string;
  readonly templateVersionId: TemplateVersionId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly goal: string;
  readonly taskInputValues: readonly TaskInputValue[];
  readonly state: TaskSetupDraftState;
  readonly createdTaskId?: TaskId;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type MetaSessionTarget =
  | Readonly<{ kind: "template_draft"; templateDraftId: TemplateDraftId }>
  | Readonly<{ kind: "task_setup_draft"; taskSetupDraftId: TaskSetupDraftId }>;

export type MetaSessionMode = "template_design" | "task_setup";
export type MetaSessionState = "active" | "consumed" | "abandoned";
export type MetaTurnStatus =
  | "pending"
  | "leased"
  | "provider_accepted"
  | "returned"
  | "rejected"
  | "ambiguous"
  | "failed";

export type MetaSessionRecordFor<Profile extends MetaProfileSnapshot> = Readonly<{
  metaSessionId: MetaSessionId;
  ownerId: string;
  metaProfileOptionId: MetaProfileOptionId;
  metaProfile: Profile;
  state: MetaSessionState;
  revision: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}> & (
  | Readonly<{ mode: "template_design"; target: Extract<MetaSessionTarget, { kind: "template_draft" }> }>
  | Readonly<{ mode: "task_setup"; target: Extract<MetaSessionTarget, { kind: "task_setup_draft" }> }>
);

export type MetaSessionRecordV2 = MetaSessionRecordFor<MetaProfileDefinitionV2>;
export type MetaSessionRecordV3 = MetaSessionRecordFor<MetaProfileDefinitionV3>;
export type MetaSessionRecord = MetaSessionRecordV2 | MetaSessionRecordV3;

export type MetaPatchOperation =
  | Readonly<{ kind: "template_metadata_set"; field: "title" | "slug" | "description"; value: string | null }>
  | Readonly<{ kind: "template_conductor_prompt_set"; value: string }>
  | Readonly<{ kind: "template_card_prompt_set"; agentCardId: AgentCardId; value: string }>
  | Readonly<{ kind: "template_profile_model_set"; executionProfileId: ExecutionProfileId; value: string }>
  | Readonly<{ kind: "template_card_profile_set"; agentCardId: AgentCardId; executionProfileId: ExecutionProfileId }>
  | Readonly<{ kind: "template_deliverable_upsert"; artifactPath: string; ownerAgentCardId: AgentCardId; description?: string }>
  | Readonly<{ kind: "task_setup_title_set"; value: string }>
  | Readonly<{ kind: "task_setup_goal_set"; value: string }>
  | Readonly<{ kind: "task_setup_input_set"; fieldId: string; value: string }>;

export interface MetaPatchValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly operationIndex?: number;
}

export type MetaPatchProposalState = "pending" | "applied" | "rejected";

export interface MetaMessageRecord {
  readonly metaMessageId: MetaMessageId;
  readonly metaSessionId: MetaSessionId;
  readonly ownerId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly contentDigest: string;
  readonly createdAt: IsoTimestamp;
}

export interface MetaPatchProposalRecordFor<Profile extends MetaProfileSnapshot> {
  readonly metaPatchProposalId: MetaPatchProposalId;
  readonly metaSessionId: MetaSessionId;
  readonly ownerId: string;
  readonly mode: MetaSessionMode;
  readonly target: MetaSessionTarget;
  readonly sourceMetaProfileOptionId: MetaProfileOptionId;
  readonly sourceMetaProfile: Profile;
  readonly sourceMetaSessionRevision: number;
  readonly targetRevision: number;
  readonly operations: readonly MetaPatchOperation[];
  readonly summary: string;
  readonly rationale: string;
  readonly validationIssues: readonly MetaPatchValidationIssue[];
  readonly state: MetaPatchProposalState;
  readonly appliedTargetRevision?: number;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
}


export type MetaPatchProposalRecordV2 = MetaPatchProposalRecordFor<MetaProfileDefinitionV2>;
export type MetaPatchProposalRecordV3 = MetaPatchProposalRecordFor<MetaProfileDefinitionV3>;
export type MetaPatchProposalRecord = MetaPatchProposalRecordV2 | MetaPatchProposalRecordV3;

export interface WorkspaceReference {
  readonly workspaceId: WorkspaceId;
  /** This exists only in a Task snapshot; portable template packages never contain it. */
  readonly cwd: string;
  readonly displayName?: string;
}

/**
 * Host-private directory authority. The canonical directory is persisted so a
 * Task can be resolved without trusting a Renderer-supplied cwd, but it is
 * never part of a Runtime read model or public Task command.
 */
export interface WorkspaceAuthorizationRecord {
  readonly workspaceId: WorkspaceId;
  readonly canonicalDirectory: string;
  readonly displayName: string;
  readonly authorizedAt: IsoTimestamp;
}

/** Frozen at Task creation; template edits never mutate this snapshot. */
export interface TaskArchitectureSnapshotV2 {
  readonly architectureSnapshotId: ArchitectureSnapshotId;
  readonly taskId: TaskId;
  readonly templateId: TemplateId;
  readonly templateVersionId: TemplateVersionId;
  readonly templateDefinitionHash: string;
  readonly definition: Extract<TemplateDefinitionSnapshot, { readonly schemaVersion: 2 }>;
  readonly taskInputValues: readonly TaskInputValue[];
  readonly taskGoalContent: string;
  readonly taskGoalContentDigest: string;
  readonly taskGoalCompilerVersion: "task-goal/v1";
  readonly workspace: WorkspaceReference;
  readonly createdAt: IsoTimestamp;
}

/** Durable snapshot union. v2 is historical/read-only; every new Task freezes v3. */
export type TaskArchitectureSnapshot = TaskArchitectureSnapshotV2 | TaskArchitectureSnapshotV3;

/** Runtime lifecycle only. User acceptance deliberately is not a lifecycle state. */
export type TaskStatus = "queued" | "running" | "stopping" | "stopped" | "blocked";

/**
 * A user's explicit acceptance decision. It can coexist with an active Run:
 * accepting a result does not assert that a Provider process has stopped.
 */
export interface TaskAchievement {
  readonly achievedAt: IsoTimestamp;
  /** Session-ID acceptance copies one non-owning, previously observed file state. */
  readonly fileStateAnchor?: Readonly<{
    workspaceRelativePath: string;
    observedDigest: string;
    label?: string;
  }>;
  readonly acceptanceNote?: string;
}

export interface TaskRecord {
  readonly taskId: TaskId;
  readonly architectureSnapshotId: ArchitectureSnapshotId;
  readonly title: string;
  readonly goal: string;
  readonly status: TaskStatus;
  /**
   * Recycle-bin retention is deliberately distinct from Task/Run lifecycle
   * and from the user's explicit Achieve decision. A trashed Task retains its
   * immutable architecture, Run and file observations until an
   * explicit restore or permanent-delete command.
   */
  readonly trashedAt?: IsoTimestamp;
  readonly achievement?: TaskAchievement;
  readonly activeRunId?: TaskRunId;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type TaskRunStatus =
  | "starting"
  | "running"
  | "waiting_attention"
  | "stopping"
  | "stopped"
  | "failed"
  | "cancellation_unknown";

export interface TaskRunRecord {
  readonly runId: TaskRunId;
  readonly taskId: TaskId;
  readonly conductorLogicalSessionId: LogicalSessionId;
  readonly status: TaskRunStatus;
  readonly runNumber: number;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp;
  readonly revision: number;
}

export type LogicalSessionKind = "conductor" | "card";
export type LogicalSessionStatus = "unmaterialized" | "active" | "waiting_attention" | "idle" | "stopped" | "unrecoverable";

export interface LogicalSessionRecord {
  readonly logicalSessionId: LogicalSessionId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly kind: LogicalSessionKind;
  readonly agentCardId: AgentCardId;
  readonly executionProfileId: ExecutionProfileId;
  readonly status: LogicalSessionStatus;
  readonly ordinal: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type ProviderFactKind =
  | "binding_observed"
  | "binding_unavailable"
  | "input_received"
  | "input_rejected"
  | "transport_unknown"
  | "turn_started"
  /** Correlated, bounded, provider-neutral progress/tool presentation fact. */
  | "activity_observed"
  /** Correlated, provider-neutral final text. Terminal completion is separate. */
  | "assistant_final"
  | "turn_completed"
  | "turn_failed"
  | "attention_requested"
  | "attention_resolved"
  | "interrupt_confirmed"
  | "native_terminal"
  | "native_child_observed"
  | "presentation_available"
  | "provider_unavailable";

/**
 * Provider activity is durable human-only presentation evidence. It never
 * becomes a SessionMessage and is never routed to another Agent. Adapters must
 * reduce native payloads to this bounded schema before a fact reaches Runtime.
 */
export type ProviderActivityCategory = "assistant_progress" | "tool" | "change" | "web";
export type ProviderActivityPhase = "started" | "progress" | "completed" | "failed";
export type ProviderActivityUpdateMode = "append" | "replace";

export interface ProviderActivityPayload {
  readonly schemaVersion: 1;
  /** Opaque stable identity; it contains no native Provider identifier. */
  readonly activityId: string;
  readonly category: ProviderActivityCategory;
  readonly phase: ProviderActivityPhase;
  readonly title: string;
  readonly detail?: string;
  /** Bounded display text only; never a raw native payload or SDK object. */
  readonly content?: string;
  readonly updateMode?: ProviderActivityUpdateMode;
  /** Adapter-local ordering evidence for multiple observations in one clock tick. */
  readonly sequence: number;
}

export interface ProviderFactDeduplication {
  readonly providerEventId?: string;
  readonly sourceInstanceId?: string;
  readonly cursor?: string;
  readonly reconciliationWatermark?: string;
}

export interface ProviderFactCorrelation {
  readonly inputSubmissionId?: InputSubmissionId;
  readonly sessionTurnId?: SessionTurnId;
  readonly attentionId?: AttentionId;
  readonly nativeMessageId?: string;
  readonly nativeTurnId?: string;
  readonly nativeRequestId?: string;
}

/** A durable, deduplicable observation owned exclusively by an Adapter. */
export interface ProviderFact {
  readonly providerFactId: ProviderFactId;
  readonly provider: ProviderKind;
  readonly bindingId: ProviderSessionBindingId;
  readonly bindingRevision: number;
  readonly kind: ProviderFactKind;
  readonly deduplication: ProviderFactDeduplication;
  readonly correlation: ProviderFactCorrelation;
  readonly evidenceReferenceId?: EvidenceReferenceId;
  readonly payload: JsonObject;
  readonly observedAt: IsoTimestamp;
}

export type ProviderEffectKind = "ensure_host" | "ensure_binding" | "submit_delivery" | "request_interrupt" | "respond_attention";

/**
 * A local transport outcome. It is intentionally not a ProviderFact and must
 * never be used as proof that a Provider received an input or stopped a turn.
 */
export interface ProviderEffect {
  readonly effectId: string;
  readonly kind: ProviderEffectKind;
  readonly provider: ProviderKind;
  readonly bindingId?: ProviderSessionBindingId;
  readonly inputSubmissionId?: InputSubmissionId;
  readonly attentionId?: AttentionId;
  readonly acceptance: "accepted" | "rejected" | "unknown";
  readonly acceptedAt: IsoTimestamp;
  readonly diagnostic?: string;
}

export interface ProviderCapabilities {
  readonly provider: ProviderKind;
  readonly available: boolean;
  readonly providerVersion?: string;
  readonly protocolFingerprint?: string;
  readonly capabilities: readonly ProviderCapability[];
  readonly unavailableReasons: readonly string[];
}

export type SessionPresentationKind = "workspace_transcript_and_composer" | "native_embedded" | "external_handoff" | "unavailable";

export interface SessionPresentation {
  readonly presentationLeaseId: PresentationLeaseId;
  readonly bindingId: ProviderSessionBindingId;
  readonly kind: SessionPresentationKind;
  readonly title: string;
  readonly url?: string;
  readonly unavailableReason?: string;
  readonly expiresAt: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
}

export interface EvidenceReference {
  readonly evidenceReferenceId: EvidenceReferenceId;
  readonly kind: "provider_history" | "provider_event" | "host_log" | "user_input";
  readonly digest: string;
  readonly locator: string;
  readonly capturedAt: IsoTimestamp;
}

export interface RuntimeCommandReceipt {
  readonly commandId: RuntimeCommandId;
  readonly acceptedAt: IsoTimestamp;
  readonly taskRevision?: number;
}

/** Stable dedup identity following the ProviderFact rules in architecture.md. */
export function providerFactDedupKey(fact: ProviderFact): string {
  const base = `${fact.provider}:${fact.bindingId}:`;
  const deduplication = fact.deduplication;
  if (deduplication.providerEventId) return `${base}event:${deduplication.providerEventId}`;
  if (deduplication.sourceInstanceId && deduplication.cursor) {
    return `${base}cursor:${deduplication.sourceInstanceId}:${deduplication.cursor}`;
  }
  if (deduplication.reconciliationWatermark) {
    const fingerprint = hashDefinition({
      kind: fact.kind,
      correlation: fact.correlation as unknown as JsonValue,
      payload: fact.payload,
      evidenceReferenceId: fact.evidenceReferenceId ?? null,
    });
    return `${base}watermark:${deduplication.reconciliationWatermark}:${fingerprint}`;
  }
  throw new Error("provider_fact_deduplication_evidence_required");
}

export function providerFactFingerprint(fact: ProviderFact): string {
  return hashDefinition({
    provider: fact.provider,
    bindingId: fact.bindingId,
    kind: fact.kind,
    // Only the selected durable identity and native semantics are part of a
    // replay fingerprint. A Host recovery may observe the same native event
    // through a later Runtime-owned Binding CAS revision (and a different
    // sourceInstanceId); Store/reducer revision gates still reject facts from
    // the future before this replay check.
    dedupKey: providerFactDedupKey(fact),
    correlation: fact.correlation as unknown as JsonValue,
    payload: fact.payload,
    evidenceReferenceId: fact.evidenceReferenceId ?? null,
  });
}

export function canonicalProviderFactPayload(fact: ProviderFact): string {
  return canonicalJson(fact.payload);
}

export type FrozenExecutionProfile = ExecutionProfileDefinition;
