import { createHash, randomUUID } from "node:crypto";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type {
  AcpModelCatalogEntry,
  AcpQualificationObservation,
  AcpSessionObservation,
  AcpV1Capability,
  AcpV1ReverseRpcHandlers,
  CreateManagedAcpV1ClientOptions,
  ManagedAcpV1Client,
} from "@agent-workspace/provider-acp";
import {
  createAcpAgentProcessFactory,
  type AcpAgentProcessCloseObservation,
  type AcpAgentProcessFactory,
  type AcpAgentProcessLease,
  type AcpProcessGeneration,
  type AcpCredentialLease,
  type AcpStdioConnectionFactory,
} from "./acp-agent-process.js";
import {
  createAcpProfileResolutionRegistry,
  type AcpPortableProfileDefinitionV3,
  type AcpCurrentInstallDescriptor,
  type AcpProfileResolutionRegistry,
  type LocalProfileResolution,
} from "./acp-profile-resolution.js";
import {
  createAcpQualificationAuthority,
  projectSafeAcpAgentObservation,
  type AcpQualification,
  type AcpQualificationAuthority,
  type AcpQualificationRole,
  type AcpQualificationSafeReport,
} from "./acp-qualification.js";
import {
  createAcpReverseRpcBroker,
  type AcpReverseRpcBroker,
  type AcpReverseRpcLease,
  type AcpReverseRpcRegistration,
} from "./acp-reverse-rpc-broker.js";

const SAFE_CODE = /^[a-z][a-z0-9:_-]{0,191}$/u;
const REVERSE_RPC_HANDLER_KEYS = Object.freeze([
  "readTextFile",
  "writeTextFile",
  "createTerminal",
  "terminalOutput",
  "waitForTerminalExit",
  "killTerminal",
  "releaseTerminal",
] as const);
type ReverseRpcHandlerKey = (typeof REVERSE_RPC_HANDLER_KEYS)[number];

type CredentialProvenance = {
  readonly owner: object;
  readonly profileRevisionId: string;
  readonly role: AcpQualificationRole;
  readonly bindingHandle: string;
  generation?: AcpProcessGeneration;
};

// The acquisition seam supplies material; only this module can attach the
// process-owner/profile/Binding/generation claim used to prevent cross-owner
// or cross-generation reuse of the same lease object.
const CREDENTIAL_PROVENANCE = new WeakMap<object, CredentialProvenance>();

declare const targetLifecycleCapabilityBrand: unique symbol;

/**
 * Host-local, one-shot capability. It is minted only after an actual target
 * Binding has observed one complete prompt lifecycle and its process, native
 * Binding, credential and reverse-RPC authority are all confirmed gone.
 *
 * This provider-neutral capability is deliberately not a native/release
 * attestation. A concrete production owner must separately prove that it used
 * an uncompromised current-install factory before it may issue release proof.
 */
export type AcpTargetLifecycleCapability = Readonly<{
  readonly [targetLifecycleCapabilityBrand]: true;
}>;

export type AcpTargetLifecycleObservation = Readonly<{
  readonly schemaVersion: 1;
  readonly evidenceClass: "host_target_lifecycle_observation";
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly role: AcpQualificationRole;
  readonly model: string;
  readonly profileConfigurationDigest: string;
  readonly resolutionSealDigest: string;
  readonly observedArtifactVersion: string;
  readonly observedUpstreamVersion?: string;
  readonly processGenerationDigest: string;
  readonly initialize: Readonly<{
    readonly protocolMajor: number;
    readonly agent?: AcpQualificationObservation["agent"];
    readonly capabilities: readonly AcpV1Capability[];
    readonly extensions: readonly string[];
    readonly capabilityFingerprint: string;
  }>;
  readonly qualificationProbeDigest: string;
  readonly actualPrompt: Readonly<{
    readonly receiptObserved: true;
    readonly finalObserved: true;
    readonly terminalObserved: true;
    readonly attemptCorrelationDigest: string;
    readonly lifecycleDigest: string;
  }>;
  readonly cleanup: Readonly<{
    readonly bindingReleaseConfirmed: true;
    readonly processExitConfirmed: true;
    readonly credentialCleanupConfirmed: true;
    readonly capabilityCleanupConfirmed: true;
    readonly receiptDigest: string;
  }>;
}>;

export type AcpTargetLifecycleCapabilityNotice = Readonly<{
  /** Workspace-generated opaque handle; never a raw ACP session id. */
  readonly bindingHandle: string;
  readonly capability: AcpTargetLifecycleCapability;
}>;

export type AcpTargetCheckpointFactKind =
  | "actual_binding_generation"
  | "prompt_receipt"
  | "latest_final_terminal_pair"
  | "cancel_reconcile"
  | "restart_load_resume"
  | "scoped_mcp_call"
  | "independent_process"
  | "no_tools"
  | "no_cwd"
  | "no_workspace"
  | "strict_whole_final"
  | "permission_rejected"
  | "cold_reconcile";

declare const targetCheckpointFactCapabilityBrand: unique symbol;

/** Host-local, exact-once authority minted only after target cleanup. */
export type AcpTargetCheckpointFactCapability = Readonly<{
  readonly [targetCheckpointFactCapabilityBrand]: true;
}>;

export type AcpTargetCheckpointFactObservation = Readonly<{
  readonly schemaVersion: 1;
  readonly evidenceClass: "host_target_checkpoint_fact";
  readonly kind: AcpTargetCheckpointFactKind;
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly role: AcpQualificationRole;
  readonly model: string;
  readonly profileConfigurationDigest: string;
  readonly resolutionSealDigest: string;
  readonly processGenerationDigest: string;
  readonly observationDigest: string;
}>;

export type AcpTargetCheckpointFactCapabilityNotice = Readonly<{
  /** Host-private routing handle; absent from the claimed safe observation. */
  readonly bindingHandle: string;
  readonly capability: AcpTargetCheckpointFactCapability;
}>;

export type AcpTargetCheckpointEvent =
  | Readonly<{
      readonly kind: "task_scoped_mcp_call";
      readonly bindingHandle: string;
      readonly attemptId: string;
      readonly role: "conductor" | "publisher";
      readonly toolName: string;
    }>
  | Readonly<{
      readonly kind: "task_cancel_accepted" | "task_reconcile_settled";
      readonly bindingHandle: string;
      readonly attemptId: string;
      readonly role: Exclude<AcpQualificationRole, "meta">;
    }>
  | Readonly<{
      readonly kind: "task_recovery_opened";
      readonly bindingHandle: string;
      readonly role: Exclude<AcpQualificationRole, "meta">;
      readonly disposition: "load" | "resume";
      readonly oldPromptReplayCount: 0;
    }>
  | Readonly<{
      readonly kind: "meta_isolation_opened";
      readonly bindingHandle: string;
      readonly role: "meta";
      readonly privateDirectoryLeaseConfirmed: true;
      readonly toolCapabilityClass: "template_draft";
      readonly toolSurfaceCount: number;
      readonly callerCwdPresent: false;
      readonly taskWorkspacePresent: false;
    }>
  | Readonly<{
      readonly kind: "meta_strict_whole_final" | "meta_permission_rejected";
      readonly bindingHandle: string;
      readonly attemptId: string;
      readonly role: "meta";
    }>
  | Readonly<{
      readonly kind: "meta_cold_reconcile_no_resend";
      readonly bindingHandle: string;
      readonly role: "meta";
      readonly disposition: "resume";
      readonly promptEffectDelta: 0;
    }>;

/** Mechanical target-only observer. Callers cannot claim or serialize it. */
export type AcpTargetCheckpointObserver = Readonly<{
  observe(event: AcpTargetCheckpointEvent): void;
}>;

type TargetLifecycleCapabilityState = {
  readonly observation: AcpTargetLifecycleObservation;
  claimed: boolean;
};

const TARGET_LIFECYCLE_CAPABILITIES = new WeakMap<object, TargetLifecycleCapabilityState>();
const TARGET_CHECKPOINT_FACT_CAPABILITIES = new WeakMap<
  object,
  Readonly<{ observation: AcpTargetCheckpointFactObservation; claimed: { value: boolean } }>
>();

/** Claims exactly one safe projection from a Host-minted lifecycle capability. */
export function claimAcpTargetLifecycleObservation(
  capability: AcpTargetLifecycleCapability | undefined,
): AcpTargetLifecycleObservation {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw compositionError("acp_target_lifecycle_capability_unrecognized");
  }
  const state = TARGET_LIFECYCLE_CAPABILITIES.get(capability as object);
  if (!state) throw compositionError("acp_target_lifecycle_capability_unrecognized");
  if (state.claimed) throw compositionError("acp_target_lifecycle_capability_already_claimed");
  state.claimed = true;
  return state.observation;
}

/** Claims one cleanup-fenced safe checkpoint fact. */
export function claimAcpTargetCheckpointFactObservation(
  capability: AcpTargetCheckpointFactCapability | undefined,
): AcpTargetCheckpointFactObservation {
  if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
    throw compositionError("acp_target_checkpoint_fact_capability_unrecognized");
  }
  const state = TARGET_CHECKPOINT_FACT_CAPABILITIES.get(capability as object);
  if (!state) throw compositionError("acp_target_checkpoint_fact_capability_unrecognized");
  if (state.claimed.value) {
    throw compositionError("acp_target_checkpoint_fact_capability_already_claimed");
  }
  state.claimed.value = true;
  return state.observation;
}

export type AcpProviderProbeResult = Readonly<{
  readonly passedBehaviors: readonly string[];
  /** Safe category=model choices observed on the exact bounded ACP Binding. */
  readonly modelCatalog?: readonly AcpModelCatalogEntry[];
  readonly safeObservations?: Readonly<Record<string, string | number | boolean | null>>;
  /** True only when this bounded probe materialized the supplied Binding handle. */
  readonly bindingEstablished: boolean;
}>;

export type AcpProviderProbeContext<
  TProfile extends AcpPortableProfileDefinitionV3 = ExecutionProfileDefinitionV3,
> = Readonly<{
  readonly profile: TProfile;
  readonly bindingHandle: string;
  readonly client: ManagedAcpV1Client;
  readonly resolution: LocalProfileResolution;
  readonly reverseRpcLease?: AcpReverseRpcLease;
}>;

