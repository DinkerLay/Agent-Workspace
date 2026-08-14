import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { ACP_TASK_ROLES, acpTaskRoleToolNames } from "./acp-task-role.js";
import {
  assertJsonValue,
  assertSessionExecutionSafeValue,
  cloneJson,
  validateAcpProfileReadinessObservation,
  validateAcpSafeSessionBindingRecordV3,
  type AcpProfileReadinessObservation,
  type AcpSafeSessionBindingRecordV3,
  type ExecutionProfileDefinitionV3,
  type JsonValue,
  type SessionRuntimeBindingReadyEvent,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
} from "@agent-workspace/provider-acp";
import type {
  ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import type {
  AcpMetaAgentRegistration,
  SessionExecutionRuntimeOwner,
} from "@agent-workspace/runtime-application";
import type {
  AcpSessionRuntimeRepositories,
  AcpV3FrozenProfileTuple,
  AcpV3FrozenProfileTupleResolver,
} from "@agent-workspace/runtime-store";
import {
  assertAcpPrivateBindingPresenceAuthorityScope,
  claimAcpPrivateBindingDispositionAuthority,
  claimAcpPrivateBindingPresenceAuthority,
  type AcpPrivateBindingPresenceAuthority,
  type AcpPrivateBindingVaultResolver,
} from "./acp-private-binding-map.js";
import type {
  AcpProductionCodexHostInputs,
  AcpProductionClaudeCodeHostInputs,
  AcpProductionConfiguration,
  AcpProductionHostInputs,
  AcpProductionOpenCodeHostInputs,
} from "./acp-production-configuration.js";
import {
  claimAcpTaskPrivateRootAuthority,
  claimAcpMetaPrivateRootAuthority,
  type AcpRuntimeHostPrivateAuthority,
  type AcpTaskPrivateRootAuthority,
} from "./acp-runtime-host-private-authority.js";
import {
  createAcpMetaProviderComposition,
  type AcpMetaProfileRegistration,
  type AcpMetaProviderComposition,
} from "./acp-meta-provider-composition.js";
import { createAcpMetaAgentRegistrations } from "./acp-meta-agent-port-adapter.js";
import { createOfficialAcpV1StdioConnection } from "./acp-sdk-stdio-connection.js";
import { createClaudeCodeAcpV1StdioConnection } from "./acp-claude-code-stdio-connection.js";
import type {
  AcpProviderAvailabilityReport,
  AcpProviderComposition,
  AcpProviderModelCatalogInspection,
  AcpCredentialAcquisitionOperation,
  AcpQualificationEffectBudget,
  AcpTargetCheckpointFactCapability,
  AcpTargetCheckpointFactCapabilityNotice,
  AcpTargetCheckpointFactKind,
  AcpTargetCheckpointFactObservation,
  AcpTargetLifecycleCapability,
  AcpTargetLifecycleCapabilityNotice,
  AcpTargetLifecycleObservation,
} from "./acp-provider-composition.js";
import {
  claimAcpTargetCheckpointFactObservation,
  claimAcpTargetLifecycleObservation,
  createAcpProviderComposition,
} from "./acp-provider-composition.js";
import {
  createAcpProfileResolutionRegistry,
  type AcpCurrentInstallDescriptor,
  type AcpPortableProfileDefinitionV3,
} from "./acp-profile-resolution.js";
import {
  createAcpAgentProcessFactory,
} from "./acp-agent-process.js";
import {
  CLAUDE_CODE_ACP_TASK_NATIVE_DRIVER,
  CODEX_ACP_TASK_NATIVE_DRIVER,
  createAcpTaskSessionRuntimeNativeBinding,
  OPENCODE_ACP_TASK_NATIVE_DRIVER,
} from "./acp-task-session-runtime-native.js";
import {
  createOpenCodeAcpTaskProfileAdapter,
  type OpenCodeAcpTaskBindingRuntime,
  type OpenCodeAcpTaskProfileAdapter,
} from "./acp-opencode-task-profile.js";
import type {
  AcpTaskPromptReconciler,
  AcpTaskRuntimeDiagnostic,
} from "./acp-task-profile-runtime.js";
import {
  createCodexAcpTaskProfileAdapter,
  type CodexAcpNativeAttemptInput,
  type CodexAcpTaskBindingRuntime,
  type CodexAcpTaskProfileAdapter,
} from "./acp-codex-task-profile.js";
import type { AcpTaskQualificationProbe } from "./acp-task-profile-runtime.js";
import {
  beginOpenCodeAcpCredentialAcquisition,
  createOpenCodeAcpCurrentInstallDescriptor,
  createOpenCodeAcpMetaCurrentInstallDescriptor,
} from "./acp-opencode-resolution.js";
import {
  createOpenCodeAcpScopedMcpRole,
  type OpenCodeAcpScopedMcpRole,
} from "./acp-opencode-scoped-mcp.js";
import {
  beginCodexAcpCredentialAcquisition,
  createCodexAcpMetaCurrentInstallDescriptor,
  createCodexAcpCurrentInstallDescriptor,
} from "./acp-codex-resolution.js";
import {
  createCodexAcpScopedMcpRole,
  type CodexAcpScopedMcpRole,
} from "./acp-codex-scoped-mcp.js";
import {
  beginClaudeCodeAcpCredentialAcquisition,
  createClaudeCodeAcpCurrentInstallDescriptor,
  createClaudeCodeAcpMetaCurrentInstallDescriptor,
} from "./acp-claude-code-resolution.js";
import {
  createClaudeCodeAcpScopedMcpRole,
  type ClaudeCodeAcpScopedMcpRole,
} from "./acp-claude-code-scoped-mcp.js";
import {
  createClaudeCodeAcpTaskProfileAdapter,
  type ClaudeCodeAcpTaskBindingRuntime,
  type ClaudeCodeAcpTaskProfileAdapter,
} from "./acp-claude-code-task-profile.js";
import {
  createAcpTaskSessionRuntimeProvider,
  type AcpTaskSessionRuntimeInterruptCorrelationResolution,
  type AcpTaskSessionRuntimeNativeDeliveryReceipt,
  type AcpTaskSessionRuntimeDeliveryReceipt,
  type AcpTaskSessionRuntimeNativeBinding,
  type AcpTaskSessionRuntimeProvider,
  type AcpTaskSessionRuntimeProviderOptions,
} from "./acp-task-session-runtime-provider.js";

const TASK_ROLES = ACP_TASK_ROLES;
const SUPPORTED_PROVIDER_FAMILIES = Object.freeze(["opencode", "codex", "claude-code"] as const);
const PROFILE_KEYS = Object.freeze([
  "executionProfileId",
  "profileRevisionId",
  "providerFamily",
  "acpAgentKind",
  "protocolMajor",
  "model",
  "configIntent",
  "requiredExtensions",
  "capabilityPolicy",
]);
const POLICY_KEYS = Object.freeze([
  "requiredCapabilities",
  "allowedTools",
  "permissionMode",
  "maxConcurrentTurns",
  "maxNativeChildren",
]);
const MANAGED_CAPABILITIES = Object.freeze([
  "create_binding",
  "resume_binding",
  "input_correlation",
  "provider_receipt",
  "reconcile",
  "interrupt",
]);
const PROFILE_ID = /^profile_[A-Za-z0-9_-]{1,223}$/u;
const PROFILE_REVISION_ID = /^profile_revision_[A-Za-z0-9_-]{1,223}$/u;
const ATTEMPT_ID = /^session_execution_attempt_[A-Za-z0-9_-]{1,223}$/u;
const SAFE_CODE = /^acp_[a-z0-9_]{1,223}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)?$/u;
const PORTABLE_MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]*)?$/u;
const OBSERVATION_KINDS = new Set<AcpSessionObservation["kind"]>([
  "delivery_receipt",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_status",
  "interaction_requested",
  "final_candidate",
  "prompt_terminal",
]);

export type SessionIdAcpTaskRole = (typeof TASK_ROLES)[number];
export type SessionIdAcpProductionProviderFamily = (typeof SUPPORTED_PROVIDER_FAMILIES)[number];
export type SessionIdAcpTaskBindingDisposition = "create" | "load" | "resume";

export type SessionIdAcpProductionNativeReleaseLane =
  | "opencode_acp_task_attestor"
  | "codex_acp_task_attestor"
  | "acp_meta_attestor";

export type SessionIdAcpProductionNativeReleaseScope = Readonly<{
  readonly schemaVersion: 1;
  readonly evidenceClass: "qualified_acp_provider" | "qualified_acp_meta";
  readonly productionLane: SessionIdAcpProductionNativeReleaseLane;
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly role: SessionIdAcpTaskRole | "meta";
  readonly model: string;
  readonly profileConfigurationDigest: string;
  readonly resolutionSealDigest: string;
  readonly observedArtifactVersion: string;
  readonly observedUpstreamVersion?: string;
  readonly processGenerationDigest: string;
}>;

declare const productionNativeReleaseCapabilityBrand: unique symbol;

/** Opaque, non-serializable production-owner claim authority. */
export type SessionIdAcpProductionNativeReleaseCapability = Readonly<{
  readonly [productionNativeReleaseCapabilityBrand]: true;
}>;

export type SessionIdAcpProductionNativeReleaseSummary = Readonly<{
  readonly scope: SessionIdAcpProductionNativeReleaseScope;
  readonly capability: SessionIdAcpProductionNativeReleaseCapability;
}>;

export type SessionIdAcpProductionNativeReleaseObservation =
  SessionIdAcpProductionNativeReleaseScope & Readonly<{
    readonly initialize: AcpTargetLifecycleObservation["initialize"];
    readonly qualificationProbeDigest: string;
    /** Host-issued per-process qualification instance; fresh across generations. */
    readonly qualificationDigest: string;
    readonly actualPrompt: AcpTargetLifecycleObservation["actualPrompt"];
    readonly cleanup: AcpTargetLifecycleObservation["cleanup"];
    readonly productionReceiptDigest: string;
  }>;

declare const productionNativeCheckpointFactCapabilityBrand: unique symbol;

/** Opaque production-owner authority for one cleanup-fenced checkpoint fact. */
export type SessionIdAcpProductionNativeCheckpointFactCapability = Readonly<{
  readonly [productionNativeCheckpointFactCapabilityBrand]: true;
}>;

export type SessionIdAcpProductionNativeCheckpointFactScope =
  SessionIdAcpProductionNativeReleaseScope & Readonly<{
    readonly kind: AcpTargetCheckpointFactKind;
  }>;

export type SessionIdAcpProductionNativeCheckpointFactSummary = Readonly<{
  readonly scope: SessionIdAcpProductionNativeCheckpointFactScope;
  readonly capability: SessionIdAcpProductionNativeCheckpointFactCapability;
}>;

export type SessionIdAcpProductionNativeCheckpointFactObservation =
  SessionIdAcpProductionNativeCheckpointFactScope & Readonly<{
    readonly observationDigest: string;
  }>;

export type SessionIdAcpProductionNativeReleaseObservationOwner = Readonly<{
  /** Unclaimed summaries only. The opaque capability cannot be JSON/clone reconstructed. */
  list(): readonly SessionIdAcpProductionNativeReleaseSummary[];
  claim(input: Readonly<{
    readonly capability: SessionIdAcpProductionNativeReleaseCapability;
    readonly expectedScope: SessionIdAcpProductionNativeReleaseScope;
  }>): SessionIdAcpProductionNativeReleaseObservation;
  /** Unclaimed cleanup-fenced facts; retained after composition close. */
  listCheckpointFacts(): readonly SessionIdAcpProductionNativeCheckpointFactSummary[];
  claimCheckpointFact(input: Readonly<{
    readonly capability: SessionIdAcpProductionNativeCheckpointFactCapability;
    readonly expectedScope: SessionIdAcpProductionNativeCheckpointFactScope;
  }>): SessionIdAcpProductionNativeCheckpointFactObservation;
}>;

type ProductionNativeReleaseIssuerState = {
  readonly productionLane: SessionIdAcpProductionNativeReleaseLane;
  readonly eligible: boolean;
  readonly capabilities: SessionIdAcpProductionNativeReleaseCapability[];
  readonly checkpointFactCapabilities: SessionIdAcpProductionNativeCheckpointFactCapability[];
  attachedOwner?: object;
};

type ProductionNativeCheckpointFactCapabilityState = {
  readonly issuer: ProductionNativeReleaseIssuerState;
  readonly scope: SessionIdAcpProductionNativeCheckpointFactScope;
  readonly observation: SessionIdAcpProductionNativeCheckpointFactObservation;
  claimed: boolean;
};

type ProductionNativeReleaseCapabilityState = {
  readonly issuer: ProductionNativeReleaseIssuerState;
  readonly scope: SessionIdAcpProductionNativeReleaseScope;
  readonly observation: SessionIdAcpProductionNativeReleaseObservation;
  claimed: boolean;
};

const PRODUCTION_TASK_FACTORY_RELEASE_ISSUERS = new WeakMap<
  object,
  ProductionNativeReleaseIssuerState
>();
const PRODUCTION_META_OWNER_RELEASE_ISSUERS = new WeakMap<
  object,
  ProductionNativeReleaseIssuerState
>();
const PRODUCTION_NATIVE_RELEASE_CAPABILITIES = new WeakMap<
  object,
  ProductionNativeReleaseCapabilityState
>();
const PRODUCTION_NATIVE_CHECKPOINT_FACT_CAPABILITIES = new WeakMap<
  object,
  ProductionNativeCheckpointFactCapabilityState
>();

export type SessionIdAcpTaskPrivateRootAuthority = AcpTaskPrivateRootAuthority;

export type SessionIdAcpTaskBindingDispositionAuthority = Readonly<{
  toJSON(): Readonly<{ readonly kind: "session_id_acp_task_binding_disposition_authority" }>;
}>;

/** Host-only execution material; it is never retained by `toJSON` or projected. */
export type SessionIdAcpTaskHostExecutionScope = Readonly<{
  readonly authorizedWorkspaceDirectory: string;
  readonly privateRootAuthority: SessionIdAcpTaskPrivateRootAuthority;
}>;

type TaskBindingDispositionAuthorityState = Readonly<{
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly bindingHandle: string;
  readonly logicalSessionId: string;
  readonly executionProfileId: string;
  readonly profileRevisionId: string;
  readonly providerFamily: AcpSafeSessionBindingRecordV3["providerFamily"];
  readonly status: AcpSafeSessionBindingRecordV3["status"];
  readonly disposition: SessionIdAcpTaskBindingDisposition;
  readonly presenceAuthority: AcpPrivateBindingPresenceAuthority;
}>;

const taskBindingDispositionAuthorities = new WeakMap<
  object,
  TaskBindingDispositionAuthorityState
>();

/**
 * Mints an exact current-Binding fence after Host-private identity inspection.
 * The concrete production factory obtains the presence authority from the
 * durable Task vault only after sealing the current installation: absent ->
 * create, present -> load/resume. Outer assembly never supplies a disposition
 * or guesses a profile-resolution fingerprint.
 */
export function createSessionIdAcpTaskBindingDispositionAuthority(options: Readonly<{
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  readonly binding: AcpSafeSessionBindingRecordV3;
  readonly presenceAuthority: AcpPrivateBindingPresenceAuthority;
  readonly profileResolutionFingerprint: string;
}>): SessionIdAcpTaskBindingDispositionAuthority {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || !sameKeys(options as unknown as Record<string, unknown>, [
      "identityVaultResolver",
      "binding",
      "presenceAuthority",
      "profileResolutionFingerprint",
    ])
    || typeof options.identityVaultResolver !== "function") {
    throw safeError("acp_task_binding_disposition_authority_options_invalid");
  }
  const binding = validateAcpSafeSessionBindingRecordV3(options.binding);
  const observedRawIdentityState = claimAcpPrivateBindingPresenceAuthority({
    authority: options.presenceAuthority,
    resolver: options.identityVaultResolver,
    bindingHandle: binding.bindingHandle,
    profileRevisionId: binding.profileRevisionId,
    providerFamily: binding.providerFamily,
  });
  const disposition = claimAcpPrivateBindingDispositionAuthority({
    authority: options.presenceAuthority,
    resolver: options.identityVaultResolver,
    bindingHandle: binding.bindingHandle,
    profileRevisionId: binding.profileRevisionId,
    profileResolutionFingerprint: options.profileResolutionFingerprint,
    providerFamily: binding.providerFamily,
  });
  if ((disposition === "create" && observedRawIdentityState !== "absent")
    || (disposition !== "create" && observedRawIdentityState !== "present")) {
    throw safeError("acp_task_binding_disposition_authority_invalid");
  }
  const authority = Object.freeze({
    toJSON: () => Object.freeze({
      kind: "session_id_acp_task_binding_disposition_authority" as const,
    }),
  });
  taskBindingDispositionAuthorities.set(authority, Object.freeze({
    identityVaultResolver: options.identityVaultResolver,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    bindingHandle: binding.bindingHandle,
    logicalSessionId: binding.logicalSessionId,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    providerFamily: binding.providerFamily,
    status: binding.status,
    disposition,
    presenceAuthority: options.presenceAuthority,
  }));
  return authority;
}

export type SessionIdAcpProductionExecutionObservation = Readonly<{
  readonly bindingId: string;
  readonly bindingHandle: string;
  readonly logicalSessionId: string;
  readonly executionProfileId: string;
  readonly profileRevisionId: string;
  readonly providerFamily: SessionIdAcpProductionProviderFamily;
  readonly role: SessionIdAcpTaskRole;
  readonly observation: AcpSessionObservation;
}>;

export type SessionIdAcpProductionFinalCandidateObservation = Omit<
  SessionIdAcpProductionExecutionObservation,
  "observation"
> & Readonly<{
  readonly observation: Extract<AcpSessionObservation, { readonly kind: "final_candidate" }>;
}>;

export type SessionIdAcpProductionTaskNativeFactoryOpenInput = Readonly<{
  readonly binding: AcpSafeSessionBindingRecordV3;
  readonly frozenProfile: AcpV3FrozenProfileTuple;
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: SessionIdAcpTaskRole;
  readonly hostScope: SessionIdAcpTaskHostExecutionScope;
  readonly hostInputs: AcpProductionOpenCodeHostInputs
    | AcpProductionCodexHostInputs
    | AcpProductionClaudeCodeHostInputs;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  readonly signal: AbortSignal;
  /**
   * Must be awaited in wire order. In particular, delivery receipt must be
   * reported before a long-running prompt completes so OR can advance its
   * Input/Turn state and admit an exact scoped interrupt.
   */
  readonly onObservation: (observation: AcpSessionObservation) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
  readonly resolveTurnContext?: (
    input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
  ) => ProviderScopedToolTurnContext | undefined;
}>;

export type SessionIdAcpProductionTaskNativeFactoryOpenResult =
  | Readonly<{
      readonly available: true;
      readonly nativeBinding: AcpTaskSessionRuntimeNativeBinding;
    }>
  | Readonly<{
      readonly available: false;
      readonly code: string;
    }>;

export type SessionIdAcpProductionTaskReadinessInput = Readonly<{
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: SessionIdAcpTaskRole;
  readonly hostInputs: AcpProductionOpenCodeHostInputs
    | AcpProductionCodexHostInputs
    | AcpProductionClaudeCodeHostInputs;
  readonly privateRootAuthority: SessionIdAcpTaskPrivateRootAuthority;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  readonly signal: AbortSignal;
}>;

export type SessionIdAcpProductionProviderModelCatalogInput = Readonly<{
  readonly hostInputs: AcpProductionOpenCodeHostInputs
    | AcpProductionCodexHostInputs
    | AcpProductionClaudeCodeHostInputs;
  readonly privateRootAuthority: SessionIdAcpTaskPrivateRootAuthority;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  readonly signal: AbortSignal;
}>;

/**
 * One Host-owned factory may open only one Provider family. Implementations
 * resolve and qualify the current installation; they may not hold a direct
 * Provider wire or return before failed-open cleanup is confirmed.
 */
export type SessionIdAcpProductionTaskNativeFactory = Readonly<{
  readonly providerFamily: SessionIdAcpProductionProviderFamily;
  /** Opens one temporary, prompt-free ACP Session and returns only its model selector. */
  readModelCatalog(
    input: SessionIdAcpProductionProviderModelCatalogInput,
  ): Promise<AcpProviderModelCatalogInspection>;
  /**
   * Runs one isolated current-install behavior probe. It never receives a Task
   * workspace or durable Task Binding and returns only a Renderer-safe report.
   */
  checkReadiness(
    input: SessionIdAcpProductionTaskReadinessInput,
  ): Promise<AcpProviderAvailabilityReport>;
  open(
    input: SessionIdAcpProductionTaskNativeFactoryOpenInput,
  ): Promise<SessionIdAcpProductionTaskNativeFactoryOpenResult>;
  close(): Promise<void>;
}>;

export type SessionIdAcpProductionTaskFactoryContext = Readonly<{
  readonly binding: AcpSafeSessionBindingRecordV3;
  readonly frozenProfile: AcpV3FrozenProfileTuple;
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: SessionIdAcpTaskRole;
  readonly bindingDisposition: SessionIdAcpTaskBindingDisposition;
  /** Host-only and deliberately absent from every safe observation. */
  readonly hostScope: SessionIdAcpTaskHostExecutionScope;
}>;

type OpenCodeAdapterOptions = Parameters<typeof createOpenCodeAcpTaskProfileAdapter>[0];
type ClaudeCodeAdapterOptions = Parameters<typeof createClaudeCodeAcpTaskProfileAdapter>[0];
type CodexAdapterOptions = Parameters<typeof createCodexAcpTaskProfileAdapter>[0];
type SessionIdAcpCurrentResolutionScope = Readonly<{
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly profileResolutionFingerprint: string;
}>;
type ControlledResolveCurrent = (input: Readonly<{
  readonly profile: ExecutionProfileDefinitionV3;
  readonly descriptor: AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3>;
}>) => SessionIdAcpCurrentResolutionScope | Promise<SessionIdAcpCurrentResolutionScope>;

export type SessionIdAcpProductionOpenCodeFactoryOptions = Readonly<{
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
  /** Required for load/resume; `create` may safely remain reconciling without one. */
  readonly resolveReconciler?: (
    input: SessionIdAcpProductionTaskFactoryContext,
  ) => AcpTaskPromptReconciler | undefined | Promise<AcpTaskPromptReconciler | undefined>;
  /** Constructor-only seam for deterministic no-live Host tests. Production omits it. */
  readonly controlledCreateAdapter?: (
    options: OpenCodeAdapterOptions,
  ) => OpenCodeAcpTaskProfileAdapter;
  readonly controlledResolveCurrent?: ControlledResolveCurrent;
}>;

export type SessionIdAcpProductionCodexFactoryOptions = Readonly<{
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
  /** Host-owned bounded probe for the isolated profile-readiness Binding. */
  readonly createReadinessProbe: (input: Readonly<{
    readonly profile: ExecutionProfileDefinitionV3;
    readonly role: SessionIdAcpTaskRole;
  }>) => CodexAcpNativeAttemptInput | Promise<CodexAcpNativeAttemptInput>;
  /** Host-owned qualification policy, including a scoped qualification turn lease when needed. */
  readonly createQualificationProbe: (
    input: SessionIdAcpProductionTaskFactoryContext,
  ) => CodexAcpNativeAttemptInput | Promise<CodexAcpNativeAttemptInput>;
  /** Required for load/resume; `create` may safely remain reconciling without one. */
  readonly resolveReconciler?: (
    input: SessionIdAcpProductionTaskFactoryContext,
  ) => AcpTaskPromptReconciler | undefined | Promise<AcpTaskPromptReconciler | undefined>;
  /** Constructor-only seams for deterministic no-live Host tests. Production omits them. */
  readonly controlled?: Readonly<{
    readonly createAdapter?: (
      options: CodexAdapterOptions,
    ) => CodexAcpTaskProfileAdapter;
    readonly resolveCurrent?: ControlledResolveCurrent;
  }>;
}>;

