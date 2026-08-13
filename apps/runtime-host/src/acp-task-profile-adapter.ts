import type {
  AcpSessionConfigurationIntent,
  AcpSessionObservation,
  AcpV1Capability,
} from "@agent-workspace/provider-acp";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import {
  createAcpProviderComposition,
  type AcpCredentialAcquisitionOperation,
  type AcpProviderAvailabilityReport,
  type AcpProviderComposition,
  type AcpProviderProbeContext,
  type AcpQualificationEffectBudget,
  type AcpTargetCheckpointObserver,
} from "./acp-provider-composition.js";
import {
  createAcpBindingPrivateStorageRegistry,
  type AcpBindingPrivateStorageLease,
  type AcpBindingPrivateStorageRegistry,
} from "./acp-binding-private-storage.js";
import {
  createAcpAgentProcessFactory,
  type AcpAgentIdentityVaultResolver,
  type AcpAgentProcessFactory,
  type AcpStdioConnectionFactory,
} from "./acp-agent-process.js";
import type {
  AcpCurrentInstallDescriptor,
} from "./acp-profile-resolution.js";
import type { ProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";
import type { AcpTaskRole } from "./acp-task-role.js";
import type {
  AcpTaskScopedMcpBinding,
  AcpTaskScopedMcpRole,
} from "./acp-task-scoped-mcp.js";
import {
  acpTaskReportHasUnconfirmedCleanup as reportHasUnconfirmedCleanup,
  acpTaskQualificationBehaviors,
  assertAcpTaskProfile,
  canonicalAcpTaskWorkspace,
  createAcpTaskBindingRuntime,
  createAcpTaskQualificationWorkingDirectory,
  normalizeAcpTaskBindingDisposition,
  normalizeAcpTaskCapabilities,
  normalizeAcpTaskRole,
  normalizeAcpTaskSessionConfiguration,
  requiredAcpTaskOpaqueId,
  runAcpTaskQualificationProbe,
  runAcpTaskOwnedCleanup as runOwnedCleanup,
  type AcpTaskBindingRuntime,
  type AcpTaskQualificationProbe,
  type AcpTaskQualificationWorkingDirectory,
  type AcpTaskReadinessRegistry,
  type AcpTaskPromptReconciler,
  type AcpTaskRuntimeDiagnostic,
} from "./acp-task-profile-runtime.js";

const DEFAULT_REQUIRED_CAPABILITIES = Object.freeze([
  "session_new",
  "session_prompt",
  "session_cancel",
  "session_update",
  "session_load",
  "session_resume",
  "session_close",
  "mcp_stdio",
  "permission",
] as const satisfies readonly AcpV1Capability[]);

export type AcpTaskProfileDriver<
  TCurrentInstall,
  TCredentialAcquisition,
  TScope extends AcpTaskScopedMcpRole,
  TProviderFamily extends ExecutionProfileDefinitionV3["providerFamily"],
  TAcpAgentKind extends ExecutionProfileDefinitionV3["acpAgentKind"],
> = Readonly<{
  readonly providerFamily: TProviderFamily;
  readonly acpAgentKind: TAcpAgentKind;
  readonly errorPrefix: string;
  readonly toolMatch: "ordered" | "exact_set";
  readonly qualificationFlow: "readiness_then_target" | "target_only";
  readonly qualificationPermissionChoiceKind?: "allow_once";
  readonly qualificationDirectoryPrefix: string;
  readonly defaultQualificationAttemptId: string;
  createError(suffix: string): Error;
  isTaskProfileError(error: unknown): boolean;
  createScopedMcpRole(input: Readonly<{
    role: AcpTaskRole;
    bridge?: ProviderScopedMcpBridge;
  }>): TScope;
  createDescriptor(
    currentInstall: TCurrentInstall,
    scope: TScope,
  ): AcpCurrentInstallDescriptor<ExecutionProfileDefinitionV3>;
  createConnection(): AcpStdioConnectionFactory;
  beginCredentialAcquisition(
    options: TCredentialAcquisition,
    providerDataDirectory?: string,
  ): AcpCredentialAcquisitionOperation;
  privateRootParent(options: TCredentialAcquisition): string;
  readinessKey(input: Readonly<{
    profile: ExecutionProfileDefinitionV3;
    role: AcpTaskRole;
    currentInstall: TCurrentInstall;
    credentialAcquisition: TCredentialAcquisition;
    requiredCapabilities: readonly AcpV1Capability[];
  }>): string;
}>;

export type AcpTaskProfileAdapterOptions<
  TCurrentInstall,
  TCredentialAcquisition,
  TScope extends AcpTaskScopedMcpRole,
> = Readonly<{
  readonly profile: ExecutionProfileDefinitionV3;
  readonly role: AcpTaskRole;
  readonly workspaceDirectory: string;
  readonly bindingDisposition: "create" | "load" | "resume";
  readonly currentInstall: TCurrentInstall;
  readonly credentialAcquisition: TCredentialAcquisition;
  readonly sessionConfiguration?: AcpSessionConfigurationIntent;
  readonly requiredCapabilities?: readonly AcpV1Capability[];
  readonly bridge?: ProviderScopedMcpBridge;
  readonly scopedMcpRoles?: Readonly<{
    readonly target: TScope;
    readonly readiness: TScope;
  }>;
  readonly composition?: AcpProviderComposition;
  readonly identityVaultResolver?: AcpAgentIdentityVaultResolver;
  readonly createProcessFactory?: (
    identityVaultResolver: AcpAgentIdentityVaultResolver | undefined,
  ) => AcpAgentProcessFactory;
  readonly bindingPrivateStorageRegistry?: AcpBindingPrivateStorageRegistry;
  readonly readinessRegistry?: AcpTaskReadinessRegistry;
  readonly createQualificationAttemptId?: () => string;
  readonly createQualificationProbe?: () => AcpTaskQualificationProbe;
  readonly reconciler?: AcpTaskPromptReconciler;
  readonly onObservation?: (observation: AcpSessionObservation) => void | Promise<void>;
  readonly onDiagnostic?: (diagnostic: AcpTaskRuntimeDiagnostic) => void;
  readonly beforeQualificationEffect?: AcpQualificationEffectBudget;
}>;

export type AcpTaskProfileOpenResult<
  TProviderFamily extends ExecutionProfileDefinitionV3["providerFamily"],
  TAcpAgentKind extends ExecutionProfileDefinitionV3["acpAgentKind"],
> =
  | Readonly<{
      readonly available: true;
      readonly runtime: AcpTaskBindingRuntime<TProviderFamily, TAcpAgentKind>;
      readonly report: AcpProviderAvailabilityReport;
    }>
  | Readonly<{
      readonly available: false;
      readonly report: AcpProviderAvailabilityReport;
    }>;

export type AcpTaskProfileAdapter<
  TProviderFamily extends ExecutionProfileDefinitionV3["providerFamily"],
  TAcpAgentKind extends ExecutionProfileDefinitionV3["acpAgentKind"],
> = Readonly<{
  readonly role: AcpTaskRole;
  openBinding(input: Readonly<{ bindingHandle: string }>): Promise<
    AcpTaskProfileOpenResult<TProviderFamily, TAcpAgentKind>
  >;
  safeObservation(): Readonly<{
    readonly role: AcpTaskRole;
    readonly processOpenEffectCount: number;
    readonly qualificationPromptEffectCount: number;
    readonly businessPromptEffectCount: number;
    readonly readinessReused: boolean;
  }>;
  close(): Promise<void>;
}>;

export function createAcpTaskProfileAdapter<
  TCurrentInstall,
  TCredentialAcquisition,
  TScope extends AcpTaskScopedMcpRole,
  TProviderFamily extends ExecutionProfileDefinitionV3["providerFamily"],
  TAcpAgentKind extends ExecutionProfileDefinitionV3["acpAgentKind"],
>(
  driver: AcpTaskProfileDriver<
    TCurrentInstall,
    TCredentialAcquisition,
    TScope,
    TProviderFamily,
    TAcpAgentKind
  >,
  options: AcpTaskProfileAdapterOptions<TCurrentInstall, TCredentialAcquisition, TScope>,
): AcpTaskProfileAdapter<TProviderFamily, TAcpAgentKind> {
  const role = normalizeAcpTaskRole(options?.role, driver.createError);
  assertAcpTaskProfile({
    profile: options.profile,
    role,
    providerFamily: driver.providerFamily,
    acpAgentKind: driver.acpAgentKind,
    createError: driver.createError,
  });
  const disposition = normalizeAcpTaskBindingDisposition(options?.bindingDisposition, driver.createError);
  if (options.beforeQualificationEffect !== undefined
    && typeof options.beforeQualificationEffect !== "function") {
    throw driver.createError("qualification_effect_budget_invalid");
  }
  const suppliedScopes = options.scopedMcpRoles;
  if (suppliedScopes && (
    suppliedScopes.target === suppliedScopes.readiness
    || suppliedScopes.target?.role !== role
    || suppliedScopes.readiness?.role !== role
  )) {
    throw driver.createError("task_scoped_role_mismatch");
  }
  const scope = suppliedScopes?.target
    ?? driver.createScopedMcpRole({ role, ...(options.bridge ? { bridge: options.bridge } : {}) });
  const readinessScope = suppliedScopes?.readiness
    ?? driver.createScopedMcpRole({
      role,
      ...(options.bridge ? { bridge: options.bridge } : {}),
    });
  const descriptor = driver.createDescriptor(options.currentInstall, scope);
  const readinessDescriptor = driver.createDescriptor(options.currentInstall, readinessScope);
  if (options.composition && (options.identityVaultResolver
    || options.createProcessFactory || options.beforeQualificationEffect)) {
    throw driver.createError("task_composition_vault_conflict");
  }
  if (options.beforeQualificationEffect && options.createProcessFactory) {
    throw driver.createError("qualification_effect_budget_controlled_conflict");
  }
  const composition = options.composition ?? createAcpProviderComposition({
    processes: options.createProcessFactory
      ? options.createProcessFactory(options.identityVaultResolver)
      : createAcpAgentProcessFactory({
          ...(options.identityVaultResolver
            ? { identityVaultResolver: options.identityVaultResolver }
            : {}),
        }),
    ...(options.beforeQualificationEffect
      ? { beforeQualificationEffect: options.beforeQualificationEffect }
      : {}),
  });
  const ownsComposition = options.composition === undefined;
  if (ownsComposition && disposition !== "create" && !options.identityVaultResolver) {
    throw driver.createError("task_durable_identity_vault_required");
  }
  const sessionConfiguration = normalizeAcpTaskSessionConfiguration(
    options.sessionConfiguration ?? Object.freeze({
      model: options.profile.model,
      options: Object.freeze([]),
    }),
    options.profile.model,
    driver.createError,
  );
  const requiredCapabilities = normalizeAcpTaskCapabilities(
    options.requiredCapabilities ?? [
      ...DEFAULT_REQUIRED_CAPABILITIES,
      ...(scope.registration ? ["mcp_http" as const] : []),
    ],
    driver.createError,
  );
  const reverseRegistration = scope.createReverseRpcRegistration();
  const readinessReverseRegistration = readinessScope.createReverseRpcRegistration();
  const bindingPrivateStorageRegistry = options.bindingPrivateStorageRegistry
    ?? createAcpBindingPrivateStorageRegistry({
    parentDirectory: driver.privateRootParent(options.credentialAcquisition),
  });
  const createQualificationAttemptId = options.createQualificationAttemptId
    ?? (() => driver.defaultQualificationAttemptId);
  const readinessCacheKey = driver.readinessKey({
    profile: options.profile,
    role,
    currentInstall: options.currentInstall,
    credentialAcquisition: options.credentialAcquisition,
    requiredCapabilities,
  });
  const probeObservations: AcpSessionObservation[] = [];
  const turnObservations = new Map<string, AcpSessionObservation[]>();
  const qualificationAttemptIds = new Set<string>();
  let scopeBinding: AcpTaskScopedMcpBinding | undefined;
  let readinessScopeBinding: AcpTaskScopedMcpBinding | undefined;
  let bindingPrivateStorageLease: AcpBindingPrivateStorageLease | undefined;
  let qualificationWorkingDirectory: AcpTaskQualificationWorkingDirectory | undefined;
  let targetQualificationWorkingDirectory: AcpTaskQualificationWorkingDirectory | undefined;
  let openedRuntime: AcpTaskBindingRuntime<TProviderFamily, TAcpAgentKind> | undefined;
  let openStarted = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let processOpenEffectCount = 0;
  let qualificationPromptEffectCount = 0;
  let businessPromptEffectCount = 0;
  let readinessReused = false;
  let targetCheckpointObserver: AcpTargetCheckpointObserver | undefined;
  let qualificationPermissionScope: Readonly<{
    readonly client: AcpProviderProbeContext["client"];
    readonly bindingHandle: string;
    readonly attemptId: string;
    readonly maxResponses: number;
    readonly interactionIds: Set<string>;
  }> | undefined;
  let qualificationPermissionResponses = 0;

  const observeQualification = async (observation: AcpSessionObservation): Promise<void> => {
    probeObservations.push(observation);
    const permissionScope = qualificationPermissionScope;
    const choiceKind = driver.qualificationPermissionChoiceKind;
    if (choiceKind && observation.kind === "interaction_requested" && permissionScope
      && observation.bindingHandle === permissionScope.bindingHandle
      && observation.attemptId === permissionScope.attemptId) {
      if (permissionScope.interactionIds.has(observation.interactionId)
        || qualificationPermissionResponses >= permissionScope.maxResponses) {
        throw driver.createError("qualification_permission_limit_exceeded");
      }
      const choices = observation.choices.filter((choice) => choice.kind === choiceKind);
      if (choices.length !== 1) {
        throw driver.createError("qualification_permission_choice_unavailable");
      }
      permissionScope.interactionIds.add(observation.interactionId);
      await permissionScope.client.respondToInteraction({
        bindingHandle: permissionScope.bindingHandle,
        attemptId: permissionScope.attemptId,
        interactionId: observation.interactionId,
        choiceId: choices[0]!.choiceId,
      });
      qualificationPermissionResponses += 1;
    }
  };

  const performProbe = async (input: Readonly<{
    context: AcpProviderProbeContext;
    probeScope: TScope;
    providerWorkingDirectory: string;
    requiredBehaviors: readonly string[];
    setScopeBinding(binding: AcpTaskScopedMcpBinding | undefined): void;
  }>) => runAcpTaskQualificationProbe({
    ...input,
    sessionConfiguration,
    expectedModel: options.profile.model,
    createQualificationAttemptId,
    ...(options.createQualificationProbe
      ? { createQualificationProbe: options.createQualificationProbe }
      : {}),
    probeObservations,
    qualificationAttemptIds,
    toolMatch: driver.toolMatch,
    createError: driver.createError,
    recordQualificationPromptEffect: () => { qualificationPromptEffectCount += 1; },
    onAttemptActive: ({ context, attemptId, maxPermissionResponses }) => {
      qualificationPermissionResponses = 0;
      qualificationPermissionScope = maxPermissionResponses > 0
        ? Object.freeze({
            client: context.client,
            bindingHandle: context.bindingHandle,
            attemptId,
            maxResponses: maxPermissionResponses,
            interactionIds: new Set<string>(),
          })
        : undefined;
    },
    onAttemptInactive: () => { qualificationPermissionScope = undefined; },
  });
  const adapter: AcpTaskProfileAdapter<TProviderFamily, TAcpAgentKind> = Object.freeze({
    role,
    async openBinding(input) {
      if (closed) throw driver.createError("task_profile_closed");
      if (openStarted) throw driver.createError("task_profile_already_opened");
      openStarted = true;
      let bindingHandle: string;
      let taskWorkspaceDirectory: string;
      try {
        bindingHandle = requiredAcpTaskOpaqueId(
          input?.bindingHandle,
          () => driver.createError("binding_handle_invalid"),
        );
        taskWorkspaceDirectory = await canonicalAcpTaskWorkspace(options.workspaceDirectory, driver.createError);
        bindingPrivateStorageLease = await bindingPrivateStorageRegistry.acquire(bindingHandle);
        await bindingPrivateStorageLease.assertProcessWorkingDirectoryEmpty();
      } catch (error) {
        return failOpen(error, [
          () => readinessScope.close(),
          () => qualificationWorkingDirectory?.cleanup() ?? Promise.resolve(),
          () => bindingPrivateStorageLease?.releaseBinding() ?? Promise.resolve(),
          () => scope.close(),
          () => ownsComposition ? composition.close() : Promise.resolve(),
        ]);
      }
      if (driver.qualificationFlow === "readiness_then_target") {
        const readinessBehaviors = acpTaskQualificationBehaviors(
          driver.errorPrefix,
          "create",
          Boolean(readinessScope.registration),
        );
        let readinessReport: AcpProviderAvailabilityReport;
        const cachedReadiness = options.readinessRegistry?.read(readinessCacheKey);
        if (cachedReadiness) {
          readinessReused = true;
          readinessReport = cachedReadiness;
          if (!await runOwnedCleanup([() => readinessScope.close()])) {
            return failOpen(driver.createError("task_cleanup_unconfirmed"), [
              () => scope.close(),
              () => ownsComposition ? composition.close() : Promise.resolve(),
              () => bindingPrivateStorageLease!.releaseBinding(),
            ]);
          }
        } else {
          try {
            qualificationWorkingDirectory = await createAcpTaskQualificationWorkingDirectory({
              parentDirectory: driver.privateRootParent(options.credentialAcquisition),
              directoryPrefix: driver.qualificationDirectoryPrefix,
              createError: driver.createError,
              isTaskProfileError: driver.isTaskProfileError,
            });
            processOpenEffectCount += 1;
            readinessReport = await composition.checkReadiness({
              profile: options.profile,
              descriptor: readinessDescriptor,
              role,
              requiredAcpCapabilities: requiredCapabilities,
              requiredBehaviors: readinessBehaviors,
              workspaceDirectory: qualificationWorkingDirectory.directory,
              createConnection: driver.createConnection(),
              beginCredentialAcquisition: () => (
                driver.beginCredentialAcquisition(options.credentialAcquisition)
              ),
              managedClientOptions: { onObservation: observeQualification },
              ...(readinessReverseRegistration
                ? { createReverseRpcRegistration: () => readinessReverseRegistration }
                : {}),
              runProbe: (context) => performProbe({
                context,
                probeScope: readinessScope,
                providerWorkingDirectory: qualificationWorkingDirectory!.directory,
                requiredBehaviors: readinessBehaviors,
                setScopeBinding: (binding) => { readinessScopeBinding = binding; },
              }),
            });
          } catch (error) {
            return failOpen(error, [
              () => readinessScope.close(),
              () => scope.close(),
              () => ownsComposition ? composition.close() : Promise.resolve(),
              () => qualificationWorkingDirectory?.cleanup() ?? Promise.resolve(),
              () => bindingPrivateStorageLease!.releaseBinding(),
            ]);
          }
          const readinessScopeCleanupConfirmed = await runOwnedCleanup([
            () => readinessScope.close(),
          ]);
          let readinessProviderCleanupConfirmed = !reportHasUnconfirmedCleanup(readinessReport);
          let readinessCompositionCleanupConfirmed = true;
          if (!readinessProviderCleanupConfirmed && ownsComposition) {
            try {
              await composition.close();
              readinessProviderCleanupConfirmed = true;
            } catch {
              readinessCompositionCleanupConfirmed = false;
            }
          }
          let qualificationCwdCleanupConfirmed = false;
          if (readinessProviderCleanupConfirmed) {
            qualificationCwdCleanupConfirmed = await runOwnedCleanup([
              () => qualificationWorkingDirectory!.cleanup(),
            ]);
          }
          if (!readinessScopeCleanupConfirmed || !readinessCompositionCleanupConfirmed
            || !readinessProviderCleanupConfirmed || !qualificationCwdCleanupConfirmed) {
            closed = true;
            await runOwnedCleanup([
              () => scope.close(),
              () => ownsComposition ? composition.close() : Promise.resolve(),
              () => bindingPrivateStorageLease!.releaseBinding(),
            ]);
            throw driver.createError("task_cleanup_unconfirmed");
          }
          options.readinessRegistry?.record(readinessCacheKey, readinessReport);
        }
        readinessScopeBinding = undefined;
        probeObservations.length = 0;
        if (!readinessReport.available) {
          closed = true;
          const cleanupConfirmed = await runOwnedCleanup([
            () => scope.close(),
            () => ownsComposition ? composition.close() : Promise.resolve(),
            () => bindingPrivateStorageLease!.releaseBinding(),
          ]);
          if (!cleanupConfirmed) throw driver.createError("task_cleanup_unconfirmed");
          return Object.freeze({ available: false, report: readinessReport });
        }
      } else if (!await runOwnedCleanup([() => readinessScope.close()])) {
        return failOpen(driver.createError("task_cleanup_unconfirmed"), [
          () => scope.close(),
          () => ownsComposition ? composition.close() : Promise.resolve(),
          () => bindingPrivateStorageLease!.releaseBinding(),
        ]);
      }

      const providerWorkingDirectory = bindingPrivateStorageLease!.processWorkingDirectory;
      const requiredBehaviors = acpTaskQualificationBehaviors(driver.errorPrefix, disposition, Boolean(scope.registration));
      let generic;
      try {
        targetQualificationWorkingDirectory = await createAcpTaskQualificationWorkingDirectory({
          parentDirectory: driver.privateRootParent(options.credentialAcquisition),
          directoryPrefix: driver.qualificationDirectoryPrefix,
          createError: driver.createError,
          isTaskProfileError: driver.isTaskProfileError,
        });
        processOpenEffectCount += 1;
        generic = await composition.openBinding({
          bindingHandle,
          profile: options.profile,
          descriptor,
          role,
          requiredAcpCapabilities: requiredCapabilities,
          requiredBehaviors,
          workspaceDirectory: providerWorkingDirectory,
          createConnection: driver.createConnection(),
          beginCredentialAcquisition: () => driver.beginCredentialAcquisition(
            options.credentialAcquisition,
            bindingPrivateStorageLease!.providerDataDirectory,
          ),
          managedClientOptions: {
            onObservation: async (observation) => {
              if (qualificationAttemptIds.has(observation.attemptId)) {
                await observeQualification(observation);
              } else {
                const observations = turnObservations.get(observation.attemptId) ?? [];
                observations.push(observation);
                turnObservations.set(observation.attemptId, observations);
                await options.onObservation?.(observation);
              }
            },
          },
          ...(reverseRegistration
            ? { createReverseRpcRegistration: () => reverseRegistration }
            : {}),
          runProbe: (context) => performProbe({
              context,
              probeScope: scope,
              providerWorkingDirectory: targetQualificationWorkingDirectory!.directory,
              requiredBehaviors,
              setScopeBinding: (binding) => { scopeBinding = binding; },
            }),
          establishTargetBinding: async (context) => {
            if (context.bindingHandle !== bindingHandle) {
              throw driver.createError("target_binding_mismatch");
            }
            // Generic composition releases the temporary qualification Binding
            // and closes its reverse-RPC lease before invoking this seam. Close
            // the probe route, then bind the fresh exact target lease before the
            // real Task Binding is established without a prompt.
            await scopeBinding?.close();
            scopeBinding = undefined;
            if (scope.registration) {
              if (!context.reverseRpcLease
                || context.reverseRpcLease.bindingHandle !== bindingHandle) {
                throw driver.createError("target_reverse_rpc_missing");
              }
              scopeBinding = await scope.openBindingRoute({
                bindingHandle,
                reverseRpcLease: context.reverseRpcLease,
              });
            } else if (context.reverseRpcLease) {
              throw driver.createError("target_reverse_rpc_forbidden");
            }
            await targetQualificationWorkingDirectory!.cleanup();
            targetQualificationWorkingDirectory = undefined;
            const binding = await context.client.ensureBinding({
              bindingHandle,
              disposition,
              workspaceDirectory: taskWorkspaceDirectory,
              mcpServers: scopeBinding?.mcpServers ?? Object.freeze([]),
              configuration: sessionConfiguration,
            });
            if (binding.bindingHandle !== bindingHandle || binding.model !== options.profile.model) {
              throw driver.createError("target_binding_observation_invalid");
            }
            targetCheckpointObserver = context.checkpointObserver;
            if (targetCheckpointObserver && disposition !== "create"
              && businessPromptEffectCount === 0) {
              targetCheckpointObserver.observe({
                kind: "task_recovery_opened",
                bindingHandle,
                role,
                disposition,
                oldPromptReplayCount: 0,
              });
            }
            return Object.freeze({ bindingEstablished: true as const });
          },
        });
      } catch (error) {
        closed = true;
        const scopeCleanupConfirmed = await runOwnedCleanup([
          () => scopeBinding?.close() ?? Promise.resolve(),
          () => scope.close(),
        ]);
        let providerCleanupConfirmed = false;
        let compositionCleanupConfirmed = true;
        if (ownsComposition) {
          try {
            await composition.close();
            providerCleanupConfirmed = true;
          } catch {
            compositionCleanupConfirmed = false;
          }
        }
        let cwdCleanupConfirmed = false;
        if (providerCleanupConfirmed) {
          cwdCleanupConfirmed = await runOwnedCleanup([
            () => bindingPrivateStorageLease!.releaseBinding(),
          ]);
        }
        if (!scopeCleanupConfirmed || !compositionCleanupConfirmed
          || !providerCleanupConfirmed || !cwdCleanupConfirmed) {
          throw driver.createError("task_cleanup_unconfirmed");
        }
        throw error;
      }
      probeObservations.length = 0;
      if (!generic.available) {
        closed = true;
        const scopeCleanupConfirmed = await runOwnedCleanup([
          () => scopeBinding?.close() ?? Promise.resolve(),
          () => scope.close(),
        ]);
        let providerCleanupConfirmed = !reportHasUnconfirmedCleanup(generic.report);
        let compositionCleanupConfirmed = true;
        if (ownsComposition) {
          try {
            await composition.close();
            providerCleanupConfirmed = true;
          } catch {
            compositionCleanupConfirmed = false;
          }
        }
        let cwdCleanupConfirmed = false;
        if (providerCleanupConfirmed) {
          cwdCleanupConfirmed = await runOwnedCleanup([
            () => targetQualificationWorkingDirectory?.cleanup() ?? Promise.resolve(),
            () => bindingPrivateStorageLease!.releaseBinding(),
          ]);
          if (cwdCleanupConfirmed) targetQualificationWorkingDirectory = undefined;
        }
        if (!scopeCleanupConfirmed || !compositionCleanupConfirmed
          || !providerCleanupConfirmed || !cwdCleanupConfirmed) {
          throw driver.createError("task_cleanup_unconfirmed");
        }
        return generic;
      }
      try {
        await generic.runtime.assertQualified();
      } catch (error) {
        closed = true;
        const scopeCleanupConfirmed = await runOwnedCleanup([
          () => scopeBinding?.close() ?? Promise.resolve(),
          () => scope.close(),
        ]);
        let providerCleanupConfirmed = true;
        try {
          await generic.runtime.close();
        } catch {
          providerCleanupConfirmed = false;
        }
        let compositionCleanupConfirmed = true;
        if (ownsComposition) {
          try {
            await composition.close();
          } catch {
            compositionCleanupConfirmed = false;
          }
        }
        let cwdCleanupConfirmed = false;
        if (providerCleanupConfirmed) {
          cwdCleanupConfirmed = await runOwnedCleanup([
            () => bindingPrivateStorageLease!.releaseBinding(),
          ]);
        }
        if (!scopeCleanupConfirmed || !compositionCleanupConfirmed
          || !providerCleanupConfirmed || !cwdCleanupConfirmed) {
          throw driver.createError("task_cleanup_unconfirmed");
        }
        throw error;
      }
      openedRuntime = createAcpTaskBindingRuntime({
        profile: options.profile,
        role,
        providerFamily: driver.providerFamily,
        acpAgentKind: driver.acpAgentKind,
        generic: generic.runtime,
        getScopeBinding: () => scopeBinding,
        turnObservations,
        qualificationAttemptIds,
        reconciler: options.reconciler,
        checkpointObserver: targetCheckpointObserver,
        createError: driver.createError,
        recordBusinessPromptEffect: () => { businessPromptEffectCount += 1; },
        preparePrivateWorkingDirectory: bindingPrivateStorageLease!.prepareForRestart,
        releasePrivateWorkingDirectory: bindingPrivateStorageLease!.releaseBinding,
        ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
      });
      return Object.freeze({
        available: true,
        runtime: openedRuntime,
        report: generic.report,
      });
    },
    safeObservation: () => Object.freeze({
      role,
      processOpenEffectCount,
      qualificationPromptEffectCount,
      businessPromptEffectCount,
      readinessReused,
    }),
    close() {
      closePromise ??= (async () => {
        closed = true;
        const cleanupConfirmed = await runOwnedCleanup([
          () => openedRuntime?.close() ?? Promise.resolve(),
          () => readinessScope.close(),
          () => qualificationWorkingDirectory?.cleanup() ?? Promise.resolve(),
          () => scope.close(),
          () => ownsComposition ? composition.close() : Promise.resolve(),
        ]);
        if (!cleanupConfirmed) throw driver.createError("task_cleanup_unconfirmed");
      })();
      return closePromise;
    },
  });
  return adapter;

  async function failOpen(
    error: unknown,
    cleanupActions: readonly (() => Promise<void>)[],
  ): Promise<never> {
    closed = true;
    if (!await runOwnedCleanup(cleanupActions)) {
      throw driver.createError("task_cleanup_unconfirmed");
    }
    throw error;
  }
}
