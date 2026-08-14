import { createHash, randomUUID } from "node:crypto";
import { validateAcpProfileReadinessObservation } from "@agent-workspace/runtime-contracts";
import type { AcpModelCatalogEntry } from "@agent-workspace/provider-acp";
import type {
  AcpProviderInstallationInput,
  AcpProfileReadinessObservation,
  AcpProviderSettingsReadModel,
  AgentCardDefinition,
  ExecutionProfileDefinitionV3,
  MetaPatchOperation,
  SessionRuntimeBindingReadyEvent,
  SessionRuntimeProviderEffectIntentRecord,
  SessionIdAcpTaskReadModel,
  SessionIdHumanMessageCommand,
  SessionIdRespondInteractionCommand,
  ProviderFamily,
  JsonObject,
  RuntimeCommand,
  TaskSetupDraftRecord,
  TemplateDefinitionV3,
  TemplateDraftRecord,
  TemplateVersionRecord,
} from "@agent-workspace/runtime-contracts";
import {
  BUILT_IN_TEMPLATE_PROFILE_OPTIONS,
  createAcpV3FrozenProfileTupleResolver,
  createSessionIdAcpTaskReadProjector,
  type AcpMetaAgentRegistration,
  type SessionIdAcpHumanInterruptResult,
  type SessionIdAcpRendererCommandResult,
  type SessionIdAcpTaskInputCommand,
  type SessionIdConfigurationTaskLifecycleCommand,
  type SessionIdConfigurationTaskLifecycleReadModel,
  type SessionIdConfigurationTaskLifecycleResult,
} from "@agent-workspace/runtime-application";
import {
  createAcpSessionRuntimeRepositories,
  createRuntimeRepositories,
  createSessionIdCanonicalStore,
  SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";
import type {
  SessionIdAcpTaskStopCommand,
  SessionIdAcpTaskStopResult,
} from "../../../packages/runtime-application/src/session-id-acp-task-stop-application.js";
import {
  createSessionIdAcpApplicationAssembly,
  type SessionIdAcpApplicationProviderFactoryInput,
  type SessionIdAcpApplicationProviderOwner,
  type SessionIdAcpApplicationReady,
  type SessionIdAcpRunApplication,
} from "./session-id-acp-application-assembly.js";
import { createSessionIdAcpTaskLifecycleHost } from "./session-id-acp-task-lifecycle-host.js";
import {
  createSessionIdAcpHumanActivityOwner,
  type SessionIdAcpHumanActivityInput,
} from "./session-id-acp-human-activity-owner.js";
import type { SessionIdAcpTaskBindingContextRepositories } from "./session-id-acp-task-binding-context.js";
import type { SessionIdAcpProviderSetupSnapshot } from "./session-id-acp-provider-settings-host.js";
import { createNodeSessionIdAcpWorkspacePreviewOwner } from "./session-id-acp-workspace-preview-port.js";
import { createSessionIdAuthenticatedCommandLedger } from "./session-id-authenticated-command-ledger.js";
import { createSessionIdConfigurationTaskLifecycleHost } from "./session-id-configuration-task-lifecycle-host.js";
import {
  sessionIdObservedLineageDigest,
  type SessionIdObservedLineage,
} from "./session-id-observed-lineage.js";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";

const LIFECYCLE_COMMAND_TYPES = new Set<string>([
  "template.create_draft",
  "template.save_draft",
  "template.migrate_v2_to_v3_draft",
  "template.publish_draft",
  "template.archive",
  "template.import",
  "template.export",
  "task_setup.create_draft",
  "task_setup.save_draft",
  "task_setup.abandon_draft",
  "meta.create_session",
  "meta.send_message",
  "meta.abandon_session",
  "meta.apply_patch",
  "meta.reject_patch",
  "task.create",
  "task.start",
  "task.resume",
  "task.restart",
  "task.achieve",
  "task.archive",
  "task.restore",
  "task.preview_permanent_delete",
  "task.permanently_delete",
]);

type RendererLifecycleCommand = Exclude<
  SessionIdConfigurationTaskLifecycleCommand,
  { type: "workspace.authorize" }
>;

type RendererTaskInputCommand = Readonly<{
  type: "task.submit_input";
  issuedAt: string;
}> & SessionIdAcpTaskInputCommand;

type RendererHumanMessageCommand = SessionIdHumanMessageCommand & Readonly<{
  issuedAt: string;
}>;

type RendererHumanInterruptCommand = Readonly<{
  type: "session.request_interrupt";
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  targetLogicalSessionId: string;
  humanInterventionId: string;
  idempotencyKey: string;
  issuedAt: string;
}>;

type RendererInteractionCommand = SessionIdRespondInteractionCommand & Readonly<{
  issuedAt: string;
}>;

type RendererWorkspacePreviewCommand = Readonly<{
  type: "workspace.preview_file";
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  observationId: string;
  issuedAt: string;
}>;

type RendererTaskStopCommand = Omit<SessionIdAcpTaskStopCommand, "idempotencyKey">;

type RendererProviderCommand = Extract<RuntimeCommand, {
  type:
    | "provider.probe_models"
    | "provider.discover_installation"
    | "provider.configure_installation"
    | "provider.configure_chat_models";
}>;

export type SessionIdUnifiedRendererCommand =
  | (RendererLifecycleCommand & Readonly<{ uiIntentId: string }>)
  | (RendererTaskInputCommand & Readonly<{ uiIntentId: string }>)
  | (RendererHumanMessageCommand & Readonly<{ uiIntentId: string }>)
  | (RendererHumanInterruptCommand & Readonly<{ uiIntentId: string }>)
  | (RendererInteractionCommand & Readonly<{ uiIntentId: string }>)
  | (RendererTaskStopCommand & Readonly<{ uiIntentId: string }>)
  | (RendererWorkspacePreviewCommand & Readonly<{ uiIntentId: string }>)
  | (RendererProviderCommand & Readonly<{ uiIntentId: string }>);

export type SessionIdUnifiedWorkspaceReadModel = Readonly<{
  generatedAt: string;
  tasks: readonly Readonly<{
    taskId: string;
    title: string;
    goal: string;
    revision: number;
    status: string;
    createdAt: string;
    updatedAt: string;
    trashedAt?: string;
    activeRun?: Readonly<{ runId: string; status: string }>;
    availableLifecycleActions: readonly ("start" | "resume" | "restart")[];
    achievement?: SessionIdConfigurationTaskLifecycleReadModel["taskLibrary"][number]["achievement"];
  }>[];
  taskSetupOptions: Readonly<{
    workspaces: readonly Readonly<{ workspaceId: string; displayName: string }>[];
    templates: readonly Readonly<{
      templateId: string;
      title: string;
      activeTemplateVersionId?: string;
      versions: readonly Readonly<{ templateVersionId: string; version: number }>[];
    }>[];
  }>;
}>;

export type SessionIdUnifiedTaskReadModel = SessionIdAcpTaskReadModel & Readonly<{
  continuity: Readonly<{
    runtimeInstanceId: string;
    lineageId: string;
    recoveryState: "live" | "recovered";
    restoredAt?: string;
    continuedFromSurface?: "browser" | "electron";
  }>;
}>;

export type SessionIdUnifiedConfigurationReadRequest =
  | Readonly<{ kind: "template_studio"; templateId?: string }>
  | Readonly<{ kind: "task_setup"; taskSetupDraftId: string }>
  | Readonly<{ kind: "provider_settings" }>
  | Readonly<{
      kind: "meta";
      scope: Readonly<{
        kind: "template_design" | "task_setup";
        draftId: string;
        draftRevision: number;
      }>;
    }>;

export type SessionIdUnifiedConfigurationReadResult =
  | Readonly<{ kind: "template_studio"; model: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "task_setup"; model: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "provider_settings"; model: AcpProviderSettingsReadModel }>
  | Readonly<{ kind: "meta"; model: Readonly<Record<string, unknown>> }>;

type WorkspacePreviewResult = Awaited<ReturnType<
  ReturnType<typeof createNodeSessionIdAcpWorkspacePreviewOwner>["command"]
>>;

export type SessionIdUnifiedCommandResult =
  | SessionIdConfigurationTaskLifecycleResult
  | SessionIdAcpRendererCommandResult
  | SessionIdAcpHumanInterruptResult
  | SessionIdAcpTaskStopResult
  | WorkspacePreviewResult
  | Readonly<{ providerSettings: AcpProviderSettingsReadModel }>
  | Readonly<{
      interactionResponse: Readonly<{
        humanInterventionId: string;
        state: "accepted";
        targetLogicalSessionId: string;
        interactionId: string;
        choiceId: string;
        label: string;
      }>;
    }>;

export type SessionIdUnifiedRuntimeInvalidation = Readonly<{
  type: "session_id_runtime_invalidated";
  reason: "command" | "provider_effect" | "provider_fact" | "meta" | "recovered";
  taskId?: string;
  observedAt: string;
}>;

export type SessionIdUnifiedObservedLineage = SessionIdObservedLineage;

export type SessionIdUnifiedRuntimeHost = Readonly<{
  runtimeInstanceId: string;
  authenticatedUserId: string;
  readWorkspace(): SessionIdUnifiedWorkspaceReadModel;
  readTask(request: Readonly<{
    taskId: string;
    continuedFromSurface?: "browser" | "electron";
  }>): SessionIdUnifiedTaskReadModel;
  readConfiguration(request: SessionIdUnifiedConfigurationReadRequest): Promise<SessionIdUnifiedConfigurationReadResult>;
  command(
    command: SessionIdUnifiedRendererCommand,
    authentication: Readonly<{
      authenticatedUserId: string;
      source: "authenticated_runtime_bridge";
    }>,
  ): Promise<SessionIdUnifiedCommandResult>;
  subscribe(
    request: Readonly<{ taskId?: string }>,
    listener: (invalidation: SessionIdUnifiedRuntimeInvalidation) => void,
  ): () => void;
  drainRun(runId: string): Promise<void>;
  drainMetaTurns(maxItems?: number): Promise<number>;
  readObservedLineage(): SessionIdUnifiedObservedLineage;
  readCommandEvidence(): ReturnType<ReturnType<typeof createSessionIdAuthenticatedCommandLedger>["readEntries"]>;
  close(): Promise<void>;
}>;

export type SessionIdUnifiedAcpProviderFactoryInput = SessionIdAcpApplicationProviderFactoryInput & Readonly<{
  runtimeInstanceId: string;
  now: () => string;
  createId(kind: "workspace_effect" | "workspace_file_observation"): string;
  onHumanOnlyActivity(input: SessionIdAcpHumanActivityInput): void;
  taskBindingContext: Readonly<{
    repositories: SessionIdAcpTaskBindingContextRepositories;
    workspaceDirectoryResolver: ReturnType<typeof createNodeWorkspaceDirectoryResolver>;
  }>;
}>;

export type SessionIdUnifiedAcpProviderAttachment = Readonly<{
  acpApplication: Pick<SessionIdAcpApplicationReady, "createRunApplication">;
  onBindingReady(event: SessionRuntimeBindingReadyEvent): void;
  onRuntimeInvalidated(reason: "provider_effect" | "provider_fact", taskId?: string): void;
}>;

export type SessionIdUnifiedAcpProviderOwner = SessionIdAcpApplicationProviderOwner & Readonly<{
  metaAgentRegistrations: readonly AcpMetaAgentRegistration[];
  /** Safe configuration presence only; command paths and credential locations remain Host-private. */
  configuredProviderFamilies: readonly ProviderFamily[];
  /** Device-local settings. Paths remain Host-private and only safe display values cross the Bridge. */
  readProviderSetup(providerFamily: ProviderFamily): SessionIdAcpProviderSetupSnapshot;
  discoverProviderInstallation(providerFamily: ProviderFamily): SessionIdAcpProviderSetupSnapshot;
  configureProviderInstallation(
    providerFamily: ProviderFamily,
    installation: AcpProviderInstallationInput,
  ): SessionIdAcpProviderSetupSnapshot;
  recordProviderModelCatalog(
    providerFamily: ProviderFamily,
    models: readonly AcpModelCatalogEntry[],
  ): SessionIdAcpProviderSetupSnapshot;
  configureProviderChatModels(
    providerFamily: ProviderFamily,
    modelIds: readonly string[],
    defaultModelId: string,
  ): SessionIdAcpProviderSetupSnapshot;
  /** Creates missing production Meta ports and returns the current settings-visible options. */
  syncMetaAgentRegistrations(): readonly AcpMetaAgentRegistration[];
  /** Pure active-option projection; retained old registrations stay hidden but recoverable. */
  readActiveMetaAgentRegistrations(): readonly AcpMetaAgentRegistration[];
  /** Explicit prompt-free ACP session; it does not require an existing Template Profile. */
  inspectProviderModelCatalog(
    providerFamily: ProviderFamily,
  ): Promise<readonly AcpModelCatalogEntry[]>;
  /** Cache read only. This callback may not resolve, qualify, launch, or probe. */
  readCachedProfileReadiness(input: Readonly<{
    profile: ExecutionProfileDefinitionV3;
    role: AgentCardDefinition["kind"];
  }>): AcpProfileReadinessObservation | undefined;
  /** Explicit bounded refresh; callers must never invoke it from a synchronous read projection. */
  checkProfileReadiness(input: Readonly<{
    profile: ExecutionProfileDefinitionV3;
    role: AgentCardDefinition["kind"];
  }>): Promise<AcpProfileReadinessObservation>;
  /** Exactly-once second phase; native execution must remain fail-closed until it resolves. */
  attachRuntime(input: SessionIdUnifiedAcpProviderAttachment): void | Promise<void>;
}>;

export type SessionIdUnifiedRuntimeHostOptions = Readonly<{
  databasePath: string;
  authenticatedUserId: string;
  workspaceBootstrapGrants?: readonly Readonly<{
    commandId: string;
    workspaceId: string;
    directory: string;
    displayName?: string;
  }>[];
  /** The production assembly and its Task Binding Context are injected atomically here. */
  createProviderOwner(
    input: SessionIdUnifiedAcpProviderFactoryInput,
  ): SessionIdUnifiedAcpProviderOwner | Promise<SessionIdUnifiedAcpProviderOwner>;
  /** Supervisor proof only; the Host never infers predecessor death from time. */
  authorizeRetiringBindingRecovery: SessionIdAcpApplicationProviderFactoryInput["authorizeRetiringBindingRecovery"];
  now?: () => string;
  createId?: (kind: string) => string;
  dispatchIntervalMs?: number;
  metaReadinessProbeTimeoutMs?: number;
  onDiagnostic?: (diagnostic: Readonly<{ code: string; error?: string }>) => void;
}>;

const HOST_OPTION_KEYS = new Set([
  "databasePath",
  "authenticatedUserId",
  "workspaceBootstrapGrants",
  "createProviderOwner",
  "authorizeRetiringBindingRecovery",
  "now",
  "createId",
  "dispatchIntervalMs",
  "metaReadinessProbeTimeoutMs",
  "onDiagnostic",
]);

/**
 * The sole production Runtime root: one SQLite connection, one ACP application
 * assembly and one provider-neutral command/read surface.
 */
export async function createSessionIdUnifiedRuntimeHost(
  options: SessionIdUnifiedRuntimeHostOptions,
): Promise<SessionIdUnifiedRuntimeHost> {
  validateHostOptions(options);
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? ((kind: string) => `${kind}_${randomUUID()}`);
  const authenticatedUserId = requiredText(options.authenticatedUserId, "session_id_authenticated_user_required");
  const sqlite = new SqliteRuntimeStore({
    path: requiredText(options.databasePath, "session_id_database_path_required"),
    now,
  });
  const repositories = createRuntimeRepositories(sqlite);
  const canonical = createSessionIdCanonicalStore(sqlite);
  const ledger = createSessionIdAuthenticatedCommandLedger(sqlite, {
    createId: () => createId("runtime_instance"),
  });
  const resolveFrozenProfileTuple = createAcpV3FrozenProfileTupleResolver({
    templates: repositories.templateTask,
    taskRun: canonical.taskRun,
  });
  const acpRepositories = createAcpSessionRuntimeRepositories(sqlite, { resolveFrozenProfileTuple });
  const workspaceDirectoryResolver = createNodeWorkspaceDirectoryResolver();
  const taskBindingContextRepositories: SessionIdAcpTaskBindingContextRepositories = Object.freeze({
    templateTask: repositories.templateTask,
    workspaceAuthorization: repositories.workspace,
    taskRun: canonical.taskRun,
    message: canonical.message,
    orchestration: canonical.orchestration,
    binding: acpRepositories.binding,
    sessionRuntime: acpRepositories.sessionRuntime,
  });
  const listeners = new Set<Readonly<{
    taskId?: string;
    listener: (invalidation: SessionIdUnifiedRuntimeInvalidation) => void;
  }>>();
  const runPumps = new Map<string, Promise<void>>();
  let metaPump: Promise<number> | undefined;
  const drainedProviderEffects = new Set<string>();
  const completedProviderEffects = new Set<string>();
  const attemptsNeedingReconciliation = new Set<string>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let acpApplication: SessionIdAcpApplicationReady | undefined;
  let lifecycleHost: ReturnType<typeof createSessionIdConfigurationTaskLifecycleHost> | undefined;
  let providerOwner: SessionIdUnifiedAcpProviderOwner | undefined;
  const taskModelCatalogs = new Map<ExecutionProfileDefinitionV3["providerFamily"], NonNullable<
    AcpProfileReadinessObservation["modelCatalog"]
  >>();
  const providerProbeReadiness = new Map<ProviderFamily, AcpProfileReadinessObservation>();
  const humanActivities = createSessionIdAcpHumanActivityOwner({
    now,
    createId: () => createId("provider_activity"),
  });

  const assembly = createSessionIdAcpApplicationAssembly({
    store: sqlite,
    authenticatedUserId,
    now,
    createId,
    authorizeRetiringBindingRecovery: options.authorizeRetiringBindingRecovery,
    async createProvider(input) {
      const owner = await options.createProviderOwner(Object.freeze({
        ...input,
        runtimeInstanceId: ledger.runtimeInstanceId,
        now,
        createId,
        onHumanOnlyActivity(input) {
          humanActivities.record(input);
        },
        taskBindingContext: Object.freeze({
          repositories: taskBindingContextRepositories,
          workspaceDirectoryResolver,
        }),
      }));
      validateProviderOwner(owner);
      providerOwner = owner;
      return owner;
    },
  });

  try {
    acpApplication = await assembly.open();
    const owner = required(providerOwner, "session_id_unified_provider_owner_missing");
    lifecycleHost = createSessionIdConfigurationTaskLifecycleHost({
      persistence: { sqlite, repositories, canonical },
      acpApplication,
      acpTaskLifecycle: createSessionIdAcpTaskLifecycleHost({ now, createId }),
      acpTaskOwners: {
        binding: acpRepositories.binding,
        sessionRuntime: acpRepositories.sessionRuntime,
      },
      metaAgentRegistrations: owner.metaAgentRegistrations,
      listTemplateProfileRevisions,
      now,
      createId,
      ...(options.metaReadinessProbeTimeoutMs === undefined
        ? {}
        : { metaReadinessProbeTimeoutMs: options.metaReadinessProbeTimeoutMs }),
    });
    await owner.attachRuntime(Object.freeze({
      acpApplication,
      onBindingReady(event) {
        const activated = lifecycleHost!.onBindingReady(event);
        if (activated) publish("provider_fact", activated.taskId);
      },
      onRuntimeInvalidated(reason, taskId) {
        publish(reason, taskId);
      },
    }));
    for (const grant of options.workspaceBootstrapGrants ?? []) {
      await lifecycleHost.lifecycle.execute({
        type: "workspace.authorize",
        commandId: requiredText(grant.commandId, "session_id_workspace_bootstrap_command_id_required"),
        issuedAt: "1970-01-01T00:00:00.000Z",
        workspaceId: requiredText(grant.workspaceId, "session_id_workspace_bootstrap_id_required"),
        directory: requiredText(grant.directory, "session_id_workspace_bootstrap_directory_required"),
        ...(grant.displayName === undefined
          ? {}
          : { displayName: requiredText(grant.displayName, "session_id_workspace_bootstrap_display_name_required") }),
      });
    }
  } catch (error) {
    let cleanupFailure: unknown;
    try {
      await lifecycleHost?.close();
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
    try {
      await acpApplication?.close();
    } catch (cleanupError) {
      cleanupFailure ??= cleanupError;
    }
    if (cleanupFailure) throw cleanupFailure;
    sqlite.close();
    throw error;
  }

  const lifecycle = required(lifecycleHost, "session_id_unified_lifecycle_not_ready");
  const application = required(acpApplication, "session_id_unified_acp_application_not_ready");
  const previewOwner = createNodeSessionIdAcpWorkspacePreviewOwner({ sqlite, now, createId });
  const taskReadProjector = createSessionIdAcpTaskReadProjector({
    now,
    snapshot: {
      read(work) {
        return sqlite.transaction(() => work({
          templateTask: repositories.templateTask,
          taskRun: Object.freeze({
            findSlot: canonical.taskRun.findSlot,
            listGenerations: canonical.taskRun.listGenerations,
            latestPlanningFence: canonical.taskRun.latestPlanningFence,
            readConductorSession(taskId: string, runId: string) {
              const run = repositories.templateTask.getRun(runId);
              const architecture = repositories.templateTask.getArchitectureSnapshot(taskId);
              if (!run || run.taskId !== taskId || !architecture || architecture.definition.schemaVersion !== 3) {
                return undefined;
              }
              const conductor = architecture.definition.conductor;
              const profile = architecture.definition.executionProfiles.find((candidate) =>
                candidate.executionProfileId === conductor.executionProfileId);
              if (!profile) return undefined;
              return Object.freeze({
                logicalSessionId: run.conductorLogicalSessionId,
                taskId,
                runId,
                agentCardId: conductor.agentCardId,
                executionProfileId: profile.executionProfileId,
                profileRevisionId: profile.profileRevisionId,
                generation: 1,
                lifecycle: run.status === "stopped" || run.status === "failed" ? "closed" as const : "current" as const,
                createdAt: run.startedAt,
                ...(run.endedAt ? { closedAt: run.endedAt } : {}),
              });
            },
          }),
          message: canonical.message,
          orchestration: canonical.orchestration,
          humanIntervention: canonical.humanIntervention,
          workspace: canonical.workspace,
          currentBinding: acpRepositories.binding,
          sessionExecution: acpRepositories.sessionRuntime,
        }));
      },
    },
    readCachedProfileReadiness: (scope) => {
      const architecture = repositories.templateTask.getArchitectureSnapshot(scope.taskId);
      if (!architecture || architecture.definition.schemaVersion !== 3) return undefined;
      const profile = architecture.definition.executionProfiles.find((candidate) =>
        candidate.executionProfileId === scope.executionProfileId
        && candidate.profileRevisionId === scope.profileRevisionId
        && candidate.providerFamily === scope.providerFamily
        && candidate.acpAgentKind === scope.acpAgentKind
        && candidate.model === scope.model);
      if (!profile) return undefined;
      return cachedReadiness(profile, scope.role);
    },
    readHumanOnlyActivities: (sessionExecutionAttemptId) => (
      humanActivities.listForAttempt(sessionExecutionAttemptId)
    ),
  });

  for (const task of repositories.templateTask.listTasks()) {
    if (!task.activeRunId || !isOwnedTask(task.taskId)) continue;
    const run = repositories.templateTask.getRun(task.activeRunId);
    if (!run || run.status === "stopped" || run.status === "failed") continue;
    lifecycle.orchestrationForRun(run.runId);
    await drainRun(run.runId);
    publish("recovered", task.taskId);
  }
  const intervalMs = options.dispatchIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 25) {
    await closeOwnedResources();
    throw new Error("session_id_dispatch_interval_invalid");
  }
  timer = setInterval(() => {
    void drainMetaPump().catch((error) => diagnostic("session_id_acp_meta_drain_failed", error));
    for (const task of repositories.templateTask.listTasks()) {
      if (!task.activeRunId || !isOwnedTask(task.taskId)) continue;
      void drainRun(task.activeRunId).catch((error) => diagnostic("session_id_acp_run_drain_failed", error));
    }
  }, intervalMs);
  timer.unref();

  return Object.freeze({
    runtimeInstanceId: ledger.runtimeInstanceId,
    authenticatedUserId,
    readWorkspace() {
      ensureOpen();
      return projectWorkspace();
    },
    readTask(request) {
      ensureOpen();
      const taskId = requiredText(request.taskId, "session_id_task_id_required");
      if (!isOwnedTask(taskId)) throw new Error("session_id_authenticated_task_denied");
      const model = taskReadProjector.read({ taskId });
      return Object.freeze({
        ...model,
        continuity: Object.freeze({
          runtimeInstanceId: ledger.runtimeInstanceId,
          lineageId: `session_id_lineage_${model.runId}`,
          recoveryState: ledger.recovered ? "recovered" as const : "live" as const,
          ...(ledger.recovered ? { restoredAt: now() } : {}),
          ...(request.continuedFromSurface ? { continuedFromSurface: request.continuedFromSurface } : {}),
        }),
      });
    },
    readConfiguration(request) {
      ensureOpen();
      return projectConfiguration(request);
    },
    async command(command, authentication) {
      ensureOpen();
      assertAuthentication(authentication);
      if (authentication.authenticatedUserId !== authenticatedUserId) {
        throw new Error("session_id_authenticated_user_denied");
      }
      const uiIntentId = requiredText(command.uiIntentId, "session_id_ui_intent_id_required");
      const commandId = requiredText(command.commandId, "session_id_command_id_required");
      const result = await executeCommand(command, authentication.authenticatedUserId);
      ledger.recordSuccessfulCommand({ uiIntentId, commandId, intentKind: command.type });
      publish(command.type === "meta.send_message" ? "meta" : "command", commandTaskId(command));
      if (command.type === "meta.send_message") {
        void drainMetaPump().catch((error) => diagnostic("session_id_acp_meta_drain_failed", error));
      }
      const runId = commandRunId(command, result);
      // The interaction choice and its provider-effect intent are already
      // durable here. Waiting for the whole Run drain would make the response
      // request wait on the prompt it is meant to unblock, and would prevent a
      // second permission choice from being submitted. Other commands retain
      // their existing drain-before-return contract.
      if (runId && command.type === "session.respond_interaction") {
        void drainRun(runId).catch((error) => diagnostic("session_id_acp_run_drain_failed", error));
      } else if (runId) {
        await drainRun(runId);
      }
      return result;
    },
    subscribe(request, listener) {
      ensureOpen();
      if (typeof listener !== "function") throw new Error("session_id_invalidation_listener_required");
      const subscription = Object.freeze({
        ...(request.taskId ? { taskId: requiredText(request.taskId, "session_id_task_id_required") } : {}),
        listener,
      });
      listeners.add(subscription);
      if (ledger.recovered) {
        listener(Object.freeze({
          type: "session_id_runtime_invalidated",
          reason: "recovered",
          ...(subscription.taskId ? { taskId: subscription.taskId } : {}),
          observedAt: now(),
        }));
      }
      return () => { listeners.delete(subscription); };
    },
    drainRun,
    async drainMetaTurns(maxItems) {
      ensureOpen();
      return drainMetaPump(maxItems);
    },
    readObservedLineage() {
      ensureOpen();
      return projectObservedLineage();
    },
    readCommandEvidence() {
      ensureOpen();
      return ledger.readEntries();
    },
    close: closeOwnedResources,
  });

  async function executeCommand(
    command: SessionIdUnifiedRendererCommand,
    userId: string,
  ): Promise<SessionIdUnifiedCommandResult> {
    if (command.type === "meta.create_session") {
      const activeOptionIds = new Set(required(providerOwner, "session_id_unified_provider_owner_missing")
        .readActiveMetaAgentRegistrations().map(({ option }) => option.metaProfileOptionId));
      if (!activeOptionIds.has(command.metaProfileOptionId)) {
        throw new Error("meta_profile_option_not_active");
      }
    }
    if (LIFECYCLE_COMMAND_TYPES.has(command.type)) {
      const { uiIntentId: _uiIntentId, ...domainCommand } = command;
      return lifecycle.lifecycle.execute(domainCommand as SessionIdConfigurationTaskLifecycleCommand);
    }
    if (command.type === "provider.probe_models") {
      const catalog = await probeProviderModels(command.providerFamily);
      taskModelCatalogs.set(command.providerFamily, catalog);
      required(providerOwner, "session_id_unified_provider_owner_missing")
        .recordProviderModelCatalog(command.providerFamily, catalog);
      return Object.freeze({ providerSettings: projectProviderSettingsModel() });
    }
    if (command.type === "provider.discover_installation") {
      required(providerOwner, "session_id_unified_provider_owner_missing")
        .discoverProviderInstallation(command.providerFamily);
      return Object.freeze({ providerSettings: projectProviderSettingsModel() });
    }
    if (command.type === "provider.configure_installation") {
      required(providerOwner, "session_id_unified_provider_owner_missing")
        .configureProviderInstallation(command.providerFamily, command.installation);
      return Object.freeze({ providerSettings: projectProviderSettingsModel() });
    }
    if (command.type === "provider.configure_chat_models") {
      const catalog = providerProbeReadiness.get(command.providerFamily)?.modelCatalog
        ?? taskModelCatalogs.get(command.providerFamily)
        ?? providerOwner?.readProviderSetup(command.providerFamily).modelCatalog
        ?? [];
      if (command.modelIds.some((modelId) => !catalog.some((entry) => entry.modelId === modelId))
        || !catalog.some((entry) => entry.modelId === command.defaultModelId)) {
        throw new Error("session_id_acp_provider_model_not_observed");
      }
      const owner = required(providerOwner, "session_id_unified_provider_owner_missing");
      owner.configureProviderChatModels(
        command.providerFamily,
        command.modelIds,
        command.defaultModelId,
      );
      lifecycle.registerMetaAgentRegistrations(owner.syncMetaAgentRegistrations());
      return Object.freeze({ providerSettings: projectProviderSettingsModel() });
    }
    const runId = requiredText("runId" in command ? command.runId : "", "session_id_run_id_required");
    const runApplication = lifecycle.orchestrationForRun(runId);
    switch (command.type) {
      case "task.submit_input": {
        const { type: _type, uiIntentId: _uiIntentId, issuedAt: _issuedAt, ...input } = command;
        return runApplication.rendererCommandApplication.submitTaskInput(input);
      }
      case "session.send_human_message": {
        const { type: _type, uiIntentId: _uiIntentId, issuedAt: _issuedAt, ...input } = command;
        return runApplication.rendererCommandApplication.sendHumanMessage({ ...input, authenticatedUserId: userId });
      }
      case "session.abandon_human_message": {
        const { type: _type, uiIntentId: _uiIntentId, issuedAt: _issuedAt, ...input } = command;
        return runApplication.rendererCommandApplication.abandonHumanMessage({ ...input, authenticatedUserId: userId });
      }
      case "session.request_interrupt": {
        const { type: _type, uiIntentId: _uiIntentId, issuedAt: _issuedAt, ...input } = command;
        const commit = runApplication.commandApplication.requestHumanInterrupt({
          ...input,
          authenticatedUserId: userId,
        });
        return commit.result;
      }
      case "session.respond_interaction": {
        const { type: _type, uiIntentId: _uiIntentId, issuedAt: _issuedAt, ...input } = command;
        return runApplication.interactionResponseOwner.respondToInteraction(input);
      }
      case "task.stop": {
        const { uiIntentId: _uiIntentId, ...input } = command;
        return runApplication.taskStopApplication.stopTask({
          ...input,
          idempotencyKey: `acp-renderer:task-stop:${input.commandId}`,
        });
      }
      case "workspace.preview_file": {
        const { uiIntentId: _uiIntentId, ...input } = command;
        return previewOwner.command(input);
      }
    }
    throw new Error("session_id_runtime_command_denied");
  }

  function drainRun(runId: string): Promise<void> {
    ensureOpen();
    const exactRunId = requiredText(runId, "session_id_run_id_required");
    const existing = runPumps.get(exactRunId);
    if (existing) return existing;
    const operation = drainRunOnce(exactRunId).finally(() => runPumps.delete(exactRunId));
    runPumps.set(exactRunId, operation);
    return operation;
  }

  function drainMetaPump(maxItems?: number): Promise<number> {
    ensureOpen();
    if (metaPump) return metaPump;
    const operation = lifecycle.drainMetaTurns(maxItems)
      .then((handled) => {
        if (handled > 0) publish("meta");
        return handled;
      })
      .finally(() => {
        if (metaPump === operation) metaPump = undefined;
      });
    metaPump = operation;
    return operation;
  }

  async function drainRunOnce(runId: string): Promise<void> {
    const run = required(repositories.templateTask.getRun(runId), "session_id_run_not_found");
    if (!isOwnedTask(run.taskId)) throw new Error("session_id_authenticated_task_denied");
    const runApplication = lifecycle.orchestrationForRun(runId);
    const reconciledThisDrain = new Set<string>();
    for (let pass = 0; pass < 64; pass += 1) {
      let progressed = false;
      const currentRun = required(repositories.templateTask.getRun(runId), "session_id_run_not_found");
      if (currentRun.status === "stopping") {
        await runApplication.taskStopPump.pumpTaskStop();
        const stop = runApplication.taskStopPump.reconcileTaskStop();
        progressed = stop.status === "stopped";
      }
      for (const intent of acpRepositories.reliability.listProviderEffectIntents()) {
        if (intent.runId !== runId || intent.state !== "pending"
          || drainedProviderEffects.has(intent.providerEffectIntentId)) continue;
        if (providerEffectResultAlreadyCommitted(intent)) {
          drainedProviderEffects.add(intent.providerEffectIntentId);
          completedProviderEffects.add(intent.providerEffectIntentId);
          continue;
        }
        const drained = await runApplication.runtimePump.drainStagedEffect({
          providerEffectIntentId: intent.providerEffectIntentId,
        });
        if (drained.disposition !== "drained") {
          throw new Error("session_id_acp_staged_effect_not_drained");
        }
        progressed = observeProviderDrain(drained) || progressed;
        if (drained.reconciliationRequired) {
          attemptsNeedingReconciliation.add(drained.sessionExecutionAttemptId);
        }
      }
      for (const logicalSessionId of currentLogicalSessions(run.taskId, runId)) {
        if (!currentLogicalSessions(run.taskId, runId).includes(logicalSessionId)) continue;
        const pumped = await runApplication.runtimePump.pumpDelivery({ logicalSessionId });
        if (pumped.disposition !== "drained") continue;
        progressed = observeProviderDrain(pumped) || progressed;
        if (pumped.reconciliationRequired) {
          attemptsNeedingReconciliation.add(pumped.sessionExecutionAttemptId);
        }
      }
      for (const sessionExecutionAttemptId of attemptsNeedingReconciliation) {
        if (reconciledThisDrain.has(sessionExecutionAttemptId)) continue;
        const attempt = acpRepositories.sessionRuntime.getAttempt(sessionExecutionAttemptId);
        if (!attempt || attempt.runId !== runId) continue;
        if (attempt.settlement) {
          attemptsNeedingReconciliation.delete(sessionExecutionAttemptId);
          continue;
        }
        const reconciled = await runApplication.runtimePump.reconcileAttempt({ sessionExecutionAttemptId });
        reconciledThisDrain.add(sessionExecutionAttemptId);
        if (reconciled.disposition === "drained") {
          progressed = observeProviderDrain(reconciled) || progressed;
          if (!reconciled.reconciliationRequired) {
            attemptsNeedingReconciliation.delete(sessionExecutionAttemptId);
          }
        }
      }
      if (!progressed) break;
      publish("provider_effect", run.taskId);
      if (pass === 63) throw new Error("session_id_acp_run_drain_unbounded");
    }
  }

  function observeProviderDrain(
    drained: Extract<Awaited<ReturnType<SessionIdAcpRunApplication["runtimePump"]["pumpDelivery"]>>, {
      disposition: "drained";
    }>,
  ): boolean {
    const firstObservation = !drainedProviderEffects.has(drained.providerEffectIntentId);
    drainedProviderEffects.add(drained.providerEffectIntentId);
    const firstCompletion = !drained.reconciliationRequired
      && !completedProviderEffects.has(drained.providerEffectIntentId);
    if (!drained.reconciliationRequired) {
      completedProviderEffects.add(drained.providerEffectIntentId);
    }
    return firstObservation || firstCompletion;
  }

  function providerEffectResultAlreadyCommitted(
    intent: SessionRuntimeProviderEffectIntentRecord,
  ): boolean {
    const attempt = acpRepositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId);
    if (!attempt?.settlement
      || attempt.taskId !== intent.taskId || attempt.runId !== intent.runId
      || attempt.logicalSessionId !== intent.logicalSessionId
      || attempt.inputSubmissionId !== intent.inputSubmissionId
      || attempt.orchestrationSessionTurnId !== intent.orchestrationSessionTurnId
      || attempt.bindingId !== intent.bindingId || attempt.bindingRevision !== intent.bindingRevision
      || attempt.settlement.sessionExecutionAttemptId !== intent.sessionExecutionAttemptId
      || attempt.settlement.taskId !== intent.taskId || attempt.settlement.runId !== intent.runId
      || attempt.settlement.logicalSessionId !== intent.logicalSessionId
      || attempt.settlement.inputSubmissionId !== intent.inputSubmissionId
      || attempt.settlement.orchestrationSessionTurnId !== intent.orchestrationSessionTurnId) return false;
    const input = canonical.orchestration.getInputSubmission(intent.inputSubmissionId);
    const turn = canonical.orchestration.getTurn(intent.orchestrationSessionTurnId);
    const inbox = input ? canonical.orchestration.getInboxItem(input.sourceInboxItemId) : undefined;
    if (!input || !turn || !inbox
      || input.inputSubmissionId !== intent.inputSubmissionId
      || input.taskId !== intent.taskId || input.runId !== intent.runId
      || input.sessionId !== intent.logicalSessionId
      || turn.sessionTurnId !== intent.orchestrationSessionTurnId
      || turn.taskId !== intent.taskId || turn.runId !== intent.runId
      || turn.sessionId !== intent.logicalSessionId
      || turn.inputSubmissionId !== input.inputSubmissionId
      || inbox.inboxItemId !== input.sourceInboxItemId
      || inbox.taskId !== intent.taskId || inbox.runId !== intent.runId
      || inbox.sessionId !== intent.logicalSessionId
      || inbox.renderedMessageId !== input.contentMessageId) return false;
    if (attempt.settlement.outcome === "completed") {
      const committedRun = repositories.templateTask.getRun(intent.runId);
      if (!committedRun || committedRun.taskId !== intent.taskId) return false;
      const conductorCompleted = intent.logicalSessionId === committedRun.conductorLogicalSessionId
        && !turn.finalMessageId;
      const cardCompleted = intent.logicalSessionId !== committedRun.conductorLogicalSessionId
        && Boolean(turn.finalMessageId);
      return input.state === "returned" && turn.state === "returned" && inbox.state === "handled"
        && (conductorCompleted || cardCompleted);
    }
    if (attempt.settlement.outcome === "failed") {
      return input.state === "failed" && turn.state === "failed" && inbox.state === "handled";
    }
    return input.state === "cancelled" && turn.state === "interrupted" && inbox.state === "handled";
  }

  function currentLogicalSessions(taskId: string, runId: string): readonly string[] {
    const run = required(repositories.templateTask.getRun(runId), "session_id_run_not_found");
    if (run.taskId !== taskId) throw new Error("session_id_run_scope_mismatch");
    const architecture = required(
      repositories.templateTask.getArchitectureSnapshot(taskId),
      "session_id_architecture_not_found",
    );
    const sessions = [run.conductorLogicalSessionId];
    for (const card of architecture.definition.agentCards) {
      const current = canonical.taskRun.findSlot(runId, card.agentCardId)?.currentSessionId;
      if (current) sessions.push(current);
    }
    return Object.freeze([...new Set(sessions)]);
  }

  function projectWorkspace(): SessionIdUnifiedWorkspaceReadModel {
    const read = lifecycle.lifecycle.read();
    return Object.freeze({
      generatedAt: now(),
      tasks: Object.freeze(read.taskLibrary.filter((task) => isOwnedTask(task.taskId)).map((task) => {
        const activeRun = task.activeRunId ? repositories.templateTask.getRun(task.activeRunId) : undefined;
        const availableLifecycleActions: ("start" | "resume" | "restart")[] = [];
        if (!task.achievement && !task.trashedAt) {
          if (task.status === "queued") availableLifecycleActions.push("start");
          if (task.status === "blocked" || task.status === "running") availableLifecycleActions.push("resume");
          if (task.status === "stopped") availableLifecycleActions.push("restart");
        }
        return Object.freeze({
          taskId: task.taskId,
          title: task.title,
          goal: task.goal,
          revision: task.revision,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          ...(task.trashedAt ? { trashedAt: task.trashedAt } : {}),
          ...(activeRun ? { activeRun: Object.freeze({ runId: activeRun.runId, status: activeRun.status }) } : {}),
          availableLifecycleActions: Object.freeze(availableLifecycleActions),
          ...(task.achievement ? { achievement: task.achievement } : {}),
        });
      })),
      taskSetupOptions: Object.freeze({
        workspaces: Object.freeze([...read.taskSetupOptions.workspaces]),
        templates: Object.freeze(read.taskSetupOptions.templates.map((template) => Object.freeze({
          ...template,
          activeTemplateVersionId: repositories.templateTask.getTemplate(template.templateId)?.activeVersionId,
        }))),
      }),
    });
  }

  async function projectConfiguration(
    request: SessionIdUnifiedConfigurationReadRequest,
  ): Promise<SessionIdUnifiedConfigurationReadResult> {
    const read = lifecycle.lifecycle.read();
    if (request.kind === "provider_settings") {
      return Object.freeze({ kind: "provider_settings", model: projectProviderSettingsModel() });
    }
    if (request.kind === "template_studio") {
      const selected = request.templateId ? repositories.templateTask.getTemplate(request.templateId) : undefined;
      const profileOptions = templateStudioProfileOptions(read.templateLibrary);
      return Object.freeze({
        kind: "template_studio",
        model: Object.freeze({
          generatedAt: now(),
          templates: Object.freeze(read.templateLibrary.map(({ template, activeVersion }) => Object.freeze({
            templateId: template.templateId,
            title: template.title,
            slug: template.slug,
            revision: template.revision,
            ...(template.description ? { description: template.description } : {}),
            ...(template.archivedAt ? { archivedAt: template.archivedAt } : {}),
            ...(activeVersion ? { currentVersion: templateVersionView(activeVersion) } : {}),
          }))),
          ...(selected ? { selectedTemplate: Object.freeze({
            templateId: selected.templateId,
            title: selected.title,
            slug: selected.slug,
            revision: selected.revision,
            ...(selected.description ? { description: selected.description } : {}),
            ...(selected.activeVersionId ? { activeTemplateVersionId: selected.activeVersionId } : {}),
            versions: Object.freeze(repositories.templateTask.listTemplateVersions(selected.templateId).map(templateVersionView)),
          }) } : {}),
          drafts: Object.freeze(read.configuration.templateDrafts
            .filter((draft) => draft.ownerId === authenticatedUserId && draft.status === "editing")
            .map((draft) => Object.freeze({
              templateDraftId: draft.templateDraftId,
              ...(draft.templateId ? { templateId: draft.templateId } : {}),
              ...(draft.baseTemplateVersionId ? { baseTemplateVersionId: draft.baseTemplateVersionId } : {}),
              revision: draft.revision,
              title: draft.metadata.title,
              slug: draft.metadata.slug ?? "untitled-agent-loop",
              ...(draft.metadata.description ? { description: draft.metadata.description } : {}),
              definitionText: JSON.stringify(draft.definition, null, 2),
              updatedAt: draft.updatedAt,
            }))),
          profileOptions: Object.freeze(profileOptions),
        }),
      });
    }
    if (request.kind === "task_setup") {
      const draft = read.configuration.taskSetupDrafts.find((candidate) =>
        candidate.taskSetupDraftId === request.taskSetupDraftId && candidate.ownerId === authenticatedUserId);
      if (!draft) throw new Error("session_id_task_setup_draft_denied");
      const version = required(
        repositories.templateTask.getTemplateVersion(draft.templateVersionId),
        "template_version_not_found",
      );
      const template = required(repositories.templateTask.getTemplate(version.templateId), "template_not_found");
      const values = new Map(draft.taskInputValues.map((value) => [value.fieldId, value.value] as const));
      const fields = version.definition.taskInputSchema?.fields ?? [];
      const validationIssues: string[] = [];
      if (!draft.workspaceId.trim()) validationIssues.push("Workspace is required.");
      if (!draft.title.trim()) validationIssues.push("Task title is required.");
      if (!draft.goal.trim()) validationIssues.push("Task goal is required.");
      for (const field of fields) {
        const value = values.get(field.fieldId)?.trim() ?? "";
        if (field.required && !value) validationIssues.push(`${field.label} is required.`);
      }
      const v3Definition = version.definition.schemaVersion === 3 ? version.definition : undefined;
      const profiles = v3Definition?.executionProfiles ?? [];
      return Object.freeze({
        kind: "task_setup",
        model: Object.freeze({
          draft: Object.freeze({
            taskSetupDraftId: draft.taskSetupDraftId,
            revision: draft.revision,
            state: draft.state,
            templateVersion: Object.freeze({
              templateId: template.templateId,
              templateVersionId: version.templateVersionId,
              templateTitle: template.title,
              version: version.version,
            }),
            workspaceId: draft.workspaceId,
            title: draft.title,
            goal: draft.goal,
            schemaFields: Object.freeze(fields.map((field) => Object.freeze({
              fieldId: field.fieldId,
              label: field.label,
              kind: field.kind,
              required: field.required,
              value: values.get(field.fieldId) ?? "",
              ...(field.description ? { help: field.description } : {}),
            }))),
            validationIssues: Object.freeze(validationIssues),
            valid: draft.state === "draft" && validationIssues.length === 0,
          }),
          workspaces: Object.freeze([...read.taskSetupOptions.workspaces]),
          profileOptions: Object.freeze(profiles.map((profile) => profileOption(
            profile,
            profileRole(required(v3Definition, "session_id_task_setup_template_not_v3"), profile.executionProfileId),
          ))),
        }),
      });
    }
    const target = request.scope.kind === "template_design"
      ? { kind: "template_draft" as const, templateDraftId: request.scope.draftId }
      : { kind: "task_setup_draft" as const, taskSetupDraftId: request.scope.draftId };
    const session = read.configuration.metaSessions.find((candidate) =>
      candidate.ownerId === authenticatedUserId
      && candidate.state === "active"
      && sameMetaTarget(candidate.target, target));
    const turns = session ? repositories.configuration.listMetaTurns(session.metaSessionId) : [];
    const latestTurn = turns.at(-1);
    const turnByAssistantMessageId = new Map(turns.map((turn) => [turn.assistantMetaMessageId, turn] as const));
    const turnByProposalId = new Map(turns.map((turn) => [turn.metaPatchProposalId, turn] as const));
    const targetTemplateDraft = target.kind === "template_draft"
      ? read.configuration.templateDrafts.find((draft) => draft.templateDraftId === target.templateDraftId)
      : undefined;
    const targetTaskSetupDraft = target.kind === "task_setup_draft"
      ? read.configuration.taskSetupDrafts.find((draft) => draft.taskSetupDraftId === target.taskSetupDraftId)
      : undefined;
    return Object.freeze({
      kind: "meta",
      model: Object.freeze({
        profileOptions: Object.freeze(providerOwner!.readActiveMetaAgentRegistrations().filter(({ option }) => {
          const setup = providerOwner!.readProviderSetup(option.profile.providerFamily);
          return setup.configurationSource === "environment"
            || setup.enabledChatModelIds.includes(option.profile.model)
            || session?.metaProfileOptionId === option.metaProfileOptionId;
        }).map(({ option }) => {
          const readiness = lifecycle.metaReadiness.readOption(option.metaProfileOptionId);
          const setup = providerOwner!.readProviderSetup(option.profile.providerFamily);
          const enabled = new Set(setup.enabledChatModelIds);
          const modelCatalog = Object.freeze([
            ...(readiness.modelCatalog ?? setup.modelCatalog),
          ].filter((entry) => setup.configurationSource === "environment"
            ? entry.modelId === option.profile.model
            : enabled.has(entry.modelId)));
          return Object.freeze({
            schemaVersion: 3 as const,
            metaProfileOptionId: option.metaProfileOptionId,
            label: option.title,
            providerFamily: option.profile.providerFamily,
            model: option.profile.model,
            configIntent: Object.freeze({ ...option.profile.configIntent }),
            readiness,
            modelCatalog,
          });
        })),
        ...(session ? { session: Object.freeze({
          metaSessionId: session.metaSessionId,
          metaProfileOptionId: session.metaProfileOptionId,
          revision: session.revision,
          status: metaTurnStatus(latestTurn?.status),
          activities: Object.freeze(latestTurn
            ? humanActivities.listForMetaTurn(session.metaSessionId, latestTurn.metaTurnId)
            : []),
          messages: Object.freeze(read.configuration.metaMessages
            .filter((message) => message.ownerId === authenticatedUserId
              && message.metaSessionId === session.metaSessionId)
            .map((message) => {
              const messageTurn = turnByAssistantMessageId.get(message.metaMessageId);
              return Object.freeze({
                messageId: message.metaMessageId,
                role: message.role,
                content: message.content,
                createdAt: message.createdAt,
                ...(messageTurn ? {
                  turnStatus: metaTurnStatus(messageTurn.status),
                  activities: Object.freeze(humanActivities.listForMetaTurn(
                    session.metaSessionId,
                    messageTurn.metaTurnId,
                  )),
                } : {}),
              });
            })),
        }) } : {}),
        proposals: Object.freeze(session ? read.configuration.metaPatchProposals
          .filter((proposal) => proposal.ownerId === authenticatedUserId
            && proposal.metaSessionId === session.metaSessionId
            && sameMetaTarget(proposal.target, target))
          .map((proposal) => Object.freeze({
            proposalId: proposal.metaPatchProposalId,
            assistantMessageId: required(
              turnByProposalId.get(proposal.metaPatchProposalId),
              "session_id_meta_proposal_turn_missing",
            ).assistantMetaMessageId,
            baseDraftRevision: proposal.targetRevision,
            status: proposal.state === "pending" && proposal.targetRevision !== request.scope.draftRevision
              ? "stale" : proposal.state,
            summary: proposal.summary,
            rationale: proposal.rationale,
            fieldDiffs: Object.freeze(proposal.operations.map((operation) => Object.freeze(
              metaOperationDiff(operation, targetTemplateDraft, targetTaskSetupDraft),
            ))),
            validationIssues: Object.freeze(proposal.validationIssues.map((issue) => `${issue.code}: ${issue.message}`)),
            unresolvedItems: Object.freeze([]),
          })) : []),
      }),
    });
  }

  function profileOption(
    profile: ExecutionProfileDefinitionV3,
    role: AgentCardDefinition["kind"],
  ) {
    const readiness: AcpProfileReadinessObservation = cachedReadiness(profile, role)
      ?? validateAcpProfileReadinessObservation({
        profileRevisionId: profile.profileRevisionId,
        providerFamily: profile.providerFamily,
        acpAgentKind: profile.acpAgentKind,
        role,
        status: "unavailable" as const,
        reasons: Object.freeze(["profile_not_qualified"]),
        missingCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
        missingExtensions: Object.freeze([...profile.requiredExtensions]),
        model: profile.model,
      });
    return Object.freeze({
      schemaVersion: 3 as const,
      executionProfileId: profile.executionProfileId,
      permissionMode: profile.capabilityPolicy.permissionMode,
      allowedTools: Object.freeze([...profile.capabilityPolicy.allowedTools]),
      requiredCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
      requiredExtensions: Object.freeze([...profile.requiredExtensions]),
      readiness,
    });
  }

  function expandTemplateStudioProfileOptions(
    base: readonly ReturnType<typeof templateStudioProfileOption>[],
  ): readonly ReturnType<typeof templateStudioProfileOption>[] {
    const optionsByScope = new Map<string, ReturnType<typeof templateStudioProfileOption>>();
    for (const option of base) {
      const key = templateProfileScopeKey(option);
      const existing = optionsByScope.get(key);
      if (!existing || (option.readiness.status === "available" && existing.readiness.status !== "available")) {
        optionsByScope.set(key, option);
      }
    }
    for (const providerFamily of ["opencode", "codex", "claude-code"] as const) {
      const setup = providerOwner?.readProviderSetup(providerFamily);
      const discoveredCatalog = taskModelCatalogs.get(providerFamily) ?? setup?.modelCatalog;
      const enabledModels = new Set(setup?.enabledChatModelIds ?? []);
      const catalog = Object.freeze([...(discoveredCatalog ?? [])].filter((entry) => (
        setup?.configurationSource === "environment" || enabledModels.has(entry.modelId)
      )));
      if (catalog.length === 0) continue;
      for (const role of ["conductor", "general", "researcher", "implementer", "reviewer", "publisher"] as const) {
        const roleOptions = base.filter((option) => option.providerFamily === providerFamily && option.role === role);
        const source = roleOptions.find((option) => option.readiness.status === "available") ?? roleOptions[0];
        if (!source) continue;
        for (const entry of catalog) {
          for (const configIntent of taskConfigIntentOptions(providerFamily, source.configIntent)) {
            const key = templateProfileScopeKey({ ...source, model: entry.modelId, configIntent });
            const existing = optionsByScope.get(key);
            if (existing) {
              optionsByScope.set(key, Object.freeze({ ...existing, catalogObserved: true }));
              continue;
            }
            const profileRevisionId = `profile_revision_catalog-${createHash("sha256")
              .update(JSON.stringify({
                executionProfileId: source.executionProfileId,
                providerFamily,
                role,
                model: entry.modelId,
                configIntent,
                capabilityPolicy: source.capabilityPolicy,
                requiredExtensions: source.requiredExtensions,
              }))
              .digest("hex")
              .slice(0, 32)}`;
            optionsByScope.set(key, Object.freeze({
              ...source,
              title: `${providerFamily} · ${entry.label} · ${taskConfigIntentLabel(configIntent)} · ${role}`,
              profileRevisionId,
              model: entry.modelId,
              configIntent: Object.freeze({ ...configIntent }),
              catalogObserved: true,
              readiness: validateAcpProfileReadinessObservation({
                profileRevisionId,
                providerFamily,
                acpAgentKind: source.acpAgentKind,
                role,
                status: "checking",
                reasons: ["model_qualification_required"],
                missingCapabilities: [],
                missingExtensions: [],
                model: entry.modelId,
                modelCatalog: catalog,
              }),
            }));
          }
        }
      }
    }
    return Object.freeze([...optionsByScope.values()]);
  }

  function templateStudioProfileOptions(
    templateLibrary: SessionIdConfigurationTaskLifecycleReadModel["templateLibrary"],
  ): readonly ReturnType<typeof templateStudioProfileOption>[] {
    const libraryProfileSources = templateLibrary
      .filter(({ template }) => !template.archivedAt)
      .flatMap(({ template, activeVersion }) => {
        if (!activeVersion || activeVersion.definition.schemaVersion !== 3) return [];
        const definition = activeVersion.definition;
        return definition.executionProfiles.map((profile) => Object.freeze({
          title: `${template.title} · ${profileRole(definition, profile.executionProfileId)}`,
          sourceTemplateId: template.templateId,
          sourceTemplateVersionId: activeVersion.templateVersionId,
          role: profileRole(definition, profile.executionProfileId),
          profile,
        }));
      });
    const profileSources = [...libraryProfileSources, ...BUILT_IN_TEMPLATE_PROFILE_OPTIONS];
    const uniqueProfileSources = new Map<string, (typeof profileSources)[number]>();
    for (const source of profileSources) {
      const key = `${source.role}:${source.profile.profileRevisionId}`;
      if (!uniqueProfileSources.has(key)) uniqueProfileSources.set(key, source);
    }
    return Object.freeze([...expandTemplateStudioProfileOptions(
      [...uniqueProfileSources.values()].map((source) => templateStudioProfileOption(source)),
    )].sort((left, right) => templateProfileOptionOrder(left) - templateProfileOptionOrder(right)
      || left.sourceTemplateId.localeCompare(right.sourceTemplateId)
      || roleOrder(left.role) - roleOrder(right.role)
      || left.executionProfileId.localeCompare(right.executionProfileId)));
  }

  function listTemplateProfileRevisions(input: Readonly<{
    draft: TemplateDraftRecord;
    executionProfileId: string;
  }>): readonly ExecutionProfileDefinitionV3[] {
    if (input.draft.definition.schemaVersion !== 3) {
      throw new Error("meta_patch_profile_revision_requires_v3");
    }
    const role = profileRole(input.draft.definition, input.executionProfileId);
    const options = templateStudioProfileOptions(lifecycleHost!.lifecycle.read().templateLibrary)
      .filter((option) => option.role === role);
    return Object.freeze(options.map((option) => Object.freeze({
      executionProfileId: input.executionProfileId,
      profileRevisionId: option.profileRevisionId,
      providerFamily: option.providerFamily,
      acpAgentKind: option.acpAgentKind,
      protocolMajor: option.protocolMajor,
      model: option.model,
      configIntent: Object.freeze({ ...option.configIntent }),
      requiredExtensions: Object.freeze([...option.requiredExtensions]),
      capabilityPolicy: Object.freeze({
        ...option.capabilityPolicy,
        requiredCapabilities: Object.freeze([...option.capabilityPolicy.requiredCapabilities]),
        allowedTools: Object.freeze([...option.capabilityPolicy.allowedTools]),
      }),
    })));
  }

  function templateProfileScopeKey(input: Readonly<{
    role: AgentCardDefinition["kind"];
    providerFamily: ProviderFamily;
    model: string;
    configIntent: JsonObject;
  }>): string {
    return `${input.role}:${input.providerFamily}:${input.model}:${createHash("sha256")
      .update(JSON.stringify(input.configIntent))
      .digest("hex")}`;
  }

  function taskConfigIntentOptions(
    providerFamily: ProviderFamily,
    source: JsonObject,
  ): readonly JsonObject[] {
    if (providerFamily !== "codex") return Object.freeze([Object.freeze({ ...source })]);
    return Object.freeze([
      Object.freeze({}),
      Object.freeze({ reasoningEffort: "low" }),
      Object.freeze({ reasoningEffort: "medium" }),
      Object.freeze({ reasoningEffort: "high" }),
      Object.freeze({ reasoningEffort: "xhigh" }),
    ] satisfies readonly JsonObject[]);
  }

  function taskConfigIntentLabel(configIntent: JsonObject): string {
    return typeof configIntent.reasoningEffort === "string" ? configIntent.reasoningEffort : "default";
  }

  async function probeProviderModels(
    providerFamily: ProviderFamily,
  ): Promise<readonly AcpModelCatalogEntry[]> {
    const owner = required(providerOwner, "session_id_unified_provider_owner_missing");
    if (!owner.configuredProviderFamilies.includes(providerFamily)) {
      throw new Error("session_id_acp_provider_not_configured");
    }
    const catalog = await owner.inspectProviderModelCatalog(providerFamily);
    if (!Array.isArray(catalog) || catalog.length === 0) {
      throw new Error("session_id_acp_provider_model_catalog_empty");
    }
    publish("provider_fact");
    return Object.freeze(catalog.map((entry) => Object.freeze({ ...entry })));
  }

  function projectProviderSettingsModel(): AcpProviderSettingsReadModel {
    const configured = new Set(providerOwner?.configuredProviderFamilies ?? []);
    return Object.freeze({
      generatedAt: now(),
      providers: Object.freeze((["opencode", "codex", "claude-code"] as const).map((providerFamily) => {
        const isConfigured = configured.has(providerFamily);
        const readiness = providerProbeReadiness.get(providerFamily);
        const setup: SessionIdAcpProviderSetupSnapshot = providerOwner?.readProviderSetup(providerFamily) ?? Object.freeze({
          configurationSource: "none" as const,
          installation: Object.freeze({ status: "not_scanned" as const, components: Object.freeze([]) }),
          modelCatalog: Object.freeze([]),
          enabledChatModelIds: Object.freeze([]),
        });
        return Object.freeze({
          providerFamily,
          displayName: providerDisplayName(providerFamily),
          configured: isConfigured,
          status: !isConfigured ? "not_configured" as const : readiness?.status ?? "not_checked" as const,
          reasons: Object.freeze(!isConfigured
            ? ["provider_not_configured"]
            : [...(readiness?.reasons ?? [])]),
          models: Object.freeze([...(readiness?.modelCatalog
            ?? taskModelCatalogs.get(providerFamily)
            ?? setup.modelCatalog)]),
          configurationSource: setup.configurationSource,
          installation: setup.installation,
          enabledChatModelIds: Object.freeze([...setup.enabledChatModelIds]),
          ...(setup.defaultModelId ? { defaultModelId: setup.defaultModelId } : {}),
          ...(readiness?.observedAgent ? { observedAgent: readiness.observedAgent } : {}),
          ...(readiness?.observedArtifactVersion
            ? { observedArtifactVersion: readiness.observedArtifactVersion }
            : {}),
          ...(readiness?.observedUpstreamVersion
            ? { observedUpstreamVersion: readiness.observedUpstreamVersion }
            : {}),
        });
      })),
    });
  }

  function templateStudioProfileOption(input: Readonly<{
    title: string;
    sourceTemplateId: string;
    sourceTemplateVersionId: string;
    role: AgentCardDefinition["kind"];
    profile: ExecutionProfileDefinitionV3;
  }>) {
    const { profile, role } = input;
    const readiness: AcpProfileReadinessObservation = cachedReadiness(profile, role)
      ?? validateAcpProfileReadinessObservation({
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      role,
      status: "unavailable" as const,
      reasons: Object.freeze(["profile_not_qualified"]),
      missingCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
      missingExtensions: Object.freeze([...profile.requiredExtensions]),
      model: profile.model,
    });
    return Object.freeze({
      title: input.title,
      sourceTemplateId: input.sourceTemplateId,
      sourceTemplateVersionId: input.sourceTemplateVersionId,
      executionProfileId: profile.executionProfileId,
      role,
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      protocolMajor: profile.protocolMajor,
      model: profile.model,
      configIntent: Object.freeze({ ...profile.configIntent }),
      requiredExtensions: Object.freeze([...profile.requiredExtensions]),
      capabilityPolicy: Object.freeze({
        ...profile.capabilityPolicy,
        requiredCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
        allowedTools: Object.freeze([...profile.capabilityPolicy.allowedTools]),
      }),
      readiness,
      catalogObserved: Boolean(readiness.modelCatalog?.some(({ modelId }) => modelId === profile.model)),
    });
  }

  function cachedReadiness(
    profile: ExecutionProfileDefinitionV3,
    role: AgentCardDefinition["kind"],
  ): AcpProfileReadinessObservation | undefined {
    const cached = providerOwner?.readCachedProfileReadiness({ profile, role });
    if (!cached) return undefined;
    const readiness = validateAcpProfileReadinessObservation(cached);
    if (readiness.profileRevisionId !== profile.profileRevisionId
      || readiness.providerFamily !== profile.providerFamily
      || readiness.acpAgentKind !== profile.acpAgentKind
      || readiness.model !== profile.model
      || readiness.role !== role) {
      throw new Error("session_id_cached_profile_readiness_scope_mismatch");
    }
    return readiness;
  }

  function projectObservedLineage(): SessionIdObservedLineage {
    const metaSessions = repositories.configuration.listMetaSessions()
      .filter((session) => session.ownerId === authenticatedUserId)
      .sort((left, right) => metaModeOrder(left.mode) - metaModeOrder(right.mode)
        || left.createdAt.localeCompare(right.createdAt)
        || left.metaSessionId.localeCompare(right.metaSessionId));
    const templateDraftIds = uniqueSorted([
      ...repositories.templateTask.listDrafts()
        .filter((draft) => draft.ownerId === authenticatedUserId)
        .map((draft) => draft.templateDraftId),
      ...metaSessions.flatMap((session) => session.target.kind === "template_draft"
        ? [session.target.templateDraftId]
        : []),
    ]);
    const taskSetupDraftIds = repositories.configuration.listTaskSetupDrafts()
      .filter((draft) => draft.ownerId === authenticatedUserId)
      .sort(byCreatedAtThen((draft) => draft.taskSetupDraftId))
      .map((draft) => draft.taskSetupDraftId);
    const tasks = canonical.taskRun.listOwnedTaskIds()
      .map((taskId) => required(repositories.templateTask.getTask(taskId), "session_id_observed_task_missing"));
    const runs = tasks.flatMap((task) => canonical.taskRun.listRuns(task.taskId));
    const logicalSessionIds: string[] = [];
    const cardSessionSlotIds: string[] = [];
    const bindingIds: string[] = [];
    const messageIds: string[] = [];
    const messageForwardIds: string[] = [];
    const humanInterventionIds: string[] = [];
    const sessionControlAuditIds: string[] = [];
    const inputSubmissions = new Map<string, Readonly<{ inputSubmissionId: string; createdAt: string }>>();
    const turns = new Map<string, Readonly<{
      sessionTurnId: string;
      inputSubmissionId: string;
      createdAt: string;
    }>>();

    for (const run of runs) {
      const architecture = required(
        repositories.templateTask.getArchitectureSnapshot(run.taskId),
        "session_id_observed_architecture_missing",
      );
      const sessionIds = [run.conductorLogicalSessionId];
      messageIds.push(...canonical.message.listMessages(run.runId).map((message) => message.messageId));
      messageForwardIds.push(...canonical.message.listForwards(run.runId).map((forward) => forward.forwardId));
      humanInterventionIds.push(...canonical.humanIntervention.list(run.runId)
        .map((intervention) => intervention.humanInterventionId));
      sessionControlAuditIds.push(...canonical.orchestration.listControlAudits(run.runId)
        .map((audit) => audit.sessionControlAuditId));
      for (const card of architecture.definition.agentCards) {
        const slot = canonical.taskRun.findSlot(run.runId, card.agentCardId);
        if (!slot) continue;
        cardSessionSlotIds.push(slot.cardSessionSlotId);
        sessionIds.push(...canonical.taskRun.listGenerations(slot.cardSessionSlotId)
          .map((generation) => generation.sessionId));
      }
      for (const logicalSessionId of uniqueInOrder(sessionIds)) {
        logicalSessionIds.push(logicalSessionId);
        bindingIds.push(...acpRepositories.binding.listBindings(logicalSessionId)
          .map((binding) => binding.bindingId));
        for (const inbox of canonical.orchestration.listInboxItems(logicalSessionId)) {
          const submission = canonical.orchestration.findInputByInboxItem(inbox.inboxItemId);
          if (submission) inputSubmissions.set(submission.inputSubmissionId, submission);
        }
        for (const turn of canonical.orchestration.listTurns(logicalSessionId)) {
          turns.set(turn.sessionTurnId, turn);
          const submission = canonical.orchestration.getInputSubmission(turn.inputSubmissionId);
          if (submission) inputSubmissions.set(submission.inputSubmissionId, submission);
        }
      }
    }

    const lineage = Object.freeze({
      schemaVersion: 1 as const,
      runtimeInstanceId: ledger.runtimeInstanceId,
      templateDraftIds: Object.freeze(templateDraftIds),
      taskSetupDraftIds: Object.freeze(taskSetupDraftIds),
      taskIds: Object.freeze(tasks.map((task) => task.taskId)),
      runIds: Object.freeze(runs.map((run) => run.runId)),
      metaSessionIds: Object.freeze(metaSessions.map((session) => session.metaSessionId)),
      metaTurnIds: Object.freeze(metaSessions.flatMap((session) =>
        repositories.configuration.listMetaTurns(session.metaSessionId).map((turn) => turn.metaTurnId))),
      cardSessionSlotIds: Object.freeze(cardSessionSlotIds),
      logicalSessionIds: Object.freeze(uniqueInOrder(logicalSessionIds)),
      bindingIds: Object.freeze(uniqueInOrder(bindingIds)),
      messageIds: Object.freeze(messageIds),
      messageForwardIds: Object.freeze(messageForwardIds),
      humanInterventionIds: Object.freeze(humanInterventionIds),
      inputSubmissionIds: Object.freeze([...inputSubmissions.values()]
        .sort(byCreatedAtThen((submission) => submission.inputSubmissionId))
        .map((submission) => submission.inputSubmissionId)),
      sessionTurnIds: Object.freeze([...turns.values()]
        .sort(byCreatedAtThen((turn) => turn.sessionTurnId))
        .map((turn) => turn.sessionTurnId)),
      sessionControlAuditIds: Object.freeze(sessionControlAuditIds),
    });
    return Object.freeze({ ...lineage, canonicalDigest: sessionIdObservedLineageDigest(lineage) });
  }

  function isOwnedTask(taskId: string): boolean {
    return repositories.configuration.listTaskSetupDrafts().some((draft) =>
      draft.ownerId === authenticatedUserId && draft.createdTaskId === taskId);
  }

  function publish(
    reason: SessionIdUnifiedRuntimeInvalidation["reason"],
    taskId?: string,
  ): void {
    if (closed) return;
    const invalidation = Object.freeze({
      type: "session_id_runtime_invalidated" as const,
      reason,
      ...(taskId ? { taskId } : {}),
      observedAt: now(),
    });
    for (const subscription of listeners) {
      if (subscription.taskId && subscription.taskId !== taskId) continue;
      try {
        subscription.listener(invalidation);
      } catch (error) {
        diagnostic("session_id_invalidation_listener_failed", error);
      }
    }
  }

  async function closeOwnedResources(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      listeners.clear();
      await Promise.allSettled([...runPumps.values()]);
      const pendingMetaPump = metaPump;
      let cleanupFailure: unknown;
      try {
        await lifecycle.close();
      } catch (error) {
        cleanupFailure = error;
      }
      if (pendingMetaPump) {
        const [settledMetaPump] = await Promise.allSettled([pendingMetaPump]);
        if (settledMetaPump?.status === "rejected") cleanupFailure ??= settledMetaPump.reason;
      }
      try {
        await application.close();
      } catch (error) {
        cleanupFailure ??= error;
      }
      if (cleanupFailure) throw cleanupFailure;
      humanActivities.clear();
      sqlite.close();
    })();
    return closePromise;
  }

  function diagnostic(code: string, error: unknown): void {
    options.onDiagnostic?.({
      code,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  function ensureOpen(): void {
    if (closed) throw new Error("session_id_unified_runtime_host_closed");
  }
}

function validateHostOptions(value: SessionIdUnifiedRuntimeHostOptions): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session_id_unified_host_options_invalid");
  }
  const extra = Object.keys(value).filter((key) => !HOST_OPTION_KEYS.has(key));
  if (extra.length > 0
    || typeof value.createProviderOwner !== "function"
    || typeof value.authorizeRetiringBindingRecovery !== "function"
    || (value.workspaceBootstrapGrants !== undefined && !Array.isArray(value.workspaceBootstrapGrants))
    || (value.now !== undefined && typeof value.now !== "function")
    || (value.createId !== undefined && typeof value.createId !== "function")
    || (value.onDiagnostic !== undefined && typeof value.onDiagnostic !== "function")) {
    throw new Error("session_id_unified_host_options_invalid");
  }
}

