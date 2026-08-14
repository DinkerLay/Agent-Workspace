import {
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  hashDefinition,
  validateAcpProfileReadinessObservation,
  validateSessionIdAcpTaskReadModel,
  validateTaskArchitectureSnapshotV3,
  type AcpProfileReadinessObservation,
  type AcpSafeSessionBindingRecordV3,
  type AgentCardDefinition,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ConductorPlanningFenceRecord,
  type ExecutionProfileDefinitionV3,
  type ProviderFamily,
  type ProviderActivityReadModel,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionIdAcpTaskDirectoryState,
  type SessionIdAcpTaskExecutionGroupReadModel,
  type SessionIdAcpTaskFileObservationReadModel,
  type SessionIdAcpTaskHumanDeliveryReadModel,
  type SessionIdAcpTaskInteractionReadModel,
  type SessionIdAcpTaskMessageReadModel,
  type SessionIdAcpTaskReadModel,
  type SessionIdAcpTaskSessionReadModel,
  type SessionIdAcpTaskTimelineItemReadModel,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type TaskArchitectureSnapshotV3,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceFileObservationRecord,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";

export type SessionIdAcpConductorSessionReadRecord = Readonly<{
  logicalSessionId: string;
  taskId: string;
  runId: string;
  agentCardId: string;
  executionProfileId: string;
  profileRevisionId: string;
  generation: number;
  lifecycle: "current" | "closed" | "faulted";
  createdAt: string;
  closedAt?: string;
}>;

export interface SessionIdAcpTaskReadTemplateTaskCapability {
  getTask(taskId: string): TaskRecord | undefined;
  getRun(runId: string): TaskRunRecord | undefined;
  getArchitectureSnapshot(taskId: string): unknown;
}

export interface SessionIdAcpTaskReadTaskRunCapability {
  findSlot(runId: string, agentCardId: string): CardSessionSlotRecord | undefined;
  listGenerations(cardSessionSlotId: string): readonly CardSessionGenerationRecord[];
  latestPlanningFence(runId: string): ConductorPlanningFenceRecord | undefined;
  readConductorSession(taskId: string, runId: string): SessionIdAcpConductorSessionReadRecord | undefined;
}

export interface SessionIdAcpTaskReadMessageCapability {
  listMessages(runId: string): readonly SessionIdSessionMessageRecord[];
  listForwards(runId: string): readonly SessionIdMessageForwardRecord[];
}

export interface SessionIdAcpTaskReadOrchestrationCapability {
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  findInputByInboxItem(inboxItemId: string): SessionIdInputSubmissionRecord | undefined;
  listTurns(logicalSessionId: string): readonly SessionIdSessionTurnRecord[];
  listControlAudits(runId: string, logicalSessionId?: string): readonly SessionControlAuditRecord[];
}

export interface SessionIdAcpTaskReadHumanCapability {
  list(runId: string, targetLogicalSessionId?: string): readonly SessionIdHumanInterventionRecord[];
}

export interface SessionIdAcpTaskReadWorkspaceCapability {
  listObservations(taskId: string): readonly WorkspaceFileObservationRecord[];
}

export interface SessionIdAcpTaskReadBindingCapability {
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpTaskReadExecutionCapability {
  getRuntimeForSession(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined;
  listAttempts(sessionExecutionRuntimeId: string): readonly SessionExecutionAttemptRecord[];
}

export type SessionIdAcpTaskReadCapabilities = Readonly<{
  templateTask: SessionIdAcpTaskReadTemplateTaskCapability;
  taskRun: SessionIdAcpTaskReadTaskRunCapability;
  message: SessionIdAcpTaskReadMessageCapability;
  orchestration: SessionIdAcpTaskReadOrchestrationCapability;
  humanIntervention: SessionIdAcpTaskReadHumanCapability;
  workspace: SessionIdAcpTaskReadWorkspaceCapability;
  currentBinding: SessionIdAcpTaskReadBindingCapability;
  sessionExecution: SessionIdAcpTaskReadExecutionCapability;
}>;

export type SessionIdAcpTaskReadProjectorOptions = Readonly<{
  /** Kept as a production clock capability; persisted fact times remain the projection truth. */
  now: () => string;
  snapshot: Readonly<{
    read<T>(work: (owners: SessionIdAcpTaskReadCapabilities) => T): T;
  }>;
  /** Cache lookup only. Implementations must never probe/resolve/launch from this callback. */
  readCachedProfileReadiness(scope: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    executionProfileId: string;
    profileRevisionId: string;
    providerFamily: ProviderFamily;
    acpAgentKind: ExecutionProfileDefinitionV3["acpAgentKind"];
    role: AgentCardDefinition["kind"];
    model: string;
  }>): AcpProfileReadinessObservation | undefined;
  /** Host-memory, human-only cache lookup. It may not launch or mutate Provider state. */
  readHumanOnlyActivities?: (
    sessionExecutionAttemptId: string,
  ) => readonly ProviderActivityReadModel[];
}>;

/**
 * Side-effect-free ACP Task projection. Its capability surface contains no
 * writer, Provider effect, raw store, legacy Attention or ProviderFact port.
 */
export function createSessionIdAcpTaskReadProjector(options: SessionIdAcpTaskReadProjectorOptions) {
  invariant(typeof options?.now === "function"
    && typeof options.snapshot?.read === "function"
    && typeof options.readCachedProfileReadiness === "function"
    && (options.readHumanOnlyActivities === undefined
      || typeof options.readHumanOnlyActivities === "function"),
  "acp_task_read_projector_options_invalid");
  return Object.freeze({ read });

  function read(value: Readonly<{ taskId: string }>): SessionIdAcpTaskReadModel {
    const taskId = exactReadRequest(value);
    return options.snapshot.read((owners) => project(owners, taskId));
  }

  function project(owners: SessionIdAcpTaskReadCapabilities, taskId: string): SessionIdAcpTaskReadModel {
    const task = owners.templateTask.getTask(taskId);
    invariant(Boolean(task) && task!.taskId === taskId, "acp_task_read_task_not_found");
    invariant(Boolean(task!.activeRunId), "acp_task_read_active_run_not_found");
    const run = owners.templateTask.getRun(task!.activeRunId!);
    invariant(Boolean(run)
      && run!.taskId === taskId
      && run!.runId === task!.activeRunId,
    "acp_task_read_run_scope_mismatch");
    const architecture = validateTaskArchitectureSnapshotV3(
      owners.templateTask.getArchitectureSnapshot(taskId),
    );
    invariant(architecture.taskId === taskId
      && architecture.architectureSnapshotId === task!.architectureSnapshotId,
    "acp_task_read_architecture_scope_mismatch");
    invariant(run!.conductorLogicalSessionId.startsWith("logical_session_"),
      "acp_task_read_conductor_identity_invalid");
    const conductor = owners.taskRun.readConductorSession(taskId, run!.runId);
    invariant(Boolean(conductor)
      && conductor!.logicalSessionId === run!.conductorLogicalSessionId
      && conductor!.taskId === taskId
      && conductor!.runId === run!.runId
      && conductor!.agentCardId === architecture.definition.conductor.agentCardId
      && conductor!.generation === 1,
    "acp_task_read_conductor_scope_mismatch");

    const profiles = new Map(architecture.definition.executionProfiles.map((profile) =>
      [profile.executionProfileId, profile] as const));
    const identities: SessionIdentity[] = [sessionIdentityForConductor(conductor!, architecture)];
    const directoryProofs: DirectoryProof[] = [];
    for (const card of architecture.definition.agentCards) {
      const slot = owners.taskRun.findSlot(run!.runId, card.agentCardId);
      if (!slot) {
        directoryProofs.push(Object.freeze({ card }));
        continue;
      }
      invariant(slot.taskId === taskId && slot.runId === run!.runId && slot.agentCardId === card.agentCardId,
        "acp_task_read_slot_scope_mismatch");
      const generations = [...owners.taskRun.listGenerations(slot.cardSessionSlotId)]
        .sort((left, right) => left.generation - right.generation);
      validateGenerations(slot, generations, taskId, run!.runId, card.agentCardId, profiles);
      identities.push(...generations.map((generation) => sessionIdentityForCard(generation, card, profiles)));
      const current = slot.currentSessionId
        ? generations.find((generation) => generation.sessionId === slot.currentSessionId)
        : undefined;
      invariant(!slot.currentSessionId || Boolean(current), "acp_task_read_current_generation_missing");
      directoryProofs.push(Object.freeze({ card, slot, generations: Object.freeze(generations), ...(current ? { current } : {}) }));
    }

    const sessionIds = identities.map((identity) => identity.logicalSessionId);
    invariant(new Set(sessionIds).size === sessionIds.length, "acp_task_read_logical_session_duplicate");
    const inbox = sessionIds.flatMap((logicalSessionId) =>
      owners.orchestration.listInboxItems(logicalSessionId).map((item) => scopedInbox(item, taskId, run!.runId, logicalSessionId)));
    const inputs = inbox.flatMap((item) => {
      const input = owners.orchestration.findInputByInboxItem(item.inboxItemId);
      if (!input) return [];
      invariant(input.taskId === taskId && input.runId === run!.runId
        && input.sessionId === item.sessionId && input.sourceInboxItemId === item.inboxItemId,
      "acp_task_read_input_scope_mismatch");
      return [input];
    });
    const turns = sessionIds.flatMap((logicalSessionId) =>
      owners.orchestration.listTurns(logicalSessionId).map((turn) => {
        invariant(turn.taskId === taskId && turn.runId === run!.runId && turn.sessionId === logicalSessionId,
          "acp_task_read_turn_scope_mismatch");
        return turn;
      }));
    const controls = owners.orchestration.listControlAudits(run!.runId).map((control) => {
      invariant(control.taskId === taskId && control.runId === run!.runId && sessionIds.includes(control.sessionId),
        "acp_task_read_control_scope_mismatch");
      return control;
    });
    const interventions = owners.humanIntervention.list(run!.runId).map((intervention) => {
      invariant(intervention.taskId === taskId && intervention.runId === run!.runId
        && sessionIds.includes(intervention.targetSessionId),
      "acp_task_read_human_scope_mismatch");
      return intervention;
    });
    const messages = owners.message.listMessages(run!.runId).map((message) => {
      invariant(message.taskId === taskId && message.runId === run!.runId,
        "acp_task_read_message_scope_mismatch");
      return message;
    });
    const forwards = owners.message.listForwards(run!.runId).map((forward) => {
      invariant(forward.taskId === taskId && forward.runId === run!.runId,
        "acp_task_read_forward_scope_mismatch");
      return forward;
    });
    const observations = owners.workspace.listObservations(taskId)
      .filter((observation) => !observation.runId || observation.runId === run!.runId)
      .map((observation) => {
        invariant(observation.taskId === taskId, "acp_task_read_observation_scope_mismatch");
        return observation;
      });
    const inputsById = new Map(inputs.map((input) => [input.inputSubmissionId, input] as const));
    const turnsById = new Map(turns.map((turn) => [turn.sessionTurnId, turn] as const));
    const sessionLabels = new Map(identities.map((identity) => [identity.logicalSessionId, identity.title] as const));
    const readinessCache = new Map<string, AcpProfileReadinessObservation>();
    const attemptProofs = new Map<string, AttemptProof>();
    const projectedSessions = identities.map((identity) => projectSession(identity));
    const sessionsById = new Map(projectedSessions.map((session) => [session.logicalSessionId, session] as const));
    const latestFence = owners.taskRun.latestPlanningFence(run!.runId);
    if (latestFence) {
      invariant(latestFence.taskId === taskId && latestFence.runId === run!.runId,
        "acp_task_read_planning_fence_scope_mismatch");
    }
    const model: SessionIdAcpTaskReadModel = Object.freeze({
      taskId,
      title: task!.title,
      goal: task!.goal,
      revision: task!.revision,
      runId: run!.runId,
      runStatus: run!.status,
      conductorLogicalSessionId: run!.conductorLogicalSessionId,
      ...(latestFence?.currentConductorSessionTurnId ? {
        planningFence: Object.freeze({
          planningFenceId: latestFence.planningFenceId,
          revision: task!.revision,
          currentConductorSessionTurnId: latestFence.currentConductorSessionTurnId,
          advancedAt: latestFence.createdAt,
        }),
      } : {}),
      directory: Object.freeze(directoryProofs.map((proof) => projectDirectory(proof, sessionsById))),
      sessions: Object.freeze(projectedSessions),
      timeline: projectTimeline({
        task: task!, run: run!, identities, messages, inputs, turns, controls, interventions, observations,
        attempts: [...attemptProofs.values()].flatMap((proof) => proof.attempts),
      }),
      files: projectFiles(observations),
    });
    return validateSessionIdAcpTaskReadModel(model);

    function projectSession(identity: SessionIdentity): SessionIdAcpTaskSessionReadModel {
      const lane = inbox.filter((item) => item.sessionId === identity.logicalSessionId);
      const sessionTurns = turns.filter((turn) => turn.sessionId === identity.logicalSessionId);
      const sessionControls = controls.filter((control) => control.sessionId === identity.logicalSessionId);
      const sessionInterventions = interventions.filter((intervention) =>
        intervention.targetSessionId === identity.logicalSessionId);
      const currentBinding = currentBindingFor(identity);
      const selectedProfile = currentBinding
        ? profiles.get(currentBinding.executionProfileId)
        : profiles.get(identity.executionProfileId);
      invariant(Boolean(selectedProfile), "acp_task_read_profile_not_found");
      const proof = executionProof(identity, currentBinding, sessionTurns);
      attemptProofs.set(identity.logicalSessionId, proof);
      const interactions = projectInteractions(proof);
      const state = deriveDirectoryState({
        identity,
        lane,
        turns: sessionTurns,
        interventions: sessionInterventions,
        proof,
        interactions,
      });
      return Object.freeze({
        logicalSessionId: identity.logicalSessionId,
        agentCardId: identity.agentCardId,
        title: identity.title,
        kind: identity.kind,
        generation: identity.generation,
        lifecycle: identity.lifecycle,
        state,
        hasReceivedFirstInstruction: lane.length > 0 || sessionTurns.length > 0,
        profile: projectProfile(identity, selectedProfile!),
        ...(currentBinding ? { binding: projectBinding(currentBinding) } : {}),
        messages: projectMessages(identity, messages, inbox, inputs, turns, forwards, sessionLabels),
        executionGroups: projectExecutions(
          identity,
          sessionTurns,
          proof,
          profiles,
          options.readHumanOnlyActivities,
        ),
        interactions,
        controls: Object.freeze(sessionControls.map((control) => Object.freeze({
          sessionControlAuditId: control.sessionControlAuditId,
          kind: control.kind,
          state: control.state,
          requestedAt: control.requestedAt,
          ...(control.settledAt ? { settledAt: control.settledAt } : {}),
          ...(control.reason ? { reason: control.reason } : {}),
        }))),
        humanDeliveries: projectHumanDeliveries(
          identity.logicalSessionId,
          sessionInterventions,
          inbox,
          messages,
          turns,
          inputs,
        ),
      });
    }

    function currentBindingFor(identity: SessionIdentity): AcpSafeSessionBindingRecordV3 | undefined {
      const persisted = owners.currentBinding.getCurrentBinding(identity.logicalSessionId);
      if (!persisted) return undefined;
      const binding = cloneAcpSafeSessionBindingRecordV3(persisted);
      invariant((binding.status === "active" || binding.status === "recovering")
        && binding.taskId === taskId
        && binding.runId === run!.runId
        && binding.logicalSessionId === identity.logicalSessionId
        && binding.agentCardId === identity.agentCardId,
      "acp_task_read_current_binding_scope_mismatch");
      const profile = profiles.get(binding.executionProfileId);
      invariant(Boolean(profile)
        && profile!.profileRevisionId === binding.profileRevisionId
        && profile!.providerFamily === binding.providerFamily,
      "acp_task_read_current_binding_profile_mismatch");
      return binding;
    }

    function executionProof(
      identity: SessionIdentity,
      currentBinding: AcpSafeSessionBindingRecordV3 | undefined,
      sessionTurns: readonly SessionIdSessionTurnRecord[],
    ): AttemptProof {
      const persisted = owners.sessionExecution.getRuntimeForSession(identity.logicalSessionId);
      if (!persisted) return Object.freeze({ attempts: Object.freeze([]) });
      const runtime = cloneSessionExecutionRuntimeRecord(persisted);
      invariant(runtime.taskId === taskId && runtime.runId === run!.runId
        && runtime.logicalSessionId === identity.logicalSessionId,
      "acp_task_read_runtime_scope_mismatch");
      const attempts = owners.sessionExecution.listAttempts(runtime.sessionExecutionRuntimeId)
        .map(cloneSessionExecutionAttemptRecord)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.sessionExecutionAttemptId.localeCompare(right.sessionExecutionAttemptId));
      invariant(new Set(attempts.map((attempt) => attempt.sessionExecutionAttemptId)).size === attempts.length,
        "acp_task_read_attempt_duplicate");
      for (const attempt of attempts) {
        invariant(attempt.sessionExecutionRuntimeId === runtime.sessionExecutionRuntimeId
          && attempt.taskId === taskId
          && attempt.runId === run!.runId
          && attempt.logicalSessionId === identity.logicalSessionId
          && profiles.get(attempt.executionProfileId)?.profileRevisionId === attempt.profileRevisionId,
        "acp_task_read_attempt_scope_mismatch");
        const input = inputsById.get(attempt.inputSubmissionId);
        const turn = turnsById.get(attempt.orchestrationSessionTurnId);
        invariant(Boolean(input) && Boolean(turn)
          && input!.sessionId === identity.logicalSessionId
          && turn!.sessionId === identity.logicalSessionId
          && turn!.inputSubmissionId === input!.inputSubmissionId
          && sessionTurns.includes(turn!),
        "acp_task_read_attempt_or_correlation_mismatch");
      }
      const activeAttempt = runtime.activeAttemptId
        ? attempts.find((attempt) => attempt.sessionExecutionAttemptId === runtime.activeAttemptId)
        : undefined;
      invariant(!runtime.activeAttemptId || Boolean(activeAttempt), "acp_task_read_active_attempt_missing");
      if (activeAttempt) {
        invariant(Boolean(currentBinding)
          && activeAttempt.bindingId === currentBinding!.bindingId
          && activeAttempt.bindingRevision === currentBinding!.revision
          && activeAttempt.executionProfileId === currentBinding!.executionProfileId
          && activeAttempt.profileRevisionId === currentBinding!.profileRevisionId,
        "acp_task_read_active_attempt_binding_mismatch");
      }
      return Object.freeze({ runtime, attempts: Object.freeze(attempts), ...(activeAttempt ? { activeAttempt } : {}) });
    }

    function projectProfile(
      identity: SessionIdentity,
      profile: ExecutionProfileDefinitionV3,
    ) {
      const key = `${profile.profileRevisionId}:${identity.role}`;
      let readiness = readinessCache.get(key);
      if (!readiness) {
        const cached = options.readCachedProfileReadiness({
          taskId,
          runId: run!.runId,
          logicalSessionId: identity.logicalSessionId,
          executionProfileId: profile.executionProfileId,
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
          acpAgentKind: profile.acpAgentKind,
          role: identity.role,
          model: profile.model,
        });
        readiness = cached
          ? validateAcpProfileReadinessObservation(cached)
          : Object.freeze({
              profileRevisionId: profile.profileRevisionId,
              providerFamily: profile.providerFamily,
              acpAgentKind: profile.acpAgentKind,
              role: identity.role,
              status: "checking" as const,
              reasons: Object.freeze(["readiness_not_cached"]),
              missingCapabilities: Object.freeze([]),
              missingExtensions: Object.freeze([]),
              model: profile.model,
            });
        invariant(readiness.profileRevisionId === profile.profileRevisionId
          && readiness.providerFamily === profile.providerFamily
          && readiness.acpAgentKind === profile.acpAgentKind
          && readiness.role === identity.role
          && readiness.model === profile.model,
        "acp_task_read_cached_readiness_scope_mismatch");
        readinessCache.set(key, readiness);
      }
      return Object.freeze({
        schemaVersion: 3 as const,
        executionProfileId: profile.executionProfileId,
        profileRevisionId: profile.profileRevisionId,
        providerFamily: profile.providerFamily,
        acpAgentKind: profile.acpAgentKind,
        model: profile.model,
        role: identity.role,
        permissionMode: profile.capabilityPolicy.permissionMode,
        allowedTools: Object.freeze([...profile.capabilityPolicy.allowedTools]),
        requiredCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
        requiredExtensions: Object.freeze([...profile.requiredExtensions]),
        readiness,
        mutableDuringRun: false as const,
      });
    }
  }
}

type SessionIdentity = Readonly<{
  logicalSessionId: string;
  agentCardId: string;
  title: string;
  kind: "conductor" | "card";
  role: AgentCardDefinition["kind"];
  generation: number;
  lifecycle: "current" | "closed" | "faulted";
  executionProfileId: string;
  profileRevisionId: string;
  createdAt: string;
  closedAt?: string;
}>;

type DirectoryProof = Readonly<{
  card: AgentCardDefinition;
  slot?: CardSessionSlotRecord;
  generations?: readonly CardSessionGenerationRecord[];
  current?: CardSessionGenerationRecord;
}>;

type AttemptProof = Readonly<{
  runtime?: SessionExecutionRuntimeRecord;
  attempts: readonly SessionExecutionAttemptRecord[];
  activeAttempt?: SessionExecutionAttemptRecord;
}>;

function sessionIdentityForConductor(
  conductor: SessionIdAcpConductorSessionReadRecord,
  architecture: TaskArchitectureSnapshotV3,
): SessionIdentity {
  const card = architecture.definition.conductor;
  const profile = architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === conductor.executionProfileId);
  invariant(Boolean(profile)
    && conductor.profileRevisionId === profile!.profileRevisionId
    && card.executionProfileId === conductor.executionProfileId,
  "acp_task_read_conductor_profile_mismatch");
  return Object.freeze({
    logicalSessionId: conductor.logicalSessionId,
    agentCardId: conductor.agentCardId,
    title: card.title,
    kind: "conductor" as const,
    role: "conductor" as const,
    generation: conductor.generation,
    lifecycle: conductor.lifecycle,
    executionProfileId: conductor.executionProfileId,
    profileRevisionId: conductor.profileRevisionId,
    createdAt: conductor.createdAt,
    ...(conductor.closedAt ? { closedAt: conductor.closedAt } : {}),
  });
}

