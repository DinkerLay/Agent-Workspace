import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  renderTaskGoalContentV1,
  type AcpProfileReadinessObservation,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type ConductorPlanningFenceRecord,
  type JsonValue,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionIdMessageForwardRecord,
  type SessionLaneItemRecord,
  type TaskArchitectureSnapshotV3,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceFileObservationRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpTaskReadProjector,
  type SessionIdAcpTaskReadCapabilities,
} from "./session-id-acp-task-read-projector.js";

const NOW = "2026-08-12T18:00:00.000Z";
const TASK_ID = "task_acp_read";
const RUN_ID = "run_acp_read";
const CONDUCTOR_ID = "logical_session_acp_conductor";
const CARD_ID = "logical_session_acp_worker";

describe("Session-ID ACP Task read projector", () => {
  it("projects only owner-safe v3 state and requested SR interactions", () => {
    const fixture = createFixture();
    const model = fixture.projector.read({ taskId: TASK_ID });
    expect(model.runStatus).toBe("running");
    expect(model.conductorLogicalSessionId).toBe(CONDUCTOR_ID);
    expect(model.directory).toEqual([expect.objectContaining({
      agentCardId: "agent_card_worker",
      state: "interaction_required",
      currentLogicalSessionId: CARD_ID,
      currentGeneration: 1,
    })]);
    const worker = model.sessions.find((session) => session.logicalSessionId === CARD_ID);
    expect(worker).toMatchObject({
      state: "interaction_required",
      binding: { label: "OpenCode ACP", status: "active", recoverable: true },
      profile: {
        schemaVersion: 3,
        executionProfileId: "profile_worker",
        profileRevisionId: "profile_revision_worker",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        model: "openai/gpt-5",
        role: "researcher",
      },
      interactions: [{
        interactionId: "interaction_permission",
        interactionRevision: 2,
        choices: [{ choiceId: "choice_allow", label: "Allow once" }],
      }],
    });
    expect(worker?.executionGroups).toEqual([expect.objectContaining({
      executionGroupId: "execution_group_session_turn_worker",
      logicalSessionId: CARD_ID,
      status: "waiting_for_interaction",
      activities: [],
    })]);
    expect(worker?.messages).toEqual([expect.objectContaining({
      messageId: "message_worker_input",
      kind: "conductor_forward",
      inboxDeliveries: [expect.objectContaining({ state: "delivered", deliveryInputSubmissionId: "input_worker" })],
    })]);
    expect(model.timeline).toContainEqual(expect.objectContaining({
      kind: "interaction_state",
      interactionId: "interaction_permission",
      status: "requested",
    }));
    expect(model.files).toEqual([expect.objectContaining({ workspaceRelativePath: "README.md" })]);
    expect(collectKeys(model)).not.toEqual(expect.arrayContaining([
      "sessionId", "attentions", "attentionId", "providerFact", "bindingId", "bindingHandle",
      "sessionExecutionAttemptId", "promptDigest", "receiptDigest", "cwd", "absolutePath",
    ]));
    expect(fixture.readCachedProfileReadiness).toHaveBeenCalledTimes(2);
    expect(model).not.toBeInstanceOf(Promise);
  });

  it("uses only the current Attempt for actionable choices", () => {
    const fixture = createFixture();
    const { activeAttemptId: _activeAttemptId, ...idleRuntime } = fixture.runtime;
    fixture.runtime = { ...idleRuntime, state: "idle", revision: 4 };
    const model = fixture.projector.read({ taskId: TASK_ID });
    const worker = model.sessions.find((session) => session.logicalSessionId === CARD_ID)!;
    expect(worker.interactions).toEqual([]);
    expect(worker.executionGroups).toHaveLength(1);
  });

  it.each(["starting", "stopping", "stopped", "failed", "cancellation_unknown"] as const)(
    "projects the canonical %s Run state without lifecycle repair",
    (status) => {
      const fixture = createFixture();
      fixture.run = { ...fixture.run, status, ...(status === "stopped" || status === "failed" ? { endedAt: NOW } : {}) };
      fixture.task = {
        ...fixture.task,
        status: status === "stopping"
          ? "stopping"
          : status === "stopped"
            ? "stopped"
            : status === "failed" || status === "cancellation_unknown"
              ? "blocked"
              : "running",
      };
      expect(fixture.projector.read({ taskId: TASK_ID }).runStatus).toBe(status);
    },
  );

  it("fails closed on current-generation or Binding/Profile drift", () => {
    const mutations: Array<(fixture: ReturnType<typeof createFixture>) => void> = [
      (fixture) => { fixture.slot = { ...fixture.slot, latestGeneration: 2 }; },
      (fixture) => { fixture.binding = { ...fixture.binding, profileRevisionId: "profile_revision_other" }; },
      (fixture) => { fixture.attempt = { ...fixture.attempt, bindingRevision: 2 }; },
    ];
    for (const mutate of mutations) {
      const fixture = createFixture();
      mutate(fixture);
      expect(() => fixture.projector.read({ taskId: TASK_ID })).toThrow();
    }
  });

  it("falls back to an honest cached-checking profile without probing or writing", () => {
    const fixture = createFixture();
    fixture.cachedReadiness = undefined;
    const model = fixture.projector.read({ taskId: TASK_ID });
    expect(model.sessions.every((session) => session.profile.readiness.status === "checking")).toBe(true);
    expect(model.sessions.every((session) => session.profile.readiness.reasons.includes("readiness_not_cached"))).toBe(true);
    expect(fixture.readCachedProfileReadiness).toHaveBeenCalledTimes(2);
  });
});

