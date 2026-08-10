import {
  createId,
  hashDefinition,
  type ArtifactReference,
  type ArtifactPreviewReadModel,
  type AttentionRecord,
  type ExecutionProfileDefinition,
  type InputSubmissionRecord,
  type HumanInterventionRecord,
  type InvocationRecord,
  type MetaMessageRecord,
  type MetaPatchOperation,
  type MetaPatchProposalRecord,
  type MetaPatchValidationIssue,
  type MetaSessionRecord,
  type MessageForwardRecord,
  type MessageSelection,
  type ProviderEffect,
  type ProviderFact,
  type ProviderSessionBootstrap,
  type ProviderSessionBindingRecord,
  type RuntimeCommand,
  type RuntimeCommandResult,
  type RuntimeEvent,
  type RuntimeInvalidation,
  type RuntimeInvalidationReason,
  type RuntimeReadModel,
  type RuntimeReadRequest,
  type SessionInboxItemRecord,
  type SessionMessageRecord,
  type SessionPresentation,
  type SessionTurnRecord,
  type JsonValue,
  type TaskRecord,
  type TaskArchitectureSnapshot,
  type TaskSetupDraftRecord,
  type TaskPermanentDeletePreview,
  type TaskPermanentDeleteResult,
  type TaskRunRecord,
  type TemplateAssetRecord,
  type TemplateAssetTransport,
  type TemplatePackage,
  type TemplateRecord,
  type TemplateVersionRecord,
  decodeTemplateAssetTransports,
  encodeTemplateAssetTransports,
  validateTemplateArchivePayload,
  validateTemplatePackage,
} from "@agent-workspace/runtime-contracts";
import {
  applyProviderFactToAttention,
  applyProviderFactToBinding,
  applyProviderFactToInput,
  applyProviderFactToInvocation,
  applyProviderFactToSessionTurn,
  abandonMetaSession,
  abandonTaskSetupDraft,
  appendMetaMessage,
  applyMetaPatchProposalToTaskSetup,
  applyMetaPatchProposalToTemplateDraft,
  authorizeRequestedArtifactClaim,
  archiveTemplate,
  archiveTask,
  assertTaskNotTrashed,
  compileProviderSessionBootstrap,
  completeBindingRelease,
  createAttentionFromProviderFact,
  createCardLogicalSession,
  createHumanIntervention,
  createMetaPatchProposal,
  createMetaSession,
  createInvocation,
  createMessageForward,
  createSessionInboxItem,
  createSessionMessage,
  createSessionTurn,
  createProviderSessionBinding,
  createTask,
  createTaskArchitectureSnapshot,
  createTaskSetupDraft,
  createWorkspaceAuthorization,
  createTemplateDraft,
  createTemplateIdentity,
  hasProviderFactTurnCorrelation,
  indexSessionTurns,
  isProviderFactCurrent,
  markTaskRunRunning,
  markHumanInterventionReady,
  markHumanInterventionSent,
  extractRelayBlocks,
  assertRelaySelectionsAllowed,
  claimSessionInboxItem,
  hasInvocationTerminalFailure,
  hasSessionTurnTerminalFailure,
  publishTemplateDraft,
  rejectMetaPatchProposal,
  recordAttentionResponseEffect,
  recordDeliveryEffect,
  recordEnsureBindingEffect,
  recordInvocationFinalMessage,
  recordSessionTurnFinalMessage,
  recordInvocationDeliveryEffect,
  recordTaskRunTerminal,
  requestBindingRelease,
  requestInvocationCancellation,
  requestSessionTurnInterrupt,
  requestTaskStop,
  restartTaskRun,
  saveTemplateDraft,
  saveTaskSetupDraft,
  stageAttentionResponse,
  stageInputSubmission,
  stageSessionInboxDelivery,
  settleSessionInboxFromInput,
  recoverExpiredInboxLease,
  renderAgentAssignment,
  normalizeRequestedArtifactPaths,
  renderInboxDelivery,
  renderRelayForward,
  resolveProviderFactSessionTurn,
  resolveInvocationFinalContent,
  resolveSessionTurnFinalContent,
  isSessionTurnActive,
  type ResolvedMessageSelection,
  type SessionTurnCorrelationIndex,
  startTaskRun,
  templateVersionToPackage,
  achieveTask,
  restoreTask,
  assertTaskSetupReadyForCreate,
  compileTaskGoal,
  consumeMetaSession,
  consumeTaskSetupDraft,
  META_AGENT_OUTPUT_SCHEMA,
  parseMetaAgentOutput,
  TASK_GOAL_COMPILER_VERSION,
} from "@agent-workspace/runtime-domain";
import type { MetaTurnRecord, OutboxRecord, RuntimeRepositories } from "@agent-workspace/runtime-store";
import type { MetaAgentTurnRequest } from "@agent-workspace/provider-port";
import type { ManagedArtifactPort } from "./managed-artifact-port.js";
import {
  assertProviderProfileAvailable,
  executionProfileFingerprint,
  type ProviderPort,
  type ProviderRegistry,
} from "./provider.js";
import { createMetaProfileRegistry, type MetaProfileRegistry } from "./meta-profile.js";
import { assertMetaAgentProfileAvailable, createMetaAgentRegistry, type MetaAgentRegistry } from "./meta-agent.js";
import { resolveAuthorizedWorkspace, type WorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";

export type RuntimeApplicationOptions = {
  readonly repositories: RuntimeRepositories;
  readonly providers: ProviderRegistry;
  /** Host-owned typed readiness registry; Renderer selects an opaque option ID only. */
  readonly metaProfiles?: MetaProfileRegistry;
  /** Host-owned configuration-only Provider boundary. Never Task-shaped. */
  readonly metaAgents?: MetaAgentRegistry;
  /** Host-owned canonical directory boundary; never supplied by a Renderer. */
  readonly workspaceDirectoryResolver: WorkspaceDirectoryResolver;
  /** Host-owned, ID-only Artifact file boundary; never exposed through a client. */
  readonly managedArtifactPort?: ManagedArtifactPort;
  readonly now?: () => string;
  readonly outboxLeaseMs?: number;
};

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * The Runtime application layer owns user commands, durable intent and fact
 * reconciliation. Provider adapters are deliberately unable to call command
 * handlers or mutate Task / Run state directly.
 */
export class RuntimeApplication {
  readonly #repositories: RuntimeRepositories;
  readonly #providers: ProviderRegistry;
  readonly #metaProfiles: MetaProfileRegistry;
  readonly #metaAgents: MetaAgentRegistry;
  readonly #workspaceDirectoryResolver: WorkspaceDirectoryResolver;
  readonly #managedArtifactPort: ManagedArtifactPort;
  readonly #now: () => string;
  readonly #outboxLeaseMs: number;
  readonly #listeners = new Set<RuntimeEventListener>();
  readonly #providerReadinessRefreshes = new Map<string, Promise<void>>();
  #invalidationSequence = 0;
  readonly #pendingCommands = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RuntimeCommandResult> }>();

  constructor({ repositories, providers, metaProfiles = createMetaProfileRegistry([]), metaAgents = createMetaAgentRegistry([]), workspaceDirectoryResolver, managedArtifactPort = unavailableManagedArtifactPort(), now = () => new Date().toISOString(), outboxLeaseMs = 30_000 }: RuntimeApplicationOptions) {
    this.#repositories = repositories;
    this.#providers = providers;
    this.#metaProfiles = metaProfiles;
    this.#metaAgents = metaAgents;
    this.#workspaceDirectoryResolver = workspaceDirectoryResolver;
    this.#managedArtifactPort = managedArtifactPort;
    this.#now = now;
    this.#outboxLeaseMs = outboxLeaseMs;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  read(request: RuntimeReadRequest = {}): RuntimeReadModel {
    const readModel = this.#repositories.read.readModel(this.#now(), request);
    const conductorExecutionProfileReadiness = readModel.task
      ? this.#taskConductorExecutionProfileReadiness(readModel.task.task)
      : undefined;
    return {
      ...readModel,
      ...(readModel.task ? {
        task: {
          ...readModel.task,
          ...(conductorExecutionProfileReadiness ? { conductorExecutionProfileReadiness } : {}),
        },
      } : {}),
      configuration: {
        ...readModel.configuration,
        metaProfileOptions: this.#metaProfileReadinessOptions(),
        executionProfileReadiness: this.#executionProfileReadinessOptions(this.#visibleExecutionProfileContexts(readModel)),
      },
    };
  }

  /**
   * Refreshes Host-owned Meta capability evidence without exposing native
   * reports. Until this completes, every nominally available option remains
   * fail-closed in the Renderer-safe read model.
   */
  async refreshMetaAgentReadiness(): Promise<boolean> {
    const before = JSON.stringify(this.#metaProfileReadinessOptions());
    await Promise.all(this.#metaProfiles.listDefinitions()
      .filter((option) => option.availability === "available")
      .map((option) => this.#metaAgents.probe(option.profile)));
    const changed = before !== JSON.stringify(this.#metaProfileReadinessOptions());
    if (changed) this.#invalidate(["configuration_changed"]);
    return changed;
  }

  /** Probes frozen Task execution profiles without creating native Sessions. */
  async refreshProviderReadiness(): Promise<boolean> {
    const contexts = this.#allExecutionProfileContexts();
    const profiles = [...new Map(contexts.map(({ profile }) => [executionProfileFingerprint(profile), profile] as const)).entries()];
    let changed = false;
    const started: Promise<void>[] = [];
    for (const [key, profile] of profiles) {
      if (this.#providerReadinessRefreshes.has(key)) continue;
      const before = JSON.stringify(this.#providers.readiness(profile));
      let pending!: Promise<void>;
      pending = this.#providers.probe(profile)
        .then(() => {
          if (before !== JSON.stringify(this.#providers.readiness(profile))) {
            changed = true;
            this.#invalidate(["configuration_changed"]);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.#providerReadinessRefreshes.get(key) === pending) this.#providerReadinessRefreshes.delete(key);
        });
      this.#providerReadinessRefreshes.set(key, pending);
      started.push(pending);
    }
    await settleWithin(started, 250);
    return changed;
  }

  #metaProfileReadinessOptions() {
    return this.#metaProfiles.listReadinessOptions().map((option) => {
      if (option.availability !== "available") return option;
      const profile = this.#metaProfiles.resolveAvailable(option.metaProfileOptionId).profile;
      const readiness = this.#metaAgents.readiness(profile);
      if (readiness.state === "available") return option;
      return {
        ...option,
        availability: "unavailable" as const,
        unavailableReason: readiness.state === "pending"
          ? "meta_agent_profile_probe_pending"
          : readiness.reason,
      };
    });
  }

  #executionProfileReadinessOptions(contexts: readonly Readonly<{
    templateVersionId: string;
    profile: ExecutionProfileDefinition;
  }>[]) {
    return contexts.map(({ profile, templateVersionId }) => {
      const readiness = this.#providers.readiness(profile);
      return {
        templateVersionId,
        executionProfileId: profile.executionProfileId,
        status: readiness.state,
        unavailableReasons: [...readiness.unavailableReasons],
        missingCapabilities: [...readiness.missingCapabilities],
      };
    });
  }

  #taskConductorExecutionProfileReadiness(task: TaskRecord) {
    const architecture = this.#repositories.templateTask.getArchitectureSnapshot(task.taskId);
    if (!architecture
      || architecture.taskId !== task.taskId
      || architecture.architectureSnapshotId !== task.architectureSnapshotId) {
      return undefined;
    }
    const profile = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === architecture.definition.conductor.executionProfileId,
    );
    if (!profile) return undefined;
    return this.#executionProfileReadinessOptions([{
      templateVersionId: architecture.templateVersionId,
      profile,
    }])[0];
  }

  #allExecutionProfileContexts(): readonly Readonly<{
    templateVersionId: string;
    profile: ExecutionProfileDefinition;
  }>[] {
    return this.#repositories.templateTask.listTemplateLibrary().flatMap(({ template }) =>
      this.#repositories.templateTask.listTemplateVersions(template.templateId).flatMap((version) =>
        version.definition.executionProfiles.map((profile) => ({
          templateVersionId: version.templateVersionId,
          profile,
        })),
      ),
    );
  }

  #visibleExecutionProfileContexts(readModel: RuntimeReadModel): readonly Readonly<{
    templateVersionId: string;
    profile: ExecutionProfileDefinition;
  }>[] {
    const versions = [
      ...readModel.templateLibrary.templates.flatMap(({ activeVersion }) => activeVersion ? [activeVersion] : []),
      ...(readModel.template?.versions ?? []),
    ];
    const contexts = versions.flatMap((version) => version.definition.executionProfiles.map((profile) => ({
      templateVersionId: version.templateVersionId,
      profile,
    })));
    const unique = new Map(contexts.map((context) => [
      `${context.templateVersionId}:${context.profile.executionProfileId}`,
      context,
    ] as const));
    return [...unique.values()];
  }

  async execute(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    const fingerprint = hashDefinition(command as unknown as JsonValue);
    const persisted = this.#repositories.command.get(command.commandId);
    if (persisted) {
      if (persisted.commandType !== command.type || persisted.payloadFingerprint !== fingerprint) {
        throw new Error("runtime_command_id_reused_with_different_payload");
      }
      return persisted.result;
    }
    const pending = this.#pendingCommands.get(command.commandId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error("runtime_command_id_reused_with_different_payload");
      return pending.promise;
    }
    const promise = this.#executeAndRecord(command, fingerprint);
    this.#pendingCommands.set(command.commandId, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      this.#pendingCommands.delete(command.commandId);
    }
  }

  async #executeAndRecord(command: RuntimeCommand, fingerprint: string): Promise<RuntimeCommandResult> {
    const result = await this.#executeCommand(command);
    const acceptedAt = this.#now();
    const taskId = commandTaskId(command);
    const response: RuntimeCommandResult = {
      receipt: { commandId: command.commandId, acceptedAt, ...(result.task ? { taskRevision: result.task.revision } : {}) },
      ...(result.templatePackage ? { templatePackage: result.templatePackage } : {}),
      ...(result.templateAssets ? { templateAssets: result.templateAssets } : {}),
      ...(result.task ? { task: result.task } : {}),
      ...(result.run ? { run: result.run } : {}),
      ...(result.taskSetupDraft ? { taskSetupDraft: result.taskSetupDraft } : {}),
      ...(result.metaSession ? { metaSession: result.metaSession } : {}),
      ...(result.metaMessage ? { metaMessage: result.metaMessage } : {}),
      ...(result.metaPatchProposal ? { metaPatchProposal: result.metaPatchProposal } : {}),
      ...(result.presentation ? { presentation: result.presentation } : {}),
      ...(result.artifactId ? { artifactId: result.artifactId } : {}),
      ...(result.artifactPreview ? { artifactPreview: result.artifactPreview } : {}),
      ...(result.permanentDeletePreview ? { permanentDeletePreview: result.permanentDeletePreview } : {}),
      ...(result.permanentDelete ? { permanentDelete: result.permanentDelete } : {}),
      readModel: this.read(taskId ? { taskId } : {}),
    };
    this.#repositories.command.record({
      commandId: command.commandId,
      commandType: command.type,
      payloadFingerprint: fingerprint,
      result: response,
      acceptedAt,
    });
    return response;
  }

  async reconcileProviderFact(incomingFact: ProviderFact): Promise<boolean> {
    // Providers may survive a Host restart with a stable native input identity
    // but no in-memory invocation correlation. The Runtime already owns the
    // durable input→invocation relation, so restore only that exact, one-to-one
    // association before persisting/reducing the observed Provider fact. This
    // is never an Agent conclusion and never derives Task completion.
    const fact = this.#restoreInvocationCorrelation(incomingFact);
    const now = this.#now();
    if (!this.#repositories.providerFact.recordFact(fact, now)) return false;
    const binding = this.#repositories.binding.getBinding(fact.bindingId);
    if (!binding) return true; // Evidence is retained, but an unknown Binding never creates one by inference.
    if (!isProviderFactCurrent(binding, fact)) return true;
    const run = this.#repositories.templateTask.getRun(binding.runId);
    const task = this.#repositories.templateTask.getTask(binding.taskId);
    if (!run || !task) return true;
    const turnsForRun = this.#repositories.turn.listTurns(run.runId);
    const turnIndex = indexSessionTurns(turnsForRun);
    if (hasProviderFactTurnCorrelation(fact)) {
      const correlatedTurn = resolveProviderFactSessionTurn(fact, turnIndex);
      if (!correlatedTurn || correlatedTurn.targetLogicalSessionId !== binding.logicalSessionId) return true;
    }

    const reasons = new Set<RuntimeInvalidationReason>(["provider_fact_reconciled"]);
    const nextBinding = applyProviderFactToBinding(binding, fact, now);
    if (!sameJson(nextBinding, binding)) {
      this.#repositories.binding.updateBinding(nextBinding);
      reasons.add("run_changed");
    }
    if (fact.kind === "binding_observed") {
      const logicalSession = this.#repositories.binding.getLogicalSession(binding.logicalSessionId);
      if (logicalSession && logicalSession.status === "unmaterialized") {
        this.#repositories.binding.updateLogicalSession({ ...logicalSession, status: "active", updatedAt: now });
        reasons.add("run_changed");
      }
      if (run.status === "starting" && binding.logicalSessionId === run.conductorLogicalSessionId) {
        this.#repositories.templateTask.updateRun(markTaskRunRunning(run));
        reasons.add("run_changed");
      }
    }

    for (const input of this.#repositories.invocation.listInputs(run.runId)) {
      const nextInput = applyProviderFactToInput(input, fact, now);
      if (!sameJson(nextInput, input)) {
        this.#repositories.invocation.updateInput(nextInput);
        reasons.add("input_changed");
        const inbox = this.#repositories.inbox.getInboxItem(input.sourceInboxItemId);
        if (inbox) {
          const nextInbox = settleSessionInboxFromInput(inbox, nextInput, now);
          if (!sameJson(nextInbox, inbox)) {
            this.#repositories.inbox.updateInboxItem(nextInbox, inbox.revision);
            reasons.add("inbox_changed");
          }
        }
      }
    }

    const factsForBinding = this.#repositories.providerFact.listFacts([binding.bindingId]).filter((candidate) => {
      if (!isProviderFactCurrent(binding, candidate)) return false;
      if (!hasProviderFactTurnCorrelation(candidate)) return true;
      const correlatedTurn = resolveProviderFactSessionTurn(candidate, turnIndex);
      return correlatedTurn?.targetLogicalSessionId === binding.logicalSessionId;
    });
    for (const invocation of this.#repositories.invocation.listInvocations(run.runId)) {
      const nextInvocation = applyProviderFactToInvocation(invocation, fact, now);
      if (!sameJson(nextInvocation, invocation)) {
        this.#repositories.invocation.updateInvocation(nextInvocation);
        reasons.add("invocation_changed");
      }
    }
    for (const turn of turnsForRun) {
      const nextTurn = applyProviderFactToSessionTurn(turn, fact, now, turnIndex);
      if (!sameJson(nextTurn, turn)) {
        this.#repositories.turn.updateTurn(nextTurn);
        reasons.add("run_changed");
      }
      const currentTurn = sameJson(nextTurn, turn) ? turn : nextTurn;
      if (this.#materializeSessionTurnReturn(currentTurn, factsForBinding, run, now, turnIndex)) {
        reasons.add("message_changed");
        reasons.add("inbox_changed");
        reasons.add("invocation_changed");
      } else if (hasSessionTurnTerminalFailure(currentTurn, factsForBinding, turnIndex) && this.#materializeSessionTurnFailureNotice(currentTurn, run, now)) {
        reasons.add("message_changed");
        reasons.add("inbox_changed");
      }
    }

    for (const intervention of this.#repositories.humanIntervention.listInterventions(run.runId)) {
      if (!intervention.affectedSessionTurnId || !["interrupting", "awaiting_turn_close"].includes(intervention.state)) continue;
      const affected = this.#repositories.turn.getTurn(intervention.affectedSessionTurnId);
      if (!affected || !["returned", "interrupted", "completed", "failed", "cancelled"].includes(affected.status)) continue;
      const ready = markHumanInterventionReady(intervention, now);
      this.#repositories.humanIntervention.updateIntervention(ready);
      if (this.#materializeHumanInterventionMessages(ready, run, now)) {
        reasons.add("message_changed");
        reasons.add("inbox_changed");
      }
    }

    if (fact.kind === "attention_requested") {
      const existing = fact.correlation.attentionId ? this.#repositories.invocation.getAttention(fact.correlation.attentionId) : undefined;
      if (!existing) {
        const attention = createAttentionFromProviderFact({
          attentionId: fact.correlation.attentionId ?? createId("attention"), taskId: task.taskId, runId: run.runId, fact, now,
        });
        this.#repositories.invocation.createAttention(attention);
        reasons.add("attention_changed");
      }
    }
    for (const attention of this.#repositories.invocation.listAttentions(run.runId)) {
      const nextAttention = applyProviderFactToAttention(attention, fact, now);
      if (!sameJson(nextAttention, attention)) {
        this.#repositories.invocation.updateAttention(nextAttention);
        reasons.add("attention_changed");
      }
    }

    // `native_terminal` is a Provider fact, not a user achievement or a
    // successful-delivery inference. It does, however, make it safe to release
    // the Host-owned transport resources for this Binding. Persist that cleanup
    // intent so a Host crash between fact storage and child shutdown can retry.
    if (fact.kind === "native_terminal") {
      this.#repositories.invocation.enqueue(newOutbox({
        commandId: `release:${fact.providerFactId}`,
        provider: binding.provider,
        kind: "release_binding",
        bindingId: binding.bindingId,
        payload: { idempotencyKey: `release:${fact.providerFactId}` },
        now,
      }));
      if (task.status === "stopping") {
        const logicalSession = this.#repositories.binding.getLogicalSession(binding.logicalSessionId);
        if (logicalSession && logicalSession.status !== "stopped") {
          this.#repositories.binding.updateLogicalSession({ ...logicalSession, status: "stopped", updatedAt: now });
        }
      }
    }

    // A Task Stop targets every live Binding in its Run. One native terminal
    // fact releases its own Binding, but must not prematurely terminalize the
    // whole Task while another selected Binding can still execute.
    if (fact.kind === "native_terminal" && task.status === "stopping" && this.#allRunBindingsTerminal(run.runId)) {
      const terminal = recordTaskRunTerminal({ task, run, outcome: "stopped", now });
      this.#repositories.templateTask.updateTask(terminal.task, task.revision);
      this.#repositories.templateTask.updateRun(terminal.run);
      reasons.add("task_changed");
      reasons.add("run_changed");
    }
    if (fact.kind === "transport_unknown" && task.status === "stopping") {
      const terminal = recordTaskRunTerminal({ task, run, outcome: "cancellation_unknown", now });
      this.#repositories.templateTask.updateTask(terminal.task, task.revision);
      this.#repositories.templateTask.updateRun(terminal.run);
      reasons.add("task_changed");
      reasons.add("run_changed");
    }
    if (await this.#stageInboxDeliveries()) {
      reasons.add("inbox_changed");
      reasons.add("input_changed");
    }
    this.#invalidate([...reasons], task.taskId, run.runId);
    return true;
  }

  #restoreInvocationCorrelation(fact: ProviderFact): ProviderFact {
    if (!fact.correlation.inputSubmissionId) return fact;
    const binding = this.#repositories.binding.getBinding(fact.bindingId);
    if (!binding) return fact;
    const input = this.#repositories.invocation.getInput(fact.correlation.inputSubmissionId);
    if (!input || input.bindingId !== fact.bindingId) return fact;
    const turn = this.#repositories.turn.findTurnByInput(input.inputSubmissionId);
    if (!turn) return fact;
    const invocation = turn.invocationId ? this.#repositories.invocation.getInvocation(turn.invocationId) : undefined;
    return {
      ...fact,
      correlation: {
        ...fact.correlation,
        sessionTurnId: fact.correlation.sessionTurnId ?? turn.sessionTurnId,
        ...(fact.correlation.invocationId ? {} : invocation ? { invocationId: invocation.invocationId } : {}),
      },
    };
  }

  /** Drains durable intent. An accepted effect is still not a receipt. */
  async drainOutbox(maxItems = 100): Promise<number> {
    // Inbox coordination is the single gateway into Provider delivery. It can
    // only stage a Message after the target Binding is demonstrably idle; the
    // ordinary durable Outbox below then performs the ProviderPort effect.
    this.#recoverIdleStoppingBindings();
    await this.#stageInboxDeliveries(maxItems);
    let handled = 0;
    if (handled < maxItems) {
      const now = this.#now();
      const leaseUntil = new Date(Date.parse(now) + this.#outboxLeaseMs).toISOString();
      const metaTurn = this.#repositories.configuration.claimMetaTurn(now, leaseUntil);
      if (metaTurn) {
        await this.#dispatchMetaTurn(metaTurn);
        handled += 1;
      }
    }
    for (; handled < maxItems; handled += 1) {
      const now = this.#now();
      const leaseUntil = new Date(Date.parse(now) + this.#outboxLeaseMs).toISOString();
      const outbox = this.#repositories.invocation.claimOutbox(now, leaseUntil);
      if (!outbox) break;
      await this.#dispatchOutbox(outbox);
    }
    return handled;
  }

  async #dispatchMetaTurn(turn: MetaTurnRecord): Promise<void> {
    if (turn.status !== "leased" || !turn.leasedFromStatus) throw new Error("meta_turn_not_leased");
    const firstNativeSubmit = turn.leasedFromStatus === "pending" && turn.attempts === 1;
    let session: MetaSessionRecord;
    let request: MetaAgentTurnRequest;
    let provider: Awaited<ReturnType<typeof assertMetaAgentProfileAvailable>>;
    try {
      session = required(this.#repositories.configuration.getMetaSession(turn.metaSessionId), "meta_session_not_found");
      if (session.state !== "active") throw new Error("meta_session_not_active");
      if (session.mode !== turn.mode) throw new Error("meta_session_mode_mismatch");
      if (hashDefinition(session.metaProfile as unknown as JsonValue) !== hashDefinition(turn.profile as unknown as JsonValue)) {
        throw new Error("meta_session_profile_snapshot_mismatch");
      }
      const option = this.#metaProfiles.resolveAvailable(session.metaProfileOptionId);
      if (hashDefinition(option.profile as unknown as JsonValue) !== hashDefinition(turn.profile as unknown as JsonValue)) {
        throw new Error("meta_session_profile_snapshot_mismatch");
      }
      const context = this.#metaTargetContext(session, turn.targetRevision);
      if (hashDefinition(context) !== turn.contextDigest) throw new Error("meta_turn_context_mismatch");
      if (hashDefinition(turn.systemInstructions) !== turn.systemInstructionsDigest) throw new Error("meta_turn_system_instructions_mismatch");
      if (hashDefinition(turn.outputSchema) !== turn.outputSchemaDigest) throw new Error("meta_turn_output_schema_mismatch");
      const userMessage = required(this.#repositories.configuration.getMetaMessage(turn.userMetaMessageId), "meta_turn_user_message_missing");
      if (userMessage.metaSessionId !== turn.metaSessionId || userMessage.role !== "user") throw new Error("meta_turn_user_message_mismatch");
      request = {
        metaTurnId: turn.metaTurnId,
        userMetaMessageId: turn.userMetaMessageId,
        idempotencyKey: turn.idempotencyKey,
        mode: turn.mode,
        profile: turn.profile,
        targetRevision: turn.targetRevision,
        systemInstructions: turn.systemInstructions,
        outputSchema: turn.outputSchema,
        context: turn.context,
        transcript: this.#repositories.configuration.listMetaMessages(turn.metaSessionId)
          .filter((message) => message.metaMessageId !== turn.userMetaMessageId)
          .map((message) => ({ metaMessageId: message.metaMessageId, role: message.role, content: message.content })),
        content: userMessage.content,
      };
    } catch (error) {
      // A failed frozen-context/profile/session preflight is locally proven and
      // cannot become completable by another native observation. Terminally
      // fence it so one obsolete Turn cannot monopolize the global Meta queue.
      this.#settleMetaTurn(turn, "failed", safeMetaFailureCode(error, "meta_turn_preflight_failed"));
      return;
    }

    // Readiness gates only the first native submit. Once acceptance may have
    // happened, an absent composed port is transient Host state: release the
    // lease without changing the durable accepted/ambiguous dispatch state.
    if (firstNativeSubmit) {
      try {
        provider = await assertMetaAgentProfileAvailable(this.#metaAgents, turn.profile);
      } catch (error) {
        this.#settleMetaTurn(turn, "failed", safeMetaFailureCode(error, "meta_agent_profile_unavailable"));
        return;
      }
    } else {
      const recoveredProvider = this.#metaAgents.get(turn.profile.provider);
      if (!recoveredProvider) {
        this.#releaseMetaTurn(turn);
        return;
      }
      provider = recoveredProvider;
    }

    // The first lease is the only state that proves no external submit could
    // have happened. A recovered `pending` lease has attempts > 1 and must
    // reconcile before any retry, because Host may have crashed after native
    // acceptance but before persisting `provider_accepted`.
    if (!firstNativeSubmit) {
      let reconciliation: Awaited<ReturnType<typeof provider.reconcileMetaTurn>>;
      try {
        reconciliation = await provider.reconcileMetaTurn(request);
      } catch {
        this.#releaseMetaTurn(turn);
        return;
      }
      switch (reconciliation.state) {
        case "returned":
          this.#completeMetaTurn(turn, reconciliation.finalText);
          return;
        case "failed":
          this.#settleMetaTurn(turn, "failed", safeMetaFailureCode(reconciliation.failureCode, "meta_provider_failed"));
          return;
        case "running":
          this.#settleMetaTurn(turn, "provider_accepted");
          return;
        case "unknown":
          this.#settleMetaTurn(turn, "ambiguous", "meta_provider_reconciliation_unknown");
          return;
        case "absent":
          if (turn.leasedFromStatus !== "pending") {
            this.#releaseMetaTurn(turn);
            return;
          }
          break;
      }
    }

    try {
      const acceptance = await provider.startMetaTurn(request);
      if (acceptance === "accepted") this.#settleMetaTurn(turn, "provider_accepted");
      else if (acceptance === "rejected") this.#settleMetaTurn(turn, "rejected", "meta_provider_rejected");
      else this.#settleMetaTurn(turn, "ambiguous", "meta_provider_acceptance_unknown");
    } catch {
      this.#settleMetaTurn(turn, "ambiguous", "meta_provider_submit_ambiguous");
    }
  }

  #releaseMetaTurn(turn: MetaTurnRecord): void {
    this.#repositories.configuration.releaseMetaTurn(turn.metaTurnId, turn.attempts, this.#now());
    this.#invalidate(["configuration_changed"]);
  }

  #settleMetaTurn(
    turn: MetaTurnRecord,
    status: "provider_accepted" | "rejected" | "ambiguous" | "failed",
    failureCode?: string,
  ): void {
    this.#repositories.configuration.settleMetaTurn({
      metaTurnId: turn.metaTurnId,
      expectedAttempts: turn.attempts,
      status,
      ...(failureCode === undefined ? {} : { failureCode }),
      now: this.#now(),
    });
    this.#invalidate(["configuration_changed"]);
  }

  #completeMetaTurn(turn: MetaTurnRecord, finalText: string): void {
    let parsed: ReturnType<typeof parseMetaAgentOutput>;
    try {
      parsed = parseMetaAgentOutput(finalText, turn.mode);
    } catch (error) {
      this.#settleMetaTurn(turn, "failed", safeMetaFailureCode(error, "meta_provider_final_invalid"));
      return;
    }
    try {
      const session = required(this.#repositories.configuration.getMetaSession(turn.metaSessionId), "meta_session_not_found");
      if (session.state !== "active") throw new Error("meta_session_not_active");
      const context = this.#metaTargetContext(session, turn.targetRevision);
      if (hashDefinition(context) !== turn.contextDigest) throw new Error("meta_turn_context_mismatch");
      const completedAt = this.#now();
      const appended = appendMetaMessage({
        session,
        metaMessageId: turn.assistantMetaMessageId,
        expectedSessionRevision: session.revision,
        role: "assistant",
        content: parsed.assistantMessage,
        now: completedAt,
      });
      const proposal = parsed.proposal
        ? this.#validatedMetaProposal(turn, session, parsed.proposal, completedAt)
        : undefined;
      this.#repositories.configuration.completeMetaTurn({
        metaTurnId: turn.metaTurnId,
        expectedAttempts: turn.attempts,
        session: appended.session,
        expectedSessionRevision: session.revision,
        assistantMessage: appended.message,
        ...(proposal === undefined ? {} : { proposal }),
        completedAt,
      });
      this.#invalidate(["configuration_changed"]);
    } catch (error) {
      const current = this.#repositories.configuration.getMetaTurn(turn.metaTurnId);
      if (current?.status === "returned") return;
      this.#settleMetaTurn(turn, "failed", safeMetaFailureCode(error, "meta_turn_completion_failed"));
    }
  }

  #validatedMetaProposal(
    turn: MetaTurnRecord,
    session: MetaSessionRecord,
    parsed: NonNullable<ReturnType<typeof parseMetaAgentOutput>["proposal"]>,
    now: string,
  ): MetaPatchProposalRecord {
    const create = (validationIssues: readonly MetaPatchValidationIssue[]) => createMetaPatchProposal({
      metaPatchProposalId: turn.metaPatchProposalId,
      session,
      targetRevision: turn.targetRevision,
      operations: parsed.operations,
      summary: parsed.summary,
      rationale: parsed.rationale,
      validationIssues,
      now,
    });
    let proposal = create(parsed.validationIssues);
    if (proposal.validationIssues.length > 0) return proposal;
    try {
      if (session.mode === "template_design") {
        if (session.target.kind !== "template_draft") throw new Error("meta_session_mode_mismatch");
        const draft = required(this.#repositories.templateTask.getDraft(session.target.templateDraftId), "template_draft_not_found");
        applyMetaPatchProposalToTemplateDraft({ draft, session, proposal, expectedTargetRevision: turn.targetRevision, now });
      } else {
        if (session.target.kind !== "task_setup_draft") throw new Error("meta_session_mode_mismatch");
        const draft = required(this.#repositories.configuration.getTaskSetupDraft(session.target.taskSetupDraftId), "task_setup_draft_not_found");
        const version = required(this.#repositories.templateTask.getTemplateVersion(draft.templateVersionId), "template_version_not_found");
        applyMetaPatchProposalToTaskSetup({
          draft,
          schema: version.definition.taskInputSchema,
          session,
          proposal,
          expectedTargetRevision: turn.targetRevision,
          now,
        });
      }
    } catch (error) {
      proposal = create([{
        code: "runtime_dry_run_failed",
        message: safeMetaFailureCode(error, "meta_patch_dry_run_failed"),
      }]);
    }
    return proposal;
  }

  async reconcileBinding(bindingId: string): Promise<number> {
    const binding = this.#repositories.binding.getBinding(bindingId);
    if (!binding) throw new Error("binding_not_found");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(binding.taskId), "task_architecture_not_found");
    const profile = profileForBinding(binding, architecture);
    if (!profile) throw new Error("binding_execution_profile_not_found");
    const session = required(this.#repositories.binding.getLogicalSession(binding.logicalSessionId), "binding_logical_session_not_found");
    const bootstrap = compileProviderSessionBootstrap({ architecture, session });
    const provider = this.#providers.get(binding.provider);
    if (!provider) throw new Error("provider_unavailable");
    const facts = await provider.reconcileBinding({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      ...(binding.nativeBindingRef ? { nativeBindingRef: binding.nativeBindingRef } : {}),
      executionProfile: profile,
      workspace: architecture.workspace,
      bootstrap,
    });
    let accepted = 0;
    for (const fact of facts) if (await this.reconcileProviderFact(fact)) accepted += 1;
    return accepted;
  }

  /** Trusted Host-only provider stream consumer; adapters still emit facts only. */
  async observeBinding(bindingId: string, signal?: AbortSignal): Promise<void> {
    const binding = required(this.#repositories.binding.getBinding(bindingId), "binding_not_found");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(binding.taskId), "task_architecture_not_found");
    const profile = required(profileForBinding(binding, architecture), "binding_execution_profile_not_found");
    const session = required(this.#repositories.binding.getLogicalSession(binding.logicalSessionId), "binding_logical_session_not_found");
    const bootstrap = compileProviderSessionBootstrap({ architecture, session });
    const provider = this.#providers.get(binding.provider);
    if (!provider) throw new Error("provider_unavailable");
    const iterator = provider.observeBinding({
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      ...(binding.nativeBindingRef ? { nativeBindingRef: binding.nativeBindingRef } : {}),
      executionProfile: profile,
      workspace: architecture.workspace,
      bootstrap,
    })[Symbol.asyncIterator]();
    try {
      while (!signal?.aborted) {
        const next = await iterator.next();
        if (next.done) return;
        await this.reconcileProviderFact(next.value);
      }
    } finally {
      await iterator.return?.();
    }
  }

  observableBindingIds(): readonly string[] {
    return this.#repositories.binding.listObservableBindings().map((binding) => binding.bindingId);
  }

  async #executeCommand(command: RuntimeCommand): Promise<CommandOutcome> {
    switch (command.type) {
      case "template.create_draft": return this.#createTemplateDraft(command);
      case "template.save_draft": return this.#saveTemplateDraft(command);
      case "template.publish_draft": return this.#publishTemplateDraft(command);
      case "template.archive": return this.#archiveTemplate(command);
      case "template.import": return this.#importTemplate(command);
      case "template.export": return this.#exportTemplate(command);
      case "workspace.authorize": return this.#authorizeWorkspace(command);
      case "task_setup.create_draft": return this.#createTaskSetupDraft(command);
      case "task_setup.save_draft": return this.#saveTaskSetupDraft(command);
      case "task_setup.abandon_draft": return this.#abandonTaskSetupDraft(command);
      case "meta.create_session": return this.#createMetaSession(command);
      case "meta.send_message": return this.#sendMetaMessage(command);
      case "meta.abandon_session": return this.#abandonMetaSession(command);
      case "meta.apply_patch": return this.#applyMetaPatch(command);
      case "meta.reject_patch": return this.#rejectMetaPatch(command);
      case "task.create": return this.#createTask(command);
      case "task.start": return this.#startTask(command);
      case "task.restart": return this.#restartTask(command);
      case "task.resume": return this.#resumeTask(command);
      case "task.submit_input": return this.#submitTaskInput(command);
      case "invocation.invoke_agent": return this.#invokeAgent(command);
      case "session.relay_message": return this.#relayMessage(command);
      case "session.publish_message": return this.#publishMessage(command);
      case "session.send_human_message": return this.#sendHumanMessage(command);
      case "session.request_interrupt": return this.#requestSessionInterrupt(command);
      case "attention.respond": return this.#respondAttention(command);
      case "task.stop": return this.#stopTask(command);
      case "task.achieve": return this.#achieveTask(command);
      case "task.archive": return this.#archiveTask(command);
      case "task.restore": return this.#restoreTask(command);
      case "task.preview_permanent_delete": return this.#previewPermanentDelete(command);
      case "task.permanently_delete": return this.#permanentlyDeleteTask(command);
      case "artifact.verify_requested": return this.#verifyRequestedArtifact(command);
      case "artifact.preview": return this.#previewArtifact(command);
      case "presentation.open": return this.#openPresentation(command);
      case "presentation.release": return this.#releasePresentation(command);
    }
    throw new Error("runtime_command_unknown");
  }

  #createTemplateDraft(command: Extract<RuntimeCommand, { type: "template.create_draft" }>): CommandOutcome {
    const now = this.#now();
    const baseVersion = command.baseTemplateVersionId
      ? required(this.#repositories.templateTask.getTemplateVersion(command.baseTemplateVersionId), "template_draft_base_version_not_found")
      : undefined;
    if (baseVersion && command.templateId && baseVersion.templateId !== command.templateId) {
      throw new Error("template_draft_base_version_template_mismatch");
    }
    const draft = createTemplateDraft({
      templateDraftId: createId("template_draft"),
      ...(baseVersion ? { templateId: baseVersion.templateId, baseTemplateVersionId: baseVersion.templateVersionId } : command.templateId ? { templateId: command.templateId } : {}),
      metadata: command.metadata,
      // A Version-derived Draft always begins with Runtime's immutable copy.
      // The renderer may save a later edit through the revision-fenced Draft
      // command, but it cannot forge a different selected-Version origin.
      definition: baseVersion?.definition ?? command.initialDefinition,
      ownerId: command.ownerId,
      now,
    });
    this.#repositories.templateTask.createDraft(draft);
    this.#invalidate(["template_changed"], undefined, undefined, command.commandId);
    return {};
  }

  #saveTemplateDraft(command: Extract<RuntimeCommand, { type: "template.save_draft" }>): CommandOutcome {
    const current = required(this.#repositories.templateTask.getDraft(command.templateDraftId), "template_draft_not_found");
    const draft = saveTemplateDraft(current, command.expectedRevision, command.metadata, command.definition, this.#now());
    this.#repositories.templateTask.updateDraft(draft, command.expectedRevision);
    this.#invalidate(["template_changed"], undefined, undefined, command.commandId);
    return {};
  }

  #publishTemplateDraft(command: Extract<RuntimeCommand, { type: "template.publish_draft" }>): CommandOutcome {
    const now = this.#now();
    const draft = required(this.#repositories.templateTask.getDraft(command.templateDraftId), "template_draft_not_found");
    const templateId = command.templateId ?? draft.templateId ?? createId("template");
    const current = this.#repositories.templateTask.getTemplate(templateId);
    const template = current ?? createTemplateIdentity({ templateId, slug: command.slug, title: command.title, description: command.description, now });
    const published = publishTemplateDraft({
      draft, template, expectedDraftRevision: command.expectedRevision,
      existingVersions: this.#repositories.templateTask.listTemplateVersions(templateId), templateVersionId: createId("template_version"), now,
    });
    const activeMetaSession = this.#repositories.configuration.findActiveMetaSession(draft.ownerId, {
      kind: "template_draft",
      templateDraftId: draft.templateDraftId,
    });
    const consumedMetaSession = activeMetaSession
      ? consumeMetaSession(activeMetaSession, activeMetaSession.revision, now)
      : undefined;
    this.#repositories.transaction(() => {
      this.#repositories.templateTask.publishDraft(published.template, published.version, published.draft, command.expectedRevision);
      if (consumedMetaSession && activeMetaSession) {
        this.#repositories.configuration.updateMetaSession(consumedMetaSession, activeMetaSession.revision);
      }
    });
    this.#invalidate(["template_changed", "configuration_changed"], undefined, undefined, command.commandId);
    return consumedMetaSession ? { metaSession: consumedMetaSession } : {};
  }

  #archiveTemplate(command: Extract<RuntimeCommand, { type: "template.archive" }>): CommandOutcome {
    const now = this.#now();
    const current = required(this.#repositories.templateTask.getTemplate(command.templateId), "template_not_found");
    const archived = archiveTemplate(current, command.expectedRevision, now);
    this.#repositories.templateTask.archiveTemplate(command.templateId, command.expectedRevision, now);
    this.#invalidate(["template_changed"], undefined, undefined, command.commandId);
    return { template: archived };
  }

  #importTemplate(command: Extract<RuntimeCommand, { type: "template.import" }>): CommandOutcome {
    const now = this.#now();
    // Preserve the ordinary YAML/package definition-hash failure exactly. ZIP
    // validation adds only the immutable asset rules after this boundary check.
    const suppliedPackage = validateTemplatePackage(command.package);
    const expectedHash = hashDefinition(suppliedPackage.definition as never);
    if (suppliedPackage.template.definitionHash && suppliedPackage.template.definitionHash !== expectedHash) {
      throw new Error("template_import_definition_hash_mismatch");
    }
    const archive = validateTemplateArchivePayload({
      package: suppliedPackage,
      assets: decodeTemplateAssetTransports(command.assets),
    });
    const packageValue = archive.package;
    const existing = this.#repositories.templateTask.getTemplate(packageValue.template.templateId);
    // A fresh command ID may retry an already-imported package after an
    // ambiguous client response. Let the immutable repository compare that
    // exact Version (definition and assets) instead of rejecting it merely
    // because the Template identity already exists.
    const existingVersion = existing
      ? this.#repositories.templateTask.listTemplateVersions(existing.templateId)
        .find((candidate) => candidate.version === packageValue.template.version)
      : undefined;
    if ((command.mode === "create" && existing && !existingVersion) || (command.mode === "new_version" && !existing)) {
      throw new Error(command.mode === "create" ? "template_import_identity_exists" : "template_import_identity_missing");
    }
    const template: TemplateRecord = existing
      ? { ...existing, title: packageValue.template.title, slug: packageValue.template.slug, ...(packageValue.template.description ? { description: packageValue.template.description } : {}), activeVersionId: createId("template_version"), revision: existing.revision + 1, updatedAt: now }
      : { templateId: packageValue.template.templateId, slug: packageValue.template.slug, title: packageValue.template.title, ...(packageValue.template.description ? { description: packageValue.template.description } : {}), activeVersionId: createId("template_version"), revision: 1, createdAt: now, updatedAt: now };
    const version: TemplateVersionRecord = {
      templateVersionId: template.activeVersionId!, templateId: template.templateId, version: packageValue.template.version,
      definition: packageValue.definition, definitionHash: expectedHash, assetManifestHash: archive.assetManifestHash, createdAt: now, publishedAt: now,
    };
    const manifestByPath = new Map(archive.manifest.assets.map((asset) => [asset.path, asset] as const));
    const assets: readonly TemplateAssetRecord[] = archive.assets.map((asset) => {
      const manifest = required(manifestByPath.get(asset.path), "template_asset_manifest_missing");
      return {
        templateVersionId: version.templateVersionId,
        path: asset.path,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        byteLength: asset.bytes.byteLength,
        contentDigest: manifest.contentDigest,
        bytes: Uint8Array.from(asset.bytes),
        createdAt: now,
      };
    });
    this.#repositories.templateTask.importPackage(template, version, packageValue, assets);
    this.#invalidate(["template_changed"], undefined, undefined, command.commandId);
    return {};
  }

  #exportTemplate(command: Extract<RuntimeCommand, { type: "template.export" }>): CommandOutcome {
    const version = required(this.#repositories.templateTask.getTemplateVersion(command.templateVersionId), "template_version_not_found");
    const template = required(this.#repositories.templateTask.getTemplate(version.templateId), "template_not_found");
    const assets = this.#repositories.templateTask.listTemplateAssets(version.templateVersionId).map((asset) => ({
      path: asset.path,
      bytes: Uint8Array.from(asset.bytes),
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    }));
    const ordinaryPackage = templateVersionToPackage(template, version);
    const portablePackage: TemplatePackage = assets.length === 0
      ? ordinaryPackage
      : {
        ...ordinaryPackage,
        template: {
          ...ordinaryPackage.template,
          assetManifestHash: version.assetManifestHash,
        },
      };
    // Revalidate the selected immutable Version before presenting it to a
    // JSON-only caller; corruption must not become a shareable export.
    const archive = validateTemplateArchivePayload({ package: portablePackage, assets });
    return {
      templatePackage: archive.package,
      templateAssets: encodeTemplateAssetTransports(archive.assets),
    };
  }

  async #authorizeWorkspace(command: Extract<RuntimeCommand, { type: "workspace.authorize" }>): Promise<CommandOutcome> {
    const resolved = await this.#workspaceDirectoryResolver.canonicalizeDirectory(command.directory);
    const authorization = createWorkspaceAuthorization({
      workspaceId: command.workspaceId,
      canonicalDirectory: resolved.canonicalDirectory,
      displayName: command.displayName?.trim() || resolved.defaultDisplayName,
      now: this.#now(),
    });
    this.#repositories.workspace.createAuthorization(authorization);
    this.#invalidate(["workspace_changed"], undefined, undefined, command.commandId);
    return {};
  }

  #createTaskSetupDraft(command: Extract<RuntimeCommand, { type: "task_setup.create_draft" }>): CommandOutcome {
    const version = required(this.#repositories.templateTask.getTemplateVersion(command.templateVersionId), "template_version_not_found");
    required(this.#repositories.workspace.getAuthorization(command.workspaceId), "workspace_not_authorized");
    const draft = createTaskSetupDraft({
      taskSetupDraftId: createId("task_setup_draft"),
      ownerId: command.ownerId,
      templateVersionId: version.templateVersionId,
      workspaceId: command.workspaceId,
      title: command.title,
      goal: command.goal,
      schema: version.definition.taskInputSchema,
      taskInputValues: command.taskInputValues,
      now: this.#now(),
    });
    this.#repositories.configuration.createTaskSetupDraft(draft);
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { taskSetupDraft: draft };
  }

  #saveTaskSetupDraft(command: Extract<RuntimeCommand, { type: "task_setup.save_draft" }>): CommandOutcome {
    const current = required(this.#repositories.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
    if (current.ownerId !== command.ownerId) throw new Error("task_setup_owner_mismatch");
    const version = required(this.#repositories.templateTask.getTemplateVersion(current.templateVersionId), "template_version_not_found");
    required(this.#repositories.workspace.getAuthorization(command.workspaceId), "workspace_not_authorized");
    const draft = saveTaskSetupDraft(current, {
      expectedRevision: command.expectedRevision,
      workspaceId: command.workspaceId,
      title: command.title,
      goal: command.goal,
      schema: version.definition.taskInputSchema,
      taskInputValues: command.taskInputValues,
      now: this.#now(),
    });
    this.#repositories.configuration.updateTaskSetupDraft(draft, current.revision);
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { taskSetupDraft: draft };
  }

  #abandonTaskSetupDraft(command: Extract<RuntimeCommand, { type: "task_setup.abandon_draft" }>): CommandOutcome {
    const current = required(this.#repositories.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
    if (current.ownerId !== command.ownerId) throw new Error("task_setup_owner_mismatch");
    const draft = abandonTaskSetupDraft(current, command.expectedRevision, this.#now());
    const activeSession = this.#repositories.configuration.findActiveMetaSession(command.ownerId, {
      kind: "task_setup_draft",
      taskSetupDraftId: current.taskSetupDraftId,
    });
    const abandonedSession = activeSession
      ? abandonMetaSession(activeSession, activeSession.revision, draft.updatedAt)
      : undefined;
    this.#repositories.transaction(() => {
      this.#repositories.configuration.updateTaskSetupDraft(draft, current.revision);
      if (abandonedSession && activeSession) {
        this.#repositories.configuration.updateMetaSession(abandonedSession, activeSession.revision);
      }
    });
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { taskSetupDraft: draft, ...(abandonedSession ? { metaSession: abandonedSession } : {}) };
  }

  async #createMetaSession(command: Extract<RuntimeCommand, { type: "meta.create_session" }>): Promise<CommandOutcome> {
    if (command.target.kind === "template_draft") {
      const draft = required(this.#repositories.templateTask.getDraft(command.target.templateDraftId), "template_draft_not_found");
      if (draft.ownerId !== command.ownerId) throw new Error("meta_session_target_owner_mismatch");
      if (draft.status !== "editing") throw new Error("meta_session_target_not_editable");
    } else {
      const draft = required(this.#repositories.configuration.getTaskSetupDraft(command.target.taskSetupDraftId), "task_setup_draft_not_found");
      if (draft.ownerId !== command.ownerId) throw new Error("meta_session_target_owner_mismatch");
      if (draft.state !== "draft") throw new Error("meta_session_target_not_editable");
    }
    const option = this.#metaProfiles.resolveAvailable(command.metaProfileOptionId);
    const existing = this.#repositories.configuration.findActiveMetaSession(command.ownerId, command.target);
    if (existing) {
      if (existing.metaProfileOptionId !== command.metaProfileOptionId) throw new Error("meta_session_profile_option_mismatch");
      if (hashDefinition(existing.metaProfile as unknown as JsonValue) !== hashDefinition(option.profile as unknown as JsonValue)) {
        throw new Error("meta_session_profile_snapshot_mismatch");
      }
      await assertMetaAgentProfileAvailable(this.#metaAgents, existing.metaProfile);
      return { metaSession: existing };
    }
    await assertMetaAgentProfileAvailable(this.#metaAgents, option.profile);
    const session = createMetaSession({
      metaSessionId: createId("meta_session"),
      ownerId: command.ownerId,
      target: command.target,
      metaProfileOptionId: option.metaProfileOptionId,
      metaProfile: option.profile,
      now: this.#now(),
    });
    this.#repositories.configuration.createMetaSession(session);
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { metaSession: session };
  }

  async #sendMetaMessage(command: Extract<RuntimeCommand, { type: "meta.send_message" }>): Promise<CommandOutcome> {
    const identity = hashDefinition({
      schemaVersion: 2,
      command: command as unknown as JsonValue,
    });
    const metaTurnId = createId("meta_turn", identity);
    const userMetaMessageId = createId("meta_message", `${identity}-user`);
    const assistantMetaMessageId = createId("meta_message", `${identity}-assistant`);
    const metaPatchProposalId = createId("meta_patch_proposal", identity);
    const replay = this.#repositories.configuration.getMetaTurn(metaTurnId);
    if (replay) {
      const message = required(this.#repositories.configuration.getMetaMessage(replay.userMetaMessageId), "meta_turn_user_message_missing");
      if (
        replay.commandId !== command.commandId
        || replay.idempotencyKey !== command.idempotencyKey
        || replay.metaSessionId !== command.metaSessionId
        || replay.targetRevision !== command.expectedTargetRevision
        || replay.userMetaMessageId !== userMetaMessageId
        || replay.assistantMetaMessageId !== assistantMetaMessageId
        || replay.metaPatchProposalId !== metaPatchProposalId
        || message.role !== "user"
        || message.content !== command.content.trim()
      ) throw new Error("meta_turn_command_retry_conflict");
      const session = required(this.#repositories.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found");
      if (session.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
      return { metaSession: session, metaMessage: message };
    }
    if (this.#repositories.configuration.listMetaTurns().some((turn) => (
      turn.commandId === command.commandId || turn.idempotencyKey === command.idempotencyKey
    ))) throw new Error("meta_turn_command_retry_conflict");
    const current = required(this.#repositories.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found");
    if (current.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    if (current.state !== "active") throw new Error("meta_session_not_active");
    const option = this.#metaProfiles.resolveAvailable(current.metaProfileOptionId);
    if (hashDefinition(option.profile as unknown as JsonValue) !== hashDefinition(current.metaProfile as unknown as JsonValue)) {
      throw new Error("meta_session_profile_snapshot_mismatch");
    }
    // Validate both durable fences and the message itself before any forced
    // Meta Provider capability observation.
    const context = this.#metaTargetContext(current, command.expectedTargetRevision);
    const systemInstructions = metaSystemInstructions(current.mode);
    const outputSchema = META_AGENT_OUTPUT_SCHEMA;
    const appended = appendMetaMessage({
      session: current,
      metaMessageId: userMetaMessageId,
      expectedSessionRevision: command.expectedSessionRevision,
      role: "user",
      content: command.content,
      now: this.#now(),
    });
    await assertMetaAgentProfileAvailable(this.#metaAgents, current.metaProfile);
    const turn: MetaTurnRecord = {
      metaTurnId,
      metaSessionId: current.metaSessionId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      userMetaMessageId,
      assistantMetaMessageId,
      metaPatchProposalId,
      profile: current.metaProfile,
      mode: current.mode,
      targetRevision: command.expectedTargetRevision,
      systemInstructions,
      systemInstructionsDigest: hashDefinition(systemInstructions),
      outputSchema,
      outputSchemaDigest: hashDefinition(outputSchema),
      context,
      contextDigest: hashDefinition(context),
      status: "pending",
      attempts: 0,
      createdAt: appended.message.createdAt,
      updatedAt: appended.message.createdAt,
    };
    this.#repositories.configuration.createMetaMessageAndTurn({
      session: appended.session,
      expectedSessionRevision: current.revision,
      userMessage: appended.message,
      turn,
    });
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { metaSession: appended.session, metaMessage: appended.message };
  }

  #metaTargetContext(session: MetaSessionRecord, expectedTargetRevision: number): JsonValue {
    if (session.mode === "template_design") {
      if (session.target.kind !== "template_draft") throw new Error("meta_session_mode_mismatch");
      const draft = required(this.#repositories.templateTask.getDraft(session.target.templateDraftId), "template_draft_not_found");
      if (draft.status !== "editing") throw new Error("meta_session_target_not_editable");
      if (draft.revision !== expectedTargetRevision) throw new Error("meta_patch_target_revision_stale");
      return {
        schemaVersion: 1,
        mode: "template_design",
        targetRevision: draft.revision,
        templateDraft: {
          metadata: draft.metadata,
          definition: draft.definition,
        },
      } as unknown as JsonValue;
    }
    if (session.target.kind !== "task_setup_draft") throw new Error("meta_session_mode_mismatch");
    const draft = required(this.#repositories.configuration.getTaskSetupDraft(session.target.taskSetupDraftId), "task_setup_draft_not_found");
    if (draft.state !== "draft") throw new Error("meta_session_target_not_editable");
    if (draft.revision !== expectedTargetRevision) throw new Error("meta_patch_target_revision_stale");
    const version = required(this.#repositories.templateTask.getTemplateVersion(draft.templateVersionId), "template_version_not_found");
    const template = required(this.#repositories.templateTask.getTemplate(version.templateId), "template_not_found");
    return {
      schemaVersion: 1,
      mode: "task_setup",
      targetRevision: draft.revision,
      template: {
        title: template.title,
        slug: template.slug,
        ...(template.description === undefined ? {} : { description: template.description }),
        version: version.version,
        taskInputSchema: version.definition.taskInputSchema ?? { fields: [] },
      },
      taskSetupDraft: {
        title: draft.title,
        goal: draft.goal,
        taskInputValues: draft.taskInputValues,
      },
    } as unknown as JsonValue;
  }

  #abandonMetaSession(command: Extract<RuntimeCommand, { type: "meta.abandon_session" }>): CommandOutcome {
    const current = required(this.#repositories.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found");
    if (current.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    const session = abandonMetaSession(current, command.expectedRevision, this.#now());
    this.#repositories.configuration.updateMetaSession(session, current.revision);
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { metaSession: session };
  }

  #applyMetaPatch(command: Extract<RuntimeCommand, { type: "meta.apply_patch" }>): CommandOutcome {
    const session = required(this.#repositories.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found");
    const proposal = required(this.#repositories.configuration.getMetaPatchProposal(command.metaPatchProposalId), "meta_patch_proposal_not_found");
    if (session.ownerId !== command.ownerId || proposal.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    if (session.mode === "template_design") {
      if (session.target.kind !== "template_draft") throw new Error("meta_session_mode_mismatch");
      const current = required(this.#repositories.templateTask.getDraft(session.target.templateDraftId), "template_draft_not_found");
      const applied = applyMetaPatchProposalToTemplateDraft({
        draft: current,
        session,
        proposal,
        expectedTargetRevision: command.expectedTargetRevision,
        now: this.#now(),
      });
      this.#repositories.transaction(() => {
        this.#repositories.templateTask.updateDraft(applied.draft, current.revision);
        this.#repositories.configuration.updateMetaPatchProposal(applied.proposal, proposal.revision);
      });
      this.#invalidate(["template_changed", "configuration_changed"], undefined, undefined, command.commandId);
      return { metaSession: session, metaPatchProposal: applied.proposal };
    }
    if (session.target.kind !== "task_setup_draft") throw new Error("meta_session_mode_mismatch");
    const current = required(this.#repositories.configuration.getTaskSetupDraft(session.target.taskSetupDraftId), "task_setup_draft_not_found");
    const version = required(this.#repositories.templateTask.getTemplateVersion(current.templateVersionId), "template_version_not_found");
    const applied = applyMetaPatchProposalToTaskSetup({
      draft: current,
      schema: version.definition.taskInputSchema,
      session,
      proposal,
      expectedTargetRevision: command.expectedTargetRevision,
      now: this.#now(),
    });
    this.#repositories.transaction(() => {
      this.#repositories.configuration.updateTaskSetupDraft(applied.draft, current.revision);
      this.#repositories.configuration.updateMetaPatchProposal(applied.proposal, proposal.revision);
    });
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { taskSetupDraft: applied.draft, metaSession: session, metaPatchProposal: applied.proposal };
  }

  #rejectMetaPatch(command: Extract<RuntimeCommand, { type: "meta.reject_patch" }>): CommandOutcome {
    const session = required(this.#repositories.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found");
    const proposal = required(this.#repositories.configuration.getMetaPatchProposal(command.metaPatchProposalId), "meta_patch_proposal_not_found");
    if (session.ownerId !== command.ownerId || proposal.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    const rejected = rejectMetaPatchProposal({ proposal, session, now: this.#now() });
    this.#repositories.configuration.updateMetaPatchProposal(rejected, proposal.revision);
    this.#invalidate(["configuration_changed"], undefined, undefined, command.commandId);
    return { metaSession: session, metaPatchProposal: rejected };
  }

  async #createTask(command: Extract<RuntimeCommand, { type: "task.create" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const setup = required(this.#repositories.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
    if (setup.ownerId !== command.ownerId) throw new Error("task_setup_owner_mismatch");
    if (setup.workspaceId !== command.workspaceId) throw new Error("task_setup_workspace_mismatch");
    if (setup.revision !== command.expectedTaskSetupRevision) throw new Error("task_setup_draft_revision_stale");
    const version = required(this.#repositories.templateTask.getTemplateVersion(setup.templateVersionId), "template_version_not_found");
    assertTaskSetupReadyForCreate(setup, version.definition.taskInputSchema);
    const authorization = required(this.#repositories.workspace.getAuthorization(setup.workspaceId), "workspace_not_authorized");
    const workspace = await resolveAuthorizedWorkspace(this.#workspaceDirectoryResolver, authorization);
    const taskGoalContent = compileTaskGoal(setup, version.definition.taskInputSchema);
    const snapshot = createTaskArchitectureSnapshot({
      architectureSnapshotId: createId("architecture"), taskId: command.taskId, templateVersion: version,
      taskInputValues: setup.taskInputValues,
      taskGoalContent,
      taskGoalContentDigest: hashDefinition(taskGoalContent),
      taskGoalCompilerVersion: TASK_GOAL_COMPILER_VERSION,
      workspace, now,
    });
    const task = createTask({ taskId: command.taskId, architectureSnapshotId: snapshot.architectureSnapshotId, title: setup.title, goal: setup.goal, now });
    const consumedSetup = consumeTaskSetupDraft(setup, task.taskId, command.expectedTaskSetupRevision, now);
    const activeMetaSession = this.#repositories.configuration.findActiveMetaSession(setup.ownerId, {
      kind: "task_setup_draft",
      taskSetupDraftId: setup.taskSetupDraftId,
    });
    const consumedMetaSession = activeMetaSession
      ? consumeMetaSession(activeMetaSession, activeMetaSession.revision, now)
      : undefined;
    this.#repositories.transaction(() => {
      this.#repositories.templateTask.createTask({ task, snapshot });
      this.#repositories.configuration.updateTaskSetupDraft(consumedSetup, setup.revision);
      if (consumedMetaSession && activeMetaSession) {
        this.#repositories.configuration.updateMetaSession(consumedMetaSession, activeMetaSession.revision);
      }
    });
    this.#invalidate(["task_changed", "configuration_changed"], task.taskId, undefined, command.commandId);
    return { task, taskSetupDraft: consumedSetup, ...(consumedMetaSession ? { metaSession: consumedMetaSession } : {}) };
  }

  async #startTask(command: Extract<RuntimeCommand, { type: "task.start" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    // Pure domain fences must reject stale or non-startable intent before a
    // forced native capability observation can occur.
    const started = startTaskRun({
      task, architecture, expectedRevision: command.expectedRevision, runId: createId("run"),
      conductorLogicalSessionId: createId("logical_session"), runNumber: this.#repositories.templateTask.countRuns(task.taskId) + 1, now,
    });
    const conductorProfile = required(
      architecture.definition.executionProfiles.find((profile) =>
        profile.executionProfileId === architecture.definition.conductor.executionProfileId,
      ),
      "conductor_execution_profile_not_found",
    );
    await this.#assertProfilesAvailable([conductorProfile]);
    const profile = profileForSession(started.conductorSession, architecture);
    const binding = createProviderSessionBinding({
      bindingId: createId("binding"), taskId: task.taskId, runId: started.run.runId,
      logicalSessionId: started.conductorSession.logicalSessionId, executionProfileId: started.conductorSession.executionProfileId,
      provider: profile.provider, now,
    });
    const outbox = newOutbox({
      commandId: command.commandId, provider: profile.provider, kind: "ensure_binding", bindingId: binding.bindingId,
      payload: { bindingId: binding.bindingId }, now,
    });
    this.#repositories.templateTask.startRun({ task: started.task, run: started.run, conductor: started.conductorSession, binding, outbox });
    this.#createRunGoalMessage(architecture, started.task, started.run, started.conductorSession.logicalSessionId, now);
    this.#invalidate(["task_changed", "run_changed", "message_changed", "inbox_changed"], task.taskId, started.run.runId, command.commandId);
    return { task: started.task, run: started.run };
  }

  async #restartTask(command: Extract<RuntimeCommand, { type: "task.restart" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    const previousRun = required(task.activeRunId ? this.#repositories.templateTask.getRun(task.activeRunId) : undefined, "task_active_run_not_found");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    // As with Start, all revision/status lifecycle checks are pure and precede
    // the forced Provider readiness gate.
    const restarted = restartTaskRun({
      task,
      previousRun,
      architecture,
      expectedRevision: command.expectedRevision,
      runId: createId("run"),
      conductorLogicalSessionId: createId("logical_session"),
      runNumber: this.#repositories.templateTask.countRuns(task.taskId) + 1,
      now,
    });
    if (!this.#allRunBindingsTerminal(previousRun.runId)) throw new Error("task_restart_bindings_not_terminal");
    const conductorProfile = required(
      architecture.definition.executionProfiles.find((profile) =>
        profile.executionProfileId === architecture.definition.conductor.executionProfileId,
      ),
      "conductor_execution_profile_not_found",
    );
    await this.#assertProfilesAvailable([conductorProfile]);
    const profile = profileForSession(restarted.conductorSession, architecture);
    const binding = createProviderSessionBinding({
      bindingId: createId("binding"), taskId: task.taskId, runId: restarted.run.runId,
      logicalSessionId: restarted.conductorSession.logicalSessionId, executionProfileId: restarted.conductorSession.executionProfileId,
      provider: profile.provider, now,
    });
    const outbox = newOutbox({
      commandId: command.commandId, provider: profile.provider, kind: "ensure_binding", bindingId: binding.bindingId,
      payload: { bindingId: binding.bindingId }, now,
    });
    this.#repositories.templateTask.startRun({ task: restarted.task, run: restarted.run, conductor: restarted.conductorSession, binding, outbox });
    this.#createRunGoalMessage(architecture, restarted.task, restarted.run, restarted.conductorSession.logicalSessionId, now);
    this.#invalidate(["task_changed", "run_changed", "message_changed", "inbox_changed"], task.taskId, restarted.run.runId, command.commandId);
    return { task: restarted.task, run: restarted.run };
  }

  async #resumeTask(command: Extract<RuntimeCommand, { type: "task.resume" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    assertTaskNotTrashed(task);
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    if (!task.activeRunId || task.activeRunId !== run.runId) throw new Error("resume_requires_original_active_run");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const bindings = this.#repositories.binding.listBindings(run.runId);
    if (bindings.length === 0 || bindings.some((binding) => !binding.recoverable)) throw new Error("resume_binding_not_recoverable");
    const profiles = [...new Map(bindings.map((binding) => {
      const profile = required(profileForBinding(binding, architecture), "binding_execution_profile_not_found");
      return [profile.executionProfileId, profile] as const;
    })).values()];
    await this.#assertProfilesAvailable(profiles);
    const nextTask: TaskRecord = { ...task, status: "running", revision: task.revision + 1, updatedAt: now };
    const nextRun: TaskRunRecord = { ...run, status: "starting", revision: run.revision + 1 };
    this.#repositories.transaction(() => {
      this.#repositories.templateTask.updateTask(nextTask, task.revision);
      this.#repositories.templateTask.updateRun(nextRun);
      for (const binding of bindings) {
        this.#repositories.invocation.enqueue(newOutbox({
          commandId: `${command.commandId}:${binding.bindingId}`, provider: binding.provider, kind: "ensure_binding", bindingId: binding.bindingId,
          payload: { bindingId: binding.bindingId, resume: true }, now,
        }));
      }
    });
    this.#invalidate(["task_changed", "run_changed"], task.taskId, run.runId, command.commandId);
    return { task: nextTask, run: nextRun };
  }

  #createRunGoalMessage(
    architecture: TaskArchitectureSnapshot,
    task: TaskRecord,
    run: TaskRunRecord,
    conductorLogicalSessionId: string,
    now: string,
  ): void {
    const message = createSessionMessage({
      messageId: createId("message"),
      taskId: task.taskId,
      runId: run.runId,
      kind: "task_goal",
      content: architecture.taskGoalContent,
      taskGoalCompilerVersion: architecture.taskGoalCompilerVersion,
      createdAt: now,
    });
    if (message.contentDigest !== architecture.taskGoalContentDigest) throw new Error("task_goal_snapshot_digest_mismatch");
    const inbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: task.taskId,
      runId: run.runId,
      targetLogicalSessionId: conductorLogicalSessionId,
      renderedMessageId: message.messageId,
      createdAt: now,
    });
    this.#repositories.transaction(() => {
      this.#repositories.message.createMessage(message);
      this.#repositories.inbox.createInboxItem(inbox);
    });
  }

  #submitTaskInput(command: Extract<RuntimeCommand, { type: "task.submit_input" }>): CommandOutcome {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    this.#assertRunAcceptsNewWork(task, run);
    if (command.targetLogicalSessionId !== run.conductorLogicalSessionId) throw new Error("task_input_target_must_be_conductor");
    const message = createSessionMessage({
      messageId: createId("message"),
      taskId: task.taskId,
      runId: run.runId,
      kind: "user_input",
      content: command.content,
      createdAt: now,
    });
    const inbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: task.taskId,
      runId: run.runId,
      targetLogicalSessionId: run.conductorLogicalSessionId,
      renderedMessageId: message.messageId,
      createdAt: now,
    });
    this.#repositories.transaction(() => {
      this.#repositories.message.createMessage(message);
      this.#repositories.inbox.createInboxItem(inbox);
    });
    this.#invalidate(["message_changed", "inbox_changed"], task.taskId, run.runId, command.commandId);
    return { task, run };
  }

  async #invokeAgent(command: Extract<RuntimeCommand, { type: "invocation.invoke_agent" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    this.#assertRunAcceptsNewWork(task, run);
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    if (run.conductorLogicalSessionId !== command.sourceLogicalSessionId) throw new Error("invocation_conductor_mismatch");
    const decisionTurn = this.#requireConductorDecisionTurn(command.decidedBySessionTurnId, task, run, command.sourceLogicalSessionId);
    const selections = this.#resolveMessageSelections(command.messageSelections, task.taskId, run.runId);
    const requestedArtifacts = normalizeRequestedArtifactPaths(command.requestedArtifacts ?? []);
    let session = this.#repositories.binding.findLogicalSession(run.runId, command.agentCardId);
    const createdSession = !session;
    if (!session) {
      session = createCardLogicalSession({
        architecture, runId: run.runId, logicalSessionId: createId("logical_session"), agentCardId: command.agentCardId,
        ordinal: this.#repositories.binding.listLogicalSessions(run.runId).length + 1, now,
      });
    }
    const profile = profileForSession(session, architecture);
    await this.#assertProfilesAvailable([profile]);
    let binding = this.#repositories.binding.findBindingForLogicalSession(session.logicalSessionId);
    const createdBinding = !binding;
    if (!binding) {
      binding = createProviderSessionBinding({
        bindingId: createId("binding"), taskId: task.taskId, runId: run.runId, logicalSessionId: session.logicalSessionId,
        executionProfileId: session.executionProfileId, provider: profile.provider, now,
      });
    }
    const existingForward = this.#repositories.forward.findForwardByTargetKey(
      task.taskId,
      run.runId,
      command.idempotencyKey,
      session.logicalSessionId,
    );
    const existingInvocation = this.#repositories.invocation.getInvocation(command.invocationId);
    if (existingForward || existingInvocation) {
      if (!existingForward || !existingInvocation) throw new Error("invocation_recovery_records_incomplete");
      assertForwardReplay(existingForward, {
        commandId: command.commandId,
        expectedTaskRevision: command.expectedRevision,
        decidedByLogicalSessionId: command.sourceLogicalSessionId,
        decidedBySessionTurnId: decisionTurn.sessionTurnId,
        targetLogicalSessionId: session.logicalSessionId,
        mode: "invoke",
        selectionDigest: resolvedSelectionDigest(selections),
      });
      if (
        existingInvocation.taskId !== task.taskId
        || existingInvocation.runId !== run.runId
        || existingInvocation.replyToLogicalSessionId !== command.sourceLogicalSessionId
        || existingInvocation.targetLogicalSessionId !== session.logicalSessionId
        || existingInvocation.targetAgentCardId !== command.agentCardId
        || existingInvocation.bindingId !== binding.bindingId
        || existingInvocation.instruction !== command.instruction
        || hashDefinition(existingInvocation.acceptanceCriteria as unknown as JsonValue) !== hashDefinition(command.acceptanceCriteria as unknown as JsonValue)
        || hashDefinition(existingInvocation.requestedArtifacts as unknown as JsonValue) !== hashDefinition(requestedArtifacts as unknown as JsonValue)
        || existingInvocation.priority !== command.priority
      ) throw new Error("invocation_idempotency_conflict");
      return { task, run };
    }
    const assignmentMessage = createSessionMessage({
      messageId: createId("message"),
      taskId: task.taskId,
      runId: run.runId,
      sourceLogicalSessionId: command.sourceLogicalSessionId,
      invocationId: command.invocationId,
      kind: "agent_assignment",
      content: renderAgentAssignment({
        instruction: command.instruction,
        acceptanceCriteria: command.acceptanceCriteria,
        requestedArtifacts,
        selections,
      }),
      createdAt: now,
    });
    const forward = createMessageForward({
      forwardId: createId("message_forward"),
      forwardSelectionIds: selections.map(() => createId("forward_selection")),
      taskId: task.taskId,
      runId: run.runId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      expectedTaskRevision: command.expectedRevision,
      targetIdempotencyKey: `${command.idempotencyKey}:${session.logicalSessionId}`,
      decidedByLogicalSessionId: command.sourceLogicalSessionId,
      decidedBySessionTurn: decisionTurn,
      targetLogicalSessionId: session.logicalSessionId,
      mode: "invoke",
      selections,
      renderedMessageId: assignmentMessage.messageId,
      now,
    });
    const inbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: task.taskId,
      runId: run.runId,
      targetLogicalSessionId: session.logicalSessionId,
      renderedMessageId: assignmentMessage.messageId,
      forwardId: forward.forwardId,
      replyToLogicalSessionId: run.conductorLogicalSessionId,
      createdAt: now,
    });
    const invocation = createInvocation({
      invocationId: command.invocationId, taskId: task.taskId, runId: run.runId, replyToLogicalSessionId: command.sourceLogicalSessionId,
      targetLogicalSessionId: session.logicalSessionId, targetAgentCardId: command.agentCardId, bindingId: binding.bindingId,
      assignmentMessage,
      instruction: command.instruction,
      acceptanceCriteria: command.acceptanceCriteria, requestedArtifacts, priority: command.priority, now,
    });
    this.#repositories.transaction(() => {
      if (createdSession) this.#repositories.binding.createLogicalSession(session);
      if (createdBinding) {
        this.#repositories.binding.createBinding(binding);
        this.#repositories.invocation.enqueue(newOutbox({
          commandId: `${command.commandId}:${binding.bindingId}`, provider: binding.provider, kind: "ensure_binding", bindingId: binding.bindingId,
          payload: { bindingId: binding.bindingId }, now,
        }));
      }
      this.#repositories.message.createMessage(assignmentMessage);
      this.#repositories.forward.createForward(forward);
      this.#repositories.inbox.createInboxItem(inbox);
      this.#repositories.invocation.createInvocation(invocation);
    });
    this.#invalidate(["message_changed", "inbox_changed", "invocation_changed"], task.taskId, run.runId, command.commandId);
    return { task, run };
  }

  async #relayMessage(command: Extract<RuntimeCommand, { type: "session.relay_message" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    this.#assertRunAcceptsNewWork(task, run);
    if (run.conductorLogicalSessionId !== command.sourceLogicalSessionId) throw new Error("relay_conductor_mismatch");
    const decisionTurn = this.#requireConductorDecisionTurn(command.decidedBySessionTurnId, task, run, command.sourceLogicalSessionId);
    const selections = this.#resolveMessageSelections(command.messageSelections, task.taskId, run.runId);
    assertRelaySelectionsAllowed({ selections });
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const target = await this.#prepareCardSession(task, run, architecture, command.targetAgentCardId, command.commandId, now);
    const existingForward = this.#repositories.forward.findForwardByTargetKey(
      task.taskId,
      run.runId,
      command.idempotencyKey,
      target.session.logicalSessionId,
    );
    if (existingForward) {
      assertForwardReplay(existingForward, {
        commandId: command.commandId,
        expectedTaskRevision: command.expectedRevision,
        decidedByLogicalSessionId: command.sourceLogicalSessionId,
        decidedBySessionTurnId: decisionTurn.sessionTurnId,
        targetLogicalSessionId: target.session.logicalSessionId,
        mode: "relay",
        selectionDigest: resolvedSelectionDigest(selections),
      });
      return { task, run };
    }
    const renderedMessage = createSessionMessage({
      messageId: createId("message"),
      taskId: task.taskId,
      runId: run.runId,
      sourceLogicalSessionId: command.sourceLogicalSessionId,
      kind: "relay_forward",
      content: renderRelayForward(selections),
      createdAt: now,
    });
    const forward = createMessageForward({
      forwardId: createId("message_forward"),
      forwardSelectionIds: selections.map(() => createId("forward_selection")),
      taskId: task.taskId,
      runId: run.runId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      expectedTaskRevision: command.expectedRevision,
      targetIdempotencyKey: `${command.idempotencyKey}:${target.session.logicalSessionId}`,
      decidedByLogicalSessionId: command.sourceLogicalSessionId,
      decidedBySessionTurn: decisionTurn,
      targetLogicalSessionId: target.session.logicalSessionId,
      mode: "relay",
      selections,
      renderedMessageId: renderedMessage.messageId,
      now,
    });
    const inbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: task.taskId,
      runId: run.runId,
      targetLogicalSessionId: target.session.logicalSessionId,
      renderedMessageId: renderedMessage.messageId,
      forwardId: forward.forwardId,
      replyToLogicalSessionId: run.conductorLogicalSessionId,
      createdAt: now,
    });
    this.#repositories.transaction(() => {
      this.#persistPreparedCardSession(target);
      this.#repositories.message.createMessage(renderedMessage);
      this.#repositories.forward.createForward(forward);
      this.#repositories.inbox.createInboxItem(inbox);
    });
    this.#invalidate(["message_changed", "inbox_changed", "run_changed"], task.taskId, run.runId, command.commandId);
    return { task, run };
  }

  async #publishMessage(command: Extract<RuntimeCommand, { type: "session.publish_message" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    this.#assertRunAcceptsNewWork(task, run);
    if (run.conductorLogicalSessionId !== command.sourceLogicalSessionId) throw new Error("publish_conductor_mismatch");
    if (command.targetAgentCardIds.length === 0 || new Set(command.targetAgentCardIds).size !== command.targetAgentCardIds.length) {
      throw new Error("publish_targets_invalid");
    }
    const decisionTurn = this.#requireConductorDecisionTurn(command.decidedBySessionTurnId, task, run, command.sourceLogicalSessionId);
    const selections = this.#resolveMessageSelections(command.messageSelections, task.taskId, run.runId);
    assertRelaySelectionsAllowed({ selections });
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const targets: PreparedCardSession[] = [];
    let nextSessionOrdinal = this.#repositories.binding.listLogicalSessions(run.runId).length + 1;
    for (const agentCardId of command.targetAgentCardIds) {
      const target = await this.#prepareCardSession(
        task,
        run,
        architecture,
        agentCardId,
        `${command.commandId}:${agentCardId}`,
        now,
        nextSessionOrdinal,
      );
      targets.push(target);
      if (target.createdSession) nextSessionOrdinal += 1;
    }
    const orderedTargets = [...targets].sort((left, right) => left.session.logicalSessionId.localeCompare(right.session.logicalSessionId));
    const selectionIdentity = selections.map((selection) => selection.kind === "full_message"
      ? { kind: selection.kind, sourceMessageId: selection.message.messageId, contentDigest: selection.message.contentDigest }
      : { kind: selection.kind, sourceMessageId: selection.relayBlock.sourceMessageId, relayBlockId: selection.relayBlock.relayBlockId, contentDigest: selection.relayBlock.contentDigest }) as JsonValue;
    const selectionDigest = hashDefinition(selectionIdentity);
    const createDelivery = (target: PreparedCardSession, publishBatchId: string) => {
      const renderedMessage = createSessionMessage({
        messageId: createId("message"),
        taskId: task.taskId,
        runId: run.runId,
        sourceLogicalSessionId: command.sourceLogicalSessionId,
        kind: "publish_forward",
        content: renderRelayForward(selections),
        createdAt: now,
      });
      const forward = createMessageForward({
        forwardId: createId("message_forward"),
        forwardSelectionIds: selections.map(() => createId("forward_selection")),
        taskId: task.taskId,
        runId: run.runId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        expectedTaskRevision: command.expectedRevision,
        publishBatchId,
        targetIdempotencyKey: `${publishBatchId}:${target.session.logicalSessionId}`,
        decidedByLogicalSessionId: command.sourceLogicalSessionId,
        decidedBySessionTurn: decisionTurn,
        targetLogicalSessionId: target.session.logicalSessionId,
        mode: "publish",
        selections,
        renderedMessageId: renderedMessage.messageId,
        now,
      });
      const inbox = createSessionInboxItem({
        inboxItemId: createId("inbox"),
        taskId: task.taskId,
        runId: run.runId,
        targetLogicalSessionId: target.session.logicalSessionId,
        renderedMessageId: renderedMessage.messageId,
        forwardId: forward.forwardId,
        replyToLogicalSessionId: run.conductorLogicalSessionId,
        createdAt: now,
      });
      return { target, renderedMessage, forward, inbox };
    };
    const existingByIdempotency = this.#repositories.forward.findBatchByIdempotencyKey(task.taskId, run.runId, command.idempotencyKey);
    const existingByFanout = this.#repositories.forward.findBatchByFanoutKey(task.taskId, run.runId, command.fanoutKey);
    if (existingByIdempotency || existingByFanout) {
      if (existingByIdempotency?.publishBatchId !== existingByFanout?.publishBatchId) {
        throw new Error("message_forward_batch_replay_conflict");
      }
      const existing = existingByIdempotency ?? existingByFanout!;
      const targetLogicalSessionIds = orderedTargets.map((target) => target.session.logicalSessionId);
      if (
        existing.commandId !== command.commandId
        || existing.expectedTaskRevision !== command.expectedRevision
        || existing.fanoutKey !== command.fanoutKey
        || existing.decidedByLogicalSessionId !== command.sourceLogicalSessionId
        || existing.decidedBySessionTurnId !== decisionTurn.sessionTurnId
        || existing.selectionDigest !== selectionDigest
        || hashDefinition(existing.targetLogicalSessionIds as unknown as JsonValue) !== hashDefinition(targetLogicalSessionIds as unknown as JsonValue)
      ) throw new Error("message_forward_batch_idempotency_conflict");
      const missingTargets: PreparedCardSession[] = [];
      for (const target of orderedTargets) {
        const targetLogicalSessionId = target.session.logicalSessionId;
        const forward = this.#repositories.forward.findForwardByTargetKey(
          task.taskId,
          run.runId,
          command.idempotencyKey,
          targetLogicalSessionId,
        );
        if (!forward) {
          missingTargets.push(target);
          continue;
        }
        if (forward.publishBatchId !== existing.publishBatchId) throw new Error("message_forward_batch_recovery_conflict");
        assertForwardReplay(forward, {
          commandId: command.commandId,
          expectedTaskRevision: command.expectedRevision,
          decidedByLogicalSessionId: command.sourceLogicalSessionId,
          decidedBySessionTurnId: decisionTurn.sessionTurnId,
          targetLogicalSessionId,
          mode: "publish",
          selectionDigest: resolvedSelectionDigest(selections),
        });
      }
      if (missingTargets.length > 0) {
        const recovered = missingTargets.map((target) => createDelivery(target, existing.publishBatchId));
        this.#repositories.transaction(() => {
          for (const delivery of recovered) {
            this.#persistPreparedCardSession(delivery.target);
            this.#repositories.message.createMessage(delivery.renderedMessage);
            this.#repositories.forward.createForward(delivery.forward);
            this.#repositories.inbox.createInboxItem(delivery.inbox);
          }
          this.#repositories.forward.updateBatch({ ...existing, state: "settled", updatedAt: now });
        });
        this.#invalidate(["message_changed", "inbox_changed", "run_changed"], task.taskId, run.runId, command.commandId);
      }
      return { task, run };
    }
    const publishBatchId = createId("message_forward_batch");
    const batch = {
      publishBatchId,
      taskId: task.taskId,
      runId: run.runId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      expectedTaskRevision: command.expectedRevision,
      fanoutKey: command.fanoutKey,
      decidedByLogicalSessionId: command.sourceLogicalSessionId,
      decidedBySessionTurnId: decisionTurn.sessionTurnId,
      targetLogicalSessionIds: orderedTargets.map((target) => target.session.logicalSessionId),
      selectionDigest,
      state: "settled" as const,
      createdAt: now,
      updatedAt: now,
    };
    const deliveries = orderedTargets.map((target) => createDelivery(target, publishBatchId));
    this.#repositories.transaction(() => {
      for (const target of orderedTargets) this.#persistPreparedCardSession(target);
      for (const delivery of deliveries) this.#repositories.message.createMessage(delivery.renderedMessage);
      this.#repositories.forward.createBatch(batch);
      for (const delivery of deliveries) {
        this.#repositories.forward.createForward(delivery.forward);
        this.#repositories.inbox.createInboxItem(delivery.inbox);
      }
    });
    this.#invalidate(["message_changed", "inbox_changed", "run_changed"], task.taskId, run.runId, command.commandId);
    return { task, run };
  }

  #sendHumanMessage(command: Extract<RuntimeCommand, { type: "session.send_human_message" }>): CommandOutcome {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    this.#assertRunAcceptsNewWork(task, run);
    const target = required(this.#repositories.binding.getLogicalSession(command.targetLogicalSessionId), "logical_session_not_found");
    if (target.runId !== run.runId || target.kind !== "card") throw new Error("human_intervention_target_not_card");
    const existing = this.#repositories.humanIntervention.findInterventionByIdempotencyKey(task.taskId, run.runId, command.idempotencyKey);
    if (existing) {
      if (
        existing.humanInterventionId !== command.humanInterventionId
        || existing.commandId !== command.commandId
        || existing.expectedTaskRevision !== command.expectedRevision
        || existing.targetLogicalSessionId !== command.targetLogicalSessionId
        || existing.contentDigest !== hashDefinition(command.content)
      ) throw new Error("human_intervention_idempotency_conflict");
      if (existing.state === "ready_to_send") this.#materializeHumanInterventionMessages(existing, run, now);
      if (["interrupting", "awaiting_turn_close"].includes(existing.state) && existing.affectedSessionTurnId) {
        const affected = this.#repositories.turn.getTurn(existing.affectedSessionTurnId);
        if (affected && ["returned", "interrupted", "completed", "failed", "cancelled"].includes(affected.status)) {
          const ready = markHumanInterventionReady(existing, now);
          this.#repositories.humanIntervention.updateIntervention(ready);
          this.#materializeHumanInterventionMessages(ready, run, now);
        }
      }
      return { task, run };
    }
    const activeTurn = [...this.#repositories.turn.listTurnsForSession(target.logicalSessionId)].reverse().find(isSessionTurnActive);
    const affectedInvocation = activeTurn?.invocationId
      ? this.#repositories.invocation.getInvocation(activeTurn.invocationId)
      : undefined;
    const intervention = createHumanIntervention({
      humanInterventionId: command.humanInterventionId,
      taskId: task.taskId,
      runId: run.runId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      expectedTaskRevision: command.expectedRevision,
      targetLogicalSessionId: target.logicalSessionId,
      content: command.content,
      ...(activeTurn ? { activeTurn } : {}),
      ...(affectedInvocation ? { affectedInvocation } : {}),
      now,
    });
    if (activeTurn) {
      const binding = required(this.#repositories.binding.findBindingForLogicalSession(target.logicalSessionId), "binding_not_found");
      const interruptedTurn = requestSessionTurnInterrupt(activeTurn, now);
      this.#repositories.transaction(() => {
        this.#repositories.humanIntervention.createIntervention(intervention);
        this.#repositories.turn.updateTurn(interruptedTurn);
        this.#repositories.invocation.enqueue(newOutbox({
          commandId: command.commandId,
          provider: binding.provider,
          kind: "request_interrupt",
          bindingId: binding.bindingId,
          payload: {
            invocationId: activeTurn.invocationId ?? null,
            sessionTurnId: activeTurn.sessionTurnId,
            idempotencyKey: command.idempotencyKey,
          },
          now,
        }));
      });
      this.#invalidate(["run_changed"], task.taskId, run.runId, command.commandId);
      return { task, run };
    }
    this.#repositories.humanIntervention.createIntervention(intervention);
    this.#materializeHumanInterventionMessages(intervention, run, now);
    this.#invalidate(["message_changed", "inbox_changed"], task.taskId, run.runId, command.commandId);
    return { task, run };
  }

  #requestSessionInterrupt(command: Extract<RuntimeCommand, { type: "session.request_interrupt" }>): CommandOutcome {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    const turn = required(this.#repositories.turn.getTurn(command.sessionTurnId), "session_turn_not_found");
    if (turn.taskId !== task.taskId || turn.runId !== run.runId || turn.targetLogicalSessionId !== command.targetLogicalSessionId) {
      throw new Error("session_interrupt_scope_mismatch");
    }
    const binding = required(this.#repositories.binding.findBindingForLogicalSession(turn.targetLogicalSessionId), "binding_not_found");
    const interrupted = requestSessionTurnInterrupt(turn, now);
    this.#repositories.transaction(() => {
      this.#repositories.turn.updateTurn(interrupted);
      this.#repositories.invocation.enqueue(newOutbox({
        commandId: command.commandId,
        provider: binding.provider,
        kind: "request_interrupt",
        bindingId: binding.bindingId,
        payload: { invocationId: turn.invocationId ?? null, sessionTurnId: turn.sessionTurnId, idempotencyKey: command.idempotencyKey },
        now,
      }));
    });
    this.#invalidate(["run_changed"], task.taskId, run.runId, command.commandId);
    return { task, run };
  }

  #respondAttention(command: Extract<RuntimeCommand, { type: "attention.respond" }>): CommandOutcome {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const attention = required(this.#repositories.invocation.getAttention(command.attentionId), "attention_not_found");
    if (attention.taskId !== task.taskId || task.activeRunId !== attention.runId) {
      throw new Error("attention_task_run_scope_mismatch");
    }
    const binding = required(this.#repositories.binding.getBinding(command.bindingId), "binding_not_found");
    if (binding.bindingId !== attention.bindingId || binding.taskId !== task.taskId || binding.runId !== attention.runId) {
      throw new Error("attention_binding_scope_mismatch");
    }
    const staged = stageAttentionResponse(attention, {
      attentionId: command.attentionId, bindingId: command.bindingId, bindingRevision: command.bindingRevision,
      nativeRequestId: command.nativeRequestId, activeInputSubmissionId: command.activeInputSubmissionId,
      activeInvocationId: command.activeInvocationId, response: command.response,
    }, now);
    this.#repositories.invocation.updateAttention(staged);
    this.#repositories.invocation.enqueue(newOutbox({
      commandId: command.commandId, provider: binding.provider, kind: "respond_attention", bindingId: binding.bindingId,
      payload: { attentionId: staged.attentionId, nativeRequestId: staged.nativeRequestId, response: staged.response ?? {}, inputSubmissionId: staged.activeInputSubmissionId ?? null, invocationId: staged.activeInvocationId ?? null }, now,
    }));
    this.#invalidate(["attention_changed"], task.taskId, attention.runId, command.commandId);
    return { task };
  }

  async #stopTask(command: Extract<RuntimeCommand, { type: "task.stop" }>): Promise<CommandOutcome> {
    const now = this.#now();
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    const runBindings = this.#repositories.binding.listBindings(run.runId);
    const bindings = this.#requireCompleteStopBindingSet(command.bindingIds, runBindings);
    const requested = requestTaskStop(task, run, command.expectedRevision, now);
    const interruptBindings = bindings.filter((binding) => this.#bindingRequiresInterrupt(binding, run.runId));
    const idleBindings = bindings.filter((binding) => !interruptBindings.includes(binding));
    // Stop is user intent, but it must not mutate Task/Run into `stopping` if
    // the selected native Provider cannot prove a terminal interrupt. This
    // guards against an adapter exposing a low-level abort route without
    // advertising it in the frozen Execution Profile.
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    await this.#assertBindingsInterruptAvailable(interruptBindings, architecture);
    const cancellableInvocations = this.#repositories.invocation.listInvocations(run.runId)
      .filter((invocation) => bindings.some((binding) => binding.bindingId === invocation.bindingId))
      .filter((invocation) => ["staged", "effect_accepted", "running"].includes(invocation.status));
    this.#repositories.transaction(() => {
      this.#repositories.templateTask.updateTask(requested.task, task.revision);
      this.#repositories.templateTask.updateRun(requested.run);
      for (const invocation of cancellableInvocations) {
        this.#repositories.invocation.updateInvocation(requestInvocationCancellation(invocation, now));
      }
      for (const binding of interruptBindings) {
        this.#repositories.invocation.enqueue(newOutbox({
          commandId: `${command.commandId}:${binding.bindingId}`, provider: binding.provider, kind: "request_interrupt", bindingId: binding.bindingId,
          payload: { invocationId: null, idempotencyKey: `${command.commandId}:${binding.bindingId}` }, now,
        }));
      }
      for (const binding of idleBindings) {
        this.#repositories.binding.updateBinding(requestBindingRelease(binding, now));
        this.#repositories.invocation.enqueue(newOutbox({
          commandId: `${command.commandId}:${binding.bindingId}:release`, provider: binding.provider, kind: "release_binding", bindingId: binding.bindingId,
          payload: { idempotencyKey: `${command.commandId}:${binding.bindingId}:release` }, now,
        }));
      }
    });
    this.#invalidate(["task_changed", "run_changed"], task.taskId, run.runId, command.commandId);
    return { task: requested.task, run: requested.run };
  }

  #achieveTask(command: Extract<RuntimeCommand, { type: "task.achieve" }>): CommandOutcome {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    const knownArtifacts = new Set(this.#repositories.artifact.listArtifactsForTask(task.taskId).map((artifact) => artifact.artifactId));
    if (command.acceptedArtifactIds.some((artifactId) => !knownArtifacts.has(artifactId))) {
      throw new Error("achieve_artifact_not_verified_for_task");
    }
    // This is a user decision, not a Provider/Conductor conclusion. Empty
    // acceptedArtifactIds are valid, and acceptance does not change Run state.
    const achieved = achieveTask({
      task,
      expectedRevision: command.expectedRevision,
      acceptedArtifactIds: command.acceptedArtifactIds,
      acceptanceNote: command.acceptanceNote,
      now: this.#now(),
    });
    this.#repositories.templateTask.updateTask(achieved, task.revision);
    this.#invalidate(["task_changed"], achieved.taskId, undefined, command.commandId);
    return { task: achieved };
  }

  #archiveTask(command: Extract<RuntimeCommand, { type: "task.archive" }>): CommandOutcome {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    // Achieve is not evidence of a stopped Provider. Preserve old Recycle Bin
    // safety by requiring every retained native binding terminal first.
    if (task.activeRunId && !this.#allRunBindingsTerminal(task.activeRunId)) {
      throw new Error("task_archive_bindings_not_terminal");
    }
    const archived = archiveTask({ task, expectedRevision: command.expectedRevision, now: this.#now() });
    this.#repositories.templateTask.updateTask(archived, task.revision);
    this.#invalidate(["task_changed"], archived.taskId, undefined, command.commandId);
    return { task: archived };
  }

  #restoreTask(command: Extract<RuntimeCommand, { type: "task.restore" }>): CommandOutcome {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    const restored = restoreTask({ task, expectedRevision: command.expectedRevision, now: this.#now() });
    this.#repositories.templateTask.updateTask(restored, task.revision);
    this.#invalidate(["task_changed"], restored.taskId, undefined, command.commandId);
    return { task: restored };
  }

  async #previewPermanentDelete(command: Extract<RuntimeCommand, { type: "task.preview_permanent_delete" }>): Promise<CommandOutcome> {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    assertTaskRevision(task, command.expectedRevision);
    if (!task.trashedAt) throw new Error("task_not_in_recycle_bin");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const permanentDeletePreview = await this.#managedArtifactPort.previewPermanentDelete({
      architecture,
      taskId: task.taskId,
      expectedRevision: task.revision,
      artifacts: this.#repositories.artifact.listArtifactsForTask(task.taskId),
    });
    if (permanentDeletePreview.taskId !== task.taskId || permanentDeletePreview.expectedRevision !== task.revision) {
      throw new Error("task_permanent_delete_preview_scope_mismatch");
    }
    return { permanentDeletePreview };
  }

  async #previewArtifact(command: Extract<RuntimeCommand, { type: "artifact.preview" }>): Promise<CommandOutcome> {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    assertTaskRevision(task, command.expectedRevision);
    const artifact = required(this.#repositories.artifact.getArtifact(command.artifactId), "artifact_not_found");
    if (artifact.taskId !== task.taskId) throw new Error("artifact_task_scope_mismatch");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const artifactPreview = await this.#managedArtifactPort.previewArtifact({ architecture, artifact });
    if (artifactPreview.taskId !== task.taskId || artifactPreview.artifactId !== artifact.artifactId) {
      throw new Error("artifact_preview_scope_mismatch");
    }
    return { artifactPreview };
  }

  async #verifyRequestedArtifact(
    command: Extract<RuntimeCommand, { type: "artifact.verify_requested" }>,
  ): Promise<CommandOutcome> {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    assertTaskRevision(task, command.expectedRevision);
    const run = required(this.#repositories.templateTask.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    this.#assertRunAcceptsNewWork(task, run);
    if (command.sourceLogicalSessionId !== run.conductorLogicalSessionId) {
      throw new Error("artifact_conductor_mismatch");
    }
    this.#requireConductorDecisionTurn(
      command.decidedBySessionTurnId,
      task,
      run,
      command.sourceLogicalSessionId,
    );
    if (!command.idempotencyKey.trim() || command.idempotencyKey !== command.commandId) {
      throw new Error("artifact_idempotency_key_mismatch");
    }

    const invocation = required(
      this.#repositories.invocation.getInvocation(command.sourceInvocationId),
      "artifact_source_invocation_not_found",
    );
    if (invocation.taskId !== task.taskId || invocation.runId !== run.runId) {
      throw new Error("artifact_source_invocation_scope_mismatch");
    }
    const sourceMessage = required(
      invocation.finalMessageId
        ? this.#repositories.message.getMessage(invocation.finalMessageId)
        : undefined,
      "artifact_source_final_message_not_found",
    );
    const sourceTurns = this.#repositories.turn.listTurns(run.runId)
      .filter((turn) => turn.invocationId === invocation.invocationId);
    if (sourceTurns.length !== 1) throw new Error("artifact_source_turn_ambiguous");
    const sourceTurn = sourceTurns[0]!;
    if (
      sourceTurn.taskId !== task.taskId
      || sourceTurn.runId !== run.runId
      || sourceTurn.targetLogicalSessionId !== invocation.targetLogicalSessionId
      || sourceTurn.finalMessageId !== sourceMessage.messageId
      || (sourceTurn.status !== "returned" && sourceTurn.status !== "completed")
    ) {
      throw new Error("artifact_source_turn_not_canonical");
    }
    const claim = authorizeRequestedArtifactClaim({
      invocation,
      sourceFinalMessage: sourceMessage,
      conductorLogicalSessionId: run.conductorLogicalSessionId,
      workspaceRelativePath: command.workspaceRelativePath,
    });
    const architecture = required(
      this.#repositories.templateTask.getArchitectureSnapshot(task.taskId),
      "task_architecture_not_found",
    );
    const artifactId = createId("artifact", hashDefinition({
      sourceMessageId: claim.sourceMessageId,
      workspaceRelativePath: claim.workspaceRelativePath,
    }));
    const existing = this.#repositories.artifact.findArtifactByClaim(
      claim.sourceMessageId,
      claim.workspaceRelativePath,
    );
    if (existing) {
      assertRequestedArtifactRecord(existing, {
        artifactId,
        taskId: task.taskId,
        runId: run.runId,
        sourceInvocationId: claim.sourceInvocationId,
        sourceMessageId: claim.sourceMessageId,
        workspaceRelativePath: claim.workspaceRelativePath,
      });
      return { task, run, artifactId: existing.artifactId };
    }
    const verifiedAt = this.#now();
    const verified = await this.#managedArtifactPort.verifyArtifact({
      artifactId,
      architecture,
      runId: run.runId,
      workspaceRelativePath: claim.workspaceRelativePath,
      sourceInvocationId: claim.sourceInvocationId,
      sourceMessageId: claim.sourceMessageId,
      evidenceReferenceIds: [],
      verifiedAt,
    });
    assertRequestedArtifactRecord(verified, {
      artifactId,
      taskId: task.taskId,
      runId: run.runId,
      sourceInvocationId: claim.sourceInvocationId,
      sourceMessageId: claim.sourceMessageId,
      workspaceRelativePath: claim.workspaceRelativePath,
    });
    // Filesystem verification is read-only but asynchronous. Re-check the
    // mutation fence before making the verified provenance durable.
    const currentTask = required(this.#repositories.templateTask.getTask(task.taskId), "task_not_found");
    assertTaskRevision(currentTask, command.expectedRevision);
    const currentRun = required(this.#repositories.templateTask.getRun(run.runId), "task_run_not_found");
    this.#assertRunAcceptsNewWork(currentTask, currentRun);
    const persisted = this.#repositories.artifact.recordArtifact(verified);
    if (persisted.artifactId !== artifactId) throw new Error("artifact_persisted_identity_mismatch");
    this.#invalidate(["artifact_changed"], task.taskId, run.runId, command.commandId);
    return { task, run, artifactId };
  }

  async #permanentlyDeleteTask(command: Extract<RuntimeCommand, { type: "task.permanently_delete" }>): Promise<CommandOutcome> {
    const payloadFingerprint = hashDefinition(command as unknown as JsonValue);
    const tombstone = this.#repositories.retention.getPermanentDeleteTombstone(command.commandId);
    if (tombstone) {
      if (tombstone.taskId !== command.taskId || tombstone.payloadFingerprint !== payloadFingerprint) {
        throw new Error("runtime_command_id_reused_with_different_payload");
      }
      return { permanentDelete: tombstone.result };
    }
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    assertTaskRevision(task, command.expectedRevision);
    if (!task.trashedAt) throw new Error("task_not_in_recycle_bin");
    if (new Set(command.artifactIds).size !== command.artifactIds.length) {
      throw new Error("task_permanent_delete_artifact_ids_duplicate");
    }
    const allArtifacts = this.#repositories.artifact.listArtifactsForTask(task.taskId);
    const artifactsById = new Map(allArtifacts.map((artifact) => [artifact.artifactId, artifact] as const));
    const selectedArtifacts = command.artifactIds.map((artifactId) => {
      const artifact = artifactsById.get(artifactId);
      if (!artifact) throw new Error("task_permanent_delete_artifact_not_registered");
      return artifact;
    });
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const intent = this.#repositories.retention.preparePermanentDelete({
      commandId: command.commandId,
      taskId: task.taskId,
      expectedRevision: task.revision,
      artifactIds: [...command.artifactIds],
      payloadFingerprint,
      preparedAt: this.#now(),
    });
    // A recovery retry is bound to the already persisted selection, never a
    // fresh renderer list. That intent was stored before the Host effect.
    const intentArtifacts = intent.artifactIds.map((artifactId) => {
      const artifact = artifactsById.get(artifactId) ?? this.#repositories.artifact.getArtifact(artifactId);
      if (!artifact || artifact.taskId !== task.taskId) throw new Error("task_permanent_delete_artifact_not_registered");
      return artifact;
    });
    const deleted = await this.#managedArtifactPort.deleteArtifacts({
      commandId: command.commandId,
      architecture,
      artifacts: intentArtifacts,
    });
    const permanentDelete: TaskPermanentDeleteResult = {
      taskId: task.taskId,
      deletedArtifactIds: deleted.deletedArtifactIds,
      skippedArtifacts: deleted.skippedArtifacts,
      deletedAt: this.#now(),
    };
    const committed = this.#repositories.retention.completePermanentDelete({
      commandId: command.commandId,
      taskId: task.taskId,
      payloadFingerprint,
      result: permanentDelete,
    });
    this.#invalidate(["task_changed", "artifact_changed"], task.taskId, undefined, command.commandId);
    return { permanentDelete: committed.result };
  }

  async #openPresentation(command: Extract<RuntimeCommand, { type: "presentation.open" }>): Promise<CommandOutcome> {
    const task = required(this.#repositories.templateTask.getTask(command.taskId), "task_not_found");
    const binding = required(this.#repositories.binding.getBinding(command.bindingId), "binding_not_found");
    if (binding.taskId !== task.taskId) throw new Error("presentation_binding_task_mismatch");
    const now = this.#now();
    const provider = this.#providers.get(binding.provider);
    let presentation: SessionPresentation;
    if (!provider?.openPresentation) {
      presentation = workspacePresentation(binding.bindingId, now);
    } else {
      const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
      const profile = required(profileForBinding(binding, architecture), "binding_execution_profile_not_found");
      const session = required(this.#repositories.binding.getLogicalSession(binding.logicalSessionId), "binding_logical_session_not_found");
      const bootstrap = compileProviderSessionBootstrap({ architecture, session });
      try {
        presentation = await provider.openPresentation({
          bindingId: binding.bindingId,
          bindingRevision: binding.bindingRevision,
          executionProfile: profile,
          workspace: architecture.workspace,
          bootstrap,
          commandId: command.commandId,
        });
      } catch (error) {
        presentation = unavailablePresentation(binding.bindingId, error, now);
      }
    }
    if (presentation.bindingId !== binding.bindingId) throw new Error("presentation_binding_mismatch");
    this.#repositories.presentation.savePresentation(presentation);
    this.#invalidate(["presentation_changed"], task.taskId, binding.runId, command.commandId);
    return { task, presentation };
  }

  #releasePresentation(command: Extract<RuntimeCommand, { type: "presentation.release" }>): CommandOutcome {
    const presentation = this.#repositories.presentation.revokePresentation(command.presentationLeaseId, this.#now());
    const binding = required(this.#repositories.binding.getBinding(presentation.bindingId), "presentation_binding_not_found");
    this.#invalidate(["presentation_changed"], binding.taskId, binding.runId, command.commandId);
    return {};
  }

  async #dispatchOutbox(outbox: OutboxRecord): Promise<void> {
    const now = this.#now();
    const bindingId = required(outbox.bindingId, "outbox_binding_required");
    const binding = required(this.#repositories.binding.getBinding(bindingId), "binding_not_found");
    const architecture = required(this.#repositories.templateTask.getArchitectureSnapshot(binding.taskId), "task_architecture_not_found");
    const profile = required(profileForBinding(binding, architecture), "binding_execution_profile_not_found");
    const session = required(this.#repositories.binding.getLogicalSession(binding.logicalSessionId), "binding_logical_session_not_found");
    const bootstrap = compileProviderSessionBootstrap({ architecture, session });
    const provider = this.#providers.get(binding.provider);
    if (!provider) {
      this.#repositories.invocation.settleOutbox(outbox.outboxId, "unknown", { reason: "provider_unavailable" });
      return;
    }
    if (outbox.kind === "release_binding") {
      try {
        await provider.releaseBinding({
          bindingId: binding.bindingId,
          bindingRevision: binding.bindingRevision,
          ...(binding.nativeBindingRef ? { nativeBindingRef: binding.nativeBindingRef } : {}),
          executionProfile: profile,
          workspace: architecture.workspace,
          bootstrap,
          commandId: outbox.commandId,
          idempotencyKey: requiredJsonString(outbox.payload.idempotencyKey, "outbox_idempotency_key_required"),
        });
        this.#repositories.transaction(() => {
          this.#repositories.invocation.settleOutbox(outbox.outboxId, "effect_accepted", {
            kind: "release_binding",
            acceptance: "accepted",
            acceptedAt: now,
          });
          const currentBinding = required(this.#repositories.binding.getBinding(binding.bindingId), "binding_not_found");
          const releasedBinding = completeBindingRelease(currentBinding, now);
          if (!sameJson(currentBinding, releasedBinding)) this.#repositories.binding.updateBinding(releasedBinding);
          const currentTask = this.#repositories.templateTask.getTask(binding.taskId);
          const currentRun = this.#repositories.templateTask.getRun(binding.runId);
          if (currentTask?.status === "stopping") {
            const logicalSession = this.#repositories.binding.getLogicalSession(binding.logicalSessionId);
            if (logicalSession && logicalSession.status !== "stopped") {
              this.#repositories.binding.updateLogicalSession({ ...logicalSession, status: "stopped", updatedAt: now });
            }
            if (currentRun && this.#allRunBindingsTerminal(currentRun.runId)) {
              const terminal = recordTaskRunTerminal({ task: currentTask, run: currentRun, outcome: "stopped", now });
              this.#repositories.templateTask.updateTask(terminal.task, currentTask.revision);
              this.#repositories.templateTask.updateRun(terminal.run);
            }
          }
        });
        this.#invalidate(["task_changed", "run_changed"], binding.taskId, binding.runId, outbox.commandId);
      } catch (error) {
        this.#repositories.invocation.settleOutbox(outbox.outboxId, "unknown", {
          kind: "release_binding",
          acceptance: "unknown",
          acceptedAt: now,
          diagnostic: error instanceof Error ? error.message : "provider_transport_error",
        });
      }
      return;
    }
    let effect: ProviderEffect;
    try {
      effect = await invokeProviderEffect(provider, outbox, binding, profile, architecture.workspace, bootstrap);
    } catch (error) {
      effect = {
        effectId: `effect_error_${outbox.outboxId}`,
        kind: outbox.kind,
        provider: binding.provider,
        bindingId: binding.bindingId,
        acceptance: "unknown",
        acceptedAt: now,
        diagnostic: error instanceof Error ? error.message : "provider_transport_error",
      };
    }
    const effectJson = {
      effectId: effect.effectId, kind: effect.kind, provider: effect.provider, acceptance: effect.acceptance,
      ...(effect.bindingId ? { bindingId: effect.bindingId } : {}), ...(effect.inputSubmissionId ? { inputSubmissionId: effect.inputSubmissionId } : {}),
      ...(effect.invocationId ? { invocationId: effect.invocationId } : {}), ...(effect.attentionId ? { attentionId: effect.attentionId } : {}),
      acceptedAt: effect.acceptedAt, ...(effect.diagnostic ? { diagnostic: effect.diagnostic } : {}),
    };
    this.#repositories.invocation.settleOutbox(outbox.outboxId, effect.acceptance === "accepted" ? "effect_accepted" : effect.acceptance === "rejected" ? "effect_rejected" : "unknown", effectJson);
    const reasons = new Set<RuntimeInvalidationReason>();
    const changedBinding = effect.kind === "ensure_binding" ? recordEnsureBindingEffect(binding, effect, now) : binding;
    if (!sameJson(binding, changedBinding)) {
      this.#repositories.binding.updateBinding(changedBinding);
      reasons.add("run_changed");
    }
    if (effect.kind === "submit_delivery") {
      const inputSubmissionId = outbox.payload.inputSubmissionId;
      if (typeof inputSubmissionId === "string") {
        const input = this.#repositories.invocation.getInput(inputSubmissionId);
        if (input) {
          const changedInput = recordDeliveryEffect(input, effect, now);
          if (!sameJson(input, changedInput)) {
            this.#repositories.invocation.updateInput(changedInput);
            const inbox = this.#repositories.inbox.getInboxItem(input.sourceInboxItemId);
            if (inbox) {
              const changedInbox = settleSessionInboxFromInput(inbox, changedInput, now);
              if (!sameJson(inbox, changedInbox)) this.#repositories.inbox.updateInboxItem(changedInbox, inbox.revision);
            }
          }
          reasons.add("input_changed");
        }
      }
      const invocationId = outbox.payload.invocationId;
      if (typeof invocationId === "string") {
        const invocation = this.#repositories.invocation.getInvocation(invocationId);
        if (invocation) {
          const changedInvocation = recordInvocationDeliveryEffect(invocation, effect, now);
          if (!sameJson(invocation, changedInvocation)) this.#repositories.invocation.updateInvocation(changedInvocation);
          reasons.add("invocation_changed");
        }
      }
    }
    if (effect.kind === "respond_attention") {
      const attentionId = outbox.payload.attentionId;
      if (typeof attentionId === "string") {
        const attention = this.#repositories.invocation.getAttention(attentionId);
        if (attention) {
          const changedAttention = recordAttentionResponseEffect(attention, effect, now);
          if (!sameJson(attention, changedAttention)) this.#repositories.invocation.updateAttention(changedAttention);
          reasons.add("attention_changed");
        }
      }
    }
    const run = this.#repositories.templateTask.getRun(binding.runId);
    if (run && run.status === "starting" && changedBinding.status === "active") {
      const active = markTaskRunRunning(run);
      this.#repositories.templateTask.updateRun(active);
      reasons.add("run_changed");
    }
    if (reasons.size > 0) this.#invalidate([...reasons], binding.taskId, binding.runId);
  }

  async #stageInboxDeliveries(maxItems = 100): Promise<boolean> {
    let stagedCount = 0;
    for (const task of this.#repositories.templateTask.listTasks()) {
      if (stagedCount >= maxItems || !task.activeRunId || task.status !== "running") continue;
      const run = this.#repositories.templateTask.getRun(task.activeRunId);
      if (!run || run.status !== "running") continue;
      for (const original of this.#repositories.inbox.listInboxItems(run.runId)) {
        if (stagedCount >= maxItems) break;
        let inbox = original;
        const now = this.#now();
        const recovered = recoverExpiredInboxLease(inbox, now);
        if (!sameJson(recovered, inbox)) {
          this.#repositories.inbox.updateInboxItem(recovered, inbox.revision);
          inbox = recovered;
        }
        if (inbox.state !== "pending") continue;
        const binding = this.#repositories.binding.findBindingForLogicalSession(inbox.targetLogicalSessionId);
        if (!binding || binding.status !== "active") continue;
        const existingInputs = this.#repositories.invocation.listInputs(run.runId)
          .filter((input) => input.bindingId === binding.bindingId);
        if (existingInputs.some((input) => ["staged", "effect_accepted", "provider_received", "turn_active", "ambiguous"].includes(input.status))) {
          continue;
        }
        if (this.#repositories.invocation.listAttentions(run.runId)
          .some((attention) => attention.bindingId === binding.bindingId && attention.status !== "resolved")) {
          continue;
        }
        const leaseId = `lease:${inbox.inboxItemId}:${inbox.revision}`;
        const claimed = this.#repositories.inbox.claimInboxItem({
          inboxItemId: inbox.inboxItemId,
          expectedRevision: inbox.revision,
          leaseId,
          leaseExpiresAt: new Date(Date.parse(now) + this.#outboxLeaseMs).toISOString(),
          now,
        });
        const message = required(this.#repositories.message.getMessage(claimed.renderedMessageId), "session_inbox_rendered_message_not_found");
        const session = required(this.#repositories.binding.getLogicalSession(claimed.targetLogicalSessionId), "session_inbox_target_not_found");
        const inputSubmissionId = createId("input");
        const input = stageInputSubmission({
          inputSubmissionId,
          sourceInboxItemId: claimed.inboxItemId,
          taskId: task.taskId,
          runId: run.runId,
          logicalSessionId: session.logicalSessionId,
          bindingId: binding.bindingId,
          contentMessageId: message.messageId,
          content: renderInboxDelivery(claimed, message),
          sequenceNumber: existingInputs.length + 1,
          idempotencyKey: `delivery:${claimed.inboxItemId}`,
          now,
        }, existingInputs);
        const provenance = turnProvenance(message, claimed, session.kind, run.conductorLogicalSessionId, this.#repositories);
        const turn = createSessionTurn({
          sessionTurnId: createId("session_turn"),
          taskId: task.taskId,
          runId: run.runId,
          inputSubmissionId: input.inputSubmissionId,
          targetLogicalSessionId: session.logicalSessionId,
          kind: session.kind === "conductor" ? "conductor" : "session_agent",
          initiator: provenance.initiator,
          trigger: provenance.trigger,
          conductorLogicalSessionId: run.conductorLogicalSessionId,
          ...(claimed.replyToLogicalSessionId ? { replyToLogicalSessionId: claimed.replyToLogicalSessionId } : {}),
          ...(provenance.invocationId ? { invocationId: provenance.invocationId } : {}),
          ...(claimed.humanInterventionId ? { humanInterventionId: claimed.humanInterventionId } : {}),
          ...(provenance.affectedSessionTurnId ? { affectedSessionTurnId: provenance.affectedSessionTurnId } : {}),
          now,
        });
        const stagedInbox = stageSessionInboxDelivery(claimed, { leaseId, inputSubmissionId, now });
        const deliveryCommandId = `delivery:${claimed.inboxItemId}`;
        this.#repositories.transaction(() => {
          this.#repositories.invocation.createInput(input, deliveryCommandId);
          this.#repositories.turn.createTurn(turn);
          this.#repositories.inbox.updateInboxItem(stagedInbox, claimed.revision);
          this.#repositories.invocation.enqueue(newOutbox({
            commandId: deliveryCommandId,
            provider: binding.provider,
            kind: "submit_delivery",
            bindingId: binding.bindingId,
            payload: {
              inputSubmissionId: input.inputSubmissionId,
              sessionTurnId: turn.sessionTurnId,
              invocationId: turn.invocationId ?? null,
              content: input.content,
              idempotencyKey: input.idempotencyKey,
            },
            now,
          }));
        });
        stagedCount += 1;
      }
    }
    return stagedCount > 0;
  }

  #materializeSessionTurnReturn(
    turn: SessionTurnRecord,
    facts: readonly ProviderFact[],
    run: TaskRunRecord,
    now: string,
    turnIndex: SessionTurnCorrelationIndex,
  ): boolean {
    if (turn.finalMessageId) return false;
    const content = resolveSessionTurnFinalContent(turn, facts, turnIndex);
    if (!content) return false;
    const message = createSessionMessage({
      messageId: createId("message"),
      taskId: turn.taskId,
      runId: turn.runId,
      sourceLogicalSessionId: turn.targetLogicalSessionId,
      sourceSessionTurnId: turn.sessionTurnId,
      ...(turn.humanInterventionId ? { sourceHumanInterventionId: turn.humanInterventionId } : {}),
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
      kind: "agent_final",
      content,
      createdAt: now,
    });
    const relayBlocks = extractRelayBlocks({ message });
    const returnedTurn = recordSessionTurnFinalMessage(turn, message, now);
    const invocation = turn.invocationId ? this.#repositories.invocation.getInvocation(turn.invocationId) : undefined;
    const returnedInvocation = invocation ? recordInvocationFinalMessage(invocation, message, now) : undefined;
    const conductorInbox = turn.kind === "session_agent" ? createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: turn.taskId,
      runId: turn.runId,
      targetLogicalSessionId: run.conductorLogicalSessionId,
      renderedMessageId: message.messageId,
      createdAt: now,
    }) : undefined;
    this.#repositories.transaction(() => {
      this.#repositories.message.createMessage(message);
      for (const relayBlock of relayBlocks) this.#repositories.message.createRelayBlock(relayBlock);
      this.#repositories.turn.updateTurn(returnedTurn);
      if (returnedInvocation) this.#repositories.invocation.updateInvocation(returnedInvocation);
      if (conductorInbox) this.#repositories.inbox.createInboxItem(conductorInbox);
    });
    return true;
  }

  #materializeSessionTurnFailureNotice(turn: SessionTurnRecord, run: TaskRunRecord, now: string): boolean {
    if (
      turn.kind !== "session_agent"
      || turn.finalMessageId
      || !(turn.status === "failed" || (["interrupted", "cancelled"].includes(turn.status) && turn.invocationId))
    ) return false;
    const existing = this.#repositories.message.listMessagesFromSession(turn.targetLogicalSessionId)
      .some((message) => message.kind === "runtime_notice" && message.sourceSessionTurnId === turn.sessionTurnId);
    if (existing) return false;
    const notice = createSessionMessage({
      messageId: createId("message"),
      taskId: turn.taskId,
      runId: turn.runId,
      sourceLogicalSessionId: turn.targetLogicalSessionId,
      sourceSessionTurnId: turn.sessionTurnId,
      ...(turn.humanInterventionId ? { sourceHumanInterventionId: turn.humanInterventionId } : {}),
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
      kind: "runtime_notice",
      content: `Session Turn ${turn.sessionTurnId} ended without a recoverable complete final message.`,
      createdAt: now,
    });
    const inbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: turn.taskId,
      runId: turn.runId,
      targetLogicalSessionId: run.conductorLogicalSessionId,
      renderedMessageId: notice.messageId,
      createdAt: now,
    });
    this.#repositories.transaction(() => {
      this.#repositories.message.createMessage(notice);
      this.#repositories.inbox.createInboxItem(inbox);
    });
    return true;
  }

  #invalidate(reasons: readonly RuntimeInvalidationReason[], taskId?: string, runId?: string, commandId?: string): void {
    const event: RuntimeInvalidation = {
      type: "runtime.invalidated", sequence: ++this.#invalidationSequence, occurredAt: this.#now(), reasons,
      ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}), ...(commandId ? { commandId } : {}),
    };
    for (const listener of this.#listeners) listener(event);
  }

  async #assertProfilesAvailable(profiles: readonly ExecutionProfileDefinition[]): Promise<void> {
    const before = JSON.stringify(profiles.map((profile) => this.#providers.readiness(profile)));
    try {
      for (const profile of profiles) await assertProviderProfileAvailable(this.#providers, profile);
    } finally {
      const after = JSON.stringify(profiles.map((profile) => this.#providers.readiness(profile)));
      if (before !== after) this.#invalidate(["configuration_changed"]);
    }
  }

  async #assertBindingsInterruptAvailable(
    bindings: readonly ProviderSessionBindingRecord[],
    architecture: { readonly definition: { readonly executionProfiles: readonly ExecutionProfileDefinition[] } },
  ): Promise<void> {
    for (const binding of bindings) {
      const profile = required(profileForBinding(binding, architecture), "binding_execution_profile_not_found");
      const provider = this.#providers.get(binding.provider);
      if (!provider) throw new Error(`task_stop_provider_unavailable:${binding.provider}`);
      const report = await provider.describeCapabilities(profile);
      if (!report.available || !report.capabilities.includes("interrupt")) {
        throw new Error(`task_stop_interrupt_unavailable:${binding.bindingId}`);
      }
    }
  }

  #assertRunAcceptsNewWork(task: TaskRecord, run: TaskRunRecord): void {
    assertTaskNotTrashed(task);
    if (task.activeRunId !== run.runId || task.status !== "running" || run.status !== "running") {
      throw new Error("task_run_not_accepting_new_work");
    }
  }

  #requireCompleteStopBindingSet(
    requestedBindingIds: readonly string[],
    runBindings: readonly ProviderSessionBindingRecord[],
  ): readonly ProviderSessionBindingRecord[] {
    const liveBindings = runBindings.filter((binding) => binding.status !== "released" && binding.status !== "unrecoverable");
    if (liveBindings.length === 0) throw new Error("task_stop_no_live_binding");
    const requested = new Set(requestedBindingIds);
    if (requested.size !== requestedBindingIds.length) throw new Error("task_stop_binding_ids_duplicate");
    if (requested.size === 0 || requested.size !== liveBindings.length || liveBindings.some((binding) => !requested.has(binding.bindingId))) {
      throw new Error("task_stop_bindings_incomplete");
    }
    if (liveBindings.some((binding) => binding.status !== "active" || !binding.nativeBindingRef)) {
      throw new Error("task_stop_binding_not_ready");
    }
    return liveBindings;
  }

  #allRunBindingsTerminal(runId: string): boolean {
    const bindings = this.#repositories.binding.listBindings(runId);
    return bindings.length > 0 && bindings.every((binding) => binding.status === "released" || binding.status === "unrecoverable");
  }

  #bindingRequiresInterrupt(binding: ProviderSessionBindingRecord, runId: string): boolean {
    const hasActiveTurn = this.#repositories.turn.listTurns(runId).some((turn) => {
      if (!isSessionTurnActive(turn)) return false;
      const input = this.#repositories.invocation.getInput(turn.inputSubmissionId);
      return input?.bindingId === binding.bindingId;
    });
    if (hasActiveTurn) return true;
    return this.#repositories.invocation.listAttentions(runId).some((attention) =>
      attention.bindingId === binding.bindingId
      && ["requested", "response_staged", "effect_accepted"].includes(attention.status));
  }

  #recoverIdleStoppingBindings(): boolean {
    let recovered = false;
    for (const task of this.#repositories.templateTask.listTasks()) {
      if (task.status !== "stopping" || !task.activeRunId) continue;
      const run = this.#repositories.templateTask.getRun(task.activeRunId);
      if (!run || run.status !== "stopping") continue;
      let recoveredForRun = false;
      for (const binding of this.#repositories.binding.listBindings(run.runId)) {
        if (binding.status !== "active" || this.#bindingRequiresInterrupt(binding, run.runId)) continue;
        const now = this.#now();
        this.#repositories.transaction(() => {
          this.#repositories.binding.updateBinding(requestBindingRelease(binding, now));
          this.#repositories.invocation.enqueue(newOutbox({
            commandId: `recover-stop:${run.runId}:${binding.bindingId}:release`,
            provider: binding.provider,
            kind: "release_binding",
            bindingId: binding.bindingId,
            payload: { idempotencyKey: `recover-stop:${run.runId}:${binding.bindingId}:release` },
            now,
          }));
        });
        recovered = true;
        recoveredForRun = true;
      }
      if (recoveredForRun) this.#invalidate(["run_changed"], task.taskId, run.runId);
    }
    return recovered;
  }

  #requireConductorDecisionTurn(
    sessionTurnId: string,
    task: TaskRecord,
    run: TaskRunRecord,
    conductorLogicalSessionId: string,
  ): SessionTurnRecord {
    const turn = required(this.#repositories.turn.getTurn(sessionTurnId), "message_forward_decision_turn_not_found");
    if (
      turn.taskId !== task.taskId
      || turn.runId !== run.runId
      || turn.kind !== "conductor"
      || turn.targetLogicalSessionId !== conductorLogicalSessionId
    ) {
      throw new Error("message_forward_decision_turn_scope_mismatch");
    }
    return turn;
  }

  #resolveMessageSelections(
    selections: readonly MessageSelection[],
    taskId: string,
    runId: string,
  ): readonly ResolvedMessageSelection[] {
    return selections.map((selection) => {
      const message = required(this.#repositories.message.getMessage(selection.sourceMessageId), "message_selection_source_not_found");
      if (message.taskId !== taskId || message.runId !== runId) throw new Error("message_selection_scope_mismatch");
      if (selection.kind === "full_message") return { kind: "full_message" as const, message };
      const relayBlock = required(this.#repositories.message.getRelayBlock(selection.relayBlockId), "message_selection_relay_not_found");
      if (relayBlock.sourceMessageId !== message.messageId) throw new Error("message_selection_relay_source_mismatch");
      return { kind: "relay_block" as const, relayBlock };
    });
  }

  async #prepareCardSession(
    task: TaskRecord,
    run: TaskRunRecord,
    architecture: NonNullable<ReturnType<RuntimeRepositories["templateTask"]["getArchitectureSnapshot"]>>,
    agentCardId: string,
    commandId: string,
    now: string,
    createdSessionOrdinal?: number,
  ): Promise<PreparedCardSession> {
    let session = this.#repositories.binding.findLogicalSession(run.runId, agentCardId);
    const createdSession = !session;
    if (!session) {
      session = createCardLogicalSession({
        architecture,
        runId: run.runId,
        logicalSessionId: createId("logical_session"),
        agentCardId,
        ordinal: createdSessionOrdinal ?? this.#repositories.binding.listLogicalSessions(run.runId).length + 1,
        now,
      });
    }
    const profile = profileForSession(session, architecture);
    await this.#assertProfilesAvailable([profile]);
    let binding = this.#repositories.binding.findBindingForLogicalSession(session.logicalSessionId);
    const createdBinding = !binding;
    if (!binding) {
      binding = createProviderSessionBinding({
        bindingId: createId("binding"),
        taskId: task.taskId,
        runId: run.runId,
        logicalSessionId: session.logicalSessionId,
        executionProfileId: session.executionProfileId,
        provider: profile.provider,
        now,
      });
    }
    return {
      session,
      binding,
      createdSession,
      createdBinding,
      ensureBindingOutbox: createdBinding ? newOutbox({
        commandId: `${commandId}:${binding.bindingId}`,
        provider: binding.provider,
        kind: "ensure_binding",
        bindingId: binding.bindingId,
        payload: { bindingId: binding.bindingId },
        now,
      }) : undefined,
    };
  }

  #persistPreparedCardSession(prepared: PreparedCardSession): void {
    if (prepared.createdSession) this.#repositories.binding.createLogicalSession(prepared.session);
    if (prepared.createdBinding) this.#repositories.binding.createBinding(prepared.binding);
    if (prepared.ensureBindingOutbox) this.#repositories.invocation.enqueue(prepared.ensureBindingOutbox);
  }

  #materializeHumanInterventionMessages(
    intervention: HumanInterventionRecord,
    run: TaskRunRecord,
    now: string,
  ): boolean {
    if (intervention.state !== "ready_to_send") return false;
    const cardMessage = createSessionMessage({
      messageId: createId("message"),
      taskId: intervention.taskId,
      runId: intervention.runId,
      sourceHumanInterventionId: intervention.humanInterventionId,
      kind: "user_input",
      content: intervention.content,
      createdAt: now,
    });
    const mirrorMessage = createSessionMessage({
      messageId: createId("message"),
      taskId: intervention.taskId,
      runId: intervention.runId,
      sourceHumanInterventionId: intervention.humanInterventionId,
      kind: "user_input",
      content: [
        `# Human Intervention ${intervention.humanInterventionId}`,
        `Target: ${intervention.targetLogicalSessionId}`,
        `Mode: ${intervention.mode}`,
        `Created: ${intervention.createdAt}`,
        "",
        intervention.content,
      ].join("\n"),
      createdAt: now,
    });
    const cardInbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: intervention.taskId,
      runId: intervention.runId,
      targetLogicalSessionId: intervention.targetLogicalSessionId,
      renderedMessageId: cardMessage.messageId,
      humanInterventionId: intervention.humanInterventionId,
      replyToLogicalSessionId: run.conductorLogicalSessionId,
      createdAt: now,
    });
    const mirrorInbox = createSessionInboxItem({
      inboxItemId: createId("inbox"),
      taskId: intervention.taskId,
      runId: intervention.runId,
      targetLogicalSessionId: run.conductorLogicalSessionId,
      renderedMessageId: mirrorMessage.messageId,
      humanInterventionId: intervention.humanInterventionId,
      createdAt: now,
    });
    const sent = markHumanInterventionSent(intervention, {
      cardMessageId: cardMessage.messageId,
      conductorMirrorMessageId: mirrorMessage.messageId,
      now,
    });
    this.#repositories.transaction(() => {
      this.#repositories.message.createMessage(cardMessage);
      this.#repositories.message.createMessage(mirrorMessage);
      this.#repositories.inbox.createInboxItem(cardInbox);
      this.#repositories.inbox.createInboxItem(mirrorInbox);
      this.#repositories.humanIntervention.updateIntervention(sent);
    });
    return true;
  }
}

