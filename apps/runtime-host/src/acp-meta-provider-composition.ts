import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  AcpPromptSettlement,
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import {
  normalizeProviderScopedToolRegistration,
  validateAcpMetaAgentTurnRequest,
  type AcpMetaAgentTurnRequest,
  type MetaAgentTurnAcceptance,
  type MetaAgentTurnReconciliation,
  type ProviderScopedToolTurnContext,
} from "@agent-workspace/provider-port";
import {
  isRuntimeId,
  validateAcpProfileReadinessObservation,
  validateMetaProfileDefinitionV3,
  validateMetaProfileOptionDefinitionV3,
  TEMPLATE_DRAFT_MCP_TOOL_DEFINITIONS,
  type AcpProfileReadinessObservation,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type MetaProfileOptionId,
  type MetaSessionId,
  type MetaSessionMode,
} from "@agent-workspace/runtime-contracts";
import {
  createAcpAgentProcessFactory,
  type AcpAgentIdentityVaultResolver,
  type AcpAgentProcessFactory,
  type AcpStdioConnectionFactory,
} from "./acp-agent-process.js";
import {
  createAcpProfileResolutionRegistry,
  type AcpCurrentInstallDescriptor,
} from "./acp-profile-resolution.js";
import {
  createAcpProviderComposition,
  type AcpTargetCheckpointFactCapability,
  type AcpTargetCheckpointFactCapabilityNotice,
  type AcpTargetCheckpointObserver,
  type AcpTargetLifecycleCapability,
  type AcpTargetLifecycleCapabilityNotice,
  type AcpCredentialAcquisitionOperation,
  type AcpProviderAvailabilityReport,
  type AcpProviderComposition,
  type AcpProviderQualificationRequest,
  type AcpQualificationEffectBudget,
  type AcpQualifiedBindingRuntime,
} from "./acp-provider-composition.js";
import { createAcpQualificationAuthority } from "./acp-qualification.js";
import { createAcpReverseRpcBroker } from "./acp-reverse-rpc-broker.js";
import {
  createProviderScopedMcpBridge,
  type ProviderScopedMcpRoute,
} from "./provider-scoped-mcp-bridge.js";

const META_REQUIRED_ACP_CAPABILITIES = Object.freeze([
  "session_new",
  "session_prompt",
  "session_cancel",
  "session_update",
] as const satisfies readonly AcpV1Capability[]);
const META_TEMPLATE_REQUIRED_ACP_CAPABILITIES = Object.freeze([
  ...META_REQUIRED_ACP_CAPABILITIES,
  "mcp_http",
] as const satisfies readonly AcpV1Capability[]);
const META_RECOVERY_CAPABILITIES = Object.freeze([
  "session_resume",
  "session_load",
] as const satisfies readonly AcpV1Capability[]);
const META_INITIAL_BEHAVIORS = Object.freeze([
  "meta_no_authority",
  "meta_single_whole_final",
  "meta_terminal_receipt",
] as const);
const META_REQUIRED_BEHAVIORS = Object.freeze([
  ...META_INITIAL_BEHAVIORS,
  "meta_cold_recovery",
] as const);
const META_PROBE_PROMPT = Object.freeze({
  instruction: "Return exactly one whole JSON object and do not use tools or permissions.",
  output: Object.freeze({ metaProbe: "ok" }),
});
const OPTIONS_KEYS = Object.freeze([
  "profiles",
  "privateRootParent",
  "processFactoryOptions",
  "readinessTtlMs",
  "operationTimeoutMs",
  "turnAdmissionTimeoutMs",
  "now",
  "createBindingHandle",
  "createReadinessBindingHandle",
  "beforeQualificationEffect",
  "onHumanOnlyActivity",
  "onDiagnostic",
  "onTargetLifecycleCapability",
  "onTargetCheckpointFactCapability",
]);
const REGISTRATION_KEYS = Object.freeze([
  "metaProfileOptionId",
  "title",
  "profile",
  "descriptor",
  "createConnection",
  "beginCredentialAcquisition",
  "sessionConfiguration",
]);
const REGISTRATION_OPTIONAL_KEYS = new Set([
  "beginCredentialAcquisition",
  "sessionConfiguration",
]);
const OPEN_KEYS = Object.freeze(["disposition", "metaSessionId", "metaProfileOptionId", "sessionMode"]);
const CLOSE_KEYS = Object.freeze(["metaSessionId"]);
const SAFE_CODE = /^[a-z][a-z0-9:_-]{0,191}$/u;
const PRIVATE_DIRECTORY_PREFIX = "agent-workspace-acp-meta-";

type ProcessFactoryOptions = NonNullable<
  Parameters<typeof createAcpAgentProcessFactory>[0]
>;

export type AcpMetaProcessFactoryOptions = Omit<
  ProcessFactoryOptions,
  "identityVault" | "identityVaultResolver"
> & Readonly<{
  /** Host-private, namespace-separated durable raw-session authority. */
  identityVaultResolver: AcpAgentIdentityVaultResolver;
}>;

export type AcpMetaProfileRegistration = Readonly<{
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly profile: MetaProfileDefinitionV3;
  readonly descriptor: AcpCurrentInstallDescriptor<MetaProfileDefinitionV3>;
  readonly createConnection: AcpStdioConnectionFactory;
  readonly beginCredentialAcquisition?: (scope: Readonly<{
    bindingHandle: string;
  }>) => AcpCredentialAcquisitionOperation;
  readonly sessionConfiguration?: AcpSessionConfigurationIntent;
}>;

export type AcpMetaSessionSafeObservation = Readonly<{
  readonly metaSessionId: MetaSessionId;
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly profileRevisionId: string;
  readonly providerFamily: MetaProfileDefinitionV3["providerFamily"];
  readonly acpAgentKind: MetaProfileDefinitionV3["acpAgentKind"];
  readonly role: "meta";
  readonly model: string;
  readonly status: "ready";
}>;

export type AcpMetaHumanOnlyActivity =
  | Readonly<{
      readonly kind: "agent_message_chunk";
      readonly metaSessionId: MetaSessionId;
      readonly metaTurnId: string;
      readonly text: string;
    }>
  | Readonly<{
      readonly kind: "agent_thought_chunk";
      readonly metaSessionId: MetaSessionId;
      readonly metaTurnId: string;
      readonly text: string;
    }>
  | Readonly<{
      readonly kind: "tool_status";
      readonly metaSessionId: MetaSessionId;
      readonly metaTurnId: string;
      readonly activityKey: string;
      readonly title: string;
      readonly status: "in_progress" | "completed" | "failed";
      readonly inputSummary?: string;
      readonly outputSummary?: string;
    }>;

export type AcpMetaSessionOpenResult =
  | Readonly<{
      readonly available: true;
      readonly session: AcpMetaSessionSafeObservation;
      readonly readiness: AcpProfileReadinessObservation;
    }>
  | Readonly<{
      readonly available: false;
      readonly readiness: AcpProfileReadinessObservation;
    }>;

export type AcpMetaProviderComposition = Readonly<{
  listMetaProfileOptions(): readonly MetaProfileOptionDefinitionV3[];
  readMetaProfileOption(
    metaProfileOptionId: MetaProfileOptionId,
  ): MetaProfileOptionDefinitionV3 | undefined;
  checkMetaProfileReadiness(
    metaProfileOptionId: MetaProfileOptionId,
  ): Promise<AcpProfileReadinessObservation>;
  /**
   * Host-only fresh qualification report used by the release parent. It is
   * never projected through Runtime Bridge/Renderer and still contains no
   * path, credential, raw ACP identity or wire payload.
   */
  checkMetaProfileQualificationReport(
    metaProfileOptionId: MetaProfileOptionId,
  ): Promise<AcpProviderAvailabilityReport>;
  openMetaSession(input: Readonly<{
    readonly metaSessionId: MetaSessionId;
    readonly metaProfileOptionId: MetaProfileOptionId;
    readonly sessionMode: MetaSessionMode;
    readonly disposition: "create" | "resume";
  }>): Promise<AcpMetaSessionOpenResult>;
  startMetaTurn(
    request: AcpMetaAgentTurnRequest,
    scopedToolTurnContext?: ProviderScopedToolTurnContext,
  ): Promise<MetaAgentTurnAcceptance>;
  reconcileMetaTurn(
    request: AcpMetaAgentTurnRequest,
  ): Promise<MetaAgentTurnReconciliation>;
  closeMetaSession(input: Readonly<{
    readonly metaSessionId: MetaSessionId;
  }>): Promise<void>;
  close(): Promise<void>;
}>;

