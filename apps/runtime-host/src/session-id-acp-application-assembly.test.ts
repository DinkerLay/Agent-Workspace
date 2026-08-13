import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  renderTaskGoalContentV1,
  type AcpV3BindingRetirementIntentRecord,
  type JsonValue,
  type SessionExecutionSettlement,
  type SessionRuntimeProviderEffectIntentRecord,
  type TaskRecord,
  type TaskRunRecord,
} from "@agent-workspace/runtime-contracts";
import {
  createTaskArchitectureSnapshotV3,
  materializeCardSessionGeneration,
} from "@agent-workspace/runtime-domain";
import {
  BUILT_IN_ACP_STARTER_PACKAGES,
  createAcpV3FrozenProfileTupleResolver,
} from "@agent-workspace/runtime-application";
import {
  createAcpSessionRuntimeRepositories,
  createRuntimeRepositories,
  createSessionIdCanonicalStore,
  type AcpSessionRuntimeRepositories,
  SqliteRuntimeStore,
} from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpApplicationAssembly,
} from "./session-id-acp-application-assembly.js";

const NOW = "2026-08-12T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Session-ID provider-neutral ACP application assembly", () => {
  it("is constructor-side-effect-free, seals direct drain before provider creation, and blocks later direct writers", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-open-");
    const events: string[] = [];
    const providerClose = vi.fn(async () => undefined);
    const recoveryAuthority = vi.fn(() => false);
    let providerRecoveryAuthority: ((intent: AcpV3BindingRetirementIntentRecord) => boolean) | undefined;
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: () => NOW,
      createId: (kind) => `${kind}_assembly_1`,
      authorizeRetiringBindingRecovery: recoveryAuthority,
      createProvider: async ({ onDeliveryReceipt, authorizeRetiringBindingRecovery }) => {
        providerRecoveryAuthority = authorizeRetiringBindingRecovery;
        expect(authorizeRetiringBindingRecovery).not.toBe(recoveryAuthority);
        const seal = fixture.store.one<{ value: string }>(
          "SELECT value FROM runtime_meta WHERE key = 'acp_direct_binding_cutover_sealed'",
        );
        events.push(`provider:${seal?.value ?? "missing"}`);
        await expect(onDeliveryReceipt({
          providerEffectIntentId: "provider_effect_unbound_receipt",
          taskId: "task_unbound_receipt",
          runId: "run_unbound_receipt",
          logicalSessionId: "logical_session_unbound_receipt",
          sessionExecutionRuntimeId: "session_execution_runtime_unbound_receipt",
          sessionExecutionAttemptId: "session_execution_attempt_unbound_receipt",
          bindingId: "binding_unbound_receipt",
          bindingRevision: 1,
          executionProfileId: "profile_unbound_receipt",
          profileRevisionId: "profile_revision_unbound_receipt",
          bindingHandle: "binding_handle_unbound_receipt",
          inputSubmissionId: "input_unbound_receipt",
          orchestrationSessionTurnId: "session_turn_unbound_receipt",
          receiptDigest: `sha256:${"a".repeat(64)}`,
        })).rejects.toThrow("session_id_acp_receipt_owner_not_bound");
        return {
          provider: {
            executeProviderEffect: async () => {
              throw new Error("controlled_provider_not_exercised");
            },
            retireBinding: async () => {
              throw new Error("controlled_provider_not_exercised");
            },
            retireBindingForClose: async () => {
              throw new Error("controlled_provider_not_exercised");
            },
          },
          close: providerClose,
        };
      },
    });

    expect(events).toEqual([]);
    expect(fixture.store.one(
      "SELECT value FROM runtime_meta WHERE key = 'acp_direct_binding_cutover_sealed'",
    )).toBeUndefined();

    const ready = await assembly.open();
    expect(events).toEqual(["provider:1"]);
    expect(ready.drainSeal).toMatchObject({ blocking: 0, total: 0 });
    expect(JSON.stringify(ready)).not.toMatch(/(?:cwd|rawSession|nativeBindingRef|credential)/iu);
    const currentHostRetiring = seedRetiringBinding(fixture.store, "current_host");
    expect(providerRecoveryAuthority?.(currentHostRetiring)).toBe(false);
    expect(recoveryAuthority).not.toHaveBeenCalled();

    const direct = createSessionIdCanonicalStore(fixture.store);
    expect(() => direct.binding.createBinding({
      bindingId: "binding_direct_after_assembly",
      taskId: "task_missing_but_seal_wins",
      runId: "run_missing_but_seal_wins",
      sessionId: "logical_session_missing_but_seal_wins",
      agentCardId: "agent_card_missing_but_seal_wins",
      executionProfileId: "profile_missing_but_seal_wins",
      provider: "opencode",
      status: "unbound",
      recoverable: false,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })).toThrow("session_id_direct_binding_cutover_sealed");

    await ready.close();
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(recoveryAuthority).not.toHaveBeenCalled();
    fixture.store.close();
  });

  it("authorizes one exact pre-provider retiring snapshot and rejects revision drift or replay", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-retiring-snapshot-");
    const startupRetiring = seedRetiringBinding(fixture.store, "predecessor");
    const supervisorAuthority = vi.fn(() => true);
    const observed: boolean[] = [];
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: () => NOW,
      createId: (kind: string) => `${kind}_snapshot_1`,
      authorizeRetiringBindingRecovery: supervisorAuthority,
      createProvider: ({ authorizeRetiringBindingRecovery }) => {
        observed.push(authorizeRetiringBindingRecovery({
          ...startupRetiring,
          attempts: startupRetiring.attempts + 1,
          revision: startupRetiring.revision + 1,
          updatedAt: "2026-08-12T12:00:02.000Z",
        }));
        observed.push(authorizeRetiringBindingRecovery(startupRetiring));
        observed.push(authorizeRetiringBindingRecovery(startupRetiring));
        return controlledProviderOwner();
      },
    });

    const ready = await assembly.open();
    expect(observed).toEqual([false, true, false]);
    expect(supervisorAuthority).toHaveBeenCalledTimes(1);
    expect(supervisorAuthority).toHaveBeenCalledWith(startupRetiring);
    await ready.close();
    fixture.store.close();
  });

  it("requires an explicit predecessor-Host recovery authority without sealing or creating a provider", () => {
    const fixture = createStore("agent-workspace-acp-assembly-recovery-authority-");
    const createProvider = vi.fn(() => controlledProviderOwner());
    expect(() => createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: () => NOW,
      createId: (kind: string) => `${kind}_authority_1`,
      createProvider,
    } as never)).toThrow("session_id_acp_application_assembly_options_invalid");
    expect(createProvider).not.toHaveBeenCalled();
    expect(fixture.store.one(
      "SELECT value FROM runtime_meta WHERE key = 'acp_direct_binding_cutover_sealed'",
    )).toBeUndefined();
    fixture.store.close();
  });

  it("does not create a provider or seal when a blocking direct Binding exists", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-blocked-");
    seedBlockingDirectBinding(fixture.store);
    const createProvider = vi.fn(() => controlledProviderOwner());
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: () => NOW,
      createId: (kind) => `${kind}_blocked_1`,
      authorizeRetiringBindingRecovery: () => false,
      createProvider,
    });

    await expect(assembly.open()).rejects.toThrow("acp_v3_direct_bindings_not_drained:1");
    expect(createProvider).not.toHaveBeenCalled();
    expect(fixture.store.one(
      "SELECT value FROM runtime_meta WHERE key = 'acp_direct_binding_cutover_sealed'",
    )).toBeUndefined();
    fixture.store.close();
  });

  it("closes an already-created provider capability when readiness construction rejects it", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-cleanup-");
    const close = vi.fn(async () => undefined);
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: () => NOW,
      createId: (kind) => `${kind}_cleanup_1`,
      authorizeRetiringBindingRecovery: () => false,
      createProvider: () => ({
        provider: {
          executeProviderEffect: async () => { throw new Error("controlled_provider_not_exercised"); },
          retireBinding: async () => { throw new Error("controlled_provider_not_exercised"); },
        },
        close,
      } as never),
    });

    await expect(assembly.open()).rejects.toThrow("session_id_acp_application_provider_invalid");
    expect(close).toHaveBeenCalledTimes(1);
    fixture.store.close();
  });

  it("shares one SQLite rollback boundary and commits receipt, canonical Final, and replay exactly once", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-flow-");
    const seeded = seedAcpRun(fixture.store);
    const ids = controlledIds();
    const providerExecutions: string[] = [];
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: monotonicNow(),
      createId: ids.create,
      authorizeRetiringBindingRecovery: () => false,
      createProvider: ({ repositories, sessionRuntimeOwner, onDeliveryReceipt }) => ({
        provider: {
          async executeProviderEffect(providerEffectIntentId) {
            providerExecutions.push(providerEffectIntentId);
            const intent = repositories.reliability.getProviderEffectIntent(providerEffectIntentId);
            if (!intent) throw new Error("controlled_provider_intent_missing");
            const existing = repositories.sessionRuntime.getAttempt(intent.sessionExecutionAttemptId);
            if (!existing) throw new Error("controlled_provider_attempt_missing");
            if (existing.settlement) return settledProviderResult(intent, existing.settlement, true);
            const receiptDigest = `sha256:${"d".repeat(64)}`;
            const first = sessionRuntimeOwner.handleDeliveryReceipt({
              ...observationScope(existing),
              receiptDigest,
            });
            await onDeliveryReceipt({
              providerEffectIntentId,
              taskId: intent.taskId,
              runId: intent.runId,
              logicalSessionId: intent.logicalSessionId,
              sessionExecutionRuntimeId: intent.sessionExecutionRuntimeId,
              sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
              bindingId: intent.bindingId,
              bindingRevision: intent.bindingRevision,
              executionProfileId: intent.executionProfileId,
              profileRevisionId: intent.profileRevisionId,
              bindingHandle: intent.effect.bindingHandle,
              inputSubmissionId: intent.inputSubmissionId,
              orchestrationSessionTurnId: intent.orchestrationSessionTurnId,
              receiptDigest,
            });
            const afterReceipt = first.attempt;
            const finalContent = "One canonical ACP worker Final.";
            const second = sessionRuntimeOwner.handleFinalCandidate({
              ...observationScope(afterReceipt),
              candidateObservationId: "provider_fact_candidate_assembly_1",
              content: finalContent,
              contentDigest: hashDefinition(finalContent),
            });
            const third = sessionRuntimeOwner.handlePromptTerminal({
              ...observationScope(second.attempt),
              terminalObservationId: "provider_fact_terminal_assembly_1",
              outcome: "completed",
              receiptDigest,
            });
            if (!third.settlement) throw new Error("controlled_provider_settlement_missing");
            return settledProviderResult(intent, third.settlement, false);
          },
          async retireBinding() {
            throw new Error("controlled_retirement_not_exercised");
          },
          async retireBindingForClose() {
            throw new Error("controlled_close_retirement_not_exercised");
          },
        },
        close: async () => undefined,
      }),
    });
    const ready = await assembly.open();
    const run = ready.createRunApplication(seeded.taskScope);
    expect(ready.createRunApplication(structuredClone(seeded.taskScope))).toBe(run);
    expect(() => ready.createRunApplication({
      ...seeded.taskScope,
      conductorSessionId: "logical_session_assembly_conductor_drifted",
    })).toThrow("session_id_acp_run_application_scope_drift");
    run.commandApplication.enqueueTaskGoal({
      messageId: "message_task_goal_assembly",
      content: seeded.architecture.taskGoalContent,
    });
    seedActiveConductorTurn(fixture.store, seeded);

    const invoked = run.commandApplication.invokeAgent(conductorCommand(seeded, {
      commandId: "command_invoke_assembly_worker",
      idempotencyKey: "assembly:invoke:worker",
      agentCardId: seeded.worker.agentCardId,
    }));
    if (!("sessionId" in invoked.result)) throw new Error("controlled_worker_invoke_failed");
    const workerSessionId = invoked.result.sessionId;
    seedForwardConflict(fixture.store, seeded, workerSessionId);

    expect(() => run.commandApplication.sendToSession(conductorCommand(seeded, {
      commandId: "command_send_assembly_rollback",
      idempotencyKey: "assembly:send:rollback",
      sessionId: workerSessionId,
      payload: { content: "This transaction must roll back." },
    }))).toThrow("UNIQUE constraint failed: session_id_message_forwards.forward_id");
    expect(createSessionIdCanonicalStore(fixture.store).message.getMessage("message_assembly_1"))
      .toBeUndefined();

    const sent = run.commandApplication.sendToSession(conductorCommand(seeded, {
      commandId: "command_send_assembly_success",
      idempotencyKey: "assembly:send:success",
      sessionId: workerSessionId,
      payload: { content: "Produce the bounded ACP Final." },
    }));
    expect(sent.result).toEqual({ status: "accepted" });

    const drained = await run.runtimePump.pumpDelivery({ logicalSessionId: workerSessionId });
    expect(drained).toMatchObject({
      disposition: "drained",
      providerDisposition: "settled",
      reconciliationRequired: false,
    });
    if (drained.disposition !== "drained") throw new Error("controlled_drain_missing");
    const canonical = createSessionIdCanonicalStore(fixture.store);
    expect(canonical.message.listMessages(seeded.run.runId).filter(({ kind }) => kind === "agent_final"))
      .toHaveLength(1);
    expect(canonical.orchestration.listInboxItems(seeded.run.conductorLogicalSessionId)
      .filter(({ renderedMessageId }) => canonical.message.getMessage(renderedMessageId)?.kind === "agent_final"))
      .toHaveLength(1);

    await expect(run.runtimePump.drainStagedEffect({
      providerEffectIntentId: drained.providerEffectIntentId,
    })).resolves.toMatchObject({
      disposition: "drained",
      providerDisposition: "settled",
    });
    expect(providerExecutions).toEqual([
      drained.providerEffectIntentId,
      drained.providerEffectIntentId,
    ]);
    expect(canonical.message.listMessages(seeded.run.runId).filter(({ kind }) => kind === "agent_final"))
      .toHaveLength(1);
    expect(canonical.orchestration.listInboxItems(seeded.run.conductorLogicalSessionId)
      .filter(({ renderedMessageId }) => canonical.message.getMessage(renderedMessageId)?.kind === "agent_final"))
      .toHaveLength(1);

    await ready.close();
    await expect(run.runtimePump.drainStagedEffect({
      providerEffectIntentId: drained.providerEffectIntentId,
    })).rejects.toThrow("session_id_acp_application_closed");
    fixture.store.close();
  });

  it("binds Renderer, Interaction and ACP Stop owners while exposing only Renderer-safe results", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-owners-");
    const seeded = seedAcpRun(fixture.store);
    const ids = controlledIds();
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: monotonicNow(),
      createId: ids.create,
      authorizeRetiringBindingRecovery: () => false,
      createProvider: () => controlledProviderOwner(),
    });
    const ready = await assembly.open();
    const run = ready.createRunApplication(seeded.taskScope);

    const submitted = run.rendererCommandApplication.submitTaskInput({
      commandId: "command_assembly_renderer_input",
      taskId: seeded.taskScope.taskId,
      runId: seeded.run.runId,
      expectedRevision: 2,
      targetLogicalSessionId: seeded.run.conductorLogicalSessionId,
      content: "One durable user input to suppress during Stop.",
    });
    expect(submitted).toEqual({ taskRevision: 3 });
    expect(JSON.stringify(submitted)).not.toMatch(/providerEffectIntentId/iu);
    expect(typeof run.interactionResponseOwner.respondToInteraction).toBe("function");

    const stopped = run.taskStopApplication.stopTask({
      type: "task.stop",
      commandId: "command_assembly_task_stop",
      idempotencyKey: "assembly:task-stop",
      taskId: seeded.taskScope.taskId,
      runId: seeded.run.runId,
      expectedRevision: 3,
      issuedAt: NOW,
    });
    expect(stopped).toEqual({});
    expect(JSON.stringify(stopped)).not.toMatch(/(?:providerEffect|bindingRetirement)/iu);
    await expect(run.taskStopPump.pumpTaskStop()).resolves.toEqual({ status: "stopped" });

    const canonical = createSessionIdCanonicalStore(fixture.store);
    expect(canonical.taskRun.readTaskRunState(seeded.taskScope.taskId, seeded.run.runId))
      .toMatchObject({ taskRevision: 5, runStatus: "stopped" });
    expect(canonical.orchestration.listInboxItems(seeded.run.conductorLogicalSessionId))
      .toEqual([expect.objectContaining({ state: "suppressed", reason: "task_stopped" })]);
    expect(fixture.store.one<{ count: number }>(
      `SELECT count(*) AS count FROM session_id_logical_sessions
       WHERE task_id = ? AND run_id = ? AND lifecycle = 'current'`,
      seeded.taskScope.taskId,
      seeded.run.runId,
    )?.count).toBe(0);

    await ready.close();
    await expect(run.taskStopPump.pumpTaskStop())
      .rejects.toThrow("session_id_acp_application_closed");
    fixture.store.close();
  });

  it("routes close through the exact global resolver, hides Host envelopes, and tracks shutdown", async () => {
    const fixture = createStore("agent-workspace-acp-assembly-close-");
    const seeded = seedAcpRun(fixture.store);
    const ids = controlledIds();
    const providerClose = vi.fn(async () => undefined);
    const retirementStarted = deferred<void>();
    const allowRetirement = deferred<void>();
    const retireBindingForClose = vi.fn(async (bindingRetirementIntentId: string) => {
      const intent = providerInput!.repositories.reliability.getBindingRetirementIntent(
        bindingRetirementIntentId,
      );
      if (!intent) throw new Error("controlled_close_retirement_missing");
      const exactScope = {
        taskId: intent.taskId,
        runId: intent.runId,
        logicalSessionId: intent.logicalSessionId,
        sessionControlAuditId: intent.sessionControlAuditId,
        idempotencyKey: intent.idempotencyKey,
        bindingId: intent.bindingId,
        bindingRevision: intent.bindingRevision,
        executionProfileId: intent.executionProfileId,
        profileRevisionId: intent.profileRevisionId,
        providerFamily: intent.providerFamily,
      };
      expect(providerInput!.resolveCloseControl({
        ...exactScope,
        bindingRevision: exactScope.bindingRevision + 1,
      })).toBeUndefined();
      fixture.store.run(
        `UPDATE session_id_card_session_slots
         SET latest_generation = latest_generation + 1
         WHERE current_session_id = ?`,
        intent.logicalSessionId,
      );
      expect(providerInput!.resolveCloseControl(exactScope)).toBeUndefined();
      fixture.store.run(
        `UPDATE session_id_card_session_slots
         SET latest_generation = latest_generation - 1
         WHERE current_session_id = ?`,
        intent.logicalSessionId,
      );
      expect(providerInput!.resolveCloseControl({
        ...exactScope,
      })).toEqual({ kind: "close", state: "requested" });
      retirementStarted.resolve();
      await allowRetirement.promise;
      releaseBindingRetirement(providerInput!.repositories, bindingRetirementIntentId);
      return {
        disposition: "released" as const,
        bindingRetirementIntentId,
        bindingId: intent.bindingId,
        replayed: false,
      };
    });
    let providerInput: Parameters<Parameters<
      typeof createSessionIdAcpApplicationAssembly
    >[0]["createProvider"]>[0] | undefined;
    const assembly = createSessionIdAcpApplicationAssembly({
      store: fixture.store,
      authenticatedUserId: "user_assembly",
      now: monotonicNow(),
      createId: ids.create,
      authorizeRetiringBindingRecovery: () => false,
      createProvider: (input) => {
        providerInput = input;
        return {
          provider: {
            executeProviderEffect: async () => { throw new Error("controlled_provider_not_exercised"); },
            retireBinding: async () => { throw new Error("controlled_task_stop_not_exercised"); },
            retireBindingForClose,
          },
          close: providerClose,
        };
      },
    });
    const ready = await assembly.open();
    const run = ready.createRunApplication(seeded.taskScope);
    run.commandApplication.enqueueTaskGoal({
      messageId: "message_task_goal_assembly_close",
      content: seeded.architecture.taskGoalContent,
    });
    seedActiveConductorTurn(fixture.store, seeded);
    const invoked = run.commandApplication.invokeAgent(conductorCommand(seeded, {
      commandId: "command_invoke_assembly_close_worker",
      idempotencyKey: "assembly:close:invoke",
      agentCardId: seeded.worker.agentCardId,
    }));
    if (!("sessionId" in invoked.result)) throw new Error("controlled_close_worker_invoke_failed");
    const workerSessionId = invoked.result.sessionId;
    run.cardBindingOwner.ensureCurrentCardBinding({ logicalSessionId: workerSessionId });

    const closing = run.closeSession(conductorCommand(seeded, {
      commandId: "command_close_assembly_worker",
      idempotencyKey: "assembly:close:worker",
      sessionId: workerSessionId,
    }));
    await retirementStarted.promise;
    const shuttingDown = ready.close();
    await Promise.resolve();
    expect(providerClose).not.toHaveBeenCalled();
    allowRetirement.resolve();
    await expect(closing).resolves.toEqual({ status: "closed" });
    expect(JSON.stringify(await closing)).not.toMatch(/(?:bindingRetirement|sessionControl)/iu);
    await shuttingDown;
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(retireBindingForClose).toHaveBeenCalledTimes(1);
    await expect(run.closeSession(conductorCommand(seeded, {
      commandId: "command_close_assembly_after_shutdown",
      idempotencyKey: "assembly:close:after-shutdown",
      sessionId: workerSessionId,
    }))).rejects.toThrow("session_id_acp_application_closed");
    fixture.store.close();
  });
});