function assertForwardReplay(
  forward: MessageForwardRecord,
  expected: Readonly<{
    commandId: string;
    expectedTaskRevision: number;
    decidedByLogicalSessionId: string;
    decidedBySessionTurnId: string;
    targetLogicalSessionId: string;
    mode: MessageForwardRecord["mode"];
    selectionDigest: string;
  }>,
): void {
  if (
    forward.commandId !== expected.commandId
    || forward.expectedTaskRevision !== expected.expectedTaskRevision
    || forward.decidedByLogicalSessionId !== expected.decidedByLogicalSessionId
    || forward.decidedBySessionTurnId !== expected.decidedBySessionTurnId
    || forward.targetLogicalSessionId !== expected.targetLogicalSessionId
    || forward.mode !== expected.mode
    || forwardSelectionDigest(forward) !== expected.selectionDigest
  ) throw new Error("message_forward_idempotency_conflict");
}

function resolvedSelectionDigest(selections: readonly ResolvedMessageSelection[]): string {
  return hashDefinition(selections.map((selection) => selection.kind === "full_message"
    ? {
        kind: selection.kind,
        sourceMessageId: selection.message.messageId,
        contentDigest: selection.message.contentDigest,
      }
    : {
        kind: selection.kind,
        sourceMessageId: selection.relayBlock.sourceMessageId,
        relayBlockId: selection.relayBlock.relayBlockId,
        contentDigest: selection.relayBlock.contentDigest,
      }) as unknown as JsonValue);
}