export type AcpProviderRecoveryProbeContext<
  TProfile extends AcpPortableProfileDefinitionV3 = ExecutionProfileDefinitionV3,
> = AcpProviderProbeContext<TProfile> & Readonly<{
  readonly recoveryCapability: AcpV1Capability;
}>;

export type AcpProviderTargetBindingContext<
  TProfile extends AcpPortableProfileDefinitionV3 = ExecutionProfileDefinitionV3,
> = AcpProviderProbeContext<TProfile> & Readonly<{
  readonly checkpointObserver?: AcpTargetCheckpointObserver;
}>;

export type AcpCredentialAcquisitionOperation = Readonly<{
  /** Ownership transfers to the process factory only when this promise resolves. */
  readonly lease: Promise<AcpCredentialLease>;
  /** Resolves only after any pre-transfer credential material is removed. */
  cancelAndWait(): Promise<Readonly<{ readonly credentialCleanupConfirmed: boolean }>>;
}>;

export type AcpProviderQualificationRequest<
  TProfile extends AcpPortableProfileDefinitionV3 = ExecutionProfileDefinitionV3,
> = Readonly<{
  readonly profile: TProfile;
  readonly descriptor: AcpCurrentInstallDescriptor<TProfile>;
  readonly role: AcpQualificationRole;
  readonly requiredAcpCapabilities: readonly AcpV1Capability[];
  /** At least one capability in this provider-neutral alternative set is required. */
  readonly requiredAnyAcpCapabilities?: readonly AcpV1Capability[];
  readonly requiredBehaviors: readonly string[];
  readonly workspaceDirectory?: string;
  readonly createConnection: AcpStdioConnectionFactory;
  readonly beginCredentialAcquisition?: (scope: Readonly<{
    bindingHandle: string;
  }>) => AcpCredentialAcquisitionOperation;
  readonly managedClientOptions?: Omit<
    CreateManagedAcpV1ClientOptions,
    "connect" | "generationId" | "reverseRpcHandlers" | "extensionPredicates"
  >;
  readonly createReverseRpcRegistration?: () => Omit<
    AcpReverseRpcRegistration,
    "bindingHandle" | "generation"
  >;
  /** Bounded model/behavior probe deadline; other Host operations keep the composition deadline. */
  readonly behaviorProbeTimeoutMs?: number;
  runProbe(context: AcpProviderProbeContext<TProfile>): Promise<AcpProviderProbeResult>;
  /** Runs only after runProbe's Binding is adopted by a fresh process generation. */
  runRecoveryProbe?(
    context: AcpProviderRecoveryProbeContext<TProfile>,
  ): Promise<AcpProviderProbeResult>;
  /** Establishes the target Binding without reusing the qualification probe Binding. */
  establishTargetBinding?(
    context: AcpProviderTargetBindingContext<TProfile>,
  ): Promise<Readonly<{ readonly bindingEstablished: true }>>;
}>;

export type AcpProviderModelCatalogRequest<
  TProfile extends AcpPortableProfileDefinitionV3 = ExecutionProfileDefinitionV3,
> = Readonly<{
  readonly profile: TProfile;
  readonly descriptor: AcpCurrentInstallDescriptor<TProfile>;
  readonly role: AcpQualificationRole;
  readonly requiredAcpCapabilities: readonly AcpV1Capability[];
  readonly workspaceDirectory: string;
  readonly createConnection: AcpStdioConnectionFactory;
  readonly beginCredentialAcquisition?: (scope: Readonly<{
    bindingHandle: string;
  }>) => AcpCredentialAcquisitionOperation;
  readonly managedClientOptions?: Omit<
    CreateManagedAcpV1ClientOptions,
    "connect" | "generationId" | "reverseRpcHandlers" | "extensionPredicates"
  >;
}>;

export type AcpProviderModelCatalogInspection = Readonly<{
  readonly available: boolean;
  readonly modelCatalog: readonly AcpModelCatalogEntry[];
  readonly unavailableReasons: readonly string[];
}>;

export type AcpProviderAvailabilityReport = Readonly<{
  readonly profileRevisionId: string;
  readonly providerFamily: ExecutionProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
  readonly role: AcpQualificationRole;
  readonly available: boolean;
  readonly protocolMajor: number | null;
  readonly agent?: AcpQualificationObservation["agent"];
  readonly capabilities: readonly AcpV1Capability[];
  readonly extensions: readonly string[];
  readonly capabilityFingerprint?: string;
  readonly probeFingerprint?: string;
  readonly unavailableReasons: readonly string[];
  readonly modelCatalog?: readonly AcpModelCatalogEntry[];
  /** Structural initialize-only observations can never authorize Host readiness. */
  readonly qualificationClass: "structural" | "binding_behavior";
  readonly observedArtifactVersion?: string;
  readonly observedUpstreamVersion?: string;
  /** Phase 2 reports injected/bounded qualification only; native proof is Phase 3+. */
  readonly evidenceClass: "injected_host_qualification";
}>;

export type AcpQualifiedBindingRuntime = Readonly<{
  readonly bindingHandle: string;
  readonly client: ManagedAcpV1Client;
  readonly qualification: AcpQualification;
  readonly report: AcpProviderAvailabilityReport;
  readonly reverseRpcLease?: AcpReverseRpcLease;
  assertQualified(): Promise<void>;
  releaseBinding(): Promise<void>;
  close(): Promise<void>;
}>;

export type AcpProviderOpenResult =
  | Readonly<{
      readonly available: true;
      readonly runtime: AcpQualifiedBindingRuntime;
      readonly report: AcpProviderAvailabilityReport;
    }>
  | Readonly<{
      readonly available: false;
      readonly report: AcpProviderAvailabilityReport;
    }>;

export type AcpProviderComposition = Readonly<{
  inspectModelCatalog<TProfile extends AcpPortableProfileDefinitionV3>(
    request: AcpProviderModelCatalogRequest<TProfile>,
  ): Promise<AcpProviderModelCatalogInspection>;
  checkReadiness<TProfile extends AcpPortableProfileDefinitionV3>(
    request: AcpProviderQualificationRequest<TProfile>,
  ): Promise<AcpProviderAvailabilityReport>;
  openBinding<TProfile extends AcpPortableProfileDefinitionV3>(
    request: AcpProviderQualificationRequest<TProfile>
      & Readonly<{ readonly bindingHandle: string }>,
  ): Promise<AcpProviderOpenResult>;
  close(): Promise<void>;
}>;

/**
 * Host-private hard-budget reservation emitted immediately before one real
 * qualification-side external effect. It deliberately excludes paths,
 * credentials, Binding handles, process IDs, and ACP wire identifiers.
 */
export type AcpQualificationEffect = Readonly<{
  readonly kind:
    | "credential_lease_acquisition"
    | "process_generation_start"
    | "model_prompt_submission";
  readonly profileRevisionId: string;
  readonly role: AcpQualificationRole;
}>;

export type AcpQualificationEffectBudget = (
  effect: AcpQualificationEffect,
) => undefined;

type QualificationExecution = Readonly<{
  readonly report: AcpProviderAvailabilityReport;
  readonly result?: AcpProviderOpenResult;
  readonly resolution?: LocalProfileResolution;
}>;

type CachedReadiness = Readonly<{
  readonly report: AcpProviderAvailabilityReport;
  readonly resolution?: LocalProfileResolution;
  readonly expiresAt: number;
}>;

type OwnedCredentialAcquisition = Readonly<{
  readonly lease: Promise<AcpCredentialLease>;
  cancelAndWait(): Promise<void>;
}>;

type OpenedProcessGeneration = Readonly<{
  readonly processLease: AcpAgentProcessLease;
  readonly reverseRpcLease?: AcpReverseRpcLease;
  readonly rebindReverseRpc?: (bindingHandle: string) => Promise<AcpReverseRpcLease>;
}>;

type TargetLifecycleTracker = Readonly<{
  observe(observation: AcpSessionObservation): void;
  admit(input: Readonly<{
    resolution: LocalProfileResolution;
    generation: AcpProcessGeneration;
    report: AcpProviderAvailabilityReport;
  }>): void;
  readonly checkpointObserver: AcpTargetCheckpointObserver;
  markBindingReleased(): void;
  complete(close: AcpAgentProcessCloseObservation): Readonly<{
    readonly lifecycleCapability?: AcpTargetLifecycleCapability;
    readonly checkpointFactCapabilities: readonly AcpTargetCheckpointFactCapability[];
  }>;
}>;

