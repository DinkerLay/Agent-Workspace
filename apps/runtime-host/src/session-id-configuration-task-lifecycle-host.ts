import { randomUUID } from "node:crypto";
import {
  assertSessionExecutionSafeValue,
  isMetaProfileDefinitionV3,
  isTaskArchitectureSnapshotV3,
  validateMetaProfileOptionDefinitionV3,
  validateTaskArchitectureSnapshotV3,
  type ExecutionProfileDefinitionV3,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionDefinitionV3,
  type SessionRuntimeBindingReadyEvent,
  type TaskRunRecord,
  type TemplateDraftRecord,
} from "@agent-workspace/runtime-contracts";
import {
  createAcpMetaAgentRegistry,
  createSessionIdConfigurationTaskLifecycle,
  createSessionIdMetaAgentOwner,
  createSessionIdMetaTemplateToolOwner,
  installBuiltInTemplates,
  resolveAuthorizedWorkspaceV3,
  sessionIdInitialConductorTurnId,
  type AcpMetaAgentRegistration,
  type SessionIdAcpOrchestrationCommandTaskScope,
  type SessionIdAcpTaskLifecycleOwnerCapabilities,
  type SessionIdAcpTaskLifecyclePort,
  type SessionIdConductorLane,
  type SessionIdOrchestrationTaskScope,
} from "@agent-workspace/runtime-application";
import type {
  SessionIdCanonicalStore,
  SqliteRuntimeStore,
  createRuntimeRepositories,
} from "@agent-workspace/runtime-store";
import type {
  SessionIdAcpApplicationReady,
  SessionIdAcpRunApplication,
} from "./session-id-acp-application-assembly.js";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";

export type SessionIdConfigurationTaskLifecycleHostPersistence = Readonly<{
  sqlite: SqliteRuntimeStore;
  repositories: ReturnType<typeof createRuntimeRepositories>;
  canonical: SessionIdCanonicalStore;
}>;

export type SessionIdConfigurationTaskLifecycleHostOptions = Readonly<{
  /** All owner capabilities and the ACP application must be backed by this same persistence. */
  persistence: SessionIdConfigurationTaskLifecycleHostPersistence;
  acpApplication: SessionIdAcpApplicationReady;
  acpTaskLifecycle: SessionIdAcpTaskLifecyclePort;
  acpTaskOwners: SessionIdAcpTaskLifecycleOwnerCapabilities;
  metaAgentRegistrations: readonly AcpMetaAgentRegistration[];
  listTemplateProfileRevisions: (input: Readonly<{
    draft: TemplateDraftRecord;
    executionProfileId: string;
  }>) => readonly ExecutionProfileDefinitionV3[];
  now?: () => string;
  createId?: (kind: string) => string;
  /** Bounds the lifecycle-owned Meta readiness cache probe. */
  metaReadinessProbeTimeoutMs?: number;
}>;

type BoundRun = Readonly<{
  lifecycleScope: SessionIdOrchestrationTaskScope;
  acpScope: SessionIdAcpOrchestrationCommandTaskScope;
  application: SessionIdAcpRunApplication;
  lane: SessionIdConductorLane;
}>;

const HOST_OPTION_KEYS = Object.freeze([
  "persistence",
  "acpApplication",
  "acpTaskLifecycle",
  "acpTaskOwners",
  "metaAgentRegistrations",
  "listTemplateProfileRevisions",
  "now",
  "createId",
  "metaReadinessProbeTimeoutMs",
] as const);

const BINDING_READY_EVENT_KEYS = Object.freeze([
  "type",
  "sessionExecutionRuntimeId",
  "logicalSessionId",
  "bindingId",
  "bindingRevision",
  "executionProfileId",
  "profileRevisionId",
  "bindingHandle",
  "recoverable",
  "observedAt",
] as const);

/**
 * ACP-only configuration and Task lifecycle composition.
 *
 * This Host is a coordinator, not an owner of the injected persistence,
 * ACP application, Meta ports, or native children. Task start atomically
 * stages the v3 Conductor Binding/SR pair and durable task_goal through the
 * one ACP run application. A separately observed, exactly fenced native
 * Binding-ready event is required before the Run leaves `starting`.
 */
