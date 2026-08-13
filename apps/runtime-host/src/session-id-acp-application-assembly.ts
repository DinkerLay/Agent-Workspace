import type {
  AcpV3BindingRetirementIntentRecord,
  JsonValue,
  ProviderFamily,
  SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  canonicalJson,
  cloneAcpV3BindingRetirementIntentRecord,
  validateTaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import {
  createAcpV3FrozenProfileTupleResolver,
  createSessionExecutionRuntimeOwner,
  createSessionExecutionSettlementCoordinator,
  createSessionIdAcpCanonicalSettlementCommitter,
  createSessionIdAcpCardBindingOwner,
  createSessionIdAcpCloseSessionOwner,
  createSessionIdAcpDeliveryResultOwner,
  createSessionIdAcpOrchestrationBridge,
  createSessionIdAcpOrchestrationCommandApplication,
  createSessionIdAcpRendererCommandApplication,
  createSessionIdAcpInteractionResponseOwner,
  createSessionIdAcpTerminalNoticeCoordinator,
  type SessionExecutionRecordRepository,
  type SessionExecutionRuntimeOwner,
  type SessionIdAcpCanonicalSettlementCapabilities,
  type SessionIdAcpCloseSessionCapabilities,
  type SessionIdAcpDeliveryResultOwnerCapabilities,
  type SessionIdAcpEffectObservation,
  type SessionIdAcpEffectObservationResult,
  type SessionIdAcpOrchestrationCommandCapabilities,
  type SessionIdAcpOrchestrationCommandTaskScope,
  type SessionIdAcpRendererCommandCapabilities,
  type SessionIdAcpInteractionResponseCapabilities,
  type SessionIdAcpTerminalNoticeCapabilities,
} from "@agent-workspace/runtime-application";
import {
  createAcpSessionRuntimeRepositories,
  createRuntimeRepositories,
  createSessionIdCanonicalStore,
  type AcpSessionRuntimeRepositories,
  type AcpV3FrozenProfileTupleResolver,
  type AcpV3SessionRuntimeRepository,
  type SessionIdCanonicalStore,
  type SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";
import type {
  AcpTaskSessionRuntimeDeliveryReceipt,
  AcpTaskSessionRuntimeCloseControlResolution,
  AcpTaskSessionRuntimeInterruptCorrelationResolution,
  AcpTaskSessionRuntimeProvider,
  AcpTaskSessionRuntimeTaskStopControlResolution,
} from "./acp-task-session-runtime-provider.js";
import {
  createSessionIdAcpCloseSessionDrain,
} from "./session-id-acp-close-session-drain.js";
import {
  createSessionIdAcpProviderDrain,
  type SessionIdAcpProviderDrain,
} from "./session-id-acp-provider-drain.js";
import {
  createSessionIdAcpRuntimePump,
} from "./session-id-acp-runtime-pump.js";
import {
  createSessionIdAcpTaskStopApplication,
  type SessionIdAcpTaskStopCapabilities,
} from "../../../packages/runtime-application/src/session-id-acp-task-stop-application.js";

export type SessionIdAcpApplicationProviderOwner = Readonly<{
  provider: Pick<
    AcpTaskSessionRuntimeProvider,
    "executeProviderEffect" | "retireBinding" | "retireBindingForClose"
  >;
  close(): Promise<void>;
}>;

export type SessionIdAcpApplicationProviderFactoryInput = Readonly<{
  repositories: AcpSessionRuntimeRepositories;
  sessionRuntimeOwner: SessionExecutionRuntimeOwner;
  resolveFrozenProfileTuple: AcpV3FrozenProfileTupleResolver;
  resolveInterruptCorrelation(input: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    sessionControlAuditId: string;
    sessionExecutionAttemptId: string;
    orchestrationSessionTurnId: string;
  }>): AcpTaskSessionRuntimeInterruptCorrelationResolution;
  resolveTaskStopControl(input: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    sessionControlAuditId: string;
    idempotencyKey: string;
  }>): AcpTaskSessionRuntimeTaskStopControlResolution | undefined;
  resolveCloseControl(input: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    sessionControlAuditId: string;
    idempotencyKey: string;
    bindingId: string;
    bindingRevision: number;
    executionProfileId: string;
    profileRevisionId: string;
    providerFamily: ProviderFamily;
  }>): AcpTaskSessionRuntimeCloseControlResolution | undefined;
  authorizeRetiringBindingRecovery(intent: AcpV3BindingRetirementIntentRecord): boolean;
  onDeliveryReceipt(receipt: AcpTaskSessionRuntimeDeliveryReceipt): Promise<void>;
}>;

export type SessionIdAcpApplicationAssemblyOptions = Readonly<{
  store: SqliteRuntimeStore;
  authenticatedUserId: string;
  now: () => string;
  createId: (kind: string) => string;
  /** True only under supervisor proof that the predecessor Host is confirmed dead. */
  authorizeRetiringBindingRecovery(intent: AcpV3BindingRetirementIntentRecord): boolean;
  createProvider(
    input: SessionIdAcpApplicationProviderFactoryInput,
  ): SessionIdAcpApplicationProviderOwner | Promise<SessionIdAcpApplicationProviderOwner>;
}>;

