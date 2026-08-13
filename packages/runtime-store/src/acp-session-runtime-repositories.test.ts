import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpSessionRuntimeRepositories } from "./acp-session-runtime-repositories.js";
import { createSessionIdCanonicalStore } from "./session-id-repositories.js";
import { SqliteRuntimeStore, SUPERSEDED_PROTOCOL_META_KEY } from "./sqlite.js";

const temporaryDirectories: string[] = [];
const now = "2026-08-12T00:00:00.000Z";
const repositoryOptions = Object.freeze({
  resolveFrozenProfileTuple: (scope: Readonly<{ executionProfileId: string }>) => (
    scope.executionProfileId === "profile_acp_v3"
      ? Object.freeze({
          schemaVersion: 3 as const,
          executionProfileId: "profile_acp_v3",
          profileRevisionId: "profile_revision_acp_v3",
          providerFamily: "opencode" as const,
        })
      : undefined
  ),
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("ACP v3 Session Runtime repositories", () => {
  it("persists only validated opaque Binding, Runtime, Attempt and effect records across reopen", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-store-");
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    seedCanonicalSession(store);
    let repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    const binding = bindingRecord();
    const runtime = runtimeRecord();
    const attempt = attemptRecord();
    const effect = providerEffectIntent();

    repositories.binding.createBinding(binding, { makeCurrent: true });
    repositories.sessionRuntime.createRuntime(runtime);
    repositories.sessionRuntime.createAttempt(attempt);
    repositories.sessionRuntime.updateRuntime({
      ...runtime,
      state: "executing",
      activeAttemptId: attempt.sessionExecutionAttemptId,
      revision: 2,
      updatedAt: "2026-08-12T00:00:01.000Z",
    }, 1);
    expect(repositories.reliability.createProviderEffectIntent(effect)).toEqual(effect);
    expect(repositories.reliability.createProviderEffectIntent(effect)).toEqual(effect);
    expect(repositories.binding.getCurrentBinding(binding.logicalSessionId)).toEqual(binding);
    store.close();

    store = new SqliteRuntimeStore({ path: databasePath });
    repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    expect(repositories.binding.getBinding(binding.bindingId)).toEqual(binding);
    expect(repositories.binding.getCurrentBinding(binding.logicalSessionId)).toEqual(binding);
    expect(repositories.sessionRuntime.getRuntime(runtime.sessionExecutionRuntimeId)).toMatchObject({
      state: "executing",
      activeAttemptId: attempt.sessionExecutionAttemptId,
      revision: 2,
    });
    expect(repositories.sessionRuntime.getAttempt(attempt.sessionExecutionAttemptId)).toEqual(attempt);
    expect(repositories.reliability.getProviderEffectIntent(effect.providerEffectIntentId)).toEqual(effect);

    const acpTables = store.many<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name LIKE 'session_id_acp_v3_%'
       ORDER BY name`,
    );
    expect(acpTables.map((entry) => entry.name)).toEqual([
      "session_id_acp_v3_binding_retirement_intents",
      "session_id_acp_v3_bindings",
      "session_id_acp_v3_current_bindings",
      "session_id_acp_v3_execution_attempts",
      "session_id_acp_v3_execution_runtimes",
      "session_id_acp_v3_provider_effect_intents",
    ]);
    const persisted = acpTables.map((entry) => entry.sql).join("\n")
      + JSON.stringify(acpTables.flatMap((entry) => store.many(`SELECT * FROM ${entry.name}`)));
    for (const forbidden of [
      "acp_session_id",
      "raw_session_id",
      "native_binding_ref",
      "native_request_id",
      "absolute_cwd",
      "workspace_path",
      "canonical_directory",
      "credential",
    ]) {
      expect(persisted.toLowerCase()).not.toContain(forbidden);
    }
    expect(store.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = 'schema_version'",
    )?.value).toBe("21");
    store.close();
  });

  it("rejects extra/private identity and cwd fields before any ACP v3 row is written", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-reject-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    const unsafeValues = [
      () => repositories.binding.createBinding({
        ...bindingRecord(),
        nativeBindingRef: "native-session-secret",
      } as unknown as AcpSafeSessionBindingRecordV3, { makeCurrent: true }),
      () => repositories.binding.createBinding({
        ...bindingRecord(),
        unexpectedField: true,
      } as unknown as AcpSafeSessionBindingRecordV3, { makeCurrent: true }),
      () => repositories.sessionRuntime.createRuntime({
        ...runtimeRecord(),
        absoluteCwd: "/Users/private/workspace",
      } as unknown as SessionExecutionRuntimeRecord),
      () => repositories.sessionRuntime.createAttempt({
        ...attemptRecord(),
        nativeRequestId: "permission-request-secret",
      } as unknown as SessionExecutionAttemptRecord),
      () => repositories.reliability.createProviderEffectIntent({
        ...providerEffectIntent(),
        acpSessionId: "raw-acp-session",
      } as unknown as SessionRuntimeProviderEffectIntentRecord),
    ];
    for (const write of unsafeValues) expect(write).toThrow();
    for (const table of [
      "session_id_acp_v3_bindings",
      "session_id_acp_v3_execution_runtimes",
      "session_id_acp_v3_execution_attempts",
      "session_id_acp_v3_provider_effect_intents",
    ]) {
      expect(store.one<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count).toBe(0);
    }
    store.close();
  });

  it("rolls back the owner records and provider-effect intent as one pre-effect transaction", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-intent-rollback-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    expect(() => repositories.transaction((owners) => {
      owners.binding.createBinding(bindingRecord(), { makeCurrent: true });
      owners.sessionRuntime.createRuntime(runtimeRecord());
      owners.sessionRuntime.createAttempt(attemptRecord());
      owners.reliability.createProviderEffectIntent(providerEffectIntent());
      throw new Error("external_effect_must_not_start");
    })).toThrow("external_effect_must_not_start");
    for (const table of [
      "session_id_acp_v3_bindings",
      "session_id_acp_v3_current_bindings",
      "session_id_acp_v3_execution_runtimes",
      "session_id_acp_v3_execution_attempts",
      "session_id_acp_v3_provider_effect_intents",
    ]) {
      expect(store.one<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count).toBe(0);
    }
    store.close();
  });

  it("CAS-suppresses only exact unhanded delivery intents and makes replay idempotent", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-suppress-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    repositories.binding.createBinding(bindingRecord(), { makeCurrent: true });
    repositories.sessionRuntime.createRuntime(runtimeRecord());
    repositories.sessionRuntime.createAttempt(attemptRecord());
    repositories.reliability.createProviderEffectIntent(providerEffectIntent());

    const suppressedAt = "2026-08-12T00:00:01.000Z";
    expect(repositories.reliability.suppressUnhandedProviderEffectIntents({
      taskId: "task_acp_v3",
      runId: "run_acp_v3",
      logicalSessionId: "logical_session_acp_v3",
      inputSubmissionIds: ["input_acp_v3"],
      suppressedAt,
    })).toEqual(["provider_effect_acp_v3"]);
    expect(repositories.reliability.getProviderEffectIntent("provider_effect_acp_v3")).toEqual({
      ...providerEffectIntent(),
      state: "suppressed",
      suppressionReason: "task_stopped",
      suppressedAt,
    });
    expect(repositories.reliability.suppressUnhandedProviderEffectIntents({
      taskId: "task_acp_v3",
      runId: "run_acp_v3",
      logicalSessionId: "logical_session_acp_v3",
      inputSubmissionIds: ["input_acp_v3"],
      suppressedAt: "2026-08-12T00:00:02.000Z",
    })).toEqual([]);
    store.close();
  });

  it("stages and CAS-settles per-Binding retirement without requiring an Attempt", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-retirement-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    const binding = bindingRecord();
    const intent = bindingRetirementIntent();
    repositories.binding.createBinding(binding, { makeCurrent: true });

    expect(repositories.reliability.createBindingRetirementIntent(intent)).toEqual(intent);
    expect(repositories.sessionRuntime.listAttempts("session_execution_runtime_absent")).toEqual([]);
    expect(repositories.reliability.findBindingRetirementIntentByIdempotencyKey({
      taskId: intent.taskId,
      runId: intent.runId,
      bindingId: intent.bindingId,
      idempotencyKey: intent.idempotencyKey,
    })).toEqual(intent);

    const retiring = repositories.reliability.claimBindingRetirementIntent({
      bindingRetirementIntentId: intent.bindingRetirementIntentId,
      expectedRevision: 1,
      mode: "initial",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });
    expect(retiring).toMatchObject({ state: "retiring", attempts: 1, revision: 2 });
    expect(() => repositories.reliability.claimBindingRetirementIntent({
      bindingRetirementIntentId: intent.bindingRetirementIntentId,
      expectedRevision: 2,
      mode: "initial",
      updatedAt: "2026-08-12T00:00:02.000Z",
    })).toThrow("acp_v3_binding_retirement_claim_state_invalid");

    const reclaimed = repositories.reliability.claimBindingRetirementIntent({
      bindingRetirementIntentId: intent.bindingRetirementIntentId,
      expectedRevision: 2,
      mode: "confirmed_dead_host_recovery",
      updatedAt: "2026-08-12T00:00:02.000Z",
    });
    expect(reclaimed).toMatchObject({ state: "retiring", attempts: 2, revision: 3 });

    repositories.transaction((owners) => {
      const current = owners.binding.getCurrentBinding(binding.logicalSessionId)!;
      owners.binding.updateBinding({
        ...current,
        status: "released",
        recoverable: false,
        revision: current.revision + 1,
        updatedAt: "2026-08-12T00:00:03.000Z",
      }, current.revision);
      owners.reliability.settleBindingRetirementReleased({
        bindingRetirementIntentId: intent.bindingRetirementIntentId,
        expectedRevision: reclaimed.revision,
        releasedAt: "2026-08-12T00:00:03.000Z",
      });
    });
    expect(repositories.binding.getCurrentBinding(binding.logicalSessionId)).toBeUndefined();
    expect(repositories.binding.getBinding(binding.bindingId)).toMatchObject({
      status: "released",
      recoverable: false,
      revision: 2,
    });
    expect(repositories.reliability.getBindingRetirementIntent(intent.bindingRetirementIntentId))
      .toMatchObject({ state: "released", attempts: 2, revision: 4 });
    expect(repositories.reliability.createBindingRetirementIntent(intent))
      .toMatchObject({ state: "released", attempts: 2, revision: 4 });
    store.close();
  });

  it("fences retirement creation to the exact current Binding/profile and idempotency scope", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-retirement-fence-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    repositories.binding.createBinding(bindingRecord(), { makeCurrent: true });
    const intent = bindingRetirementIntent();
    for (const candidate of [
      { ...intent, bindingRevision: 2 },
      { ...intent, bindingHandle: "binding_handle_wrong" },
      { ...intent, profileRevisionId: "profile_revision_wrong" },
      { ...intent, providerFamily: "codex" as const },
    ]) {
      expect(() => repositories.reliability.createBindingRetirementIntent(candidate)).toThrow();
    }
    expect(repositories.reliability.listBindingRetirementIntents()).toEqual([]);
    repositories.reliability.createBindingRetirementIntent(intent);
    expect(() => repositories.reliability.createBindingRetirementIntent({
      ...intent,
      bindingRetirementIntentId: "binding_retirement_parallel",
      commandId: "command_retire-parallel",
      idempotencyKey: "close:parallel",
      sessionControlAuditId: "session_control_close-parallel",
    })).toThrow("acp_v3_binding_retirement_unresolved_conflict");
    expect(() => repositories.reliability.createBindingRetirementIntent({
      ...intent,
      bindingRetirementIntentId: "binding_retirement_conflict",
    })).toThrow("acp_v3_binding_retirement_idempotency_conflict");
    expect(() => repositories.reliability.createBindingRetirementIntent({
      ...intent,
      bindingRetirementIntentId: "binding_retirement_unsafe",
      commandId: "command_retire-unsafe",
      idempotencyKey: "task-stop:unsafe",
      absoluteCwd: "/private/workspace",
    } as never)).toThrow();
    expect(repositories.reliability.listBindingRetirementIntents()).toEqual([intent]);
    store.close();
  });

  it("CAS-updates one Binding lineage and clears its current pointer only at a terminal state", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-binding-cas-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    const first = bindingRecord();
    repositories.binding.createBinding(first, { makeCurrent: true });

    expect(() => repositories.binding.updateBinding({
      ...first,
      status: "recovering",
      revision: 3,
      updatedAt: "2026-08-12T00:00:02.000Z",
    }, 1)).toThrow("acp_v3_binding_revision_transition_invalid");
    expect(() => repositories.binding.createBinding({
      ...first,
      bindingId: "binding_acp_v3_competing",
      bindingHandle: "binding_handle_acp_v3_competing",
    }, { makeCurrent: true })).toThrow("acp_v3_current_binding_conflict");

    const recovering: AcpSafeSessionBindingRecordV3 = {
      ...first,
      status: "recovering",
      revision: 2,
      updatedAt: "2026-08-12T00:00:01.000Z",
    };
    repositories.binding.updateBinding(recovering, 1);
    expect(repositories.binding.getCurrentBinding(first.logicalSessionId)).toEqual(recovering);
    const released: AcpSafeSessionBindingRecordV3 = {
      ...recovering,
      status: "released",
      recoverable: false,
      revision: 3,
      updatedAt: "2026-08-12T00:00:02.000Z",
    };
    repositories.binding.updateBinding(released, 2);
    expect(repositories.binding.getCurrentBinding(first.logicalSessionId)).toBeUndefined();

    const replacement: AcpSafeSessionBindingRecordV3 = {
      ...first,
      bindingId: "binding_acp_v3_replacement",
      bindingHandle: "binding_handle_acp_v3_replacement",
      createdAt: "2026-08-12T00:00:03.000Z",
      updatedAt: "2026-08-12T00:00:03.000Z",
    };
    repositories.binding.createBinding(replacement, { makeCurrent: true });
    expect(repositories.binding.getCurrentBinding(first.logicalSessionId)).toEqual(replacement);
    expect(repositories.binding.listBindings(first.logicalSessionId)).toEqual([released, replacement]);
    store.close();
  });

  it("keeps direct Binding rows read-only and blocks every non-terminal or uncertain status", () => {
    const directory = temporaryDirectory("agent-workspace-direct-drain-");
    const databasePath = path.join(directory, "runtime.sqlite");
    let store = new SqliteRuntimeStore({ path: databasePath });
    store.close();
    replaceDirectBindingTable(databasePath);
    store = new SqliteRuntimeStore({ path: databasePath });
    const statuses = [
      "released",
      "unrecoverable",
      "unbound",
      "binding_effect_accepted",
      "active",
      "recovering",
      "ambiguous",
      "future_status",
    ] as const;
    statuses.forEach((status, index) => {
      store.run(
        `INSERT INTO session_id_provider_bindings(
           binding_id, task_id, run_id, session_id, agent_card_id, execution_profile_id,
           provider, provider_host_id, native_binding_ref, status, recoverable,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        `binding_direct_${index}`,
        `task_direct_${index}`,
        `run_direct_${index}`,
        `logical_session_direct_${index}`,
        `agent_card_direct_${index}`,
        `profile_direct_${index}`,
        index % 2 === 0 ? "opencode" : "codex",
        `provider_host_private_${index}`,
        `native-session-private-${index}`,
        status,
        status === "active" || status === "recovering" ? 1 : 0,
        now,
        now,
      );
    });
    const before = directTableSnapshot(store);
    const repositories = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    const inventory = repositories.directDrain.inventory();
    expect(inventory).toMatchObject({ total: 8, safe: 2, blocking: 6 });
    expect(inventory.bindings.map((binding) => binding.status)).toEqual([
      "released",
      "unrecoverable",
      "unbound",
      "binding_effect_accepted",
      "active",
      "recovering",
      "ambiguous",
      "unknown",
    ]);
    expect(JSON.stringify(inventory)).not.toMatch(/native|provider_host|raw|payload/iu);
    expect(() => repositories.directDrain.assertDrained()).toThrow("acp_v3_direct_bindings_not_drained");
    expect(() => repositories.directDrain.sealDrainedForCutover()).toThrow("acp_v3_direct_bindings_not_drained");
    expect(store.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = 'acp_direct_binding_cutover_sealed'",
    )).toBeUndefined();
    expect(directTableSnapshot(store)).toEqual(before);

    store.run(
      `UPDATE session_id_provider_bindings
       SET status = 'released', recoverable = 0
       WHERE status NOT IN ('released', 'unrecoverable')`,
    );
    expect(repositories.directDrain.sealDrainedForCutover()).toMatchObject({ total: 8, safe: 8, blocking: 0 });
    store.close();
  });

  it("rejects a v3 Binding unless the frozen Task Architecture owns the exact v3 Profile tuple", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-profile-fence-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const candidates = [
      undefined,
      { schemaVersion: 3 as const, executionProfileId: "profile_other", profileRevisionId: "profile_revision_acp_v3", providerFamily: "opencode" as const },
      { schemaVersion: 3 as const, executionProfileId: "profile_acp_v3", profileRevisionId: "profile_revision_other", providerFamily: "opencode" as const },
      { schemaVersion: 3 as const, executionProfileId: "profile_acp_v3", profileRevisionId: "profile_revision_acp_v3", providerFamily: "codex" as const },
    ];
    for (const frozen of candidates) {
      const repositories = createAcpSessionRuntimeRepositories(store, {
        resolveFrozenProfileTuple: () => frozen,
      });
      expect(() => repositories.binding.createBinding(bindingRecord(), { makeCurrent: true }))
        .toThrow("acp_v3_binding_frozen_profile_mismatch");
      expect(repositories.binding.getBinding(bindingRecord().bindingId)).toBeUndefined();
    }
    store.close();
  });

  it("atomically seals a drained direct table and rejects every later direct Binding create", () => {
    const directory = temporaryDirectory("agent-workspace-acp-direct-seal-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const acp = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    expect(acp.directDrain.sealDrainedForCutover()).toMatchObject({ blocking: 0, total: 0 });

    const direct = createSessionIdCanonicalStore(store);
    expect(() => direct.binding.createBinding({
      bindingId: "binding_direct_after_seal",
      taskId: "task_acp_v3",
      runId: "run_acp_v3",
      sessionId: "logical_session_acp_v3",
      agentCardId: "agent_card_acp_v3",
      executionProfileId: "profile_acp_v3",
      provider: "opencode",
      status: "unbound",
      recoverable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })).toThrow("session_id_direct_binding_cutover_sealed");
    store.close();
  });

  it("makes every superseded direct writer fail closed after the durable cutover seal", () => {
    const directory = temporaryDirectory("agent-workspace-acp-direct-writer-seal-");
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });
    seedCanonicalSession(store);
    const direct = createSessionIdCanonicalStore(store);
    const binding = {
      bindingId: "binding_direct_writer_seal",
      taskId: "task_acp_v3",
      runId: "run_acp_v3",
      sessionId: "logical_session_acp_v3",
      agentCardId: "agent_card_acp_v3",
      executionProfileId: "profile_acp_v3",
      provider: "opencode" as const,
      status: "unbound" as const,
      recoverable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    direct.binding.createBinding(binding);
    const released = {
      ...binding,
      status: "released" as const,
      revision: 2,
      updatedAt: "2026-08-12T00:00:01.000Z",
    };
    direct.binding.updateBinding(released, 1);
    direct.providerFact.recordFact({
      providerFactId: "provider_fact_direct_before_seal",
      provider: "opencode",
      bindingId: binding.bindingId,
      bindingRevision: released.revision,
      kind: "binding_observed",
      deduplication: { providerEventId: "direct-before-seal" },
      correlation: {},
      payload: { nativeBindingRef: "historical-private-value" },
      observedAt: "2026-08-12T00:00:02.000Z",
    });
    direct.reliability.createProviderEffect({
      outboxId: "outbox_direct_before_seal",
      taskId: binding.taskId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      kind: "ensure_binding",
      idempotencyKey: "direct-before-seal",
      payload: { bindingId: binding.bindingId },
      payloadFingerprint: "sha256:direct-before-seal",
      state: "pending",
      attempts: 0,
      createdAt: "2026-08-12T00:00:03.000Z",
      updatedAt: "2026-08-12T00:00:03.000Z",
    });
    const before = {
      bindings: direct.binding.listBindings(binding.runId),
      facts: direct.providerFact.listFacts(binding.bindingId),
      effects: direct.reliability.listProviderEffects(binding.sessionId),
    };

    const acp = createAcpSessionRuntimeRepositories(store, repositoryOptions);
    expect(acp.directDrain.sealDrainedForCutover()).toMatchObject({ blocking: 0, total: 1 });

    const blockedWrites: readonly (() => unknown)[] = [
      () => direct.binding.createBinding({ ...binding, bindingId: "binding_direct_after_seal" }),
      () => direct.binding.updateBinding({
        ...released,
        status: "unrecoverable",
        revision: 3,
        updatedAt: "2026-08-12T00:00:04.000Z",
      }, released.revision),
      () => direct.providerFact.recordFact({
        providerFactId: "provider_fact_direct_after_seal",
        provider: "opencode",
        bindingId: binding.bindingId,
        bindingRevision: released.revision,
        kind: "binding_observed",
        deduplication: { providerEventId: "direct-after-seal" },
        correlation: {},
        payload: { nativeBindingRef: "must-not-persist" },
        observedAt: "2026-08-12T00:00:04.000Z",
      }),
      () => direct.orchestration.createAttention({} as never),
      () => direct.orchestration.updateAttention({} as never, 1, "requested"),
      () => direct.reliability.createProviderEffect({
        outboxId: "outbox_direct_after_seal",
        taskId: binding.taskId,
        runId: binding.runId,
        sessionId: binding.sessionId,
        kind: "ensure_binding",
        idempotencyKey: "direct-after-seal",
        payload: { nativeBindingRef: "must-not-persist" },
        payloadFingerprint: "sha256:direct-after-seal",
        state: "pending",
        attempts: 0,
        createdAt: "2026-08-12T00:00:04.000Z",
        updatedAt: "2026-08-12T00:00:04.000Z",
      }),
      () => direct.reliability.claimNextProviderEffect(
        binding.taskId,
        binding.runId,
        "2026-08-12T00:00:04.000Z",
        "2026-08-12T00:00:05.000Z",
      ),
      () => direct.reliability.settleProviderEffect({
        outboxId: "outbox_direct_before_seal",
        expectedAttempts: 0,
        state: "unknown",
        now: "2026-08-12T00:00:04.000Z",
      }),
      () => direct.reliability.suppressPendingProviderEffects(
        binding.sessionId,
        ["ensure_binding"],
        "cutover",
        "2026-08-12T00:00:04.000Z",
      ),
      () => direct.reliability.suppressProviderEffect(
        "outbox_direct_before_seal",
        "cutover",
        "2026-08-12T00:00:04.000Z",
      ),
      () => direct.reliability.createUiCommandReceipt({
        commandId: "command_direct_attention_after_seal",
        taskId: binding.taskId,
        runId: binding.runId,
        commandKind: "session.respond_attention",
        idempotencyKey: "direct-attention-after-seal",
        payloadFingerprint: "sha256:direct-attention-after-seal",
        result: { attentionId: "attention_direct", status: "response_staged" },
        createdAt: "2026-08-12T00:00:04.000Z",
      }),
    ];
    for (const write of blockedWrites) {
      expect(write).toThrow("session_id_direct_binding_cutover_sealed");
    }

    expect({
      bindings: direct.binding.listBindings(binding.runId),
      facts: direct.providerFact.listFacts(binding.bindingId),
      effects: direct.reliability.listProviderEffects(binding.sessionId),
    }).toEqual(before);
    store.close();
  });

  it("projects superseded Binding presence by metadata without selecting any legacy row", () => {
    const directory = temporaryDirectory("agent-workspace-acp-history-metadata-");
    const databasePath = path.join(directory, "runtime.sqlite");
    new SqliteRuntimeStore({ path: databasePath }).close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("CREATE TABLE provider_session_bindings (legacy_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    legacy.prepare("INSERT INTO provider_session_bindings VALUES (?, ?)")
      .run("legacy_binding_uninspected", "raw-private-payload-must-not-be-read");
    legacy.close();

    const store = new SqliteRuntimeStore({ path: databasePath });
    const statements: string[] = [];
    const originalMany = store.many.bind(store);
    const originalOne = store.one.bind(store);
    Object.assign(store, {
      many: (sql: string, ...parameters: never[]) => {
        statements.push(sql);
        return originalMany(sql, ...parameters);
      },
      one: (sql: string, ...parameters: never[]) => {
        statements.push(sql);
        return originalOne(sql, ...parameters);
      },
    });
    const inventory = createAcpSessionRuntimeRepositories(store, repositoryOptions).directDrain.inventory();
    expect(inventory).toMatchObject({
      total: 0,
      blocking: 0,
      historicalUninspectedProtocolTables: ["provider_session_bindings"],
    });
    expect(statements.some((sql) => /from\s+provider_session_bindings/iu.test(sql))).toBe(false);
    expect(() => store.one("SELECT payload FROM provider_session_bindings LIMIT 1"))
      .toThrow(/prohibited|not authorized/iu);
    expect(() => store.run("UPDATE provider_session_bindings SET payload = payload"))
      .toThrow(/prohibited|not authorized/iu);
    store.close();
  });

  it("upgrades v19 without rewriting published v2 bytes or unknown/superseded tables", () => {
    const directory = temporaryDirectory("agent-workspace-acp-v3-upgrade-");
    const databasePath = path.join(directory, "runtime.sqlite");
    const definitionBytes = '  { "schemaVersion": 2, "providerVersion": "historical" }\n';
    const assetBytes = new Uint8Array([0, 255, 1, 127]);
    // A direct v19 fixture: it never opens through the v20 Store and contains none of the five ACP tables.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO runtime_meta VALUES ('schema_version', '19');
      CREATE TABLE templates (
        template_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        description TEXT, status TEXT NOT NULL, active_version_id TEXT, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE template_versions (
        template_version_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(template_id),
        version INTEGER NOT NULL, schema_version INTEGER NOT NULL, definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL, asset_manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, published_at TEXT NOT NULL,
        UNIQUE(template_id, version), UNIQUE(template_id, definition_hash, asset_manifest_hash)
      );
      CREATE TABLE template_assets (
        template_version_id TEXT NOT NULL REFERENCES template_versions(template_version_id),
        asset_path TEXT NOT NULL, content_type TEXT, byte_length INTEGER NOT NULL,
        content_digest TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(template_version_id, asset_path)
      );
      CREATE TABLE operator_private_acp_notes (note_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO operator_private_acp_notes VALUES ('note_1', 'keep-private-bytes');
      CREATE TABLE provider_session_bindings (legacy_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO provider_session_bindings VALUES ('legacy_binding_1', 'do-not-translate-native-ref');
    `);
    legacy.prepare(
      `INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at)
       VALUES ('template_v2_bytes', 'v2-bytes', 'V2 bytes', 'active', 1, ?, ?)`,
    ).run(now, now);
    legacy.prepare(
      `INSERT INTO template_versions(
         template_version_id, template_id, version, schema_version, definition_json,
         definition_hash, asset_manifest_hash, created_at, published_at
       ) VALUES ('template_version_v2_bytes', 'template_v2_bytes', 1, 2, ?, ?, 'sha256:empty', ?, ?)`,
    ).run(definitionBytes, hashDefinition(JSON.parse(definitionBytes)), now, now);
    legacy.prepare(
      `INSERT INTO template_assets(
         template_version_id, asset_path, content_type, byte_length,
         content_digest, bytes, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "template_version_v2_bytes",
      "prompts/v2-private.bin",
      "application/octet-stream",
      assetBytes.byteLength,
      "sha256:v2-private-bytes",
      assetBytes,
      now,
    );
    const privateDefinition = legacy.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operator_private_acp_notes'",
    ).get() as { sql: string };
    legacy.close();

    expect(() => new SqliteRuntimeStore({
      path: databasePath,
      migrationFailpoint: (stage) => {
        if (stage === "after_acp_v3_tables") throw new Error("simulated_v19_upgrade_crash");
      },
    })).toThrow("simulated_v19_upgrade_crash");
    const interrupted = new DatabaseSync(databasePath, { readOnly: true });
    expect((interrupted.prepare(
      "SELECT definition_json FROM template_versions WHERE template_version_id = 'template_version_v2_bytes'",
    ).get() as { definition_json: string }).definition_json).toBe(definitionBytes);
    expect(new Uint8Array((interrupted.prepare(
      "SELECT bytes FROM template_assets WHERE template_version_id = 'template_version_v2_bytes'",
    ).get() as { bytes: Uint8Array }).bytes)).toEqual(assetBytes);
    expect((interrupted.prepare(
      "SELECT value FROM runtime_meta WHERE key = 'schema_version'",
    ).get() as { value: string }).value).toBe("19");
    interrupted.close();

    const store = new SqliteRuntimeStore({ path: databasePath });
    expect(store.one<{ definition_json: string }>(
      "SELECT definition_json FROM template_versions WHERE template_version_id = 'template_version_v2_bytes'",
    )?.definition_json).toBe(definitionBytes);
    expect(new Uint8Array(store.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM template_assets WHERE template_version_id = 'template_version_v2_bytes'",
    )!.bytes)).toEqual(assetBytes);
    expect(store.one<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operator_private_acp_notes'",
    )?.sql).toBe(privateDefinition.sql);
    expect(store.one<{ payload: string }>(
      "SELECT payload FROM operator_private_acp_notes WHERE note_id = 'note_1'",
    )?.payload).toBe("keep-private-bytes");
    expect(JSON.parse(store.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = ?",
      SUPERSEDED_PROTOCOL_META_KEY,
    )!.value)).toContain("provider_session_bindings");
    expect(store.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = 'schema_version'",
    )?.value).toBe("21");
    store.close();
  });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function seedCanonicalSession(store: SqliteRuntimeStore): void {
  store.run(
    `INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at)
     VALUES ('template_acp_v3', 'acp-v3', 'ACP v3', 'active', 1, ?, ?)`,
    now,
    now,
  );
  store.run(
    `INSERT INTO template_versions(
       template_version_id, template_id, version, schema_version, definition_json,
       definition_hash, asset_manifest_hash, created_at, published_at
     ) VALUES ('template_version_acp_v3', 'template_acp_v3', 1, 3, '{}', 'sha256:profile-v3', 'sha256:empty', ?, ?)`,
    now,
    now,
  );
  store.run(
    `INSERT INTO task_architecture_snapshots(
       architecture_snapshot_id, task_id, template_id, template_version_id,
       template_definition_hash, definition_json, workspace_json, created_at
     ) VALUES ('architecture_acp_v3', 'task_acp_v3', 'template_acp_v3',
       'template_version_acp_v3', 'sha256:profile-v3', '{}', '{"workspaceId":"workspace_acp_v3"}', ?)`,
    now,
  );
  store.run(
    `INSERT INTO tasks(
       task_id, architecture_snapshot_id, title, goal, status, active_run_id,
       revision, created_at, updated_at
     ) VALUES ('task_acp_v3', 'architecture_acp_v3', 'ACP v3', 'Persist safe records.',
       'running', 'run_acp_v3', 1, ?, ?)`,
    now,
    now,
  );
  store.run(
    `INSERT INTO task_runs(
       run_id, task_id, conductor_logical_session_id, status, run_number,
       revision, started_at
     ) VALUES ('run_acp_v3', 'task_acp_v3', 'logical_session_acp_v3', 'running', 1, 1, ?)`,
    now,
  );
  store.run(
    `INSERT INTO session_id_card_session_slots(
       card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
       latest_generation, revision, created_at, updated_at
     ) VALUES ('card_session_slot_acp_v3', 'task_acp_v3', 'run_acp_v3',
       'agent_card_acp_v3', 'logical_session_acp_v3', 1, 1, ?, ?)`,
    now,
    now,
  );
  store.run(
    `INSERT INTO session_id_logical_sessions(
       session_id, card_session_slot_id, task_id, run_id, session_kind,
       architecture_schema_version, agent_card_id, execution_profile_id,
       profile_revision_id, generation, lifecycle, created_at
     ) VALUES ('logical_session_acp_v3', 'card_session_slot_acp_v3', 'task_acp_v3',
       'run_acp_v3', 'card', 3, 'agent_card_acp_v3', 'profile_acp_v3',
       'profile_revision_acp_v3', 1, 'current', ?)`,
    now,
  );
}