export function createAcpProviderComposition(options: Readonly<{
  readonly resolutions?: AcpProfileResolutionRegistry;
  readonly processes?: AcpAgentProcessFactory;
  readonly qualifications?: AcpQualificationAuthority;
  readonly reverseRpcBroker?: AcpReverseRpcBroker;
  readonly readinessTtlMs?: number;
  readonly operationTimeoutMs?: number;
  readonly now?: () => number;
  readonly createReadinessBindingHandle?: () => string;
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
  /** Host-only sink. Receiving this capability never by itself proves native release eligibility. */
  readonly onTargetLifecycleCapability?: (notice: AcpTargetLifecycleCapabilityNotice) => void;
  /** Host-only cleanup-fenced checkpoint facts; never a readiness/config projection. */
  readonly onTargetCheckpointFactCapability?: (
    notice: AcpTargetCheckpointFactCapabilityNotice,
  ) => void;
}> = {}): AcpProviderComposition {
  const resolutions = options.resolutions ?? createAcpProfileResolutionRegistry();
  const processes = options.processes ?? createAcpAgentProcessFactory();
  const qualifications = options.qualifications ?? createAcpQualificationAuthority();
  const reverseRpcBroker = options.reverseRpcBroker ?? createAcpReverseRpcBroker();
  const readinessTtlMs = boundedInteger(
    options.readinessTtlMs ?? 5_000,
    0,
    5 * 60_000,
    "acp_readiness_ttl_invalid",
  );
  const operationTimeoutMs = boundedInteger(
    options.operationTimeoutMs ?? 120_000,
    1,
    5 * 60_000,
    "acp_operation_timeout_invalid",
  );
  const now = options.now ?? Date.now;
  const createReadinessBindingHandle = options.createReadinessBindingHandle
    ?? (() => `binding_handle_readiness_${randomUUID()}`);
  if (options.onTargetLifecycleCapability !== undefined
    && typeof options.onTargetLifecycleCapability !== "function") {
    throw compositionError("acp_target_lifecycle_observer_invalid");
  }
  if (options.onTargetCheckpointFactCapability !== undefined
    && typeof options.onTargetCheckpointFactCapability !== "function") {
    throw compositionError("acp_target_checkpoint_fact_observer_invalid");
  }
  if (options.beforeQualificationEffect !== undefined
    && typeof options.beforeQualificationEffect !== "function") {
    throw compositionError("acp_qualification_effect_budget_invalid");
  }
  const cache = new Map<string, CachedReadiness>();
  const inFlight = new Map<string, Promise<AcpProviderAvailabilityReport>>();
  const planIdentities = new WeakMap<object, number>();
  const activeRuntimes = new Set<AcpQualifiedBindingRuntime>();
  const activeCredentialAcquisitions = new Set<OwnedCredentialAcquisition>();
  const credentialOwner = Object.freeze(Object.create(null));
  let nextPlanIdentity = 1;
  let closed = false;
  let poisonedCode: string | undefined;
  let closePromise: Promise<void> | undefined;

  const planIdentity = (value: object): number => {
    const existing = planIdentities.get(value);
    if (existing !== undefined) return existing;
    const identity = nextPlanIdentity;
    nextPlanIdentity += 1;
    planIdentities.set(value, identity);
    return identity;
  };

  const readinessKey = <TProfile extends AcpPortableProfileDefinitionV3>(
    request: AcpProviderQualificationRequest<TProfile>,
  ): string => digest({
    requestIdentity: planIdentity(request),
    descriptorIdentity: planIdentity(request.descriptor),
    connectionIdentity: planIdentity(request.createConnection),
    probeIdentity: planIdentity(request.runProbe),
    recoveryProbeIdentity: request.runRecoveryProbe
      ? planIdentity(request.runRecoveryProbe)
      : null,
    targetBindingIdentity: request.establishTargetBinding
      ? planIdentity(request.establishTargetBinding)
      : null,
    descriptorId: request?.descriptor?.descriptorId,
    profile: request?.profile,
    role: request?.role,
    requiredAcpCapabilities: request?.requiredAcpCapabilities,
    requiredAnyAcpCapabilities: request?.requiredAnyAcpCapabilities,
    requiredBehaviors: request?.requiredBehaviors,
  });

  return Object.freeze({
    async inspectModelCatalog(request): Promise<AcpProviderModelCatalogInspection> {
      if (closed) return unavailableModelCatalog("acp_provider_composition_closed");
      if (poisonedCode) return unavailableModelCatalog(poisonedCode);
      let processLease: AcpAgentProcessLease | undefined;
      const bindingHandle = requiredBindingHandle(
        createReadinessBindingHandle(),
        "acp_model_catalog_binding_handle_invalid",
      );
      try {
        validateModelCatalogRequest(request);
        const resolution = await withTimeout(
          resolutions.resolve(request.profile, request.descriptor),
          operationTimeoutMs,
          "acp_resolution_timeout",
        );
        if (closed) throw compositionError("acp_provider_composition_closed");
        const opened = await openProcessGeneration(
          request,
          bindingHandle,
          resolution,
          bindingHandle,
        );
        processLease = opened.processLease;
        const qualification = await withTimeout(
          processLease.client.initialize({
            protocolMajor: request.profile.protocolMajor,
            requiredCapabilities: request.requiredAcpCapabilities,
            requiredExtensions: [],
          }),
          operationTimeoutMs,
          "acp_initialize_timeout",
        );
        if (!qualification.available) {
          return unavailableModelCatalog(...qualification.unavailableReasons);
        }
        const observation = await withTimeout(
          processLease.client.inspectModelCatalog({
            bindingHandle,
            workspaceDirectory: request.workspaceDirectory,
            mcpServers: [],
          }),
          operationTimeoutMs,
          "acp_model_catalog_timeout",
        );
        return Object.freeze({
          available: true,
          modelCatalog: Object.freeze(observation.modelCatalog.map((entry) => Object.freeze({ ...entry }))),
          unavailableReasons: Object.freeze([]),
        });
      } catch (error) {
        const reason = safeErrorCode(error);
        const diagnostic = safeDiagnosticCode(error);
        return unavailableModelCatalog(
          reason,
          ...(diagnostic && diagnostic !== reason ? [diagnostic] : []),
        );
      } finally {
        if (processLease) {
          const cleanupReason = await cleanupRejected(processLease, bindingHandle, false);
          if (cleanupReason) throw compositionError(cleanupReason);
        }
      }
    },

    async checkReadiness(request): Promise<AcpProviderAvailabilityReport> {
      if (closed) return unavailableReport(request, "acp_provider_composition_closed");
      if (poisonedCode) return unavailableReport(request, poisonedCode);
      const key = readinessKey(request);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        if (!cached.resolution) return cached.report;
        try {
          await withTimeout(cached.resolution.assertCurrent(), operationTimeoutMs, "acp_resolution_timeout");
          return cached.report;
        } catch {
          cache.delete(key);
        }
      }
      const current = inFlight.get(key);
      if (current) return current;
      const pending = (async () => {
        const bindingHandle = requiredBindingHandle(
          createReadinessBindingHandle(),
          "acp_readiness_binding_handle_invalid",
        );
        const execution = await qualifyBinding(request, bindingHandle, "readiness");
        const report = execution.report;
        cache.set(key, Object.freeze({
          report,
          ...(execution.resolution ? { resolution: execution.resolution } : {}),
          expiresAt: now() + readinessTtlMs,
        }));
        return report;
      })().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
      return pending;
    },

    async openBinding(request): Promise<AcpProviderOpenResult> {
      if (closed) return Object.freeze({
        available: false,
        report: unavailableReport(request, "acp_provider_composition_closed"),
      });
      if (poisonedCode) return Object.freeze({
        available: false,
        report: unavailableReport(request, poisonedCode),
      });
      const bindingHandle = requiredBindingHandle(
        request.bindingHandle,
        "acp_binding_handle_invalid",
      );
      const execution = await qualifyBinding(request, bindingHandle, "binding");
      if (!execution.result) throw compositionError("acp_binding_qualification_result_missing");
      if (execution.result.available) activeRuntimes.add(execution.result.runtime);
      return execution.result;
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      cache.clear();
      closePromise = (async () => {
        const runtimeResults = await Promise.allSettled(
          [...activeRuntimes].map((runtime) => runtime.close()),
        );
        activeRuntimes.clear();
        const credentialOperations = [...activeCredentialAcquisitions];
        const credentialResults = await Promise.allSettled(
          credentialOperations.map((operation) => withTimeout(
            operation.cancelAndWait(),
            operationTimeoutMs,
            "acp_credential_cleanup_timeout",
          )),
        );
        for (const [index, operation] of credentialOperations.entries()) {
          if (credentialResults[index]?.status === "fulfilled") {
            activeCredentialAcquisitions.delete(operation);
          }
        }
        const ownerResults = await Promise.allSettled([
          processes.close(),
          reverseRpcBroker.close(),
        ]);
        const failure = [...runtimeResults, ...credentialResults, ...ownerResults].find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) {
          if (credentialResults.some((result) => result.status === "rejected")) {
            poisonedCode = "acp_credential_cleanup_unconfirmed";
            throw compositionError("acp_credential_cleanup_unconfirmed");
          }
          throw failure.reason;
        }
      })();
      return closePromise;
    },
  });

  async function qualifyBinding<TProfile extends AcpPortableProfileDefinitionV3>(
    request: AcpProviderQualificationRequest<TProfile>,
    bindingHandle: string,
    mode: "readiness" | "binding",
  ): Promise<QualificationExecution> {
    let resolution: LocalProfileResolution | undefined;
    let processLease: AcpAgentProcessLease | undefined;
    let reverseRpcLease: AcpReverseRpcLease | undefined;
    let rebindReverseRpc: ((bindingHandle: string) => Promise<AcpReverseRpcLease>) | undefined;
    const probeBindingHandle = mode === "binding" && request.establishTargetBinding
      ? requiredBindingHandle(
          createReadinessBindingHandle(),
          "acp_probe_binding_handle_invalid",
        )
      : bindingHandle;
    if (mode === "binding"
      && probeBindingHandle === bindingHandle
      && request.establishTargetBinding) {
      return Object.freeze({
        report: unavailableReport(request, "acp_probe_binding_handle_conflict"),
        result: Object.freeze({
          available: false,
          report: unavailableReport(request, "acp_probe_binding_handle_conflict"),
        }),
      });
    }
    let bindingEstablished = false;
    let activeBindingHandle = probeBindingHandle;
    let probeExecuted = false;
    let initializeObservation: AcpQualificationObservation | undefined;
    const targetLifecycle = mode === "binding"
      && (options.onTargetLifecycleCapability || options.onTargetCheckpointFactCapability)
      ? createTargetLifecycleTracker(request, bindingHandle)
      : undefined;
    try {
      validateRequest(request);
      resolution = await withTimeout(
        resolutions.resolve(request.profile, request.descriptor),
        operationTimeoutMs,
        "acp_resolution_timeout",
      );
      if (closed) throw compositionError("acp_provider_composition_closed");
      const opened = await openProcessGeneration(
        request,
        mode === "binding" && request.establishTargetBinding
          ? bindingHandle
          : probeBindingHandle,
        resolution,
        probeBindingHandle,
        targetLifecycle,
      );
      processLease = opened.processLease;
      reverseRpcLease = opened.reverseRpcLease;
      rebindReverseRpc = opened.rebindReverseRpc;

      initializeObservation = await withTimeout(
        processLease.client.initialize({
          protocolMajor: request.profile.protocolMajor,
          requiredCapabilities: request.requiredAcpCapabilities,
          requiredExtensions: request.profile.requiredExtensions,
        }),
        operationTimeoutMs,
        "acp_initialize_timeout",
      );

      let probe: AcpProviderProbeResult = Object.freeze({
        passedBehaviors: Object.freeze([]),
        bindingEstablished: false,
      });
      if (initializeObservation.available) {
        probeExecuted = true;
        try {
          probe = normalizeProbeResult(await withTimeout(
            request.runProbe(Object.freeze({
              profile: request.profile,
              bindingHandle: probeBindingHandle,
              client: processLease.client,
              resolution,
              ...(reverseRpcLease ? { reverseRpcLease } : {}),
            })),
            request.behaviorProbeTimeoutMs ?? operationTimeoutMs,
            "acp_behavior_probe_timeout",
          ));
          bindingEstablished = probe.bindingEstablished;
        } catch (error) {
          const report = unavailableReport(
            request,
            "acp_behavior_probe_failed",
            resolution,
            initializeObservation,
          );
          const failureCode = safeErrorCode(error);
          const diagnosticCode = safeDiagnosticCode(error);
          let diagnosticReport = report;
          for (const reason of [failureCode, diagnosticCode]) {
            if (reason && reason !== "acp_provider_qualification_failed"
              && !diagnosticReport.unavailableReasons.includes(reason)) {
              diagnosticReport = appendUnavailable(diagnosticReport, reason);
            }
          }
          const cleanupReason = await cleanupRejected(processLease, probeBindingHandle, true);
          const finalReport = cleanupReason
            ? appendUnavailable(diagnosticReport, cleanupReason)
            : diagnosticReport;
          return Object.freeze({
            report: finalReport,
            result: Object.freeze({ available: false, report: finalReport }),
            resolution,
          });
        }
      }

      if (initializeObservation.available && request.runRecoveryProbe) {
        const recoveryCapability = request.requiredAnyAcpCapabilities?.find(
          (capability) => initializeObservation?.capabilities.includes(capability),
        );
        if (recoveryCapability && bindingEstablished) {
          await withTimeout(
            processLease.close(),
            operationTimeoutMs,
            "acp_recovery_generation_close_timeout",
          );
          processLease = undefined;
          reverseRpcLease = undefined;
          let recovered: OpenedProcessGeneration;
          try {
            recovered = await openProcessGeneration(
              request,
              mode === "binding" && request.establishTargetBinding
                ? bindingHandle
                : probeBindingHandle,
              resolution,
              probeBindingHandle,
              targetLifecycle,
            );
          } catch {
            poisonedCode = "acp_probe_binding_cleanup_unconfirmed";
            throw compositionError(poisonedCode);
          }
          processLease = recovered.processLease;
          reverseRpcLease = recovered.reverseRpcLease;
          rebindReverseRpc = recovered.rebindReverseRpc;
          initializeObservation = await withTimeout(
            processLease.client.initialize({
              protocolMajor: request.profile.protocolMajor,
              requiredCapabilities: request.requiredAcpCapabilities,
              requiredExtensions: request.profile.requiredExtensions,
            }),
            operationTimeoutMs,
            "acp_initialize_timeout",
          );
          const recoveryProbe = normalizeProbeResult(await withTimeout(
            request.runRecoveryProbe(Object.freeze({
              profile: request.profile,
              bindingHandle: probeBindingHandle,
              client: processLease.client,
              resolution,
              recoveryCapability,
              ...(reverseRpcLease ? { reverseRpcLease } : {}),
            })),
            operationTimeoutMs,
            "acp_recovery_probe_timeout",
          ));
          bindingEstablished = recoveryProbe.bindingEstablished;
          probe = mergeProbeResults(probe, recoveryProbe);
        }
      }

      if (initializeObservation.available && request.requiredBehaviors.length === 0) {
        const cleanupReason = await cleanupRejected(
          processLease,
          activeBindingHandle,
          bindingEstablished || probeExecuted,
        );
        const report = unavailableReport(
          request,
          "acp_behavior_baseline_unproven",
          resolution,
          initializeObservation,
        );
        const finalReport = cleanupReason ? appendUnavailable(report, cleanupReason) : report;
        return Object.freeze({
          report: finalReport,
          result: Object.freeze({ available: false, report: finalReport }),
          resolution,
        });
      }

      const rolePolicyDigest = digest({
        role: request.role,
        capabilityPolicy: request.profile.capabilityPolicy,
        requiredExtensions: request.profile.requiredExtensions,
      });
      const qualification = await withTimeout(qualifications.issue({
        profile: request.profile,
        resolution,
        generation: processLease.generation,
        actualModel: request.profile.model,
        rolePolicyDigest,
        requiredAcpCapabilities: request.requiredAcpCapabilities,
        ...(request.requiredAnyAcpCapabilities
          ? { requiredAnyAcpCapabilities: request.requiredAnyAcpCapabilities }
          : {}),
        initializeObservation,
        probe: {
          role: request.role,
          requiredBehaviors: request.requiredBehaviors,
          passedBehaviors: probe.passedBehaviors,
          ...(probe.safeObservations ? { safeObservations: probe.safeObservations } : {}),
        },
      }), operationTimeoutMs, "acp_qualification_timeout");
      const report = availabilityReport(
        qualification.report,
        request.requiredBehaviors,
        probe.modelCatalog,
      );
      if (!qualification.available) {
        const cleanupReason = await cleanupRejected(
          processLease,
          activeBindingHandle,
          bindingEstablished || probeExecuted,
        );
        const finalReport = cleanupReason ? appendUnavailable(report, cleanupReason) : report;
        return Object.freeze({
          report: finalReport,
          result: Object.freeze({ available: false, report: finalReport }),
          resolution,
        });
      }

      if ((mode === "binding" || request.requiredBehaviors.length > 0) && !bindingEstablished) {
        const cleanupReason = await cleanupRejected(processLease, activeBindingHandle, true);
        const unavailable = appendUnavailable(report, "acp_behavior_binding_unproven");
        const finalReport = cleanupReason ? appendUnavailable(unavailable, cleanupReason) : unavailable;
        return Object.freeze({
          report: finalReport,
          result: Object.freeze({ available: false, report: finalReport }),
          resolution,
        });
      }

      if (mode === "binding" && request.establishTargetBinding) {
        try {
          await withTimeout(
            processLease.client.releaseBinding({ bindingHandle: probeBindingHandle }),
            operationTimeoutMs,
            "acp_probe_binding_cleanup_timeout",
          );
        } catch {
          const cleanupReason = await cleanupRejected(
            processLease,
            probeBindingHandle,
            true,
          );
          const unavailable = appendUnavailable(
            report,
            "acp_probe_binding_cleanup_unconfirmed",
          );
          const finalReport = cleanupReason
            ? appendUnavailable(unavailable, cleanupReason)
            : unavailable;
          poisonedCode = "acp_probe_binding_cleanup_unconfirmed";
          return Object.freeze({
            report: finalReport,
            result: Object.freeze({ available: false, report: finalReport }),
            resolution,
          });
        }
        if (request.createReverseRpcRegistration) {
          if (!rebindReverseRpc) {
            throw compositionError("acp_reverse_rpc_rebind_unavailable");
          }
          reverseRpcLease = await withTimeout(
            rebindReverseRpc(bindingHandle),
            operationTimeoutMs,
            "acp_reverse_rpc_rebind_timeout",
          );
        }
        bindingEstablished = true;
        activeBindingHandle = bindingHandle;
        const target = await withTimeout(request.establishTargetBinding(Object.freeze({
          profile: request.profile,
          bindingHandle,
          client: processLease.client,
          resolution,
          ...(reverseRpcLease ? { reverseRpcLease } : {}),
          ...(targetLifecycle ? { checkpointObserver: targetLifecycle.checkpointObserver } : {}),
        })), operationTimeoutMs, "acp_target_binding_establishment_timeout");
        if (!target
          || target.bindingEstablished !== true
          || Object.keys(target).some((key) => key !== "bindingEstablished")) {
          throw compositionError("acp_target_binding_establishment_invalid");
        }
      }

      if (mode === "readiness") {
        const cleanupReason = await cleanupRejected(
          processLease,
          activeBindingHandle,
          bindingEstablished || probeExecuted,
        );
        const finalReport = cleanupReason ? appendUnavailable(report, cleanupReason) : report;
        return Object.freeze({
          report: finalReport,
          resolution,
        });
      }

      const initialFingerprint = initializeObservation.capabilityFingerprint;
      targetLifecycle?.admit(Object.freeze({
        resolution,
        generation: processLease.generation,
        report,
      }));
      let released = false;
      let runtimeClosed = false;
      let runtimeClosePromise: Promise<void> | undefined;
      const runtime = Object.freeze({
        bindingHandle,
        client: processLease.client,
        qualification: qualification.qualification,
        report,
        ...(reverseRpcLease ? { reverseRpcLease } : {}),
        async assertQualified() {
          if (runtimeClosed) throw compositionError("acp_qualified_runtime_closed");
          const currentInitialize = await withTimeout(processLease!.client.initialize({
            protocolMajor: request.profile.protocolMajor,
            requiredCapabilities: request.requiredAcpCapabilities,
            requiredExtensions: request.profile.requiredExtensions,
          }), operationTimeoutMs, "acp_initialize_timeout");
          await withTimeout(qualifications.assertUsable(qualification.qualification, {
            profile: request.profile,
            resolution: resolution!,
            generation: processLease!.generation,
            actualModel: request.profile.model,
            rolePolicyDigest,
            initializeFingerprint: currentInitialize.capabilityFingerprint,
          }), operationTimeoutMs, "acp_qualification_assertion_timeout");
          if (currentInitialize.capabilityFingerprint !== initialFingerprint) {
            throw compositionError("acp_initialize_fingerprint_drift");
          }
        },
        async releaseBinding() {
          if (runtimeClosed) throw compositionError("acp_qualified_runtime_closed");
          if (released) return;
          await withTimeout(
            processLease!.client.releaseBinding({ bindingHandle }),
            operationTimeoutMs,
            "acp_binding_release_timeout",
          );
          released = true;
          targetLifecycle?.markBindingReleased();
        },
        close() {
          if (runtimeClosePromise) return runtimeClosePromise;
          runtimeClosed = true;
          activeRuntimes.delete(runtime);
          runtimeClosePromise = (async () => {
            try {
              await withTimeout(
                processLease!.close(),
                operationTimeoutMs,
                "acp_process_cleanup_timeout",
              );
              const closeObservation = await withTimeout(
                processLease!.closed,
                operationTimeoutMs,
                "acp_process_cleanup_timeout",
              );
              const completed = targetLifecycle?.complete(closeObservation);
              if (completed?.lifecycleCapability) {
                options.onTargetLifecycleCapability?.(Object.freeze({
                  bindingHandle,
                  capability: completed.lifecycleCapability,
                }));
              }
              for (const capability of completed?.checkpointFactCapabilities ?? []) {
                options.onTargetCheckpointFactCapability?.(Object.freeze({
                  bindingHandle,
                  capability,
                }));
              }
            } catch (error) {
              const safe = safeErrorCode(error);
              poisonedCode = safe === "acp_provider_qualification_failed"
                ? "acp_process_cleanup_unconfirmed"
                : safe;
              throw error;
            }
          })();
          runtimeClosePromise.catch(() => undefined);
          return runtimeClosePromise;
        },
      }) as AcpQualifiedBindingRuntime;
      const result = Object.freeze({ available: true, runtime, report }) as AcpProviderOpenResult;
      return Object.freeze({
        report,
        result,
        resolution,
      });
    } catch (error) {
      const reason = safeErrorCode(error);
      const diagnosticCode = safeDiagnosticCode(error);
      if (processLease) {
        const cleanupReason = await cleanupRejected(
          processLease,
          activeBindingHandle,
          bindingEstablished || probeExecuted,
        );
        let report = unavailableReport(
          request,
          cleanupReason ?? reason,
          resolution,
          initializeObservation,
        );
        if (diagnosticCode && diagnosticCode !== cleanupReason && diagnosticCode !== reason) {
          report = appendUnavailable(report, diagnosticCode);
        }
        return Object.freeze({
          report,
          result: Object.freeze({ available: false, report }),
          ...(resolution ? { resolution } : {}),
        });
      }
      let report = unavailableReport(request, reason, resolution, initializeObservation);
      if (diagnosticCode && diagnosticCode !== reason) {
        report = appendUnavailable(report, diagnosticCode);
      }
      return Object.freeze({
        report,
        result: Object.freeze({ available: false, report }),
        ...(resolution ? { resolution } : {}),
      });
    }
  }

  async function openProcessGeneration<
    TProfile extends AcpPortableProfileDefinitionV3,
  >(
    request: AcpProviderQualificationRequest<TProfile> | AcpProviderModelCatalogRequest<TProfile>,
    processBindingHandle: string,
    resolution: LocalProfileResolution,
    initialReverseRpcBindingHandle: string,
    targetLifecycle?: TargetLifecycleTracker,
  ): Promise<OpenedProcessGeneration> {
    const acquiredCredential = request.beginCredentialAcquisition
      ? await (async () => {
          reserveQualificationEffect(options.beforeQualificationEffect, Object.freeze({
            kind: "credential_lease_acquisition" as const,
            profileRevisionId: request.profile.profileRevisionId,
            role: request.role,
          }));
          return acquireCredentialOwned(
            () => request.beginCredentialAcquisition!(Object.freeze({
              bindingHandle: processBindingHandle,
            })),
            operationTimeoutMs,
            (code) => { poisonedCode = code; },
            activeCredentialAcquisitions,
          );
        })()
      : undefined;
    if (closed && acquiredCredential) {
      try {
        await withTimeout(
          acquiredCredential.operation.cancelAndWait(),
          operationTimeoutMs,
          "acp_credential_cleanup_timeout",
        );
        activeCredentialAcquisitions.delete(acquiredCredential.operation);
      } catch {
        poisonedCode = "acp_credential_cleanup_unconfirmed";
        throw compositionError(poisonedCode);
      }
      throw compositionError("acp_provider_composition_closed");
    }
    let reverseRpcLease: AcpReverseRpcLease | undefined;
    let reverseRpcHandlers: AcpV1ReverseRpcHandlers | undefined;
    let reverseRpcGeneration: AcpProcessGeneration | undefined;
    let reverseRpcHandlerKeys: readonly ReverseRpcHandlerKey[] | undefined;
    let processOpen: ReturnType<AcpAgentProcessFactory["beginOpen"]>;
    try {
      if (acquiredCredential) {
        claimCredentialProvenance(
          acquiredCredential.credential,
          credentialOwner,
          request.profile.profileRevisionId,
          request.role,
          processBindingHandle,
        );
      }
      const originalObservation = request.managedClientOptions?.onObservation;
      const originalBeforePromptEffect = request.managedClientOptions?.beforePromptEffect;
      const managedClientOptions = Object.freeze({
        ...request.managedClientOptions,
        ...((options.beforeQualificationEffect || originalBeforePromptEffect) ? {
          beforePromptEffect: () => {
            reserveQualificationEffect(options.beforeQualificationEffect, Object.freeze({
              kind: "model_prompt_submission" as const,
              profileRevisionId: request.profile.profileRevisionId,
              role: request.role,
            }));
            originalBeforePromptEffect?.();
            return undefined;
          },
        } : {}),
        ...((targetLifecycle || originalObservation) ? {
          onObservation: async (observation: AcpSessionObservation) => {
            targetLifecycle?.observe(observation);
            await originalObservation?.(observation);
          },
        } : {}),
      });
      reserveQualificationEffect(options.beforeQualificationEffect, Object.freeze({
        kind: "process_generation_start" as const,
        profileRevisionId: request.profile.profileRevisionId,
        role: request.role,
      }));
      processOpen = processes.beginOpen({
        bindingHandle: processBindingHandle,
        resolution,
        ...(request.workspaceDirectory
          ? { workspaceDirectory: request.workspaceDirectory }
          : {}),
        ...(acquiredCredential ? { credentialLease: acquiredCredential.credential } : {}),
        createConnection: request.createConnection,
        managedClientOptions: {
          ...managedClientOptions,
          ...(request.descriptor.extensionPredicates
            ? { extensionPredicates: request.descriptor.extensionPredicates }
            : {}),
        },
        ...("createReverseRpcRegistration" in request && request.createReverseRpcRegistration ? {
          prepareReverseRpc: (generation) => {
            const registered = registerReverseRpcLease(
              request as AcpProviderQualificationRequest<TProfile>,
              initialReverseRpcBindingHandle,
              generation,
            );
            reverseRpcLease = registered;
            reverseRpcHandlers = registered.reverseRpcHandlers();
            reverseRpcGeneration = generation;
            reverseRpcHandlerKeys = exactReverseRpcHandlerKeys(reverseRpcHandlers);
            return Object.freeze({
              handlers: delegatingReverseRpcHandlers(
                reverseRpcHandlerKeys,
                () => reverseRpcHandlers,
              ),
              async close() {
                reverseRpcHandlers = undefined;
                await reverseRpcLease?.close();
              },
            });
          },
        } : {}),
      });
      if (acquiredCredential) {
        activeCredentialAcquisitions.delete(acquiredCredential.operation);
      }
    } catch (error) {
      if (acquiredCredential) {
        try {
          await withTimeout(
            acquiredCredential.operation.cancelAndWait(),
            operationTimeoutMs,
            "acp_credential_cleanup_timeout",
          );
          activeCredentialAcquisitions.delete(acquiredCredential.operation);
        } catch {
          poisonedCode = "acp_credential_cleanup_unconfirmed";
          throw compositionError(poisonedCode);
        }
      }
      throw error;
    }
    processOpen.lease.then(undefined, () => undefined);
    let processLease: AcpAgentProcessLease;
    try {
      processLease = await withTimeout(
        processOpen.lease,
        operationTimeoutMs,
        "acp_process_open_timeout",
      );
    } catch (error) {
      try {
        const cleanup = await withTimeout(
          processOpen.cancelAndWait(),
          operationTimeoutMs,
          "acp_process_open_cleanup_timeout",
        );
        if (!cleanup.processCleanupConfirmed
          || !cleanup.credentialCleanupConfirmed
          || !cleanup.capabilityCleanupConfirmed) {
          throw compositionError("acp_process_open_cleanup_unconfirmed");
        }
      } catch {
        poisonedCode = "acp_process_open_cleanup_unconfirmed";
        throw compositionError(poisonedCode);
      }
      throw error;
    }
    if (acquiredCredential) {
      bindCredentialGeneration(
        acquiredCredential.credential,
        credentialOwner,
        request.profile.profileRevisionId,
        request.role,
        processBindingHandle,
        processLease.generation,
      );
    }
    return Object.freeze({
      processLease,
      ...(reverseRpcLease ? { reverseRpcLease } : {}),
      ...("createReverseRpcRegistration" in request && request.createReverseRpcRegistration ? {
        async rebindReverseRpc(targetBindingHandle: string) {
          const bindingHandle = requiredBindingHandle(
            targetBindingHandle,
            "acp_reverse_rpc_rebind_binding_invalid",
          );
          if (!reverseRpcLease || !reverseRpcGeneration || !reverseRpcHandlerKeys) {
            throw compositionError("acp_reverse_rpc_rebind_unavailable");
          }
          reverseRpcHandlers = undefined;
          await reverseRpcLease.close();
          const registered = registerReverseRpcLease(
            request as AcpProviderQualificationRequest<TProfile>,
            bindingHandle,
            reverseRpcGeneration,
          );
          const handlers = registered.reverseRpcHandlers();
          const nextKeys = exactReverseRpcHandlerKeys(handlers);
          if (!sameStrings(reverseRpcHandlerKeys, nextKeys)) {
            await registered.close().catch(() => undefined);
            throw compositionError("acp_reverse_rpc_rebind_capability_drift");
          }
          reverseRpcLease = registered;
          reverseRpcHandlers = handlers;
          return registered;
        },
      } : {}),
    });
  }

  function registerReverseRpcLease<TProfile extends AcpPortableProfileDefinitionV3>(
    request: AcpProviderQualificationRequest<TProfile>,
    bindingHandle: string,
    generation: AcpProcessGeneration,
  ): AcpReverseRpcLease {
    const registration = request.createReverseRpcRegistration;
    if (!registration) throw compositionError("acp_reverse_rpc_registration_missing");
    return reverseRpcBroker.register({
      ...registration(),
      bindingHandle,
      generation,
    });
  }

  async function cleanupRejected(
    processLease: AcpAgentProcessLease,
    bindingHandle: string,
    bindingEstablished: boolean,
  ): Promise<string | undefined> {
    let bindingReason: string | undefined;
    if (bindingEstablished) {
      try {
        await withTimeout(
          processLease.client.releaseBinding({ bindingHandle }),
          operationTimeoutMs,
          "acp_probe_binding_cleanup_timeout",
        );
      } catch (error) {
        if (safeErrorCode(error) !== "acp_binding_not_mapped") {
          bindingReason = "acp_probe_binding_cleanup_unconfirmed";
        }
      }
    }
    let processReason: string | undefined;
    try {
      await withTimeout(
        processLease.close(),
        operationTimeoutMs,
        "acp_process_cleanup_timeout",
      );
    } catch (error) {
      const safe = safeErrorCode(error);
      processReason = safe === "acp_provider_qualification_failed"
        ? "acp_process_cleanup_unconfirmed"
        : safe;
    }
    // Process/credential authority still alive outranks a leaked Binding map.
    // Either cleanup ambiguity poisons the owner so no later qualification can
    // reuse an uncertain process, raw-id map, or credential generation.
    const reason = processReason ?? bindingReason;
    if (reason) poisonedCode = reason;
    return reason;
  }
}