export type SessionIdAcpRunApplication = Readonly<{
  commandApplication: ReturnType<typeof createSessionIdAcpOrchestrationCommandApplication>;
  rendererCommandApplication: PublicRendererCommandApplication;
  interactionResponseOwner: PublicInteractionResponseOwner;
  taskStopApplication: PublicTaskStopApplication;
  taskStopPump: Pick<
    ReturnType<typeof createSessionIdAcpTaskStopApplication>,
    "pumpTaskStop" | "reconcileTaskStop"
  >;
  closeSession: ReturnType<typeof createSessionIdAcpCloseSessionDrain>["closeSession"];
  cardBindingOwner: ReturnType<typeof createSessionIdAcpCardBindingOwner>;
  orchestrationBridge: ReturnType<typeof createSessionIdAcpOrchestrationBridge>;
  deliveryResultOwner: ReturnType<typeof createSessionIdAcpDeliveryResultOwner>;
  runtimePump: ReturnType<typeof createSessionIdAcpRuntimePump>;
}>;

type RendererCommandOwner = ReturnType<typeof createSessionIdAcpRendererCommandApplication>;
type PublicRendererCommandApplication = Readonly<{
  submitTaskInput(
    ...args: Parameters<RendererCommandOwner["submitTaskInput"]>
  ): ReturnType<RendererCommandOwner["submitTaskInput"]>["result"];
  sendHumanMessage(
    ...args: Parameters<RendererCommandOwner["sendHumanMessage"]>
  ): ReturnType<RendererCommandOwner["sendHumanMessage"]>["result"];
  abandonHumanMessage(
    ...args: Parameters<RendererCommandOwner["abandonHumanMessage"]>
  ): ReturnType<RendererCommandOwner["abandonHumanMessage"]>["result"];
}>;

type InteractionResponseOwner = ReturnType<typeof createSessionIdAcpInteractionResponseOwner>;
type PublicInteractionResponseOwner = Readonly<{
  respondToInteraction(
    ...args: Parameters<InteractionResponseOwner["respondToInteraction"]>
  ): ReturnType<InteractionResponseOwner["respondToInteraction"]>["result"];
}>;

type TaskStopOwner = ReturnType<typeof createSessionIdAcpTaskStopApplication>;
type PublicTaskStopApplication = Readonly<{
  stopTask(...args: Parameters<TaskStopOwner["stopTask"]>): ReturnType<TaskStopOwner["stopTask"]>["result"];
}>;

export type SessionIdAcpApplicationReady = Readonly<{
  drainSeal: Readonly<{
    total: number;
    safe: number;
    blocking: 0;
    historicalUninspectedProtocolTables: readonly string[];
  }>;
  createRunApplication(
    task: SessionIdAcpOrchestrationCommandTaskScope,
  ): SessionIdAcpRunApplication;
  close(): Promise<void>;
}>;

export class SessionIdAcpApplicationAssemblyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SessionIdAcpApplicationAssemblyError";
    this.code = code;
  }
}

/**
 * Provider-neutral production application root.
 *
 * Construction only binds in-process capabilities. `open()` performs the
 * irreversible cutover seal as its first synchronous operation; no Provider
 * factory can run before that transaction commits.
 */