function validateProviderOwner(value: SessionIdUnifiedAcpProviderOwner): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.provider?.executeProviderEffect !== "function"
    || typeof value.provider?.retireBinding !== "function"
    || typeof value.provider?.retireBindingForClose !== "function"
    || typeof value.close !== "function"
    || !Array.isArray(value.metaAgentRegistrations)
    || !Array.isArray(value.configuredProviderFamilies)
    || new Set(value.configuredProviderFamilies).size !== value.configuredProviderFamilies.length
    || value.configuredProviderFamilies.some((family) => family !== "opencode" && family !== "codex" && family !== "claude-code")
    || typeof value.readProviderSetup !== "function"
    || typeof value.discoverProviderInstallation !== "function"
    || typeof value.configureProviderInstallation !== "function"
    || typeof value.recordProviderModelCatalog !== "function"
    || typeof value.configureProviderChatModels !== "function"
    || typeof value.syncMetaAgentRegistrations !== "function"
    || typeof value.readActiveMetaAgentRegistrations !== "function"
    || typeof value.inspectProviderModelCatalog !== "function"
    || typeof value.readCachedProfileReadiness !== "function"
    || typeof value.checkProfileReadiness !== "function"
    || typeof value.attachRuntime !== "function") {
    throw new Error("session_id_unified_provider_owner_invalid");
  }
}