function forwardSelectionDigest(forward: MessageForwardRecord): string {
  return hashDefinition(forward.selections.map((selection) => selection.kind === "full_message"
    ? {
        kind: selection.kind,
        sourceMessageId: selection.sourceMessageId,
        contentDigest: selection.contentDigest,
      }
    : {
        kind: selection.kind,
        sourceMessageId: selection.sourceMessageId,
        relayBlockId: selection.relayBlockId,
        contentDigest: selection.contentDigest,
      }) as unknown as JsonValue);
}

type CommandOutcome = {
  readonly task?: TaskRecord;
  readonly run?: TaskRunRecord;
  readonly taskSetupDraft?: TaskSetupDraftRecord;
  readonly metaSession?: MetaSessionRecord;
  readonly metaMessage?: MetaMessageRecord;
  readonly metaPatchProposal?: MetaPatchProposalRecord;
  readonly template?: TemplateRecord;
  readonly templatePackage?: TemplatePackage;
  readonly templateAssets?: readonly TemplateAssetTransport[];
  readonly presentation?: SessionPresentation;
  readonly artifactPreview?: ArtifactPreviewReadModel;
  readonly artifactId?: string;
  readonly permanentDeletePreview?: TaskPermanentDeletePreview;
  readonly permanentDelete?: TaskPermanentDeleteResult;
};