function createFixture() {
  let task = taskRecord();
  let run = runRecord();
  const architecture = architectureRecord();
  let slot = slotRecord();
  const generation = generationRecord();
  let binding = bindingRecord();
  let runtime = runtimeRecord();
  let attempt = attemptRecord();
  let cachedReadiness: AcpProfileReadinessObservation | undefined;
  let cachedReadinessEnabled = true;
  const messages = messageRecords();
  const inbox = inboxRecords();
  const inputs = inputRecords();
  const turns = turnRecords();
  const controls: SessionControlAuditRecord[] = [];
  const interventions: SessionIdHumanInterventionRecord[] = [];
  const observations = observationRecords();
  const readCachedProfileReadiness = vi.fn((scope: Readonly<{
    profileRevisionId: string;
    role: string;
  }>) => cachedReadinessEnabled
    ? cachedReadiness ?? readiness(scope.profileRevisionId, scope.role)
    : undefined);
  const capabilities: SessionIdAcpTaskReadCapabilities = {
    templateTask: {
      getTask: (taskId) => taskId === TASK_ID ? task : undefined,
      getRun: (runId) => runId === RUN_ID ? run : undefined,
      getArchitectureSnapshot: (taskId) => taskId === TASK_ID ? architecture : undefined,
    },
    taskRun: {
      findSlot: (runId, agentCardId) => runId === RUN_ID && agentCardId === "agent_card_worker" ? slot : undefined,
      listGenerations: (slotId) => slotId === slot.cardSessionSlotId ? [generation] : [],
      latestPlanningFence: () => planningFence(),
      readConductorSession: () => ({
        logicalSessionId: CONDUCTOR_ID,
        taskId: TASK_ID,
        runId: RUN_ID,
        agentCardId: "agent_card_conductor",
        executionProfileId: "profile_conductor",
        profileRevisionId: "profile_revision_conductor",
        generation: 1,
        lifecycle: "current",
        createdAt: NOW,
      }),
    },
    message: { listMessages: () => messages, listForwards: () => [] as SessionIdMessageForwardRecord[] },
    orchestration: {
      listInboxItems: (logicalSessionId) => inbox.filter((item) => item.sessionId === logicalSessionId),
      findInputByInboxItem: (inboxItemId) => inputs.find((input) => input.sourceInboxItemId === inboxItemId),
      listTurns: (logicalSessionId) => turns.filter((turn) => turn.sessionId === logicalSessionId),
      listControlAudits: (_runId, logicalSessionId) => controls.filter((control) =>
        !logicalSessionId || control.sessionId === logicalSessionId),
    },
    humanIntervention: {
      list: (_runId, logicalSessionId) => interventions.filter((intervention) =>
        !logicalSessionId || intervention.targetSessionId === logicalSessionId),
    },
    workspace: { listObservations: () => observations },
    currentBinding: { getCurrentBinding: (logicalSessionId) => logicalSessionId === CARD_ID ? binding : undefined },
    sessionExecution: {
      getRuntimeForSession: (logicalSessionId) => logicalSessionId === CARD_ID ? runtime : undefined,
      listAttempts: (runtimeId) => runtimeId === runtime.sessionExecutionRuntimeId ? [attempt] : [],
    },
  };
  const projector = createSessionIdAcpTaskReadProjector({
    now: () => NOW,
    snapshot: { read: <T>(work: (owners: SessionIdAcpTaskReadCapabilities) => T) => work(capabilities) },
    readCachedProfileReadiness,
  });
  return {
    projector,
    readCachedProfileReadiness,
    get task() { return task; },
    set task(value: TaskRecord) { task = value; },
    get run() { return run; },
    set run(value: TaskRunRecord) { run = value; },
    get slot() { return slot; },
    set slot(value: CardSessionSlotRecord) { slot = value; },
    get binding() { return binding; },
    set binding(value: AcpSafeSessionBindingRecordV3) { binding = value; },
    get runtime() { return runtime; },
    set runtime(value: SessionExecutionRuntimeRecord) { runtime = value; },
    get attempt() { return attempt; },
    set attempt(value: SessionExecutionAttemptRecord) { attempt = value; },
    get cachedReadiness() { return cachedReadiness; },
    set cachedReadiness(value: AcpProfileReadinessObservation | undefined) {
      cachedReadiness = value;
      cachedReadinessEnabled = value !== undefined;
    },
  };
}