function createStore(prefix: string) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return {
    store: new SqliteRuntimeStore({
      path: path.join(directory, "runtime.sqlite"),
      now: () => NOW,
    }),
  };
}

function controlledProviderOwner() {
  return {
    provider: {
      executeProviderEffect: async () => {
        throw new Error("controlled_provider_not_exercised");
      },
      retireBinding: async () => {
        throw new Error("controlled_provider_not_exercised");
      },
      retireBindingForClose: async () => {
        throw new Error("controlled_provider_not_exercised");
      },
    },
    close: async () => undefined,
  };
}

function seedBlockingDirectBinding(store: SqliteRuntimeStore): void {
  // This fixture needs only the superseded table's drain state. Foreign rows
  // are intentionally irrelevant because the ACP preflight must not traverse
  // or translate the legacy object graph.
  store.run("PRAGMA foreign_keys = OFF");
  store.run(
    `INSERT INTO session_id_provider_bindings(
       binding_id, task_id, run_id, session_id, agent_card_id, execution_profile_id,
       provider, provider_host_id, native_binding_ref, status, recoverable,
       revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', 1, 1, ?, ?)`,
    "binding_direct_blocking",
    "task_direct_blocking",
    "run_direct_blocking",
    "logical_session_direct_blocking",
    "agent_card_direct_blocking",
    "profile_direct_blocking",
    "opencode",
    NOW,
    NOW,
  );
  store.run("PRAGMA foreign_keys = ON");
}