function providerDisplayName(providerFamily: ProviderFamily): string {
  if (providerFamily === "opencode") return "OpenCode";
  if (providerFamily === "codex") return "Codex";
  return "Claude Code";
}

function assertAuthentication(authentication: Readonly<{
  authenticatedUserId: string;
  source: "authenticated_runtime_bridge";
}>): void {
  if (authentication.source !== "authenticated_runtime_bridge") {
    throw new Error("session_id_runtime_source_denied");
  }
  requiredText(authentication.authenticatedUserId, "session_id_authenticated_user_required");
}

function templateVersionView(version: TemplateVersionRecord) {
  return Object.freeze({
    templateVersionId: version.templateVersionId,
    version: version.version,
    definitionHash: version.definitionHash,
    ...(version.assetManifestHash ? { assetManifestHash: version.assetManifestHash } : {}),
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
    definitionText: JSON.stringify(version.definition, null, 2),
  });
}

function profileRole(
  definition: TemplateDefinitionV3,
  executionProfileId: string,
): AgentCardDefinition["kind"] {
  const roles = new Set<AgentCardDefinition["kind"]>();
  if (definition.conductor.executionProfileId === executionProfileId) roles.add("conductor");
  for (const card of definition.agentCards) {
    if (card.executionProfileId === executionProfileId) roles.add(card.kind);
  }
  if (roles.size !== 1) throw new Error("session_id_profile_role_ambiguous");
  return [...roles][0]!;
}