export type SessionIdAcpProductionClaudeCodeFactoryOptions = Readonly<{
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
  readonly resolveReconciler?: (
    input: SessionIdAcpProductionTaskFactoryContext,
  ) => AcpTaskPromptReconciler | undefined | Promise<AcpTaskPromptReconciler | undefined>;
  /** Constructor-only seams for deterministic no-live Host tests. */
  readonly controlledCreateAdapter?: (
    options: ClaudeCodeAdapterOptions,
  ) => ClaudeCodeAcpTaskProfileAdapter;
  readonly controlledResolveCurrent?: ControlledResolveCurrent;
}>;

export type SessionIdAcpProductionTaskProfileRegistration =
  | Readonly<{
      readonly status: "configured";
      readonly providerFamily: SessionIdAcpProductionProviderFamily;
      readonly executionProfileId: string;
      readonly profileRevisionId: string;
      readonly role: SessionIdAcpTaskRole;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
      readonly executionProfileId: string;
      readonly profileRevisionId: string;
      readonly role: SessionIdAcpTaskRole;
      readonly code: string;
    }>;

export type SessionIdAcpProductionTaskNativeOpenResult =
  | Readonly<{
      readonly available: true;
      readonly nativeBinding: AcpTaskSessionRuntimeNativeBinding;
    }>
  | Readonly<{
      readonly available: false;
      readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
      readonly executionProfileId: string;
      readonly profileRevisionId: string;
      readonly role: SessionIdAcpTaskRole;
      readonly code: string;
    }>;

export type SessionIdAcpProductionTaskNativeBindingRegistry = Readonly<{
  open(input: Readonly<{
    readonly binding: AcpSafeSessionBindingRecordV3;
    readonly frozenProfile: AcpV3FrozenProfileTuple;
    readonly profile: ExecutionProfileDefinitionV3;
    readonly role: SessionIdAcpTaskRole;
    readonly hostScope: SessionIdAcpTaskHostExecutionScope;
    readonly signal: AbortSignal;
    readonly observeDeliveryReceipt: (
      receipt: AcpTaskSessionRuntimeNativeDeliveryReceipt,
    ) => Promise<void>;
    readonly resolveTurnContext?: (
      input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
    ) => ProviderScopedToolTurnContext | undefined;
  }>): Promise<SessionIdAcpProductionTaskNativeOpenResult>;
  inspect(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
  ): SessionIdAcpProductionTaskProfileRegistration;
  close(): Promise<void>;
}>;

export type SessionIdAcpProductionMetaOwner = Readonly<{
  close(): Promise<void>;
}>;

export type AcpProductionMetaOwner = SessionIdAcpProductionMetaOwner & Readonly<{
  readonly providerComposition: AcpMetaProviderComposition;
  readonly registrations: readonly AcpMetaAgentRegistration[];
  toJSON(): Readonly<{
    readonly kind: "acp_production_meta_owner";
    readonly profileCount: number;
  }>;
}>;

export type AcpProductionMetaOwnerOptions = Readonly<{
  readonly configuration: AcpProductionConfiguration;
  readonly hostInputs: AcpProductionHostInputs;
  readonly privateAuthority: AcpRuntimeHostPrivateAuthority;
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
  readonly onHumanOnlyActivity?: Parameters<
    typeof createAcpMetaProviderComposition
  >[0]["onHumanOnlyActivity"];
  readonly onDiagnostic?: Parameters<
    typeof createAcpMetaProviderComposition
  >[0]["onDiagnostic"];
  /** Constructor-only no-live seam; production always uses the concrete owner. */
  readonly controlledCreateComposition?: typeof createAcpMetaProviderComposition;
}>;

export type SessionIdAcpProductionMetaRegistration =
  | Readonly<{
      readonly status: "configured";
      readonly owner: SessionIdAcpProductionMetaOwner;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly code: "acp_meta_profile_not_configured" | "acp_meta_owner_factory_not_registered";
    }>;

export type SessionIdAcpProductionComposition = Readonly<{
  readonly taskSessionRuntimeProvider: AcpTaskSessionRuntimeProvider;
  readonly taskNativeBindings: SessionIdAcpProductionTaskNativeBindingRegistry;
  readonly meta: SessionIdAcpProductionMetaRegistration;
  readonly nativeReleaseObservations: SessionIdAcpProductionNativeReleaseObservationOwner;
  inspectTaskProfile(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
  ): SessionIdAcpProductionTaskProfileRegistration;
  /** Explicit prompt-free ACP session used only by device Provider settings. */
  inspectProviderModelCatalog(
    providerFamily: SessionIdAcpProductionProviderFamily,
  ): Promise<AcpProviderModelCatalogInspection>;
  /** Pure cached projection. It never resolves an install or launches a child. */
  readTaskProfileReadiness(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
  ): AcpProfileReadinessObservation;
  /** Explicit Host effect. Only `force: true` runs a fresh bounded probe. */
  checkTaskProfileReadiness(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
    options: Readonly<{ readonly force: boolean }>,
  ): Promise<AcpProfileReadinessObservation>;
  close(): Promise<void>;
  toJSON(): Readonly<{
    readonly kind: "session_id_acp_production_composition";
    readonly taskProviders: readonly SessionIdAcpProductionProviderFamily[];
    readonly meta: "configured" | "unavailable";
  }>;
}>;

export type SessionIdAcpProductionCompositionOptions = Readonly<{
  readonly configuration: AcpProductionConfiguration;
  readonly hostInputs: AcpProductionHostInputs;
  readonly privateAuthority: AcpRuntimeHostPrivateAuthority;
  readonly repositories: AcpSessionRuntimeRepositories;
  readonly sessionRuntimeOwner: SessionExecutionRuntimeOwner;
  readonly resolveFrozenProfileTuple: AcpV3FrozenProfileTupleResolver;
  readonly resolveInterruptCorrelation: (
    scope: Readonly<{
      readonly taskId: string;
      readonly runId: string;
      readonly logicalSessionId: string;
      readonly sessionControlAuditId: string;
      readonly sessionExecutionAttemptId: string;
      readonly orchestrationSessionTurnId: string;
    }>,
  ) => AcpTaskSessionRuntimeInterruptCorrelationResolution;
  /** OR-owned exact task_stop Control proof; never inferred from Binding state. */
  readonly resolveTaskStopControl: NonNullable<
    AcpTaskSessionRuntimeProviderOptions["resolveTaskStopControl"]
  >;
  /** OR/TaskRun-owned exact close Control + current generation proof. */
  readonly resolveCloseControl: NonNullable<
    AcpTaskSessionRuntimeProviderOptions["resolveCloseControl"]
  >;
  /** Supervisor-issued confirmed-dead predecessor Host authority. */
  readonly authorizeRetiringBindingRecovery: NonNullable<
    AcpTaskSessionRuntimeProviderOptions["authorizeRetiringBindingRecovery"]
  >;
  /** Reads the exact immutable v3 Architecture entry and Card/Conductor role. */
  readonly resolveTaskBindingContext: (input: Readonly<{
    readonly binding: AcpSafeSessionBindingRecordV3;
    readonly frozenProfile: AcpV3FrozenProfileTuple;
  }>) => Readonly<{
    readonly profile: ExecutionProfileDefinitionV3;
    readonly role: SessionIdAcpTaskRole;
    readonly hostScope: SessionIdAcpTaskHostExecutionScope;
    readonly resolveTurnContext?: (
      input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
    ) => ProviderScopedToolTurnContext | undefined;
  }> | Promise<Readonly<{
    readonly profile: ExecutionProfileDefinitionV3;
    readonly role: SessionIdAcpTaskRole;
    readonly hostScope: SessionIdAcpTaskHostExecutionScope;
    readonly resolveTurnContext?: (
      input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
    ) => ProviderScopedToolTurnContext | undefined;
  }>>;
  /** Host owner callback; never a Renderer or provider callback. */
  readonly observeExecution: (
    observation: SessionIdAcpProductionExecutionObservation,
  ) => void | Promise<void>;
  /** Required durable SR seam; release branding waits for this exact attempt. */
  readonly observeFinalCandidate: (
    observation: SessionIdAcpProductionFinalCandidateObservation,
  ) => void | Promise<void>;
  /** OR-owned projection invoked only after the common SR receipt commit. */
  readonly onDeliveryReceipt: (
    receipt: AcpTaskSessionRuntimeDeliveryReceipt,
  ) => void | Promise<void>;
  /** Awaited after exact native qualification/open and before any submit can run. */
  readonly onBindingReady: (
    event: SessionRuntimeBindingReadyEvent,
  ) => void | Promise<void>;
  /** Host-process-only safe stage diagnostics; never persisted or bridged. */
  readonly onDiagnostic?: (diagnostic: Readonly<{
    code: string;
    role?: SessionIdAcpTaskRole;
    stage: string;
  }>) => void;
  readonly taskNativeFactories: Readonly<{
    readonly opencode?: SessionIdAcpProductionTaskNativeFactory;
    readonly codex?: SessionIdAcpProductionTaskNativeFactory;
    readonly "claude-code"?: SessionIdAcpProductionTaskNativeFactory;
  }>;
  readonly createMetaOwner?: (input: Readonly<{
    readonly configuration: AcpProductionConfiguration;
    readonly hostInputs: AcpProductionHostInputs;
    readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
  }>) => SessionIdAcpProductionMetaRegistration;
  readonly effectDeadlineMs: number;
}>;

export class SessionIdAcpProductionCompositionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SessionIdAcpProductionCompositionError";
    this.code = code;
  }
}

/**
 * Atomic ACP-only owner assembly. Provider-specific mechanics remain behind
 * current-install factories; the common Task adapter sees only exact v3
 * Binding/Profile input and provider-neutral native outcomes.
 */
export function createSessionIdAcpProductionComposition(
  options: SessionIdAcpProductionCompositionOptions,
): SessionIdAcpProductionComposition {
  validateOptions(options);
  const factories = normalizeFactories(options.taskNativeFactories);
  const taskReadiness = createTaskProfileReadinessOwner(options, factories);
  const taskNativeBindings = createTaskNativeBindingRegistry(options, factories, taskReadiness);
  const meta = createMetaRegistration(options);
  const nativeReleaseObservations = createProductionNativeReleaseObservationOwner(
    factories,
    meta,
  );
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const taskSessionRuntimeProvider = createAcpTaskSessionRuntimeProvider({
    repositories: options.repositories,
    sessionRuntimeOwner: options.sessionRuntimeOwner,
    resolveFrozenProfileTuple: options.resolveFrozenProfileTuple,
    resolveInterruptCorrelation: options.resolveInterruptCorrelation,
    resolveTaskStopControl: options.resolveTaskStopControl,
    resolveCloseControl: options.resolveCloseControl,
    authorizeRetiringBindingRecovery: options.authorizeRetiringBindingRecovery,
    onDeliveryReceipt: options.onDeliveryReceipt,
    effectDeadlineMs: options.effectDeadlineMs,
    ...(options.onDiagnostic ? {
      onDiagnostic: (diagnostic) => {
        try { options.onDiagnostic?.(diagnostic); } catch { /* observability only */ }
      },
    } : {}),
    async openNativeBinding({ binding, profile: frozenProfile, observeDeliveryReceipt, signal }) {
      ensureOpen();
      const resolved = normalizeResolvedTaskContext(
        await options.resolveTaskBindingContext({ binding, frozenProfile }),
      );
      reportTaskNativeDiagnostic(
        options,
        resolved.role,
        "acp_task_native_context_resolved",
        "native_context",
      );
      const reportAbort = () => reportTaskNativeDiagnostic(
        options,
        resolved.role,
        "acp_task_native_open_aborted",
        "native_open",
      );
      signal.addEventListener("abort", reportAbort, { once: true });
      reportTaskNativeDiagnostic(
        options,
        resolved.role,
        "acp_task_native_open_started",
        "native_open",
      );
      let result: SessionIdAcpProductionTaskNativeOpenResult;
      try {
        result = await taskNativeBindings.open({
          binding,
          frozenProfile,
          profile: resolved.profile,
          role: resolved.role,
          hostScope: resolved.hostScope,
          signal,
          observeDeliveryReceipt,
          ...(resolved.resolveTurnContext
            ? { resolveTurnContext: resolved.resolveTurnContext }
            : {}),
        });
      } finally {
        signal.removeEventListener("abort", reportAbort);
      }
      if (!result.available) throw safeError(result.code);
      reportTaskNativeDiagnostic(
        options,
        resolved.role,
        "acp_task_native_open_available",
        "native_open",
      );
      return result.nativeBinding;
    },
  });

  const composition: SessionIdAcpProductionComposition = Object.freeze({
    taskSessionRuntimeProvider,
    taskNativeBindings,
    meta,
    nativeReleaseObservations,
    inspectTaskProfile(profile, role) {
      ensureOpen();
      return taskNativeBindings.inspect(profile, role);
    },
    inspectProviderModelCatalog(providerFamily) {
      ensureOpen();
      return taskReadiness.inspectModelCatalog(providerFamily);
    },
    readTaskProfileReadiness(profile, role) {
      ensureOpen();
      return taskReadiness.read(profile, role);
    },
    checkTaskProfileReadiness(profile, role, readinessOptions) {
      ensureOpen();
      return taskReadiness.check(profile, role, readinessOptions);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const childResults: PromiseSettledResult<unknown>[] = [];
        childResults.push(await settle(taskSessionRuntimeProvider.close()));
        childResults.push(await settle(taskReadiness.close()));
        childResults.push(await settle(taskNativeBindings.close()));
        if (meta.status === "configured") {
          childResults.push(await settle(meta.owner.close()));
        }
        if (childResults.some((result) => result.status === "rejected")) {
          // Keep the Host epoch lease sticky when any child may still own a
          // process, credential, route or raw-session vault writer.
          throw safeError("acp_production_child_cleanup_unconfirmed");
        }
        try {
          options.privateAuthority.close();
        } catch {
          throw safeError("acp_production_private_authority_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
    toJSON() {
      return Object.freeze({
        kind: "session_id_acp_production_composition" as const,
        taskProviders: Object.freeze([...factories.keys()].sort()) as readonly SessionIdAcpProductionProviderFamily[],
        meta: meta.status,
      });
    },
  });
  return composition;

  function ensureOpen(): void {
    if (closed) throw safeError("acp_production_composition_closed");
  }
}

function createProductionNativeReleaseObservationOwner(
  factories: ReadonlyMap<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory>,
  meta: SessionIdAcpProductionMetaRegistration,
): SessionIdAcpProductionNativeReleaseObservationOwner {
  const ownerIdentity = Object.freeze(Object.create(null)) as object;
  const issuers: ProductionNativeReleaseIssuerState[] = [];
  for (const family of SUPPORTED_PROVIDER_FAMILIES) {
    const factory = factories.get(family);
    const issuer = factory
      ? PRODUCTION_TASK_FACTORY_RELEASE_ISSUERS.get(factory as object)
      : undefined;
    if (issuer?.eligible) issuers.push(issuer);
  }
  if (meta.status === "configured") {
    const issuer = PRODUCTION_META_OWNER_RELEASE_ISSUERS.get(meta.owner as object);
    if (issuer?.eligible) issuers.push(issuer);
  }
  if (new Set(issuers.map((issuer) => issuer.productionLane)).size !== issuers.length) {
    throw safeError("acp_production_native_release_lane_duplicate");
  }
  for (const issuer of issuers) {
    if (issuer.attachedOwner) {
      throw safeError("acp_production_native_release_issuer_reused");
    }
    issuer.attachedOwner = ownerIdentity;
  }
  return Object.freeze({
    list() {
      const summaries = issuers.flatMap((issuer) => issuer.capabilities.flatMap((capability) => {
        const state = PRODUCTION_NATIVE_RELEASE_CAPABILITIES.get(capability as object);
        if (!state || state.claimed || state.issuer !== issuer) return [];
        return [Object.freeze({ scope: state.scope, capability })];
      }));
      summaries.sort((left, right) => productionNativeReleaseScopeKey(left.scope)
        .localeCompare(productionNativeReleaseScopeKey(right.scope)));
      return Object.freeze(summaries);
    },
    claim(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || !sameKeys(input as unknown as Record<string, unknown>, [
          "capability",
          "expectedScope",
        ])) {
        throw safeError("acp_production_native_release_claim_invalid");
      }
      const capability = input.capability;
      if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
        throw safeError("acp_production_native_release_capability_unrecognized");
      }
      const state = PRODUCTION_NATIVE_RELEASE_CAPABILITIES.get(capability as object);
      if (!state) throw safeError("acp_production_native_release_capability_unrecognized");
      if (state.issuer.attachedOwner !== ownerIdentity || !issuers.includes(state.issuer)) {
        throw safeError("acp_production_native_release_authority_mismatch");
      }
      if (state.claimed) throw safeError("acp_production_native_release_already_claimed");
      if (!isProductionNativeReleaseScope(input.expectedScope)
        || productionNativeReleaseScopeKey(input.expectedScope)
          !== productionNativeReleaseScopeKey(state.scope)) {
        throw safeError("acp_production_native_release_scope_mismatch");
      }
      state.claimed = true;
      return state.observation;
    },
    listCheckpointFacts() {
      const summaries = issuers.flatMap((issuer) => (
        issuer.checkpointFactCapabilities.flatMap((capability) => {
          const state = PRODUCTION_NATIVE_CHECKPOINT_FACT_CAPABILITIES.get(
            capability as object,
          );
          if (!state || state.claimed || state.issuer !== issuer) return [];
          return [Object.freeze({ scope: state.scope, capability })];
        })
      ));
      summaries.sort((left, right) => productionNativeCheckpointFactScopeKey(left.scope)
        .localeCompare(productionNativeCheckpointFactScopeKey(right.scope)));
      return Object.freeze(summaries);
    },
    claimCheckpointFact(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || !sameKeys(input as unknown as Record<string, unknown>, [
          "capability",
          "expectedScope",
        ])) {
        throw safeError("acp_production_native_checkpoint_claim_invalid");
      }
      const capability = input.capability;
      if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
        throw safeError("acp_production_native_checkpoint_capability_unrecognized");
      }
      const state = PRODUCTION_NATIVE_CHECKPOINT_FACT_CAPABILITIES.get(
        capability as object,
      );
      if (!state) throw safeError("acp_production_native_checkpoint_capability_unrecognized");
      if (state.issuer.attachedOwner !== ownerIdentity || !issuers.includes(state.issuer)) {
        throw safeError("acp_production_native_checkpoint_authority_mismatch");
      }
      if (state.claimed) throw safeError("acp_production_native_checkpoint_already_claimed");
      if (!isProductionNativeCheckpointFactScope(input.expectedScope)
        || productionNativeCheckpointFactScopeKey(input.expectedScope)
          !== productionNativeCheckpointFactScopeKey(state.scope)) {
        throw safeError("acp_production_native_checkpoint_scope_mismatch");
      }
      state.claimed = true;
      return state.observation;
    },
  });
}

function mintProductionNativeReleaseObservation(input: Readonly<{
  readonly issuer: ProductionNativeReleaseIssuerState;
  readonly profile: AcpPortableProfileDefinitionV3;
  readonly role: SessionIdAcpTaskRole | "meta";
  readonly currentResolution?: SessionIdAcpCurrentResolutionScope;
  readonly lifecycle: AcpTargetLifecycleObservation;
}>): SessionIdAcpProductionNativeReleaseScope {
  const { issuer, profile, role, lifecycle } = input;
  if (!issuer.eligible) throw safeError("acp_production_native_release_issuer_ineligible");
  const expectedLane = role === "meta"
    ? "acp_meta_attestor"
    : profile.providerFamily === "opencode"
      ? "opencode_acp_task_attestor"
      : profile.providerFamily === "codex"
        ? "codex_acp_task_attestor"
        : undefined;
  const taskResolutionValid = role === "meta"
    ? input.currentResolution === undefined
    : Boolean(input.currentResolution
      && input.currentResolution.profileRevisionId === profile.profileRevisionId
      && input.currentResolution.providerFamily === profile.providerFamily
      && input.currentResolution.profileResolutionFingerprint === lifecycle.resolutionSealDigest);
  if (!expectedLane || issuer.productionLane !== expectedLane
    || lifecycle.evidenceClass !== "host_target_lifecycle_observation"
    || lifecycle.profileRevisionId !== profile.profileRevisionId
    || lifecycle.providerFamily !== profile.providerFamily
    || lifecycle.acpAgentKind !== profile.acpAgentKind
    || lifecycle.role !== role
    || lifecycle.model !== profile.model
    || lifecycle.profileConfigurationDigest !== productionProfileConfigurationDigest(profile)
    || !taskResolutionValid
    || !SHA256.test(lifecycle.resolutionSealDigest)
    || !SHA256.test(lifecycle.processGenerationDigest)
    || !SHA256.test(lifecycle.qualificationProbeDigest)
    || !SHA256.test(lifecycle.actualPrompt.attemptCorrelationDigest)
    || !SHA256.test(lifecycle.actualPrompt.lifecycleDigest)
    || !SHA256.test(lifecycle.cleanup.receiptDigest)) {
    throw safeError("acp_production_native_release_scope_mismatch");
  }
  const evidenceClass = role === "meta"
    ? "qualified_acp_meta" as const
    : "qualified_acp_provider" as const;
  const scope: SessionIdAcpProductionNativeReleaseScope = Object.freeze({
    schemaVersion: 1 as const,
    evidenceClass,
    productionLane: issuer.productionLane,
    profileRevisionId: lifecycle.profileRevisionId,
    providerFamily: lifecycle.providerFamily,
    acpAgentKind: lifecycle.acpAgentKind,
    role,
    model: lifecycle.model,
    profileConfigurationDigest: lifecycle.profileConfigurationDigest,
    resolutionSealDigest: lifecycle.resolutionSealDigest,
    observedArtifactVersion: lifecycle.observedArtifactVersion,
    ...(lifecycle.observedUpstreamVersion
      ? { observedUpstreamVersion: lifecycle.observedUpstreamVersion }
      : {}),
    processGenerationDigest: lifecycle.processGenerationDigest,
  });
  const observation: SessionIdAcpProductionNativeReleaseObservation = Object.freeze({
    ...scope,
    initialize: lifecycle.initialize,
    qualificationProbeDigest: lifecycle.qualificationProbeDigest,
    qualificationDigest: productionDigest({
      nonce: randomUUID(),
      productionLane: issuer.productionLane,
      scope: {
        profileRevisionId: scope.profileRevisionId,
        providerFamily: scope.providerFamily,
        acpAgentKind: scope.acpAgentKind,
        role: scope.role,
        model: scope.model,
        resolutionSealDigest: scope.resolutionSealDigest,
        processGenerationDigest: scope.processGenerationDigest,
      },
      initializeCapabilityFingerprint: lifecycle.initialize.capabilityFingerprint,
      qualificationProbeDigest: lifecycle.qualificationProbeDigest,
    }),
    actualPrompt: lifecycle.actualPrompt,
    cleanup: lifecycle.cleanup,
    productionReceiptDigest: productionDigest({
      nonce: randomUUID(),
      productionLane: issuer.productionLane,
      scope,
      initializeCapabilityFingerprint: lifecycle.initialize.capabilityFingerprint,
      qualificationProbeDigest: lifecycle.qualificationProbeDigest,
      lifecycleDigest: lifecycle.actualPrompt.lifecycleDigest,
      cleanupReceiptDigest: lifecycle.cleanup.receiptDigest,
    }),
  });
  const capability = Object.freeze(Object.create(null)) as
    SessionIdAcpProductionNativeReleaseCapability;
  PRODUCTION_NATIVE_RELEASE_CAPABILITIES.set(capability as object, {
    issuer,
    scope,
    observation,
    claimed: false,
  });
  issuer.capabilities.push(capability);
  return scope;
}

