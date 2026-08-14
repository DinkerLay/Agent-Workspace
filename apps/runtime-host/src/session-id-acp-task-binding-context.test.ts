import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  renderTaskGoalContentV1,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type JsonValue,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceAuthorizationRecord,
} from "@agent-workspace/runtime-contracts";
import { BUILT_IN_ACP_STARTER_PACKAGES } from "@agent-workspace/runtime-application";
import type {
  SessionIdInputSubmissionRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import { createAcpRuntimeHostPrivateAuthority } from "./acp-runtime-host-private-authority.js";
import {
  createSessionIdAcpTaskBindingContextOwner,
  type SessionIdAcpTaskBindingContextOwnerOptions,
  type SessionIdAcpTaskBindingContextRepositories,
} from "./session-id-acp-task-binding-context.js";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";

const NOW = "2026-08-12T16:00:00.000Z";
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const operation of cleanup.splice(0).reverse()) operation();
});

describe("Session-ID ACP Task Binding context owner", () => {
  it("returns the exact immutable v3 profile/role while keeping Host path and authority out of serialization", async () => {
    const fixture = createFixture("conductor");
    const context = await fixture.resolve();

    expect(context.role).toBe("conductor");
    expect(context.profile).toEqual(fixture.profile);
    expect(Object.isFrozen(context.profile)).toBe(true);
    expect(Object.isFrozen(context.profile.capabilityPolicy)).toBe(true);
    expect(Object.isFrozen(context.profile.capabilityPolicy.allowedTools)).toBe(true);
    expect(context.hostScope.authorizedWorkspaceDirectory).toBe(fixture.workspaceRoot);
    expect(context.hostScope.privateRootAuthority).toBe(
      fixture.privateAuthority.taskPrivateRootAuthority,
    );
    expect(Object.keys(context.hostScope).sort()).toEqual([
      "authorizedWorkspaceDirectory",
      "privateRootAuthority",
    ]);
    expect(JSON.stringify(context)).not.toContain(fixture.workspaceRoot);
    expect(JSON.stringify(context.hostScope)).toBe(
      JSON.stringify({ kind: "session_id_acp_task_host_execution_scope" }),
    );
    expect(JSON.stringify(fixture.owner)).toBe(
      JSON.stringify({ kind: "session_id_acp_task_binding_context_owner" }),
    );
    expect(JSON.stringify(context)).not.toMatch(/(?:raw|credential|resolution|nativeBindingRef)/iu);
  });

  it("admits the exact frozen bootstrap only until this LogicalSession has a Provider receipt", async () => {
    const conductor = createFixture("conductor");
    const conductorContext = await conductor.resolve();
    const conductorBootstrap = conductorContext.resolvePromptBootstrap?.({
      sessionExecutionAttemptId: conductor.attempt.sessionExecutionAttemptId,
    });

    expect(conductorBootstrap).toMatchObject({
      purpose: "task_conductor",
      kind: "conductor",
      title: conductor.architecture.definition.conductor.title,
      systemPrompt: conductor.architecture.definition.conductor.systemPrompt,
      dispatchRegistry: [{
        agentCardId: conductor.workerCardId,
        title: conductor.architecture.definition.agentCards[0]!.dispatchProfile!.title,
      }],
    });
    expect(JSON.stringify(conductorBootstrap)).not.toContain(
      conductor.architecture.definition.agentCards[0]!.systemPrompt,
    );

    conductor.state.priorAttempts = [Object.freeze({
      ...conductor.attempt,
      sessionExecutionAttemptId: "session_execution_attempt_context_conductor_prior",
      receiptDigest: `sha256:${"b".repeat(64)}`,
      receiptObservedAt: NOW,
      state: "settled" as const,
      revision: 2,
    })];
    expect(conductorContext.resolvePromptBootstrap?.({
      sessionExecutionAttemptId: conductor.attempt.sessionExecutionAttemptId,
    })).toBeUndefined();

    const worker = createFixture("worker");
    const workerContext = await worker.resolve();
    const workerBootstrap = workerContext.resolvePromptBootstrap?.({
      sessionExecutionAttemptId: worker.attempt.sessionExecutionAttemptId,
    });
    expect(workerBootstrap).toMatchObject({
      purpose: "task_worker",
      kind: worker.architecture.definition.agentCards[0]!.kind,
      title: worker.architecture.definition.agentCards[0]!.title,
      systemPrompt: worker.architecture.definition.agentCards[0]!.systemPrompt,
    });
    expect(workerBootstrap).not.toHaveProperty("dispatchRegistry");
    expect(JSON.stringify(workerBootstrap)).not.toContain(
      worker.architecture.definition.conductor.systemPrompt,
    );
  });

  it("fails before application construction on Profile, Workspace and current-Binding drift", async () => {
    const profileDrift = createFixture("worker");
    await expect(profileDrift.resolve({
      ...profileDrift.frozenProfile,
      profileRevisionId: "profile_revision_drifted",
    })).rejects.toThrow("session_id_acp_task_context_profile_fence_mismatch");
    expect(profileDrift.createRunApplication).not.toHaveBeenCalled();

    const workspaceDrift = createFixture("worker");
    workspaceDrift.state.authorization = {
      ...workspaceDrift.state.authorization,
      authorizedAt: "2026-08-12T16:00:01.000Z",
    };
    await expect(workspaceDrift.resolve()).rejects.toThrow(
      "session_id_acp_task_context_workspace_grant_drift",
    );
    expect(workspaceDrift.createRunApplication).not.toHaveBeenCalled();

    const bindingDrift = createFixture("worker");
    bindingDrift.state.currentBinding = {
      ...bindingDrift.binding,
      revision: 2,
      updatedAt: "2026-08-12T16:00:01.000Z",
    };
    await expect(bindingDrift.resolve()).rejects.toThrow(
      "session_id_acp_task_context_binding_not_current",
    );
    expect(bindingDrift.createRunApplication).not.toHaveBeenCalled();
  });

  it("dispatches exactly four Conductor tools, returns only public results, and drains every Host-only effect id", async () => {
    const fixture = createFixture("conductor");
    const resolved = await fixture.resolve();
    const turnContext = resolved.resolveTurnContext?.({
      sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
    });
    if (!turnContext) throw new Error("controlled_conductor_context_missing");
    expect(turnContext.capabilityClass).toBe("runtime_orchestration");

    const invoked = await turnContext.handleCall({
      providerCallId: "provider_call_invoke",
      name: "invoke_agent",
      arguments: { agentCardId: fixture.workerCardId },
      lease: turnContext.lease,
    });
    const sent = await turnContext.handleCall({
      providerCallId: "provider_call_send",
      name: "send_to_session",
      arguments: {
        sessionId: "logical_session_target",
        payload: { content: "One exact ACP assignment." },
      },
      lease: turnContext.lease,
    });
    const interrupted = await turnContext.handleCall({
      providerCallId: "provider_call_interrupt",
      name: "interrupt_session",
      arguments: { sessionId: "logical_session_target" },
      lease: turnContext.lease,
    });
    const closed = await turnContext.handleCall({
      providerCallId: "provider_call_close",
      name: "close_session",
      arguments: { sessionId: "logical_session_target" },
      lease: turnContext.lease,
    });

    expect(invoked.result).toEqual({ sessionId: "logical_session_created" });
    expect(sent.result).toEqual({ status: "accepted" });
    expect(interrupted.result).toEqual({ status: "accepted" });
    expect(closed.result).toEqual({ status: "closed" });
    expect(JSON.stringify([invoked, sent, interrupted, closed])).not.toMatch(
      /provider_effect_(?:interrupt|close)/u,
    );
    expect(fixture.commands.invokeAgent).toHaveBeenCalledTimes(1);
    expect(fixture.commands.sendToSession).toHaveBeenCalledTimes(1);
    expect(fixture.commands.interruptSession).toHaveBeenCalledTimes(1);
    expect(fixture.closeSession).toHaveBeenCalledTimes(1);
    expect(fixture.commands.closeSession).not.toHaveBeenCalled();
    expect(fixture.drainStagedEffect.mock.calls.map(([value]) => value)).toEqual([
      { providerEffectIntentId: "provider_effect_interrupt" },
    ]);
    expect(fixture.onRuntimeInvalidated).toHaveBeenCalledTimes(4);
  });

  it("mints the exact Conductor turn context after the provider durably marks the pre-effect attempt reconciling", async () => {
    const fixture = createFixture("conductor");
    fixture.state.runtime = {
      ...fixture.state.runtime,
      state: "reconciling",
      revision: fixture.state.runtime.revision + 1,
    };
    fixture.state.attempt = {
      ...fixture.state.attempt,
      state: "reconciling",
      revision: fixture.state.attempt.revision + 1,
    };

    const resolved = await fixture.resolve();
    const turnContext = resolved.resolveTurnContext?.({
      sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
    });

    expect(turnContext?.capabilityClass).toBe("runtime_orchestration");
    await expect(turnContext!.handleCall({
      providerCallId: "provider_call_reconciling_pre_effect",
      name: "invoke_agent",
      arguments: { agentCardId: fixture.workerCardId },
      lease: turnContext!.lease,
    })).resolves.toMatchObject({ result: { sessionId: "logical_session_created" } });
  });

  it("reports only a safe Host-local stage code when a pre-prompt Attempt fence is stale", async () => {
    const fixture = createFixture("conductor");
    const { activeAttemptId: _activeAttemptId, ...idleRuntime } = fixture.state.runtime;
    fixture.state.runtime = {
      ...idleRuntime,
      state: "idle",
      revision: fixture.state.runtime.revision + 1,
    };

    const resolved = await fixture.resolve();
    expect(() => resolved.resolveTurnContext?.({
      sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
    })).toThrow("conductor_tool_lease_stale");
    expect(fixture.onDiagnostic).toHaveBeenCalledWith({
      code: "runtime_fence_mismatch",
      role: "conductor",
      stage: "runtime",
    });
    expect(JSON.stringify(fixture.onDiagnostic.mock.calls)).not.toMatch(
      /(?:\/Users\/|binding_handle_|session_execution_attempt_)/u,
    );
  });

  it("propagates async close failures without effect drain and permits an exact tool-call retry", async () => {
    const fixture = createFixture("conductor");
    fixture.closeSession.mockRejectedValueOnce(new Error("controlled_close_failure"));
    const resolved = await fixture.resolve();
    const turnContext = resolved.resolveTurnContext?.({
      sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
    });
    if (!turnContext) throw new Error("controlled_conductor_context_missing");
    const call = {
      providerCallId: "provider_call_close_failure",
      name: "close_session" as const,
      arguments: { sessionId: "logical_session_target" },
      lease: turnContext.lease,
    };

    await expect(turnContext.handleCall(call)).rejects.toThrow("controlled_close_failure");
    expect(fixture.drainStagedEffect).not.toHaveBeenCalled();
    expect(fixture.onRuntimeInvalidated).not.toHaveBeenCalled();
    await expect(turnContext.handleCall(call)).resolves.toMatchObject({
      result: { status: "closed" },
    });
    expect(fixture.closeSession).toHaveBeenCalledTimes(2);
    expect(fixture.drainStagedEffect).not.toHaveBeenCalled();
  });

  it("lets an already-started close settle when the context owner closes, while revoking later calls", async () => {
    const fixture = createFixture("conductor");
    const started = deferred<void>();
    const settle = deferred<Readonly<{ status: "closed" }>>();
    fixture.closeSession.mockImplementationOnce(async () => {
      started.resolve();
      return settle.promise;
    });
    const resolved = await fixture.resolve();
    const turnContext = resolved.resolveTurnContext?.({
      sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
    });
    if (!turnContext) throw new Error("controlled_conductor_context_missing");
    const closing = turnContext.handleCall({
      providerCallId: "provider_call_close_during_owner_shutdown",
      name: "close_session",
      arguments: { sessionId: "logical_session_target" },
      lease: turnContext.lease,
    });
    await started.promise;
    fixture.owner.close();
    settle.resolve({ status: "closed" });

    await expect(closing).resolves.toMatchObject({ result: { status: "closed" } });
    expect(fixture.drainStagedEffect).not.toHaveBeenCalled();
    await expect(turnContext.handleCall({
      providerCallId: "provider_call_after_close_completion",
      name: "invoke_agent",
      arguments: { agentCardId: fixture.workerCardId },
      lease: turnContext.lease,
    })).rejects.toThrow("session_id_acp_task_context_owner_closed");
  });

  it("gives every ordinary Task role zero injected tools and revokes Conductor leases on cleanup", async () => {
    for (const role of ["publisher", "worker", "reviewer"] as const) {
      const fixture = createFixture(role);
      const resolved = await fixture.resolve();
      expect(resolved.role).toBe(role);
      expect(resolved.resolveTurnContext?.({
        sessionExecutionAttemptId: fixture.attempt.sessionExecutionAttemptId,
      })).toBeUndefined();
      expect(fixture.commands.invokeAgent).not.toHaveBeenCalled();
    }

    const conductor = createFixture("conductor");
    const resolved = await conductor.resolve();
    const turnContext = resolved.resolveTurnContext?.({
      sessionExecutionAttemptId: conductor.attempt.sessionExecutionAttemptId,
    });
    if (!turnContext) throw new Error("controlled_conductor_context_missing");
    conductor.owner.close();
    conductor.owner.close();
    await expect(turnContext.handleCall({
      providerCallId: "provider_call_after_close",
      name: "invoke_agent",
      arguments: { agentCardId: conductor.workerCardId },
      lease: turnContext.lease,
    })).rejects.toThrow("session_id_acp_task_context_owner_closed");
    await expect(conductor.resolve()).rejects.toThrow(
      "session_id_acp_task_context_owner_closed",
    );
    expect(conductor.commands.invokeAgent).not.toHaveBeenCalled();
  });
});