function templateProfileOptionOrder(input: Readonly<{ providerFamily: string }>): number {
  if (input.providerFamily === "codex") return 0;
  if (input.providerFamily === "claude-code") return 1;
  if (input.providerFamily === "opencode") return 2;
  return 3;
}

function roleOrder(role: AgentCardDefinition["kind"]): number {
  if (role === "conductor") return 0;
  if (role === "publisher") return 1;
  if (role === "reviewer") return 2;
  return 3;
}

function sameMetaTarget(
  left: Readonly<{ kind: string; templateDraftId?: string; taskSetupDraftId?: string }>,
  right: Readonly<{ kind: string; templateDraftId?: string; taskSetupDraftId?: string }>,
): boolean {
  return left.kind === right.kind
    && left.templateDraftId === right.templateDraftId
    && left.taskSetupDraftId === right.taskSetupDraftId;
}

function metaTurnStatus(status?: string): "creating" | "active" | "idle" | "ambiguous" | "failed" {
  if (status === "pending" || status === "leased" || status === "provider_accepted") return "creating";
  if (status === "ambiguous") return "ambiguous";
  if (status === "failed" || status === "rejected") return "failed";
  if (status === "returned") return "idle";
  return "active";
}

function metaOperationPath(operation: MetaPatchOperation): string {
  switch (operation.kind) {
    case "template_metadata_set": return `metadata.${operation.field}`;
    case "template_conductor_prompt_set": return "definition.conductor.systemPrompt";
    case "template_conductor_prompt_edit": return "definition.conductor.systemPrompt";
    case "template_card_create": return `definition.agentCards[${operation.agentCardId}]`;
    case "template_card_update": return `definition.agentCards[${operation.agentCardId}]`;
    case "template_card_remove": return `definition.agentCards[${operation.agentCardId}]`;
    case "template_card_reorder": return "definition.agentCards.order";
    case "template_card_prompt_set": return `definition.agentCards[${operation.agentCardId}].systemPrompt`;
    case "template_card_prompt_edit": return `definition.agentCards[${operation.agentCardId}].systemPrompt`;
    case "template_profile_model_set": return `definition.executionProfiles[${operation.executionProfileId}].model`;
    case "template_profile_revision_set": return `definition.executionProfiles[${operation.executionProfileId}]`;
    case "template_card_profile_set": return `definition.agentCards[${operation.agentCardId}].executionProfileId`;
    case "template_deliverable_upsert": return `definition.deliverables[${operation.artifactPath}]`;
    case "template_deliverable_remove": return `definition.deliverables[${operation.artifactPath}]`;
    case "task_setup_title_set": return "title";
    case "task_setup_goal_set": return "goal";
    case "task_setup_input_set": return `taskInputValues[${operation.fieldId}]`;
  }
}