type NormalizedRegistration = Readonly<{
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly profile: MetaProfileDefinitionV3;
  readonly descriptor: AcpCurrentInstallDescriptor<MetaProfileDefinitionV3>;
  readonly createConnection: AcpStdioConnectionFactory;
  readonly beginCredentialAcquisition?: (scope: Readonly<{
    bindingHandle: string;
  }>) => AcpCredentialAcquisitionOperation;
  readonly sessionConfiguration: AcpSessionConfigurationIntent;
}>;

type PrivateDirectoryLease = Readonly<{
  readonly directory: string;
  cleanup(): Promise<void>;
}>;

type MetaSessionState = {
  readonly metaSessionId: MetaSessionId;
  readonly registration: NormalizedRegistration;
  readonly sessionMode: MetaSessionMode;
  readonly disposition: "create" | "resume";
  readonly bindingHandle: string;
  readonly privateDirectory: PrivateDirectoryLease;
  readonly runtime: AcpQualifiedBindingRuntime;
  readonly safe: AcpMetaSessionSafeObservation;
  readonly shutdown: AbortController;
  readonly checkpointObserver?: AcpTargetCheckpointObserver;
  readonly templateDraftRoute?: ProviderScopedMcpRoute;
  promptEffectCount: number;
  closing?: Promise<void>;
};

type MetaTurnState = {
  readonly metaSessionId: MetaSessionId;
  readonly metaTurnId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  acceptance: MetaAgentTurnAcceptance;
  reconciliation: MetaAgentTurnReconciliation;
  readonly admission: Promise<MetaAgentTurnAcceptance>;
  readonly templateToolCallHandles: Set<string>;
  resolveAdmission(value: MetaAgentTurnAcceptance): void;
  execution: Promise<void>;
};

type OpeningMetaSession = Readonly<{
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly sessionMode: MetaSessionMode;
  readonly disposition: "create" | "resume";
  readonly result: Promise<AcpMetaSessionOpenResult>;
}>;

export class AcpMetaProviderCompositionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcpMetaProviderCompositionError";
    this.code = code;
  }
}

/**
 * Configuration-only ACP owner. It constructs fresh generic Host owners and
 * deliberately has no seam for importing a Task composition, qualification
 * token, reverse-RPC broker, raw identity vault, Workspace path or caller tool
 * catalog. Its fixed Template Draft catalog is proposal-only and Turn-scoped.
 * Its only identity seam is the Host Meta namespace resolver.
 */