export function createSessionIdAcpApplicationAssembly(
  options: SessionIdAcpApplicationAssemblyOptions,
): Readonly<{ open(): Promise<SessionIdAcpApplicationReady> }> {
  validateOptions(options);
  const canonical = createSessionIdCanonicalStore(options.store);
  const runtimeRepositories = createRuntimeRepositories(options.store);
  const resolveFrozenProfileTuple = createAcpV3FrozenProfileTupleResolver({
    templates: runtimeRepositories.templateTask,
    taskRun: canonical.taskRun,
  });
  const acpRepositories = createAcpSessionRuntimeRepositories(options.store, {
    resolveFrozenProfileTuple,
  });
  let openPromise: Promise<SessionIdAcpApplicationReady> | undefined;

  return Object.freeze({
    open() {
      if (!openPromise) openPromise = openAssembly();
      return openPromise;
    },
  });

  async function openAssembly(): Promise<SessionIdAcpApplicationReady> {
    // This is deliberately the first operation in openAssembly and precedes
    // its first await. The Store transaction serializes this seal against the
    // superseded direct Binding writer.
    const inventory = acpRepositories.directDrain.sealDrainedForCutover();
    if (inventory.blocking !== 0) throw safeError("session_id_acp_direct_drain_seal_invalid");
    const authorizeRetiringBindingRecovery = createStartupRetiringBindingRecoveryAuthorizer(
      acpRepositories,
      options.authorizeRetiringBindingRecovery,
    );

    const sessionRuntimeOwner = createSessionExecutionRuntimeOwner({
      repository: sessionExecutionRepository(acpRepositories),
      commandTransaction: sessionRuntimeCommandTransaction(acpRepositories),
      now: options.now,
      createRuntimeId: () => requiredGeneratedId(
        options.createId("session_execution_runtime"),
        "session_execution_runtime",
      ),
      createAttemptId: () => requiredGeneratedId(
        options.createId("session_execution_attempt"),
        "session_execution_attempt",
      ),
      createProviderEffectIntentId: () => requiredGeneratedId(
        options.createId("provider_effect"),
        "provider_effect",
      ),
    });
    const runs = new Map<string, RunRegistration>();
    const resultRouter = createResultRouter(runs, acpRepositories);
    const receiptSink = createReceiptSink(runs);
    let providerOwner: SessionIdAcpApplicationProviderOwner | undefined;
    try {
      providerOwner = await options.createProvider(Object.freeze({
        repositories: acpRepositories,
        sessionRuntimeOwner,
        resolveFrozenProfileTuple,
        resolveInterruptCorrelation: createInterruptCorrelationResolver(
          canonical,
          acpRepositories,
        ),
        resolveTaskStopControl: createTaskStopControlResolver(canonical),
        resolveCloseControl: createCloseControlResolver(
          canonical,
          acpRepositories,
          resolveFrozenProfileTuple,
        ),
        authorizeRetiringBindingRecovery,
        onDeliveryReceipt: receiptSink,
      }));
      if (!validProviderOwner(providerOwner)) {
        await closeInvalidProviderOwner(providerOwner);
        throw safeError("session_id_acp_application_provider_invalid");
      }
      const providerDrain = createSessionIdAcpProviderDrain({
        provider: providerOwner.provider,
        providerEffects: acpRepositories.reliability,
        resultOwner: resultRouter,
      });
      return createReady(
        inventory,
        providerOwner,
        providerDrain,
        canonical,
        runtimeRepositories.templateTask,
        acpRepositories,
        resolveFrozenProfileTuple,
        sessionRuntimeOwner,
        runs,
      );
    } catch (error) {
      if (providerOwner && validProviderOwner(providerOwner)) {
        try {
          await providerOwner.close();
        } catch {
          throw safeError("session_id_acp_application_cleanup_unconfirmed");
        }
      }
      throw error;
    }
  }

  function createReady(
    inventory: ReturnType<AcpSessionRuntimeRepositories["directDrain"]["sealDrainedForCutover"]>,
    providerOwner: SessionIdAcpApplicationProviderOwner,
    providerDrain: SessionIdAcpProviderDrain,
    canonical: SessionIdCanonicalStore,
    templates: ReturnType<typeof createRuntimeRepositories>["templateTask"],
    repositories: AcpSessionRuntimeRepositories,
    resolver: AcpV3FrozenProfileTupleResolver,
    sessionRuntimeOwner: SessionExecutionRuntimeOwner,
    runs: Map<string, RunRegistration>,
  ): SessionIdAcpApplicationReady {
    let closePromise: Promise<void> | undefined;
    let closed = false;
    const inFlight = new Set<Promise<unknown>>();
    const ready: SessionIdAcpApplicationReady = Object.freeze({
      drainSeal: Object.freeze({
        total: inventory.total,
        safe: inventory.safe,
        blocking: 0 as const,
        historicalUninspectedProtocolTables: Object.freeze([
          ...inventory.historicalUninspectedProtocolTables,
        ]),
      }),
      createRunApplication(task) {
        if (closed) throw safeError("session_id_acp_application_closed");
        validateTaskScope(task);
        const key = runKey(task.taskId, task.runId);
        const existing = runs.get(key);
        if (existing) {
          if (!sameTaskScope(existing.task, task)) {
            throw safeError("session_id_acp_run_application_scope_drift");
          }
          return existing.application;
        }
        const frozenTask = freezeTaskScope(task);
        const built = createRunApplication({
          task: frozenTask,
          canonical,
          templates,
          repositories,
          resolver,
          sessionRuntimeOwner,
          providerDrain,
          provider: providerOwner.provider,
        });
        const application = Object.freeze({
          ...built,
          closeSession: trackCloseSession(built.closeSession, () => closed, inFlight),
          runtimePump: trackRuntimePump(built.runtimePump, () => closed, inFlight),
          taskStopPump: trackTaskStopPump(built.taskStopPump, () => closed, inFlight),
        });
        runs.set(key, Object.freeze({
          task: frozenTask,
          application,
          deliveryResultOwner: application.deliveryResultOwner,
        }));
        return application;
      },
      close() {
        if (!closePromise) {
          closed = true;
          closePromise = (async () => {
            // Keep exact Run receipt routes available while already-started
            // drains quiesce. No new pump call is admitted after `closed`.
            await Promise.allSettled([...inFlight]);
            try {
              await providerOwner.close();
            } catch {
              // Sticky routes are intentional when child cleanup is unknown:
              // a late receipt must never be misrouted to another generation.
              throw safeError("session_id_acp_application_cleanup_unconfirmed");
            }
            runs.clear();
          })();
        }
        return closePromise;
      },
    });
    return ready;
  }

  function createRunApplication(input: Readonly<{
    task: SessionIdAcpOrchestrationCommandTaskScope;
    canonical: SessionIdCanonicalStore;
    templates: ReturnType<typeof createRuntimeRepositories>["templateTask"];
    repositories: AcpSessionRuntimeRepositories;
    resolver: AcpV3FrozenProfileTupleResolver;
    sessionRuntimeOwner: SessionExecutionRuntimeOwner;
    providerDrain: SessionIdAcpProviderDrain;
    provider: Pick<
      AcpTaskSessionRuntimeProvider,
      "executeProviderEffect" | "retireBinding" | "retireBindingForClose"
    >;
  }>): SessionIdAcpRunApplication {
    const architecture = requiredV3Architecture(input.templates, input.task.taskId);
    const canonicalCommitter = createSessionIdAcpCanonicalSettlementCommitter({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      task: {
        taskId: input.task.taskId,
        runId: input.task.runId,
        conductorSessionId: input.task.conductorSessionId,
      },
      transaction: canonicalSettlementTransaction(
        options.store,
        input.canonical,
        input.repositories,
      ),
    });
    const settlementCoordinator = createSessionExecutionSettlementCoordinator({
      committer: canonicalCommitter,
    });
    const terminalNoticeCoordinator = createSessionIdAcpTerminalNoticeCoordinator({
      now: options.now,
      task: {
        taskId: input.task.taskId,
        runId: input.task.runId,
        conductorSessionId: input.task.conductorSessionId,
      },
      transaction: terminalNoticeTransaction(
        options.store,
        input.canonical,
        input.repositories,
      ),
    });
    const orchestrationBridge = createSessionIdAcpOrchestrationBridge({
      orchestrationRead: input.canonical.orchestration,
      messageRead: input.canonical.message,
      taskRunRead: input.canonical.taskRun,
      currentBindingRead: input.repositories.binding,
      resolveFrozenProfileTuple: input.resolver,
      providerEffectRead: providerEffectLookup(input.repositories),
      sessionRuntimeOwner: input.sessionRuntimeOwner,
      settlementCoordinator,
    });
    const deliveryResultOwner = createSessionIdAcpDeliveryResultOwner({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      task: input.task,
      transaction: deliveryTransaction(
        options.store,
        input.canonical,
        input.repositories,
      ),
      bridge: orchestrationBridge,
      terminalNoticeCoordinator,
    });
    const cardBindingOwner = createSessionIdAcpCardBindingOwner({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      transaction: {
        run: (work) => options.store.transaction(() => work({
          taskRun: input.canonical.taskRun,
          architecture: input.templates,
          binding: input.repositories.binding,
          sessionRuntime: input.repositories.sessionRuntime,
        })),
      },
    });
    const commandApplication = createSessionIdAcpOrchestrationCommandApplication({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      task: input.task,
      transaction: commandTransaction(options.store, input.canonical, input.repositories),
      resolveFrozenProfile: input.resolver,
      interruptBridge: orchestrationBridge,
    });
    const closeOwner = createSessionIdAcpCloseSessionOwner({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      task: input.task,
      transaction: closeTransaction(options.store, input.canonical, input.repositories),
      resolveFrozenProfile: input.resolver,
    });
    const closeDrain = createSessionIdAcpCloseSessionDrain({
      owner: closeOwner,
      provider: input.provider,
    });
    const rendererCommandOwner = createSessionIdAcpRendererCommandApplication({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      task: input.task,
      transaction: rendererCommandTransaction(options.store, input.canonical, input.repositories),
      resolveFrozenProfile: input.resolver,
      interruptBridge: orchestrationBridge,
    });
    const interactionResponseOwner = createSessionIdAcpInteractionResponseOwner({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      authenticatedUserId: options.authenticatedUserId,
      task: {
        taskId: input.task.taskId,
        runId: input.task.runId,
        conductorSessionId: input.task.conductorSessionId,
      },
      transaction: interactionResponseTransaction(options.store, input.canonical, input.repositories),
      interactionBridge: orchestrationBridge,
    });
    const taskStopOwner = createSessionIdAcpTaskStopApplication({
      now: options.now,
      createId: (kind) => requiredGeneratedId(options.createId(kind), kind),
      architecture,
      task: { taskId: input.task.taskId, runId: input.task.runId },
      transaction: taskStopTransaction(
        options.store,
        input.canonical,
        input.templates,
        input.repositories,
      ),
      interruptBridge: orchestrationBridge,
      provider: input.provider,
    });
    const runtimePump = createSessionIdAcpRuntimePump({
      deliveryOwner: deliveryResultOwner,
      cardBindingOwner,
      orchestrationBridge,
      providerDrain: input.providerDrain,
    });
    return Object.freeze({
      commandApplication,
      rendererCommandApplication: rendererPublicApplication(rendererCommandOwner),
      interactionResponseOwner: interactionPublicOwner(interactionResponseOwner),
      taskStopApplication: taskStopPublicApplication(taskStopOwner),
      taskStopPump: Object.freeze({
        pumpTaskStop: taskStopOwner.pumpTaskStop,
        reconcileTaskStop: taskStopOwner.reconcileTaskStop,
      }),
      closeSession: closeDrain.closeSession,
      cardBindingOwner,
      orchestrationBridge,
      deliveryResultOwner,
      runtimePump,
    });
  }
}

