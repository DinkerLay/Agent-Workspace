import type {
  MetaPatchProposalRecord,
  MetaMessageRecord,
  MetaSessionRecord,
  MetaSessionMode,
  MetaTurnStatus,
  TaskRecord,
  TaskSetupDraftRecord,
  TemplateDraftRecord,
  TemplateRecord,
  TemplateVersionRecord,
} from "./records";
import type {
  MetaProfileOptionId,
  MetaMessageId,
  MetaPatchProposalId,
  MetaProfileId,
  MetaSessionId,
  MetaTurnId,
  RuntimeCommandId,
  TaskId,
  TaskRunId,
  TemplateId,
  TemplateVersionId,
  WorkspaceId,
  ExecutionProfileRevisionId,
} from "./ids";
import type {
  ACPAgentKind,
  ProviderCapability,
  ProviderFamily,
  ProviderKind,
  TemplateDefinition,
} from "./templates";
import type { AcpProfileReadinessObservation } from "./acp-profile-readiness";

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
  /** `version_mismatch` is retained only for persisted schema-v2 projections. */
  readonly status: "checking" | "available" | "unavailable" | "version_mismatch" | "capability_missing";
  readonly unavailableReasons: readonly ExecutionProfileReadinessReason[];
  readonly missingCapabilities: readonly ProviderCapability[];
  /** Live, Host-observed evidence. Never sourced from Template v2 metadata. */
  readonly observedProviderVersion?: string;
  readonly observedProtocolFingerprint?: string;
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

export interface MetaProfileOptionReadModelV2 {
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

/** Renderer-safe ACP option. Host-private resolution and native IDs are absent. */
export interface MetaProfileOptionReadModelV3 {
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly availability: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly profile: Readonly<{
    metaProfileId: MetaProfileId;
    profileRevisionId: ExecutionProfileRevisionId;
    providerFamily: ProviderFamily;
    acpAgentKind: ACPAgentKind;
    protocolMajor: 1;
    role: "meta";
    model: string;
  }>;
  readonly readiness: AcpProfileReadinessObservation;
}

/** Schema-dispatched option projection; v2 history is never executable. */
export type MetaProfileOptionReadModel = MetaProfileOptionReadModelV2 | MetaProfileOptionReadModelV3;

/**
 * A renderer-safe, durable-fact projection for the preserved AgentLoop
 * Timeline.  It intentionally contains no raw Provider event/payload, PTY
 * transcript, credential, native session id, or lifecycle decision API.
 *
 * `user_achieved` records only an explicit user decision.  Provider facts and
 * agent results remain evidence in the Timeline; they never imply Achieve.
 */
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