export function createAcpMetaProviderComposition(
  input: Readonly<{
    readonly profiles: readonly AcpMetaProfileRegistration[];
    readonly privateRootParent: string;
    readonly processFactoryOptions: AcpMetaProcessFactoryOptions;
    readonly readinessTtlMs?: number;
    readonly operationTimeoutMs?: number;
    readonly turnAdmissionTimeoutMs?: number;
    readonly now?: () => number;
    readonly createBindingHandle?: (metaSessionId: MetaSessionId) => string;
    readonly createReadinessBindingHandle?: () => string;
    readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
    /** Best-effort Host-only projection; never becomes a MetaMessage, Proposal, or settlement gate. */
    readonly onHumanOnlyActivity?: (
      activity: AcpMetaHumanOnlyActivity,
    ) => void | Promise<void>;
    /** Host-process-only safe stage diagnostic; never persisted or bridged. */
    readonly onDiagnostic?: (diagnostic: Readonly<{
      readonly code: string;
      readonly stage: "turn";
    }>) => void;
    /** Host-only: forwarded only after the exact Meta target cwd and process are gone. */
    readonly onTargetLifecycleCapability?: (capability: AcpTargetLifecycleCapability) => void;
    /** Host-only: forwarded only after target process and private-directory cleanup. */
    readonly onTargetCheckpointFactCapability?: (
      capability: AcpTargetCheckpointFactCapability,
    ) => void;
  }>,
): AcpMetaProviderComposition {
  const options = exactRecord(
    input,
    OPTIONS_KEYS,
    new Set([
      "readinessTtlMs",
      "operationTimeoutMs",
      "turnAdmissionTimeoutMs",
      "now",
      "createBindingHandle",
      "createReadinessBindingHandle",
      "beforeQualificationEffect",
      "onHumanOnlyActivity",
      "onDiagnostic",
      "onTargetLifecycleCapability",
      "onTargetCheckpointFactCapability",
    ]),
    "acp_meta_composition_options_invalid",
  );
  if (!Array.isArray(options.profiles) || options.profiles.length > 64) {
    throw safeError("acp_meta_profiles_invalid");
  }
  const privateRootParent = requiredAbsolutePath(
    options.privateRootParent,
    "acp_meta_private_root_invalid",
  );
  const processFactoryOptions = normalizeProcessFactoryOptions(
    input.processFactoryOptions,
  );
  const readinessTtlMs = boundedInteger(
    options.readinessTtlMs ?? 5_000,
    0,
    5 * 60_000,
    "acp_meta_readiness_ttl_invalid",
  );
  const operationTimeoutMs = boundedInteger(
    // Meta readiness and turns execute a real bounded model probe. Keep the
    // default aligned with the generic ACP qualification timeout; 30 seconds
    // cancelled healthy Codex ACP generations while the model was still
    // producing the strict whole-final response, which then made cleanup
    // correctly—but misleadingly—surface as unconfirmed.
    options.operationTimeoutMs ?? 120_000,
    1,
    5 * 60_000,
    "acp_meta_operation_timeout_invalid",
  );
  const turnAdmissionTimeoutMs = boundedInteger(
    // Template editing commonly needs several bounded MCP calls. Keep the
    // acceptance window separate from short process/readiness operations so a
    // healthy whole-final is not orphaned while its tools are still running.
    options.turnAdmissionTimeoutMs ?? 10 * 60_000,
    1,
    30 * 60_000,
    "acp_meta_turn_admission_timeout_invalid",
  );
  const now = optionalFunction(options.now, Date.now, "acp_meta_now_invalid");
  const createBindingHandle = optionalFunction(
    options.createBindingHandle,
    (metaSessionId: MetaSessionId) => `binding_handle_meta_${createHash("sha256")
      .update(metaSessionId)
      .digest("hex")}`,
    "acp_meta_binding_factory_invalid",
  );
  const createReadinessBindingHandle = optionalFunction(
    options.createReadinessBindingHandle,
    () => `binding_handle_meta_readiness_${randomUUID()}`,
    "acp_meta_readiness_binding_factory_invalid",
  );
  const beforeQualificationEffect = options.beforeQualificationEffect as
    AcpQualificationEffectBudget | undefined;
  if (beforeQualificationEffect !== undefined
    && typeof beforeQualificationEffect !== "function") {
    throw safeError("acp_meta_qualification_effect_budget_invalid");
  }
  const onHumanOnlyActivity = options.onHumanOnlyActivity as
    ((activity: AcpMetaHumanOnlyActivity) => void | Promise<void>) | undefined;
  if (onHumanOnlyActivity !== undefined && typeof onHumanOnlyActivity !== "function") {
    throw safeError("acp_meta_human_activity_observer_invalid");
  }
  const onDiagnostic = options.onDiagnostic as
    ((diagnostic: Readonly<{ readonly code: string; readonly stage: "turn" }>) => void)
    | undefined;
  if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") {
    throw safeError("acp_meta_diagnostic_observer_invalid");
  }

  async function projectHumanOnlyActivity(activity: AcpMetaHumanOnlyActivity): Promise<void> {
    if (!onHumanOnlyActivity) return;
    try {
      await onHumanOnlyActivity(activity);
    } catch {
      // This projection is an in-memory, rebuildable Chat UI cache. It must not
      // turn an otherwise completed ACP prompt into an ambiguous Meta turn.
    }
  }
  const onTargetLifecycleCapability = options.onTargetLifecycleCapability;
  if (onTargetLifecycleCapability !== undefined
    && typeof onTargetLifecycleCapability !== "function") {
    throw safeError("acp_meta_target_lifecycle_observer_invalid");
  }
  const targetLifecycleObserver = onTargetLifecycleCapability as
    ((capability: AcpTargetLifecycleCapability) => void) | undefined;
  const onTargetCheckpointFactCapability = options.onTargetCheckpointFactCapability;
  if (onTargetCheckpointFactCapability !== undefined
    && typeof onTargetCheckpointFactCapability !== "function") {
    throw safeError("acp_meta_target_checkpoint_observer_invalid");
  }
  const targetCheckpointObserver = onTargetCheckpointFactCapability as
    ((capability: AcpTargetCheckpointFactCapability) => void) | undefined;
  const registrations = normalizeRegistrations(
    input.profiles,
  );
  const byOptionId = new Map(
    registrations.map((registration) => [registration.metaProfileOptionId, registration]),
  );

  // Every composition invocation creates all five private owners afresh.
  const resolutions = createAcpProfileResolutionRegistry();
  const processes: AcpAgentProcessFactory = createAcpAgentProcessFactory(
    processFactoryOptions,
  );
  const qualifications = createAcpQualificationAuthority();
  const reverseRpcBroker = createAcpReverseRpcBroker();
  const activeTemplateTurns = new Map<string, MetaTurnState>();
  const templateDraftBridge = createProviderScopedMcpBridge();
  const templateDraftMcpServerName = "agent_workspace_template_draft";
  const templateDraftRegistration = normalizeProviderScopedToolRegistration({
    capabilityClass: "template_draft",
    tools: TEMPLATE_DRAFT_MCP_TOOL_DEFINITIONS,
  });
  const provider: AcpProviderComposition = createAcpProviderComposition({
    resolutions,
    processes,
    qualifications,
    reverseRpcBroker,
    readinessTtlMs,
    operationTimeoutMs,
    now,
    createReadinessBindingHandle,
    ...(beforeQualificationEffect ? { beforeQualificationEffect } : {}),
    onTargetLifecycleCapability(notice) {
      recordTargetLifecycleCapability(notice);
    },
    onTargetCheckpointFactCapability(notice) {
      recordTargetCheckpointFactCapability(notice);
    },
  });
  const currentReadiness = new Map<MetaProfileOptionId, AcpProfileReadinessObservation>(
    registrations.map((registration) => [
      registration.metaProfileOptionId,
      pendingReadiness(registration.profile),
    ]),
  );
  const readinessExpiresAt = new Map<MetaProfileOptionId, number>();
  const readinessInFlight = new Map<
    MetaProfileOptionId,
    Promise<AcpProfileReadinessObservation>
  >();
  const sessions = new Map<MetaSessionId, MetaSessionState>();
  const openingSessions = new Map<MetaSessionId, OpeningMetaSession>();
  const retiredSessions = new Set<MetaSessionId>();
  const orphanedDirectories = new Set<PrivateDirectoryLease>();
  const turnsById = new Map<string, MetaTurnState>();
  const turnsByAttempt = new Map<string, MetaTurnState>();
  const targetLifecycleCapabilities = new Map<string, AcpTargetLifecycleCapability>();
  const targetCheckpointFactCapabilities = new Map<
    string,
    AcpTargetCheckpointFactCapability[]
  >();
  let probeSequence = 0;
  let closed = false;
  let poisonedCode: string | undefined;
  let closePromise: Promise<void> | undefined;

  const composition: AcpMetaProviderComposition = Object.freeze({
    listMetaProfileOptions() {
      return Object.freeze(registrations.map((registration) => optionProjection(
        registration,
        currentReadiness.get(registration.metaProfileOptionId)
          ?? pendingReadiness(registration.profile),
      )));
    },

    readMetaProfileOption(metaProfileOptionId) {
      const registration = byOptionId.get(metaProfileOptionId);
      if (!registration) return undefined;
      return optionProjection(
        registration,
        currentReadiness.get(metaProfileOptionId)
          ?? pendingReadiness(registration.profile),
      );
    },

    async checkMetaProfileReadiness(metaProfileOptionId) {
      const registration = requiredRegistration(byOptionId, metaProfileOptionId);
      if (closed) {
        return unavailableReadiness(registration.profile, "acp_meta_composition_closed");
      }
      if (poisonedCode) return unavailableReadiness(registration.profile, poisonedCode);
      const cached = currentReadiness.get(metaProfileOptionId);
      if (cached && cached.status !== "checking"
        && (readinessExpiresAt.get(metaProfileOptionId) ?? 0) > now()) {
        return cached;
      }
      const inFlight = readinessInFlight.get(metaProfileOptionId);
      if (inFlight) return inFlight;
      const pending = (async () => {
        let directory: PrivateDirectoryLease | undefined;
        try {
          directory = await createPrivateDirectory();
          const report = await provider.checkReadiness(qualificationRequest(
            registration,
            directory.directory,
          ));
          if (hasUnconfirmedCleanup(report.unavailableReasons)) {
            orphanedDirectories.add(directory);
            poisonedCode = "acp_meta_cleanup_unconfirmed";
            const readiness = unavailableReadiness(
              registration.profile,
              poisonedCode,
            );
            currentReadiness.set(metaProfileOptionId, readiness);
            readinessExpiresAt.set(metaProfileOptionId, Number.POSITIVE_INFINITY);
            return readiness;
          }
          const readiness = projectReadiness(registration.profile, report);
          currentReadiness.set(metaProfileOptionId, readiness);
          readinessExpiresAt.set(metaProfileOptionId, now() + readinessTtlMs);
          return readiness;
        } catch (error) {
          const readiness = unavailableReadiness(
            registration.profile,
            safeCode(error, "acp_meta_readiness_failed"),
          );
          currentReadiness.set(metaProfileOptionId, readiness);
          readinessExpiresAt.set(metaProfileOptionId, now() + readinessTtlMs);
          return readiness;
        } finally {
          if (directory && !orphanedDirectories.has(directory)) {
            try {
              await directory.cleanup();
            } catch {
              poisonedCode = "acp_meta_private_cwd_cleanup_unconfirmed";
              const readiness = unavailableReadiness(
                registration.profile,
                poisonedCode,
              );
              currentReadiness.set(metaProfileOptionId, readiness);
              readinessExpiresAt.set(metaProfileOptionId, Number.POSITIVE_INFINITY);
            }
          }
        }
      })().then(() => currentReadiness.get(metaProfileOptionId)!, () => (
        unavailableReadiness(registration.profile, "acp_meta_readiness_failed")
      )).finally(() => {
        readinessInFlight.delete(metaProfileOptionId);
      });
      readinessInFlight.set(metaProfileOptionId, pending);
      return pending;
    },

    async checkMetaProfileQualificationReport(metaProfileOptionId) {
      const registration = requiredRegistration(byOptionId, metaProfileOptionId);
      if (closed) throw safeError("acp_meta_composition_closed");
      if (poisonedCode) throw safeError(poisonedCode);
      let directory: PrivateDirectoryLease | undefined;
      let report: AcpProviderAvailabilityReport;
      try {
        directory = await createPrivateDirectory();
        report = await provider.checkReadiness(qualificationRequest(
          registration,
          directory.directory,
        ));
        if (hasUnconfirmedCleanup(report.unavailableReasons)) {
          orphanedDirectories.add(directory);
          poisonedCode = "acp_meta_cleanup_unconfirmed";
          throw safeError(poisonedCode);
        }
      } finally {
        if (directory && !orphanedDirectories.has(directory)) {
          try {
            await directory.cleanup();
          } catch {
            poisonedCode = "acp_meta_private_cwd_cleanup_unconfirmed";
            throw safeError(poisonedCode);
          }
        }
      }
      return report!;
    },

    async openMetaSession(value) {
      const request = exactRecord(
        value,
        OPEN_KEYS,
        new Set(),
        "acp_meta_open_input_invalid",
      );
      const metaSessionId = requiredMetaSessionId(request.metaSessionId);
      const disposition = requiredOpenDisposition(request.disposition);
      const sessionMode = requiredMetaSessionMode(request.sessionMode);
      const registration = requiredRegistration(
        byOptionId,
        request.metaProfileOptionId,
      );
      if (closed) throw safeError("acp_meta_composition_closed");
      if (poisonedCode) {
        return Object.freeze({
          available: false,
          readiness: unavailableReadiness(registration.profile, poisonedCode),
        });
      }
      if (retiredSessions.has(metaSessionId)) {
        throw safeError("acp_meta_session_retired");
      }
      const existing = sessions.get(metaSessionId);
      if (existing) {
        if (existing.registration.metaProfileOptionId !== registration.metaProfileOptionId) {
          throw safeError("acp_meta_session_profile_conflict");
        }
        if (existing.disposition !== disposition || existing.sessionMode !== sessionMode) {
          throw safeError("acp_meta_session_disposition_conflict");
        }
        if (existing.closing) throw safeError("acp_meta_session_closing");
        return Object.freeze({
          available: true,
          session: existing.safe,
          readiness: currentReadiness.get(registration.metaProfileOptionId)
            ?? pendingReadiness(registration.profile),
        });
      }
      const opening = openingSessions.get(metaSessionId);
      if (opening) {
        if (opening.metaProfileOptionId !== registration.metaProfileOptionId) {
          throw safeError("acp_meta_session_profile_conflict");
        }
        if (opening.disposition !== disposition || opening.sessionMode !== sessionMode) {
          throw safeError("acp_meta_session_disposition_conflict");
        }
        return opening.result;
      }

      const result: Promise<AcpMetaSessionOpenResult> = (async () => {
        const bindingHandle = requiredBindingHandle(createBindingHandle(metaSessionId));
        const directory = await createPrivateDirectory();
        let checkpointObserver: AcpTargetCheckpointObserver | undefined;
        let templateDraftRoute: ProviderScopedMcpRoute | undefined;
        let opened;
        try {
          opened = await provider.openBinding({
            ...qualificationRequest(
              registration,
              directory.directory,
              disposition,
              sessionMode,
              (observer) => { checkpointObserver = observer; },
              (route) => { templateDraftRoute = route; },
            ),
            bindingHandle,
          });
        } catch (error) {
          templateDraftRoute?.close();
          await cleanupDirectoryOrPoison(directory);
          throw error;
        }
        const readiness = projectReadiness(registration.profile, opened.report);
        currentReadiness.set(registration.metaProfileOptionId, readiness);
        readinessExpiresAt.set(
          registration.metaProfileOptionId,
          now() + readinessTtlMs,
        );
        if (!opened.available) {
          templateDraftRoute?.close();
          if (hasUnconfirmedCleanup(opened.report.unavailableReasons)) {
            orphanedDirectories.add(directory);
            poisonedCode = "acp_meta_cleanup_unconfirmed";
            const poisonedReadiness = unavailableReadiness(
              registration.profile,
              poisonedCode,
            );
            currentReadiness.set(
              registration.metaProfileOptionId,
              poisonedReadiness,
            );
            readinessExpiresAt.set(
              registration.metaProfileOptionId,
              Number.POSITIVE_INFINITY,
            );
            return Object.freeze({
              available: false,
              readiness: poisonedReadiness,
            });
          }
          await cleanupDirectoryOrPoison(directory);
          return Object.freeze({ available: false, readiness });
        }
        if (readiness.status !== "available") {
          templateDraftRoute?.close();
          const cleanup = await Promise.allSettled([
            opened.runtime.releaseBinding(),
            opened.runtime.close(),
          ]);
          if (cleanup.some((entry) => entry.status !== "fulfilled")) {
            orphanedDirectories.add(directory);
            poisonedCode = "acp_meta_cleanup_unconfirmed";
            throw safeError(poisonedCode);
          }
          await cleanupDirectoryOrPoison(directory);
          return Object.freeze({ available: false, readiness });
        }
        if (sessionMode === "template_design" && !templateDraftRoute) {
          await Promise.allSettled([opened.runtime.releaseBinding(), opened.runtime.close()]);
          await cleanupDirectoryOrPoison(directory);
          throw safeError("acp_meta_template_draft_route_missing");
        }
        const safe = safeSession(metaSessionId, registration);
        const state: MetaSessionState = {
          metaSessionId,
          registration,
          sessionMode,
          disposition,
          bindingHandle,
          privateDirectory: directory,
          runtime: opened.runtime,
          safe,
          shutdown: new AbortController(),
          ...(checkpointObserver ? { checkpointObserver } : {}),
          ...(templateDraftRoute ? { templateDraftRoute } : {}),
          promptEffectCount: 0,
        };
        sessions.set(metaSessionId, state);
        return Object.freeze({ available: true, session: safe, readiness });
      })();
      openingSessions.set(metaSessionId, Object.freeze({
        metaProfileOptionId: registration.metaProfileOptionId,
        sessionMode,
        disposition,
        result,
      }));
      try {
        return await result;
      } finally {
        if (openingSessions.get(metaSessionId)?.result === result) {
          openingSessions.delete(metaSessionId);
        }
      }
    },

    async startMetaTurn(value, scopedToolTurnContext) {
      const request = normalizeTurnRequest(value);
      const session = requireTurnSession(request, sessions);
      if (request.mode !== session.sessionMode) {
        throw safeError("acp_meta_session_mode_conflict");
      }
      if (request.mode === "template_design") {
        if (!scopedToolTurnContext
          || scopedToolTurnContext.capabilityClass !== "template_draft"
          || typeof scopedToolTurnContext.handleCall !== "function") {
          throw safeError("acp_meta_template_draft_turn_context_required");
        }
      } else if (scopedToolTurnContext !== undefined) {
        throw safeError("acp_meta_template_draft_turn_context_forbidden");
      }
      const requestDigest = digest(request);
      const existing = turnsById.get(request.metaTurnId);
      if (existing) {
        assertTurnReplay(existing, request, requestDigest);
        return existing.acceptance;
      }
      if ([...turnsById.values()].some((turn) => (
        turn.metaSessionId === request.metaSessionId
        && turn.reconciliation.state === "running"
      ))) {
        throw safeError("acp_meta_turn_already_active");
      }
      const attemptId = attemptIdFor(request.metaTurnId);
      const turn: MetaTurnState = {
        metaSessionId: request.metaSessionId,
        metaTurnId: request.metaTurnId,
        attemptId,
        requestDigest,
        acceptance: "unknown",
        reconciliation: Object.freeze({ state: "running" }),
        templateToolCallHandles: new Set<string>(),
        ...createTurnAdmission(),
        execution: Promise.resolve(),
      };
      turnsById.set(request.metaTurnId, turn);
      turnsByAttempt.set(attemptId, turn);
      if (scopedToolTurnContext) {
        session.templateDraftRoute!.activate(scopedToolTurnContext);
        activeTemplateTurns.set(session.bindingHandle, turn);
      }
      turn.execution = executeMetaTurn(session, turn, request).finally(() => {
        if (scopedToolTurnContext) {
          if (activeTemplateTurns.get(session.bindingHandle) === turn) {
            activeTemplateTurns.delete(session.bindingHandle);
          }
          try {
            session.templateDraftRoute!.deactivate();
          } catch (error) {
            if (!(error instanceof Error && error.message === "provider_scoped_mcp_route_closed")) {
              throw error;
            }
          }
        }
        turnsByAttempt.delete(attemptId);
      });
      return waitForTurnAdmission(turn, turnAdmissionTimeoutMs);
    },

    async reconcileMetaTurn(value) {
      const request = normalizeTurnRequest(value);
      const turn = turnsById.get(request.metaTurnId);
      // A cold Host has no private receipt/raw-ID lineage with which to prove
      // absence. Unknown is fail-closed and, unlike absent, cannot authorize a
      // retry of a possibly accepted Meta Turn.
      if (!turn) {
        const session = sessions.get(request.metaSessionId);
        if (session?.disposition === "resume"
          && session.registration.profile.profileRevisionId === request.profile.profileRevisionId
          && session.registration.profile.model === request.profile.model) {
          const before = session.promptEffectCount;
          const after = session.promptEffectCount;
          if (after !== before) throw safeError("acp_meta_cold_reconcile_effect_observed");
          session.checkpointObserver?.observe({
            kind: "meta_cold_reconcile_no_resend",
            bindingHandle: session.bindingHandle,
            role: "meta",
            disposition: "resume",
            promptEffectDelta: 0,
          });
        }
        return Object.freeze({ state: "unknown" });
      }
      assertTurnReplay(turn, request, digest(request));
      return turn.reconciliation;
    },

    async closeMetaSession(value) {
      const request = exactRecord(
        value,
        CLOSE_KEYS,
        new Set(),
        "acp_meta_close_input_invalid",
      );
      await closeSession(requiredMetaSessionId(request.metaSessionId));
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled(
          [...openingSessions.values()].map((opening) => opening.result),
        );
        const sessionResults = await Promise.allSettled(
          [...sessions.keys()].map((metaSessionId) => closeSession(metaSessionId)),
        );
        const ownerResult = await Promise.allSettled([provider.close(), templateDraftBridge.close()]);
        let orphanResults: PromiseSettledResult<void>[] = [];
        if (ownerResult[0]?.status === "fulfilled") {
          orphanResults = await Promise.allSettled(
            [...orphanedDirectories].map(async (directory) => {
              await directory.cleanup();
              orphanedDirectories.delete(directory);
            }),
          );
        }
        const failure = [...sessionResults, ...ownerResult, ...orphanResults].find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failure) {
          poisonedCode = "acp_meta_cleanup_unconfirmed";
          throw safeError("acp_meta_cleanup_unconfirmed");
        }
      })();
      return closePromise;
    },
  });
  return composition;

  function qualificationRequest(
    registration: NormalizedRegistration,
    privateDirectory: string,
    targetDisposition: "create" | "resume" = "create",
    targetSessionMode?: MetaSessionMode,
    captureCheckpointObserver?: (observer: AcpTargetCheckpointObserver) => void,
    captureTemplateDraftRoute?: (route: ProviderScopedMcpRoute) => void,
  ): AcpProviderQualificationRequest<MetaProfileDefinitionV3> {
    return Object.freeze({
      profile: registration.profile,
      descriptor: registration.descriptor,
      role: "meta",
      requiredAcpCapabilities: targetSessionMode === "template_design"
        ? META_TEMPLATE_REQUIRED_ACP_CAPABILITIES
        : META_REQUIRED_ACP_CAPABILITIES,
      requiredAnyAcpCapabilities: META_RECOVERY_CAPABILITIES,
      requiredBehaviors: META_REQUIRED_BEHAVIORS,
      workspaceDirectory: privateDirectory,
      createConnection: registration.createConnection,
      ...(registration.beginCredentialAcquisition
        ? { beginCredentialAcquisition: registration.beginCredentialAcquisition }
        : {}),
      managedClientOptions: Object.freeze({
        onObservation: observe,
      }),
      async runProbe(context) {
        if (context.profile !== registration.profile
          || !("role" in context.profile)
          || context.profile.role !== "meta") {
          throw safeError("acp_meta_probe_profile_mismatch");
        }
        if (context.reverseRpcLease) {
          throw safeError("acp_meta_reverse_rpc_forbidden");
        }
        const binding = await context.client.ensureBinding({
          bindingHandle: context.bindingHandle,
          disposition: "create",
          workspaceDirectory: privateDirectory,
          mcpServers: Object.freeze([]),
          configuration: registration.sessionConfiguration,
        });
        if (binding.bindingHandle !== context.bindingHandle
          || binding.model !== registration.profile.model) {
          throw safeError("acp_meta_probe_binding_invalid");
        }
        probeSequence += 1;
        const settlement = await context.client.submitPrompt({
          bindingHandle: context.bindingHandle,
          attemptId: `session_execution_attempt_meta_probe_${probeSequence}`,
          content: JSON.stringify(META_PROBE_PROMPT),
        });
        assertStrictSettlement(settlement, true);
        return Object.freeze({
          passedBehaviors: META_INITIAL_BEHAVIORS,
          modelCatalog: binding.modelCatalog,
          bindingEstablished: true,
          safeObservations: Object.freeze({
            noAuthority: true,
            wholeFinal: true,
          }),
        });
      },
      async runRecoveryProbe(context) {
        if (context.profile !== registration.profile || context.reverseRpcLease) {
          throw safeError("acp_meta_recovery_probe_invalid");
        }
        const disposition = context.recoveryCapability === "session_load"
          ? "load"
          : context.recoveryCapability === "session_resume"
            ? "resume"
            : undefined;
        if (!disposition) throw safeError("acp_meta_recovery_probe_invalid");
        const binding = await context.client.ensureBinding({
          bindingHandle: context.bindingHandle,
          disposition,
          workspaceDirectory: privateDirectory,
          mcpServers: Object.freeze([]),
          configuration: registration.sessionConfiguration,
        });
        if (binding.bindingHandle !== context.bindingHandle
          || binding.disposition !== disposition
          || binding.model !== registration.profile.model) {
          throw safeError("acp_meta_recovery_probe_invalid");
        }
        return Object.freeze({
          passedBehaviors: Object.freeze(["meta_cold_recovery"]),
          modelCatalog: binding.modelCatalog,
          bindingEstablished: true,
          safeObservations: Object.freeze({ coldRecovery: true }),
        });
      },
      async establishTargetBinding(context) {
        if (context.profile !== registration.profile || context.reverseRpcLease) {
          throw safeError("acp_meta_target_binding_invalid");
        }
        const route = targetSessionMode === "template_design"
          ? await createTemplateDraftRoute(context.bindingHandle)
          : undefined;
        if (route) captureTemplateDraftRoute?.(route);
        const mcpServers = route
          ? Object.freeze([Object.freeze({
              type: "http" as const,
              name: templateDraftMcpServerName,
              url: route.url,
              headers: Object.freeze([]),
            }) as unknown as McpServer])
          : Object.freeze([]);
        let binding;
        try {
          binding = await context.client.ensureBinding({
            bindingHandle: context.bindingHandle,
            disposition: targetDisposition,
            workspaceDirectory: privateDirectory,
            mcpServers,
            configuration: registration.sessionConfiguration,
          });
          if (route) await route.waitForToolDiscovery();
        } catch (error) {
          route?.close();
          throw error;
        }
        if (binding.bindingHandle !== context.bindingHandle
          || binding.disposition !== targetDisposition
          || binding.model !== registration.profile.model) {
          throw safeError("acp_meta_target_binding_invalid");
        }
        if (context.checkpointObserver && route) {
          captureCheckpointObserver?.(context.checkpointObserver);
          context.checkpointObserver.observe({
            kind: "meta_isolation_opened",
            bindingHandle: context.bindingHandle,
            role: "meta",
            privateDirectoryLeaseConfirmed: true,
            toolCapabilityClass: "template_draft",
            toolSurfaceCount: templateDraftRegistration.tools.length,
            callerCwdPresent: false,
            taskWorkspacePresent: false,
          });
        }
        return Object.freeze({ bindingEstablished: true as const });
      },
    });
  }

  function isTemplateDraftMcpToolTitle(title: string | undefined): boolean {
    if (!title) return false;
    return templateDraftRegistration.tools.some((tool) => (
      title === `mcp.${templateDraftMcpServerName}.${tool.name}`
    ));
  }

  async function observe(observation: AcpSessionObservation): Promise<void> {
    const turn = turnsByAttempt.get(observation.attemptId);
    if (observation.kind === "agent_message_chunk" || observation.kind === "agent_thought_chunk") {
      if (turn) {
        await projectHumanOnlyActivity(Object.freeze({
          kind: observation.kind,
          metaSessionId: turn.metaSessionId,
          metaTurnId: turn.metaTurnId,
          text: observation.text,
        }));
      }
      return;
    }
    if (observation.kind === "tool_status") {
      if (!turn) throw safeError("acp_meta_authority_observed");
      const session = sessions.get(turn.metaSessionId);
      if (session?.sessionMode === "template_design"
        && observation.bindingHandle === session.bindingHandle
        && isTemplateDraftMcpToolTitle(observation.title)) {
        if (observation.status === "completed" || observation.status === "failed") {
          turn.templateToolCallHandles.delete(observation.toolCallHandle);
        } else {
          turn.templateToolCallHandles.add(observation.toolCallHandle);
        }
      }
      return;
    }
    if (observation.kind === "interaction_requested") {
      const session = turn ? sessions.get(turn.metaSessionId) : undefined;
      const allowOnce = observation.choices.filter((choice) => choice.kind === "allow_once");
      if (turn
        && session?.sessionMode === "template_design"
        && observation.bindingHandle === session.bindingHandle
        && turn.templateToolCallHandles.delete(observation.toolCallHandle)
        && allowOnce.length === 1) {
        await session.runtime.client.respondToInteraction({
          bindingHandle: observation.bindingHandle,
          attemptId: observation.attemptId,
          interactionId: observation.interactionId,
          choiceId: allowOnce[0]!.choiceId,
        });
        return;
      }
      session?.checkpointObserver?.observe({
        kind: "meta_permission_rejected",
        bindingHandle: session.bindingHandle,
        attemptId: observation.attemptId,
        role: "meta",
      });
      throw safeError("acp_meta_authority_observed");
    }
    if (turn && observation.kind === "delivery_receipt") {
      turn.acceptance = "accepted";
    }
  }

  async function createTemplateDraftRoute(bindingId: string): Promise<ProviderScopedMcpRoute> {
    await templateDraftBridge.listen();
    return templateDraftBridge.registerRoute({
      bindingId,
      registration: templateDraftRegistration,
      projectToolActivity: projectTemplateDraftToolActivity,
      async onToolActivity(activity) {
        const turn = activeTemplateTurns.get(bindingId);
        if (!turn) return;
        await projectHumanOnlyActivity(Object.freeze({
          kind: "tool_status" as const,
          metaSessionId: turn.metaSessionId,
          metaTurnId: turn.metaTurnId,
          activityKey: activity.activityKey,
          title: templateDraftToolTitle(activity.name),
          status: activity.status,
          ...(activity.inputSummary ? { inputSummary: activity.inputSummary } : {}),
          ...(activity.outputSummary ? { outputSummary: activity.outputSummary } : {}),
        }));
      },
    });
  }

  async function executeMetaTurn(
    session: MetaSessionState,
    turn: MetaTurnState,
    request: AcpMetaAgentTurnRequest,
  ): Promise<void> {
    try {
      await session.runtime.assertQualified();
      const submission = session.runtime.client.submitPrompt({
        bindingHandle: session.bindingHandle,
        attemptId: turn.attemptId,
        content: promptFor(request),
      });
      session.promptEffectCount += 1;
      submission.catch(() => undefined);
      const settlement = await Promise.race([
        submission,
        rejectOnAbort(session.shutdown.signal),
      ]);
      turn.acceptance = "accepted";
      turn.resolveAdmission("accepted");
      try {
        assertStrictSettlement(settlement, false);
        session.checkpointObserver?.observe({
          kind: "meta_strict_whole_final",
          bindingHandle: session.bindingHandle,
          attemptId: turn.attemptId,
          role: "meta",
        });
        turn.reconciliation = Object.freeze({
          state: "returned",
          finalText: settlement.finalCandidate!,
          observedAt: observedAt(now()),
        });
      } catch (error) {
        turn.reconciliation = Object.freeze({
          state: "failed",
          failureCode: safeCode(error, "acp_meta_settlement_invalid"),
          observedAt: observedAt(now()),
        });
      }
    } catch (error) {
      // An accepted-but-unsettled or transport-ambiguous Turn remains unknown.
      // Neither start nor reconcile ever invokes submitPrompt again for it.
      try {
        onDiagnostic?.(Object.freeze({
          code: safeCode(error, "acp_meta_turn_unknown"),
          stage: "turn",
        }));
      } catch {
        // Host-only observability must never become a lifecycle decision.
      }
      turn.reconciliation = Object.freeze({ state: "unknown" });
    } finally {
      turn.resolveAdmission(turn.acceptance);
    }
  }

  async function closeSession(metaSessionId: MetaSessionId): Promise<void> {
    retiredSessions.add(metaSessionId);
    const opening = openingSessions.get(metaSessionId);
    if (opening) await opening.result.catch(() => undefined);
    const session = sessions.get(metaSessionId);
    if (!session) return;
    if (session.closing) return session.closing;
    const closing = (async () => {
      session.templateDraftRoute?.close();
      const activeTurns = [...turnsById.values()].filter((turn) => (
        turn.metaSessionId === metaSessionId
        && turn.reconciliation.state === "running"
      ));
      session.shutdown.abort();
      const releaseResult = activeTurns.length === 0
        ? await Promise.allSettled([session.runtime.releaseBinding()])
        : [];
      const processResult = await Promise.allSettled([session.runtime.close()]);
      if (processResult[0]?.status !== "fulfilled") {
        poisonedCode = "acp_meta_cleanup_unconfirmed";
        throw safeError("acp_meta_cleanup_unconfirmed");
      }
      await Promise.all(activeTurns.map((turn) => turn.execution));
      try {
        await session.privateDirectory.cleanup();
      } catch {
        poisonedCode = "acp_meta_cleanup_unconfirmed";
        throw safeError("acp_meta_cleanup_unconfirmed");
      }
      if (releaseResult.some((entry) => entry.status !== "fulfilled")) {
        poisonedCode = "acp_meta_cleanup_unconfirmed";
        throw safeError("acp_meta_cleanup_unconfirmed");
      }
      const targetCapability = targetLifecycleCapabilities.get(session.bindingHandle);
      if (targetCapability) {
        targetLifecycleCapabilities.delete(session.bindingHandle);
        targetLifecycleObserver?.(targetCapability);
      }
      const checkpointCapabilities = targetCheckpointFactCapabilities.get(session.bindingHandle) ?? [];
      targetCheckpointFactCapabilities.delete(session.bindingHandle);
      for (const capability of checkpointCapabilities) targetCheckpointObserver?.(capability);
      sessions.delete(metaSessionId);
    })();
    session.closing = closing;
    return closing;
  }

  async function createPrivateDirectory(): Promise<PrivateDirectoryLease> {
    // Revalidate the Host-private parent for every lease so replacing it after
    // a readiness probe cannot redirect a later MetaSession cwd.
    const root = await canonicalRoot(privateRootParent);
    const directory = await mkdtemp(path.join(root, PRIVATE_DIRECTORY_PREFIX));
    try {
      await chmod(directory, 0o700);
      const [entryStat, canonical, entries] = await Promise.all([
        lstat(directory),
        realpath(directory),
        readdir(directory),
      ]);
      if (!entryStat.isDirectory()
        || entryStat.isSymbolicLink()
        || canonical !== directory
        || entries.length !== 0
        || (entryStat.mode & 0o777) !== 0o700) {
        throw safeError("acp_meta_private_cwd_invalid");
      }
      let cleaned = false;
      return Object.freeze({
        directory,
        async cleanup() {
          if (cleaned) return;
          assertPrivateDirectoryTarget(root, directory);
          await rm(directory, { recursive: true, force: true });
          cleaned = true;
        },
      });
    } catch (error) {
      assertPrivateDirectoryTarget(root, directory);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function cleanupDirectoryOrPoison(directory: PrivateDirectoryLease): Promise<void> {
    try {
      await directory.cleanup();
    } catch {
      orphanedDirectories.add(directory);
      poisonedCode = "acp_meta_private_cwd_cleanup_unconfirmed";
      throw safeError(poisonedCode);
    }
  }

  function recordTargetLifecycleCapability(notice: AcpTargetLifecycleCapabilityNotice): void {
    if (targetLifecycleCapabilities.has(notice.bindingHandle)) {
      poisonedCode = "acp_meta_target_lifecycle_duplicate";
      throw safeError(poisonedCode);
    }
    targetLifecycleCapabilities.set(notice.bindingHandle, notice.capability);
  }

  function recordTargetCheckpointFactCapability(
    notice: AcpTargetCheckpointFactCapabilityNotice,
  ): void {
    const current = targetCheckpointFactCapabilities.get(notice.bindingHandle) ?? [];
    if (current.includes(notice.capability)) {
      poisonedCode = "acp_meta_target_checkpoint_duplicate";
      throw safeError(poisonedCode);
    }
    current.push(notice.capability);
    targetCheckpointFactCapabilities.set(notice.bindingHandle, current);
  }
}

function hasUnconfirmedCleanup(reasons: readonly string[]): boolean {
  return reasons.some((reason) => (
    reason.includes("cleanup_unconfirmed")
      || reason.includes("cleanup_timeout")
      || reason.includes("exit_unconfirmed")
  ));
}

function normalizeRegistrations(
  registrations: readonly AcpMetaProfileRegistration[],
): readonly NormalizedRegistration[] {
  const optionIds = new Set<string>();
  const profileRevisionIds = new Set<string>();
  return Object.freeze(registrations.map((value) => {
    const root = exactRecord(
      value,
      REGISTRATION_KEYS,
      REGISTRATION_OPTIONAL_KEYS,
      "acp_meta_profile_registration_invalid",
    );
    const profile = validateMetaProfileDefinitionV3(root.profile);
    const initial = validateMetaProfileOptionDefinitionV3({
      metaProfileOptionId: root.metaProfileOptionId,
      title: root.title,
      profile,
      readiness: pendingReadiness(profile),
    });
    if (optionIds.has(initial.metaProfileOptionId)
      || profileRevisionIds.has(profile.profileRevisionId)) {
      throw safeError("acp_meta_profile_registration_duplicate");
    }
    optionIds.add(initial.metaProfileOptionId);
    profileRevisionIds.add(profile.profileRevisionId);
    const descriptor = value.descriptor;
    if (!descriptor || typeof descriptor !== "object"
      || typeof descriptor.discoverCurrent !== "function") {
      throw safeError("acp_meta_descriptor_invalid");
    }
    if (typeof root.createConnection !== "function") {
      throw safeError("acp_meta_connection_factory_invalid");
    }
    if (root.beginCredentialAcquisition !== undefined
      && typeof root.beginCredentialAcquisition !== "function") {
      throw safeError("acp_meta_credential_factory_invalid");
    }
    return Object.freeze({
      metaProfileOptionId: initial.metaProfileOptionId,
      title: initial.title,
      profile,
      descriptor,
      createConnection: value.createConnection,
      ...(value.beginCredentialAcquisition
        ? { beginCredentialAcquisition: value.beginCredentialAcquisition }
        : {}),
      sessionConfiguration: normalizeSessionConfiguration(
        value.sessionConfiguration,
        profile.model,
      ),
    });
  }));
}

function normalizeSessionConfiguration(
  value: AcpSessionConfigurationIntent | undefined,
  model: string,
): AcpSessionConfigurationIntent {
  if (value === undefined) {
    return Object.freeze({ model, options: Object.freeze([]) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError("acp_meta_session_configuration_invalid");
  }
  if (Object.keys(value).some((key) => key !== "model" && key !== "options")) {
    throw safeError("acp_meta_session_configuration_invalid");
  }
  const snapshot = structuredClone(value);
  if (snapshot.model !== model || !Array.isArray(snapshot.options)) {
    throw safeError("acp_meta_session_configuration_invalid");
  }
  return deepFreeze(snapshot);
}

function normalizeProcessFactoryOptions(
  value: AcpMetaProcessFactoryOptions,
): AcpMetaProcessFactoryOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.hasOwn(value, "identityVault")
    || typeof value.identityVaultResolver !== "function") {
    throw safeError("acp_meta_process_factory_options_invalid");
  }
  return Object.freeze({ ...value });
}

function optionProjection(
  registration: NormalizedRegistration,
  readiness: AcpProfileReadinessObservation,
): MetaProfileOptionDefinitionV3 {
  return deepFreeze(validateMetaProfileOptionDefinitionV3({
    metaProfileOptionId: registration.metaProfileOptionId,
    title: registration.title,
    profile: registration.profile,
    readiness,
  }));
}

function pendingReadiness(
  profile: MetaProfileDefinitionV3,
): AcpProfileReadinessObservation {
  return validateAcpProfileReadinessObservation({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role: "meta",
    status: "checking",
    reasons: ["probe_pending"],
    missingCapabilities: [],
    missingExtensions: [],
    model: profile.model,
  });
}

function unavailableReadiness(
  profile: MetaProfileDefinitionV3,
  reason: string,
): AcpProfileReadinessObservation {
  return validateAcpProfileReadinessObservation({
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    acpAgentKind: profile.acpAgentKind,
    role: "meta",
    status: "unavailable",
    reasons: [safeReason(reason)],
    missingCapabilities: [],
    missingExtensions: [],
    model: profile.model,
  });
}

function projectReadiness(
  profile: MetaProfileDefinitionV3,
  report: AcpProviderAvailabilityReport,
): AcpProfileReadinessObservation {
  if (report.profileRevisionId !== profile.profileRevisionId
    || report.providerFamily !== profile.providerFamily
    || report.acpAgentKind !== profile.acpAgentKind
    || report.role !== "meta") {
    return unavailableReadiness(profile, "acp_meta_readiness_identity_mismatch");
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
      role: "meta",
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
        // Optional current-install metadata may be less portable than the
        // Renderer-safe contract. Omitting it cannot weaken qualification.
      }
    }
    return readiness;
  } catch {
    return unavailableReadiness(profile, "acp_meta_readiness_projection_invalid");
  }
}

