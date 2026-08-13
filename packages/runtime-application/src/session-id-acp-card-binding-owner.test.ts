import {
  hashDefinition,
  renderTaskGoalContentV1,
  validateTaskArchitectureSnapshotV3,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type JsonValue,
  type SessionExecutionRuntimeRecord,
  type TaskArchitectureSnapshotV3,
  type TaskRunRecord,
} from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ACP_STARTER_PACKAGES } from "./built-in-templates.js";
import {
  createSessionIdAcpCardBindingOwner,
  type SessionIdAcpCardBindingOwnerCapabilities,
} from "./session-id-acp-card-binding-owner.js";

const NOW = "2026-08-12T09:00:00.000Z";

describe("Session-ID ACP first-delivery Card Binding owner", () => {
  it("derives the frozen Card tuple, creates one current v3 Binding/idle SR, and replays without writes", () => {
    const fixture = createFixture();
    const ids = stableIds();
    const owner = createSessionIdAcpCardBindingOwner({
      now: () => NOW,
      createId: ids.create,
      transaction: fixture.transaction,
    });

    const created = owner.ensureCurrentCardBinding({ logicalSessionId: fixture.generation.sessionId });
    expect(created).toEqual({
      disposition: "created",
      taskId: fixture.generation.taskId,
      runId: fixture.generation.runId,
      logicalSessionId: fixture.generation.sessionId,
      agentCardId: fixture.generation.agentCardId,
      executionProfileId: fixture.profile.executionProfileId,
      profileRevisionId: fixture.profile.profileRevisionId,
      providerFamily: fixture.profile.providerFamily,
      bindingId: "binding_card_1",
      bindingHandle: "binding_handle_card_1",
      sessionExecutionRuntimeId: "session_execution_runtime_card_1",
    });
    expect(fixture.currentBinding()).toEqual({
      schemaVersion: 3,
      bindingId: created.bindingId,
      taskId: created.taskId,
      runId: created.runId,
      logicalSessionId: created.logicalSessionId,
      agentCardId: created.agentCardId,
      executionProfileId: created.executionProfileId,
      profileRevisionId: created.profileRevisionId,
      providerFamily: created.providerFamily,
      bindingHandle: created.bindingHandle,
      status: "active",
      recoverable: true,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(fixture.currentRuntime()).toEqual({
      sessionExecutionRuntimeId: created.sessionExecutionRuntimeId,
      taskId: created.taskId,
      runId: created.runId,
      logicalSessionId: created.logicalSessionId,
      state: "idle",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(fixture.writeCounts()).toEqual({ bindings: 1, runtimes: 1 });

    expect(owner.ensureCurrentCardBinding({ logicalSessionId: fixture.generation.sessionId })).toEqual({
      ...created,
      disposition: "replay",
    });
    expect(fixture.writeCounts()).toEqual({ bindings: 1, runtimes: 1 });
    expect(ids.calls()).toEqual(["binding", "binding_handle", "session_execution_runtime"]);
    expect(Object.keys(owner)).toEqual(["ensureCurrentCardBinding"]);
    expect(JSON.stringify(created)).not.toMatch(
      /"(?:cwd|nativeBindingRef|providerVersion|artifactVersion|resolution|credential|absolutePath|rawId|rawSessionId)"/iu,
    );
  });

  it("rejects a non-current generation, stale Slot pointer, and caller-free Profile drift before writes", () => {
    const cases: Array<Readonly<{
      mutate(fixture: Fixture): void;
      error: string;
    }>> = [{
      mutate: (fixture) => fixture.replaceGeneration({ ...fixture.generation, lifecycle: "closed", closedAt: NOW }),
      error: "session_id_acp_card_generation_not_current",
    }, {
      mutate: (fixture) => fixture.replaceSlot({ ...fixture.slot, currentSessionId: "logical_session_other" }),
      error: "session_id_acp_card_slot_not_current",
    }, {
      mutate: (fixture) => fixture.replaceGeneration({
        ...fixture.generation,
        executionProfileId: "profile_forged",
      }),
      error: "session_id_acp_card_profile_scope_mismatch",
    }, {
      mutate: (fixture) => fixture.replaceRun({ ...fixture.run, status: "stopped", endedAt: NOW }),
      error: "session_id_acp_card_run_not_active",
    }];

    for (const testCase of cases) {
      const fixture = createFixture();
      testCase.mutate(fixture);
      const owner = createOwner(fixture);
      expect(() => owner.ensureCurrentCardBinding({ logicalSessionId: fixture.generation.sessionId }))
        .toThrow(testCase.error);
      expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0 });
    }
  });

  it("fails closed for active history without a pointer and every partial Binding/runtime pair", () => {
    const activeHistory = createFixture();
    activeHistory.seedBinding(bindingRecord(activeHistory), false);
    expect(() => createOwner(activeHistory).ensureCurrentCardBinding({
      logicalSessionId: activeHistory.generation.sessionId,
    })).toThrow("session_id_acp_card_binding_history_without_current");

    const runtimeOnly = createFixture();
    runtimeOnly.seedRuntime(runtimeRecord(runtimeOnly));
    expect(() => createOwner(runtimeOnly).ensureCurrentCardBinding({
      logicalSessionId: runtimeOnly.generation.sessionId,
    })).toThrow("session_id_acp_card_binding_runtime_partial");

    const bindingOnly = createFixture();
    bindingOnly.seedBinding(bindingRecord(bindingOnly), true);
    expect(() => createOwner(bindingOnly).ensureCurrentCardBinding({
      logicalSessionId: bindingOnly.generation.sessionId,
    })).toThrow("session_id_acp_card_binding_runtime_partial");

    for (const fixture of [activeHistory, runtimeOnly, bindingOnly]) {
      expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0 });
    }
  });

  it("rolls back the Binding when the paired Runtime write fails", () => {
    const fixture = createFixture();
    fixture.failRuntimeCreate();
    expect(() => createOwner(fixture).ensureCurrentCardBinding({
      logicalSessionId: fixture.generation.sessionId,
    })).toThrow("controlled_runtime_write_failure");
    expect(fixture.currentBinding()).toBeUndefined();
    expect(fixture.currentRuntime()).toBeUndefined();
    expect(fixture.bindingCount()).toBe(0);
    expect(fixture.runtimeCount()).toBe(0);
    expect(fixture.writeCounts()).toEqual({ bindings: 1, runtimes: 1 });
  });

  it("rechecks the TaskRun/Architecture entry fence after ID allocation and rejects TOCTOU", () => {
    const fixture = createFixture();
    const ids = stableIds(() => {
      fixture.replaceSlot({ ...fixture.slot, currentSessionId: "logical_session_raced" });
    });
    const owner = createSessionIdAcpCardBindingOwner({
      now: () => NOW,
      createId: ids.create,
      transaction: fixture.transaction,
    });
    expect(() => owner.ensureCurrentCardBinding({ logicalSessionId: fixture.generation.sessionId }))
      .toThrow("session_id_acp_card_entry_fence_changed");
    expect(fixture.bindingCount()).toBe(0);
    expect(fixture.runtimeCount()).toBe(0);
    expect(fixture.writeCounts()).toEqual({ bindings: 0, runtimes: 0 });
  });

  it("accepts only the exact public logicalSessionId input and never runs a transaction for private fields", () => {
    const fixture = createFixture();
    const owner = createOwner(fixture);
    expect(() => owner.ensureCurrentCardBinding({
      logicalSessionId: fixture.generation.sessionId,
      cwd: "/private/workspace",
    } as never)).toThrow("session_execution_private_field_forbidden");
    expect(() => owner.ensureCurrentCardBinding({
      logicalSessionId: fixture.generation.sessionId,
      profileRevisionId: fixture.profile.profileRevisionId,
    } as never)).toThrow("session_id_acp_card_binding_input_shape_invalid");
    expect(() => owner.ensureCurrentCardBinding({ logicalSessionId: "logical_session/../../raw" }))
      .toThrow("session_id_acp_card_logical_session_id_invalid");
    expect(fixture.transactionCalls()).toBe(0);
  });
});