function assertRequestedArtifactRecord(
  artifact: ArtifactReference,
  expected: Readonly<{
    artifactId: string;
    taskId: string;
    runId: string;
    workspaceRelativePath: string;
    sourceInvocationId: string;
    sourceMessageId: string;
  }>,
): void {
  if (
    artifact.artifactId !== expected.artifactId
    || artifact.taskId !== expected.taskId
    || artifact.runId !== expected.runId
    || artifact.workspaceRelativePath !== expected.workspaceRelativePath
    || artifact.sourceInvocationId !== expected.sourceInvocationId
    || artifact.sourceMessageId !== expected.sourceMessageId
    || artifact.sourceProviderFactId !== undefined
    || artifact.evidenceReferenceIds.length !== 0
    || !/^sha256:[0-9a-f]{64}$/.test(artifact.contentDigest)
    || !artifact.verifiedAt
  ) {
    throw new Error("artifact_verification_result_mismatch");
  }
}

type PreparedCardSession = Readonly<{
  session: ReturnType<typeof createCardLogicalSession>;
  binding: ProviderSessionBindingRecord;
  createdSession: boolean;
  createdBinding: boolean;
  ensureBindingOutbox?: OutboxRecord;
}>;

function turnProvenance(
  message: SessionMessageRecord,
  inbox: SessionInboxItemRecord,
  targetKind: "conductor" | "card",
  conductorLogicalSessionId: string,
  repositories: RuntimeRepositories,
): Readonly<{
  initiator: SessionTurnRecord["initiator"];
  trigger: SessionTurnRecord["trigger"];
  invocationId?: string;
  affectedSessionTurnId?: string;
}> {
  if (message.kind === "task_goal") return { initiator: "runtime", trigger: "task_goal" };
  if (message.kind === "agent_assignment") {
    return {
      initiator: "conductor",
      trigger: "conductor_invocation",
      invocationId: required(message.invocationId, "assignment_invocation_id_required"),
    };
  }
  if (message.kind === "relay_forward") return { initiator: "conductor", trigger: "conductor_relay" };
  if (message.kind === "publish_forward") return { initiator: "conductor", trigger: "conductor_publish" };
  if (message.kind === "agent_final") {
    if (targetKind !== "conductor" || inbox.targetLogicalSessionId !== conductorLogicalSessionId) {
      throw new Error("agent_final_inbox_target_must_be_conductor");
    }
    return { initiator: "session_agent", trigger: "session_agent_return" };
  }
  if (message.kind === "runtime_notice") return { initiator: "runtime", trigger: "runtime_recovery" };
  if (message.kind === "user_input") {
    const intervention = inbox.humanInterventionId
      ? repositories.humanIntervention.getIntervention(inbox.humanInterventionId)
      : undefined;
    return {
      initiator: "human",
      trigger: intervention?.mode === "interrupt_then_send" ? "human_interrupt_then_send" : "human_direct",
      ...(intervention?.affectedSessionTurnId ? { affectedSessionTurnId: intervention.affectedSessionTurnId } : {}),
    };
  }
  throw new Error("session_turn_message_kind_unsupported");
}