function safeSession(
  metaSessionId: MetaSessionId,
  registration: NormalizedRegistration,
): AcpMetaSessionSafeObservation {
  return Object.freeze({
    metaSessionId,
    metaProfileOptionId: registration.metaProfileOptionId,
    profileRevisionId: registration.profile.profileRevisionId,
    providerFamily: registration.profile.providerFamily,
    acpAgentKind: registration.profile.acpAgentKind,
    role: "meta",
    model: registration.profile.model,
    status: "ready",
  });
}

function normalizeTurnRequest(value: unknown): AcpMetaAgentTurnRequest {
  try {
    return validateAcpMetaAgentTurnRequest(value);
  } catch {
    throw safeError("acp_meta_turn_request_invalid");
  }
}

function requireTurnSession(
  request: AcpMetaAgentTurnRequest,
  sessions: ReadonlyMap<MetaSessionId, MetaSessionState>,
): MetaSessionState {
  const session = sessions.get(request.metaSessionId);
  if (!session || session.closing) throw safeError("acp_meta_session_not_open");
  const profile = session.registration.profile;
  if (digest(request.profile) !== digest(profile)) {
    throw safeError("acp_meta_turn_profile_mismatch");
  }
  return session;
}

function assertTurnReplay(
  turn: MetaTurnState,
  request: AcpMetaAgentTurnRequest,
  requestDigest: string,
): void {
  if (turn.metaSessionId !== request.metaSessionId
    || turn.requestDigest !== requestDigest) {
    throw safeError("acp_meta_turn_replay_conflict");
  }
}