function createTargetLifecycleTracker<TProfile extends AcpPortableProfileDefinitionV3>(
  request: AcpProviderQualificationRequest<TProfile>,
  targetBindingHandle: string,
): TargetLifecycleTracker {
  type AttemptFacts = {
    receiptObserved: boolean;
    finalObserved: boolean;
    terminalObserved: boolean;
  };
  const attempts = new Map<string, AttemptFacts>();
  const scopedCallAttempts = new Map<string, Set<string>>();
  const cancelledAttempts = new Set<string>();
  const reconciledAttempts = new Set<string>();
  const strictMetaFinalAttempts = new Set<string>();
  let recoveryOpened: "load" | "resume" | undefined;
  let metaIsolationObserved = false;
  let metaTemplateDraftToolsAvailable = false;
  let metaPermissionRejected = false;
  let metaColdReconcileObserved = false;
  let targetToolObserved = false;
  let admitted: Readonly<{
    resolution: LocalProfileResolution;
    generation: AcpProcessGeneration;
    report: AcpProviderAvailabilityReport;
    processGenerationDigest: string;
  }> | undefined;
  let bindingReleaseConfirmed = false;
  let completed = false;

  const checkpointObserver: AcpTargetCheckpointObserver = Object.freeze({
    observe(event) {
      if (completed || !event || typeof event !== "object" || Array.isArray(event)
        || event.bindingHandle !== targetBindingHandle || event.role !== request.role) {
        throw compositionError("acp_target_checkpoint_event_scope_mismatch");
      }
      switch (event.kind) {
        case "task_scoped_mcp_call": {
          requireCheckpointEventKeys(event, ["kind", "bindingHandle", "attemptId", "role", "toolName"]);
          if ((request.role !== "conductor" && request.role !== "publisher")
            || !isCheckpointAttemptId(event.attemptId)
            || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(event.toolName)) {
            throw compositionError("acp_target_checkpoint_event_invalid");
          }
          const names = scopedCallAttempts.get(event.attemptId) ?? new Set<string>();
          names.add(event.toolName);
          scopedCallAttempts.set(event.attemptId, names);
          return;
        }
        case "task_cancel_accepted":
        case "task_reconcile_settled":
          requireCheckpointEventKeys(event, ["kind", "bindingHandle", "attemptId", "role"]);
          if (request.role === "meta" || !isCheckpointAttemptId(event.attemptId)) {
            throw compositionError("acp_target_checkpoint_event_invalid");
          }
          (event.kind === "task_cancel_accepted" ? cancelledAttempts : reconciledAttempts)
            .add(event.attemptId);
          return;
        case "task_recovery_opened":
          requireCheckpointEventKeys(event, [
            "kind", "bindingHandle", "role", "disposition", "oldPromptReplayCount",
          ]);
          if (request.role === "meta"
            || (event.disposition !== "load" && event.disposition !== "resume")
            || event.oldPromptReplayCount !== 0) {
            throw compositionError("acp_target_checkpoint_event_invalid");
          }
          recoveryOpened = event.disposition;
          return;
        case "meta_isolation_opened":
          requireCheckpointEventKeys(event, [
            "kind", "bindingHandle", "role", "privateDirectoryLeaseConfirmed",
            "toolCapabilityClass", "toolSurfaceCount", "callerCwdPresent", "taskWorkspacePresent",
          ]);
          if (request.role !== "meta"
            || event.privateDirectoryLeaseConfirmed !== true
            || event.toolCapabilityClass !== "template_draft"
            || !Number.isSafeInteger(event.toolSurfaceCount)
            || event.toolSurfaceCount < 1
            || event.toolSurfaceCount > 64
            || event.callerCwdPresent !== false
            || event.taskWorkspacePresent !== false) {
            throw compositionError("acp_target_checkpoint_event_invalid");
          }
          metaIsolationObserved = true;
          metaTemplateDraftToolsAvailable = true;
          return;
        case "meta_strict_whole_final":
        case "meta_permission_rejected":
          requireCheckpointEventKeys(event, ["kind", "bindingHandle", "attemptId", "role"]);
          if (request.role !== "meta" || !isCheckpointAttemptId(event.attemptId)) {
            throw compositionError("acp_target_checkpoint_event_invalid");
          }
          if (event.kind === "meta_strict_whole_final") strictMetaFinalAttempts.add(event.attemptId);
          else metaPermissionRejected = true;
          return;
        case "meta_cold_reconcile_no_resend":
          requireCheckpointEventKeys(event, [
            "kind", "bindingHandle", "role", "disposition", "promptEffectDelta",
          ]);
          if (request.role !== "meta" || event.disposition !== "resume"
            || event.promptEffectDelta !== 0) {
            throw compositionError("acp_target_checkpoint_event_invalid");
          }
          metaColdReconcileObserved = true;
          return;
      }
    },
  });

  return Object.freeze({
    observe(observation) {
      if (!admitted || completed || observation.bindingHandle !== targetBindingHandle) return;
      if (observation.kind === "tool_status") targetToolObserved = true;
      if (observation.kind !== "delivery_receipt"
        && observation.kind !== "final_candidate"
        && observation.kind !== "prompt_terminal") return;
      const facts = attempts.get(observation.attemptId) ?? {
        receiptObserved: false,
        finalObserved: false,
        terminalObserved: false,
      };
      if (observation.kind === "delivery_receipt") facts.receiptObserved = true;
      if (observation.kind === "final_candidate") facts.finalObserved = true;
      if (observation.kind === "prompt_terminal") facts.terminalObserved = true;
      attempts.set(observation.attemptId, facts);
    },
    checkpointObserver,
    admit(input) {
      if (admitted || completed
        || !input.report.available
        || input.report.qualificationClass !== "binding_behavior"
        || input.report.protocolMajor === null
        || !input.report.capabilityFingerprint
        || !/^sha256:[a-f0-9]{64}$/u.test(input.report.capabilityFingerprint)
        || !input.report.probeFingerprint
        || !/^sha256:[a-f0-9]{64}$/u.test(input.report.probeFingerprint)
        || !input.generation.isActive()) {
        throw compositionError("acp_target_lifecycle_admission_invalid");
      }
      const material = input.resolution.hostPrivateLaunchMaterial();
      admitted = Object.freeze({
        resolution: input.resolution,
        generation: input.generation,
        report: input.report,
        processGenerationDigest: digest({
          nonce: randomUUID(),
          profileRevisionId: request.profile.profileRevisionId,
          resolutionSealDigest: material.sealFingerprint,
          model: request.profile.model,
          role: request.role,
        }),
      });
    },
    markBindingReleased() {
      bindingReleaseConfirmed = true;
    },
    complete(close) {
      const empty = Object.freeze({ checkpointFactCapabilities: Object.freeze([]) });
      if (completed) return empty;
      completed = true;
      if (!admitted
        || !bindingReleaseConfirmed
        || admitted.generation.isActive()
        || close.exitConfirmed !== true
        || close.credentialCleanupConfirmed !== true
        || close.capabilityCleanupConfirmed !== true
        || close.observation.bindingHandle !== targetBindingHandle) return empty;
      const prompt = [...attempts.entries()].find(([, facts]) => (
        facts.receiptObserved && facts.finalObserved && facts.terminalObserved
      ));
      if (!prompt) return empty;
      const [attemptId] = prompt;
      const report = admitted.report;
      const resolution = admitted.resolution.hostPrivateLaunchMaterial();
      const lifecycleDigest = digest({
        nonce: randomUUID(),
        profileRevisionId: request.profile.profileRevisionId,
        processGenerationDigest: admitted.processGenerationDigest,
        receiptObserved: true,
        finalObserved: true,
        terminalObserved: true,
      });
      const cleanupReceiptDigest = digest({
        nonce: randomUUID(),
        lifecycleDigest,
        bindingReleaseConfirmed: true,
        processExitConfirmed: true,
        credentialCleanupConfirmed: true,
        capabilityCleanupConfirmed: true,
      });
      const observation: AcpTargetLifecycleObservation = Object.freeze({
        schemaVersion: 1 as const,
        evidenceClass: "host_target_lifecycle_observation" as const,
        profileRevisionId: request.profile.profileRevisionId,
        providerFamily: request.profile.providerFamily,
        acpAgentKind: request.profile.acpAgentKind,
        role: request.role,
        model: request.profile.model,
        profileConfigurationDigest: digest({
          model: request.profile.model,
          configIntent: request.profile.configIntent,
          requiredExtensions: request.profile.requiredExtensions,
          capabilityPolicy: request.profile.capabilityPolicy,
        }),
        resolutionSealDigest: resolution.sealFingerprint,
        observedArtifactVersion: resolution.observedArtifactVersion,
        ...(resolution.observedUpstreamVersion
          ? { observedUpstreamVersion: resolution.observedUpstreamVersion }
          : {}),
        processGenerationDigest: admitted.processGenerationDigest,
        initialize: Object.freeze({
          protocolMajor: report.protocolMajor!,
          ...(report.agent ? { agent: Object.freeze({ ...report.agent }) } : {}),
          capabilities: Object.freeze([...report.capabilities]),
          extensions: Object.freeze([...report.extensions]),
          capabilityFingerprint: report.capabilityFingerprint!,
        }),
        qualificationProbeDigest: report.probeFingerprint!,
        actualPrompt: Object.freeze({
          receiptObserved: true as const,
          finalObserved: true as const,
          terminalObserved: true as const,
          attemptCorrelationDigest: digest({ attemptId }),
          lifecycleDigest,
        }),
        cleanup: Object.freeze({
          bindingReleaseConfirmed: true as const,
          processExitConfirmed: true as const,
          credentialCleanupConfirmed: true as const,
          capabilityCleanupConfirmed: true as const,
          receiptDigest: cleanupReceiptDigest,
        }),
      });
      const capability = Object.freeze(Object.create(null)) as AcpTargetLifecycleCapability;
      TARGET_LIFECYCLE_CAPABILITIES.set(capability as object, { observation, claimed: false });
      const facts: Array<Readonly<{
        kind: AcpTargetCheckpointFactKind;
        evidence: Readonly<Record<string, unknown>>;
      }>> = [];
      if (request.role === "meta") {
        facts.push({ kind: "independent_process", evidence: Object.freeze({ lifecycleDigest }) });
        if (metaIsolationObserved && !metaTemplateDraftToolsAvailable && !targetToolObserved) {
          facts.push({ kind: "no_tools", evidence: Object.freeze({ lifecycleDigest }) });
        }
        if (metaIsolationObserved) {
          facts.push(
            { kind: "no_cwd", evidence: Object.freeze({ lifecycleDigest }) },
            { kind: "no_workspace", evidence: Object.freeze({ lifecycleDigest }) },
          );
        }
        if (strictMetaFinalAttempts.has(attemptId)) {
          facts.push({ kind: "strict_whole_final", evidence: Object.freeze({ attemptId }) });
        }
        if (metaPermissionRejected) {
          facts.push({ kind: "permission_rejected", evidence: Object.freeze({ lifecycleDigest }) });
        }
        if (metaColdReconcileObserved) {
          facts.push({ kind: "cold_reconcile", evidence: Object.freeze({ lifecycleDigest }) });
        }
      } else {
        facts.push(
          { kind: "actual_binding_generation", evidence: Object.freeze({ lifecycleDigest }) },
          { kind: "prompt_receipt", evidence: Object.freeze({ attemptId }) },
          { kind: "latest_final_terminal_pair", evidence: Object.freeze({ attemptId }) },
        );
        if (scopedCallAttempts.has(attemptId)) {
          facts.push({
            kind: "scoped_mcp_call",
            evidence: Object.freeze({
              attemptId,
              toolNames: Object.freeze([...(scopedCallAttempts.get(attemptId) ?? [])].sort()),
            }),
          });
        }
        const cancelReconcileAttempt = [...cancelledAttempts]
          .find((candidate) => reconciledAttempts.has(candidate));
        if (cancelReconcileAttempt) {
          facts.push({
            kind: "cancel_reconcile",
            evidence: Object.freeze({ attemptId: cancelReconcileAttempt }),
          });
        }
        if (recoveryOpened) {
          facts.push({
            kind: "restart_load_resume",
            evidence: Object.freeze({ disposition: recoveryOpened }),
          });
        }
      }
      const checkpointFactCapabilities = Object.freeze(facts.map(({ kind, evidence }) => {
        const factObservation: AcpTargetCheckpointFactObservation = Object.freeze({
          schemaVersion: 1 as const,
          evidenceClass: "host_target_checkpoint_fact" as const,
          kind,
          profileRevisionId: observation.profileRevisionId,
          providerFamily: observation.providerFamily,
          acpAgentKind: observation.acpAgentKind,
          role: observation.role,
          model: observation.model,
          profileConfigurationDigest: observation.profileConfigurationDigest,
          resolutionSealDigest: observation.resolutionSealDigest,
          processGenerationDigest: observation.processGenerationDigest,
          observationDigest: digest({
            nonce: randomUUID(),
            kind,
            profileRevisionId: observation.profileRevisionId,
            processGenerationDigest: observation.processGenerationDigest,
            evidenceDigest: digest(evidence),
            cleanupReceiptDigest,
          }),
        });
        const factCapability = Object.freeze(Object.create(null)) as AcpTargetCheckpointFactCapability;
        TARGET_CHECKPOINT_FACT_CAPABILITIES.set(factCapability as object, {
          observation: factObservation,
          claimed: { value: false },
        });
        return factCapability;
      }));
      return Object.freeze({ lifecycleCapability: capability, checkpointFactCapabilities });
    },
  });
}