export function createSessionIdConfigurationTaskLifecycleHost(
  options: SessionIdConfigurationTaskLifecycleHostOptions,
) {
  validateOptions(options);
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? ((kind: string) => `${kind}_${randomUUID()}`);
  const { sqlite, repositories, canonical } = options.persistence;
  const workspaceResolver = createNodeWorkspaceDirectoryResolver();
  const metaRegistrations = Object.freeze(options.metaAgentRegistrations.map((registration) => Object.freeze({
    option: validateMetaProfileOptionDefinitionV3(registration.option),
    port: registration.port,
  })));
  const metaAgents = createAcpMetaAgentRegistry(metaRegistrations, {
    ...(options.metaReadinessProbeTimeoutMs === undefined
      ? {}
      : { probeTimeoutMs: options.metaReadinessProbeTimeoutMs }),
  });
  const metaOptions = new Map<string, MetaProfileOptionDefinitionV3>();
  const runs = new Map<string, BoundRun>();
  const metaDrainAbort = new AbortController();
  const metaDrains = new Set<Promise<number>>();
  let closed = false;

  registerMetaAgentRegistrations(metaRegistrations);
  installBuiltInTemplates(repositories, now());

  const lifecycle = createSessionIdConfigurationTaskLifecycle({
    now,
    createId,
    transaction: repositories.transaction,
    templates: repositories.templateTask,
    configuration: repositories.configuration,
    workspaces: repositories.workspace,
    commands: repositories.command,
    taskRun: canonical.taskRun,
    workspaceFiles: canonical.workspace,
    retention: canonical.retention,
    canonicalizeWorkspaceDirectory: (directory) => workspaceResolver.canonicalizeDirectory(directory),
    resolveWorkspace: (authorization) => resolveAuthorizedWorkspaceV3(workspaceResolver, authorization),
    resolveMetaProfileOption: resolveMetaOption,
    assertMetaProfileReady,
    acpTaskLifecycle: options.acpTaskLifecycle,
    acpTaskOwners: options.acpTaskOwners,
    createConductorLane,
  });
  const metaAgent = createSessionIdMetaAgentOwner({
    now,
    createId,
    templates: repositories.templateTask,
    configuration: repositories.configuration,
    metaAgents,
    resolveMetaProfileOption: resolveMetaOption,
    templateDraftTools: createSessionIdMetaTemplateToolOwner({
      templates: repositories.templateTask,
      toolOperations: repositories.configuration,
      listTemplateProfileRevisions: options.listTemplateProfileRevisions,
    }),
    resolveTemplateProfileRevision({ draft, executionProfileId, profileRevisionId }) {
      const profile = options.listTemplateProfileRevisions({ draft, executionProfileId })
        .find((candidate) => candidate.profileRevisionId === profileRevisionId);
      if (!profile) throw new Error("meta_patch_profile_revision_not_host_issued");
      return profile;
    },
  });

  return Object.freeze({
    lifecycle,
    registerMetaAgentRegistrations,
    metaReadiness: Object.freeze({
      readOption(metaProfileOptionId: string) {
        ensureOpen();
        const option = resolveMetaOption(metaProfileOptionId);
        return metaAgents.readiness(option.metaProfileOptionId, option.profile);
      },
      probeOption(metaProfileOptionId: string) {
        ensureOpen();
        const option = resolveMetaOption(metaProfileOptionId);
        return metaAgents.probe(option.metaProfileOptionId, option.profile);
      },
    }),
    drainMetaTurns(maxItems = 1, signal?: AbortSignal): Promise<number> {
      ensureOpen();
      const combinedSignal = signal
        ? AbortSignal.any([metaDrainAbort.signal, signal])
        : metaDrainAbort.signal;
      const pending = metaAgent.drain(maxItems, combinedSignal)
        .finally(() => metaDrains.delete(pending));
      metaDrains.add(pending);
      return pending;
    },
    orchestrationForRun(runId: string): SessionIdAcpRunApplication {
      ensureOpen();
      const existing = runs.get(runId);
      if (existing) return existing.application;
      const run = repositories.templateTask.getRun(runId);
      if (!run) throw new Error("session_id_run_orchestration_not_found");
      const task = repositories.templateTask.getTask(run.taskId);
      const architecture = repositories.templateTask.getArchitectureSnapshot(run.taskId);
      const taskGoal = canonical.message.listMessages(runId).find((message) => message.kind === "task_goal");
      if (!task || !architecture || !taskGoal) throw new Error("session_id_run_orchestration_not_found");
      const bound = bindRun(Object.freeze({
        taskId: task.taskId,
        runId: run.runId,
        revision: task.revision,
        conductorSessionId: run.conductorLogicalSessionId,
        conductorSessionTurnId: sessionIdInitialConductorTurnId(run.runId, taskGoal.messageId),
        agentCards: Object.freeze(architecture.definition.agentCards.map((card) => Object.freeze({
          agentCardId: card.agentCardId,
          executionProfileId: card.executionProfileId,
        }))),
      }));
      return bound.application;
    },
    onBindingReady(event: SessionRuntimeBindingReadyEvent): TaskRunRecord | undefined {
      ensureOpen();
      return sqlite.transaction(() => acceptBindingReady(event));
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      metaDrainAbort.abort();
      await Promise.allSettled([...metaDrains]);
      runs.clear();
    },
  });

  function createConductorLane(scope: SessionIdOrchestrationTaskScope): SessionIdConductorLane {
    return bindRun(scope).lane;
  }

  function registerMetaAgentRegistrations(
    registrations: readonly AcpMetaAgentRegistration[],
  ): void {
    ensureOpen();
    metaAgents.register(registrations);
    for (const registration of registrations) {
      const option = validateMetaProfileOptionDefinitionV3(registration.option);
      const existing = metaOptions.get(option.metaProfileOptionId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(option)) {
          throw new Error("meta_profile_option_duplicate");
        }
        continue;
      }
      metaOptions.set(option.metaProfileOptionId, option);
    }
  }

  function bindRun(scope: SessionIdOrchestrationTaskScope): BoundRun {
    ensureOpen();
    const existing = runs.get(scope.runId);
    if (existing) {
      if (!sameLifecycleScope(existing.lifecycleScope, scope)) {
        throw new Error("session_id_run_orchestration_scope_conflict");
      }
      return existing;
    }
    const acpScope = compileAcpScope(scope);
    const application = options.acpApplication.createRunApplication(acpScope);
    const lane: SessionIdConductorLane = Object.freeze({
      enqueueTaskGoal: (input) => application.commandApplication.enqueueTaskGoal(input),
    });
    const bound = Object.freeze({
      lifecycleScope: freezeLifecycleScope(scope),
      acpScope,
      application,
      lane,
    });
    runs.set(scope.runId, bound);
    return bound;
  }

  function compileAcpScope(
    scope: SessionIdOrchestrationTaskScope,
  ): SessionIdAcpOrchestrationCommandTaskScope {
    const snapshot = repositories.templateTask.getArchitectureSnapshot(scope.taskId);
    if (!snapshot || !isTaskArchitectureSnapshotV3(snapshot)) throw new Error("template_v2_read_only");
    const architecture = validateTaskArchitectureSnapshotV3(snapshot);
    if (architecture.taskId !== scope.taskId
      || scope.agentCards.length !== architecture.definition.agentCards.length
      || scope.agentCards.some((card, index) => {
        const frozen = architecture.definition.agentCards[index];
        return !frozen
          || card.agentCardId !== frozen.agentCardId
          || card.executionProfileId !== frozen.executionProfileId;
      })) {
      throw new Error("session_id_run_orchestration_scope_conflict");
    }
    return Object.freeze({
      taskId: scope.taskId,
      runId: scope.runId,
      conductorSessionId: scope.conductorSessionId,
      initialConductorSessionTurnId: scope.conductorSessionTurnId,
      agentCards: Object.freeze(architecture.definition.agentCards.map((card) => {
        const profile = architecture.definition.executionProfiles.find((candidate) =>
          candidate.executionProfileId === card.executionProfileId);
        if (!profile) throw new Error("session_id_run_orchestration_profile_not_found");
        return Object.freeze({
          agentCardId: card.agentCardId,
          executionProfileId: profile.executionProfileId,
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
        });
      })),
    });
  }

  function acceptBindingReady(event: SessionRuntimeBindingReadyEvent): TaskRunRecord | undefined {
    validateBindingReadyEvent(event);
    const binding = options.acpTaskOwners.binding.getBinding(event.bindingId);
    const current = options.acpTaskOwners.binding.getCurrentBinding(event.logicalSessionId);
    const runtime = options.acpTaskOwners.sessionRuntime.getRuntime(event.sessionExecutionRuntimeId);
    if (!binding || !current || !runtime
      || binding.bindingId !== current.bindingId
      || binding.revision !== current.revision
      || binding.bindingId !== event.bindingId
      || binding.revision !== event.bindingRevision
      || binding.logicalSessionId !== event.logicalSessionId
      || binding.executionProfileId !== event.executionProfileId
      || binding.profileRevisionId !== event.profileRevisionId
      || binding.bindingHandle !== event.bindingHandle
      || binding.recoverable !== event.recoverable
      || binding.status !== "active"
      || binding.recoverable !== true
      || runtime.sessionExecutionRuntimeId !== event.sessionExecutionRuntimeId
      || runtime.taskId !== binding.taskId
      || runtime.runId !== binding.runId
      || runtime.logicalSessionId !== binding.logicalSessionId
      || runtime.state === "closed") {
      throw new Error("session_id_binding_ready_fence_mismatch");
    }
    const task = repositories.templateTask.getTask(binding.taskId);
    const run = repositories.templateTask.getRun(binding.runId);
    const snapshot = repositories.templateTask.getArchitectureSnapshot(binding.taskId);
    if (!task || !run || !snapshot || !isTaskArchitectureSnapshotV3(snapshot)
      || task.activeRunId !== binding.runId || run.taskId !== binding.taskId
      || (run.status !== "starting" && run.status !== "running")) {
      throw new Error("session_id_binding_ready_scope_mismatch");
    }
    const architecture = validateTaskArchitectureSnapshotV3(snapshot);
    if (architecture.taskId !== binding.taskId) {
      throw new Error("session_id_binding_ready_scope_mismatch");
    }
    const profile = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === binding.executionProfileId);
    if (!profile
      || profile.profileRevisionId !== binding.profileRevisionId
      || profile.providerFamily !== binding.providerFamily) {
      throw new Error("session_id_binding_ready_profile_mismatch");
    }
    if (binding.logicalSessionId === run.conductorLogicalSessionId) {
      if (binding.agentCardId !== architecture.definition.conductor.agentCardId
        || binding.executionProfileId !== architecture.definition.conductor.executionProfileId) {
        throw new Error("session_id_binding_ready_conductor_mismatch");
      }
      return lifecycle.activateRun({
        taskId: binding.taskId,
        runId: binding.runId,
        conductorBindingId: binding.bindingId,
      });
    }
    const generation = canonical.taskRun.getGeneration(binding.logicalSessionId);
    const slot = canonical.taskRun.findSlot(binding.runId, binding.agentCardId);
    const card = architecture.definition.agentCards.find((candidate) =>
      candidate.agentCardId === binding.agentCardId);
    if (!generation || generation.lifecycle !== "current"
      || generation.taskId !== binding.taskId
      || generation.runId !== binding.runId
      || generation.sessionId !== binding.logicalSessionId
      || generation.agentCardId !== binding.agentCardId
      || generation.executionProfileId !== binding.executionProfileId
      || !slot
      || slot.cardSessionSlotId !== generation.cardSessionSlotId
      || slot.currentSessionId !== binding.logicalSessionId
      || slot.latestGeneration !== generation.generation
      || !card || card.executionProfileId !== binding.executionProfileId) {
      throw new Error("session_id_binding_ready_card_mismatch");
    }
    return undefined;
  }

  function ensureOpen(): void {
    if (closed) throw new Error("session_id_configuration_task_lifecycle_host_closed");
  }

  function resolveMetaOption(metaProfileOptionId: string): MetaProfileOptionDefinitionV3 {
    const option = metaOptions.get(metaProfileOptionId);
    if (!option) throw new Error("meta_profile_option_not_found");
    return option;
  }

  async function assertMetaProfileReady(
    profile: Parameters<Parameters<typeof createSessionIdConfigurationTaskLifecycle>[0]["assertMetaProfileReady"]>[0],
    metaProfileOptionId: string,
  ): Promise<void> {
    if (!isMetaProfileDefinitionV3(profile)) throw new Error("meta_profile_v2_read_only");
    const readiness = await metaAgents.probe(
      metaProfileOptionId,
      profile as MetaProfileDefinitionV3,
      { force: true },
    );
    if (readiness.status !== "available") {
      throw new Error(`meta_agent_profile_unavailable:${readiness.reasons[0] ?? readiness.status}`);
    }
  }
}