function createTurnAdmission(): Pick<
  MetaTurnState,
  "admission" | "resolveAdmission"
> {
  let settled = false;
  let resolvePromise: (value: MetaAgentTurnAcceptance) => void = () => undefined;
  const admission = new Promise<MetaAgentTurnAcceptance>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    admission,
    resolveAdmission(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
  };
}

async function waitForTurnAdmission(
  turn: MetaTurnState,
  timeoutMs: number,
): Promise<MetaAgentTurnAcceptance> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MetaAgentTurnAcceptance>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), timeoutMs);
  });
  try {
    return await Promise.race([turn.admission, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(safeError("acp_meta_session_closing"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(safeError("acp_meta_session_closing")),
      { once: true },
    );
  });
}

function assertStrictSettlement(
  settlement: AcpPromptSettlement,
  probe: boolean,
): void {
  if (settlement.stopReason !== "end_turn") {
    throw safeError("acp_meta_terminal_incomplete");
  }
  if (probe && settlement.finalCandidateGroupCount !== 1) {
    throw safeError("acp_meta_final_candidate_nonunique");
  }
  if (settlement.finalCandidateGroupCount < 1 || !settlement.finalCandidate) {
    throw safeError("acp_meta_final_candidate_missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(settlement.finalCandidate);
  } catch {
    throw safeError("acp_meta_final_json_invalid");
  }
  if (probe && (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed as Record<string, unknown>).length !== 1
    || (parsed as Record<string, unknown>).metaProbe !== "ok")) {
    throw safeError("acp_meta_probe_final_invalid");
  }
}

function promptFor(request: AcpMetaAgentTurnRequest): string {
  return JSON.stringify({
    mode: request.mode,
    targetRevision: request.targetRevision,
    systemInstructions: request.systemInstructions,
    outputSchema: request.outputSchema,
    context: request.context,
    transcript: request.transcript,
    content: request.content,
  });
}

function attemptIdFor(metaTurnId: string): string {
  const suffix = metaTurnId.replace(/^meta_turn_/u, "");
  if (!/^[A-Za-z0-9_-]+$/u.test(suffix)) {
    throw safeError("acp_meta_turn_id_invalid");
  }
  return `session_execution_attempt_meta_${suffix}`;
}

function templateDraftToolTitle(name: string): string {
  switch (name) {
    case "template_draft_read": return "读取 Template Draft";
    case "template_draft_update_metadata": return "修改 Template 信息";
    case "template_draft_create_card": return "新增 Agent Card";
    case "template_draft_update_card": return "修改 Agent Card";
    case "template_draft_edit_prompt": return "定位修改 Prompt";
    case "template_draft_delete_card": return "删除 Agent Card";
    case "template_draft_reorder_cards": return "调整 Agent Card 顺序";
    case "template_draft_select_profile": return "选择执行 Profile";
    case "template_draft_upsert_deliverable": return "更新 Deliverable";
    case "template_draft_delete_deliverable": return "删除 Deliverable";
    default: return "Template Draft 工具";
  }
}

function projectTemplateDraftToolActivity(input: Readonly<{
  name: string;
  status: "in_progress" | "completed" | "failed";
  arguments: unknown;
  result?: unknown;
}>): Readonly<{ inputSummary?: string; outputSummary?: string }> {
  if (input.status === "failed") {
    return Object.freeze({ outputSummary: "工具调用未完成；没有形成可应用的 Draft 操作。" });
  }
  if (input.status === "completed") {
    const result = presentationRecord(input.result);
    const revision = Number.isSafeInteger(result.targetRevision)
      ? `Draft r${String(result.targetRevision)}`
      : "当前 Draft";
    if (input.name === "template_draft_read") {
      const cardCount = Array.isArray(result.agentCards) ? result.agentCards.length : undefined;
      const profileCount = Array.isArray(result.executionProfiles) ? result.executionProfiles.length : undefined;
      const inventory = [
        cardCount === undefined ? undefined : `${cardCount} 张 Agent Card`,
        profileCount === undefined ? undefined : `${profileCount} 个 Execution Profile`,
      ].filter((entry): entry is string => Boolean(entry));
      return Object.freeze({
        outputSummary: `已读取 ${revision} 的稳定快照${inventory.length ? `：${inventory.join("，")}` : ""}。`,
      });
    }
    const operation = presentationRecord(result.operation);
    return Object.freeze({
      outputSummary: `${revision}：已生成${templateDraftOperationLabel(operation.kind)}，尚未应用。`,
    });
  }
  const argumentsValue = presentationRecord(input.arguments);
  switch (input.name) {
    case "template_draft_read":
      return Object.freeze({ inputSummary: `目标：${templateDraftTargetLabel(argumentsValue.target)}` });
    case "template_draft_edit_prompt": {
      const target = presentationRecord(argumentsValue.target);
      return Object.freeze({ inputSummary: [
        `目标：${templateDraftTargetLabel(target)} Prompt`,
        `原文：${presentationText(argumentsValue.oldText, 7_500)}`,
        `新文：${presentationText(argumentsValue.newText, 7_500)}`,
      ].join("\n") });
    }
    case "template_draft_update_metadata":
      return Object.freeze({ inputSummary: `字段：${presentationText(argumentsValue.field, 80)}\n新值：${presentationText(argumentsValue.value, 2_000)}` });
    case "template_draft_create_card":
      return Object.freeze({ inputSummary: `新增 Agent Card：${presentationText(argumentsValue.title, 200)}\n类型：${presentationText(argumentsValue.cardKind, 80)}` });
    case "template_draft_update_card": {
      const changes = presentationRecord(argumentsValue.changes);
      return Object.freeze({ inputSummary: `修改 Agent Card 字段：${Object.keys(changes).sort().join("、") || "未提供"}` });
    }
    case "template_draft_delete_card":
      return Object.freeze({ inputSummary: "删除一个现有 Agent Card。" });
    case "template_draft_reorder_cards":
      return Object.freeze({ inputSummary: `调整 Agent Card 顺序：${Array.isArray(argumentsValue.cardRefs) ? argumentsValue.cardRefs.length : 0} 张。` });
    case "template_draft_select_profile":
      return Object.freeze({ inputSummary: "选择一个由 Host 验证的执行 Profile revision。" });
    case "template_draft_upsert_deliverable":
      return Object.freeze({ inputSummary: `交付物：${presentationText(argumentsValue.artifactPath, 600)}` });
    case "template_draft_delete_deliverable":
      return Object.freeze({ inputSummary: `删除交付物：${presentationText(argumentsValue.artifactPath, 600)}` });
    default:
      return Object.freeze({});
  }
}

function templateDraftTargetLabel(value: unknown): string {
  const target = presentationRecord(value);
  switch (target.kind) {
    case "template": return "整个 Template Draft";
    case "conductor": return "Conductor";
    case "card": return "Session Agent Card";
    case "profile": return "Execution Profile";
    default: return "当前 Draft 对象";
  }
}

function templateDraftOperationLabel(value: unknown): string {
  switch (value) {
    case "template_metadata_set": return " Template 信息修改操作";
    case "template_card_create": return " Agent Card 新增操作";
    case "template_card_update": return " Agent Card 修改操作";
    case "template_conductor_prompt_edit":
    case "template_card_prompt_edit": return " Prompt 定位修改操作";
    case "template_card_delete": return " Agent Card 删除操作";
    case "template_cards_reorder": return " Agent Card 排序操作";
    case "template_profile_revision_select": return "执行 Profile 选择操作";
    case "template_deliverable_upsert": return " Deliverable 更新操作";
    case "template_deliverable_delete": return " Deliverable 删除操作";
    default: return "一项 Proposal 操作";
  }
}

function presentationRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : Object.create(null) as Record<string, unknown>;
}