type Fixture = ReturnType<typeof createFixture>;

function createOwner(fixture: Fixture) {
  return createSessionIdAcpCardBindingOwner({
    now: () => NOW,
    createId: stableIds().create,
    transaction: fixture.transaction,
  });
}

function createFixture() {
  const architecture = taskArchitecture("task_card_binding");
  const card = architecture.definition.agentCards[0]!;
  const profile = architecture.definition.executionProfiles.find((candidate) =>
    candidate.executionProfileId === card.executionProfileId)!;
  let run: TaskRunRecord = {
    runId: "run_card_binding",
    taskId: architecture.taskId,
    conductorLogicalSessionId: "logical_session_card_binding_conductor",
    status: "running",
    runNumber: 1,
    startedAt: NOW,
    revision: 2,
  };
  let slot: CardSessionSlotRecord = {
    cardSessionSlotId: "card_session_slot_card_binding",
    taskId: architecture.taskId,
    runId: run.runId,
    agentCardId: card.agentCardId,
    currentSessionId: "logical_session_card_binding_worker",
    latestGeneration: 1,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  let generation: CardSessionGenerationRecord = {
    sessionId: slot.currentSessionId!,
    cardSessionSlotId: slot.cardSessionSlotId,
    taskId: architecture.taskId,
    runId: run.runId,
    agentCardId: card.agentCardId,
    executionProfileId: card.executionProfileId,
    generation: 1,
    lifecycle: "current",
    createdAt: NOW,
  };
  const bindings = new Map<string, AcpSafeSessionBindingRecordV3>();
  const currentBindings = new Map<string, string>();
  const runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  const runtimeBySession = new Map<string, string>();
  let bindingWrites = 0;
  let runtimeWrites = 0;
  let transactionCalls = 0;
  let rejectRuntimeCreate = false;

  const capabilities: SessionIdAcpCardBindingOwnerCapabilities = {
    taskRun: {
      getGeneration: (logicalSessionId) => logicalSessionId === generation.sessionId
        ? structuredClone(generation)
        : undefined,
      getSlot: (cardSessionSlotId) => cardSessionSlotId === slot.cardSessionSlotId
        ? structuredClone(slot)
        : undefined,
      readTaskRunState: (taskId, runId) => {
        if (taskId !== run.taskId || runId !== run.runId) throw new Error("controlled_run_scope_mismatch");
        return {
          taskId: run.taskId,
          runId: run.runId,
          taskRevision: 3,
          runStatus: run.status,
        };
      },
    },
    architecture: {
      getArchitectureSnapshot: (taskId) => taskId === architecture.taskId
        ? structuredClone(architecture)
        : undefined,
    },
    binding: {
      createBinding(binding, { makeCurrent }) {
        bindingWrites += 1;
        if (bindings.has(binding.bindingId)) throw new Error("controlled_binding_id_conflict");
        if ([...bindings.values()].some((candidate) => candidate.bindingHandle === binding.bindingHandle)) {
          throw new Error("controlled_binding_handle_conflict");
        }
        if (makeCurrent && currentBindings.has(binding.logicalSessionId)) {
          throw new Error("controlled_binding_current_conflict");
        }
        bindings.set(binding.bindingId, structuredClone(binding));
        if (makeCurrent) currentBindings.set(binding.logicalSessionId, binding.bindingId);
      },
      getBinding: (bindingId) => clone(bindings.get(bindingId)),
      getCurrentBinding(logicalSessionId) {
        const bindingId = currentBindings.get(logicalSessionId);
        return bindingId ? clone(bindings.get(bindingId)) : undefined;
      },
      listBindings: (logicalSessionId) => [...bindings.values()]
        .filter((binding) => binding.logicalSessionId === logicalSessionId)
        .map((binding) => structuredClone(binding)),
    },
    sessionRuntime: {
      createRuntime(runtime) {
        runtimeWrites += 1;
        if (rejectRuntimeCreate) throw new Error("controlled_runtime_write_failure");
        if (runtimes.has(runtime.sessionExecutionRuntimeId)
          || runtimeBySession.has(runtime.logicalSessionId)) throw new Error("controlled_runtime_conflict");
        runtimes.set(runtime.sessionExecutionRuntimeId, structuredClone(runtime));
        runtimeBySession.set(runtime.logicalSessionId, runtime.sessionExecutionRuntimeId);
      },
      getRuntime: (runtimeId) => clone(runtimes.get(runtimeId)),
      getRuntimeForSession(logicalSessionId) {
        const runtimeId = runtimeBySession.get(logicalSessionId);
        return runtimeId ? clone(runtimes.get(runtimeId)) : undefined;
      },
    },
  };

  const transaction = {
    run<T>(work: (owners: SessionIdAcpCardBindingOwnerCapabilities) => T): T {
      transactionCalls += 1;
      const before = {
        bindings: structuredClone([...bindings]),
        currentBindings: structuredClone([...currentBindings]),
        runtimes: structuredClone([...runtimes]),
        runtimeBySession: structuredClone([...runtimeBySession]),
      };
      try {
        return work(capabilities);
      } catch (error) {
        restoreMap(bindings, before.bindings);
        restoreMap(currentBindings, before.currentBindings);
        restoreMap(runtimes, before.runtimes);
        restoreMap(runtimeBySession, before.runtimeBySession);
        throw error;
      }
    },
  };

  return {
    architecture,
    card,
    profile,
    get run() { return run; },
    get slot() { return slot; },
    get generation() { return generation; },
    transaction,
    replaceRun: (value: TaskRunRecord) => { run = structuredClone(value); },
    replaceSlot: (value: CardSessionSlotRecord) => { slot = structuredClone(value); },
    replaceGeneration: (value: CardSessionGenerationRecord) => { generation = structuredClone(value); },
    seedBinding(binding: AcpSafeSessionBindingRecordV3, makeCurrent: boolean) {
      bindings.set(binding.bindingId, structuredClone(binding));
      if (makeCurrent) currentBindings.set(binding.logicalSessionId, binding.bindingId);
    },
    seedRuntime(runtime: SessionExecutionRuntimeRecord) {
      runtimes.set(runtime.sessionExecutionRuntimeId, structuredClone(runtime));
      runtimeBySession.set(runtime.logicalSessionId, runtime.sessionExecutionRuntimeId);
    },
    failRuntimeCreate: () => { rejectRuntimeCreate = true; },
    currentBinding: () => {
      const bindingId = currentBindings.get(generation.sessionId);
      return bindingId ? clone(bindings.get(bindingId)) : undefined;
    },
    currentRuntime: () => {
      const runtimeId = runtimeBySession.get(generation.sessionId);
      return runtimeId ? clone(runtimes.get(runtimeId)) : undefined;
    },
    bindingCount: () => bindings.size,
    runtimeCount: () => runtimes.size,
    writeCounts: () => ({ bindings: bindingWrites, runtimes: runtimeWrites }),
    transactionCalls: () => transactionCalls,
  };
}

function taskArchitecture(taskId: string): TaskArchitectureSnapshotV3 {
  const source = BUILT_IN_ACP_STARTER_PACKAGES.find(({ package: candidate }) =>
    candidate.template.slug === "codex-acp-starter")!;
  const definition = source.package.definition;
  const taskGoalContent = renderTaskGoalContentV1({
    title: "Card Binding contract",
    goal: "Materialize the first-delivery Card execution owner.",
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
    taskTitle: "Card Binding contract",
    taskGoal: "Materialize the first-delivery Card execution owner.",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: {
      workspaceId: "workspace_card_binding_contract",
      grantDigest: `sha256:${"b".repeat(64)}`,
    },
    createdAt: NOW,
  });
}

function bindingRecord(fixture: Fixture): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_card_existing",
    taskId: fixture.generation.taskId,
    runId: fixture.generation.runId,
    logicalSessionId: fixture.generation.sessionId,
    agentCardId: fixture.generation.agentCardId,
    executionProfileId: fixture.profile.executionProfileId,
    profileRevisionId: fixture.profile.profileRevisionId,
    providerFamily: fixture.profile.providerFamily,
    bindingHandle: "binding_handle_card_existing",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeRecord(fixture: Fixture): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_card_existing",
    taskId: fixture.generation.taskId,
    runId: fixture.generation.runId,
    logicalSessionId: fixture.generation.sessionId,
    state: "idle",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function stableIds(onFirst?: () => void) {
  const counters = new Map<string, number>();
  const observed: string[] = [];
  return {
    create(kind: "binding" | "binding_handle" | "session_execution_runtime") {
      observed.push(kind);
      if (observed.length === 1) onFirst?.();
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}_card_${next}`;
    },
    calls: () => [...observed],
  };
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function restoreMap<K, V>(target: Map<K, V>, entries: Array<[K, V]>): void {
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}
