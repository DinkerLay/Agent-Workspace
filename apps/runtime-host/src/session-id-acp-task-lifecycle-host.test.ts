import {
  hashDefinition,
  renderTaskGoalContentV1,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type JsonValue,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type TaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import {
  BUILT_IN_ACP_STARTER_PACKAGES,
  type SessionIdAcpTaskCommandFence,
  type SessionIdAcpTaskLifecycleOwnerCapabilities,
} from "@agent-workspace/runtime-application";
import { describe, expect, it } from "vitest";
import { createSessionIdAcpTaskLifecycleHost } from "./session-id-acp-task-lifecycle-host.js";

const NOW = "2026-08-12T08:00:00.000Z";
const LATER = "2026-08-12T08:00:01.000Z";

describe("Session-ID ACP Task lifecycle Host adapter", () => {
  it("prepares no effect, stages one current v3 Conductor Binding/runtime, and exactly replays", async () => {
    const ids = stableIds();
    const host = createSessionIdAcpTaskLifecycleHost({ now: () => NOW, createId: ids.create });
    const fixture = createOwnerFixture();
    const architecture = taskArchitecture("task_lifecycle_start");
    const fence = startFence({
      operation: "start",
      commandId: "command_lifecycle_start",
      taskId: architecture.taskId,
      runId: "run_lifecycle_start",
      logicalSessionId: "logical_session_lifecycle_start",
    });

    const prepared = await host.prepare({ architecture, commandFence: fence, owners: fixture.owners });
    expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0, attempts: 0 });
    expect(prepared).toEqual({
      schemaVersion: 3,
      operation: "start",
      taskId: architecture.taskId,
      runId: fence.runId,
      bindings: [{
        bindingId: "binding_host_1",
        bindingHandle: "binding_handle_host_1",
        logicalSessionId: fence.conductorLogicalSessionId,
        sessionExecutionRuntimeId: "session_execution_runtime_host_1",
        executionProfileId: architecture.definition.conductor.executionProfileId,
        profileRevisionId: architecture.definition.executionProfiles[0]!.profileRevisionId,
        providerFamily: "codex",
      }],
      providerEffectIntentIds: [],
    });
    expect(await host.prepare({ architecture, commandFence: fence, owners: fixture.owners })).toEqual(prepared);
    expect(ids.calls()).toEqual([
      "binding",
      "binding_handle",
      "session_execution_runtime",
    ]);
    expect(Object.keys(prepared).sort()).toEqual([
      "bindings", "operation", "providerEffectIntentIds", "runId", "schemaVersion", "taskId",
    ]);
    expect(Object.keys(prepared.bindings[0]!).sort()).toEqual([
      "bindingHandle", "bindingId", "executionProfileId", "logicalSessionId", "profileRevisionId",
      "providerFamily", "sessionExecutionRuntimeId",
    ]);
    expect(JSON.stringify(prepared)).not.toMatch(
      /"(?:cwd|nativeBindingRef|providerVersion|artifactVersion|resolution|credential|absolutePath|rawId|rawSessionId)"/iu,
    );

    host.stage({ architecture, commandFence: fence, prepared, owners: fixture.owners });
    expect(fixture.owners.binding.getCurrentBinding(fence.conductorLogicalSessionId)).toEqual({
      schemaVersion: 3,
      bindingId: prepared.bindings[0]!.bindingId,
      bindingHandle: prepared.bindings[0]!.bindingHandle,
      taskId: architecture.taskId,
      runId: fence.runId,
      logicalSessionId: fence.conductorLogicalSessionId,
      agentCardId: architecture.definition.conductor.agentCardId,
      executionProfileId: prepared.bindings[0]!.executionProfileId,
      profileRevisionId: prepared.bindings[0]!.profileRevisionId,
      providerFamily: prepared.bindings[0]!.providerFamily,
      status: "active",
      recoverable: true,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(fixture.owners.sessionRuntime.getRuntimeForSession(fence.conductorLogicalSessionId)).toEqual({
      sessionExecutionRuntimeId: prepared.bindings[0]!.sessionExecutionRuntimeId,
      taskId: architecture.taskId,
      runId: fence.runId,
      logicalSessionId: fence.conductorLogicalSessionId,
      state: "idle",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(fixture.writeCounts()).toEqual({ bindings: 1, runtimes: 1, attempts: 0 });

    host.stage({ architecture, commandFence: fence, prepared, owners: fixture.owners });
    expect(fixture.writeCounts()).toEqual({ bindings: 1, runtimes: 1, attempts: 0 });

    const restartFence = startFence({
      operation: "restart",
      commandId: "command_lifecycle_restart",
      taskId: architecture.taskId,
      runId: "run_lifecycle_restart",
      logicalSessionId: "logical_session_lifecycle_restart",
    });
    const restarted = await host.prepare({ architecture, commandFence: restartFence, owners: fixture.owners });
    expect(restarted.bindings[0]).toMatchObject({
      bindingId: "binding_host_2",
      bindingHandle: "binding_handle_host_2",
      sessionExecutionRuntimeId: "session_execution_runtime_host_2",
    });
  });

  it("resumes only the exact active recoverable current Binding and idle runtime with zero writes", async () => {
    const host = createSessionIdAcpTaskLifecycleHost({ now: () => NOW, createId: stableIds().create });
    const fixture = createOwnerFixture();
    const architecture = taskArchitecture("task_lifecycle_resume");
    const profile = architecture.definition.executionProfiles[0]!;
    const binding = bindingRecord({
      architecture,
      runId: "run_lifecycle_resume",
      logicalSessionId: "logical_session_lifecycle_resume",
      bindingId: "binding_lifecycle_resume",
      bindingHandle: "binding_handle_lifecycle_resume",
    });
    const runtime = runtimeRecord({
      architecture,
      runId: binding.runId,
      logicalSessionId: binding.logicalSessionId,
      runtimeId: "session_execution_runtime_lifecycle_resume",
    });
    fixture.seedBinding(binding, true);
    fixture.seedRuntime(runtime);
    const fence: SessionIdAcpTaskCommandFence = {
      operation: "resume",
      commandId: "command_lifecycle_resume",
      issuedAt: NOW,
      taskId: architecture.taskId,
      expectedTaskRevision: 2,
      runId: binding.runId,
      expectedRunRevision: 3,
      conductorLogicalSessionId: binding.logicalSessionId,
    };

    const prepared = await host.prepare({ architecture, commandFence: fence, owners: fixture.owners });
    expect(prepared.bindings).toEqual([{
      bindingId: binding.bindingId,
      bindingHandle: binding.bindingHandle,
      logicalSessionId: binding.logicalSessionId,
      sessionExecutionRuntimeId: runtime.sessionExecutionRuntimeId,
      executionProfileId: profile.executionProfileId,
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
    }]);
    host.stage({ architecture, commandFence: fence, prepared, owners: fixture.owners });
    host.stage({ architecture, commandFence: fence, prepared, owners: fixture.owners });
    expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0, attempts: 0 });

    const secondFence = { ...fence, commandId: "command_lifecycle_resume_changed" } as const;
    const secondPrepared = await host.prepare({
      architecture,
      commandFence: secondFence,
      owners: fixture.owners,
    });
    fixture.replaceRuntime({ ...runtime, revision: 2, updatedAt: LATER });
    expect(() => host.stage({
      architecture,
      commandFence: secondFence,
      prepared: secondPrepared,
      owners: fixture.owners,
    })).toThrow("acp_task_lifecycle_entry_snapshot_changed");
    expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0, attempts: 0 });
  });

  it("fails closed when the start entry changes between prepare and stage", async () => {
    const host = createSessionIdAcpTaskLifecycleHost({ now: () => NOW, createId: stableIds().create });
    const fixture = createOwnerFixture();
    const architecture = taskArchitecture("task_lifecycle_toctou");
    const fence = startFence({
      operation: "start",
      commandId: "command_lifecycle_toctou",
      taskId: architecture.taskId,
      runId: "run_lifecycle_toctou",
      logicalSessionId: "logical_session_lifecycle_toctou",
    });
    const prepared = await host.prepare({ architecture, commandFence: fence, owners: fixture.owners });
    fixture.seedBinding(bindingRecord({
      architecture,
      runId: fence.runId,
      logicalSessionId: fence.conductorLogicalSessionId,
      bindingId: "binding_lifecycle_racer",
      bindingHandle: "binding_handle_lifecycle_racer",
    }), true);

    expect(() => host.stage({ architecture, commandFence: fence, prepared, owners: fixture.owners }))
      .toThrow("acp_task_lifecycle_entry_snapshot_changed");
    expect(fixture.owners.binding.getBinding(prepared.bindings[0]!.bindingId)).toBeUndefined();
    expect(fixture.owners.sessionRuntime.getRuntime(prepared.bindings[0]!.sessionExecutionRuntimeId)).toBeUndefined();
    expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0, attempts: 0 });
  });

  it("rejects command replay drift, generated ID conflicts, and invalid resume ownership", async () => {
    const architecture = taskArchitecture("task_lifecycle_conflict");
    const fixture = createOwnerFixture();
    const ids = stableIds();
    const host = createSessionIdAcpTaskLifecycleHost({ now: () => NOW, createId: ids.create });
    const fence = startFence({
      operation: "start",
      commandId: "command_lifecycle_conflict",
      taskId: architecture.taskId,
      runId: "run_lifecycle_conflict",
      logicalSessionId: "logical_session_lifecycle_conflict",
    });
    await host.prepare({ architecture, commandFence: fence, owners: fixture.owners });
    await expect(host.prepare({
      architecture,
      commandFence: { ...fence, runId: "run_lifecycle_conflict_drift" },
      owners: fixture.owners,
    })).rejects.toThrow("acp_task_lifecycle_command_replay_conflict");

    const collisionFixture = createOwnerFixture();
    collisionFixture.seedBinding(bindingRecord({
      architecture,
      runId: "run_lifecycle_existing",
      logicalSessionId: "logical_session_lifecycle_existing",
      bindingId: "binding_existing",
      bindingHandle: "binding_handle_existing",
    }), true);
    const generated = ["binding_existing", "binding_handle_new", "session_execution_runtime_new"];
    const collisionHost = createSessionIdAcpTaskLifecycleHost({
      now: () => NOW,
      createId: () => generated.shift()!,
    });
    await expect(collisionHost.prepare({
      architecture,
      commandFence: startFence({
        operation: "start",
        commandId: "command_lifecycle_id_collision",
        taskId: architecture.taskId,
        runId: "run_lifecycle_id_collision",
        logicalSessionId: "logical_session_lifecycle_id_collision",
      }),
      owners: collisionFixture.owners,
    })).rejects.toThrow("acp_task_lifecycle_generated_id_conflict");

    const invalidResume = createOwnerFixture();
    const invalidBinding = {
      ...bindingRecord({
        architecture,
        runId: "run_lifecycle_invalid_resume",
        logicalSessionId: "logical_session_lifecycle_invalid_resume",
        bindingId: "binding_lifecycle_invalid_resume",
        bindingHandle: "binding_handle_lifecycle_invalid_resume",
      }),
      status: "recovering" as const,
    };
    invalidResume.seedBinding(invalidBinding, true);
    invalidResume.seedRuntime(runtimeRecord({
      architecture,
      runId: invalidBinding.runId,
      logicalSessionId: invalidBinding.logicalSessionId,
      runtimeId: "session_execution_runtime_lifecycle_invalid_resume",
    }));
    await expect(host.prepare({
      architecture,
      commandFence: {
        operation: "resume",
        commandId: "command_lifecycle_invalid_resume",
        issuedAt: NOW,
        taskId: architecture.taskId,
        expectedTaskRevision: 2,
        runId: invalidBinding.runId,
        expectedRunRevision: 2,
        conductorLogicalSessionId: invalidBinding.logicalSessionId,
      },
      owners: invalidResume.owners,
    })).rejects.toThrow("acp_task_lifecycle_resume_binding_not_recoverable");
  });

  it("does not expose cleanup, close, Provider, or native execution responsibilities", () => {
    const host = createSessionIdAcpTaskLifecycleHost({ now: () => NOW });
    expect(Object.keys(host).sort()).toEqual(["prepare", "stage"]);
    expect(host).not.toHaveProperty("close");
    expect(host).not.toHaveProperty("cleanup");
    expect(host).not.toHaveProperty("provider");
    expect(host).not.toHaveProperty("openNativeBinding");
  });
});