type RunRegistration = Readonly<{
  task: SessionIdAcpOrchestrationCommandTaskScope;
  application: SessionIdAcpRunApplication;
  deliveryResultOwner: ReturnType<typeof createSessionIdAcpDeliveryResultOwner>;
}>;

function createReceiptSink(
  runs: ReadonlyMap<string, RunRegistration>,
): (receipt: AcpTaskSessionRuntimeDeliveryReceipt) => Promise<void> {
  return async (receipt) => {
    const target = runs.get(runKey(receipt.taskId, receipt.runId));
    if (!target) throw safeError("session_id_acp_receipt_owner_not_bound");
    const result = target.deliveryResultOwner.acceptEffectObservation(Object.freeze({
      kind: "delivery_receipt" as const,
      ...receipt,
    }));
    if (result.outcome !== "delivery_accepted"
      && result.outcome !== "delivery_accepted_reconciling") {
      throw safeError("session_id_acp_receipt_projection_invalid");
    }
  };
}

function createResultRouter(
  runs: ReadonlyMap<string, RunRegistration>,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    acceptEffectObservation(observation: SessionIdAcpEffectObservation): SessionIdAcpEffectObservationResult {
      const intent = repositories.reliability.getProviderEffectIntent(
        observation.providerEffectIntentId,
      );
      if (!intent || intent.sessionExecutionAttemptId !== observation.sessionExecutionAttemptId) {
        throw safeError("session_id_acp_result_route_intent_missing");
      }
      const target = runs.get(runKey(intent.taskId, intent.runId));
      if (!target) throw safeError("session_id_acp_result_owner_not_bound");
      return target.deliveryResultOwner.acceptEffectObservation(observation);
    },
    acceptSettlement(settlement: Parameters<RunRegistration["deliveryResultOwner"]["acceptSettlement"]>[0]) {
      const target = runs.get(runKey(settlement.taskId, settlement.runId));
      if (!target) throw safeError("session_id_acp_result_owner_not_bound");
      return target.deliveryResultOwner.acceptSettlement(settlement);
    },
  });
}