function sessionIdentityForCard(
  generation: CardSessionGenerationRecord,
  card: AgentCardDefinition,
  profiles: ReadonlyMap<string, ExecutionProfileDefinitionV3>,
): SessionIdentity {
  const profile = profiles.get(generation.executionProfileId);
  invariant(Boolean(profile), "acp_task_read_generation_profile_missing");
  return Object.freeze({
    logicalSessionId: generation.sessionId,
    agentCardId: generation.agentCardId,
    title: card.title,
    kind: "card" as const,
    role: card.kind,
    generation: generation.generation,
    lifecycle: generation.lifecycle,
    executionProfileId: generation.executionProfileId,
    profileRevisionId: profile!.profileRevisionId,
    createdAt: generation.createdAt,
    ...(generation.closedAt ? { closedAt: generation.closedAt } : {}),
  });
}

function validateGenerations(
  slot: CardSessionSlotRecord,
  generations: readonly CardSessionGenerationRecord[],
  taskId: string,
  runId: string,
  agentCardId: string,
  profiles: ReadonlyMap<string, ExecutionProfileDefinitionV3>,
): void {
  invariant(new Set(generations.map((generation) => generation.generation)).size === generations.length,
    "acp_task_read_generation_duplicate");
  const latest = generations.at(-1);
  invariant((latest?.generation ?? 0) === slot.latestGeneration, "acp_task_read_slot_latest_generation_mismatch");
  for (const generation of generations) {
    invariant(generation.cardSessionSlotId === slot.cardSessionSlotId
      && generation.taskId === taskId
      && generation.runId === runId
      && generation.agentCardId === agentCardId
      && Boolean(profiles.get(generation.executionProfileId)),
    "acp_task_read_generation_scope_mismatch");
  }
  if (!slot.currentSessionId) {
    invariant(!generations.some((generation) => generation.lifecycle === "current"),
      "acp_task_read_slot_current_pointer_missing");
    return;
  }
  const current = generations.filter((generation) => generation.sessionId === slot.currentSessionId);
  invariant(current.length === 1
    && current[0]!.lifecycle === "current"
    && current[0]!.generation === slot.latestGeneration
    && !current[0]!.closedAt
    && generations.filter((generation) => generation.lifecycle === "current").length === 1,
  "acp_task_read_current_generation_mismatch");
}