function requireCheckpointEventKeys(
  event: AcpTargetCheckpointEvent,
  keys: readonly string[],
): void {
  const actual = Object.keys(event).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw compositionError("acp_target_checkpoint_event_invalid");
  }
}

function isCheckpointAttemptId(value: unknown): value is string {
  return typeof value === "string"
    && /^session_execution_attempt_[A-Za-z0-9_-]{1,223}$/u.test(value);
}

function exactReverseRpcHandlerKeys(
  handlers: AcpV1ReverseRpcHandlers,
): readonly ReverseRpcHandlerKey[] {
  const keys = Object.keys(handlers).sort();
  if (keys.some((key) => !REVERSE_RPC_HANDLER_KEYS.includes(key as ReverseRpcHandlerKey))
    || keys.some((key) => typeof handlers[key as ReverseRpcHandlerKey] !== "function")) {
    throw compositionError("acp_reverse_rpc_handlers_invalid");
  }
  return Object.freeze(keys as ReverseRpcHandlerKey[]);
}

function delegatingReverseRpcHandlers(
  keys: readonly ReverseRpcHandlerKey[],
  current: () => AcpV1ReverseRpcHandlers | undefined,
): AcpV1ReverseRpcHandlers {
  const delegates: Partial<Record<ReverseRpcHandlerKey, (params: unknown) => Promise<unknown>>> = {};
  for (const key of keys) {
    delegates[key] = async (params: unknown) => {
      const handler = current()?.[key];
      if (typeof handler !== "function") {
        throw compositionError("acp_reverse_rpc_rebinding");
      }
      return handler(params);
    };
  }
  return Object.freeze(delegates);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function availabilityReport(
  report: AcpQualificationSafeReport,
  requiredBehaviors: readonly string[],
  modelCatalog?: readonly AcpModelCatalogEntry[],
): AcpProviderAvailabilityReport {
  return Object.freeze({
    ...report,
    ...(modelCatalog ? { modelCatalog } : {}),
    qualificationClass: requiredBehaviors.length === 0 ? "structural" : "binding_behavior",
    evidenceClass: "injected_host_qualification",
  });
}

function unavailableReport<TProfile extends AcpPortableProfileDefinitionV3>(
  request: AcpProviderQualificationRequest<TProfile>,
  reason: string,
  resolution?: LocalProfileResolution,
  initialize?: AcpQualificationObservation,
): AcpProviderAvailabilityReport {
  const safeResolution = resolution?.safeObservation();
  const safeAgent = projectSafeAcpAgentObservation(initialize?.agent);
  return Object.freeze({
    profileRevisionId: request?.profile?.profileRevisionId ?? "profile_revision_unavailable",
    providerFamily: request?.profile?.providerFamily ?? "opencode",
    acpAgentKind: request?.profile?.acpAgentKind ?? "native_acp",
    role: request?.role ?? "worker",
    available: false,
    protocolMajor: initialize?.protocolMajor ?? null,
    ...(safeAgent ? { agent: safeAgent } : {}),
    capabilities: Object.freeze([...(initialize?.capabilities ?? [])]),
    extensions: Object.freeze([...(initialize?.extensions ?? [])]),
    ...(initialize?.capabilityFingerprint
      ? { capabilityFingerprint: initialize.capabilityFingerprint }
      : {}),
    unavailableReasons: Object.freeze([safeReason(reason)]),
    qualificationClass: request?.requiredBehaviors?.length > 0
      ? "binding_behavior"
      : "structural",
    ...(safeResolution ? {
      observedArtifactVersion: safeResolution.observedArtifactVersion,
      ...(safeResolution.observedUpstreamVersion
        ? { observedUpstreamVersion: safeResolution.observedUpstreamVersion }
        : {}),
    } : {}),
    evidenceClass: "injected_host_qualification",
  });
}

function unavailableModelCatalog(...reasons: readonly string[]): AcpProviderModelCatalogInspection {
  const normalized = [...new Set(
    (reasons.length > 0 ? reasons : ["acp_model_catalog_unavailable"]).map(safeReason),
  )];
  return Object.freeze({
    available: false,
    modelCatalog: Object.freeze([]),
    unavailableReasons: Object.freeze(normalized),
  });
}

function validateModelCatalogRequest<TProfile extends AcpPortableProfileDefinitionV3>(
  request: AcpProviderModelCatalogRequest<TProfile>,
): void {
  const allowedKeys = new Set([
    "beginCredentialAcquisition",
    "createConnection",
    "descriptor",
    "managedClientOptions",
    "profile",
    "requiredAcpCapabilities",
    "role",
    "workspaceDirectory",
  ]);
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).some((key) => !allowedKeys.has(key))
    || !request.profile || request.profile.protocolMajor !== 1
    || !request.descriptor || typeof request.descriptor.discoverCurrent !== "function"
    || typeof request.createConnection !== "function"
    || typeof request.workspaceDirectory !== "string" || !request.workspaceDirectory
    || !Array.isArray(request.requiredAcpCapabilities)
    || request.requiredAcpCapabilities.length === 0
    || (request.beginCredentialAcquisition !== undefined
      && typeof request.beginCredentialAcquisition !== "function")) {
    throw compositionError("acp_provider_model_catalog_request_invalid");
  }
}