function taskRecord(): TaskRecord {
  return {
    taskId: TASK_ID,
    architectureSnapshotId: "architecture_acp_read",
    title: "ACP read model",
    goal: "Project canonical state",
    status: "running",
    activeRunId: RUN_ID,
    revision: 7,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runRecord(): TaskRunRecord {
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    conductorLogicalSessionId: CONDUCTOR_ID,
    status: "running",
    runNumber: 1,
    startedAt: NOW,
    revision: 2,
  };
}

function architectureRecord(): TaskArchitectureSnapshotV3 {
  const definition = {
    schemaVersion: 3 as const,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor" as const,
      title: "Conductor",
      executionProfileId: "profile_conductor",
      systemPrompt: "Coordinate the task.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "researcher" as const,
      title: "Researcher",
      executionProfileId: "profile_worker",
      systemPrompt: "Research safely.",
      capabilityRefs: [],
      dispatchProfile: { title: "Research", description: "Use for research." },
    }],
    executionProfiles: [
      profile("profile_conductor", "profile_revision_conductor", "conductor"),
      profile("profile_worker", "profile_revision_worker", "researcher"),
    ],
    routingPolicy: { mode: "agent_loop" as const, maxConcurrentInvocations: 2, maxDispatchesPerDecision: 2 },
    deliverables: [],
  };
  const taskGoalContent = renderTaskGoalContentV1({ title: "ACP read model", goal: "Project canonical state", taskInputValues: [] });
  return {
    schemaVersion: 3,
    architectureSnapshotId: "architecture_acp_read",
    taskId: TASK_ID,
    templateId: "template_acp_read",
    templateVersionId: "template_version_acp_read",
    templateDefinitionHash: hashDefinition(definition as unknown as JsonValue),
    definition,
    taskInputValues: [],
    taskTitle: "ACP read model",
    taskGoal: "Project canonical state",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: { workspaceId: "workspace_acp_read", grantDigest: `sha256:${"a".repeat(64)}` },
    createdAt: NOW,
  };
}

