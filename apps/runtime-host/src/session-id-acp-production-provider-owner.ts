import type {
  AcpProductionConfiguration,
  AcpProductionHostInputs,
} from "./acp-production-configuration.js";
import { loadAcpProductionConfigurationFromEnvironment } from "./acp-production-configuration.js";
import type {
  AcpRuntimeHostPrivateAuthority,
} from "./acp-runtime-host-private-authority.js";
import {
  createAcpProductionMetaOwner,
  createCodexAcpProductionTaskNativeFactory,
  createClaudeCodeAcpProductionTaskNativeFactory,
  createOpenCodeAcpProductionTaskNativeFactory,
  createSessionIdAcpProductionComposition,
  type AcpProductionMetaOwner,
  type SessionIdAcpProductionNativeReleaseObservationOwner,
} from "./session-id-acp-production-composition.js";
import { createSessionIdAcpProductionPolicyOwner } from "./session-id-acp-production-policy.js";
import { createSessionIdAcpTaskBindingContextOwner } from "./session-id-acp-task-binding-context.js";
import type { SessionIdAcpProviderSettingsHost } from "./session-id-acp-provider-settings-host.js";
import type {
  SessionIdUnifiedAcpProviderAttachment,
  SessionIdUnifiedAcpProviderFactoryInput,
  SessionIdUnifiedAcpProviderOwner,
} from "./session-id-unified-runtime-host.js";
import type { AcpMetaAgentRegistration } from "@agent-workspace/runtime-application";

// A production Task prompt includes the model turn and any scoped tool round
// trips. Thirty seconds was shorter than a normal Codex ACP Luna turn, so the
// Host cancelled healthy prompts and left the durable Attempt honestly (but
// permanently) reconciling. Keep this bounded while allowing the actual
// Provider turn to reach its correlated final + terminal pair.
const DEFAULT_EFFECT_DEADLINE_MS = 180_000;
const OWNER_OPTION_KEYS = Object.freeze([
  "configuration",
  "effectDeadlineMs",
  "hostInputs",
  "input",
  "onHumanOnlyDiagnostic",
  "onDiagnostic",
  "privateAuthority",
  "providerSettings",
  "retainPrivateAuthority",
]);
const PROVIDER_INPUT_KEYS = Object.freeze([
  "authorizeRetiringBindingRecovery",
  "createId",
  "now",
  "onDeliveryReceipt",
  "onHumanOnlyActivity",
  "repositories",
  "resolveCloseControl",
  "resolveFrozenProfileTuple",
  "resolveInterruptCorrelation",
  "resolveTaskStopControl",
  "runtimeInstanceId",
  "sessionRuntimeOwner",
  "taskBindingContext",
]);
const PRIVATE_AUTHORITY_KEYS = Object.freeze([
  "authorizeRetiringBindingRecovery",
  "close",
  "metaIdentityVaults",
  "metaPrivateRootAuthority",
  "recoveryObservation",
  "taskIdentityVaults",
  "taskPrivateRootAuthority",
  "toJSON",
]);

export type SessionIdAcpProductionProviderOwner = SessionIdUnifiedAcpProviderOwner & Readonly<{
  /** Host/release-wrapper only. It is never installed on the Unified Host or Bridge surface. */
  readonly nativeReleaseObservations: SessionIdAcpProductionNativeReleaseObservationOwner;
}>;

export type SessionIdAcpProductionProviderOwnerOptions = Readonly<{
  readonly input: SessionIdUnifiedAcpProviderFactoryInput;
  readonly privateAuthority: AcpRuntimeHostPrivateAuthority;
  readonly configuration: AcpProductionConfiguration;
  readonly hostInputs: AcpProductionHostInputs;
  readonly providerSettings: SessionIdAcpProviderSettingsHost;
  /** Keeps the epoch authority sticky when construction cleanup is ambiguous. */
  readonly retainPrivateAuthority: () => void;
  readonly effectDeadlineMs?: number;
  readonly onHumanOnlyDiagnostic?: Parameters<
    typeof createSessionIdAcpProductionPolicyOwner
  >[0]["onHumanOnlyDiagnostic"];
  /** Host-process-only safe diagnostic sink; never crosses the Runtime Bridge. */
  readonly onDiagnostic?: (diagnostic: Readonly<{
    code: string;
    role?: string;
    stage?: string;
  }>) => void;
}>;