type FixtureRole = "conductor" | "publisher" | "worker" | "reviewer";

function createFixture(role: FixtureRole) {
  const workspaceRoot = realpathSync(mkdtempSync(path.join(tmpdir(), `acp-task-context-${role}-`)));
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), `acp-task-context-private-${role}-`));
  chmodSync(runtimeRoot, 0o700);
  cleanup.push(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  cleanup.push(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const { publicKey } = generateKeyPairSync("ed25519");
  const privateAuthority = createAcpRuntimeHostPrivateAuthority({
    runtimeDataDirectory: runtimeRoot,
    environment: {
      AGENT_WORKSPACE_ACP_HOST_EPOCH: `host_epoch_task_context_${role}`,
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
        format: "der",
        type: "spki",
      }).toString("base64url"),
    },
  });
  cleanup.push(() => privateAuthority.close());

  const resolver = createNodeWorkspaceDirectoryResolver();
  const authorization: WorkspaceAuthorizationRecord = {
    workspaceId: `workspace_task_context_${role}`,
    canonicalDirectory: workspaceRoot,
    displayName: "Task context workspace",
    authorizedAt: NOW,
  };
  const grantDigest = resolver.digestGrant({
    schemaVersion: 1,
    workspaceId: authorization.workspaceId,
    canonicalDirectory: authorization.canonicalDirectory,
    authorizedAt: authorization.authorizedAt,
  });
  const source = BUILT_IN_ACP_STARTER_PACKAGES.find(({ package: candidate }) =>
    candidate.template.slug === "opencode-acp-starter");
  if (!source) throw new Error("controlled_acp_template_missing");
  const base = source.package.definition;
  const originalWorker = base.agentCards[0]!;
  const originalProfile = base.executionProfiles.find((profile) =>
    profile.executionProfileId === originalWorker.executionProfileId)!;
  const selectedKind = role === "conductor" || role === "worker" ? "general" : role;
  const selectedCard = {
    ...originalWorker,
    kind: selectedKind,
    capabilityRefs: [],
  };
  const selectedProfile = {
    ...originalProfile,
    capabilityPolicy: {
      ...originalProfile.capabilityPolicy,
      allowedTools: [],
    },
  };
  const definition = {
    ...base,
    agentCards: [selectedCard],
    executionProfiles: base.executionProfiles.map((profile) =>
      profile.executionProfileId === selectedProfile.executionProfileId ? selectedProfile : profile),
  };
  const taskId = `task_context_${role}`;
  const runId = `run_context_${role}`;
  const conductorSessionId = `logical_session_context_${role}_conductor`;
  const cardSessionId = `logical_session_context_${role}_card`;
  const taskGoalContent = renderTaskGoalContentV1({
    title: "ACP Task context",
    goal: "Prove exact Host-only Binding and Attempt scope.",
    taskInputValues: [],
  }, definition.taskInputSchema);
  const architecture = validateTaskArchitectureSnapshotV3({
    schemaVersion: 3,
    architectureSnapshotId: `architecture_context_${role}`,
    taskId,
    templateId: source.package.template.templateId,
    templateVersionId: source.templateVersionId,
    templateDefinitionHash: hashDefinition(definition as unknown as JsonValue),
    definition,
    taskInputValues: [],
    taskTitle: "ACP Task context",
    taskGoal: "Prove exact Host-only Binding and Attempt scope.",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: { workspaceId: authorization.workspaceId, grantDigest },
    createdAt: NOW,
  });
  const boundCard = role === "conductor" ? architecture.definition.conductor : selectedCard;
  const profile = architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === boundCard.executionProfileId)!;
  const logicalSessionId = role === "conductor" ? conductorSessionId : cardSessionId;
  const task: TaskRecord = {
    taskId,
    architectureSnapshotId: architecture.architectureSnapshotId,
    title: architecture.taskTitle,
    goal: architecture.taskGoal,
    status: "running",
    activeRunId: runId,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const run: TaskRunRecord = {
    runId,
    taskId,
    conductorLogicalSessionId: conductorSessionId,
    status: "running",
    runNumber: 1,
    revision: 2,
    startedAt: NOW,
  };
  const binding: AcpSafeSessionBindingRecordV3 = {
    schemaVersion: 3,
    bindingId: `binding_context_${role}`,
    taskId,
    runId,
    logicalSessionId,
    agentCardId: boundCard.agentCardId,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    bindingHandle: `binding_handle_context_${role}`,
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const runtime: SessionExecutionRuntimeRecord = {
    sessionExecutionRuntimeId: `session_execution_runtime_context_${role}`,
    taskId,
    runId,
    logicalSessionId,
    state: "executing",
    activeAttemptId: `session_execution_attempt_context_${role}`,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const attempt: SessionExecutionAttemptRecord = {
    sessionExecutionAttemptId: runtime.activeAttemptId!,
    sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
    taskId,
    runId,
    logicalSessionId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    inputSubmissionId: `input_context_${role}`,
    orchestrationSessionTurnId: `session_turn_context_${role}`,
    state: "awaiting_receipt",
    interactions: [],
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const input: SessionIdInputSubmissionRecord = {
    inputSubmissionId: attempt.inputSubmissionId,
    taskId,
    runId,
    sessionId: logicalSessionId,
    sourceInboxItemId: `inbox_context_${role}`,
    contentMessageId: `message_context_${role}_input`,
    commandId: `command_context_${role}_input`,
    idempotencyKey: `context:${role}:input`,
    sequence: 1,
    state: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const turn: SessionIdSessionTurnRecord = {
    sessionTurnId: attempt.orchestrationSessionTurnId,
    taskId,
    runId,
    sessionId: logicalSessionId,
    inputSubmissionId: input.inputSubmissionId,
    trigger: role === "conductor" ? "task_goal" : "conductor_send",
    state: "pending",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const taskGoal: SessionIdSessionMessageRecord = {
    messageId: `message_context_${role}_task_goal`,
    taskId,
    runId,
    kind: "task_goal",
    content: architecture.taskGoalContent,
    canonicalContent: [{ kind: "text", text: architecture.taskGoalContent }],
    contentDigest: architecture.taskGoalContentDigest,
    createdAt: NOW,
  };
  const generation: CardSessionGenerationRecord = {
    sessionId: cardSessionId,
    taskId,
    runId,
    cardSessionSlotId: `card_session_slot_context_${role}`,
    agentCardId: selectedCard.agentCardId,
    executionProfileId: selectedCard.executionProfileId,
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
  const slot: CardSessionSlotRecord = {
    cardSessionSlotId: generation.cardSessionSlotId,
    taskId,
    runId,
    agentCardId: selectedCard.agentCardId,
    currentSessionId: cardSessionId,
    latestGeneration: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const state = {
    authorization,
    currentBinding: binding,
    runtime,
    attempt,
    priorAttempts: [] as SessionExecutionAttemptRecord[],
    input,
    turn,
  };
  const repositories: SessionIdAcpTaskBindingContextRepositories = {
    templateTask: {
      getTask: (value) => value === taskId ? structuredClone(task) : undefined,
      getRun: (value) => value === runId ? structuredClone(run) : undefined,
      getArchitectureSnapshot: (value) => value === taskId ? structuredClone(architecture) : undefined,
    },
    workspaceAuthorization: {
      getAuthorization: (value) => value === authorization.workspaceId
        ? structuredClone(state.authorization)
        : undefined,
    },
    taskRun: {
      readTaskRunState: (readTaskId, readRunId) => {
        if (readTaskId !== taskId || readRunId !== runId) throw new Error("controlled_run_missing");
        return {
          taskId,
          runId,
          taskRevision: task.revision,
          runStatus: run.status,
          currentConductorSessionTurnId: role === "conductor" ? turn.sessionTurnId : undefined,
        };
      },
      getConductorSessionId: (readTaskId, readRunId) => {
        if (readTaskId !== taskId || readRunId !== runId) throw new Error("controlled_run_missing");
        return conductorSessionId;
      },
      getGeneration: (value) => value === cardSessionId ? structuredClone(generation) : undefined,
      getSlot: (value) => value === slot.cardSessionSlotId ? structuredClone(slot) : undefined,
    },
    message: {
      listMessages: (value) => value === runId ? [structuredClone(taskGoal)] : [],
    },
    orchestration: {
      getInputSubmission: (value) => value === state.input.inputSubmissionId
        ? structuredClone(state.input)
        : undefined,
      getTurn: (value) => value === state.turn.sessionTurnId
        ? structuredClone(state.turn)
        : undefined,
    },
    binding: {
      getBinding: (value) => value === binding.bindingId
        ? structuredClone(state.currentBinding)
        : undefined,
      getCurrentBinding: (value) => value === logicalSessionId
        ? structuredClone(state.currentBinding)
        : undefined,
    },
    sessionRuntime: {
      getRuntime: (value) => value === state.runtime.sessionExecutionRuntimeId
        ? structuredClone(state.runtime)
        : undefined,
      getRuntimeForSession: (value) => value === logicalSessionId
        ? structuredClone(state.runtime)
        : undefined,
      getAttempt: (value) => value === state.attempt.sessionExecutionAttemptId
        ? structuredClone(state.attempt)
        : undefined,
      listAttempts: (value) => value === state.runtime.sessionExecutionRuntimeId
        ? structuredClone([...state.priorAttempts, state.attempt])
        : [],
    },
  };
  const commands = {
    invokeAgent: vi.fn(() => ({
      result: { sessionId: "logical_session_created" },
      providerEffectIntentIds: [],
    })),
    sendToSession: vi.fn(() => ({
      result: { status: "accepted" as const },
      providerEffectIntentIds: [],
    })),
    interruptSession: vi.fn(() => ({
      result: { status: "accepted" as const },
      providerEffectIntentIds: ["provider_effect_interrupt"],
    })),
    closeSession: vi.fn(() => ({
      result: { status: "closed" as const },
      providerEffectIntentIds: ["provider_effect_close"],
    })),
  };
  const closeSession = vi.fn(async () => ({ status: "closed" as const }));
  const drainStagedEffect = vi.fn(async (_input: Readonly<{ providerEffectIntentId: string }>) => ({
    disposition: "idle" as const,
    reason: "no_pending_inbox" as const,
  }));
  const createRunApplication = vi.fn(() => ({
    commandApplication: commands,
    closeSession,
    runtimePump: { drainStagedEffect },
  }));
  const onRuntimeInvalidated = vi.fn();
  const onDiagnostic = vi.fn();
  const options: SessionIdAcpTaskBindingContextOwnerOptions = {
    repositories,
    workspaceDirectoryResolver: resolver,
    acpApplication: { createRunApplication },
    privateAuthority,
    onRuntimeInvalidated,
    onDiagnostic,
  };
  const owner = createSessionIdAcpTaskBindingContextOwner(options);
  const frozenProfile = {
    schemaVersion: 3 as const,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
  };
  return {
    owner,
    privateAuthority,
    workspaceRoot,
    state,
    profile,
    architecture,
    binding,
    attempt,
    frozenProfile,
    workerCardId: architecture.definition.agentCards[0]!.agentCardId,
    commands,
    closeSession,
    drainStagedEffect,
    createRunApplication,
    onRuntimeInvalidated,
    onDiagnostic,
    resolve(override = frozenProfile) {
      return owner.resolveTaskBindingContext({ binding, frozenProfile: override });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