function appendUnavailable(
  report: AcpProviderAvailabilityReport,
  reason: string,
): AcpProviderAvailabilityReport {
  return Object.freeze({
    ...report,
    available: false,
    unavailableReasons: Object.freeze([
      ...report.unavailableReasons,
      ...(!report.unavailableReasons.includes(safeReason(reason)) ? [safeReason(reason)] : []),
    ]),
  });
}

function validateRequest<TProfile extends AcpPortableProfileDefinitionV3>(
  request: AcpProviderQualificationRequest<TProfile>,
): void {
  const allowedKeys = new Set([
    "bindingHandle",
    "profile",
    "descriptor",
    "role",
    "requiredAcpCapabilities",
    "requiredAnyAcpCapabilities",
    "requiredBehaviors",
    "workspaceDirectory",
    "createConnection",
    "beginCredentialAcquisition",
    "managedClientOptions",
    "createReverseRpcRegistration",
    "behaviorProbeTimeoutMs",
    "runProbe",
    "runRecoveryProbe",
    "establishTargetBinding",
  ]);
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).some((key) => !allowedKeys.has(key))) {
    throw compositionError("acp_provider_qualification_request_invalid");
  }
  if (!request?.profile || request.profile.protocolMajor !== 1) {
    throw compositionError("acp_profile_invalid");
  }
  if (!request.descriptor || typeof request.descriptor.discoverCurrent !== "function") {
    throw compositionError("acp_resolution_descriptor_invalid");
  }
  if (typeof request.createConnection !== "function" || typeof request.runProbe !== "function") {
    throw compositionError("acp_provider_qualification_request_invalid");
  }
  if (request.beginCredentialAcquisition !== undefined
    && typeof request.beginCredentialAcquisition !== "function") {
    throw compositionError("acp_credential_acquisition_invalid");
  }
  if (!Array.isArray(request.requiredAcpCapabilities) || !Array.isArray(request.requiredBehaviors)) {
    throw compositionError("acp_provider_qualification_request_invalid");
  }
  const hasRecoveryCapabilities = Array.isArray(request.requiredAnyAcpCapabilities)
    && request.requiredAnyAcpCapabilities.length > 0;
  if ((request.requiredAnyAcpCapabilities !== undefined && !hasRecoveryCapabilities)
    || hasRecoveryCapabilities !== (typeof request.runRecoveryProbe === "function")) {
    throw compositionError("acp_provider_recovery_probe_invalid");
  }
  if (request.establishTargetBinding !== undefined
    && typeof request.establishTargetBinding !== "function") {
    throw compositionError("acp_target_binding_establishment_invalid");
  }
  if (request.behaviorProbeTimeoutMs !== undefined) {
    boundedInteger(
      request.behaviorProbeTimeoutMs,
      1,
      10 * 60_000,
      "acp_behavior_probe_timeout_invalid",
    );
  }
}