function projectDirectory(
  proof: DirectoryProof,
  sessions: ReadonlyMap<string, SessionIdAcpTaskSessionReadModel>,
) {
  const current = proof.current ? sessions.get(proof.current.sessionId) : undefined;
  const latest = proof.generations?.at(-1);
  const state: SessionIdAcpTaskDirectoryState = current?.state
    ?? (latest?.lifecycle === "faulted" ? "faulted" : latest ? "closed" : "no_session");
  return Object.freeze({
    agentCardId: proof.card.agentCardId,
    title: proof.card.title,
    state,
    ...(current ? {
      currentLogicalSessionId: current.logicalSessionId,
      currentGeneration: current.generation,
    } : {}),
    detail: directoryDetail(state),
  });
}

function projectBinding(binding: AcpSafeSessionBindingRecordV3) {
  return Object.freeze({
    label: `${providerTitle(binding.providerFamily)} ACP`,
    status: binding.status as "active" | "recovering",
    recoverable: binding.recoverable,
  });
}

function projectInteractions(proof: AttemptProof): readonly SessionIdAcpTaskInteractionReadModel[] {
  if (proof.runtime?.state !== "executing" || proof.activeAttempt?.state !== "waiting_for_interaction"
    || proof.activeAttempt.settlement) return Object.freeze([]);
  return Object.freeze(proof.activeAttempt.interactions
    .filter((interaction) => interaction.status === "requested")
    .map((interaction) => Object.freeze({
      interactionId: interaction.interactionId,
      interactionRevision: interaction.revision,
      choices: Object.freeze(interaction.choices.map((choice) => Object.freeze({
        choiceId: choice.choiceId,
        label: choice.label,
      }))),
    })));
}