function taskArchitecture(taskId: string): TaskArchitectureSnapshotV3 {
  const source = BUILT_IN_ACP_STARTER_PACKAGES.find(({ package: candidate }) =>
    candidate.template.slug === "codex-acp-starter")!;
  const definition = source.package.definition;
  const taskGoalContent = renderTaskGoalContentV1({
    title: "Lifecycle contract",
    goal: "Stage the ACP-safe Conductor lifecycle.",
    taskInputValues: [],
  }, definition.taskInputSchema);
  return validateTaskArchitectureSnapshotV3({
    schemaVersion: 3,
    architectureSnapshotId: `architecture_${taskId}`,
    taskId,
    templateId: source.package.template.templateId,
    templateVersionId: source.templateVersionId,
    templateDefinitionHash: hashDefinition(definition as unknown as JsonValue),
    definition,
    taskInputValues: [],
    taskTitle: "Lifecycle contract",
    taskGoal: "Stage the ACP-safe Conductor lifecycle.",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: {
      workspaceId: "workspace_lifecycle_contract",
      grantDigest: `sha256:${"a".repeat(64)}`,
    },
    createdAt: NOW,
  });
}

function startFence(input: Readonly<{
  operation: "start" | "restart";
  commandId: string;
  taskId: string;
  runId: string;
  logicalSessionId: string;
}>): SessionIdAcpTaskCommandFence {
  return {
    operation: input.operation,
    commandId: input.commandId,
    issuedAt: NOW,
    taskId: input.taskId,
    expectedTaskRevision: 1,
    runId: input.runId,
    conductorLogicalSessionId: input.logicalSessionId,
  };
}