function seedAcpRun(store: SqliteRuntimeStore) {
  const repositories = createRuntimeRepositories(store);
  const source = BUILT_IN_ACP_STARTER_PACKAGES.find(({ package: candidate }) => (
    candidate.template.slug === "opencode-acp-starter"
  ));
  if (!source) throw new Error("controlled_acp_starter_missing");
  const packageValue = source.package;
  const definitionHash = hashDefinition(packageValue.definition as unknown as JsonValue);
  repositories.templateTask.importPackage({
    templateId: packageValue.template.templateId,
    slug: packageValue.template.slug,
    title: packageValue.template.title,
    ...(packageValue.template.description ? { description: packageValue.template.description } : {}),
    activeVersionId: source.templateVersionId,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, {
    templateVersionId: source.templateVersionId,
    templateId: packageValue.template.templateId,
    version: packageValue.template.version,
    definition: packageValue.definition,
    definitionHash,
    createdAt: NOW,
    publishedAt: NOW,
  }, packageValue, []);
  const definition = source.package.definition;
  const taskId = "task_assembly_flow";
  const taskGoalContent = renderTaskGoalContentV1({
    title: "Assembly flow",
    goal: "Prove the unique provider-neutral ACP application root.",
    taskInputValues: [],
  }, definition.taskInputSchema);
  const version = repositories.templateTask.getTemplateVersion(source.templateVersionId);
  if (!version) throw new Error("controlled_acp_version_missing");
  const architecture = createTaskArchitectureSnapshotV3({
    architectureSnapshotId: "architecture_assembly_flow",
    taskId,
    templateVersion: version,
    taskInputValues: [],
    taskTitle: "Assembly flow",
    taskGoal: "Prove the unique provider-neutral ACP application root.",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: {
      workspaceId: "workspace_assembly_flow",
      grantDigest: `sha256:${"a".repeat(64)}`,
    },
    now: NOW,
  });
  const queuedTask: TaskRecord = {
    taskId,
    architectureSnapshotId: architecture.architectureSnapshotId,
    title: architecture.taskTitle,
    goal: architecture.taskGoal,
    status: "queued",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repositories.templateTask.createTask({ task: queuedTask, snapshot: architecture });
  const canonical = createSessionIdCanonicalStore(store);
  canonical.taskRun.registerTask(taskId, NOW);
  const run: TaskRunRecord = {
    runId: "run_assembly_flow",
    taskId,
    conductorLogicalSessionId: "logical_session_assembly_conductor",
    status: "starting",
    runNumber: 1,
    revision: 1,
    startedAt: NOW,
  };
  canonical.taskRun.createRun({
    task: {
      ...queuedTask,
      status: "running",
      activeRunId: run.runId,
      revision: 2,
    },
    expectedTaskRevision: queuedTask.revision,
    run,
  });
  for (const [index, card] of definition.agentCards.entries()) {
    canonical.taskRun.initializeSlot({
      cardSessionSlotId: `card_session_slot_assembly_${index + 1}`,
      taskId,
      runId: run.runId,
      agentCardId: card.agentCardId,
      latestGeneration: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  const runningRun: TaskRunRecord = {
    ...run,
    status: "running",
    revision: 2,
  };
  canonical.taskRun.markRunRunning(runningRun, run.revision);
  const worker = definition.agentCards[0];
  if (!worker) throw new Error("controlled_worker_missing");
  const agentCards = definition.agentCards.map((card) => {
    const profile = definition.executionProfiles.find((candidate) => (
      candidate.executionProfileId === card.executionProfileId
    ));
    if (!profile) throw new Error("controlled_card_profile_missing");
    return {
      agentCardId: card.agentCardId,
      executionProfileId: profile.executionProfileId,
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
    };
  });
  return {
    architecture,
    worker,
    run: runningRun,
    taskScope: {
      taskId,
      runId: run.runId,
      conductorSessionId: run.conductorLogicalSessionId,
      initialConductorSessionTurnId: "session_turn_assembly_conductor_initial",
      agentCards,
    },
  };
}

function seedActiveConductorTurn(
  store: SqliteRuntimeStore,
  seeded: ReturnType<typeof seedAcpRun>,
): void {
  const canonical = createSessionIdCanonicalStore(store);
  const inbox = canonical.orchestration.listInboxItems(seeded.run.conductorLogicalSessionId)[0];
  if (!inbox) throw new Error("controlled_task_goal_inbox_missing");
  canonical.transaction(({ taskRun, orchestration }) => {
    orchestration.createInputSubmission({
      inputSubmissionId: "input_assembly_conductor_initial",
      taskId: seeded.taskScope.taskId,
      runId: seeded.taskScope.runId,
      sessionId: seeded.taskScope.conductorSessionId,
      sourceInboxItemId: inbox.inboxItemId,
      contentMessageId: inbox.renderedMessageId,
      commandId: "command_assembly_task_goal",
      idempotencyKey: "assembly:task-goal",
      sequence: 1,
      state: "accepted",
      createdAt: NOW,
      updatedAt: NOW,
    });
    orchestration.createTurn({
      sessionTurnId: seeded.taskScope.initialConductorSessionTurnId,
      taskId: seeded.taskScope.taskId,
      runId: seeded.taskScope.runId,
      sessionId: seeded.taskScope.conductorSessionId,
      inputSubmissionId: "input_assembly_conductor_initial",
      trigger: "task_goal",
      state: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    orchestration.updateInboxItem({
      ...inbox,
      state: "handed",
      updatedAt: NOW,
    }, "pending");
    taskRun.createPlanningFence({
      planningFenceId: "planning_fence_assembly_initial",
      taskId: seeded.taskScope.taskId,
      runId: seeded.taskScope.runId,
      sourceCommandId: "command_assembly_task_goal",
      currentConductorSessionTurnId: seeded.taskScope.initialConductorSessionTurnId,
      createdAt: NOW,
    });
  });
}

function seedForwardConflict(
  store: SqliteRuntimeStore,
  seeded: ReturnType<typeof seedAcpRun>,
  workerSessionId: string,
): void {
  const canonical = createSessionIdCanonicalStore(store);
  const content = "Pre-existing identity fence.";
  canonical.transaction(({ message }) => {
    message.createMessage({
      messageId: "message_forward_conflict_seed",
      taskId: seeded.taskScope.taskId,
      runId: seeded.taskScope.runId,
      kind: "conductor_forward",
      content,
      canonicalContent: [{ kind: "text", text: content }],
      contentDigest: hashDefinition(content),
      createdAt: NOW,
    });
    message.createForward({
      forwardId: "message_forward_conflict",
      taskId: seeded.taskScope.taskId,
      runId: seeded.taskScope.runId,
      commandId: "command_forward_conflict_seed",
      idempotencyKey: "assembly:forward-conflict-seed",
      decidedBySessionTurnId: seeded.taskScope.initialConductorSessionTurnId,
      targetSessionId: workerSessionId,
      orderedReferenceSnapshots: [],
      renderedMessageId: "message_forward_conflict_seed",
      createdAt: NOW,
    });
  });
}

function conductorCommand<T extends Readonly<Record<string, unknown>>>(
  seeded: ReturnType<typeof seedAcpRun>,
  input: T,
) {
  return {
    taskId: seeded.taskScope.taskId,
    runId: seeded.taskScope.runId,
    expectedRevision: 2,
    conductorSessionId: seeded.taskScope.conductorSessionId,
    conductorSessionTurnId: seeded.taskScope.initialConductorSessionTurnId,
    ...input,
  };
}

function controlledIds() {
  const counts = new Map<string, number>();
  return {
    create(kind: string) {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      if (kind === "message_forward" && next === 1) return "message_forward_conflict";
      return `${kind}_assembly_${next}`;
    },
  };
}

function monotonicNow() {
  let offset = 0;
  return () => new Date(Date.parse(NOW) + offset++).toISOString();
}

function observationScope(attempt: Readonly<{
  sessionExecutionAttemptId: string;
  revision: number;
  logicalSessionId: string;
  bindingId: string;
  bindingRevision: number;
  executionProfileId: string;
  profileRevisionId: string;
}>) {
  return {
    sessionExecutionAttemptId: attempt.sessionExecutionAttemptId,
    expectedAttemptRevision: attempt.revision,
    logicalSessionId: attempt.logicalSessionId,
    bindingId: attempt.bindingId,
    bindingRevision: attempt.bindingRevision,
    executionProfileId: attempt.executionProfileId,
    profileRevisionId: attempt.profileRevisionId,
  };
}

function settledProviderResult(
  intent: SessionRuntimeProviderEffectIntentRecord,
  settlement: SessionExecutionSettlement,
  replayed: boolean,
) {
  return {
    disposition: "settled" as const,
    providerEffectIntentId: intent.providerEffectIntentId,
    sessionExecutionAttemptId: intent.sessionExecutionAttemptId,
    replayed,
    settlement,
  };
}

function seedRetiringBinding(
  store: SqliteRuntimeStore,
  suffix: string,
): AcpV3BindingRetirementIntentRecord {
  const seeded = seedAcpRun(store);
  const canonical = createSessionIdCanonicalStore(store);
  const card = seeded.taskScope.agentCards.find((candidate) => (
    candidate.agentCardId === seeded.worker.agentCardId
  ));
  const slot = canonical.taskRun.getSlot("card_session_slot_assembly_1");
  if (!card || !slot) throw new Error("controlled_recovery_card_scope_missing");
  const logicalSessionId = `logical_session_assembly_recovery_${suffix}`;
  const materialized = materializeCardSessionGeneration({
    slot,
    taskId: seeded.taskScope.taskId,
    runId: seeded.taskScope.runId,
    agentCardId: card.agentCardId,
    executionProfileId: card.executionProfileId,
    cardSessionSlotId: slot.cardSessionSlotId,
    sessionId: logicalSessionId,
    now: NOW,
  });
  canonical.taskRun.materializeGeneration(materialized.slot, materialized.generation);
  const templates = createRuntimeRepositories(store).templateTask;
  const resolveFrozenProfileTuple = createAcpV3FrozenProfileTupleResolver({
    templates,
    taskRun: canonical.taskRun,
  });
  const repositories = createAcpSessionRuntimeRepositories(store, { resolveFrozenProfileTuple });
  const binding = {
    schemaVersion: 3 as const,
    bindingId: `binding_assembly_recovery_${suffix}`,
    taskId: seeded.taskScope.taskId,
    runId: seeded.taskScope.runId,
    logicalSessionId,
    agentCardId: card.agentCardId,
    executionProfileId: card.executionProfileId,
    profileRevisionId: card.profileRevisionId,
    providerFamily: card.providerFamily,
    bindingHandle: `binding_handle_assembly_recovery_${suffix}`,
    status: "active" as const,
    recoverable: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  repositories.binding.createBinding(binding, { makeCurrent: true });
  const pending = repositories.reliability.createBindingRetirementIntent({
    bindingRetirementIntentId: `binding_retirement_assembly_recovery_${suffix}`,
    commandId: `command_assembly_recovery_${suffix}`,
    idempotencyKey: `assembly:recovery:${suffix}`,
    taskId: binding.taskId,
    runId: binding.runId,
    logicalSessionId,
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    bindingHandle: binding.bindingHandle,
    executionProfileId: binding.executionProfileId,
    profileRevisionId: binding.profileRevisionId,
    providerFamily: binding.providerFamily,
    sessionControlAuditId: `session_control_assembly_recovery_${suffix}`,
    state: "pending",
    attempts: 0,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return repositories.reliability.claimBindingRetirementIntent({
    bindingRetirementIntentId: pending.bindingRetirementIntentId,
    expectedRevision: pending.revision,
    mode: "initial",
    updatedAt: "2026-08-12T12:00:01.000Z",
  });
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

function releaseBindingRetirement(
  repositories: AcpSessionRuntimeRepositories,
  bindingRetirementIntentId: string,
): void {
  const releasedAt = "2026-08-12T12:01:00.000Z";
  const pending = repositories.reliability.getBindingRetirementIntent(bindingRetirementIntentId);
  if (!pending) throw new Error("controlled_close_retirement_missing");
  const claimed = repositories.reliability.claimBindingRetirementIntent({
    bindingRetirementIntentId,
    expectedRevision: pending.revision,
    mode: "initial",
    updatedAt: releasedAt,
  });
  repositories.transaction((owners) => {
    const binding = owners.binding.getCurrentBinding(claimed.logicalSessionId);
    if (!binding || binding.bindingId !== claimed.bindingId) {
      throw new Error("controlled_close_binding_missing");
    }
    owners.binding.updateBinding({
      ...binding,
      status: "released",
      recoverable: false,
      revision: binding.revision + 1,
      updatedAt: releasedAt,
    }, binding.revision);
    owners.reliability.settleBindingRetirementReleased({
      bindingRetirementIntentId,
      expectedRevision: claimed.revision,
      releasedAt,
    });
  });
}