function mintProductionNativeCheckpointFactObservation(input: Readonly<{
  readonly issuer: ProductionNativeReleaseIssuerState;
  readonly releaseScope: SessionIdAcpProductionNativeReleaseScope;
  readonly fact: AcpTargetCheckpointFactObservation;
}>): void {
  const { issuer, releaseScope, fact } = input;
  const metaFact = isMetaCheckpointFactKind(fact.kind);
  if (!issuer.eligible
    || fact.evidenceClass !== "host_target_checkpoint_fact"
    || fact.profileRevisionId !== releaseScope.profileRevisionId
    || fact.providerFamily !== releaseScope.providerFamily
    || fact.acpAgentKind !== releaseScope.acpAgentKind
    || fact.role !== releaseScope.role
    || fact.model !== releaseScope.model
    || fact.profileConfigurationDigest !== releaseScope.profileConfigurationDigest
    || fact.resolutionSealDigest !== releaseScope.resolutionSealDigest
    || fact.processGenerationDigest !== releaseScope.processGenerationDigest
    || !SHA256.test(fact.observationDigest)
    || metaFact !== (releaseScope.role === "meta")
    || (fact.kind === "scoped_mcp_call"
      && releaseScope.role !== "conductor"
      && releaseScope.role !== "publisher")) {
    throw safeError("acp_production_native_checkpoint_scope_mismatch");
  }
  const scope: SessionIdAcpProductionNativeCheckpointFactScope = Object.freeze({
    ...releaseScope,
    kind: fact.kind,
  });
  if (issuer.checkpointFactCapabilities.some((capability) => {
    const existing = PRODUCTION_NATIVE_CHECKPOINT_FACT_CAPABILITIES.get(capability as object);
    return existing && productionNativeCheckpointFactScopeKey(existing.scope)
      === productionNativeCheckpointFactScopeKey(scope);
  })) {
    throw safeError("acp_production_native_checkpoint_duplicate");
  }
  const observation: SessionIdAcpProductionNativeCheckpointFactObservation = Object.freeze({
    ...scope,
    observationDigest: productionDigest({
      nonce: randomUUID(),
      productionLane: issuer.productionLane,
      scope,
      targetObservationDigest: fact.observationDigest,
    }),
  });
  const capability = Object.freeze(Object.create(null)) as
    SessionIdAcpProductionNativeCheckpointFactCapability;
  PRODUCTION_NATIVE_CHECKPOINT_FACT_CAPABILITIES.set(capability as object, {
    issuer,
    scope,
    observation,
    claimed: false,
  });
  issuer.checkpointFactCapabilities.push(capability);
}

function productionProfileConfigurationDigest(profile: AcpPortableProfileDefinitionV3): string {
  return productionDigest({
    model: profile.model,
    configIntent: profile.configIntent,
    requiredExtensions: profile.requiredExtensions,
    capabilityPolicy: profile.capabilityPolicy,
  });
}

function productionDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableProductionJson(value)).digest("hex")}`;
}

function stableProductionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableProductionJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableProductionJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isProductionNativeReleaseScope(
  value: unknown,
): value is SessionIdAcpProductionNativeReleaseScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<SessionIdAcpProductionNativeReleaseScope>;
  const expectedKeys = [
    "schemaVersion",
    "evidenceClass",
    "productionLane",
    "profileRevisionId",
    "providerFamily",
    "acpAgentKind",
    "role",
    "model",
    "profileConfigurationDigest",
    "resolutionSealDigest",
    "observedArtifactVersion",
    ...(scope.observedUpstreamVersion === undefined ? [] : ["observedUpstreamVersion"]),
    "processGenerationDigest",
  ];
  return sameKeys(value as Record<string, unknown>, expectedKeys)
    && scope.schemaVersion === 1
    && (scope.evidenceClass === "qualified_acp_provider"
      || scope.evidenceClass === "qualified_acp_meta")
    && (scope.productionLane === "opencode_acp_task_attestor"
      || scope.productionLane === "codex_acp_task_attestor"
      || scope.productionLane === "acp_meta_attestor")
    && typeof scope.profileRevisionId === "string" && PROFILE_REVISION_ID.test(scope.profileRevisionId)
    && typeof scope.providerFamily === "string"
    && typeof scope.acpAgentKind === "string"
    && (scope.role === "meta" || TASK_ROLES.includes(scope.role as SessionIdAcpTaskRole))
    && typeof scope.model === "string" && PORTABLE_MODEL_IDENTIFIER.test(scope.model)
    && typeof scope.profileConfigurationDigest === "string" && SHA256.test(scope.profileConfigurationDigest)
    && typeof scope.resolutionSealDigest === "string" && SHA256.test(scope.resolutionSealDigest)
    && typeof scope.observedArtifactVersion === "string" && scope.observedArtifactVersion.length > 0
    && (scope.observedUpstreamVersion === undefined
      || (typeof scope.observedUpstreamVersion === "string" && scope.observedUpstreamVersion.length > 0))
    && typeof scope.processGenerationDigest === "string" && SHA256.test(scope.processGenerationDigest);
}

function productionNativeReleaseScopeKey(scope: SessionIdAcpProductionNativeReleaseScope): string {
  return stableProductionJson(scope);
}

function isProductionNativeCheckpointFactScope(
  value: unknown,
): value is SessionIdAcpProductionNativeCheckpointFactScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { kind, ...releaseScope } = value as Record<string, unknown>;
  if (!isCheckpointFactKind(kind) || !isProductionNativeReleaseScope(releaseScope)) return false;
  const role = releaseScope.role;
  return isMetaCheckpointFactKind(kind) === (role === "meta")
    && (kind !== "scoped_mcp_call" || role === "conductor");
}

function productionNativeCheckpointFactScopeKey(
  scope: SessionIdAcpProductionNativeCheckpointFactScope,
): string {
  return stableProductionJson(scope);
}

function isCheckpointFactKind(value: unknown): value is AcpTargetCheckpointFactKind {
  return value === "actual_binding_generation"
    || value === "prompt_receipt"
    || value === "latest_final_terminal_pair"
    || value === "cancel_reconcile"
    || value === "restart_load_resume"
    || value === "scoped_mcp_call"
    || value === "independent_process"
    || value === "no_tools"
    || value === "no_cwd"
    || value === "no_workspace"
    || value === "strict_whole_final"
    || value === "permission_rejected"
    || value === "cold_reconcile";
}

function isMetaCheckpointFactKind(kind: AcpTargetCheckpointFactKind): boolean {
  return kind === "independent_process"
    || kind === "no_tools"
    || kind === "no_cwd"
    || kind === "no_workspace"
    || kind === "strict_whole_final"
    || kind === "permission_rejected"
    || kind === "cold_reconcile";
}

/**
 * Concrete production Meta assembly. It owns a Meta-only process composition,
 * current-install descriptors, credential acquisitions and private cwd root;
 * it never receives a Task workspace, Task vault or Task factory.
 */
export function createAcpProductionMetaOwner(
  options: AcpProductionMetaOwnerOptions,
): AcpProductionMetaOwner {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || !sameKeys(options as unknown as Record<string, unknown>, [
      "configuration",
      "hostInputs",
      "privateAuthority",
      ...(options && Object.hasOwn(options, "beforeQualificationEffect")
        ? ["beforeQualificationEffect"]
        : []),
      ...(options && Object.hasOwn(options, "onHumanOnlyActivity")
        ? ["onHumanOnlyActivity"]
        : []),
      ...(options && Object.hasOwn(options, "onDiagnostic")
        ? ["onDiagnostic"]
        : []),
      ...(options && Object.hasOwn(options, "controlledCreateComposition")
        ? ["controlledCreateComposition"]
        : []),
    ])
    || !options.configuration || !Array.isArray(options.configuration.metaProfiles)
    || !options.hostInputs || typeof options.hostInputs.openCode !== "function"
    || typeof options.hostInputs.codex !== "function"
    || typeof options.hostInputs.claudeCode !== "function"
    || !options.privateAuthority
    || typeof options.privateAuthority.metaIdentityVaults !== "function"
    || !options.privateAuthority.metaPrivateRootAuthority
    || (options.controlledCreateComposition !== undefined
      && typeof options.controlledCreateComposition !== "function")
    || (options.beforeQualificationEffect !== undefined
      && typeof options.beforeQualificationEffect !== "function")
    || (options.onHumanOnlyActivity !== undefined
      && typeof options.onHumanOnlyActivity !== "function")
    || (options.onDiagnostic !== undefined
      && typeof options.onDiagnostic !== "function")
    || (options.beforeQualificationEffect && options.controlledCreateComposition)) {
    throw safeError("acp_production_meta_owner_options_invalid");
  }
  const metaRoot = claimAcpMetaPrivateRootAuthority({
    authority: options.privateAuthority.metaPrivateRootAuthority,
    identityVaultResolver: options.privateAuthority.metaIdentityVaults,
  });
  const sessionRoot = ensureHostPrivateChildDirectory(metaRoot, "session-cwd");
  const openCodeRoot = ensureHostPrivateChildDirectory(metaRoot, "opencode");
  const openCodeInspectionRoot = ensureHostPrivateChildDirectory(openCodeRoot, "inspection");
  const openCodeInspection = Object.freeze({
    homeDirectory: ensureHostPrivateChildDirectory(openCodeInspectionRoot, "home"),
    configHome: ensureHostPrivateChildDirectory(openCodeInspectionRoot, "config"),
    dataHome: ensureHostPrivateChildDirectory(openCodeInspectionRoot, "data"),
    cacheHome: ensureHostPrivateChildDirectory(openCodeInspectionRoot, "cache"),
    stateHome: ensureHostPrivateChildDirectory(openCodeInspectionRoot, "state"),
    temporaryDirectory: ensureHostPrivateChildDirectory(openCodeInspectionRoot, "tmp"),
  });
  const openCodeCredentialRoot = ensureHostPrivateChildDirectory(openCodeRoot, "credentials");
  const codexRoot = ensureHostPrivateChildDirectory(metaRoot, "codex");
  const codexCredentialRoot = ensureHostPrivateChildDirectory(codexRoot, "credentials");
  const codexSessionDataRoot = ensureHostPrivateChildDirectory(codexRoot, "session-data");
  const claudeCodeRoot = ensureHostPrivateChildDirectory(metaRoot, "claude-code");
  const claudeCodeCredentialRoot = ensureHostPrivateChildDirectory(
    claudeCodeRoot,
    "credentials",
  );

  const profiles = Object.freeze(options.configuration.metaProfiles.map((entry) => {
    let registration: AcpMetaProfileRegistration;
    if (entry.profile.providerFamily === "opencode") {
      const hostInputs = options.hostInputs.openCode();
      if (!hostInputs) throw safeError("acp_production_meta_provider_not_configured");
      registration = Object.freeze({
        metaProfileOptionId: entry.metaProfileOptionId,
        title: entry.title,
        profile: entry.profile,
        descriptor: createOpenCodeAcpMetaCurrentInstallDescriptor({
          commandReference: hostInputs.commandReference,
          executableSearchPath: hostInputs.executableSearchPath,
          inspectionEnvironment: openCodeInspection,
        }),
        createConnection: createOfficialAcpV1StdioConnection,
        beginCredentialAcquisition: () => beginOpenCodeAcpCredentialAcquisition({
          privateRootParent: openCodeCredentialRoot,
          sourceAuthFile: hostInputs.authFile,
        }),
        sessionConfiguration: Object.freeze({
          ...compilePortableSessionConfiguration(entry.profile),
        }),
      });
    } else if (entry.profile.providerFamily === "codex") {
      const hostInputs = options.hostInputs.codex();
      if (!hostInputs) throw safeError("acp_production_meta_provider_not_configured");
      registration = Object.freeze({
        metaProfileOptionId: entry.metaProfileOptionId,
        title: entry.title,
        profile: entry.profile,
        descriptor: createCodexAcpMetaCurrentInstallDescriptor({
          wrapperCommandReference: hostInputs.wrapperCommandReference,
          codexCommandReference: hostInputs.codexCommandReference,
          nodeCommandReference: hostInputs.nodeCommandReference,
          executableSearchPath: hostInputs.executableSearchPath,
        }),
        createConnection: createOfficialAcpV1StdioConnection,
        beginCredentialAcquisition: ({ bindingHandle }) => {
          const persistentCodexHome = ensureHostPrivateChildDirectory(
            codexSessionDataRoot,
            `binding-${createHash("sha256").update(bindingHandle).digest("hex").slice(0, 32)}`,
          );
          return beginCodexAcpCredentialAcquisition({
            runtimePrivateRoot: codexCredentialRoot,
            authSourcePath: hostInputs.authFile,
            persistentCodexHome,
          });
        },
        sessionConfiguration: Object.freeze({
          ...compilePortableSessionConfiguration(entry.profile),
        }),
      });
    } else if (entry.profile.providerFamily === "claude-code") {
      const hostInputs = options.hostInputs.claudeCode();
      if (!hostInputs) throw safeError("acp_production_meta_provider_not_configured");
      registration = Object.freeze({
        metaProfileOptionId: entry.metaProfileOptionId,
        title: entry.title,
        profile: entry.profile,
        descriptor: createClaudeCodeAcpMetaCurrentInstallDescriptor({
          wrapperCommandReference: hostInputs.wrapperCommandReference,
          claudeCommandReference: hostInputs.claudeCommandReference,
          nodeCommandReference: hostInputs.nodeCommandReference,
          executableSearchPath: hostInputs.executableSearchPath,
          settingsSourcePath: hostInputs.settingsFile,
        }),
        createConnection: createClaudeCodeAcpV1StdioConnection({ nativeTools: "disabled" }),
        beginCredentialAcquisition: () => beginClaudeCodeAcpCredentialAcquisition({
          privateRootParent: claudeCodeCredentialRoot,
          sourceSettingsFile: hostInputs.settingsFile,
        }),
        sessionConfiguration: Object.freeze({
          ...compilePortableSessionConfiguration(entry.profile),
        }),
      });
    } else {
      throw safeError("acp_production_meta_provider_not_supported");
    }
    return registration;
  }));
  const createComposition = options.controlledCreateComposition
    ?? createAcpMetaProviderComposition;
  const releaseIssuer: ProductionNativeReleaseIssuerState = {
    productionLane: "acp_meta_attestor",
    eligible: options.controlledCreateComposition === undefined,
    capabilities: [],
    checkpointFactCapabilities: [],
  };
  const releaseScopesByProcessGeneration = new Map<
    string,
    SessionIdAcpProductionNativeReleaseScope
  >();
  const providerComposition = createComposition({
    profiles,
    privateRootParent: sessionRoot,
    processFactoryOptions: Object.freeze({
      identityVaultResolver: options.privateAuthority.metaIdentityVaults,
    }),
    ...(options.beforeQualificationEffect
      ? { beforeQualificationEffect: options.beforeQualificationEffect }
      : {}),
    ...(options.onHumanOnlyActivity
      ? { onHumanOnlyActivity: options.onHumanOnlyActivity }
      : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
    ...(releaseIssuer.eligible ? {
      onTargetLifecycleCapability(capability: AcpTargetLifecycleCapability) {
        const observation = claimAcpTargetLifecycleObservation(capability);
        const registration = profiles.find((entry) => (
          entry.profile.profileRevisionId === observation.profileRevisionId
        ));
        if (!registration) throw safeError("acp_production_native_release_profile_mismatch");
        const scope = mintProductionNativeReleaseObservation({
          issuer: releaseIssuer,
          profile: registration.profile,
          role: "meta",
          lifecycle: observation,
        });
        if (releaseScopesByProcessGeneration.has(scope.processGenerationDigest)) {
          throw safeError("acp_production_native_release_duplicate");
        }
        releaseScopesByProcessGeneration.set(scope.processGenerationDigest, scope);
      },
      onTargetCheckpointFactCapability(capability: AcpTargetCheckpointFactCapability) {
        const fact = claimAcpTargetCheckpointFactObservation(capability);
        const releaseScope = releaseScopesByProcessGeneration.get(
          fact.processGenerationDigest,
        );
        if (!releaseScope) throw safeError("acp_production_native_checkpoint_scope_mismatch");
        mintProductionNativeCheckpointFactObservation({
          issuer: releaseIssuer,
          releaseScope,
          fact,
        });
      },
    } : {}),
  });
  const registrations = createAcpMetaAgentRegistrations(providerComposition);
  let closePromise: Promise<void> | undefined;
  const owner: AcpProductionMetaOwner = Object.freeze({
    providerComposition,
    registrations,
    close() {
      closePromise ??= providerComposition.close().catch(() => {
        throw safeError("acp_production_meta_cleanup_unconfirmed");
      });
      return closePromise;
    },
    toJSON: () => Object.freeze({
      kind: "acp_production_meta_owner" as const,
      profileCount: profiles.length,
    }),
  });
  PRODUCTION_META_OWNER_RELEASE_ISSUERS.set(owner as object, releaseIssuer);
  return owner;
}

/**
 * Concrete OpenCode ACP factory. Host input is consumed here, not in the
 * unified Host entry: current-install discovery, credential acquisition,
 * private process storage and the Task identity vault are all owned by the
 * adapter; the target ACP Session uses the revalidated Task workspace.
 */
export function createOpenCodeAcpProductionTaskNativeFactory(
  options: SessionIdAcpProductionOpenCodeFactoryOptions = {},
): SessionIdAcpProductionTaskNativeFactory {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => ![
      "beforeQualificationEffect",
      "resolveReconciler",
      "controlledCreateAdapter",
      "controlledResolveCurrent",
    ].includes(key))
    || (options.resolveReconciler !== undefined
      && typeof options.resolveReconciler !== "function")
    || (options.beforeQualificationEffect !== undefined
      && typeof options.beforeQualificationEffect !== "function")
    || (options.beforeQualificationEffect
      && (options.controlledCreateAdapter || options.controlledResolveCurrent))
    || (options.controlledCreateAdapter !== undefined
      && typeof options.controlledCreateAdapter !== "function")
    || (options.controlledResolveCurrent !== undefined
      && typeof options.controlledResolveCurrent !== "function")) {
    throw safeError("acp_opencode_production_factory_options_invalid");
  }
  const createAdapter = options.controlledCreateAdapter ?? createOpenCodeAcpTaskProfileAdapter;
  const releaseIssuer: ProductionNativeReleaseIssuerState = {
    productionLane: "opencode_acp_task_attestor",
    eligible: options.controlledCreateAdapter === undefined
      && options.controlledResolveCurrent === undefined,
    capabilities: [],
    checkpointFactCapabilities: [],
  };
  const active = new Set<AcpTaskSessionRuntimeNativeBinding>();
  const readinessChecks = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const factory: SessionIdAcpProductionTaskNativeFactory = Object.freeze({
    providerFamily: "opencode" as const,
    readModelCatalog(input) {
      if (closed) return Promise.resolve(unavailableProviderModelCatalog(
        "acp_opencode_production_factory_closed",
      ));
      const pending = runProductionProviderModelCatalog(
        "opencode",
        options.beforeQualificationEffect,
        normalizeProviderModelCatalogInput(input, "opencode"),
      ).finally(() => { readinessChecks.delete(pending); });
      readinessChecks.add(pending);
      return pending;
    },
    checkReadiness(input) {
      const normalized = normalizeTaskReadinessInput(input, "opencode");
      if (closed) return Promise.resolve(unavailableAvailabilityReport(
        normalized.profile,
        normalized.role,
        "acp_opencode_production_factory_closed",
      ));
      const pending = runOpenCodeProductionReadiness(options, createAdapter, normalized)
        .finally(() => { readinessChecks.delete(pending); });
      readinessChecks.add(pending);
      return pending;
    },
    async open(input) {
      if (closed) return Object.freeze({
        available: false as const,
        code: "acp_opencode_production_factory_closed",
      });
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw safeError("acp_task_native_factory_input_invalid");
      }
      if (!input.profile || input.profile.providerFamily !== "opencode"
        || input.profile.acpAgentKind !== "native_acp"
        || !isOpenCodeHostInputs(input.hostInputs)) {
        throw safeError("acp_opencode_production_factory_scope_mismatch");
      }
      validateFactoryInput(input, "opencode");
      if (input.signal.aborted) return unavailableFactory("acp_task_native_open_aborted");
      let sessionConfiguration: AcpSessionConfigurationIntent;
      try {
        sessionConfiguration = compileTaskSessionConfiguration(input.profile);
      } catch {
        return unavailableFactory("acp_task_config_intent_unsupported");
      }
      let hostScope: SessionIdAcpTaskHostExecutionScope;
      let runtimePrivateRoot: string;
      try {
        const resolved = await resolveConcreteHostScope(
          input.hostScope,
          input.profile,
          input.identityVaultResolver,
        );
        hostScope = resolved.hostScope;
        runtimePrivateRoot = resolved.runtimePrivateRoot;
      } catch {
        return unavailableFactory("acp_opencode_host_authority_unavailable");
      }
      let privateDirectories: OpenCodeProductionPrivateDirectories;
      try {
        privateDirectories = await prepareOpenCodePrivateDirectories(runtimePrivateRoot);
      } catch {
        return unavailableFactory("acp_opencode_host_authority_unavailable");
      }
      const scopedMcpRoles = Object.freeze({
        target: createOpenCodeAcpScopedMcpRole({ role: input.role }),
        readiness: createOpenCodeAcpScopedMcpRole({ role: input.role }),
      });
      const descriptor = createOpenCodeAcpCurrentInstallDescriptor({
        commandReference: input.hostInputs.commandReference,
        executableSearchPath: input.hostInputs.executableSearchPath,
        inspectionEnvironment: privateDirectories.inspection,
        executionPolicy: scopedMcpRoles.target.executionPolicy,
      });
      let currentResolution: SessionIdAcpCurrentResolutionScope;
      try {
        currentResolution = await resolveCurrentResolutionScope(
          input.profile,
          descriptor,
          options.controlledResolveCurrent,
        );
      } catch {
        await closeOpenCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_opencode_current_install_unavailable");
      }
      let bindingDisposition: SessionIdAcpTaskBindingDisposition;
      let identityVaultResolver: AcpPrivateBindingVaultResolver;
      try {
        const resolved = resolveCurrentBindingDisposition(
          input.binding,
          input.identityVaultResolver,
          currentResolution,
        );
        bindingDisposition = resolved.bindingDisposition;
        identityVaultResolver = resolved.identityVaultResolver;
      } catch {
        await closeOpenCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_opencode_host_authority_unavailable");
      }
      const context = productionFactoryContext(input, hostScope, bindingDisposition);
      let reconciler: AcpTaskPromptReconciler | undefined;
      try {
        reconciler = await options.resolveReconciler?.(context);
      } catch {
        await closeOpenCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_opencode_reconciler_unavailable");
      }
      if (bindingDisposition !== "create" && !reconciler) {
        await closeOpenCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_opencode_reconciler_not_configured");
      }
      const persistedFinalCandidateDigests = new Set<string>();
      const observeTarget = async (observation: AcpSessionObservation): Promise<void> => {
        await input.onObservation(observation);
        if (observation.kind === "final_candidate") {
          persistedFinalCandidateDigests.add(productionDigest({
            attemptId: observation.attemptId,
          }));
        }
      };
      let targetLifecycleNotice: AcpTargetLifecycleCapabilityNotice | undefined;
      const targetCheckpointNotices: AcpTargetCheckpointFactCapabilityNotice[] = [];
      const targetProviderComposition = releaseIssuer.eligible
        ? createAcpProviderComposition({
            processes: createAcpAgentProcessFactory({ identityVaultResolver }),
            ...(options.beforeQualificationEffect
              ? { beforeQualificationEffect: options.beforeQualificationEffect }
              : {}),
            onTargetLifecycleCapability(notice) {
              if (notice.bindingHandle !== input.binding.bindingHandle) {
                throw safeError("acp_production_native_release_binding_mismatch");
              }
              if (targetLifecycleNotice) {
                throw safeError("acp_production_native_release_duplicate");
              }
              targetLifecycleNotice = notice;
            },
            onTargetCheckpointFactCapability(notice) {
              if (notice.bindingHandle !== input.binding.bindingHandle) {
                throw safeError("acp_production_native_checkpoint_binding_mismatch");
              }
              if (targetCheckpointNotices.some((entry) => entry.capability === notice.capability)) {
                throw safeError("acp_production_native_checkpoint_duplicate");
              }
              targetCheckpointNotices.push(notice);
            },
          })
        : undefined;
      let adapter: OpenCodeAcpTaskProfileAdapter;
      try {
        const created = createAdapter({
          profile: input.profile,
          role: input.role,
          workspaceDirectory: hostScope.authorizedWorkspaceDirectory,
          bindingDisposition,
          scopedMcpRoles,
          currentInstall: {
            commandReference: input.hostInputs.commandReference,
            executableSearchPath: input.hostInputs.executableSearchPath,
            inspectionEnvironment: privateDirectories.inspection,
          },
          credentialAcquisition: {
            privateRootParent: privateDirectories.providerRoot,
            sourceAuthFile: input.hostInputs.authFile,
          },
          sessionConfiguration,
          ...(targetProviderComposition
            ? { composition: targetProviderComposition }
            : { identityVaultResolver }),
          ...(!targetProviderComposition && options.beforeQualificationEffect
            ? { beforeQualificationEffect: options.beforeQualificationEffect }
            : {}),
          createQualificationAttemptId: () => (
            `session_execution_attempt_opencode_qualification_${randomUUID().replaceAll("-", "")}`
          ),
          ...(reconciler ? { reconciler } : {}),
          onObservation: observeTarget,
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
        adapter = targetProviderComposition
          ? ownOpenCodeProviderComposition(created, targetProviderComposition)
          : created;
      } catch {
        const cleanup = await Promise.all([
          settle(closeOpenCodeScopedRoles(scopedMcpRoles)),
          ...(targetProviderComposition
            ? [settle(targetProviderComposition.close())]
            : []),
        ]);
        if (cleanup.some((entry) => entry.status === "rejected")) {
          throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory("acp_opencode_current_install_unavailable");
      }
      let opened;
      try {
        opened = await adapter.openBinding({ bindingHandle: input.binding.bindingHandle });
      } catch (error) {
        if (!await closeOpenCodeAdapter(adapter)) {
          throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
        }
        if (isCleanupUnconfirmed(error)) {
          throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory("acp_opencode_current_install_unavailable");
      }
      if (!opened.available) {
        if (!await closeOpenCodeAdapter(adapter)) {
          throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory(availabilityUnavailableCode(
          opened.report,
          "acp_opencode_current_install_unavailable",
        ));
      }
      const runtime = opened.runtime;
      if (!runtime) throw safeError("acp_opencode_qualified_binding_invalid");
      let native: AcpTaskSessionRuntimeNativeBinding;
      try {
        native = createAcpTaskSessionRuntimeNativeBinding({
          driver: OPENCODE_ACP_TASK_NATIVE_DRIVER,
          adapter,
          runtime,
          profile: input.frozenProfile,
          ...(input.resolveTurnContext
            ? { resolveTurnContext: input.resolveTurnContext }
            : {}),
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
      } catch (error) {
        const retirement = await settle(runtime.releaseBinding());
        const closure = await settle(adapter.close());
        if (retirement.status === "rejected" || closure.status === "rejected") {
          throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
        }
        throw error;
      }
      const tracked = trackNativeBinding(native, active, () => {
        if (!targetLifecycleNotice) return;
        const notice = targetLifecycleNotice;
        targetLifecycleNotice = undefined;
        const lifecycle = claimAcpTargetLifecycleObservation(notice.capability);
        if (!persistedFinalCandidateDigests.has(
          lifecycle.actualPrompt.attemptCorrelationDigest,
        )) return;
        const releaseScope = mintProductionNativeReleaseObservation({
          issuer: releaseIssuer,
          profile: input.profile,
          role: input.role,
          currentResolution,
          lifecycle,
        });
        for (const checkpointNotice of targetCheckpointNotices.splice(0)) {
          mintProductionNativeCheckpointFactObservation({
            issuer: releaseIssuer,
            releaseScope,
            fact: claimAcpTargetCheckpointFactObservation(checkpointNotice.capability),
          });
        }
      });
      active.add(tracked);
      return Object.freeze({ available: true as const, nativeBinding: tracked });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const checks = await Promise.allSettled([...readinessChecks]);
        const bindings = await settle(closeTrackedNativeBindings(
          active,
          "acp_opencode_production_factory_cleanup_unconfirmed",
        ));
        if (checks.some((result) => result.status === "rejected")
          || bindings.status === "rejected") {
          throw safeError("acp_opencode_production_factory_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
  PRODUCTION_TASK_FACTORY_RELEASE_ISSUERS.set(factory as object, releaseIssuer);
  return factory;
}

/**
 * Concrete Claude Code ACP counterpart. The target ACP Session receives the
 * revalidated Task workspace, while the child process and provider state stay
 * under the empty Host-private Task/Claude namespace.
 */
export function createClaudeCodeAcpProductionTaskNativeFactory(
  options: SessionIdAcpProductionClaudeCodeFactoryOptions = {},
): SessionIdAcpProductionTaskNativeFactory {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => ![
      "beforeQualificationEffect",
      "resolveReconciler",
      "controlledCreateAdapter",
      "controlledResolveCurrent",
    ].includes(key))
    || (options.resolveReconciler !== undefined
      && typeof options.resolveReconciler !== "function")
    || (options.beforeQualificationEffect !== undefined
      && typeof options.beforeQualificationEffect !== "function")
    || (options.beforeQualificationEffect
      && (options.controlledCreateAdapter || options.controlledResolveCurrent))
    || (options.controlledCreateAdapter !== undefined
      && typeof options.controlledCreateAdapter !== "function")
    || (options.controlledResolveCurrent !== undefined
      && typeof options.controlledResolveCurrent !== "function")) {
    throw safeError("acp_claude_code_production_factory_options_invalid");
  }
  const createAdapter = options.controlledCreateAdapter ?? createClaudeCodeAcpTaskProfileAdapter;
  const active = new Set<AcpTaskSessionRuntimeNativeBinding>();
  const readinessChecks = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const factory: SessionIdAcpProductionTaskNativeFactory = Object.freeze({
    providerFamily: "claude-code" as const,
    readModelCatalog(input) {
      if (closed) return Promise.resolve(unavailableProviderModelCatalog(
        "acp_claude_code_production_factory_closed",
      ));
      const pending = runProductionProviderModelCatalog(
        "claude-code",
        options.beforeQualificationEffect,
        normalizeProviderModelCatalogInput(input, "claude-code"),
      ).finally(() => { readinessChecks.delete(pending); });
      readinessChecks.add(pending);
      return pending;
    },
    checkReadiness(input) {
      const normalized = normalizeTaskReadinessInput(input, "claude-code");
      if (closed) return Promise.resolve(unavailableAvailabilityReport(
        normalized.profile,
        normalized.role,
        "acp_claude_code_production_factory_closed",
      ));
      const pending = runClaudeCodeProductionReadiness(options, createAdapter, normalized)
        .finally(() => { readinessChecks.delete(pending); });
      readinessChecks.add(pending);
      return pending;
    },
    async open(input) {
      if (closed) return Object.freeze({
        available: false as const,
        code: "acp_claude_code_production_factory_closed",
      });
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw safeError("acp_task_native_factory_input_invalid");
      }
      if (!input.profile || input.profile.providerFamily !== "claude-code"
        || input.profile.acpAgentKind !== "claude_agent_acp"
        || !isClaudeCodeHostInputs(input.hostInputs)) {
        throw safeError("acp_claude_code_production_factory_scope_mismatch");
      }
      validateFactoryInput(input, "claude-code");
      if (input.signal.aborted) return unavailableFactory("acp_task_native_open_aborted");
      let sessionConfiguration: AcpSessionConfigurationIntent;
      try {
        sessionConfiguration = compileTaskSessionConfiguration(input.profile);
      } catch {
        return unavailableFactory("acp_task_config_intent_unsupported");
      }
      let hostScope: SessionIdAcpTaskHostExecutionScope;
      let runtimePrivateRoot: string;
      try {
        const resolved = await resolveConcreteHostScope(
          input.hostScope,
          input.profile,
          input.identityVaultResolver,
        );
        hostScope = resolved.hostScope;
        runtimePrivateRoot = resolved.runtimePrivateRoot;
      } catch {
        return unavailableFactory("acp_claude_code_host_authority_unavailable");
      }
      let privateDirectories: ClaudeCodeProductionPrivateDirectories;
      try {
        privateDirectories = await prepareClaudeCodePrivateDirectories(runtimePrivateRoot);
      } catch {
        return unavailableFactory("acp_claude_code_host_authority_unavailable");
      }
      const scopedMcpRoles = Object.freeze({
        target: createClaudeCodeAcpScopedMcpRole({ role: input.role }),
        readiness: createClaudeCodeAcpScopedMcpRole({ role: input.role }),
      });
      const descriptor = createClaudeCodeAcpCurrentInstallDescriptor({
        wrapperCommandReference: input.hostInputs.wrapperCommandReference,
        claudeCommandReference: input.hostInputs.claudeCommandReference,
        nodeCommandReference: input.hostInputs.nodeCommandReference,
        executableSearchPath: input.hostInputs.executableSearchPath,
        settingsSourcePath: input.hostInputs.settingsFile,
      });
      let currentResolution: SessionIdAcpCurrentResolutionScope;
      try {
        currentResolution = await resolveCurrentResolutionScope(
          input.profile,
          descriptor,
          options.controlledResolveCurrent,
        );
      } catch {
        await closeClaudeCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_claude_code_current_install_unavailable");
      }
      let bindingDisposition: SessionIdAcpTaskBindingDisposition;
      let identityVaultResolver: AcpPrivateBindingVaultResolver;
      try {
        const resolved = resolveCurrentBindingDisposition(
          input.binding,
          input.identityVaultResolver,
          currentResolution,
        );
        bindingDisposition = resolved.bindingDisposition;
        identityVaultResolver = resolved.identityVaultResolver;
      } catch {
        await closeClaudeCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_claude_code_host_authority_unavailable");
      }
      const context = productionFactoryContext(input, hostScope, bindingDisposition);
      let reconciler: AcpTaskPromptReconciler | undefined;
      try {
        reconciler = await options.resolveReconciler?.(context);
      } catch {
        await closeClaudeCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_claude_code_reconciler_unavailable");
      }
      if (bindingDisposition !== "create" && !reconciler) {
        await closeClaudeCodeScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_claude_code_reconciler_not_configured");
      }
      const observeTarget = async (observation: AcpSessionObservation): Promise<void> => {
        await input.onObservation(observation);
      };
      let adapter: ClaudeCodeAcpTaskProfileAdapter;
      try {
        const created = createAdapter({
          profile: input.profile,
          role: input.role,
          workspaceDirectory: hostScope.authorizedWorkspaceDirectory,
          bindingDisposition,
          scopedMcpRoles,
          currentInstall: {
            wrapperCommandReference: input.hostInputs.wrapperCommandReference,
            claudeCommandReference: input.hostInputs.claudeCommandReference,
            nodeCommandReference: input.hostInputs.nodeCommandReference,
            executableSearchPath: input.hostInputs.executableSearchPath,
            settingsSourcePath: input.hostInputs.settingsFile,
          },
          credentialAcquisition: {
            privateRootParent: privateDirectories.providerRoot,
            sourceSettingsFile: input.hostInputs.settingsFile,
          },
          sessionConfiguration,
          identityVaultResolver,
          ...(options.beforeQualificationEffect
            ? { beforeQualificationEffect: options.beforeQualificationEffect }
            : {}),
          createQualificationAttemptId: () => (
            `session_execution_attempt_claude_code_qualification_${randomUUID().replaceAll("-", "")}`
          ),
          ...(reconciler ? { reconciler } : {}),
          onObservation: observeTarget,
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
        adapter = created;
      } catch {
        const cleanup = await Promise.all([settle(closeClaudeCodeScopedRoles(scopedMcpRoles))]);
        if (cleanup.some((entry) => entry.status === "rejected")) {
          throw safeError("acp_claude_code_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory("acp_claude_code_current_install_unavailable");
      }
      let opened;
      try {
        opened = await adapter.openBinding({ bindingHandle: input.binding.bindingHandle });
      } catch (error) {
        if (!await closeClaudeCodeAdapter(adapter)) {
          throw safeError("acp_claude_code_qualified_binding_cleanup_unconfirmed");
        }
        if (isCleanupUnconfirmed(error)) {
          throw safeError("acp_claude_code_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory("acp_claude_code_current_install_unavailable");
      }
      if (!opened.available) {
        if (!await closeClaudeCodeAdapter(adapter)) {
          throw safeError("acp_claude_code_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory(availabilityUnavailableCode(
          opened.report,
          "acp_claude_code_current_install_unavailable",
        ));
      }
      const runtime = opened.runtime;
      if (!runtime) throw safeError("acp_claude_code_qualified_binding_invalid");
      let native: AcpTaskSessionRuntimeNativeBinding;
      try {
        native = createAcpTaskSessionRuntimeNativeBinding({
          driver: CLAUDE_CODE_ACP_TASK_NATIVE_DRIVER,
          adapter,
          runtime,
          profile: input.frozenProfile,
          ...(input.resolveTurnContext
            ? { resolveTurnContext: input.resolveTurnContext }
            : {}),
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
      } catch (error) {
        const retirement = await settle(runtime.releaseBinding());
        const closure = await settle(adapter.close());
        if (retirement.status === "rejected" || closure.status === "rejected") {
          throw safeError("acp_claude_code_qualified_binding_cleanup_unconfirmed");
        }
        throw error;
      }
      const tracked = trackNativeBinding(native, active);
      active.add(tracked);
      return Object.freeze({ available: true as const, nativeBinding: tracked });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const checks = await Promise.allSettled([...readinessChecks]);
        const bindings = await settle(closeTrackedNativeBindings(
          active,
          "acp_claude_code_production_factory_cleanup_unconfirmed",
        ));
        if (checks.some((result) => result.status === "rejected")
          || bindings.status === "rejected") {
          throw safeError("acp_claude_code_production_factory_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
  return factory;
}

/**
 * Concrete Codex ACP counterpart. The target ACP Session receives the
 * revalidated Task workspace, while the child process and provider state stay
 * under the empty Host-private Task/Codex namespace.
 */
export function createCodexAcpProductionTaskNativeFactory(
  options: SessionIdAcpProductionCodexFactoryOptions,
): SessionIdAcpProductionTaskNativeFactory {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => ![
      "beforeQualificationEffect",
      "createQualificationProbe",
      "createReadinessProbe",
      "resolveReconciler",
      "controlled",
    ].includes(key))
    || typeof options.createReadinessProbe !== "function"
    || typeof options.createQualificationProbe !== "function"
    || (options.resolveReconciler !== undefined
      && typeof options.resolveReconciler !== "function")
    || (options.beforeQualificationEffect !== undefined
      && typeof options.beforeQualificationEffect !== "function")
    || (options.beforeQualificationEffect
      && options.controlled)
    || (options.controlled !== undefined
      && (!options.controlled || typeof options.controlled !== "object"
        || Array.isArray(options.controlled)
        || Object.keys(options.controlled).some((key) => ![
          "createAdapter",
          "resolveCurrent",
        ].includes(key))
        || (options.controlled.createAdapter !== undefined
          && typeof options.controlled.createAdapter !== "function")
        || (options.controlled.resolveCurrent !== undefined
          && typeof options.controlled.resolveCurrent !== "function")))) {
    throw safeError("acp_codex_production_factory_options_invalid");
  }
  const createAdapter = options.controlled?.createAdapter ?? createCodexAcpTaskProfileAdapter;
  const releaseIssuer: ProductionNativeReleaseIssuerState = {
    productionLane: "codex_acp_task_attestor",
    eligible: options.controlled === undefined,
    capabilities: [],
    checkpointFactCapabilities: [],
  };
  const active = new Set<AcpTaskSessionRuntimeNativeBinding>();
  const readinessChecks = new Set<Promise<unknown>>();
  let closePromise: Promise<void> | undefined;
  let closed = false;
  const factory: SessionIdAcpProductionTaskNativeFactory = Object.freeze({
    providerFamily: "codex" as const,
    readModelCatalog(input) {
      if (closed) return Promise.resolve(unavailableProviderModelCatalog(
        "acp_codex_production_factory_closed",
      ));
      const pending = runProductionProviderModelCatalog(
        "codex",
        options.beforeQualificationEffect,
        normalizeProviderModelCatalogInput(input, "codex"),
      ).finally(() => { readinessChecks.delete(pending); });
      readinessChecks.add(pending);
      return pending;
    },
    checkReadiness(input) {
      const normalized = normalizeTaskReadinessInput(input, "codex");
      if (closed) return Promise.resolve(unavailableAvailabilityReport(
        normalized.profile,
        normalized.role,
        "acp_codex_production_factory_closed",
      ));
      const pending = runCodexProductionReadiness(options, createAdapter, normalized)
        .finally(() => { readinessChecks.delete(pending); });
      readinessChecks.add(pending);
      return pending;
    },
    async open(input) {
      if (closed) return Object.freeze({
        available: false as const,
        code: "acp_codex_production_factory_closed",
      });
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw safeError("acp_task_native_factory_input_invalid");
      }
      if (!input.profile || input.profile.providerFamily !== "codex"
        || input.profile.acpAgentKind !== "codex_acp"
        || !isCodexHostInputs(input.hostInputs)) {
        throw safeError("acp_codex_production_factory_scope_mismatch");
      }
      validateFactoryInput(input, "codex");
      if (input.signal.aborted) return unavailableFactory("acp_task_native_open_aborted");
      let sessionConfiguration: AcpSessionConfigurationIntent;
      try {
        sessionConfiguration = compileTaskSessionConfiguration(input.profile);
      } catch {
        return unavailableFactory("acp_task_config_intent_unsupported");
      }
      let hostScope: SessionIdAcpTaskHostExecutionScope;
      let runtimePrivateRoot: string;
      try {
        const resolved = await resolveConcreteHostScope(
          input.hostScope,
          input.profile,
          input.identityVaultResolver,
        );
        hostScope = resolved.hostScope;
        runtimePrivateRoot = resolved.runtimePrivateRoot;
      } catch {
        return unavailableFactory("acp_codex_host_authority_unavailable");
      }
      let privateDirectories: CodexProductionPrivateDirectories;
      try {
        privateDirectories = await prepareCodexProfilePrivateDirectories(runtimePrivateRoot);
      } catch {
        return unavailableFactory("acp_codex_host_authority_unavailable");
      }
      const scopedMcpRoles = Object.freeze({
        target: createCodexAcpScopedMcpRole({ role: input.role }),
        readiness: createCodexAcpScopedMcpRole({ role: input.role }),
      });
      const descriptor = createCodexAcpCurrentInstallDescriptor({
        wrapperCommandReference: input.hostInputs.wrapperCommandReference,
        codexCommandReference: input.hostInputs.codexCommandReference,
        nodeCommandReference: input.hostInputs.nodeCommandReference,
        executableSearchPath: input.hostInputs.executableSearchPath,
      });
      let currentResolution: SessionIdAcpCurrentResolutionScope;
      try {
        currentResolution = await resolveCurrentResolutionScope(
          input.profile,
          descriptor,
          options.controlled?.resolveCurrent,
        );
      } catch {
        await closeCodexScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_codex_current_install_unavailable");
      }
      let bindingDisposition: SessionIdAcpTaskBindingDisposition;
      let identityVaultResolver: AcpPrivateBindingVaultResolver;
      try {
        const resolved = resolveCurrentBindingDisposition(
          input.binding,
          input.identityVaultResolver,
          currentResolution,
        );
        bindingDisposition = resolved.bindingDisposition;
        identityVaultResolver = resolved.identityVaultResolver;
      } catch {
        await closeCodexScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_codex_host_authority_unavailable");
      }
      const context = productionFactoryContext(input, hostScope, bindingDisposition);
      let qualificationProbe: CodexAcpNativeAttemptInput;
      let reconciler: AcpTaskPromptReconciler | undefined;
      try {
        qualificationProbe = await options.createQualificationProbe(context);
        reconciler = await options.resolveReconciler?.(context);
      } catch {
        await closeCodexScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_codex_reconciler_unavailable");
      }
      if (bindingDisposition !== "create" && !reconciler) {
        await closeCodexScopedRoles(scopedMcpRoles);
        return unavailableFactory("acp_codex_reconciler_not_configured");
      }
      const persistedFinalCandidateDigests = new Set<string>();
      const observeTarget = async (observation: AcpSessionObservation): Promise<void> => {
        await input.onObservation(observation);
        if (observation.kind === "final_candidate") {
          persistedFinalCandidateDigests.add(productionDigest({
            attemptId: observation.attemptId,
          }));
        }
      };
      let targetLifecycleNotice: AcpTargetLifecycleCapabilityNotice | undefined;
      const targetCheckpointNotices: AcpTargetCheckpointFactCapabilityNotice[] = [];
      const targetProviderComposition = releaseIssuer.eligible
        ? createAcpProviderComposition({
            processes: createAcpAgentProcessFactory({ identityVaultResolver }),
            ...(options.beforeQualificationEffect
              ? { beforeQualificationEffect: options.beforeQualificationEffect }
              : {}),
            onTargetLifecycleCapability(notice) {
              if (notice.bindingHandle !== input.binding.bindingHandle) {
                throw safeError("acp_production_native_release_binding_mismatch");
              }
              if (targetLifecycleNotice) {
                throw safeError("acp_production_native_release_duplicate");
              }
              targetLifecycleNotice = notice;
            },
            onTargetCheckpointFactCapability(notice) {
              if (notice.bindingHandle !== input.binding.bindingHandle) {
                throw safeError("acp_production_native_checkpoint_binding_mismatch");
              }
              if (targetCheckpointNotices.some((entry) => entry.capability === notice.capability)) {
                throw safeError("acp_production_native_checkpoint_duplicate");
              }
              targetCheckpointNotices.push(notice);
            },
          })
        : undefined;
      let adapter: CodexAcpTaskProfileAdapter;
      try {
        const created = createAdapter({
          profile: input.profile,
          role: input.role,
          workspaceDirectory: hostScope.authorizedWorkspaceDirectory,
          bindingDisposition,
          scopedMcpRoles,
          currentInstall: {
            wrapperCommandReference: input.hostInputs.wrapperCommandReference,
            codexCommandReference: input.hostInputs.codexCommandReference,
            nodeCommandReference: input.hostInputs.nodeCommandReference,
            executableSearchPath: input.hostInputs.executableSearchPath,
          },
          credentialAcquisition: {
            runtimePrivateRoot: privateDirectories.providerRoot,
            authSourcePath: input.hostInputs.authFile,
          },
          sessionConfiguration,
          ...(targetProviderComposition
            ? { composition: targetProviderComposition }
            : { identityVaultResolver }),
          ...(!targetProviderComposition && options.beforeQualificationEffect
            ? { beforeQualificationEffect: options.beforeQualificationEffect }
            : {}),
          createQualificationProbe: () => codexTaskQualificationProbe(qualificationProbe),
          ...(reconciler ? { reconciler } : {}),
          onObservation: observeTarget,
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
        adapter = targetProviderComposition
          ? ownCodexProviderComposition(created, targetProviderComposition)
          : created;
      } catch {
        const cleanup = await Promise.all([
          settle(closeCodexScopedRoles(scopedMcpRoles)),
          ...(targetProviderComposition
            ? [settle(targetProviderComposition.close())]
            : []),
        ]);
        if (cleanup.some((entry) => entry.status === "rejected")) {
          throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory("acp_codex_current_install_unavailable");
      }
      let opened;
      try {
        opened = await adapter.openBinding({ bindingHandle: input.binding.bindingHandle });
      } catch (error) {
        if (!await closeCodexAdapter(adapter)) {
          throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
        }
        if (isCleanupUnconfirmed(error)) {
          throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory("acp_codex_current_install_unavailable");
      }
      if (!opened.available) {
        if (!await closeCodexAdapter(adapter)) {
          throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
        }
        return unavailableFactory(availabilityUnavailableCode(
          opened.report,
          "acp_codex_current_install_unavailable",
        ));
      }
      const runtime = opened.runtime;
      if (!runtime) throw safeError("acp_codex_qualified_binding_invalid");
      let native: AcpTaskSessionRuntimeNativeBinding;
      try {
        native = createAcpTaskSessionRuntimeNativeBinding({
          driver: CODEX_ACP_TASK_NATIVE_DRIVER,
          adapter,
          runtime,
          profile: input.frozenProfile,
          ...(input.resolveTurnContext
            ? { resolveTurnContext: input.resolveTurnContext }
            : {}),
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
        });
      } catch (error) {
        const retirement = await settle(runtime.releaseBinding());
        const closure = await settle(adapter.close());
        if (retirement.status === "rejected" || closure.status === "rejected") {
          throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
        }
        throw error;
      }
      const tracked = trackNativeBinding(native, active, () => {
        if (!targetLifecycleNotice) return;
        const notice = targetLifecycleNotice;
        targetLifecycleNotice = undefined;
        const lifecycle = claimAcpTargetLifecycleObservation(notice.capability);
        if (!persistedFinalCandidateDigests.has(
          lifecycle.actualPrompt.attemptCorrelationDigest,
        )) return;
        const releaseScope = mintProductionNativeReleaseObservation({
          issuer: releaseIssuer,
          profile: input.profile,
          role: input.role,
          currentResolution,
          lifecycle,
        });
        for (const checkpointNotice of targetCheckpointNotices.splice(0)) {
          mintProductionNativeCheckpointFactObservation({
            issuer: releaseIssuer,
            releaseScope,
            fact: claimAcpTargetCheckpointFactObservation(checkpointNotice.capability),
          });
        }
      });
      active.add(tracked);
      return Object.freeze({ available: true as const, nativeBinding: tracked });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const checks = await Promise.allSettled([...readinessChecks]);
        const bindings = await settle(closeTrackedNativeBindings(
          active,
          "acp_codex_production_factory_cleanup_unconfirmed",
        ));
        if (checks.some((result) => result.status === "rejected")
          || bindings.status === "rejected") {
          throw safeError("acp_codex_production_factory_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
  PRODUCTION_TASK_FACTORY_RELEASE_ISSUERS.set(factory as object, releaseIssuer);
  return factory;
}

/**
 * Concrete Claude Code ACP counterpart. The target ACP Session receives the
 * revalidated Task workspace, while the child process and provider state stay
 * under the empty Host-private Task/Claude namespace.
 */

async function runProductionProviderModelCatalog(
  providerFamily: SessionIdAcpProductionProviderFamily,
  beforeQualificationEffect: AcpQualificationEffectBudget | undefined,
  input: SessionIdAcpProductionProviderModelCatalogInput,
): Promise<AcpProviderModelCatalogInspection> {
  if (input.signal.aborted) {
    return unavailableProviderModelCatalog("acp_provider_model_catalog_aborted");
  }
  const profile = providerModelCatalogProfile(providerFamily);
  let workingDirectory: string | undefined;
  let providerRoot: string | undefined;
  let openCodeRole: OpenCodeAcpScopedMcpRole | undefined;
  const composition = createAcpProviderComposition({
    processes: createAcpAgentProcessFactory(),
    ...(beforeQualificationEffect ? { beforeQualificationEffect } : {}),
  });
  try {
    const runtimePrivateRoot = claimAcpTaskPrivateRootAuthority({
      authority: input.privateRootAuthority,
      identityVaultResolver: input.identityVaultResolver,
    });
    let descriptor: AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3>;
    let createConnection: typeof createOfficialAcpV1StdioConnection;
    let beginCredentialAcquisition: ((scope: Readonly<{
      bindingHandle: string;
    }>) => AcpCredentialAcquisitionOperation) | undefined;
    if (providerFamily === "opencode") {
      if (!isOpenCodeHostInputs(input.hostInputs)) {
        throw safeError("acp_opencode_production_catalog_scope_mismatch");
      }
      const hostInputs = input.hostInputs;
      const directories = await prepareOpenCodePrivateDirectories(runtimePrivateRoot);
      providerRoot = directories.providerRoot;
      workingDirectory = await createHostPrivateTemporaryDirectory(
        providerRoot,
        "model-catalog",
      );
      openCodeRole = createOpenCodeAcpScopedMcpRole({ role: "worker" });
      descriptor = createOpenCodeAcpCurrentInstallDescriptor({
        commandReference: hostInputs.commandReference,
        executableSearchPath: hostInputs.executableSearchPath,
        inspectionEnvironment: directories.inspection,
        executionPolicy: openCodeRole.executionPolicy,
      });
      createConnection = createOfficialAcpV1StdioConnection;
      beginCredentialAcquisition = () => beginOpenCodeAcpCredentialAcquisition({
        privateRootParent: providerRoot!,
        sourceAuthFile: hostInputs.authFile,
      });
    } else if (providerFamily === "codex") {
      if (!isCodexHostInputs(input.hostInputs)) {
        throw safeError("acp_codex_production_catalog_scope_mismatch");
      }
      const hostInputs = input.hostInputs;
      const directories = await prepareCodexProfilePrivateDirectories(runtimePrivateRoot);
      providerRoot = directories.providerRoot;
      workingDirectory = await createHostPrivateTemporaryDirectory(
        providerRoot,
        "model-catalog",
      );
      descriptor = createCodexAcpCurrentInstallDescriptor({
        wrapperCommandReference: hostInputs.wrapperCommandReference,
        codexCommandReference: hostInputs.codexCommandReference,
        nodeCommandReference: hostInputs.nodeCommandReference,
        executableSearchPath: hostInputs.executableSearchPath,
      });
      createConnection = createOfficialAcpV1StdioConnection;
      beginCredentialAcquisition = () => beginCodexAcpCredentialAcquisition({
        runtimePrivateRoot: providerRoot!,
        authSourcePath: hostInputs.authFile,
      });
    } else {
      if (!isClaudeCodeHostInputs(input.hostInputs)) {
        throw safeError("acp_claude_code_production_catalog_scope_mismatch");
      }
      const hostInputs = input.hostInputs;
      const directories = await prepareClaudeCodePrivateDirectories(runtimePrivateRoot);
      providerRoot = directories.providerRoot;
      workingDirectory = await createHostPrivateTemporaryDirectory(
        providerRoot,
        "model-catalog",
      );
      descriptor = createClaudeCodeAcpCurrentInstallDescriptor({
        wrapperCommandReference: hostInputs.wrapperCommandReference,
        claudeCommandReference: hostInputs.claudeCommandReference,
        nodeCommandReference: hostInputs.nodeCommandReference,
        executableSearchPath: hostInputs.executableSearchPath,
        settingsSourcePath: hostInputs.settingsFile,
      });
      createConnection = createClaudeCodeAcpV1StdioConnection({ nativeTools: "disabled" });
      beginCredentialAcquisition = () => beginClaudeCodeAcpCredentialAcquisition({
        privateRootParent: providerRoot!,
        sourceSettingsFile: hostInputs.settingsFile,
      });
    }
    return await composition.inspectModelCatalog({
      profile,
      descriptor,
      role: "worker",
      requiredAcpCapabilities: ["session_new", "session_close"],
      workspaceDirectory: workingDirectory,
      createConnection,
      beginCredentialAcquisition,
    });
  } catch (error) {
    if (isCleanupUnconfirmed(error)) throw error;
    return unavailableProviderModelCatalog(
      failureCode(error, "acp_provider_model_catalog_unavailable"),
    );
  } finally {
    const cleanup = await Promise.allSettled([
      composition.close(),
      ...(openCodeRole ? [openCodeRole.close()] : []),
      ...(workingDirectory ? [removeExactPrivateDirectory(workingDirectory)] : []),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      throw safeError("acp_provider_model_catalog_cleanup_unconfirmed");
    }
  }
}

function normalizeProviderModelCatalogInput(
  input: SessionIdAcpProductionProviderModelCatalogInput,
  providerFamily: SessionIdAcpProductionProviderFamily,
): SessionIdAcpProductionProviderModelCatalogInput {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !sameKeys(input as unknown as Record<string, unknown>, [
      "hostInputs",
      "identityVaultResolver",
      "privateRootAuthority",
      "signal",
    ])
    || typeof input.identityVaultResolver !== "function"
    || !input.privateRootAuthority
    || !input.signal || typeof input.signal.aborted !== "boolean"
    || (providerFamily === "opencode" && !isOpenCodeHostInputs(input.hostInputs))
    || (providerFamily === "codex" && !isCodexHostInputs(input.hostInputs))
    || (providerFamily === "claude-code" && !isClaudeCodeHostInputs(input.hostInputs))) {
    throw safeError("acp_provider_model_catalog_input_invalid");
  }
  return input;
}

function providerModelCatalogProfile(
  providerFamily: SessionIdAcpProductionProviderFamily,
): ExecutionProfileDefinitionV3 {
  const suffix = providerFamily.replaceAll("-", "_");
  return Object.freeze({
    executionProfileId: `execution_profile_provider_settings_${suffix}` as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: `profile_revision_provider_settings_${suffix}` as ExecutionProfileDefinitionV3["profileRevisionId"],
    providerFamily,
    acpAgentKind: providerFamily === "opencode"
      ? "native_acp" as const
      : providerFamily === "codex"
        ? "codex_acp" as const
        : "claude_agent_acp" as const,
    protocolMajor: 1,
    model: "settings_catalog_observation_only",
    configIntent: Object.freeze({}),
    requiredExtensions: Object.freeze([]),
    capabilityPolicy: Object.freeze({
      requiredCapabilities: MANAGED_CAPABILITIES as ExecutionProfileDefinitionV3["capabilityPolicy"]["requiredCapabilities"],
      allowedTools: Object.freeze([]),
      permissionMode: "ask" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    }),
  });
}

function unavailableProviderModelCatalog(reason: string): AcpProviderModelCatalogInspection {
  return Object.freeze({
    available: false,
    modelCatalog: Object.freeze([]),
    unavailableReasons: Object.freeze([failureCode({ code: reason }, "acp_provider_model_catalog_unavailable")]),
  });
}

async function runOpenCodeProductionReadiness(
  options: SessionIdAcpProductionOpenCodeFactoryOptions,
  createAdapter: (options: OpenCodeAdapterOptions) => OpenCodeAcpTaskProfileAdapter,
  input: SessionIdAcpProductionTaskReadinessInput,
): Promise<AcpProviderAvailabilityReport> {
  if (input.signal.aborted) {
    return unavailableAvailabilityReport(input.profile, input.role, "acp_task_readiness_aborted");
  }
  let readinessDirectory: string | undefined;
  let scopedMcpRoles: Readonly<{
    readonly target: OpenCodeAcpScopedMcpRole;
    readonly readiness: OpenCodeAcpScopedMcpRole;
  }> | undefined;
  let adapter: OpenCodeAcpTaskProfileAdapter | undefined;
  let runtime: OpenCodeAcpTaskBindingRuntime | undefined;
  let bindingHandle: string | undefined;
  let currentResolution: SessionIdAcpCurrentResolutionScope | undefined;
  let readinessResolution: SessionIdAcpCurrentResolutionScope | undefined;
  let report: AcpProviderAvailabilityReport;
  try {
    const hostInputs = input.hostInputs as AcpProductionOpenCodeHostInputs;
    const sessionConfiguration = compileTaskSessionConfiguration(input.profile);
    const runtimePrivateRoot = claimAcpTaskPrivateRootAuthority({
      authority: input.privateRootAuthority,
      identityVaultResolver: input.identityVaultResolver,
    });
    const privateDirectories = await prepareOpenCodePrivateDirectories(runtimePrivateRoot);
    readinessDirectory = await createHostPrivateTemporaryDirectory(
      privateDirectories.providerRoot,
      "profile-readiness",
    );
    scopedMcpRoles = Object.freeze({
      target: createOpenCodeAcpScopedMcpRole({ role: input.role }),
      readiness: createOpenCodeAcpScopedMcpRole({ role: input.role }),
    });
    const descriptor = createOpenCodeAcpCurrentInstallDescriptor({
      commandReference: hostInputs.commandReference,
      executableSearchPath: hostInputs.executableSearchPath,
      inspectionEnvironment: privateDirectories.inspection,
      executionPolicy: scopedMcpRoles.target.executionPolicy,
    });
    const readinessDescriptor = createOpenCodeAcpCurrentInstallDescriptor({
      commandReference: hostInputs.commandReference,
      executableSearchPath: hostInputs.executableSearchPath,
      inspectionEnvironment: privateDirectories.inspection,
      executionPolicy: scopedMcpRoles.readiness.executionPolicy,
    });
    [currentResolution, readinessResolution] = await Promise.all([
      resolveCurrentResolutionScope(input.profile, descriptor, options.controlledResolveCurrent),
      resolveCurrentResolutionScope(input.profile, readinessDescriptor, options.controlledResolveCurrent),
    ]);
    bindingHandle = `binding_handle_task_readiness_${randomUUID().replaceAll("-", "")}`;
    assertReadinessBindingAbsent(
      input.identityVaultResolver,
      input.profile,
      currentResolution,
      bindingHandle,
    );
    adapter = createAdapter({
      profile: input.profile,
      role: input.role,
      workspaceDirectory: readinessDirectory,
      bindingDisposition: "create",
      scopedMcpRoles,
      currentInstall: {
        commandReference: hostInputs.commandReference,
        executableSearchPath: hostInputs.executableSearchPath,
        inspectionEnvironment: privateDirectories.inspection,
      },
      credentialAcquisition: {
        privateRootParent: privateDirectories.providerRoot,
        sourceAuthFile: hostInputs.authFile,
      },
      sessionConfiguration,
      identityVaultResolver: createResolutionSetFencedIdentityVaultResolver(
        input.identityVaultResolver,
        [currentResolution, readinessResolution],
      ),
      ...(options.beforeQualificationEffect
        ? { beforeQualificationEffect: options.beforeQualificationEffect }
        : {}),
      createQualificationAttemptId: () => (
        `session_execution_attempt_opencode_readiness_${randomUUID().replaceAll("-", "")}`
      ),
    });
    const opened = await adapter.openBinding({ bindingHandle });
    report = opened.report;
    if (opened.available) runtime = opened.runtime;
  } catch (error) {
    if (isCleanupUnconfirmed(error)) throw error;
    report = unavailableAvailabilityReport(
      input.profile,
      input.role,
      failureCode(error, "acp_opencode_task_readiness_unavailable"),
    );
  } finally {
    const cleanup: PromiseSettledResult<unknown>[] = [];
    if (runtime) cleanup.push(await settle(runtime.releaseBinding()));
    if (adapter) {
      cleanup.push(await settle(adapter.close()));
    } else if (scopedMcpRoles) {
      cleanup.push(await settle(closeOpenCodeScopedRoles(scopedMcpRoles)));
    }
    if (readinessDirectory) cleanup.push(await settle(removeExactPrivateDirectory(readinessDirectory)));
    if (bindingHandle && currentResolution) {
      try {
        assertReadinessBindingAbsent(
          input.identityVaultResolver,
          input.profile,
          currentResolution,
          bindingHandle,
        );
      } catch (error) {
        cleanup.push({ status: "rejected", reason: error });
      }
    }
    if (cleanup.some((result) => result.status === "rejected")) {
      throw safeError("acp_opencode_task_readiness_cleanup_unconfirmed");
    }
  }
  return report!;
}

async function runClaudeCodeProductionReadiness(
  options: SessionIdAcpProductionClaudeCodeFactoryOptions,
  createAdapter: (options: ClaudeCodeAdapterOptions) => ClaudeCodeAcpTaskProfileAdapter,
  input: SessionIdAcpProductionTaskReadinessInput,
): Promise<AcpProviderAvailabilityReport> {
  if (input.signal.aborted) {
    return unavailableAvailabilityReport(input.profile, input.role, "acp_task_readiness_aborted");
  }
  let readinessDirectory: string | undefined;
  let scopedMcpRoles: Readonly<{
    readonly target: ClaudeCodeAcpScopedMcpRole;
    readonly readiness: ClaudeCodeAcpScopedMcpRole;
  }> | undefined;
  let adapter: ClaudeCodeAcpTaskProfileAdapter | undefined;
  let runtime: ClaudeCodeAcpTaskBindingRuntime | undefined;
  let bindingHandle: string | undefined;
  let currentResolution: SessionIdAcpCurrentResolutionScope | undefined;
  let readinessResolution: SessionIdAcpCurrentResolutionScope | undefined;
  let report: AcpProviderAvailabilityReport;
  try {
    const hostInputs = input.hostInputs as AcpProductionClaudeCodeHostInputs;
    const sessionConfiguration = compileTaskSessionConfiguration(input.profile);
    const runtimePrivateRoot = claimAcpTaskPrivateRootAuthority({
      authority: input.privateRootAuthority,
      identityVaultResolver: input.identityVaultResolver,
    });
    const privateDirectories = await prepareClaudeCodePrivateDirectories(runtimePrivateRoot);
    readinessDirectory = await createHostPrivateTemporaryDirectory(
      privateDirectories.providerRoot,
      "profile-readiness",
    );
    scopedMcpRoles = Object.freeze({
      target: createClaudeCodeAcpScopedMcpRole({ role: input.role }),
      readiness: createClaudeCodeAcpScopedMcpRole({ role: input.role }),
    });
    const descriptor = createClaudeCodeAcpCurrentInstallDescriptor({
      wrapperCommandReference: hostInputs.wrapperCommandReference,
      claudeCommandReference: hostInputs.claudeCommandReference,
      nodeCommandReference: hostInputs.nodeCommandReference,
      executableSearchPath: hostInputs.executableSearchPath,
      settingsSourcePath: hostInputs.settingsFile,
    });
    const readinessDescriptor = createClaudeCodeAcpCurrentInstallDescriptor({
      wrapperCommandReference: hostInputs.wrapperCommandReference,
      claudeCommandReference: hostInputs.claudeCommandReference,
      nodeCommandReference: hostInputs.nodeCommandReference,
      executableSearchPath: hostInputs.executableSearchPath,
      settingsSourcePath: hostInputs.settingsFile,
    });
    [currentResolution, readinessResolution] = await Promise.all([
      resolveCurrentResolutionScope(input.profile, descriptor, options.controlledResolveCurrent),
      resolveCurrentResolutionScope(input.profile, readinessDescriptor, options.controlledResolveCurrent),
    ]);
    bindingHandle = `binding_handle_task_readiness_${randomUUID().replaceAll("-", "")}`;
    assertReadinessBindingAbsent(
      input.identityVaultResolver,
      input.profile,
      currentResolution,
      bindingHandle,
    );
    adapter = createAdapter({
      profile: input.profile,
      role: input.role,
      workspaceDirectory: readinessDirectory,
      bindingDisposition: "create",
      scopedMcpRoles,
      currentInstall: {
        wrapperCommandReference: hostInputs.wrapperCommandReference,
        claudeCommandReference: hostInputs.claudeCommandReference,
        nodeCommandReference: hostInputs.nodeCommandReference,
        executableSearchPath: hostInputs.executableSearchPath,
        settingsSourcePath: hostInputs.settingsFile,
      },
      credentialAcquisition: {
        privateRootParent: privateDirectories.providerRoot,
        sourceSettingsFile: hostInputs.settingsFile,
      },
      sessionConfiguration,
      identityVaultResolver: createResolutionSetFencedIdentityVaultResolver(
        input.identityVaultResolver,
        [currentResolution, readinessResolution],
      ),
      ...(options.beforeQualificationEffect
        ? { beforeQualificationEffect: options.beforeQualificationEffect }
        : {}),
      createQualificationAttemptId: () => (
        `session_execution_attempt_claude_code_readiness_${randomUUID().replaceAll("-", "")}`
      ),
    });
    const opened = await adapter.openBinding({ bindingHandle });
    report = opened.report;
    if (opened.available) runtime = opened.runtime;
  } catch (error) {
    if (isCleanupUnconfirmed(error)) throw error;
    report = unavailableAvailabilityReport(
      input.profile,
      input.role,
      failureCode(error, "acp_claude_code_task_readiness_unavailable"),
    );
  } finally {
    const cleanup: PromiseSettledResult<unknown>[] = [];
    if (runtime) cleanup.push(await settle(runtime.releaseBinding()));
    if (adapter) {
      cleanup.push(await settle(adapter.close()));
    } else if (scopedMcpRoles) {
      cleanup.push(await settle(closeClaudeCodeScopedRoles(scopedMcpRoles)));
    }
    if (readinessDirectory) cleanup.push(await settle(removeExactPrivateDirectory(readinessDirectory)));
    if (bindingHandle && currentResolution) {
      try {
        assertReadinessBindingAbsent(
          input.identityVaultResolver,
          input.profile,
          currentResolution,
          bindingHandle,
        );
      } catch (error) {
        cleanup.push({ status: "rejected", reason: error });
      }
    }
    if (cleanup.some((result) => result.status === "rejected")) {
      throw safeError("acp_claude_code_task_readiness_cleanup_unconfirmed");
    }
  }
  return report!;
}

async function runCodexProductionReadiness(
  options: SessionIdAcpProductionCodexFactoryOptions,
  createAdapter: (options: CodexAdapterOptions) => CodexAcpTaskProfileAdapter,
  input: SessionIdAcpProductionTaskReadinessInput,
): Promise<AcpProviderAvailabilityReport> {
  if (input.signal.aborted) {
    return unavailableAvailabilityReport(input.profile, input.role, "acp_task_readiness_aborted");
  }
  let readinessDirectory: string | undefined;
  let scopedMcpRoles: Readonly<{
    readonly target: CodexAcpScopedMcpRole;
    readonly readiness: CodexAcpScopedMcpRole;
  }> | undefined;
  let adapter: CodexAcpTaskProfileAdapter | undefined;
  let runtime: CodexAcpTaskBindingRuntime | undefined;
  let bindingHandle: string | undefined;
  let currentResolution: SessionIdAcpCurrentResolutionScope | undefined;
  let readinessResolution: SessionIdAcpCurrentResolutionScope | undefined;
  let report: AcpProviderAvailabilityReport;
  try {
    const hostInputs = input.hostInputs as AcpProductionCodexHostInputs;
    const sessionConfiguration = compileTaskSessionConfiguration(input.profile);
    const runtimePrivateRoot = claimAcpTaskPrivateRootAuthority({
      authority: input.privateRootAuthority,
      identityVaultResolver: input.identityVaultResolver,
    });
    const privateDirectories = await prepareCodexProfilePrivateDirectories(runtimePrivateRoot);
    readinessDirectory = await createHostPrivateTemporaryDirectory(
      privateDirectories.providerRoot,
      "profile-readiness",
    );
    scopedMcpRoles = Object.freeze({
      target: createCodexAcpScopedMcpRole({ role: input.role }),
      readiness: createCodexAcpScopedMcpRole({ role: input.role }),
    });
    const descriptor = createCodexAcpCurrentInstallDescriptor({
      wrapperCommandReference: hostInputs.wrapperCommandReference,
      codexCommandReference: hostInputs.codexCommandReference,
      nodeCommandReference: hostInputs.nodeCommandReference,
      executableSearchPath: hostInputs.executableSearchPath,
    });
    const readinessDescriptor = createCodexAcpCurrentInstallDescriptor({
      wrapperCommandReference: hostInputs.wrapperCommandReference,
      codexCommandReference: hostInputs.codexCommandReference,
      nodeCommandReference: hostInputs.nodeCommandReference,
      executableSearchPath: hostInputs.executableSearchPath,
    });
    [currentResolution, readinessResolution] = await Promise.all([
      resolveCurrentResolutionScope(input.profile, descriptor, options.controlled?.resolveCurrent),
      resolveCurrentResolutionScope(input.profile, readinessDescriptor, options.controlled?.resolveCurrent),
    ]);
    bindingHandle = `binding_handle_task_readiness_${randomUUID().replaceAll("-", "")}`;
    assertReadinessBindingAbsent(
      input.identityVaultResolver,
      input.profile,
      currentResolution,
      bindingHandle,
    );
    const readinessProbe = await options.createReadinessProbe(Object.freeze({
      profile: input.profile,
      role: input.role,
    }));
    adapter = createAdapter({
      profile: input.profile,
      role: input.role,
      workspaceDirectory: readinessDirectory,
      bindingDisposition: "create",
      scopedMcpRoles,
      currentInstall: {
        wrapperCommandReference: hostInputs.wrapperCommandReference,
        codexCommandReference: hostInputs.codexCommandReference,
        nodeCommandReference: hostInputs.nodeCommandReference,
        executableSearchPath: hostInputs.executableSearchPath,
      },
      credentialAcquisition: {
        runtimePrivateRoot: privateDirectories.providerRoot,
        authSourcePath: hostInputs.authFile,
      },
      sessionConfiguration,
      identityVaultResolver: createResolutionSetFencedIdentityVaultResolver(
        input.identityVaultResolver,
        [currentResolution, readinessResolution],
      ),
      ...(options.beforeQualificationEffect
        ? { beforeQualificationEffect: options.beforeQualificationEffect }
        : {}),
      createQualificationProbe: () => codexTaskQualificationProbe(readinessProbe),
    });
    const opened = await adapter.openBinding({ bindingHandle });
    report = opened.report;
    if (opened.available) runtime = opened.runtime;
  } catch (error) {
    if (isCleanupUnconfirmed(error)) throw error;
    report = unavailableAvailabilityReport(
      input.profile,
      input.role,
      failureCode(error, "acp_codex_task_readiness_unavailable"),
    );
  } finally {
    const cleanup: PromiseSettledResult<unknown>[] = [];
    if (runtime) cleanup.push(await settle(runtime.releaseBinding()));
    if (adapter) {
      cleanup.push(await settle(adapter.close()));
    } else if (scopedMcpRoles) {
      cleanup.push(await settle(closeCodexScopedRoles(scopedMcpRoles)));
    }
    if (readinessDirectory) cleanup.push(await settle(removeExactPrivateDirectory(readinessDirectory)));
    if (bindingHandle && currentResolution) {
      try {
        assertReadinessBindingAbsent(
          input.identityVaultResolver,
          input.profile,
          currentResolution,
          bindingHandle,
        );
      } catch (error) {
        cleanup.push({ status: "rejected", reason: error });
      }
    }
    if (cleanup.some((result) => result.status === "rejected")) {
      throw safeError("acp_codex_task_readiness_cleanup_unconfirmed");
    }
  }
  return report!;
}

function codexTaskQualificationProbe(
  input: CodexAcpNativeAttemptInput,
): AcpTaskQualificationProbe {
  return Object.freeze({
    attemptId: input.attemptId,
    content: input.content,
    interactionRevision: input.interactionRevision,
    ...(input.turnContext ? { turnContext: input.turnContext } : {}),
    ...(input.qualificationExpectedFinalCandidate === undefined
      ? {}
      : { expectedFinalCandidate: input.qualificationExpectedFinalCandidate }),
    ...(input.additionalSteps === undefined
      ? {}
      : { additionalSteps: input.additionalSteps }),
  });
}

type OpenCodeProductionPrivateDirectories = Readonly<{
  readonly providerRoot: string;
  readonly inspection: Readonly<{
    readonly homeDirectory: string;
    readonly configHome: string;
    readonly dataHome: string;
    readonly cacheHome: string;
    readonly stateHome: string;
    readonly temporaryDirectory: string;
  }>;
}>;

type ClaudeCodeProductionPrivateDirectories = Readonly<{
  readonly providerRoot: string;
}>;

type CodexProductionPrivateDirectories = Readonly<{
  readonly providerRoot: string;
}>;

function normalizeTaskReadinessInput(
  input: SessionIdAcpProductionTaskReadinessInput,
  family: SessionIdAcpProductionProviderFamily,
): SessionIdAcpProductionTaskReadinessInput {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !sameKeys(input as unknown as Record<string, unknown>, [
      "profile",
      "role",
      "hostInputs",
      "privateRootAuthority",
      "identityVaultResolver",
      "signal",
    ])) {
    throw safeError("acp_task_readiness_input_invalid");
  }
  const normalized = normalizeProfileAndRole(input.profile, input.role);
  if (normalized.profile.providerFamily !== family
    || (family === "opencode" && !isOpenCodeHostInputs(input.hostInputs))
    || (family === "codex" && !isCodexHostInputs(input.hostInputs))
    || (family === "claude-code" && !isClaudeCodeHostInputs(input.hostInputs))
    || !input.privateRootAuthority
    || typeof input.identityVaultResolver !== "function"
    || !input.signal || typeof input.signal.aborted !== "boolean") {
    throw safeError("acp_task_readiness_input_invalid");
  }
  return Object.freeze({
    profile: normalized.profile,
    role: normalized.role,
    hostInputs: input.hostInputs,
    privateRootAuthority: input.privateRootAuthority,
    identityVaultResolver: input.identityVaultResolver,
    signal: input.signal,
  });
}

function unavailableAvailabilityReport(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
  code: string,
): AcpProviderAvailabilityReport {
  return Object.freeze({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role,
    available: false,
    protocolMajor: null,
    capabilities: Object.freeze([]),
    extensions: Object.freeze([]),
    unavailableReasons: Object.freeze([
      requiredSafeCode(code, "acp_task_readiness_unavailable_code_invalid"),
    ]),
    qualificationClass: "structural",
    evidenceClass: "injected_host_qualification",
  });
}

function createExactResolutionFencedIdentityVaultResolver(
  resolver: AcpPrivateBindingVaultResolver,
  currentResolution: SessionIdAcpCurrentResolutionScope,
): AcpPrivateBindingVaultResolver {
  return createResolutionSetFencedIdentityVaultResolver(resolver, [currentResolution]);
}

function createResolutionSetFencedIdentityVaultResolver(
  resolver: AcpPrivateBindingVaultResolver,
  currentResolutions: readonly SessionIdAcpCurrentResolutionScope[],
): AcpPrivateBindingVaultResolver {
  if (currentResolutions.length === 0) {
    throw safeError("acp_task_current_resolution_vault_scope_mismatch");
  }
  const allowedScopes = new Set(currentResolutions.map((currentResolution) => (
    `${currentResolution.profileRevisionId}\0${currentResolution.profileResolutionFingerprint}`
  )));
  const resolve = ((scope: Readonly<{
    profileRevisionId: string;
    profileResolutionFingerprint: string;
  }>) => {
    if (!scope || !allowedScopes.has(
      `${scope.profileRevisionId}\0${scope.profileResolutionFingerprint}`,
    )) {
      throw safeError("acp_task_current_resolution_vault_scope_mismatch");
    }
    return resolver(scope);
  }) as AcpPrivateBindingVaultResolver;
  Object.defineProperty(resolve, "observeBindingPresence", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: resolver.observeBindingPresence.bind(resolver),
  });
  return Object.freeze(resolve);
}

function assertReadinessBindingAbsent(
  resolver: AcpPrivateBindingVaultResolver,
  profile: ExecutionProfileDefinitionV3,
  currentResolution: SessionIdAcpCurrentResolutionScope,
  bindingHandle: string,
): void {
  const authority = resolver.observeBindingPresence({
    bindingHandle,
    profileRevisionId: profile.profileRevisionId,
    profileResolutionFingerprint: currentResolution.profileResolutionFingerprint,
    providerFamily: profile.providerFamily,
  });
  if (claimAcpPrivateBindingPresenceAuthority({
    authority,
    resolver,
    bindingHandle,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
  }) !== "absent") {
    throw safeError("acp_task_readiness_binding_cleanup_unconfirmed");
  }
}

function validateFactoryInput(
  input: SessionIdAcpProductionTaskNativeFactoryOpenInput,
  family: SessionIdAcpProductionProviderFamily,
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw safeError("acp_task_native_factory_input_invalid");
  }
  const binding = validateAcpSafeSessionBindingRecordV3(input.binding);
  const frozenProfile = normalizeFrozenProfile(input.frozenProfile);
  const normalized = normalizeProfileAndRole(input.profile, input.role);
  normalizeHostScope(input.hostScope, normalized.profile);
  assertExecutionFence(binding, frozenProfile, normalized.profile);
  if (normalized.profile.providerFamily !== family
    || typeof input.identityVaultResolver !== "function"
    || !input.signal || typeof input.signal.aborted !== "boolean"
    || typeof input.onObservation !== "function"
    || (input.onDiagnostic !== undefined && typeof input.onDiagnostic !== "function")
    || (input.resolveTurnContext !== undefined
      && typeof input.resolveTurnContext !== "function")) {
    throw safeError("acp_task_native_factory_input_invalid");
  }
}

function productionFactoryContext(
  input: SessionIdAcpProductionTaskNativeFactoryOpenInput,
  hostScope: SessionIdAcpTaskHostExecutionScope,
  bindingDisposition: SessionIdAcpTaskBindingDisposition,
): SessionIdAcpProductionTaskFactoryContext {
  return Object.freeze({
    binding: input.binding,
    frozenProfile: input.frozenProfile,
    profile: input.profile,
    role: input.role,
    bindingDisposition,
    hostScope,
  });
}

type ResolvedConcreteHostScope = Readonly<{
  readonly hostScope: SessionIdAcpTaskHostExecutionScope;
  readonly runtimePrivateRoot: string;
}>;

async function resolveConcreteHostScope(
  value: SessionIdAcpTaskHostExecutionScope,
  profile: ExecutionProfileDefinitionV3,
  identityVaultResolver: AcpPrivateBindingVaultResolver,
): Promise<ResolvedConcreteHostScope> {
  const normalized = normalizeHostScope(value, profile);
  const [authorizedWorkspaceDirectory, runtimePrivateRoot] = await Promise.all([
    canonicalAuthorizedWorkspace(normalized.authorizedWorkspaceDirectory),
    Promise.resolve(claimAcpTaskPrivateRootAuthority({
      authority: normalized.privateRootAuthority,
      identityVaultResolver,
    })),
  ]);
  if (pathsOverlap(authorizedWorkspaceDirectory, runtimePrivateRoot)) {
    throw safeError("acp_task_workspace_private_root_overlap");
  }
  return Object.freeze({
    hostScope: Object.freeze({
      authorizedWorkspaceDirectory,
      privateRootAuthority: normalized.privateRootAuthority,
    }),
    runtimePrivateRoot,
  });
}

async function resolveCurrentResolutionScope(
  profile: ExecutionProfileDefinitionV3,
  descriptor: AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3>,
  controlled?: ControlledResolveCurrent,
): Promise<SessionIdAcpCurrentResolutionScope> {
  const resolved = controlled
    ? await controlled(Object.freeze({ profile, descriptor }))
    : await createAcpProfileResolutionRegistry().resolve(profile, descriptor).then((resolution) => (
        Object.freeze({
          profileRevisionId: resolution.profileRevisionId,
          providerFamily: resolution.providerFamily,
          profileResolutionFingerprint: resolution.hostPrivateLaunchMaterial().sealFingerprint,
        })
      ));
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)
    || !sameKeys(resolved as unknown as Record<string, unknown>, [
      "profileRevisionId",
      "providerFamily",
      "profileResolutionFingerprint",
    ])
    || resolved.profileRevisionId !== profile.profileRevisionId
    || resolved.providerFamily !== profile.providerFamily
    || typeof resolved.profileResolutionFingerprint !== "string"
    || !SHA256.test(resolved.profileResolutionFingerprint)) {
    throw safeError("acp_task_current_resolution_scope_invalid");
  }
  return Object.freeze({ ...resolved });
}

function resolveCurrentBindingDisposition(
  binding: AcpSafeSessionBindingRecordV3,
  identityVaultResolver: AcpPrivateBindingVaultResolver,
  currentResolution: SessionIdAcpCurrentResolutionScope,
): Readonly<{
  readonly bindingDisposition: SessionIdAcpTaskBindingDisposition;
  readonly identityVaultResolver: AcpPrivateBindingVaultResolver;
}> {
  if (binding.profileRevisionId !== currentResolution.profileRevisionId
    || binding.providerFamily !== currentResolution.providerFamily) {
    throw safeError("acp_task_current_resolution_binding_mismatch");
  }
  const presenceAuthority = identityVaultResolver.observeBindingPresence({
    bindingHandle: binding.bindingHandle,
    profileRevisionId: binding.profileRevisionId,
    profileResolutionFingerprint: currentResolution.profileResolutionFingerprint,
    providerFamily: binding.providerFamily,
  });
  const dispositionAuthority = createSessionIdAcpTaskBindingDispositionAuthority({
    identityVaultResolver,
    binding,
    presenceAuthority,
    profileResolutionFingerprint: currentResolution.profileResolutionFingerprint,
  });
  const state = claimTaskBindingDispositionAuthority(
    dispositionAuthority,
    binding,
    identityVaultResolver,
  );
  return Object.freeze({
    bindingDisposition: state.disposition,
    identityVaultResolver: createPresenceFencedIdentityVaultResolver(
      state,
      identityVaultResolver,
    ),
  });
}

async function closeOpenCodeScopedRoles(scopes: Readonly<{
  readonly target: OpenCodeAcpScopedMcpRole;
  readonly readiness: OpenCodeAcpScopedMcpRole;
}>): Promise<void> {
  const results = await Promise.allSettled([
    scopes.target.close(),
    scopes.readiness.close(),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
  }
}

async function closeClaudeCodeScopedRoles(scopes: Readonly<{
  readonly target: ClaudeCodeAcpScopedMcpRole;
  readonly readiness: ClaudeCodeAcpScopedMcpRole;
}>): Promise<void> {
  const results = await Promise.allSettled([
    scopes.target.close(),
    scopes.readiness.close(),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    throw safeError("acp_claude_code_qualified_binding_cleanup_unconfirmed");
  }
}

async function closeCodexScopedRoles(scopes: Readonly<{
  readonly target: CodexAcpScopedMcpRole;
  readonly readiness: CodexAcpScopedMcpRole;
}>): Promise<void> {
  const results = await Promise.allSettled([
    scopes.target.close(),
    scopes.readiness.close(),
  ]);
  if (results.some((result) => result.status === "rejected")) {
    throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
  }
}

function claimTaskBindingDispositionAuthority(
  authority: SessionIdAcpTaskBindingDispositionAuthority,
  binding: AcpSafeSessionBindingRecordV3,
  identityVaultResolver: AcpPrivateBindingVaultResolver,
): TaskBindingDispositionAuthorityState {
  if (!authority || typeof authority !== "object") {
    throw safeError("acp_task_binding_disposition_authority_invalid");
  }
  const state = taskBindingDispositionAuthorities.get(authority as object);
  if (!state || state.identityVaultResolver !== identityVaultResolver
    || state.bindingId !== binding.bindingId
    || state.bindingRevision !== binding.revision
    || state.bindingHandle !== binding.bindingHandle
    || state.logicalSessionId !== binding.logicalSessionId
    || state.executionProfileId !== binding.executionProfileId
    || state.profileRevisionId !== binding.profileRevisionId
    || state.providerFamily !== binding.providerFamily
    || state.status !== binding.status
    || binding.recoverable !== true) {
    throw safeError("acp_task_binding_disposition_authority_mismatch");
  }
  return state;
}

function createPresenceFencedIdentityVaultResolver(
  state: TaskBindingDispositionAuthorityState,
  resolver: AcpPrivateBindingVaultResolver,
): AcpPrivateBindingVaultResolver {
  const resolve = ((scope: Readonly<{
    profileRevisionId: string;
    profileResolutionFingerprint: string;
  }>) => {
    assertAcpPrivateBindingPresenceAuthorityScope({
      authority: state.presenceAuthority,
      resolver,
      bindingHandle: state.bindingHandle,
      profileRevisionId: scope?.profileRevisionId,
      profileResolutionFingerprint: scope?.profileResolutionFingerprint,
      providerFamily: state.providerFamily,
    });
    return resolver(scope);
  }) as AcpPrivateBindingVaultResolver;
  Object.defineProperty(resolve, "observeBindingPresence", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: resolver.observeBindingPresence.bind(resolver),
  });
  return Object.freeze(resolve);
}

async function assertExistingHostPrivateDirectory(value: string): Promise<string> {
  const normalized = absoluteHostPath(value, "acp_task_private_root_authority_invalid");
  try {
    const [metadata, canonical] = await Promise.all([lstat(normalized), realpath(normalized)]);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== normalized
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
      || (currentUid !== undefined && metadata.uid !== currentUid)) {
      throw new Error("unsafe_private_authority_root");
    }
    return canonical;
  } catch {
    throw safeError("acp_task_private_root_authority_invalid");
  }
}

function isStrictContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return isContainedRelativePath(relative);
}

async function prepareOpenCodePrivateDirectories(
  runtimePrivateRoot: string,
): Promise<OpenCodeProductionPrivateDirectories> {
  const providerRoot = await ensureHostPrivateDirectory(
    path.join(runtimePrivateRoot, "task-acp-opencode"),
  );
  const inspectionRoot = await ensureHostPrivateDirectory(path.join(providerRoot, "inspection"));
  const [homeDirectory, configHome, dataHome, cacheHome, stateHome, temporaryDirectory] =
    await Promise.all([
      ensureHostPrivateDirectory(path.join(inspectionRoot, "home")),
      ensureHostPrivateDirectory(path.join(inspectionRoot, "config")),
      ensureHostPrivateDirectory(path.join(inspectionRoot, "data")),
      ensureHostPrivateDirectory(path.join(inspectionRoot, "cache")),
      ensureHostPrivateDirectory(path.join(inspectionRoot, "state")),
      ensureHostPrivateDirectory(path.join(inspectionRoot, "tmp")),
    ]);
  return Object.freeze({
    providerRoot,
    inspection: Object.freeze({
      homeDirectory,
      configHome,
      dataHome,
      cacheHome,
      stateHome,
      temporaryDirectory,
    }),
  });
}

async function prepareClaudeCodePrivateDirectories(
  runtimePrivateRoot: string,
): Promise<ClaudeCodeProductionPrivateDirectories> {
  const providerRoot = await ensureHostPrivateDirectory(
    path.join(runtimePrivateRoot, "task-acp-claude-code"),
  );
  return Object.freeze({ providerRoot });
}

async function prepareCodexProfilePrivateDirectories(
  runtimePrivateRoot: string,
): Promise<CodexProductionPrivateDirectories> {
  const providerRoot = await ensureHostPrivateDirectory(
    path.join(runtimePrivateRoot, "task-acp-codex"),
  );
  return Object.freeze({ providerRoot });
}

async function createHostPrivateTemporaryDirectory(
  parent: string,
  prefix: string,
): Promise<string> {
  const safePrefix = requiredSafeCode(`acp_${prefix.replaceAll("-", "_")}`, "acp_private_prefix_invalid")
    .slice(4);
  const directory = await mkdtemp(path.join(parent, `${safePrefix}-`));
  await chmod(directory, 0o700);
  return ensureHostPrivateDirectory(directory);
}

async function canonicalAuthorizedWorkspace(value: string): Promise<string> {
  const normalized = absoluteHostPath(value, "acp_task_workspace_authority_invalid");
  try {
    const [metadata, canonical] = await Promise.all([lstat(normalized), realpath(normalized)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== normalized) {
      throw new Error("unsafe_workspace");
    }
    return canonical;
  } catch {
    throw safeError("acp_task_workspace_authority_invalid");
  }
}

async function ensureHostPrivateDirectory(value: string): Promise<string> {
  const normalized = absoluteHostPath(value, "acp_task_private_root_invalid");
  try {
    await mkdir(normalized, { recursive: true, mode: 0o700 });
    const before = await lstat(normalized);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!before.isDirectory() || before.isSymbolicLink()
      || (currentUid !== undefined && before.uid !== currentUid)) {
      throw new Error("unsafe_private_directory");
    }
    await chmod(normalized, 0o700);
    const [metadata, canonical] = await Promise.all([lstat(normalized), realpath(normalized)]);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== normalized
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)) {
      throw new Error("unsafe_private_directory");
    }
    return canonical;
  } catch {
    throw safeError("acp_task_private_root_invalid");
  }
}

async function closeOpenCodeAdapter(adapter: OpenCodeAcpTaskProfileAdapter): Promise<boolean> {
  return (await settle(adapter.close())).status === "fulfilled";
}

async function closeCodexAdapter(adapter: CodexAcpTaskProfileAdapter): Promise<boolean> {
  return (await settle(adapter.close())).status === "fulfilled";
}

async function closeClaudeCodeAdapter(
  adapter: ClaudeCodeAcpTaskProfileAdapter,
): Promise<boolean> {
  return (await settle(adapter.close())).status === "fulfilled";
}

async function removeExactPrivateDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  try {
    await lstat(directory);
  } catch (error) {
    if (isMissingFile(error)) return;
  }
  throw safeError("acp_codex_binding_directory_cleanup_unconfirmed");
}

function ownOpenCodeProviderComposition(
  adapter: OpenCodeAcpTaskProfileAdapter,
  composition: AcpProviderComposition,
): OpenCodeAcpTaskProfileAdapter {
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    role: adapter.role,
    openBinding: adapter.openBinding,
    safeObservation: adapter.safeObservation,
    close() {
      closePromise ??= (async () => {
        const adapterClose = await settle(adapter.close());
        const providerClose = await settle(composition.close());
        if (adapterClose.status === "rejected" || providerClose.status === "rejected") {
          throw safeError("acp_opencode_qualified_binding_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
}

function ownCodexProviderComposition(
  adapter: CodexAcpTaskProfileAdapter,
  composition: AcpProviderComposition,
): CodexAcpTaskProfileAdapter {
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    role: adapter.role,
    openBinding: adapter.openBinding,
    safeObservation: adapter.safeObservation,
    close() {
      closePromise ??= (async () => {
        const adapterClose = await settle(adapter.close());
        const providerClose = await settle(composition.close());
        if (adapterClose.status === "rejected" || providerClose.status === "rejected") {
          throw safeError("acp_codex_qualified_binding_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
}

function unavailableFactory(code: string): SessionIdAcpProductionTaskNativeFactoryOpenResult {
  return Object.freeze({
    available: false as const,
    code: requiredSafeCode(code, "acp_task_native_factory_unavailable_code_invalid"),
  });
}

function availabilityUnavailableCode(
  report: AcpProviderAvailabilityReport | undefined,
  fallback: string,
): string {
  const safeReason = report?.unavailableReasons.find((reason) => SAFE_CODE.test(reason));
  return safeReason ?? fallback;
}

type TaskProfileReadinessOwner = Readonly<{
  inspectModelCatalog(
    providerFamily: SessionIdAcpProductionProviderFamily,
  ): Promise<AcpProviderModelCatalogInspection>;
  read(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
  ): AcpProfileReadinessObservation;
  check(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
    options: Readonly<{ readonly force: boolean }>,
  ): Promise<AcpProfileReadinessObservation>;
  forceBeforeOpen(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
    signal: AbortSignal,
  ): Promise<AcpProfileReadinessObservation>;
  close(): Promise<void>;
}>;

function createTaskProfileReadinessOwner(
  options: SessionIdAcpProductionCompositionOptions,
  factories: ReadonlyMap<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory>,
): TaskProfileReadinessOwner {
  const cache = new Map<string, Readonly<{
    readonly observation: AcpProfileReadinessObservation;
    readonly expiresAt: number;
  }>>();
  const inFlight = new Map<string, Promise<AcpProfileReadinessObservation>>();
  const catalogInFlight = new Map<
    SessionIdAcpProductionProviderFamily,
    Promise<AcpProviderModelCatalogInspection>
  >();
  let closed = false;
  let poisonedCode: string | undefined;
  let closePromise: Promise<void> | undefined;

  const owner: TaskProfileReadinessOwner = Object.freeze({
    inspectModelCatalog(providerFamily) {
      if (closed) throw safeError("acp_task_readiness_owner_closed");
      if (!SUPPORTED_PROVIDER_FAMILIES.includes(providerFamily)) {
        throw safeError("acp_provider_family_unsupported");
      }
      if (poisonedCode) return Promise.resolve(unavailableProviderModelCatalog(poisonedCode));
      const existing = catalogInFlight.get(providerFamily);
      if (existing) return existing;
      const factory = factories.get(providerFamily);
      const hostInputs = providerFamily === "opencode"
        ? options.hostInputs.openCode()
        : providerFamily === "codex"
          ? options.hostInputs.codex()
          : options.hostInputs.claudeCode();
      if (!factory || !hostInputs) {
        return Promise.resolve(unavailableProviderModelCatalog(
          "acp_task_provider_not_configured",
        ));
      }
      const pending = factory.readModelCatalog(Object.freeze({
        hostInputs,
        privateRootAuthority: options.privateAuthority.taskPrivateRootAuthority,
        identityVaultResolver: options.privateAuthority.taskIdentityVaults,
        signal: new AbortController().signal,
      })).catch((error) => {
        const code = failureCode(error, "acp_provider_model_catalog_failed");
        if (isCleanupUnconfirmed(error)) {
          poisonedCode = code;
          throw safeError(code);
        }
        return unavailableProviderModelCatalog(code);
      }).finally(() => { catalogInFlight.delete(providerFamily); });
      catalogInFlight.set(providerFamily, pending);
      return pending;
    },
    read(profile, role) {
      if (closed) throw safeError("acp_task_readiness_owner_closed");
      const normalized = normalizeProfileAndRole(profile, role);
      try {
        compileTaskSessionConfiguration(normalized.profile);
      } catch {
        return unavailableTaskReadiness(
          normalized.profile,
          normalized.role,
          "acp_task_config_intent_unsupported",
        );
      }
      const unavailable = readinessRegistrationUnavailable(
        options,
        factories,
        normalized.profile,
        normalized.role,
      );
      if (unavailable) return unavailableTaskReadiness(
        normalized.profile,
        normalized.role,
        unavailable,
      );
      if (poisonedCode) return unavailableTaskReadiness(
        normalized.profile,
        normalized.role,
        poisonedCode,
      );
      const cached = cache.get(taskProfileReadinessKey(normalized.profile, normalized.role));
      return cached && cached.expiresAt > Date.now()
        ? cached.observation
        : pendingTaskReadiness(normalized.profile, normalized.role);
    },
    async check(profile, role, checkOptions) {
      if (closed) throw safeError("acp_task_readiness_owner_closed");
      if (!checkOptions || typeof checkOptions !== "object" || Array.isArray(checkOptions)
        || !sameKeys(checkOptions as unknown as Record<string, unknown>, ["force"])
        || typeof checkOptions.force !== "boolean") {
        throw safeError("acp_task_readiness_check_options_invalid");
      }
      const normalized = normalizeProfileAndRole(profile, role);
      if (!checkOptions.force) return owner.read(normalized.profile, normalized.role);
      return forceProbe(normalized.profile, normalized.role, new AbortController().signal);
    },
    forceBeforeOpen(profile, role, signal) {
      if (closed) throw safeError("acp_task_readiness_owner_closed");
      const normalized = normalizeProfileAndRole(profile, role);
      if (!signal || typeof signal.aborted !== "boolean") {
        throw safeError("acp_task_readiness_abort_signal_invalid");
      }
      return forceProbe(normalized.profile, normalized.role, signal);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      cache.clear();
      closePromise = (async () => {
        const results = await Promise.allSettled([
          ...inFlight.values(),
          ...catalogInFlight.values(),
        ]);
        inFlight.clear();
        catalogInFlight.clear();
        if (results.some((result) => result.status === "rejected")) {
          throw safeError("acp_task_readiness_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
  return owner;

  function forceProbe(
    profile: ExecutionProfileDefinitionV3,
    role: SessionIdAcpTaskRole,
    signal: AbortSignal,
  ): Promise<AcpProfileReadinessObservation> {
    try {
      compileTaskSessionConfiguration(profile);
    } catch {
      return Promise.resolve(unavailableTaskReadiness(
        profile,
        role,
        "acp_task_config_intent_unsupported",
      ));
    }
    const unavailable = readinessRegistrationUnavailable(options, factories, profile, role);
    if (unavailable) return Promise.resolve(unavailableTaskReadiness(profile, role, unavailable));
    if (poisonedCode) return Promise.resolve(unavailableTaskReadiness(profile, role, poisonedCode));
    const key = taskProfileReadinessKey(profile, role);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const family = profile.providerFamily as SessionIdAcpProductionProviderFamily;
    const factory = factories.get(family)!;
    const hostInputs = family === "opencode"
      ? options.hostInputs.openCode()
      : family === "codex"
        ? options.hostInputs.codex()
        : options.hostInputs.claudeCode();
    if (!hostInputs) {
      return Promise.resolve(unavailableTaskReadiness(
        profile,
        role,
        "acp_task_provider_not_configured",
      ));
    }
    const pending = (async () => {
      try {
        const report = await factory.checkReadiness(Object.freeze({
          profile,
          role,
          hostInputs,
          privateRootAuthority: options.privateAuthority.taskPrivateRootAuthority,
          identityVaultResolver: options.privateAuthority.taskIdentityVaults,
          signal,
        }));
        const observation = projectTaskReadiness(profile, role, report);
        cache.set(key, Object.freeze({ observation, expiresAt: Date.now() + 5_000 }));
        return observation;
      } catch (error) {
        const code = failureCode(error, "acp_task_readiness_probe_failed");
        if (isCleanupUnconfirmed(error)) {
          poisonedCode = code;
          throw safeError(code);
        }
        const observation = unavailableTaskReadiness(profile, role, code);
        cache.set(key, Object.freeze({ observation, expiresAt: Date.now() + 5_000 }));
        return observation;
      }
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, pending);
    return pending;
  }
}

function readinessRegistrationUnavailable(
  options: SessionIdAcpProductionCompositionOptions,
  factories: ReadonlyMap<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory>,
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
): string | undefined {
  const registration = inspectRegistration(options, factories, profile, role);
  return registration.status === "unavailable" ? registration.code : undefined;
}

function taskProfileReadinessKey(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ profile, role }), "utf8")
    .digest("hex");
}

function pendingTaskReadiness(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
): AcpProfileReadinessObservation {
  return validateAcpProfileReadinessObservation({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role,
    status: "checking",
    reasons: ["probe_pending"],
    missingCapabilities: [],
    missingExtensions: [],
    model: profile.model,
  });
}

function unavailableTaskReadiness(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
  reason: string,
): AcpProfileReadinessObservation {
  return validateAcpProfileReadinessObservation({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role,
    status: "unavailable",
    reasons: [requiredSafeCode(reason, "acp_task_readiness_reason_invalid")],
    missingCapabilities: [],
    missingExtensions: [],
    model: profile.model,
  });
}

function projectTaskReadiness(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
  report: AcpProviderAvailabilityReport,
): AcpProfileReadinessObservation {
  if (!report || report.profileRevisionId !== profile.profileRevisionId
    || report.providerFamily !== profile.providerFamily
    || report.acpAgentKind !== profile.acpAgentKind
    || report.role !== role) {
    return unavailableTaskReadiness(profile, role, "acp_task_readiness_identity_mismatch");
  }
  if (report.available && report.qualificationClass !== "binding_behavior") {
    return unavailableTaskReadiness(profile, role, "acp_task_readiness_behavior_unproven");
  }
  const missingCapabilities = Object.freeze(report.unavailableReasons
    .filter((reason) => reason.startsWith("acp_capability_missing:"))
    .map((reason) => reason.slice("acp_capability_missing:".length)));
  const missingExtensions = Object.freeze(report.unavailableReasons
    .filter((reason) => reason.startsWith("acp_extension_missing:"))
    .map((reason) => reason.slice("acp_extension_missing:".length)));
  const status = report.available
    ? "available"
    : missingCapabilities.length > 0 || missingExtensions.length > 0
      ? "capability_missing"
      : "unavailable";
  try {
    let readiness = validateAcpProfileReadinessObservation({
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      role,
      status,
      reasons: report.available ? [] : report.unavailableReasons,
      missingCapabilities,
      missingExtensions,
      model: profile.model,
      ...(report.modelCatalog ? { modelCatalog: report.modelCatalog } : {}),
    });
    for (const optional of [
      ...(report.protocolMajor === null ? [] : [{ observedProtocolMajor: report.protocolMajor }]),
      ...(report.agent ? [{ observedAgent: report.agent }] : []),
      ...(report.observedArtifactVersion
        ? [{ observedArtifactVersion: report.observedArtifactVersion }]
        : []),
      ...(report.observedUpstreamVersion
        ? [{ observedUpstreamVersion: report.observedUpstreamVersion }]
        : []),
      { observedCapabilities: report.capabilities },
      { observedExtensions: report.extensions },
    ]) {
      try {
        readiness = validateAcpProfileReadinessObservation({ ...readiness, ...optional });
      } catch {
        // Qualification is already fenced by the full Host-private report;
        // optional Renderer metadata is included only when portable and safe.
      }
    }
    return readiness;
  } catch {
    return unavailableTaskReadiness(profile, role, "acp_task_readiness_projection_invalid");
  }
}

function createTaskNativeBindingRegistry(
  options: SessionIdAcpProductionCompositionOptions,
  factories: ReadonlyMap<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory>,
  taskReadiness: TaskProfileReadinessOwner,
): SessionIdAcpProductionTaskNativeBindingRegistry {
  let closed = false;
  let poisonedCode: string | undefined;
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    inspect(profile, role) {
      if (poisonedCode) throw safeError(poisonedCode);
      if (closed) throw safeError("acp_task_native_registry_closed");
      const normalized = normalizeProfileAndRole(profile, role);
      return inspectRegistration(options, factories, normalized.profile, normalized.role);
    },
    async open(input) {
      if (poisonedCode) throw safeError(poisonedCode);
      if (closed) throw safeError("acp_task_native_registry_closed");
      const normalized = normalizeOpenInput(input);
      const registration = inspectRegistration(
        options,
        factories,
        normalized.profile,
        normalized.role,
      );
      assertExecutionFence(
        normalized.binding,
        normalized.frozenProfile,
        normalized.profile,
      );
      if (registration.status === "unavailable") {
        return openUnavailable(normalized.profile, normalized.role, registration.code);
      }
      const family = registration.providerFamily;
      const factory = factories.get(family);
      if (!factory) return openUnavailable(normalized.profile, normalized.role, "acp_task_provider_factory_not_registered");
      const hostInputs = family === "opencode"
        ? options.hostInputs.openCode()
        : family === "codex"
          ? options.hostInputs.codex()
          : options.hostInputs.claudeCode();
      if (!hostInputs) {
        return openUnavailable(normalized.profile, normalized.role, "acp_task_provider_not_configured");
      }
      if (normalized.signal.aborted) throw safeError("acp_task_native_open_aborted");
      let readiness: AcpProfileReadinessObservation;
      reportTaskNativeDiagnostic(
        options,
        normalized.role,
        "acp_task_native_readiness_started",
        "native_readiness",
      );
      try {
        readiness = await taskReadiness.forceBeforeOpen(
          normalized.profile,
          normalized.role,
          normalized.signal,
        );
      } catch (error) {
        if (isCleanupUnconfirmed(error)) {
          reportTaskNativeDiagnostic(
            options,
            normalized.role,
            "acp_task_readiness_cleanup_unconfirmed",
            "native_readiness",
          );
          poisonedCode = "acp_task_readiness_cleanup_unconfirmed";
          throw safeError(poisonedCode);
        }
        const code = failureCode(error, "acp_task_readiness_probe_failed");
        reportTaskNativeDiagnostic(
          options,
          normalized.role,
          code,
          "native_readiness",
        );
        return openUnavailable(
          normalized.profile,
          normalized.role,
          code,
        );
      }
      if (readiness.status !== "available") {
        reportTaskNativeDiagnostic(
          options,
          normalized.role,
          readiness.reasons[0] ?? "acp_task_readiness_unavailable",
          "native_readiness",
        );
        return openUnavailable(
          normalized.profile,
          normalized.role,
          readiness.reasons[0] ?? "acp_task_readiness_unavailable",
        );
      }
      reportTaskNativeDiagnostic(
        options,
        normalized.role,
        "acp_task_native_readiness_available",
        "native_readiness",
      );
      let result: SessionIdAcpProductionTaskNativeFactoryOpenResult;
      reportTaskNativeDiagnostic(
        options,
        normalized.role,
        "acp_task_native_factory_open_started",
        "native_factory_open",
      );
      try {
        result = await factory.open(Object.freeze({
          binding: normalized.binding,
          frozenProfile: normalized.frozenProfile,
          profile: normalized.profile,
          role: normalized.role,
          hostScope: normalized.hostScope,
          hostInputs,
          identityVaultResolver: options.privateAuthority.taskIdentityVaults,
          signal: normalized.signal,
          onObservation: (observation) => observeScopedExecution(
            options,
            normalized.binding,
            normalized.profile,
            normalized.role,
            normalized.observeDeliveryReceipt,
            observation,
          ),
          ...(options.onDiagnostic ? {
            onDiagnostic: (diagnostic: AcpTaskRuntimeDiagnostic) => options.onDiagnostic?.(
              Object.freeze({ ...diagnostic, role: normalized.role }),
            ),
          } : {}),
          ...(normalized.resolveTurnContext
            ? { resolveTurnContext: normalized.resolveTurnContext }
            : {}),
        }));
      } catch (error) {
        if (isCleanupUnconfirmed(error)) {
          poisonedCode = "acp_task_native_factory_open_cleanup_unconfirmed";
          throw safeError(poisonedCode);
        }
        return openUnavailable(normalized.profile, normalized.role, "acp_task_provider_open_failed");
      }
      if (!result || typeof result !== "object") {
        throw safeError("acp_task_native_factory_result_invalid");
      }
      if (!result.available) {
        reportTaskNativeDiagnostic(
          options,
          normalized.role,
          result.code,
          "native_factory_open",
        );
        return openUnavailable(
          normalized.profile,
          normalized.role,
          requiredSafeCode(result.code, "acp_task_native_factory_unavailable_code_invalid"),
        );
      }
      reportTaskNativeDiagnostic(
        options,
        normalized.role,
        "acp_task_native_factory_open_available",
        "native_factory_open",
      );
      const nativeBinding = validateNativeBinding(result.nativeBinding, normalized.binding.bindingHandle);
      try {
        await publishBindingReady(options, normalized.binding);
      } catch (error) {
        try {
          await cleanupBindingReadyFailure(nativeBinding);
        } catch {
          poisonedCode = "acp_task_binding_ready_cleanup_unconfirmed";
          throw safeError(poisonedCode);
        }
        return openUnavailable(
          normalized.profile,
          normalized.role,
          failureCode(error, "acp_task_binding_ready_observer_failed"),
        );
      }
      reportTaskNativeDiagnostic(
        options,
        normalized.role,
        "acp_task_binding_ready_published",
        "binding_ready",
      );
      return Object.freeze({ available: true as const, nativeBinding });
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const results: PromiseSettledResult<void>[] = [];
        for (const family of SUPPORTED_PROVIDER_FAMILIES) {
          const factory = factories.get(family);
          if (factory) results.push(await settle(factory.close()));
        }
        if (poisonedCode || results.some((result) => result.status === "rejected")) {
          throw safeError("acp_task_native_factory_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
}

function reportTaskNativeDiagnostic(
  options: SessionIdAcpProductionCompositionOptions,
  role: SessionIdAcpTaskRole,
  code: unknown,
  stage: string,
): void {
  if (!options.onDiagnostic) return;
  const safeCode = typeof code === "string" && SAFE_CODE.test(code)
    ? code
    : "acp_task_native_diagnostic_invalid";
  try {
    options.onDiagnostic(Object.freeze({ code: safeCode, role, stage }));
  } catch {
    // Host-only observability must never become a lifecycle decision or effect.
  }
}

function createMetaRegistration(
  options: SessionIdAcpProductionCompositionOptions,
): SessionIdAcpProductionMetaRegistration {
  if (options.configuration.metaProfiles.length === 0) {
    return Object.freeze({ status: "unavailable", code: "acp_meta_profile_not_configured" });
  }
  let registration: SessionIdAcpProductionMetaRegistration;
  try {
    registration = options.createMetaOwner
      ? options.createMetaOwner(Object.freeze({
          configuration: options.configuration,
          hostInputs: options.hostInputs,
          identityVaultResolver: options.privateAuthority.metaIdentityVaults,
        }))
      : Object.freeze({
          status: "configured" as const,
          owner: createAcpProductionMetaOwner({
            configuration: options.configuration,
            hostInputs: options.hostInputs,
            privateAuthority: options.privateAuthority,
          }),
        });
  } catch {
    return Object.freeze({ status: "unavailable", code: "acp_meta_owner_factory_not_registered" });
  }
  if (!registration || registration.status !== "configured"
    || !registration.owner || typeof registration.owner.close !== "function") {
    throw safeError("acp_meta_owner_factory_result_invalid");
  }
  return Object.freeze({ status: "configured", owner: registration.owner });
}

function inspectRegistration(
  options: SessionIdAcpProductionCompositionOptions,
  factories: ReadonlyMap<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory>,
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
): SessionIdAcpProductionTaskProfileRegistration {
  if (!SUPPORTED_PROVIDER_FAMILIES.includes(
    profile.providerFamily as SessionIdAcpProductionProviderFamily,
  )) {
    return unavailable(profile, role, "acp_task_provider_not_supported");
  }
  const configured = profile.providerFamily === "opencode"
    ? options.hostInputs.openCode()
    : profile.providerFamily === "codex"
      ? options.hostInputs.codex()
      : options.hostInputs.claudeCode();
  if (!configured) return unavailable(profile, role, "acp_task_provider_not_configured");
  if (!factories.has(profile.providerFamily)) {
    return unavailable(profile, role, "acp_task_provider_factory_not_registered");
  }
  return Object.freeze({
    status: "configured" as const,
    providerFamily: profile.providerFamily,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    role,
  });
}

function unavailable(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
  code: string,
): Extract<SessionIdAcpProductionTaskProfileRegistration, { status: "unavailable" }> {
  return Object.freeze({
    status: "unavailable" as const,
    providerFamily: profile.providerFamily,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    role,
    code: requiredSafeCode(code, "acp_task_unavailable_code_invalid"),
  });
}

function openUnavailable(
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
  code: string,
): Extract<SessionIdAcpProductionTaskNativeOpenResult, { available: false }> {
  return Object.freeze({
    available: false as const,
    providerFamily: profile.providerFamily,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    role,
    code: requiredSafeCode(code, "acp_task_unavailable_code_invalid"),
  });
}

async function observeScopedExecution(
  options: SessionIdAcpProductionCompositionOptions,
  binding: AcpSafeSessionBindingRecordV3,
  profile: ExecutionProfileDefinitionV3,
  role: SessionIdAcpTaskRole,
  observeDeliveryReceipt: (
    receipt: AcpTaskSessionRuntimeNativeDeliveryReceipt,
  ) => Promise<void>,
  value: AcpSessionObservation,
): Promise<void> {
  const observation = normalizeObservation(value, binding.bindingHandle);
  if (observation.kind === "delivery_receipt") {
    await observeDeliveryReceipt(Object.freeze({
      bindingHandle: observation.bindingHandle,
      sessionExecutionAttemptId: observation.attemptId,
      receiptDigest: observation.receiptDigest,
    }));
  }
  const scoped = Object.freeze({
    bindingId: binding.bindingId,
    bindingHandle: binding.bindingHandle,
    logicalSessionId: binding.logicalSessionId,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily as SessionIdAcpProductionProviderFamily,
    role,
    observation,
  });
  if (observation.kind === "final_candidate") {
    await options.observeFinalCandidate(
      scoped as SessionIdAcpProductionFinalCandidateObservation,
    );
  }
  await options.observeExecution(scoped);
}

function normalizeOpenInput(
  input: Parameters<SessionIdAcpProductionTaskNativeBindingRegistry["open"]>[0],
): Readonly<{
  binding: AcpSafeSessionBindingRecordV3;
  frozenProfile: AcpV3FrozenProfileTuple;
  profile: ExecutionProfileDefinitionV3;
  role: SessionIdAcpTaskRole;
  hostScope: SessionIdAcpTaskHostExecutionScope;
  signal: AbortSignal;
  observeDeliveryReceipt: (
    receipt: AcpTaskSessionRuntimeNativeDeliveryReceipt,
  ) => Promise<void>;
  resolveTurnContext?: (
    input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
  ) => ProviderScopedToolTurnContext | undefined;
}> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw safeError("acp_task_native_open_input_invalid");
  }
  const binding = validateAcpSafeSessionBindingRecordV3(input.binding);
  const frozenProfile = normalizeFrozenProfile(input.frozenProfile);
  const { profile, role } = normalizeProfileAndRole(input.profile, input.role);
  const hostScope = normalizeHostScope(input.hostScope, profile);
  if (!input.signal || typeof input.signal.aborted !== "boolean") {
    throw safeError("acp_task_native_open_signal_invalid");
  }
  if (typeof input.observeDeliveryReceipt !== "function") {
    throw safeError("acp_task_delivery_receipt_observer_invalid");
  }
  if (input.resolveTurnContext !== undefined && typeof input.resolveTurnContext !== "function") {
    throw safeError("acp_task_turn_context_resolver_invalid");
  }
  return Object.freeze({
    binding,
    frozenProfile,
    profile,
    role,
    hostScope,
    signal: input.signal,
    observeDeliveryReceipt: input.observeDeliveryReceipt,
    ...(input.resolveTurnContext ? { resolveTurnContext: input.resolveTurnContext } : {}),
  });
}

function normalizeResolvedTaskContext(
  value: Awaited<ReturnType<SessionIdAcpProductionCompositionOptions["resolveTaskBindingContext"]>>,
): Readonly<{
  profile: ExecutionProfileDefinitionV3;
  role: SessionIdAcpTaskRole;
  hostScope: SessionIdAcpTaskHostExecutionScope;
  resolveTurnContext?: (
    input: Readonly<{ readonly sessionExecutionAttemptId: string }>,
  ) => ProviderScopedToolTurnContext | undefined;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("acp_task_binding_context_invalid");
  }
  const { profile, role } = normalizeProfileAndRole(value.profile, value.role);
  const hostScope = normalizeHostScope(value.hostScope, profile);
  if (value.resolveTurnContext !== undefined && typeof value.resolveTurnContext !== "function") {
    throw safeError("acp_task_turn_context_resolver_invalid");
  }
  return Object.freeze({
    profile,
    role,
    hostScope,
    ...(value.resolveTurnContext ? { resolveTurnContext: value.resolveTurnContext } : {}),
  });
}

function normalizeProfileAndRole(
  value: ExecutionProfileDefinitionV3,
  roleValue: SessionIdAcpTaskRole,
): Readonly<{ profile: ExecutionProfileDefinitionV3; role: SessionIdAcpTaskRole }> {
  const profile = normalizeExecutionProfile(value);
  const role = normalizeRole(roleValue);
  const expectedTools = acpTaskRoleToolNames(role);
  if (!sameSet(profile.capabilityPolicy.allowedTools, expectedTools)) {
    throw safeError("acp_task_profile_role_policy_mismatch");
  }
  return Object.freeze({ profile, role });
}

function normalizeExecutionProfile(value: ExecutionProfileDefinitionV3): ExecutionProfileDefinitionV3 {
  try {
    assertSessionExecutionSafeValue(value, "ACP production Profile");
    assertJsonValue(value as unknown as JsonValue, "ACP production Profile");
  } catch {
    throw safeError("acp_task_profile_private_field_forbidden");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value as unknown as Record<string, unknown>, PROFILE_KEYS)
    || typeof value.executionProfileId !== "string" || !PROFILE_ID.test(value.executionProfileId)
    || typeof value.profileRevisionId !== "string" || !PROFILE_REVISION_ID.test(value.profileRevisionId)
    || value.protocolMajor !== 1
    || typeof value.model !== "string" || !PORTABLE_MODEL_IDENTIFIER.test(value.model)
    || !Array.isArray(value.requiredExtensions)
    || new Set(value.requiredExtensions).size !== value.requiredExtensions.length
    || value.requiredExtensions.some((entry) => typeof entry !== "string" || !PORTABLE_IDENTIFIER.test(entry))
    || !value.capabilityPolicy || typeof value.capabilityPolicy !== "object"
    || Array.isArray(value.capabilityPolicy)
    || !sameKeys(value.capabilityPolicy as unknown as Record<string, unknown>, POLICY_KEYS)) {
    throw safeError("acp_task_profile_invalid");
  }
  const expectedAgentKind = value.providerFamily === "opencode"
    ? "native_acp"
    : value.providerFamily === "codex"
      ? "codex_acp"
      : value.providerFamily === "claude-code"
        ? "claude_agent_acp"
        : undefined;
  if (!expectedAgentKind || value.acpAgentKind !== expectedAgentKind) {
    throw safeError("acp_task_profile_agent_kind_mismatch");
  }
  const policy = value.capabilityPolicy;
  if (!Array.isArray(policy.requiredCapabilities)
    || policy.requiredCapabilities.some((capability) => (
      typeof capability !== "string" || !PORTABLE_IDENTIFIER.test(capability)
    ))
    || new Set(policy.requiredCapabilities).size !== policy.requiredCapabilities.length
    || MANAGED_CAPABILITIES.some((capability) =>
      !(policy.requiredCapabilities as readonly string[]).includes(capability))
    || !Array.isArray(policy.allowedTools)
    || policy.allowedTools.some((tool) => typeof tool !== "string" || !PORTABLE_IDENTIFIER.test(tool))
    || new Set(policy.allowedTools).size !== policy.allowedTools.length
    || !["ask", "preapproved", "deny"].includes(policy.permissionMode)
    || !Number.isSafeInteger(policy.maxConcurrentTurns) || policy.maxConcurrentTurns < 1
    || !Number.isSafeInteger(policy.maxNativeChildren) || policy.maxNativeChildren < 0) {
    throw safeError("acp_task_profile_capability_policy_invalid");
  }
  return deepFreeze(cloneJson(value as unknown as JsonValue) as unknown as ExecutionProfileDefinitionV3);
}

function normalizeFrozenProfile(value: AcpV3FrozenProfileTuple): AcpV3FrozenProfileTuple {
  try {
    assertSessionExecutionSafeValue(value, "ACP frozen Profile tuple");
  } catch {
    throw safeError("acp_task_frozen_profile_invalid");
  }
  if (!value || value.schemaVersion !== 3
    || typeof value.executionProfileId !== "string" || !PROFILE_ID.test(value.executionProfileId)
    || typeof value.profileRevisionId !== "string" || !PROFILE_REVISION_ID.test(value.profileRevisionId)
    || !["opencode", "codex", "claude-code"].includes(value.providerFamily)) {
    throw safeError("acp_task_frozen_profile_invalid");
  }
  return Object.freeze({ ...value });
}

function normalizeHostScope(
  value: SessionIdAcpTaskHostExecutionScope,
  _profile: ExecutionProfileDefinitionV3,
): SessionIdAcpTaskHostExecutionScope {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value as unknown as Record<string, unknown>, [
      "authorizedWorkspaceDirectory",
      "privateRootAuthority",
    ])) {
    throw safeError("acp_task_host_scope_invalid");
  }
  const authorizedWorkspaceDirectory = absoluteHostPath(
    value.authorizedWorkspaceDirectory,
    "acp_task_workspace_authority_invalid",
  );
  if (!value.privateRootAuthority || typeof value.privateRootAuthority !== "object"
    || typeof value.privateRootAuthority.toJSON !== "function") {
    throw safeError("acp_task_private_root_authority_invalid");
  }
  return Object.freeze({
    authorizedWorkspaceDirectory,
    privateRootAuthority: value.privateRootAuthority,
  });
}

/**
 * Portable config intent is not an ACP config-id bag. Only explicitly frozen
 * provider semantic mappings compile; every other non-empty intent fails before
 * resolution, child launch or credential effect.
 */
function compileTaskSessionConfiguration(
  profile: ExecutionProfileDefinitionV3,
): AcpSessionConfigurationIntent {
  return compilePortableSessionConfiguration(profile);
}

/** Provider-specific semantic compiler; values are verified against the live ACP inventory. */
export function compileClaudeCodeAcpSessionConfiguration(
  profile: ExecutionProfileDefinitionV3,
): AcpSessionConfigurationIntent {
  if (!profile || profile.providerFamily !== "claude-code"
    || profile.acpAgentKind !== "claude_agent_acp") {
    throw safeError("acp_claude_code_session_configuration_profile_mismatch");
  }
  return compilePortableSessionConfiguration(profile);
}

function compilePortableSessionConfiguration(profile: Readonly<{
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly model: string;
  readonly configIntent: Readonly<Record<string, JsonValue>>;
  readonly capabilityPolicy: Readonly<{
    readonly permissionMode: "ask" | "preapproved" | "deny";
  }>;
}>): AcpSessionConfigurationIntent {
  if (!profile.configIntent || typeof profile.configIntent !== "object"
    || Array.isArray(profile.configIntent)) {
    throw safeError("acp_task_config_intent_unsupported");
  }
  const keys = Object.keys(profile.configIntent);
  let options: AcpSessionConfigurationIntent["options"] = profile.providerFamily === "claude-code"
    ? Object.freeze([Object.freeze({
        configId: "mode",
        category: "mode",
        type: "select" as const,
        value: profile.capabilityPolicy.permissionMode === "preapproved"
          ? "bypassPermissions"
          : profile.capabilityPolicy.permissionMode === "deny"
            ? "dontAsk"
            : "default",
      })])
    : Object.freeze([]);
  if (keys.length === 0) {
    // The exact empty portable intent deliberately means model only.
  } else if (profile.providerFamily === "codex"
    && sameKeys(profile.configIntent as Record<string, unknown>, ["reasoningEffort"])
    && typeof profile.configIntent.reasoningEffort === "string"
    && PORTABLE_IDENTIFIER.test(profile.configIntent.reasoningEffort)) {
    // Current codex-acp advertises this exact ACP config id/category. The ACP
    // client still verifies the current Binding inventory and confirmed value.
    options = Object.freeze([...options, Object.freeze({
      configId: "reasoning_effort",
      category: "thought_level",
      type: "select" as const,
      value: profile.configIntent.reasoningEffort,
    })]);
  } else {
    throw safeError("acp_task_config_intent_unsupported");
  }
  return normalizeSessionConfiguration(Object.freeze({
    model: profile.model,
    options,
  }), profile.model);
}

function normalizeSessionConfiguration(
  value: AcpSessionConfigurationIntent,
  expectedModel: string,
): AcpSessionConfigurationIntent {
  try {
    assertJsonValue(value as unknown as JsonValue, "ACP session configuration");
    assertSessionExecutionSafeValue(value, "ACP session configuration");
  } catch {
    throw safeError("acp_task_session_configuration_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value as unknown as Record<string, unknown>, value.legacyModeId === undefined
      ? ["model", "options"]
      : ["model", "options", "legacyModeId"])
    || value.model !== expectedModel
    || !Array.isArray(value.options)
    || value.options.length > 128
    || value.options.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || !sameKeys(entry as unknown as Record<string, unknown>, [
          "configId",
          "category",
          "type",
          "value",
        ])
        || typeof entry.configId !== "string" || !PORTABLE_IDENTIFIER.test(entry.configId)
        || typeof entry.category !== "string" || !PORTABLE_IDENTIFIER.test(entry.category)
        || (entry.type !== "select" && entry.type !== "boolean")) return true;
      return entry.type === "select"
        ? typeof entry.value !== "string" || !PORTABLE_IDENTIFIER.test(entry.value)
        : typeof entry.value !== "boolean";
    })) {
    throw safeError("acp_task_session_configuration_invalid");
  }
  const identities = value.options.map((entry) => `${entry.category}\0${entry.configId}`);
  if (new Set(identities).size !== identities.length) {
    throw safeError("acp_task_session_configuration_duplicate");
  }
  if (value.legacyModeId !== undefined
    && (typeof value.legacyModeId !== "string" || !PORTABLE_IDENTIFIER.test(value.legacyModeId))) {
    throw safeError("acp_task_session_configuration_invalid");
  }
  return deepFreeze(cloneJson(value as unknown as JsonValue) as unknown as AcpSessionConfigurationIntent);
}

function assertExecutionFence(
  binding: AcpSafeSessionBindingRecordV3,
  frozenProfile: AcpV3FrozenProfileTuple,
  profile: ExecutionProfileDefinitionV3,
): void {
  if ((binding.status !== "active" && binding.status !== "recovering")
    || binding.recoverable !== true
    || binding.executionProfileId !== frozenProfile.executionProfileId
    || binding.profileRevisionId !== frozenProfile.profileRevisionId
    || binding.providerFamily !== frozenProfile.providerFamily
    || profile.executionProfileId !== frozenProfile.executionProfileId
    || profile.profileRevisionId !== frozenProfile.profileRevisionId
    || profile.providerFamily !== frozenProfile.providerFamily) {
    throw safeError("acp_task_binding_profile_fence_mismatch");
  }
}

function normalizeObservation(
  value: AcpSessionObservation,
  bindingHandle: string,
): AcpSessionObservation {
  try {
    assertSessionExecutionSafeValue(value, "ACP production observation");
    assertJsonValue(value as unknown as JsonValue, "ACP production observation");
  } catch {
    throw safeError("acp_task_execution_observation_private_field_forbidden");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !OBSERVATION_KINDS.has(value.kind)
    || value.bindingHandle !== bindingHandle
    || typeof value.attemptId !== "string" || !ATTEMPT_ID.test(value.attemptId)) {
    throw safeError("acp_task_execution_observation_scope_mismatch");
  }
  return deepFreeze(cloneJson(value as unknown as JsonValue) as unknown as AcpSessionObservation);
}

function validateNativeBinding(
  value: AcpTaskSessionRuntimeNativeBinding,
  bindingHandle: string,
): AcpTaskSessionRuntimeNativeBinding {
  if (!value || typeof value !== "object" || value.bindingHandle !== bindingHandle
    || typeof value.submitDelivery !== "function"
    || typeof value.reconcileAttempt !== "function"
    || typeof value.retire !== "function"
    || typeof value.close !== "function") {
    throw safeError("acp_task_native_binding_invalid");
  }
  return value;
}

function trackNativeBinding(
  native: AcpTaskSessionRuntimeNativeBinding,
  active: Set<AcpTaskSessionRuntimeNativeBinding>,
  onClosed?: () => void | Promise<void>,
): AcpTaskSessionRuntimeNativeBinding {
  let tracked: AcpTaskSessionRuntimeNativeBinding;
  let closePromise: Promise<void> | undefined;
  const close = (input: Readonly<{ readonly signal: AbortSignal }>): Promise<void> => {
    closePromise ??= (async () => {
      await native.close(input);
      await onClosed?.();
      active.delete(tracked);
    })();
    return closePromise;
  };
  tracked = Object.freeze({
    bindingHandle: native.bindingHandle,
    submitDelivery: native.submitDelivery,
    reconcileAttempt: native.reconcileAttempt,
    ...(native.requestInterrupt ? { requestInterrupt: native.requestInterrupt } : {}),
    ...(native.respondInteraction ? { respondInteraction: native.respondInteraction } : {}),
    ...(native.cancelTimedOutEffect
      ? { cancelTimedOutEffect: native.cancelTimedOutEffect }
      : {}),
    retire: native.retire,
    close,
  });
  return tracked;
}

async function cleanupBindingReadyFailure(
  native: AcpTaskSessionRuntimeNativeBinding,
): Promise<void> {
  const signal = new AbortController().signal;
  const retirement = await settle(native.retire({ signal }));
  const closure = await settle(native.close({ signal }));
  if (retirement.status === "rejected" || closure.status === "rejected") {
    throw safeError("acp_task_binding_ready_cleanup_unconfirmed");
  }
}

async function publishBindingReady(
  options: SessionIdAcpProductionCompositionOptions,
  binding: AcpSafeSessionBindingRecordV3,
): Promise<void> {
  const runtime = options.repositories.sessionRuntime.getRuntimeForSession(
    binding.logicalSessionId,
  );
  if (!runtime || runtime.taskId !== binding.taskId || runtime.runId !== binding.runId
    || runtime.logicalSessionId !== binding.logicalSessionId || runtime.state === "closed") {
    throw safeError("acp_task_binding_ready_runtime_mismatch");
  }
  const event: SessionRuntimeBindingReadyEvent = options.sessionRuntimeOwner.bindingReadyEvent({
    sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
    logicalSessionId: binding.logicalSessionId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    bindingHandle: binding.bindingHandle,
    recoverable: binding.recoverable,
  });
  await options.onBindingReady(event);
}

async function closeTrackedNativeBindings(
  active: Set<AcpTaskSessionRuntimeNativeBinding>,
  failureCode: string,
): Promise<void> {
  let failed = false;
  for (const native of [...active]) {
    const signal = new AbortController().signal;
    const retirement = await settle(native.retire({ signal }));
    const closure = await settle(native.close({ signal }));
    if (retirement.status === "rejected" || closure.status === "rejected") failed = true;
  }
  if (failed || active.size !== 0) throw safeError(failureCode);
}

function absoluteHostPath(value: unknown, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError(code);
  }
  return path.normalize(value);
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return isContainedRelativePath(leftToRight) || isContainedRelativePath(rightToLeft);
}

function ensureHostPrivateChildDirectory(parent: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name)) {
    throw safeError("acp_production_private_directory_invalid");
  }
  const canonicalParent = realpathSync(parent);
  const directory = path.join(canonicalParent, name);
  if (path.dirname(directory) !== canonicalParent) {
    throw safeError("acp_production_private_directory_invalid");
  }
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object"
      || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw safeError("acp_production_private_directory_invalid");
    }
  }
  try {
    const metadata = lstatSync(directory);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || realpathSync(directory) !== directory
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
      || (currentUid !== undefined && metadata.uid !== currentUid)) {
      throw new Error("unsafe");
    }
  } catch {
    throw safeError("acp_production_private_directory_invalid");
  }
  return directory;
}

function isContainedRelativePath(value: string): boolean {
  return Boolean(value && !path.isAbsolute(value)
    && value !== ".." && !value.startsWith(`..${path.sep}`));
}

function isMissingFile(value: unknown): boolean {
  return Boolean(value && typeof value === "object"
    && (value as NodeJS.ErrnoException).code === "ENOENT");
}

function isOpenCodeHostInputs(
  value: AcpProductionOpenCodeHostInputs
    | AcpProductionCodexHostInputs
    | AcpProductionClaudeCodeHostInputs,
): value is AcpProductionOpenCodeHostInputs {
  const candidate = value as AcpProductionOpenCodeHostInputs;
  return Boolean(value
    && sameKeys(value as unknown as Record<string, unknown>, [
      "commandReference",
      "executableSearchPath",
      "authFile",
    ])
    && typeof candidate.commandReference === "string"
    && typeof candidate.executableSearchPath === "string"
    && typeof candidate.authFile === "string");
}

function isCodexHostInputs(
  value: AcpProductionOpenCodeHostInputs
    | AcpProductionCodexHostInputs
    | AcpProductionClaudeCodeHostInputs,
): value is AcpProductionCodexHostInputs {
  const candidate = value as AcpProductionCodexHostInputs;
  return Boolean(value
    && sameKeys(value as unknown as Record<string, unknown>, [
      "wrapperCommandReference",
      "codexCommandReference",
      "nodeCommandReference",
      "executableSearchPath",
      "authFile",
    ])
    && typeof candidate.wrapperCommandReference === "string"
    && typeof candidate.codexCommandReference === "string"
    && typeof candidate.nodeCommandReference === "string"
    && typeof candidate.executableSearchPath === "string"
    && typeof candidate.authFile === "string");
}

function isClaudeCodeHostInputs(
  value: AcpProductionOpenCodeHostInputs
    | AcpProductionCodexHostInputs
    | AcpProductionClaudeCodeHostInputs,
): value is AcpProductionClaudeCodeHostInputs {
  const candidate = value as AcpProductionClaudeCodeHostInputs;
  return Boolean(value
    && sameKeys(value as unknown as Record<string, unknown>, [
      "wrapperCommandReference",
      "claudeCommandReference",
      "nodeCommandReference",
      "executableSearchPath",
      "settingsFile",
    ])
    && typeof candidate.wrapperCommandReference === "string"
    && typeof candidate.claudeCommandReference === "string"
    && typeof candidate.nodeCommandReference === "string"
    && typeof candidate.executableSearchPath === "string"
    && typeof candidate.settingsFile === "string");
}

function normalizeFactories(
  value: SessionIdAcpProductionCompositionOptions["taskNativeFactories"],
): ReadonlyMap<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !SUPPORTED_PROVIDER_FAMILIES.includes(
      key as SessionIdAcpProductionProviderFamily,
    ))) {
    throw safeError("acp_task_native_factories_invalid");
  }
  const factories = new Map<SessionIdAcpProductionProviderFamily, SessionIdAcpProductionTaskNativeFactory>();
  for (const family of SUPPORTED_PROVIDER_FAMILIES) {
    const factory = value[family];
    if (!factory) continue;
    if (factory.providerFamily !== family
      || typeof factory.readModelCatalog !== "function"
      || typeof factory.checkReadiness !== "function"
      || typeof factory.open !== "function"
      || typeof factory.close !== "function") {
      throw safeError("acp_task_native_factory_family_mismatch");
    }
    factories.set(family, factory);
  }
  const configuredFactories = [...factories.values()];
  if (new Set(configuredFactories).size !== configuredFactories.length) {
    throw safeError("acp_task_native_factory_alias_forbidden");
  }
  return factories;
}

function validateOptions(value: SessionIdAcpProductionCompositionOptions): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.configuration || value.configuration.schemaVersion !== 1
    || !value.hostInputs || typeof value.hostInputs.openCode !== "function"
    || typeof value.hostInputs.codex !== "function"
    || typeof value.hostInputs.claudeCode !== "function"
    || !value.privateAuthority
    || typeof value.privateAuthority.taskIdentityVaults !== "function"
    || typeof value.privateAuthority.metaIdentityVaults !== "function"
    || typeof value.privateAuthority.close !== "function"
    || !value.repositories
    || !value.sessionRuntimeOwner
    || typeof value.resolveFrozenProfileTuple !== "function"
    || typeof value.resolveInterruptCorrelation !== "function"
    || typeof value.resolveTaskStopControl !== "function"
    || typeof value.resolveCloseControl !== "function"
    || typeof value.authorizeRetiringBindingRecovery !== "function"
    || typeof value.resolveTaskBindingContext !== "function"
    || typeof value.observeExecution !== "function"
    || typeof value.observeFinalCandidate !== "function"
    || typeof value.onDeliveryReceipt !== "function"
    || typeof value.onBindingReady !== "function"
    || (value.onDiagnostic !== undefined && typeof value.onDiagnostic !== "function")
    || !value.taskNativeFactories
    || !Number.isSafeInteger(value.effectDeadlineMs)
    || value.effectDeadlineMs < 1
    || value.effectDeadlineMs > 10 * 60_000) {
    throw safeError("acp_production_composition_options_invalid");
  }
}

function normalizeRole(value: unknown): SessionIdAcpTaskRole {
  if (!TASK_ROLES.includes(value as SessionIdAcpTaskRole)) {
    throw safeError("acp_task_role_invalid");
  }
  return value as SessionIdAcpTaskRole;
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((entry) => actual.includes(entry));
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const target = [...expected].sort();
  return keys.length === target.length && keys.every((key, index) => key === target[index]);
}

function requiredSafeCode(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) throw safeError(fallback);
  return value;
}

function failureCode(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "code" in value
    && typeof (value as { code?: unknown }).code === "string"
    && SAFE_CODE.test((value as { code: string }).code)) {
    return (value as { code: string }).code;
  }
  return fallback;
}

function isCleanupUnconfirmed(value: unknown): boolean {
  return Boolean(value
    && typeof value === "object"
    && "code" in value
    && typeof (value as { code?: unknown }).code === "string"
    && (value as { code: string }).code.endsWith("cleanup_unconfirmed"));
}

function safeError(code: string): SessionIdAcpProductionCompositionError {
  return new SessionIdAcpProductionCompositionError(code);
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}