function normalizeProbeResult(result: AcpProviderProbeResult): AcpProviderProbeResult {
  if (!result || typeof result !== "object" || Array.isArray(result)
    || !Array.isArray(result.passedBehaviors)
    || typeof result.bindingEstablished !== "boolean") {
    throw compositionError("acp_behavior_probe_result_invalid");
  }
  const allowed = new Set([
    "passedBehaviors",
    "modelCatalog",
    "safeObservations",
    "bindingEstablished",
  ]);
  if (Object.keys(result).some((key) => !allowed.has(key))) {
    throw compositionError("acp_behavior_probe_result_invalid");
  }
  return Object.freeze({
    passedBehaviors: Object.freeze([...result.passedBehaviors]),
    ...(result.modelCatalog ? { modelCatalog: normalizeModelCatalog(result.modelCatalog) } : {}),
    ...(result.safeObservations ? { safeObservations: Object.freeze({ ...result.safeObservations }) } : {}),
    bindingEstablished: result.bindingEstablished,
  });
}

function mergeProbeResults(
  initial: AcpProviderProbeResult,
  recovery: AcpProviderProbeResult,
): AcpProviderProbeResult {
  const initialCatalog = initial.modelCatalog;
  const recoveryCatalog = recovery.modelCatalog;
  if (initialCatalog && recoveryCatalog
    && JSON.stringify(initialCatalog) !== JSON.stringify(recoveryCatalog)) {
    throw compositionError("acp_model_catalog_recovery_drift");
  }
  return Object.freeze({
    passedBehaviors: Object.freeze([
      ...new Set([...initial.passedBehaviors, ...recovery.passedBehaviors]),
    ]),
    ...((recoveryCatalog ?? initialCatalog)
      ? { modelCatalog: recoveryCatalog ?? initialCatalog }
      : {}),
    safeObservations: Object.freeze({
      ...(initial.safeObservations ?? {}),
      ...(recovery.safeObservations ?? {}),
    }),
    bindingEstablished: recovery.bindingEstablished,
  });
}