function trackRuntimePump(
  pump: ReturnType<typeof createSessionIdAcpRuntimePump>,
  isClosed: () => boolean,
  inFlight: Set<Promise<unknown>>,
): ReturnType<typeof createSessionIdAcpRuntimePump> {
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (isClosed()) return Promise.reject(safeError("session_id_acp_application_closed"));
    const running = operation();
    inFlight.add(running);
    void running.finally(() => { inFlight.delete(running); }).catch(() => undefined);
    return running;
  };
  return Object.freeze({
    pumpDelivery: (input) => track(() => pump.pumpDelivery(input)),
    reconcileAttempt: (input) => track(() => pump.reconcileAttempt(input)),
    drainStagedEffect: (input) => track(() => pump.drainStagedEffect(input)),
  });
}

function trackTaskStopPump(
  pump: SessionIdAcpRunApplication["taskStopPump"],
  isClosed: () => boolean,
  inFlight: Set<Promise<unknown>>,
): SessionIdAcpRunApplication["taskStopPump"] {
  return Object.freeze({
    pumpTaskStop() {
      if (isClosed()) return Promise.reject(safeError("session_id_acp_application_closed"));
      const running = pump.pumpTaskStop();
      inFlight.add(running);
      void running.finally(() => { inFlight.delete(running); }).catch(() => undefined);
      return running;
    },
    reconcileTaskStop() {
      if (isClosed()) throw safeError("session_id_acp_application_closed");
      return pump.reconcileTaskStop();
    },
  });
}

function trackCloseSession(
  closeSession: SessionIdAcpRunApplication["closeSession"],
  isClosed: () => boolean,
  inFlight: Set<Promise<unknown>>,
): SessionIdAcpRunApplication["closeSession"] {
  return (command) => {
    if (isClosed()) return Promise.reject(safeError("session_id_acp_application_closed"));
    const running = closeSession(command);
    inFlight.add(running);
    void running.finally(() => { inFlight.delete(running); }).catch(() => undefined);
    return running;
  };
}

function createStartupRetiringBindingRecoveryAuthorizer(
  repositories: AcpSessionRuntimeRepositories,
  supervisorAuthority: SessionIdAcpApplicationAssemblyOptions["authorizeRetiringBindingRecovery"],
): SessionIdAcpApplicationProviderFactoryInput["authorizeRetiringBindingRecovery"] {
  const startup = new Map<string, Readonly<{ revision: number; canonical: string }>>();
  for (const value of repositories.reliability.listBindingRetirementIntents()) {
    const intent = cloneAcpV3BindingRetirementIntentRecord(value);
    if (intent.state !== "retiring") continue;
    if (startup.has(intent.bindingRetirementIntentId)) {
      throw safeError("session_id_acp_retiring_recovery_snapshot_ambiguous");
    }
    startup.set(intent.bindingRetirementIntentId, Object.freeze({
      revision: intent.revision,
      canonical: canonicalRetirementIntent(intent),
    }));
  }
  const consumed = new Set<string>();
  return (value) => {
    let intent: AcpV3BindingRetirementIntentRecord;
    try {
      intent = cloneAcpV3BindingRetirementIntentRecord(value);
    } catch {
      return false;
    }
    if (intent.state !== "retiring") return false;
    const snapshot = startup.get(intent.bindingRetirementIntentId);
    const key = `${intent.bindingRetirementIntentId}\0${intent.revision}`;
    if (!snapshot
      || snapshot.revision !== intent.revision
      || snapshot.canonical !== canonicalRetirementIntent(intent)
      || consumed.has(key)) return false;
    const persisted = repositories.reliability.getBindingRetirementIntent(
      intent.bindingRetirementIntentId,
    );
    if (!persisted
      || persisted.revision !== intent.revision
      || canonicalRetirementIntent(persisted) !== snapshot.canonical) return false;
    if (supervisorAuthority(intent) !== true) return false;
    consumed.add(key);
    return true;
  };
}

function canonicalRetirementIntent(intent: AcpV3BindingRetirementIntentRecord): string {
  return canonicalJson(intent as unknown as JsonValue);
}

function createInterruptCorrelationResolver(
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
): SessionIdAcpApplicationProviderFactoryInput["resolveInterruptCorrelation"] {
  return (scope) => {
    const control = canonical.orchestration.getControlAudit(scope.sessionControlAuditId);
    const attempt = repositories.sessionRuntime.getAttempt(scope.sessionExecutionAttemptId);
    const turn = canonical.orchestration.getTurn(scope.orchestrationSessionTurnId);
    if (!control || !attempt || !turn) return undefined;
    if (control.taskId !== scope.taskId
      || control.runId !== scope.runId
      || control.sessionId !== scope.logicalSessionId
      || attempt.taskId !== scope.taskId
      || attempt.runId !== scope.runId
      || attempt.logicalSessionId !== scope.logicalSessionId
      || attempt.orchestrationSessionTurnId !== scope.orchestrationSessionTurnId
      || turn.taskId !== scope.taskId
      || turn.runId !== scope.runId
      || turn.sessionId !== scope.logicalSessionId
      || turn.sessionTurnId !== attempt.orchestrationSessionTurnId) return undefined;
    return Object.freeze({
      sessionControlAuditId: control.sessionControlAuditId,
      sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
      orchestrationSessionTurnId: turn.sessionTurnId,
    });
  };
}