function metaSystemInstructions(mode: MetaSessionRecord["mode"]): string {
  const allowed = mode === "template_design"
    ? "template_metadata_set, template_conductor_prompt_set, template_card_prompt_set, template_profile_model_set, template_card_profile_set, template_deliverable_upsert"
    : "task_setup_title_set, task_setup_goal_set, task_setup_input_set";
  return [
    "You are the configuration-only Meta Agent for Agent WorkSpace.",
    "You may reason only over the supplied configuration context and Meta conversation.",
    "Never use tools, files, networks, credentials, Task transcripts, routing, lifecycle commands, or native child agents.",
    "Never publish a Template, create or start a Task, or claim that a patch was applied.",
    `The current mode is ${mode}. Allowed patch operation kinds: ${allowed}.`,
    "Return exactly one JSON object matching the supplied output schema; do not use Markdown fences or any text outside the JSON object.",
    "A proposal remains pending until the authenticated user explicitly applies it.",
  ].join("\n");
}

function safeMetaFailureCode(value: unknown, fallback: string): string {
  const candidate = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const normalized = candidate.trim().slice(0, 160);
  return /^(?:meta|task_setup|template|runtime|provider)_[a-z0-9_:.-]+$/.test(normalized)
    ? normalized
    : fallback;
}

function commandTaskId(command: RuntimeCommand): string | undefined {
  return "taskId" in command ? command.taskId : undefined;
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

function assertTaskRevision(task: TaskRecord, expectedRevision: number): void {
  if (task.revision !== expectedRevision) throw new Error("expected_revision_stale");
}

function unavailableManagedArtifactPort(): ManagedArtifactPort {
  const unavailable = async (): Promise<never> => {
    throw new Error("managed_artifact_port_unavailable");
  };
  return {
    verifyArtifact: unavailable,
    previewArtifact: unavailable,
    previewPermanentDelete: unavailable,
    deleteArtifacts: unavailable,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function settleWithin(promises: readonly Promise<void>[], timeoutMs: number): Promise<void> {
  if (promises.length === 0) return;
  await new Promise<void>((resolve) => {
    let remaining = promises.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    timeout.unref();
    for (const promise of promises) {
      void promise.then(() => {
        remaining -= 1;
        if (remaining === 0) finish();
      });
    }
  });
}

function profileForSession(session: { executionProfileId: string }, architecture: { definition: { executionProfiles: readonly ExecutionProfileDefinition[] } }): ExecutionProfileDefinition {
  return required(architecture.definition.executionProfiles.find((profile) => profile.executionProfileId === session.executionProfileId), "execution_profile_not_found");
}

function profileForBinding(binding: ProviderSessionBindingRecord, architecture: { definition: { executionProfiles: readonly ExecutionProfileDefinition[] } } | undefined): ExecutionProfileDefinition | undefined {
  return architecture?.definition.executionProfiles.find((profile) => profile.executionProfileId === binding.executionProfileId);
}

function newOutbox(input: {
  readonly commandId: string;
  readonly provider: string;
  readonly kind: OutboxRecord["kind"];
  readonly bindingId: string;
  readonly payload: Record<string, unknown>;
  readonly now: string;
}): OutboxRecord {
  return {
    outboxId: createId("command"), commandId: input.commandId, provider: input.provider, kind: input.kind,
    bindingId: input.bindingId, payload: input.payload as never, state: "pending", attempts: 0,
    createdAt: input.now, updatedAt: input.now,
  };
}

async function invokeProviderEffect(provider: ProviderPort, outbox: OutboxRecord, binding: ProviderSessionBindingRecord, profile: ExecutionProfileDefinition, workspace: { readonly workspaceId: string; readonly cwd: string }, bootstrap: ProviderSessionBootstrap): Promise<ProviderEffect> {
  const base = {
    bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision,
    ...(binding.nativeBindingRef ? { nativeBindingRef: binding.nativeBindingRef } : {}),
    executionProfile: profile,
    workspace,
    bootstrap,
    commandId: outbox.commandId,
  };
  if (outbox.kind === "ensure_binding") {
    return provider.ensureBinding({ ...base, idempotencyKey: outbox.commandId, disposition: binding.nativeBindingRef ? "resume" : "create" });
  }
  if (outbox.kind === "submit_delivery") {
    const inputSubmissionId = requiredJsonString(outbox.payload.inputSubmissionId, "outbox_input_required");
    const content = requiredJsonString(outbox.payload.content, "outbox_content_required");
    const idempotencyKey = requiredJsonString(outbox.payload.idempotencyKey, "outbox_idempotency_key_required");
    const invocationId = optionalJsonString(outbox.payload.invocationId);
    return provider.submitDelivery({ ...base, inputSubmissionId, content, idempotencyKey, ...(invocationId ? { invocationId } : {}) });
  }
  if (outbox.kind === "request_interrupt") {
    const idempotencyKey = requiredJsonString(outbox.payload.idempotencyKey, "outbox_idempotency_key_required");
    const invocationId = optionalJsonString(outbox.payload.invocationId);
    return provider.requestInterrupt({ ...base, idempotencyKey, ...(invocationId ? { invocationId } : {}) });
  }
  const attentionId = requiredJsonString(outbox.payload.attentionId, "outbox_attention_required");
  const attention = requiredJsonString(outbox.payload.nativeRequestId, "outbox_native_request_required");
  const stored = requiredJsonObject(outbox.payload.response, "outbox_attention_response_required");
  if (!provider.respondAttention) throw new Error("provider_attention_reply_unavailable");
  return provider.respondAttention({
    ...base, attentionId, nativeRequestId: attention, response: stored,
    ...(optionalJsonString(outbox.payload.inputSubmissionId) ? { activeInputSubmissionId: optionalJsonString(outbox.payload.inputSubmissionId)! } : {}),
    ...(optionalJsonString(outbox.payload.invocationId) ? { activeInvocationId: optionalJsonString(outbox.payload.invocationId)! } : {}),
  });
}

function requiredJsonString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value) throw new Error(code);
  return value;
}

function optionalJsonString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function requiredJsonObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function workspacePresentation(bindingId: string, now: string): SessionPresentation {
  return {
    presentationLeaseId: createId("presentation"),
    bindingId,
    kind: "workspace_transcript_and_composer",
    title: "Managed session",
    expiresAt: new Date(Date.parse(now) + 60 * 60 * 1_000).toISOString(),
  };
}

function unavailablePresentation(bindingId: string, error: unknown, now: string): SessionPresentation {
  return {
    presentationLeaseId: createId("presentation"),
    bindingId,
    kind: "unavailable",
    title: "Native session presentation unavailable",
    unavailableReason: error instanceof Error ? error.message : "provider_presentation_unavailable",
    expiresAt: new Date(Date.parse(now) + 5 * 60 * 1_000).toISOString(),
  };
}