function metaOperationDiff(
  operation: MetaPatchOperation,
  templateDraft: TemplateDraftRecord | undefined,
  taskSetupDraft: TaskSetupDraftRecord | undefined,
): Readonly<{
  path: string;
  operation: "add" | "remove" | "replace";
  before?: string;
  after?: string;
}> {
  const path = metaOperationPath(operation);
  switch (operation.kind) {
    case "template_metadata_set": {
      const before = templateDraft?.metadata[operation.field];
      return operation.value === null
        ? { path, operation: "remove", ...(before === undefined ? {} : { before }) }
        : { path, operation: before === undefined ? "add" : "replace", ...(before === undefined ? {} : { before }), after: operation.value };
    }
    case "template_conductor_prompt_set":
      return { path, operation: "replace", ...(templateDraft ? { before: templateDraft.definition.conductor.systemPrompt } : {}), after: operation.value };
    case "template_conductor_prompt_edit": {
      return {
        path,
        operation: "replace",
        before: operation.oldText,
        after: operation.newText,
      };
    }
    case "template_card_create": {
      const card = {
        agentCardId: operation.agentCardId,
        kind: operation.cardKind,
        title: operation.title,
        ...(operation.role === undefined ? {} : { role: operation.role }),
        executionProfileId: operation.executionProfileId,
        systemPrompt: operation.systemPrompt,
        capabilityRefs: [],
        dispatchProfile: operation.dispatchProfile,
      };
      return { path: `definition.agentCards[${operation.title}]`, operation: "add", after: JSON.stringify(card, null, 2) };
    }
    case "template_card_update": {
      const current = templateDraft?.definition.agentCards.find((card) => card.agentCardId === operation.agentCardId);
      const next = current ? {
        ...current,
        ...(operation.title === undefined ? {} : { title: operation.title }),
        ...(operation.role === undefined ? {} : operation.role === null ? { role: undefined } : { role: operation.role }),
        ...(operation.executionProfileId === undefined ? {} : { executionProfileId: operation.executionProfileId }),
        ...(operation.systemPrompt === undefined ? {} : { systemPrompt: operation.systemPrompt }),
        ...(operation.dispatchProfile === undefined ? {} : { dispatchProfile: operation.dispatchProfile }),
      } : operation;
      return {
        path: `definition.agentCards[${current?.title ?? operation.agentCardId}]`,
        operation: "replace",
        ...(current ? { before: JSON.stringify(current, null, 2) } : {}),
        after: JSON.stringify(next, null, 2),
      };
    }
    case "template_card_remove": {
      const current = templateDraft?.definition.agentCards.find((card) => card.agentCardId === operation.agentCardId);
      return { path: `definition.agentCards[${current?.title ?? operation.agentCardId}]`, operation: "remove", ...(current ? { before: JSON.stringify(current, null, 2) } : {}) };
    }
    case "template_card_reorder": {
      const before = templateDraft?.definition.agentCards.length;
      return {
        path,
        operation: "replace",
        ...(before === undefined ? {} : { before: `${before} 张 Agent Card` }),
        after: `${operation.agentCardIds.length} 张 Agent Card · 新顺序`,
      };
    }
    case "template_card_prompt_set": {
      const before = templateDraft?.definition.agentCards.find((card) => card.agentCardId === operation.agentCardId)?.systemPrompt;
      return { path, operation: before === undefined ? "add" : "replace", ...(before === undefined ? {} : { before }), after: operation.value };
    }
    case "template_card_prompt_edit": {
      return {
        path,
        operation: "replace",
        before: operation.oldText,
        after: operation.newText,
      };
    }
    case "template_profile_model_set": {
      const before = templateDraft?.definition.executionProfiles.find((profile) => profile.executionProfileId === operation.executionProfileId)?.model;
      return { path, operation: before === undefined ? "add" : "replace", ...(before === undefined ? {} : { before }), after: operation.value };
    }
    case "template_profile_revision_set": {
      const before = templateDraft?.definition.executionProfiles.find((profile) => profile.executionProfileId === operation.executionProfileId);
      return {
        path,
        operation: before === undefined ? "add" : "replace",
        ...(before === undefined ? {} : { before: JSON.stringify(before, null, 2) }),
        after: JSON.stringify(operation.profile, null, 2),
      };
    }
    case "template_card_profile_set": {
      const before = templateDraft?.definition.conductor.agentCardId === operation.agentCardId
        ? templateDraft.definition.conductor.executionProfileId
        : templateDraft?.definition.agentCards.find((card) => card.agentCardId === operation.agentCardId)?.executionProfileId;
      return { path, operation: before === undefined ? "add" : "replace", ...(before === undefined ? {} : { before }), after: operation.executionProfileId };
    }
    case "template_deliverable_upsert": {
      const current = templateDraft?.definition.deliverables.find((deliverable) => deliverable.artifactPath === operation.artifactPath);
      const next = {
        artifactPath: operation.artifactPath,
        ownerAgentCardId: operation.ownerAgentCardId,
        ...(operation.description === undefined ? {} : { description: operation.description }),
      };
      return {
        path,
        operation: current ? "replace" : "add",
        ...(current ? { before: JSON.stringify(current, null, 2) } : {}),
        after: JSON.stringify(next, null, 2),
      };
    }
    case "template_deliverable_remove": {
      const current = templateDraft?.definition.deliverables.find(
        (deliverable) => deliverable.artifactPath === operation.artifactPath,
      );
      return {
        path,
        operation: "remove",
        ...(current ? { before: JSON.stringify(current, null, 2) } : {}),
      };
    }
    case "task_setup_title_set":
      return { path, operation: "replace", ...(taskSetupDraft ? { before: taskSetupDraft.title } : {}), after: operation.value };
    case "task_setup_goal_set":
      return { path, operation: "replace", ...(taskSetupDraft ? { before: taskSetupDraft.goal } : {}), after: operation.value };
    case "task_setup_input_set": {
      const before = taskSetupDraft?.taskInputValues.find((value) => value.fieldId === operation.fieldId)?.value;
      return { path, operation: before === undefined ? "add" : "replace", ...(before === undefined ? {} : { before }), after: operation.value };
    }
  }
}

function commandTaskId(command: SessionIdUnifiedRendererCommand): string | undefined {
  return "taskId" in command && typeof command.taskId === "string" ? command.taskId : undefined;
}

function commandRunId(
  command: SessionIdUnifiedRendererCommand,
  result: SessionIdUnifiedCommandResult,
): string | undefined {
  if ("runId" in command && typeof command.runId === "string") return command.runId;
  return "run" in result && result.run?.runId ? result.run.runId : undefined;
}

function metaModeOrder(mode: "template_design" | "task_setup"): number {
  return mode === "template_design" ? 0 : 1;
}

function byCreatedAtThen<T extends Readonly<{ createdAt: string }>>(
  identity: (value: T) => string,
): (left: T, right: T) => number {
  return (left, right) => left.createdAt.localeCompare(right.createdAt)
    || identity(left).localeCompare(identity(right));
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function requiredText(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