function presentationText(value: unknown, maximum: number): string {
  if (value === null) return "（清空）";
  if (typeof value !== "string") return "（未提供）";
  const normalized = value.replaceAll("\0", "").trim();
  if (!normalized) return "（空）";
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

async function canonicalRoot(value: string): Promise<string> {
  const canonical = await realpath(value).catch(() => {
    throw safeError("acp_meta_private_root_invalid");
  });
  const [entry, target] = await Promise.all([lstat(value), stat(canonical)]);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !target.isDirectory()
    || canonical !== path.resolve(value)) {
    throw safeError("acp_meta_private_root_invalid");
  }
  return canonical;
}

function assertPrivateDirectoryTarget(root: string, directory: string): void {
  if (path.dirname(directory) !== root
    || !path.basename(directory).startsWith(PRIVATE_DIRECTORY_PREFIX)) {
    throw safeError("acp_meta_private_cwd_cleanup_target_invalid");
  }
}

function requiredRegistration(
  registrations: ReadonlyMap<MetaProfileOptionId, NormalizedRegistration>,
  value: unknown,
): NormalizedRegistration {
  if (typeof value !== "string") throw safeError("acp_meta_profile_option_not_found");
  const registration = registrations.get(value as MetaProfileOptionId);
  if (!registration) throw safeError("acp_meta_profile_option_not_found");
  return registration;
}