function validateOptions(options: SessionIdConfigurationTaskLifecycleHostOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !(HOST_OPTION_KEYS as readonly string[]).includes(key))
    || !options.persistence || typeof options.persistence !== "object"
    || typeof options.persistence.sqlite?.transaction !== "function"
    || typeof options.persistence.repositories?.transaction !== "function"
    || typeof options.persistence.canonical?.taskRun?.readTaskRunState !== "function"
    || options.acpApplication?.drainSeal?.blocking !== 0
    || typeof options.acpApplication?.createRunApplication !== "function"
    || typeof options.acpApplication?.close !== "function"
    || typeof options.acpTaskLifecycle?.prepare !== "function"
    || typeof options.acpTaskLifecycle?.stage !== "function"
    || typeof options.acpTaskOwners?.binding?.getBinding !== "function"
    || typeof options.acpTaskOwners?.binding?.getCurrentBinding !== "function"
    || typeof options.acpTaskOwners?.sessionRuntime?.getRuntime !== "function"
    || !Array.isArray(options.metaAgentRegistrations)
    || typeof options.listTemplateProfileRevisions !== "function"
    || (options.now !== undefined && typeof options.now !== "function")
    || (options.createId !== undefined && typeof options.createId !== "function")) {
    throw new Error("session_id_lifecycle_host_options_invalid");
  }
}