function bindingRecord(input: Readonly<{
  architecture: TaskArchitectureSnapshotV3;
  runId: string;
  logicalSessionId: string;
  bindingId: string;
  bindingHandle: string;
}>): AcpSafeSessionBindingRecordV3 {
  const profile = input.architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === input.architecture.definition.conductor.executionProfileId)!;
  return {
    schemaVersion: 3,
    bindingId: input.bindingId,
    taskId: input.architecture.taskId,
    runId: input.runId,
    logicalSessionId: input.logicalSessionId,
    agentCardId: input.architecture.definition.conductor.agentCardId,
    executionProfileId: profile.executionProfileId,
    profileRevisionId: profile.profileRevisionId,
    providerFamily: profile.providerFamily,
    bindingHandle: input.bindingHandle,
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeRecord(input: Readonly<{
  architecture: TaskArchitectureSnapshotV3;
  runId: string;
  logicalSessionId: string;
  runtimeId: string;
}>): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: input.runtimeId,
    taskId: input.architecture.taskId,
    runId: input.runId,
    logicalSessionId: input.logicalSessionId,
    state: "idle",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stableIds() {
  const counters = new Map<string, number>();
  const observed: string[] = [];
  return {
    create(kind: "binding" | "binding_handle" | "session_execution_runtime") {
      observed.push(kind);
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}_host_${next}`;
    },
    calls: () => [...observed],
  };
}

function createOwnerFixture() {
  const bindings = new Map<string, AcpSafeSessionBindingRecordV3>();
  const currentBindings = new Map<string, string>();
  const runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  const runtimeBySession = new Map<string, string>();
  const attempts = new Map<string, SessionExecutionAttemptRecord>();
  let bindingWrites = 0;
  let runtimeWrites = 0;
  let attemptWrites = 0;

  const owners: SessionIdAcpTaskLifecycleOwnerCapabilities = {
    binding: {
      createBinding(binding, { makeCurrent }) {
        if (bindings.has(binding.bindingId)) throw new Error("fake_binding_conflict");
        if (makeCurrent && currentBindings.has(binding.logicalSessionId)) throw new Error("fake_current_conflict");
        bindings.set(binding.bindingId, structuredClone(binding));
        if (makeCurrent) currentBindings.set(binding.logicalSessionId, binding.bindingId);
        bindingWrites += 1;
      },
      getBinding(bindingId) {
        return clone(bindings.get(bindingId));
      },
      getCurrentBinding(logicalSessionId) {
        const bindingId = currentBindings.get(logicalSessionId);
        return bindingId ? clone(bindings.get(bindingId)) : undefined;
      },
      listBindings(logicalSessionId) {
        return [...bindings.values()]
          .filter((binding) => binding.logicalSessionId === logicalSessionId)
          .map((binding) => structuredClone(binding));
      },
      listBindingsForRun(taskId, runId) {
        return [...bindings.values()]
          .filter((binding) => binding.taskId === taskId && binding.runId === runId)
          .map((binding) => structuredClone(binding));
      },
      updateBinding() {
        throw new Error("fake_binding_update_forbidden");
      },
    },
    sessionRuntime: {
      createRuntime(runtime) {
        if (runtimes.has(runtime.sessionExecutionRuntimeId)
          || runtimeBySession.has(runtime.logicalSessionId)) throw new Error("fake_runtime_conflict");
        runtimes.set(runtime.sessionExecutionRuntimeId, structuredClone(runtime));
        runtimeBySession.set(runtime.logicalSessionId, runtime.sessionExecutionRuntimeId);
        runtimeWrites += 1;
      },
      getRuntime(runtimeId) {
        return clone(runtimes.get(runtimeId));
      },
      getRuntimeForSession(logicalSessionId) {
        const runtimeId = runtimeBySession.get(logicalSessionId);
        return runtimeId ? clone(runtimes.get(runtimeId)) : undefined;
      },
      updateRuntime() {
        throw new Error("fake_runtime_update_forbidden");
      },
      createAttempt(attempt) {
        if (attempts.has(attempt.sessionExecutionAttemptId)) throw new Error("fake_attempt_conflict");
        attempts.set(attempt.sessionExecutionAttemptId, structuredClone(attempt));
        attemptWrites += 1;
      },
      getAttempt(attemptId) {
        return clone(attempts.get(attemptId));
      },
      listAttempts(runtimeId) {
        return [...attempts.values()]
          .filter((attempt) => attempt.sessionExecutionRuntimeId === runtimeId)
          .map((attempt) => structuredClone(attempt));
      },
      updateAttempt() {
        throw new Error("fake_attempt_update_forbidden");
      },
    },
  };

  return {
    owners,
    seedBinding(binding: AcpSafeSessionBindingRecordV3, makeCurrent: boolean) {
      bindings.set(binding.bindingId, structuredClone(binding));
      if (makeCurrent) currentBindings.set(binding.logicalSessionId, binding.bindingId);
    },
    seedRuntime(runtime: SessionExecutionRuntimeRecord) {
      runtimes.set(runtime.sessionExecutionRuntimeId, structuredClone(runtime));
      runtimeBySession.set(runtime.logicalSessionId, runtime.sessionExecutionRuntimeId);
    },
    replaceRuntime(runtime: SessionExecutionRuntimeRecord) {
      runtimes.set(runtime.sessionExecutionRuntimeId, structuredClone(runtime));
      runtimeBySession.set(runtime.logicalSessionId, runtime.sessionExecutionRuntimeId);
    },
    writeCounts: () => ({ bindings: bindingWrites, runtimes: runtimeWrites, attempts: attemptWrites }),
  };
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