function normalizeModelCatalog(value: readonly AcpModelCatalogEntry[]): readonly AcpModelCatalogEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw compositionError("acp_model_catalog_invalid");
  }
  const result = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, "modelId")
      || !Object.hasOwn(entry, "label")
      || typeof entry.modelId !== "string"
      || !entry.modelId
      || entry.modelId.startsWith("/")
      || entry.modelId.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(entry.modelId)
      || typeof entry.label !== "string"
      || !entry.label.trim()
      || entry.label.length > 160
      || /[\u0000-\u001f\u007f]/u.test(entry.label)) {
      throw compositionError("acp_model_catalog_invalid");
    }
    return Object.freeze({ modelId: entry.modelId, label: entry.label.trim() });
  });
  if (new Set(result.map(({ modelId }) => modelId)).size !== result.length) {
    throw compositionError("acp_model_catalog_invalid");
  }
  return Object.freeze(result.sort((left, right) => left.modelId.localeCompare(right.modelId)
    || left.label.localeCompare(right.label)));
}

function reserveQualificationEffect(
  budget: AcpQualificationEffectBudget | undefined,
  effect: AcpQualificationEffect,
): void {
  if (!budget) return;
  const result: unknown = (budget as (value: AcpQualificationEffect) => unknown)(effect);
  if (result === undefined) return;
  if (result && (typeof result === "object" || typeof result === "function")
    && typeof (result as { then?: unknown }).then === "function") {
    void Promise.resolve(result).catch(() => undefined);
  }
  throw compositionError("acp_qualification_effect_budget_async_forbidden");
}

async function acquireCredentialOwned(
  begin: () => AcpCredentialAcquisitionOperation,
  timeoutMs: number,
  poison: (code: string) => void,
  active: Set<OwnedCredentialAcquisition>,
): Promise<Readonly<{
  readonly credential: AcpCredentialLease;
  readonly operation: OwnedCredentialAcquisition;
}>> {
  let operation: AcpCredentialAcquisitionOperation;
  try {
    operation = begin();
  } catch {
    poison("acp_credential_cleanup_unconfirmed");
    throw compositionError("acp_credential_cleanup_unconfirmed");
  }
  if (!operation || typeof operation !== "object"
    || !operation.lease || typeof operation.lease.then !== "function"
    || typeof operation.cancelAndWait !== "function"
    || Object.keys(operation).some((key) => (
      key !== "lease" && key !== "cancelAndWait"
    ))) {
    poison("acp_credential_cleanup_unconfirmed");
    throw compositionError("acp_credential_cleanup_unconfirmed");
  }
  let cancellation: Promise<void> | undefined;
  const owned: OwnedCredentialAcquisition = Object.freeze({
    lease: operation.lease,
    cancelAndWait() {
      cancellation ??= Promise.resolve().then(() => operation.cancelAndWait()).then((cleanup) => {
        if (!cleanup
          || typeof cleanup !== "object"
          || Array.isArray(cleanup)
          || cleanup.credentialCleanupConfirmed !== true
          || Object.keys(cleanup).some((key) => key !== "credentialCleanupConfirmed")) {
          throw compositionError("acp_credential_cleanup_unconfirmed");
        }
      });
      cancellation.catch(() => undefined);
      return cancellation;
    },
  });
  active.add(owned);
  owned.lease.catch(() => undefined);
  try {
    const credential = await withTimeout(
      owned.lease,
      timeoutMs,
      "acp_credential_acquisition_timeout",
    );
    return Object.freeze({ credential, operation: owned });
  } catch (error) {
    try {
      await withTimeout(
        owned.cancelAndWait(),
        timeoutMs,
        "acp_credential_cleanup_timeout",
      );
      active.delete(owned);
    } catch {
      poison("acp_credential_cleanup_unconfirmed");
      throw compositionError("acp_credential_cleanup_unconfirmed");
    }
    throw error;
  }
}

function claimCredentialProvenance(
  credential: AcpCredentialLease,
  owner: object,
  profileRevisionId: string,
  role: AcpQualificationRole,
  bindingHandle: string,
): void {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    throw compositionError("acp_credential_provenance_invalid");
  }
  if (Object.keys(credential).some((key) => key !== "environment" && key !== "revoke")) {
    throw compositionError("acp_credential_provenance_invalid");
  }
  if (CREDENTIAL_PROVENANCE.has(credential)) {
    throw compositionError("acp_credential_provenance_mismatch");
  }
  CREDENTIAL_PROVENANCE.set(credential, {
    owner,
    profileRevisionId,
    role,
    bindingHandle,
  });
}

function bindCredentialGeneration(
  credential: AcpCredentialLease,
  owner: object,
  profileRevisionId: string,
  role: AcpQualificationRole,
  bindingHandle: string,
  generation: AcpProcessGeneration,
): void {
  const provenance = CREDENTIAL_PROVENANCE.get(credential);
  if (!provenance
    || provenance.owner !== owner
    || provenance.profileRevisionId !== profileRevisionId
    || provenance.role !== role
    || provenance.bindingHandle !== bindingHandle
    || provenance.generation) {
    throw compositionError("acp_credential_provenance_mismatch");
  }
  provenance.generation = generation;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(compositionError(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  }
  return "acp_provider_qualification_failed";
}

function safeDiagnosticCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "diagnosticCode" in error) {
    const code = (error as { readonly diagnosticCode?: unknown }).diagnosticCode;
    if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  }
  return undefined;
}

function safeReason(reason: string): string {
  return SAFE_CODE.test(reason) ? reason : "acp_provider_qualification_failed";
}

function requiredOpaqueId(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{1,255}$/u.test(value)) {
    throw compositionError(code);
  }
  return value;
}

function requiredBindingHandle(value: unknown, code: string): string {
  const bindingHandle = requiredOpaqueId(value, code);
  if (!/^binding_handle_[A-Za-z0-9_-]+$/u.test(bindingHandle)) {
    throw compositionError(code);
  }
  return bindingHandle;
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw compositionError(code);
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compositionError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