function createTaskStopControlResolver(
  canonical: SessionIdCanonicalStore,
): SessionIdAcpApplicationProviderFactoryInput["resolveTaskStopControl"] {
  return (scope) => {
    const control = canonical.orchestration.getControlAudit(scope.sessionControlAuditId);
    if (!control
      || control.taskId !== scope.taskId
      || control.runId !== scope.runId
      || control.sessionId !== scope.logicalSessionId
      || control.idempotencyKey !== scope.idempotencyKey
      || control.kind !== "task_stop"
      || (control.state !== "requested" && control.state !== "accepted")) return undefined;
    return Object.freeze({ kind: "task_stop", state: control.state });
  };
}

function createCloseControlResolver(
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
  resolveFrozenProfileTuple: AcpV3FrozenProfileTupleResolver,
): SessionIdAcpApplicationProviderFactoryInput["resolveCloseControl"] {
  return (scope) => {
    const control = canonical.orchestration.getControlAudit(scope.sessionControlAuditId);
    if (!control
      || control.taskId !== scope.taskId
      || control.runId !== scope.runId
      || control.sessionId !== scope.logicalSessionId
      || control.idempotencyKey !== scope.idempotencyKey
      || control.kind !== "close"
      || control.state !== "requested") return undefined;

    let run: ReturnType<SessionIdCanonicalStore["taskRun"]["readTaskRunState"]>;
    try {
      run = canonical.taskRun.readTaskRunState(scope.taskId, scope.runId);
    } catch {
      return undefined;
    }
    if (run.taskId !== scope.taskId
      || run.runId !== scope.runId
      || run.runStatus !== "running") return undefined;

    const generation = canonical.taskRun.getGeneration(scope.logicalSessionId);
    if (!generation
      || generation.taskId !== scope.taskId
      || generation.runId !== scope.runId
      || generation.sessionId !== scope.logicalSessionId
      || generation.lifecycle !== "current"
      || generation.closedAt !== undefined
      || generation.executionProfileId !== scope.executionProfileId) return undefined;
    const slot = canonical.taskRun.getSlot(generation.cardSessionSlotId);
    if (!slot
      || slot.cardSessionSlotId !== generation.cardSessionSlotId
      || slot.taskId !== scope.taskId
      || slot.runId !== scope.runId
      || slot.agentCardId !== generation.agentCardId
      || slot.currentSessionId !== scope.logicalSessionId
      || slot.latestGeneration !== generation.generation) return undefined;

    const binding = repositories.binding.getCurrentBinding(scope.logicalSessionId);
    if (!binding
      || binding.taskId !== scope.taskId
      || binding.runId !== scope.runId
      || binding.logicalSessionId !== scope.logicalSessionId
      || binding.agentCardId !== generation.agentCardId
      || binding.bindingId !== scope.bindingId
      || binding.revision !== scope.bindingRevision
      || binding.status !== "active"
      || binding.executionProfileId !== scope.executionProfileId
      || binding.profileRevisionId !== scope.profileRevisionId
      || binding.providerFamily !== scope.providerFamily) return undefined;

    const profile = resolveFrozenProfileTuple({
      taskId: scope.taskId,
      runId: scope.runId,
      logicalSessionId: scope.logicalSessionId,
      executionProfileId: scope.executionProfileId,
    });
    if (!profile
      || profile.schemaVersion !== 3
      || profile.executionProfileId !== scope.executionProfileId
      || profile.profileRevisionId !== scope.profileRevisionId
      || profile.providerFamily !== scope.providerFamily) return undefined;
    return Object.freeze({ kind: "close" as const, state: "requested" as const });
  };
}

function canonicalSettlementTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpCanonicalSettlementCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        message: canonical.message,
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        currentBinding: repositories.binding,
        sessionExecution: repositories.sessionRuntime,
        providerEffects: repositories.reliability,
      }));
    },
  });
}

function terminalNoticeTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpTerminalNoticeCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        message: canonical.message,
        orchestration: canonical.orchestration,
        currentBinding: repositories.binding,
        sessionExecution: repositories.sessionRuntime,
        providerEffects: repositories.reliability,
      }));
    },
  });
}

function deliveryTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpDeliveryResultOwnerCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        message: canonical.message,
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        currentBinding: repositories.binding,
        providerEffects: repositories.reliability,
        sessionExecution: repositories.sessionRuntime,
      }));
    },
  });
}

function commandTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpOrchestrationCommandCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        message: canonical.message,
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        commandReceipts: {
          createCommandReceipt: canonical.reliability.createCommandReceipt,
          findCommandReceipt: canonical.reliability.findCommandReceipt,
          createUiCommandReceipt: canonical.reliability.createUiCommandReceipt,
          getUiCommandReceipt: canonical.reliability.getUiCommandReceipt,
        },
        sessionExecution: {
          getRuntimeForSession: repositories.sessionRuntime.getRuntimeForSession,
          getAttempt: repositories.sessionRuntime.getAttempt,
        },
        providerEffects: {
          listProviderEffectIntents: repositories.reliability.listProviderEffectIntents,
        },
      }));
    },
  });
}

function rendererCommandTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpRendererCommandCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        message: canonical.message,
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        commandReceipts: {
          createUiCommandReceipt: canonical.reliability.createUiCommandReceipt,
          getUiCommandReceipt: canonical.reliability.getUiCommandReceipt,
        },
        sessionExecution: {
          getRuntimeForSession: repositories.sessionRuntime.getRuntimeForSession,
          getAttempt: repositories.sessionRuntime.getAttempt,
        },
        providerEffects: {
          listProviderEffectIntents: repositories.reliability.listProviderEffectIntents,
        },
      }));
    },
  });
}

function interactionResponseTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpInteractionResponseCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        message: canonical.message,
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        commandReceipts: {
          createUiCommandReceipt: canonical.reliability.createUiCommandReceipt,
          getUiCommandReceipt: canonical.reliability.getUiCommandReceipt,
        },
        currentBinding: repositories.binding,
        sessionExecution: {
          getRuntimeForSession: repositories.sessionRuntime.getRuntimeForSession,
          getAttempt: repositories.sessionRuntime.getAttempt,
        },
        providerEffects: {
          getProviderEffectIntent: repositories.reliability.getProviderEffectIntent,
        },
      }));
    },
  });
}

function closeTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpCloseSessionCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: canonical.taskRun,
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        currentBinding: repositories.binding,
        sessionExecution: repositories.sessionRuntime,
        reliability: repositories.reliability,
        commandReceipts: {
          createCommandReceipt: canonical.reliability.createCommandReceipt,
          findCommandReceipt: canonical.reliability.findCommandReceipt,
        },
      }));
    },
  });
}

function taskStopTransaction(
  store: SqliteRuntimeStore,
  canonical: SessionIdCanonicalStore,
  templates: ReturnType<typeof createRuntimeRepositories>["templateTask"],
  repositories: AcpSessionRuntimeRepositories,
) {
  return Object.freeze({
    run<T>(work: (owners: SessionIdAcpTaskStopCapabilities) => T): T {
      return store.transaction(() => work({
        taskRun: {
          readExactStopState(taskId, runId) {
            const state = canonical.taskRun.readTaskRunState(taskId, runId);
            const task = templates.getTask(taskId);
            const architecture = requiredV3Architecture(templates, taskId);
            if (!task) throw new Error("session_id_acp_task_stop_scope_missing");
            return Object.freeze({
              taskId: state.taskId,
              runId: state.runId,
              taskRevision: state.taskRevision,
              taskStatus: task.status,
              runStatus: state.runStatus,
              architectureSnapshotId: architecture.architectureSnapshotId,
              architectureSchemaVersion: architecture.schemaVersion,
              conductorSessionId: canonical.taskRun.getConductorSessionId(taskId, runId),
            });
          },
          acceptTaskStop: canonical.taskRun.acceptTaskStop,
          retireCurrentSessionsForTaskStop: canonical.taskRun.retireCurrentSessionsForTaskStop,
          completeAcpTaskStop: canonical.taskRun.completeAcpTaskStop,
        },
        orchestration: canonical.orchestration,
        humanIntervention: canonical.humanIntervention,
        binding: repositories.binding,
        sessionExecution: repositories.sessionRuntime,
        reliability: repositories.reliability,
        commandReceipts: {
          createUiCommandReceipt: canonical.reliability.createUiCommandReceipt,
          getUiCommandReceipt: canonical.reliability.getUiCommandReceipt,
        },
      }));
    },
  });
}

function sessionExecutionRepository(
  repositories: AcpSessionRuntimeRepositories,
) {
  const records = sessionExecutionRecords(repositories.sessionRuntime);
  return Object.freeze({
    ...records,
    transaction<T>(work: (repository: SessionExecutionRecordRepository) => T): T {
      return repositories.transaction(({ sessionRuntime }) => (
        work(sessionExecutionRecords(sessionRuntime))
      ));
    },
  });
}

function sessionExecutionRecords(
  repository: AcpV3SessionRuntimeRepository,
): SessionExecutionRecordRepository {
  return Object.freeze({
    findRuntimeByLogicalSessionId: repository.getRuntimeForSession,
    getRuntime: repository.getRuntime,
    insertRuntime: repository.createRuntime,
    updateRuntime: repository.updateRuntime,
    getAttempt: repository.getAttempt,
    insertAttempt: repository.createAttempt,
    updateAttempt: repository.updateAttempt,
  });
}

function sessionRuntimeCommandTransaction(repositories: AcpSessionRuntimeRepositories) {
  return Object.freeze({
    run<T>(work: (owners: Readonly<{
      sessionExecution: SessionExecutionRecordRepository;
      providerEffects: Readonly<{
        findByCommandId(commandId: string): SessionRuntimeProviderEffectIntentRecord | undefined;
        findByIdempotencyKey(idempotencyKey: string): SessionRuntimeProviderEffectIntentRecord | undefined;
        insert(intent: SessionRuntimeProviderEffectIntentRecord): void;
      }>;
    }>) => T): T {
      return repositories.transaction(({ sessionRuntime, reliability }) => work({
        sessionExecution: sessionExecutionRecords(sessionRuntime),
        providerEffects: {
          findByCommandId: (commandId) => reliability.listProviderEffectIntents()
            .find((intent) => intent.commandId === commandId),
          findByIdempotencyKey: (idempotencyKey) => reliability.listProviderEffectIntents()
            .find((intent) => intent.idempotencyKey === idempotencyKey),
          insert: (intent) => { reliability.createProviderEffectIntent(intent); },
        },
      }));
    },
  });
}