function validateBindingReadyEvent(event: SessionRuntimeBindingReadyEvent): void {
  assertSessionExecutionSafeValue(event, "Session Runtime Binding-ready event");
  if (!event || typeof event !== "object" || Array.isArray(event)
    || !sameKeys(event as unknown as Record<string, unknown>, BINDING_READY_EVENT_KEYS)
    || event.type !== "session_runtime.binding_ready"
    || !Number.isSafeInteger(event.bindingRevision) || event.bindingRevision < 1
    || event.recoverable !== true
    || !isIsoTimestamp(event.observedAt)) {
    throw new Error("session_id_binding_ready_event_invalid");
  }
}

function freezeLifecycleScope(scope: SessionIdOrchestrationTaskScope): SessionIdOrchestrationTaskScope {
  return Object.freeze({
    ...scope,
    agentCards: Object.freeze(scope.agentCards.map((card) => Object.freeze({ ...card }))),
  });
}

function sameLifecycleScope(
  left: SessionIdOrchestrationTaskScope,
  right: SessionIdOrchestrationTaskScope,
): boolean {
  return left.taskId === right.taskId
    && left.runId === right.runId
    && left.revision === right.revision
    && left.conductorSessionId === right.conductorSessionId
    && left.conductorSessionTurnId === right.conductorSessionTurnId
    && left.agentCards.length === right.agentCards.length
    && left.agentCards.every((card, index) => card.agentCardId === right.agentCards[index]?.agentCardId
      && card.executionProfileId === right.agentCards[index]?.executionProfileId);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