/**
 * The single concrete ACP production owner factory used by the executable Host
 * and release-only wrappers. It owns policy, Task Binding context, concrete
 * factories, Meta and the production release-observation authority once.
 */
export async function createSessionIdAcpProductionProviderOwner(
  options: SessionIdAcpProductionProviderOwnerOptions,
): Promise<SessionIdAcpProductionProviderOwner> {
  validateOptions(options);
  let attachment: SessionIdUnifiedAcpProviderAttachment | undefined;
  let taskBindingContext: ReturnType<typeof createSessionIdAcpTaskBindingContextOwner> | undefined;
  let metaOwner: AcpProductionMetaOwner | undefined;
  const policy = createSessionIdAcpProductionPolicyOwner({
    bindings: Object.freeze({
      getBinding: options.input.repositories.binding.getBinding,
      getCurrentBinding: options.input.repositories.binding.getCurrentBinding,
    }),
    sessionRuntime: Object.freeze({
      getRuntime: options.input.repositories.sessionRuntime.getRuntime,
      getRuntimeForSession: options.input.repositories.sessionRuntime.getRuntimeForSession,
      getAttempt: options.input.repositories.sessionRuntime.getAttempt,
    }),
    resolveFrozenProfile: options.input.resolveFrozenProfileTuple,
    sessionRuntimeOwner: Object.freeze({
      handleInteractionRequested: options.input.sessionRuntimeOwner.handleInteractionRequested,
      handleFinalCandidate: options.input.sessionRuntimeOwner.handleFinalCandidate,
    }),
    async onHumanOnlyDiagnostic(value) {
      options.input.onHumanOnlyActivity(Object.freeze({
        ...value,
        scope: "task" as const,
      }));
      await options.onHumanOnlyDiagnostic?.(value);
    },
    onRuntimeInvalidation(value) {
      requiredAttachment().onRuntimeInvalidated("provider_fact", value.taskId);
    },
  });
  const taskNativeFactories = Object.freeze({
    opencode: createOpenCodeAcpProductionTaskNativeFactory(policy.openCode),
    codex: createCodexAcpProductionTaskNativeFactory(policy.codex),
    "claude-code": createClaudeCodeAcpProductionTaskNativeFactory(policy.claudeCode),
  });
  let composition: ReturnType<typeof createSessionIdAcpProductionComposition>;
  try {
    composition = createSessionIdAcpProductionComposition({
      configuration: options.configuration,
      hostInputs: options.hostInputs,
      privateAuthority: options.privateAuthority,
      repositories: options.input.repositories,
      sessionRuntimeOwner: options.input.sessionRuntimeOwner,
      resolveFrozenProfileTuple: options.input.resolveFrozenProfileTuple,
      resolveInterruptCorrelation: options.input.resolveInterruptCorrelation,
      resolveTaskStopControl: options.input.resolveTaskStopControl,
      resolveCloseControl: options.input.resolveCloseControl,
      authorizeRetiringBindingRecovery: options.input.authorizeRetiringBindingRecovery,
      resolveTaskBindingContext(value) {
        if (!taskBindingContext) throw new Error("session_id_acp_provider_runtime_not_attached");
        return taskBindingContext.resolveTaskBindingContext(value);
      },
      observeExecution: policy.observeExecution,
      observeFinalCandidate: policy.observeFinalCandidate,
      onDeliveryReceipt: options.input.onDeliveryReceipt,
      onBindingReady(event) {
        return requiredAttachment().onBindingReady(event);
      },
      ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      taskNativeFactories,
      createMetaOwner(value) {
        if (value.configuration !== options.configuration
          || value.hostInputs !== options.hostInputs
          || value.identityVaultResolver !== options.privateAuthority.metaIdentityVaults) {
          throw new Error("session_id_acp_meta_owner_scope_mismatch");
        }
        metaOwner = createAcpProductionMetaOwner({
          configuration: options.configuration,
          hostInputs: options.hostInputs,
          privateAuthority: options.privateAuthority,
          ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
          onHumanOnlyActivity(value) {
            options.input.onHumanOnlyActivity(Object.freeze({
              ...value,
              scope: "meta" as const,
            }));
            requiredAttachment().onRuntimeInvalidated("provider_fact");
          },
        });
        return Object.freeze({ status: "configured" as const, owner: metaOwner });
      },
      effectDeadlineMs: options.effectDeadlineMs ?? DEFAULT_EFFECT_DEADLINE_MS,
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...Object.values(taskNativeFactories).map((factory) => factory.close()),
      ...(metaOwner ? [metaOwner.close()] : []),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      options.retainPrivateAuthority();
      throw new Error("session_id_acp_provider_construction_cleanup_unconfirmed");
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const registrationByOptionId = new Map<string, AcpMetaAgentRegistration>();
  const additionalMetaOwners: AcpProductionMetaOwner[] = [];
  const initialMetaAgentRegistrations = Object.freeze([...(metaOwner?.registrations ?? [])]);
  for (const registration of initialMetaAgentRegistrations) {
    registrationByOptionId.set(registration.option.metaProfileOptionId, registration);
  }
  let activeMetaAgentRegistrations = initialMetaAgentRegistrations;
  const owner: SessionIdAcpProductionProviderOwner = Object.freeze({
    provider: composition.taskSessionRuntimeProvider,
    metaAgentRegistrations: initialMetaAgentRegistrations,
    get configuredProviderFamilies() {
      return Object.freeze([
        ...(options.hostInputs.openCode() ? ["opencode" as const] : []),
        ...(options.hostInputs.codex() ? ["codex" as const] : []),
        ...(options.hostInputs.claudeCode() ? ["claude-code" as const] : []),
      ]);
    },
    readProviderSetup: options.providerSettings.read,
    discoverProviderInstallation: options.providerSettings.discover,
    configureProviderInstallation: options.providerSettings.configure,
    recordProviderModelCatalog: options.providerSettings.recordModelCatalog,
    configureProviderChatModels: options.providerSettings.configureChatModels,
    syncMetaAgentRegistrations,
    readActiveMetaAgentRegistrations() {
      return activeMetaAgentRegistrations;
    },
    async inspectProviderModelCatalog(providerFamily) {
      const result = await composition.inspectProviderModelCatalog(providerFamily);
      if (!result.available) {
        throw new Error(result.unavailableReasons[0] ?? "acp_provider_model_catalog_unavailable");
      }
      return result.modelCatalog;
    },
    nativeReleaseObservations: composition.nativeReleaseObservations,
    readCachedProfileReadiness(
      value: Parameters<SessionIdUnifiedAcpProviderOwner["readCachedProfileReadiness"]>[0],
    ) {
      const role = value.role === "conductor"
        ? "conductor"
        : value.role === "publisher"
          ? "publisher"
          : value.role === "reviewer"
            ? "reviewer"
            : "worker";
      const readiness = composition.readTaskProfileReadiness(value.profile, role);
      return readiness.role === value.role
        ? readiness
        : Object.freeze({ ...readiness, role: value.role });
    },
    async checkProfileReadiness(value) {
      const role = value.role === "conductor"
        ? "conductor"
        : value.role === "publisher"
          ? "publisher"
          : value.role === "reviewer"
            ? "reviewer"
            : "worker";
      const readiness = await composition.checkTaskProfileReadiness(
        value.profile,
        role,
        { force: true },
      );
      return readiness.role === value.role
        ? readiness
        : Object.freeze({ ...readiness, role: value.role });
    },
    attachRuntime(value: SessionIdUnifiedAcpProviderAttachment) {
      if (attachment || taskBindingContext) {
        throw new Error("session_id_acp_provider_runtime_already_attached");
      }
      taskBindingContext = createSessionIdAcpTaskBindingContextOwner({
        repositories: options.input.taskBindingContext.repositories,
        workspaceDirectoryResolver: options.input.taskBindingContext.workspaceDirectoryResolver,
        acpApplication: value.acpApplication,
        privateAuthority: options.privateAuthority,
        onRuntimeInvalidated() {
          value.onRuntimeInvalidated("provider_effect");
        },
        ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      });
      attachment = value;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const dynamicCleanup = await Promise.allSettled(
          additionalMetaOwners.map((dynamicOwner) => dynamicOwner.close()),
        );
        if (dynamicCleanup.some((result) => result.status === "rejected")) {
          throw new Error("session_id_acp_provider_cleanup_unconfirmed");
        }
        let failure: unknown;
        try {
          await composition.close();
        } catch (error) {
          failure = error;
        } finally {
          try {
            taskBindingContext?.close();
          } catch (error) {
            failure ??= error;
          } finally {
            taskBindingContext = undefined;
          }
        }
        if (failure) throw failure;
      })();
      return closePromise;
    },
  });
  return owner;

  function requiredAttachment(): SessionIdUnifiedAcpProviderAttachment {
    if (!attachment) throw new Error("session_id_acp_provider_runtime_not_attached");
    return attachment;
  }

  function syncMetaAgentRegistrations(): readonly AcpMetaAgentRegistration[] {
    const configuration = loadAcpProductionConfigurationFromEnvironment(
      options.providerSettings.effectiveEnvironment(),
    );
    const missing = configuration.metaProfiles.filter((entry) => (
      !registrationByOptionId.has(entry.metaProfileOptionId)
    ));
    if (missing.length) {
      const dynamicOwner = createAcpProductionMetaOwner({
        configuration: Object.freeze({
          schemaVersion: 1 as const,
          agents: configuration.agents,
          metaProfiles: Object.freeze(missing),
        }),
        hostInputs: options.hostInputs,
        privateAuthority: options.privateAuthority,
        ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
        onHumanOnlyActivity(value) {
          options.input.onHumanOnlyActivity(Object.freeze({
            ...value,
            scope: "meta" as const,
          }));
          requiredAttachment().onRuntimeInvalidated("provider_fact");
        },
      });
      additionalMetaOwners.push(dynamicOwner);
      for (const registration of dynamicOwner.registrations) {
        if (registrationByOptionId.has(registration.option.metaProfileOptionId)) {
          void dynamicOwner.close();
          throw new Error("session_id_acp_meta_profile_registration_conflict");
        }
        registrationByOptionId.set(registration.option.metaProfileOptionId, registration);
      }
    }
    activeMetaAgentRegistrations = Object.freeze(configuration.metaProfiles.map((entry) => {
      const registration = registrationByOptionId.get(entry.metaProfileOptionId);
      if (!registration) throw new Error("session_id_acp_meta_profile_registration_missing");
      return registration;
    }));
    return activeMetaAgentRegistrations;
  }
}

function validateOptions(options: SessionIdAcpProductionProviderOwnerOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || !hasOnlyKeys(options, OWNER_OPTION_KEYS)
    || !options.input || typeof options.input !== "object" || Array.isArray(options.input)
    || !hasExactKeys(options.input, PROVIDER_INPUT_KEYS)
    || !options.input.taskBindingContext
    || typeof options.input.taskBindingContext !== "object"
    || Array.isArray(options.input.taskBindingContext)
    || !hasExactKeys(options.input.taskBindingContext, [
      "repositories",
      "workspaceDirectoryResolver",
    ])
    || !options.input.repositories
    || !options.input.sessionRuntimeOwner
    || !options.input.taskBindingContext.repositories
    || !options.input.taskBindingContext.workspaceDirectoryResolver
    || !requiredRuntimeInstanceId(options.input.runtimeInstanceId)
    || typeof options.input.now !== "function"
    || typeof options.input.createId !== "function"
    || typeof options.input.resolveFrozenProfileTuple !== "function"
    || typeof options.input.resolveInterruptCorrelation !== "function"
    || typeof options.input.resolveTaskStopControl !== "function"
    || typeof options.input.resolveCloseControl !== "function"
    || typeof options.input.authorizeRetiringBindingRecovery !== "function"
    || typeof options.input.onDeliveryReceipt !== "function"
    || typeof options.input.onHumanOnlyActivity !== "function"
    || !options.privateAuthority
    || typeof options.privateAuthority !== "object"
    || Array.isArray(options.privateAuthority)
    || !hasExactKeys(options.privateAuthority, PRIVATE_AUTHORITY_KEYS)
    || typeof options.privateAuthority.taskIdentityVaults !== "function"
    || typeof options.privateAuthority.metaIdentityVaults !== "function"
    || !options.privateAuthority.taskPrivateRootAuthority
    || !options.privateAuthority.metaPrivateRootAuthority
    || typeof options.privateAuthority.recoveryObservation !== "function"
    || typeof options.privateAuthority.authorizeRetiringBindingRecovery !== "function"
    || typeof options.privateAuthority.close !== "function"
    || typeof options.privateAuthority.toJSON !== "function"
    || !options.configuration
    || typeof options.configuration !== "object"
    || Array.isArray(options.configuration)
    || !hasExactKeys(options.configuration, ["agents", "metaProfiles", "schemaVersion"])
    || options.configuration.schemaVersion !== 1
    || !options.configuration.agents
    || typeof options.configuration.agents !== "object"
    || Array.isArray(options.configuration.agents)
    || !hasOnlyKeys(options.configuration.agents, ["claudeCode", "codex", "opencode"])
    || !Array.isArray(options.configuration.metaProfiles)
    || !options.hostInputs
    || typeof options.hostInputs !== "object"
    || Array.isArray(options.hostInputs)
    || !hasExactKeys(options.hostInputs, ["claudeCode", "codex", "openCode", "toJSON"])
    || typeof options.hostInputs.openCode !== "function"
    || typeof options.hostInputs.codex !== "function"
    || typeof options.hostInputs.claudeCode !== "function"
    || typeof options.hostInputs.toJSON !== "function"
    || !options.providerSettings
    || typeof options.providerSettings !== "object"
    || Array.isArray(options.providerSettings)
    || !hasExactKeys(options.providerSettings, [
      "configure",
      "discover",
      "effectiveEnvironment",
      "configureChatModels",
      "read",
      "recordModelCatalog",
      "toJSON",
    ])
    || typeof options.providerSettings.read !== "function"
    || typeof options.providerSettings.discover !== "function"
    || typeof options.providerSettings.configure !== "function"
    || typeof options.providerSettings.recordModelCatalog !== "function"
    || typeof options.providerSettings.configureChatModels !== "function"
    || typeof options.retainPrivateAuthority !== "function"
    || (options.effectDeadlineMs !== undefined
      && (!Number.isSafeInteger(options.effectDeadlineMs)
        || options.effectDeadlineMs < 1
        || options.effectDeadlineMs > 10 * 60_000))
    || (options.onHumanOnlyDiagnostic !== undefined
      && typeof options.onHumanOnlyDiagnostic !== "function")
    || (options.onDiagnostic !== undefined
      && typeof options.onDiagnostic !== "function")) {
    throw new Error("session_id_acp_production_provider_owner_options_invalid");
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function requiredRuntimeInstanceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 256
    && /^runtime_instance_[A-Za-z0-9_-]+$/u.test(value);
}