function bindingRecord(): AcpSafeSessionBindingRecordV3 {
  return {
    schemaVersion: 3,
    bindingId: "binding_acp_v3",
    taskId: "task_acp_v3",
    runId: "run_acp_v3",
    logicalSessionId: "logical_session_acp_v3",
    agentCardId: "agent_card_acp_v3",
    executionProfileId: "profile_acp_v3",
    profileRevisionId: "profile_revision_acp_v3",
    providerFamily: "opencode",
    bindingHandle: "binding_handle_acp_v3",
    status: "active",
    recoverable: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function runtimeRecord(): SessionExecutionRuntimeRecord {
  return {
    sessionExecutionRuntimeId: "session_execution_runtime_acp_v3",
    taskId: "task_acp_v3",
    runId: "run_acp_v3",
    logicalSessionId: "logical_session_acp_v3",
    state: "idle",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function attemptRecord(): SessionExecutionAttemptRecord {
  return {
    sessionExecutionAttemptId: "session_execution_attempt_acp_v3",
    sessionExecutionRuntimeId: "session_execution_runtime_acp_v3",
    taskId: "task_acp_v3",
    runId: "run_acp_v3",
    logicalSessionId: "logical_session_acp_v3",
    bindingId: "binding_acp_v3",
    bindingRevision: 1,
    executionProfileId: "profile_acp_v3",
    profileRevisionId: "profile_revision_acp_v3",
    inputSubmissionId: "input_acp_v3",
    orchestrationSessionTurnId: "session_turn_acp_v3",
    state: "waiting_for_interaction",
    interactions: [{
      interactionId: "interaction_acp_v3",
      promptDigest: "sha256:interaction-acp-v3",
      choices: [{ choiceId: "choice_acp_v3_allow", label: "Allow once" }],
      status: "requested",
      revision: 1,
      requestedAt: now,
    }],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function providerEffectIntent(): SessionRuntimeProviderEffectIntentRecord {
  return {
    providerEffectIntentId: "provider_effect_acp_v3",
    commandId: "command_acp_v3",
    idempotencyKey: "submit-acp-v3",
    commandType: "session_runtime.submit_delivery",
    commandFingerprint: "sha256:command-acp-v3",
    taskId: "task_acp_v3",
    runId: "run_acp_v3",
    logicalSessionId: "logical_session_acp_v3",
    sessionExecutionRuntimeId: "session_execution_runtime_acp_v3",
    sessionExecutionAttemptId: "session_execution_attempt_acp_v3",
    inputSubmissionId: "input_acp_v3",
    orchestrationSessionTurnId: "session_turn_acp_v3",
    bindingId: "binding_acp_v3",
    bindingRevision: 1,
    executionProfileId: "profile_acp_v3",
    profileRevisionId: "profile_revision_acp_v3",
    effect: {
      kind: "submit_delivery",
      bindingHandle: "binding_handle_acp_v3",
      sessionExecutionAttemptId: "session_execution_attempt_acp_v3",
      content: "Persist this delivery safely.",
    },
    state: "pending",
    createdAt: now,
  };
}

function bindingRetirementIntent(): AcpV3BindingRetirementIntentRecord {
  return {
    bindingRetirementIntentId: "binding_retirement_acp-v3",
    commandId: "command_retire-acp-v3",
    idempotencyKey: "task-stop:acp-v3",
    taskId: "task_acp_v3",
    runId: "run_acp_v3",
    logicalSessionId: "logical_session_acp_v3",
    bindingId: "binding_acp_v3",
    bindingRevision: 1,
    bindingHandle: "binding_handle_acp_v3",
    executionProfileId: "profile_acp_v3",
    profileRevisionId: "profile_revision_acp_v3",
    providerFamily: "opencode",
    sessionControlAuditId: "session_control_task-stop-acp-v3",
    state: "pending",
    attempts: 0,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function replaceDirectBindingTable(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE session_id_provider_bindings;
    CREATE TABLE session_id_provider_bindings (
      binding_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      agent_card_id TEXT NOT NULL,
      execution_profile_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_host_id TEXT,
      native_binding_ref TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'unbound', 'binding_effect_accepted', 'active', 'recovering',
        'released', 'unrecoverable', 'ambiguous', 'future_status'
      )),
      recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(binding_id, revision)
    );
    CREATE INDEX session_id_provider_bindings_run_idx
      ON session_id_provider_bindings(run_id, agent_card_id, binding_id);
    PRAGMA foreign_keys = ON;
  `);
  database.close();
}

function directTableSnapshot(store: SqliteRuntimeStore): unknown {
  return {
    definition: store.one<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_id_provider_bindings'",
    )?.sql,
    rows: store.many(
      "SELECT * FROM session_id_provider_bindings ORDER BY binding_id",
    ),
  };
}