function requiredMetaSessionId(value: unknown): MetaSessionId {
  if (!isRuntimeId(value, "meta_session")) {
    throw safeError("acp_meta_session_id_invalid");
  }
  return value;
}

function requiredOpenDisposition(value: unknown): "create" | "resume" {
  if (value !== "create" && value !== "resume") {
    throw safeError("acp_meta_open_disposition_invalid");
  }
  return value;
}

function requiredMetaSessionMode(value: unknown): MetaSessionMode {
  if (value !== "template_design" && value !== "task_setup") {
    throw safeError("acp_meta_session_mode_invalid");
  }
  return value;
}

function requiredBindingHandle(value: unknown): string {
  if (typeof value !== "string"
    || !/^binding_handle_[A-Za-z0-9_-]+$/u.test(value)) {
    throw safeError("acp_meta_binding_handle_invalid");
  }
  return value;
}

function requiredAbsolutePath(value: unknown, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw safeError(code);
  }
  return path.resolve(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: ReadonlySet<string>,
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw safeError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw safeError(code);
  const root = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(root).some((key) => !allowed.has(key))) throw safeError(code);
  for (const key of keys) {
    if (!optional.has(key) && !(key in root)) throw safeError(code);
  }
  return root;
}

function optionalFunction<T extends (...arguments_: never[]) => unknown>(
  value: unknown,
  fallback: T,
  code: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "function") throw safeError(code);
  return value as T;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum) {
    throw safeError(code);
  }
  return value as number;
}

function observedAt(value: number): string {
  if (!Number.isFinite(value)) throw safeError("acp_meta_observed_at_invalid");
  return new Date(value).toISOString();
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

function safeCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  }
  return fallback;
}

function safeReason(value: string): string {
  return SAFE_CODE.test(value) ? value : "acp_meta_unavailable";
}

function safeError(code: string): AcpMetaProviderCompositionError {
  return new AcpMetaProviderCompositionError(code);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}