function profile(executionProfileId: string, profileRevisionId: string, role: "conductor" | "researcher") {
  return {
    executionProfileId,
    profileRevisionId,
    providerFamily: "opencode" as const,
    acpAgentKind: "native_acp" as const,
    protocolMajor: 1 as const,
    model: "openai/gpt-5",
    configIntent: {},
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ] as const,
      allowedTools: role === "conductor" ? ["invoke_agent"] : [],
      permissionMode: "ask" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function slotRecord(): CardSessionSlotRecord {
  return {
    cardSessionSlotId: "card_session_slot_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_worker",
    currentSessionId: CARD_ID,
    latestGeneration: 1,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function generationRecord(): CardSessionGenerationRecord {
  return {
    sessionId: CARD_ID,
    cardSessionSlotId: "card_session_slot_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_worker",
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_acp_read",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: CARD_ID,
    agentCardId: "agent_card_worker",
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_acp_read",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeRecord(): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_acp_read",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: CARD_ID,
    state: "executing",
    activeAttemptId: "session_execution_attempt_acp_read",
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function attemptRecord(): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_acp_read",
    sessionExecutionRuntimeId: "session_execution_runtime_acp_read",
    taskId: TASK_ID,
    runId: RUN_ID,
    logicalSessionId: CARD_ID,
    bindingId: "binding_acp_read",
    bindingRevision: 1,
    executionProfileId: "profile_worker",
    profileRevisionId: "profile_revision_worker",
    inputSubmissionId: "input_worker",
    orchestrationSessionTurnId: "session_turn_worker",
    state: "waiting_for_interaction",
    receiptDigest: `sha256:${"b".repeat(64)}`,
    receiptObservedAt: NOW,
    interactions: [{
      interactionId: "interaction_permission",
      promptDigest: `sha256:${"c".repeat(64)}`,
      choices: [{ choiceId: "choice_allow", label: "Allow once" }],
      status: "requested",
      revision: 2,
      requestedAt: NOW,
    }],
    revision: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function messageRecords(): SessionIdSessionMessageRecord[] {
  const content = "Research this topic";
  return [{
    messageId: "message_worker_input",
    taskId: TASK_ID,
    runId: RUN_ID,
    kind: "conductor_forward",
    content,
    canonicalContent: [{ kind: "text", text: content }],
    contentDigest: hashDefinition(content),
    createdAt: NOW,
  }];
}

function inboxRecords(): SessionLaneItemRecord[] {
  return [{
    inboxItemId: "inbox_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: CARD_ID,
    renderedMessageId: "message_worker_input",
    sequence: 1,
    priority: "ordinary",
    state: "handed",
    createdAt: NOW,
    updatedAt: NOW,
  }];
}

function inputRecords(): SessionIdInputSubmissionRecord[] {
  return [{
    inputSubmissionId: "input_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: CARD_ID,
    sourceInboxItemId: "inbox_worker",
    contentMessageId: "message_worker_input",
    commandId: "command_worker_input",
    idempotencyKey: "read:model:worker",
    sequence: 1,
    state: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
  }];
}

function turnRecords(): SessionIdSessionTurnRecord[] {
  return [{
    sessionTurnId: "session_turn_worker",
    taskId: TASK_ID,
    runId: RUN_ID,
    sessionId: CARD_ID,
    inputSubmissionId: "input_worker",
    sourceConductorSessionTurnId: "session_turn_conductor",
    trigger: "conductor_send",
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  }];
}

function observationRecords(): WorkspaceFileObservationRecord[] {
  return [{
    workspaceFileObservationId: "workspace_file_observation_readme",
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceRelativePath: "README.md",
    state: "available",
    source: "verified_tool",
    observedAt: NOW,
  }];
}

function planningFence(): ConductorPlanningFenceRecord {
  return {
    planningFenceId: "planning_fence_acp_read",
    taskId: TASK_ID,
    runId: RUN_ID,
    sourceCommandId: "command_task_input",
    currentConductorSessionTurnId: "session_turn_conductor",
    createdAt: NOW,
  };
}

function readiness(profileRevisionId: string, role: string): AcpProfileReadinessObservation {
  return {
    profileRevisionId,
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    role: role as "conductor" | "researcher",
    status: "available",
    reasons: [],
    missingCapabilities: [],
    missingExtensions: [],
    model: "openai/gpt-5",
  };
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [key, ...collectKeys(entry)]);
}