function providerEffectLookup(repositories: AcpSessionRuntimeRepositories) {
  return Object.freeze({
    findByIdempotencyKey(scope: Readonly<{
      taskId: string;
      runId: string;
      commandType: SessionRuntimeProviderEffectIntentRecord["commandType"];
      idempotencyKey: string;
    }>) {
      return repositories.reliability.listProviderEffectIntents().find((intent) => (
        intent.taskId === scope.taskId
        && intent.runId === scope.runId
        && intent.commandType === scope.commandType
        && intent.idempotencyKey === scope.idempotencyKey
      ));
    },
  });
}

function requiredV3Architecture(
  templates: ReturnType<typeof createRuntimeRepositories>["templateTask"],
  taskId: string,
) {
  const snapshot = templates.getArchitectureSnapshot(taskId);
  if (!snapshot) throw safeError("session_id_acp_run_architecture_not_v3");
  try {
    return validateTaskArchitectureSnapshotV3(snapshot);
  } catch {
    throw safeError("session_id_acp_run_architecture_not_v3");
  }
}

function rendererPublicApplication(
  owner: RendererCommandOwner,
): PublicRendererCommandApplication {
  return Object.freeze({
    submitTaskInput: (...args) => owner.submitTaskInput(...args).result,
    sendHumanMessage: (...args) => owner.sendHumanMessage(...args).result,
    abandonHumanMessage: (...args) => owner.abandonHumanMessage(...args).result,
  });
}

function interactionPublicOwner(
  owner: InteractionResponseOwner,
): PublicInteractionResponseOwner {
  return Object.freeze({
    respondToInteraction: (...args) => owner.respondToInteraction(...args).result,
  });
}

function taskStopPublicApplication(owner: TaskStopOwner): PublicTaskStopApplication {
  return Object.freeze({
    stopTask: (...args) => owner.stopTask(...args).result,
  });
}

function validProviderOwner(
  value: SessionIdAcpApplicationProviderOwner | undefined,
): value is SessionIdAcpApplicationProviderOwner {
  return Boolean(value
    && typeof value === "object"
    && value.provider
    && typeof value.provider.executeProviderEffect === "function"
    && typeof value.provider.retireBinding === "function"
    && typeof value.provider.retireBindingForClose === "function"
    && typeof value.close === "function");
}

async function closeInvalidProviderOwner(value: unknown): Promise<void> {
  if (!value || typeof value !== "object" || !("close" in value)
    || typeof value.close !== "function") return;
  try {
    await value.close();
  } catch {
    throw safeError("session_id_acp_application_cleanup_unconfirmed");
  }
}

function validateOptions(value: SessionIdAcpApplicationAssemblyOptions): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !value.store || typeof value.store.transaction !== "function"
    || typeof value.authenticatedUserId !== "string"
    || !requiredOpaque(value.authenticatedUserId, "user")
    || typeof value.now !== "function"
    || typeof value.createId !== "function"
    || typeof value.authorizeRetiringBindingRecovery !== "function"
    || typeof value.createProvider !== "function") {
    throw safeError("session_id_acp_application_assembly_options_invalid");
  }
}

function validateTaskScope(value: SessionIdAcpOrchestrationCommandTaskScope): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !requiredOpaque(value.taskId, "task")
    || !requiredOpaque(value.runId, "run")
    || !requiredOpaque(value.conductorSessionId, "logical_session")
    || !requiredOpaque(value.initialConductorSessionTurnId, "session_turn")
    || !Array.isArray(value.agentCards)) {
    throw safeError("session_id_acp_run_application_scope_invalid");
  }
}

function requiredGeneratedId(value: string, prefix: string): string {
  if (!requiredOpaque(value, prefix)) {
    throw safeError(`session_id_acp_generated_${prefix}_invalid`);
  }
  return value;
}

function requiredOpaque(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && value.length <= 256
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value);
}

function runKey(taskId: string, runId: string): string {
  return `${taskId}\u0000${runId}`;
}

function freezeTaskScope(
  value: SessionIdAcpOrchestrationCommandTaskScope,
): SessionIdAcpOrchestrationCommandTaskScope {
  return Object.freeze({
    ...value,
    agentCards: Object.freeze(value.agentCards.map((card) => Object.freeze({ ...card }))),
  });
}

function sameTaskScope(
  left: SessionIdAcpOrchestrationCommandTaskScope,
  right: SessionIdAcpOrchestrationCommandTaskScope,
): boolean {
  if (left.taskId !== right.taskId
    || left.runId !== right.runId
    || left.conductorSessionId !== right.conductorSessionId
    || left.initialConductorSessionTurnId !== right.initialConductorSessionTurnId
    || left.agentCards.length !== right.agentCards.length) return false;
  return left.agentCards.every((card, index) => {
    const candidate = right.agentCards[index];
    return Boolean(candidate
      && card.agentCardId === candidate.agentCardId
      && card.executionProfileId === candidate.executionProfileId
      && card.profileRevisionId === candidate.profileRevisionId
      && card.providerFamily === candidate.providerFamily);
  });
}

function safeError(code: string): SessionIdAcpApplicationAssemblyError {
  return new SessionIdAcpApplicationAssemblyError(code);
}