function deriveDirectoryState(input: Readonly<{
  identity: SessionIdentity;
  lane: readonly SessionLaneItemRecord[];
  turns: readonly SessionIdSessionTurnRecord[];
  interventions: readonly SessionIdHumanInterventionRecord[];
  proof: AttemptProof;
  interactions: readonly SessionIdAcpTaskInteractionReadModel[];
}>): SessionIdAcpTaskDirectoryState {
  if (input.identity.lifecycle === "closed") return "closed";
  if (input.identity.lifecycle === "faulted") return "faulted";
  if (input.proof.runtime?.state === "reconciling"
    || input.proof.activeAttempt?.state === "reconciling"
    || input.turns.some((turn) => turn.state === "ambiguous")) return "reconciling";
  if (input.interventions.some((intervention) => intervention.state === "held")
    || input.lane.some((item) => item.state === "held_by_human_intervention")) return "human_blocked";
  if (input.interactions.length > 0) return "interaction_required";
  if (input.proof.activeAttempt
    || input.turns.some((turn) => turn.state === "pending" || turn.state === "active")
    || input.lane.some((item) => item.state === "pending" || item.state === "leased")) return "busy";
  return "available";
}

function projectMessages(
  identity: SessionIdentity,
  messages: readonly SessionIdSessionMessageRecord[],
  inbox: readonly SessionLaneItemRecord[],
  inputs: readonly SessionIdInputSubmissionRecord[],
  turns: readonly SessionIdSessionTurnRecord[],
  forwards: readonly SessionIdMessageForwardRecord[],
  labels: ReadonlyMap<string, string>,
): readonly SessionIdAcpTaskMessageReadModel[] {
  const turnsById = new Map(turns.map((turn) => [turn.sessionTurnId, turn] as const));
  const inputsByInbox = new Map(inputs.map((input) => [input.sourceInboxItemId, input] as const));
  const deliveriesByMessage = new Map<string, SessionLaneItemRecord[]>();
  for (const item of inbox) {
    const list = deliveriesByMessage.get(item.renderedMessageId) ?? [];
    list.push(item);
    deliveriesByMessage.set(item.renderedMessageId, list);
  }
  const visible = new Set(inbox.filter((item) => item.sessionId === identity.logicalSessionId)
    .map((item) => item.renderedMessageId));
  const forwardsByMessage = new Map(forwards.map((forward) => [forward.renderedMessageId, forward] as const));
  return Object.freeze(messages
    .filter((message) => visible.has(message.messageId)
      || message.sourceSessionId === identity.logicalSessionId
      || (message.sourceSessionTurnId
        && turnsById.get(message.sourceSessionTurnId)?.sessionId === identity.logicalSessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.messageId.localeCompare(right.messageId))
    .map((message) => {
      const forward = forwardsByMessage.get(message.messageId);
      const references = forward
        ? [...new Set(forward.orderedReferenceSnapshots.map((reference) => reference.sourceMessageId))]
        : [];
      const relayBlocks = message.canonicalContent.flatMap((node, ordinal) => node.kind === "relay"
        ? [Object.freeze({
            relayBlockId: node.relayBlockId,
            ordinal,
            suggestedTargetAgentCardIds: Object.freeze([...node.suggestedTargetAgentCardIds]),
            ...(node.suggestedAudience ? { suggestedAudience: node.suggestedAudience } : {}),
            ...(node.topic ? { topic: node.topic } : {}),
            format: node.format,
            content: node.content,
            contentDigest: hashDefinition(node.content),
            createdAt: message.createdAt,
          })]
        : []);
      return Object.freeze({
        messageId: message.messageId,
        kind: message.kind,
        content: message.content,
        contentDigest: message.contentDigest,
        ...(message.sourceSessionId ? { sourceLogicalSessionId: message.sourceSessionId } : {}),
        ...(message.sourceSessionTurnId ? { sourceSessionTurnId: message.sourceSessionTurnId } : {}),
        ...(message.sourceHumanInterventionId ? { sourceHumanInterventionId: message.sourceHumanInterventionId } : {}),
        ...(message.sourceSessionId ? { sourceLabel: labels.get(message.sourceSessionId) ?? "Card Session" } : {}),
        ...(message.messageId.startsWith("message_acp_late_final_")
          ? { runtimeNoticeKind: "late_final" as const }
          : {}),
        ...(references.length > 0 ? { referencedMessageIds: Object.freeze(references) } : {}),
        createdAt: message.createdAt,
        relayBlocks: Object.freeze(relayBlocks),
        inboxDeliveries: Object.freeze((deliveriesByMessage.get(message.messageId) ?? [])
          .map((item) => projectInboxDelivery(item, inputsByInbox.get(item.inboxItemId)))),
      });
    }));
}

function projectInboxDelivery(item: SessionLaneItemRecord, input?: SessionIdInputSubmissionRecord) {
  const state = item.state === "pending" || item.state === "held_by_human_intervention"
    ? "pending"
    : item.state === "leased"
      ? input ? "delivery_staged" : "leased"
      : item.state === "handed" || item.state === "handled"
        ? "delivered"
        : item.state;
  return Object.freeze({
    inboxItemId: item.inboxItemId,
    targetLogicalSessionId: item.sessionId,
    route: item.humanInterventionId ? "human" as const : item.forwardId ? "forward" as const : "message" as const,
    ...(item.forwardId ? { forwardId: item.forwardId } : {}),
    ...(item.humanInterventionId ? { humanInterventionId: item.humanInterventionId } : {}),
    state,
    ...(input ? { deliveryInputSubmissionId: input.inputSubmissionId } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}

function projectExecutions(
  identity: SessionIdentity,
  turns: readonly SessionIdSessionTurnRecord[],
  proof: AttemptProof,
  profiles: ReadonlyMap<string, ExecutionProfileDefinitionV3>,
  readHumanOnlyActivities?: (
    sessionExecutionAttemptId: string,
  ) => readonly ProviderActivityReadModel[],
): readonly SessionIdAcpTaskExecutionGroupReadModel[] {
  return Object.freeze(turns.map((turn) => {
    const attempts = proof.attempts.filter((attempt) => attempt.orchestrationSessionTurnId === turn.sessionTurnId);
    invariant(attempts.length <= 1, "acp_task_read_turn_attempt_ambiguous");
    const attempt = attempts[0];
    const profile = attempt ? profiles.get(attempt.executionProfileId) : profiles.get(identity.executionProfileId);
    invariant(Boolean(profile), "acp_task_read_execution_profile_missing");
    return Object.freeze({
      executionGroupId: `execution_group_${turn.sessionTurnId}`,
      logicalSessionId: identity.logicalSessionId,
      providerFamily: profile!.providerFamily,
      sessionTurnId: turn.sessionTurnId,
      inputSubmissionId: turn.inputSubmissionId,
      ...(turn.finalMessageId ? { finalMessageId: turn.finalMessageId } : {}),
      status: executionStatus(turn, attempt),
      startedAt: attempt?.createdAt ?? turn.createdAt,
      updatedAt: attempt?.updatedAt ?? turn.updatedAt,
      activities: Object.freeze(attempt && readHumanOnlyActivities
        ? [...readHumanOnlyActivities(attempt.sessionExecutionAttemptId)]
        : []),
    });
  }));
}

function executionStatus(
  turn: SessionIdSessionTurnRecord,
  attempt?: SessionExecutionAttemptRecord,
): SessionIdAcpTaskExecutionGroupReadModel["status"] {
  if (attempt?.settlement?.outcome === "completed" || turn.state === "returned" || turn.state === "completed") return "completed";
  if (attempt?.settlement?.outcome === "failed" || turn.state === "failed") return "failed";
  if (attempt?.settlement?.outcome === "cancelled" || turn.state === "cancelled" || turn.state === "interrupted") return "cancelled";
  if (attempt?.state === "reconciling" || turn.state === "ambiguous") return "ambiguous";
  if (attempt?.state === "waiting_for_interaction") return "waiting_for_interaction";
  if (attempt?.state === "candidate_observed") return "awaiting_final";
  if (attempt || turn.state === "active") return "running";
  return "pending";
}

function projectHumanDeliveries(
  logicalSessionId: string,
  interventions: readonly SessionIdHumanInterventionRecord[],
  inbox: readonly SessionLaneItemRecord[],
  messages: readonly SessionIdSessionMessageRecord[],
  turns: readonly SessionIdSessionTurnRecord[],
  inputs: readonly SessionIdInputSubmissionRecord[],
): readonly SessionIdAcpTaskHumanDeliveryReadModel[] {
  const messagesById = new Map(messages.map((message) => [message.messageId, message] as const));
  const inputsByInbox = new Map(inputs.map((input) => [input.sourceInboxItemId, input] as const));
  return Object.freeze(interventions.flatMap((intervention) => {
    if ((intervention.mode !== "direct_message" && intervention.mode !== "interrupt_then_send")
      || !intervention.cardMessageId || !intervention.conductorMirrorMessageId) return [];
    const card = inbox.find((item) => item.sessionId === logicalSessionId
      && item.humanInterventionId === intervention.humanInterventionId
      && item.renderedMessageId === intervention.cardMessageId);
    const mirror = inbox.find((item) => item.humanInterventionId === intervention.humanInterventionId
      && item.renderedMessageId === intervention.conductorMirrorMessageId);
    const message = messagesById.get(intervention.cardMessageId);
    if (!card || !mirror || !message) return [];
    const input = inputsByInbox.get(card.inboxItemId);
    const turn = input ? turns.find((candidate) => candidate.inputSubmissionId === input.inputSubmissionId) : undefined;
    return [Object.freeze({
      humanInterventionId: intervention.humanInterventionId,
      mode: intervention.mode,
      content: message.content,
      conductorMirrorMessageId: intervention.conductorMirrorMessageId,
      conductorMirrorSequence: mirror.sequence,
      cardMessageId: intervention.cardMessageId,
      cardSequence: card.sequence,
      cardState: humanCardState(card.state),
      ...(turn ? { deliverySessionTurnId: turn.sessionTurnId } : {}),
      createdAt: intervention.createdAt,
    })];
  }));
}

function humanCardState(state: SessionLaneItemRecord["state"]): SessionIdAcpTaskHumanDeliveryReadModel["cardState"] {
  if (state === "held_by_human_intervention") return "held";
  if (state === "suppressed") return "suppressed";
  if (state === "handed" || state === "handled") return "delivered";
  return "pending";
}

function projectTimeline(input: Readonly<{
  task: TaskRecord;
  run: TaskRunRecord;
  identities: readonly SessionIdentity[];
  messages: readonly SessionIdSessionMessageRecord[];
  inputs: readonly SessionIdInputSubmissionRecord[];
  turns: readonly SessionIdSessionTurnRecord[];
  controls: readonly SessionControlAuditRecord[];
  interventions: readonly SessionIdHumanInterventionRecord[];
  observations: readonly WorkspaceFileObservationRecord[];
  attempts: readonly SessionExecutionAttemptRecord[];
}>): readonly SessionIdAcpTaskTimelineItemReadModel[] {
  const items: SessionIdAcpTaskTimelineItemReadModel[] = [
    timeline(`timeline_task_created_${input.task.taskId}`, "task_created", input.task.createdAt, "Task created"),
    timeline(`timeline_run_started_${input.run.runId}`, "run_started", input.run.startedAt, "Run started", { status: input.run.status }),
  ];
  if (input.run.endedAt) {
    items.push(timeline(`timeline_run_stopped_${input.run.runId}`, "run_stopped", input.run.endedAt, "Run ended", {
      status: input.run.status,
    }));
  }
  for (const identity of input.identities) {
    items.push(timeline(`timeline_generation_created_${identity.logicalSessionId}`,
      "session_generation_created", identity.createdAt, "Session generation created", {
        logicalSessionId: identity.logicalSessionId,
        generation: identity.generation,
        status: identity.lifecycle,
      }));
    if (identity.closedAt) items.push(timeline(`timeline_generation_closed_${identity.logicalSessionId}`,
      "session_generation_closed", identity.closedAt, "Session generation closed", {
        logicalSessionId: identity.logicalSessionId,
        generation: identity.generation,
        status: identity.lifecycle,
      }));
  }
  for (const message of input.messages) items.push(timeline(`timeline_message_${message.messageId}`,
    "message_created", message.createdAt, "Message created", {
      status: message.kind,
      messageId: message.messageId,
      ...(message.sourceSessionId ? { logicalSessionId: message.sourceSessionId } : {}),
    }));
  for (const submission of input.inputs) items.push(timeline(`timeline_input_${submission.inputSubmissionId}_${submission.state}`,
    "input_state", submission.updatedAt, "Input state changed", {
      status: submission.state,
      logicalSessionId: submission.sessionId,
      inputSubmissionId: submission.inputSubmissionId,
    }));
  for (const turn of input.turns) items.push(timeline(`timeline_turn_${turn.sessionTurnId}_${turn.state}`,
    "turn_state", turn.updatedAt, "Turn state changed", {
      status: turn.state,
      logicalSessionId: turn.sessionId,
      sessionTurnId: turn.sessionTurnId,
    }));
  for (const control of input.controls) {
    items.push(timeline(`timeline_control_${control.sessionControlAuditId}_${control.state}`,
      "control_state", control.settledAt ?? control.requestedAt, "Session control state changed", {
        status: control.state,
        logicalSessionId: control.sessionId,
        sessionControlAuditId: control.sessionControlAuditId,
      }));
    if (control.kind === "task_stop") items.push(timeline(`timeline_stop_${control.sessionControlAuditId}`,
      "stop_requested", control.requestedAt, "Task stop requested", {
        status: control.state,
        logicalSessionId: control.sessionId,
        sessionControlAuditId: control.sessionControlAuditId,
      }));
  }
  for (const attempt of input.attempts) for (const interaction of attempt.interactions) {
    items.push(timeline(`timeline_interaction_${interaction.interactionId}_${interaction.revision}`,
      "interaction_state", interaction.respondedAt ?? interaction.requestedAt,
      interaction.status === "requested" ? "Interaction requires a choice" : "Interaction choice recorded", {
        status: interaction.status,
        logicalSessionId: attempt.logicalSessionId,
        interactionId: interaction.interactionId,
      }));
  }
  for (const intervention of input.interventions) items.push(timeline(
    `timeline_human_${intervention.humanInterventionId}_${intervention.state}`,
    "human_intervention_state", intervention.updatedAt, "Human intervention state changed", {
      status: intervention.state,
      logicalSessionId: intervention.targetSessionId,
      humanInterventionId: intervention.humanInterventionId,
    }));
  for (const observation of input.observations) items.push(timeline(
    `timeline_workspace_${observation.workspaceFileObservationId}`,
    "workspace_observed", observation.observedAt, "Workspace file observed", {
      status: observation.state,
      observationId: observation.workspaceFileObservationId,
    }));
  if (input.task.achievement) items.push(timeline(`timeline_achievement_${input.task.taskId}`,
    "achievement_recorded", input.task.achievement.achievedAt, "Task achievement recorded"));
  return Object.freeze(items.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || left.timelineItemId.localeCompare(right.timelineItemId)));
}

function timeline(
  timelineItemId: string,
  kind: SessionIdAcpTaskTimelineItemReadModel["kind"],
  occurredAt: string,
  title: string,
  extra: Omit<SessionIdAcpTaskTimelineItemReadModel, "timelineItemId" | "kind" | "occurredAt" | "title"> = {},
): SessionIdAcpTaskTimelineItemReadModel {
  return Object.freeze({ timelineItemId, kind, occurredAt, title, ...extra });
}

function projectFiles(
  observations: readonly WorkspaceFileObservationRecord[],
): readonly SessionIdAcpTaskFileObservationReadModel[] {
  const latest = new Map<string, WorkspaceFileObservationRecord>();
  for (const observation of observations) {
    const prior = latest.get(observation.workspaceRelativePath);
    if (!prior || prior.observedAt < observation.observedAt
      || (prior.observedAt === observation.observedAt
        && prior.workspaceFileObservationId < observation.workspaceFileObservationId)) {
      latest.set(observation.workspaceRelativePath, observation);
    }
  }
  return Object.freeze([...latest.values()]
    .sort((left, right) => left.workspaceRelativePath.localeCompare(right.workspaceRelativePath))
    .map((observation) => Object.freeze({
      observationId: observation.workspaceFileObservationId,
      workspaceRelativePath: observation.workspaceRelativePath,
      observedAt: observation.observedAt,
      ...(observation.contentDigest ? { contentDigest: observation.contentDigest } : {}),
      currentState: observation.state,
      source: observation.source,
    })));
}

function scopedInbox(
  item: SessionLaneItemRecord,
  taskId: string,
  runId: string,
  logicalSessionId: string,
): SessionLaneItemRecord {
  invariant(item.taskId === taskId && item.runId === runId && item.sessionId === logicalSessionId,
    "acp_task_read_inbox_scope_mismatch");
  return item;
}

function providerTitle(providerFamily: ProviderFamily): string {
  if (providerFamily === "opencode") return "OpenCode";
  if (providerFamily === "codex") return "Codex";
  return "Claude Code";
}

function directoryDetail(state: SessionIdAcpTaskDirectoryState): string {
  if (state === "no_session") return "No current Session";
  if (state === "available") return "Ready for the next instruction";
  if (state === "busy") return "Session is processing durable work";
  if (state === "human_blocked") return "Authenticated human intervention is pending";
  if (state === "interaction_required") return "Waiting for an authenticated choice";
  if (state === "reconciling") return "Runtime reconciliation required";
  if (state === "closed") return "Session generation is closed";
  return "Session generation faulted";
}

function exactReadRequest(value: unknown): string {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "acp_task_read_request_invalid");
  const root = value as Record<string, unknown>;
  invariant(Object.keys(root).length === 1 && typeof root.taskId === "string"
    && /^task_[A-Za-z0-9_-]+$/u.test(root.taskId),
  "acp_task_read_request_invalid");
  return root.taskId;
}
