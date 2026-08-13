import {
  canonicalJson,
  cloneAcpV3BindingRetirementIntentRecord,
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionRuntimeProviderEffectIntent,
  type AcpSafeSessionBindingRecordV3,
  type AcpV3BindingRetirementIntentRecord,
  type JsonValue,
  type ProviderFamily,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import { decodeJson, encodeJson, SqliteRuntimeStore } from "./sqlite.js";

type Row = Record<string, unknown>;

export type DirectBindingDrainStatus =
  | "unbound"
  | "binding_effect_accepted"
  | "active"
  | "recovering"
  | "released"
  | "unrecoverable"
  | "ambiguous"
  | "unknown";

export type DirectBindingDrainItem = Readonly<{
  bindingId: string;
  logicalSessionId: string;
  providerFamily: ProviderFamily | "unknown";
  status: DirectBindingDrainStatus;
  disposition: "safe" | "blocking";
}>;

export type DirectBindingDrainInventory = Readonly<{
  total: number;
  safe: number;
  blocking: number;
  bindings: readonly DirectBindingDrainItem[];
  historicalUninspectedProtocolTables: readonly string[];
}>;

export type AcpV3FrozenProfileTuple = Readonly<{
  schemaVersion: 3;
  executionProfileId: string;
  profileRevisionId: string;
  providerFamily: ProviderFamily;
}>;

export type AcpV3FrozenProfileTupleResolver = (
  scope: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    executionProfileId: string;
  }>,
) => AcpV3FrozenProfileTuple | undefined;

export interface AcpV3BindingRepository {
  readonly createBinding: (
    binding: AcpSafeSessionBindingRecordV3,
    options: Readonly<{ makeCurrent: boolean }>,
  ) => void;
  readonly getBinding: (bindingId: string) => AcpSafeSessionBindingRecordV3 | undefined;
  readonly getCurrentBinding: (logicalSessionId: string) => AcpSafeSessionBindingRecordV3 | undefined;
  readonly listBindings: (logicalSessionId: string) => readonly AcpSafeSessionBindingRecordV3[];
  readonly listBindingsForRun: (taskId: string, runId: string) => readonly AcpSafeSessionBindingRecordV3[];
  /** Terminal updates atomically clear the current pointer. */
  readonly updateBinding: (binding: AcpSafeSessionBindingRecordV3, expectedRevision: number) => void;
}

export interface AcpV3SessionRuntimeRepository {
  readonly createRuntime: (runtime: SessionExecutionRuntimeRecord) => void;
  readonly getRuntime: (sessionExecutionRuntimeId: string) => SessionExecutionRuntimeRecord | undefined;
  readonly getRuntimeForSession: (logicalSessionId: string) => SessionExecutionRuntimeRecord | undefined;
  readonly updateRuntime: (runtime: SessionExecutionRuntimeRecord, expectedRevision: number) => void;
  readonly createAttempt: (attempt: SessionExecutionAttemptRecord) => void;
  readonly getAttempt: (sessionExecutionAttemptId: string) => SessionExecutionAttemptRecord | undefined;
  readonly listAttempts: (sessionExecutionRuntimeId: string) => readonly SessionExecutionAttemptRecord[];
  readonly updateAttempt: (attempt: SessionExecutionAttemptRecord, expectedRevision: number) => void;
}

export interface AcpV3ReliabilityRepository {
  readonly createProviderEffectIntent: (
    intent: SessionRuntimeProviderEffectIntentRecord,
  ) => SessionRuntimeProviderEffectIntentRecord;
  readonly getProviderEffectIntent: (
    providerEffectIntentId: string,
  ) => SessionRuntimeProviderEffectIntentRecord | undefined;
  readonly listProviderEffectIntents: (
    sessionExecutionAttemptId?: string,
  ) => readonly SessionRuntimeProviderEffectIntentRecord[];
  readonly suppressUnhandedProviderEffectIntents: (input: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    inputSubmissionIds: readonly string[];
    suppressedAt: string;
  }>) => readonly string[];
  readonly createBindingRetirementIntent: (
    intent: AcpV3BindingRetirementIntentRecord,
  ) => AcpV3BindingRetirementIntentRecord;
  readonly getBindingRetirementIntent: (
    bindingRetirementIntentId: string,
  ) => AcpV3BindingRetirementIntentRecord | undefined;
  readonly findBindingRetirementIntentByIdempotencyKey: (
    scope: Readonly<{ taskId: string; runId: string; bindingId: string; idempotencyKey: string }>,
  ) => AcpV3BindingRetirementIntentRecord | undefined;
  readonly listBindingRetirementIntents: (
    logicalSessionId?: string,
  ) => readonly AcpV3BindingRetirementIntentRecord[];
  /** `confirmed_dead_host_recovery` is never inferred from time; the caller must hold that Host authority. */
  readonly claimBindingRetirementIntent: (input: Readonly<{
    bindingRetirementIntentId: string;
    expectedRevision: number;
    mode: "initial" | "confirmed_dead_host_recovery";
    updatedAt: string;
  }>) => AcpV3BindingRetirementIntentRecord;
  readonly settleBindingRetirementReleased: (input: Readonly<{
    bindingRetirementIntentId: string;
    expectedRevision: number;
    releasedAt: string;
  }>) => AcpV3BindingRetirementIntentRecord;
  readonly settleBindingRetirementUnknown: (input: Readonly<{
    bindingRetirementIntentId: string;
    expectedRevision: number;
    failureCode: string;
    updatedAt: string;
  }>) => AcpV3BindingRetirementIntentRecord;
}

export interface DirectBindingDrainRepository {
  readonly inventory: () => DirectBindingDrainInventory;
  readonly assertDrained: () => DirectBindingDrainInventory;
  /** Atomically prevents every future direct Binding create after proving the current table drained. */
  readonly sealDrainedForCutover: () => DirectBindingDrainInventory;
}

export type AcpSessionRuntimeOwnerRepositories = Readonly<{
  binding: AcpV3BindingRepository;
  sessionRuntime: AcpV3SessionRuntimeRepository;
  reliability: AcpV3ReliabilityRepository;
  directDrain: DirectBindingDrainRepository;
}>;

export type AcpSessionRuntimeRepositories = AcpSessionRuntimeOwnerRepositories & Readonly<{
  transaction: <T>(work: (owners: AcpSessionRuntimeOwnerRepositories) => T) => T;
}>;

/**
 * Phase-6 Store boundary. It intentionally knows only Runtime contracts and
 * SQLite; application/SR runtime code is a caller, never a Store dependency.
 */
export function createAcpSessionRuntimeRepositories(
  store: SqliteRuntimeStore,
  options: Readonly<{
    resolveFrozenProfileTuple: AcpV3FrozenProfileTupleResolver;
  }>,
): AcpSessionRuntimeRepositories {
  if (typeof options?.resolveFrozenProfileTuple !== "function") {
    throw new Error("acp_v3_frozen_profile_resolver_required");
  }
  const binding: AcpV3BindingRepository = {
    createBinding(value, { makeCurrent }) {
      const candidate = cloneAcpSafeSessionBindingRecordV3(value);
      if (candidate.revision !== 1) throw new Error("acp_v3_binding_initial_revision_invalid");
      if (makeCurrent && isTerminalBinding(candidate)) {
        throw new Error("acp_v3_terminal_binding_cannot_be_current");
      }
      assertLogicalSessionScope(store, candidate);
      assertFrozenProfileTuple(options.resolveFrozenProfileTuple, candidate);
      store.transaction(() => {
        const existing = binding.getBinding(candidate.bindingId);
        if (existing) {
          if (!sameRecord(existing, candidate)) throw new Error("acp_v3_binding_id_conflict");
          if (makeCurrent) assertCurrentPointer(store, candidate);
          return;
        }
        const handleOwner = store.one<Row>(
          "SELECT binding_id FROM session_id_acp_v3_bindings WHERE binding_handle = ?",
          candidate.bindingHandle,
        );
        if (handleOwner) throw new Error("acp_v3_binding_handle_conflict");
        if (makeCurrent) assertNoOtherCurrentBinding(store, candidate.logicalSessionId, candidate.bindingId);
        store.run(
          `INSERT INTO session_id_acp_v3_bindings(
             binding_id, schema_version, task_id, run_id, logical_session_id, agent_card_id,
             execution_profile_id, profile_revision_id, provider_family, binding_handle,
             status, recoverable, revision, created_at, updated_at
           ) VALUES (?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          candidate.bindingId,
          candidate.taskId,
          candidate.runId,
          candidate.logicalSessionId,
          candidate.agentCardId,
          candidate.executionProfileId,
          candidate.profileRevisionId,
          candidate.providerFamily,
          candidate.bindingHandle,
          candidate.status,
          candidate.recoverable ? 1 : 0,
          candidate.revision,
          candidate.createdAt,
          candidate.updatedAt,
        );
        if (makeCurrent) {
          store.run(
            `INSERT INTO session_id_acp_v3_current_bindings(
               logical_session_id, binding_id, binding_revision, updated_at
             ) VALUES (?, ?, ?, ?)`,
            candidate.logicalSessionId,
            candidate.bindingId,
            candidate.revision,
            candidate.updatedAt,
          );
        }
      });
    },
    getBinding(bindingId) {
      const row = store.one<Row>(
        "SELECT * FROM session_id_acp_v3_bindings WHERE binding_id = ?",
        bindingId,
      );
      return row ? bindingFromRow(row) : undefined;
    },
    getCurrentBinding(logicalSessionId) {
      const pointer = store.one<Row>(
        `SELECT binding_id, binding_revision
         FROM session_id_acp_v3_current_bindings
         WHERE logical_session_id = ?`,
        logicalSessionId,
      );
      if (!pointer) return undefined;
      const current = binding.getBinding(text(pointer.binding_id));
      if (!current
        || current.logicalSessionId !== logicalSessionId
        || current.revision !== positiveInteger(pointer.binding_revision)) {
        throw new Error("acp_v3_current_binding_pointer_corrupt");
      }
      if (isTerminalBinding(current)) throw new Error("acp_v3_current_binding_terminal_corrupt");
      return current;
    },
    listBindings(logicalSessionId) {
      return Object.freeze(store.many<Row>(
        `SELECT * FROM session_id_acp_v3_bindings
         WHERE logical_session_id = ? ORDER BY created_at, binding_id`,
        logicalSessionId,
      ).map(bindingFromRow));
    },
    listBindingsForRun(taskId, runId) {
      return Object.freeze(store.many<Row>(
        `SELECT * FROM session_id_acp_v3_bindings
         WHERE task_id = ? AND run_id = ? ORDER BY created_at, binding_id`,
        taskId,
        runId,
      ).map(bindingFromRow));
    },
    updateBinding(value, expectedRevision) {
      const candidate = cloneAcpSafeSessionBindingRecordV3(value);
      if (candidate.revision !== expectedRevision + 1) {
        throw new Error("acp_v3_binding_revision_transition_invalid");
      }
      store.transaction(() => {
        const current = binding.getBinding(candidate.bindingId);
        if (!current) throw new Error("acp_v3_binding_not_found");
        if (current.revision !== expectedRevision) throw new Error("acp_v3_binding_revision_stale");
        assertBindingImmutableScope(current, candidate);
        if (isTerminalBinding(current)) throw new Error("acp_v3_binding_terminal");
        const pointer = store.one<Row>(
          `SELECT logical_session_id, binding_revision
           FROM session_id_acp_v3_current_bindings WHERE binding_id = ?`,
          candidate.bindingId,
        );
        if (pointer && positiveInteger(pointer.binding_revision) !== expectedRevision) {
          throw new Error("acp_v3_current_binding_pointer_stale");
        }
        store.run(
          `UPDATE session_id_acp_v3_bindings
           SET status = ?, recoverable = ?, revision = ?, updated_at = ?
           WHERE binding_id = ? AND revision = ?`,
          candidate.status,
          candidate.recoverable ? 1 : 0,
          candidate.revision,
          candidate.updatedAt,
          candidate.bindingId,
          expectedRevision,
        );
        if (pointer) {
          if (isTerminalBinding(candidate)) {
            store.run(
              `DELETE FROM session_id_acp_v3_current_bindings
               WHERE binding_id = ? AND binding_revision = ?`,
              candidate.bindingId,
              expectedRevision,
            );
          } else {
            store.run(
              `UPDATE session_id_acp_v3_current_bindings
               SET binding_revision = ?, updated_at = ?
               WHERE binding_id = ? AND binding_revision = ?`,
              candidate.revision,
              candidate.updatedAt,
              candidate.bindingId,
              expectedRevision,
            );
          }
        }
        const persisted = binding.getBinding(candidate.bindingId);
        if (!persisted || persisted.revision !== candidate.revision || !sameRecord(persisted, candidate)) {
          throw new Error("acp_v3_binding_revision_stale");
        }
      });
    },
  };

  const sessionRuntime: AcpV3SessionRuntimeRepository = {
    createRuntime(value) {
      const candidate = cloneSessionExecutionRuntimeRecord(value);
      if (candidate.revision !== 1) throw new Error("acp_v3_runtime_initial_revision_invalid");
      assertLogicalSessionScope(store, candidate);
      const existing = sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId);
      if (existing) {
        if (!sameRecord(existing, candidate)) throw new Error("acp_v3_runtime_id_conflict");
        return;
      }
      const sessionOwner = sessionRuntime.getRuntimeForSession(candidate.logicalSessionId);
      if (sessionOwner) throw new Error("acp_v3_runtime_session_conflict");
      store.run(
        `INSERT INTO session_id_acp_v3_execution_runtimes(
           session_execution_runtime_id, task_id, run_id, logical_session_id, state,
           active_attempt_id, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidate.sessionExecutionRuntimeId,
        candidate.taskId,
        candidate.runId,
        candidate.logicalSessionId,
        candidate.state,
        candidate.activeAttemptId ?? null,
        candidate.revision,
        candidate.createdAt,
        candidate.updatedAt,
      );
    },
    getRuntime(sessionExecutionRuntimeId) {
      const row = store.one<Row>(
        `SELECT * FROM session_id_acp_v3_execution_runtimes
         WHERE session_execution_runtime_id = ?`,
        sessionExecutionRuntimeId,
      );
      return row ? runtimeFromRow(row) : undefined;
    },
    getRuntimeForSession(logicalSessionId) {
      const row = store.one<Row>(
        `SELECT * FROM session_id_acp_v3_execution_runtimes
         WHERE logical_session_id = ?`,
        logicalSessionId,
      );
      return row ? runtimeFromRow(row) : undefined;
    },
    updateRuntime(value, expectedRevision) {
      const candidate = cloneSessionExecutionRuntimeRecord(value);
      if (candidate.revision !== expectedRevision + 1) {
        throw new Error("acp_v3_runtime_revision_transition_invalid");
      }
      const current = sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId);
      if (!current) throw new Error("acp_v3_runtime_not_found");
      if (current.revision !== expectedRevision) throw new Error("acp_v3_runtime_revision_stale");
      assertRuntimeImmutableScope(current, candidate);
      if (candidate.activeAttemptId) {
        const attempt = sessionRuntime.getAttempt(candidate.activeAttemptId);
        if (!attempt || attempt.sessionExecutionRuntimeId !== candidate.sessionExecutionRuntimeId) {
          throw new Error("acp_v3_runtime_active_attempt_mismatch");
        }
      }
      store.run(
        `UPDATE session_id_acp_v3_execution_runtimes
         SET state = ?, active_attempt_id = ?, revision = ?, updated_at = ?
         WHERE session_execution_runtime_id = ? AND revision = ?`,
        candidate.state,
        candidate.activeAttemptId ?? null,
        candidate.revision,
        candidate.updatedAt,
        candidate.sessionExecutionRuntimeId,
        expectedRevision,
      );
      const persisted = sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId);
      if (!persisted || !sameRecord(persisted, candidate)) throw new Error("acp_v3_runtime_revision_stale");
    },
    createAttempt(value) {
      const candidate = cloneSessionExecutionAttemptRecord(value);
      if (candidate.revision !== 1) throw new Error("acp_v3_attempt_initial_revision_invalid");
      assertAttemptScope(candidate);
      const existing = sessionRuntime.getAttempt(candidate.sessionExecutionAttemptId);
      if (existing) {
        if (!sameRecord(existing, candidate)) throw new Error("acp_v3_attempt_id_conflict");
        return;
      }
      store.run(
        `INSERT INTO session_id_acp_v3_execution_attempts(
           session_execution_attempt_id, session_execution_runtime_id, task_id, run_id,
           logical_session_id, binding_id, binding_revision, execution_profile_id,
           profile_revision_id, input_submission_id, orchestration_session_turn_id,
           state, record_json, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidate.sessionExecutionAttemptId,
        candidate.sessionExecutionRuntimeId,
        candidate.taskId,
        candidate.runId,
        candidate.logicalSessionId,
        candidate.bindingId,
        candidate.bindingRevision,
        candidate.executionProfileId,
        candidate.profileRevisionId,
        candidate.inputSubmissionId,
        candidate.orchestrationSessionTurnId,
        candidate.state,
        encodeJson(candidate),
        candidate.revision,
        candidate.createdAt,
        candidate.updatedAt,
      );
    },
    getAttempt(sessionExecutionAttemptId) {
      const row = store.one<Row>(
        `SELECT * FROM session_id_acp_v3_execution_attempts
         WHERE session_execution_attempt_id = ?`,
        sessionExecutionAttemptId,
      );
      return row ? attemptFromRow(row) : undefined;
    },
    listAttempts(sessionExecutionRuntimeId) {
      return Object.freeze(store.many<Row>(
        `SELECT * FROM session_id_acp_v3_execution_attempts
         WHERE session_execution_runtime_id = ?
         ORDER BY created_at, session_execution_attempt_id`,
        sessionExecutionRuntimeId,
      ).map(attemptFromRow));
    },
    updateAttempt(value, expectedRevision) {
      const candidate = cloneSessionExecutionAttemptRecord(value);
      if (candidate.revision !== expectedRevision + 1) {
        throw new Error("acp_v3_attempt_revision_transition_invalid");
      }
      const current = sessionRuntime.getAttempt(candidate.sessionExecutionAttemptId);
      if (!current) throw new Error("acp_v3_attempt_not_found");
      if (current.revision !== expectedRevision) throw new Error("acp_v3_attempt_revision_stale");
      assertAttemptImmutableScope(current, candidate);
      store.run(
        `UPDATE session_id_acp_v3_execution_attempts
         SET state = ?, record_json = ?, revision = ?, updated_at = ?
         WHERE session_execution_attempt_id = ? AND revision = ?`,
        candidate.state,
        encodeJson(candidate),
        candidate.revision,
        candidate.updatedAt,
        candidate.sessionExecutionAttemptId,
        expectedRevision,
      );
      const persisted = sessionRuntime.getAttempt(candidate.sessionExecutionAttemptId);
      if (!persisted || !sameRecord(persisted, candidate)) throw new Error("acp_v3_attempt_revision_stale");
    },
  };

  function assertAttemptScope(candidate: SessionExecutionAttemptRecord): void {
    const runtime = sessionRuntime.getRuntime(candidate.sessionExecutionRuntimeId);
    if (!runtime
      || runtime.taskId !== candidate.taskId
      || runtime.runId !== candidate.runId
      || runtime.logicalSessionId !== candidate.logicalSessionId) {
      throw new Error("acp_v3_attempt_runtime_scope_mismatch");
    }
    const candidateBinding = binding.getBinding(candidate.bindingId);
    if (!candidateBinding
      || candidateBinding.taskId !== candidate.taskId
      || candidateBinding.runId !== candidate.runId
      || candidateBinding.logicalSessionId !== candidate.logicalSessionId
      || candidateBinding.executionProfileId !== candidate.executionProfileId
      || candidateBinding.profileRevisionId !== candidate.profileRevisionId
      || candidateBinding.revision !== candidate.bindingRevision) {
      throw new Error("acp_v3_attempt_binding_scope_mismatch");
    }
    const currentBinding = binding.getCurrentBinding(candidate.logicalSessionId);
    if (!currentBinding
      || currentBinding.bindingId !== candidate.bindingId
      || currentBinding.revision !== candidate.bindingRevision) {
      throw new Error("acp_v3_attempt_binding_not_current");
    }
  }

  const reliability: AcpV3ReliabilityRepository = {
    createProviderEffectIntent(value) {
      const candidate = cloneSessionRuntimeProviderEffectIntent(value);
      assertProviderEffectScope(candidate);
      const existing = reliability.getProviderEffectIntent(candidate.providerEffectIntentId);
      if (existing) {
        if (!sameRecord(existing, candidate)) throw new Error("acp_v3_provider_effect_id_conflict");
        return existing;
      }
      const idempotencyConflict = store.one<Row>(
        `SELECT provider_effect_intent_id
         FROM session_id_acp_v3_provider_effect_intents
         WHERE command_id = ?
            OR (task_id = ? AND run_id = ? AND command_type = ? AND idempotency_key = ?)`,
        candidate.commandId,
        candidate.taskId,
        candidate.runId,
        candidate.commandType,
        candidate.idempotencyKey,
      );
      if (idempotencyConflict) throw new Error("acp_v3_provider_effect_idempotency_conflict");
      store.run(
        `INSERT INTO session_id_acp_v3_provider_effect_intents(
           provider_effect_intent_id, command_id, idempotency_key, command_type,
           task_id, run_id, logical_session_id, session_execution_runtime_id,
           session_execution_attempt_id, binding_id, binding_revision, state,
           record_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        candidate.providerEffectIntentId,
        candidate.commandId,
        candidate.idempotencyKey,
        candidate.commandType,
        candidate.taskId,
        candidate.runId,
        candidate.logicalSessionId,
        candidate.sessionExecutionRuntimeId,
        candidate.sessionExecutionAttemptId,
        candidate.bindingId,
        candidate.bindingRevision,
        encodeJson(candidate),
        candidate.createdAt,
      );
      return candidate;
    },
    getProviderEffectIntent(providerEffectIntentId) {
      const row = store.one<Row>(
        `SELECT * FROM session_id_acp_v3_provider_effect_intents
         WHERE provider_effect_intent_id = ?`,
        providerEffectIntentId,
      );
      return row ? providerEffectFromRow(row) : undefined;
    },
    listProviderEffectIntents(sessionExecutionAttemptId) {
      const rows = sessionExecutionAttemptId === undefined
        ? store.many<Row>(
          `SELECT * FROM session_id_acp_v3_provider_effect_intents
           ORDER BY created_at, provider_effect_intent_id`,
        )
        : store.many<Row>(
          `SELECT * FROM session_id_acp_v3_provider_effect_intents
           WHERE session_execution_attempt_id = ?
           ORDER BY created_at, provider_effect_intent_id`,
          sessionExecutionAttemptId,
        );
      return Object.freeze(rows.map(providerEffectFromRow));
    },
    suppressUnhandedProviderEffectIntents(input) {
      const inputIds = [...new Set(input.inputSubmissionIds)];
      const suppressed: string[] = [];
      for (const inputSubmissionId of inputIds) {
        const rows = store.many<Row>(
          `SELECT * FROM session_id_acp_v3_provider_effect_intents
           WHERE task_id = ? AND run_id = ? AND logical_session_id = ?
             AND command_type = 'session_runtime.submit_delivery' AND state = 'pending'`,
          input.taskId,
          input.runId,
          input.logicalSessionId,
        );
        for (const row of rows) {
          const current = providerEffectFromRow(row);
          if (current.inputSubmissionId !== inputSubmissionId) continue;
          const next = cloneSessionRuntimeProviderEffectIntent({
            ...current,
            state: "suppressed",
            suppressionReason: "task_stopped",
            suppressedAt: input.suppressedAt,
          });
          store.run(
            `UPDATE session_id_acp_v3_provider_effect_intents
             SET state = 'suppressed', record_json = ?
             WHERE provider_effect_intent_id = ? AND state = 'pending'`,
            encodeJson(next),
            next.providerEffectIntentId,
          );
          suppressed.push(next.providerEffectIntentId);
        }
      }
      return Object.freeze(suppressed);
    },
    createBindingRetirementIntent(value) {
      const candidate = cloneAcpV3BindingRetirementIntentRecord(value);
      if (candidate.state !== "pending" || candidate.attempts !== 0 || candidate.revision !== 1) {
        throw new Error("acp_v3_binding_retirement_initial_state_invalid");
      }
      const existing = reliability.getBindingRetirementIntent(candidate.bindingRetirementIntentId);
      if (existing) {
        if (!sameBindingRetirementCreation(existing, candidate)) {
          throw new Error("acp_v3_binding_retirement_id_conflict");
        }
        return existing;
      }
      assertBindingRetirementScope(candidate);
      const conflict = store.one<Row>(
        `SELECT binding_retirement_intent_id
         FROM session_id_acp_v3_binding_retirement_intents
         WHERE command_id = ?
            OR (task_id = ? AND run_id = ? AND binding_id = ? AND idempotency_key = ?)`,
        candidate.commandId,
        candidate.taskId,
        candidate.runId,
        candidate.bindingId,
        candidate.idempotencyKey,
      );
      if (conflict) throw new Error("acp_v3_binding_retirement_idempotency_conflict");
      const unresolved = store.one<Row>(
        `SELECT binding_retirement_intent_id
         FROM session_id_acp_v3_binding_retirement_intents
         WHERE task_id = ? AND run_id = ? AND binding_id = ?
           AND state IN ('pending', 'retiring', 'unknown')`,
        candidate.taskId,
        candidate.runId,
        candidate.bindingId,
      );
      if (unresolved) throw new Error("acp_v3_binding_retirement_unresolved_conflict");
      store.run(
        `INSERT INTO session_id_acp_v3_binding_retirement_intents(
           binding_retirement_intent_id, command_id, idempotency_key,
           task_id, run_id, logical_session_id, binding_id, binding_revision,
           state, attempts, revision, record_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ?)`,
        candidate.bindingRetirementIntentId,
        candidate.commandId,
        candidate.idempotencyKey,
        candidate.taskId,
        candidate.runId,
        candidate.logicalSessionId,
        candidate.bindingId,
        candidate.bindingRevision,
        encodeJson(candidate),
        candidate.createdAt,
        candidate.updatedAt,
      );
      return candidate;
    },
    getBindingRetirementIntent(bindingRetirementIntentId) {
      const row = store.one<Row>(
        `SELECT * FROM session_id_acp_v3_binding_retirement_intents
         WHERE binding_retirement_intent_id = ?`,
        bindingRetirementIntentId,
      );
      return row ? bindingRetirementFromRow(row) : undefined;
    },
    findBindingRetirementIntentByIdempotencyKey(scope) {
      const row = store.one<Row>(
        `SELECT * FROM session_id_acp_v3_binding_retirement_intents
         WHERE task_id = ? AND run_id = ? AND binding_id = ? AND idempotency_key = ?`,
        scope.taskId,
        scope.runId,
        scope.bindingId,
        scope.idempotencyKey,
      );
      return row ? bindingRetirementFromRow(row) : undefined;
    },
    listBindingRetirementIntents(logicalSessionId) {
      const rows = logicalSessionId === undefined
        ? store.many<Row>(
          `SELECT * FROM session_id_acp_v3_binding_retirement_intents
           ORDER BY created_at, binding_retirement_intent_id`,
        )
        : store.many<Row>(
          `SELECT * FROM session_id_acp_v3_binding_retirement_intents
           WHERE logical_session_id = ? ORDER BY created_at, binding_retirement_intent_id`,
          logicalSessionId,
        );
      return Object.freeze(rows.map(bindingRetirementFromRow));
    },
    claimBindingRetirementIntent(input) {
      const current = requiredBindingRetirementIntent(reliability, input.bindingRetirementIntentId);
      if (current.revision !== input.expectedRevision) throw new Error("acp_v3_binding_retirement_revision_conflict");
      if ((input.mode === "initial" && current.state !== "pending")
        || (input.mode === "confirmed_dead_host_recovery" && current.state !== "retiring")) {
        throw new Error("acp_v3_binding_retirement_claim_state_invalid");
      }
      assertBindingRetirementScope(current);
      const next = cloneAcpV3BindingRetirementIntentRecord({
        ...current,
        state: "retiring",
        attempts: current.attempts + 1,
        revision: current.revision + 1,
        updatedAt: input.updatedAt,
      });
      updateBindingRetirementIntent(store, next, current.revision);
      return next;
    },
    settleBindingRetirementReleased(input) {
      const current = requiredBindingRetirementIntent(reliability, input.bindingRetirementIntentId);
      if (current.revision !== input.expectedRevision) throw new Error("acp_v3_binding_retirement_revision_conflict");
      if (current.state !== "retiring") throw new Error("acp_v3_binding_retirement_settle_state_invalid");
      const next = cloneAcpV3BindingRetirementIntentRecord({
        ...current,
        state: "released",
        revision: current.revision + 1,
        updatedAt: input.releasedAt,
        releasedAt: input.releasedAt,
      });
      updateBindingRetirementIntent(store, next, current.revision);
      return next;
    },
    settleBindingRetirementUnknown(input) {
      const current = requiredBindingRetirementIntent(reliability, input.bindingRetirementIntentId);
      if (current.revision !== input.expectedRevision) throw new Error("acp_v3_binding_retirement_revision_conflict");
      if (current.state !== "retiring") throw new Error("acp_v3_binding_retirement_settle_state_invalid");
      const next = cloneAcpV3BindingRetirementIntentRecord({
        ...current,
        state: "unknown",
        failureCode: input.failureCode,
        revision: current.revision + 1,
        updatedAt: input.updatedAt,
      });
      updateBindingRetirementIntent(store, next, current.revision);
      return next;
    },
  };

  function assertBindingRetirementScope(candidate: AcpV3BindingRetirementIntentRecord): void {
    const candidateBinding = binding.getBinding(candidate.bindingId);
    if (!candidateBinding
      || candidateBinding.taskId !== candidate.taskId
      || candidateBinding.runId !== candidate.runId
      || candidateBinding.logicalSessionId !== candidate.logicalSessionId
      || candidateBinding.revision !== candidate.bindingRevision
      || candidateBinding.bindingHandle !== candidate.bindingHandle
      || candidateBinding.executionProfileId !== candidate.executionProfileId
      || candidateBinding.profileRevisionId !== candidate.profileRevisionId
      || candidateBinding.providerFamily !== candidate.providerFamily) {
      throw new Error("acp_v3_binding_retirement_binding_scope_mismatch");
    }
    const currentBinding = binding.getCurrentBinding(candidate.logicalSessionId);
    if (!currentBinding
      || currentBinding.bindingId !== candidate.bindingId
      || currentBinding.revision !== candidate.bindingRevision) {
      throw new Error("acp_v3_binding_retirement_binding_not_current");
    }
    assertFrozenProfileTuple(options.resolveFrozenProfileTuple, candidateBinding);
  }

  function assertProviderEffectScope(candidate: SessionRuntimeProviderEffectIntentRecord): void {
    const attempt = sessionRuntime.getAttempt(candidate.sessionExecutionAttemptId);
    if (!attempt
      || attempt.sessionExecutionRuntimeId !== candidate.sessionExecutionRuntimeId
      || attempt.taskId !== candidate.taskId
      || attempt.runId !== candidate.runId
      || attempt.logicalSessionId !== candidate.logicalSessionId
      || attempt.bindingId !== candidate.bindingId
      || attempt.bindingRevision !== candidate.bindingRevision
      || attempt.executionProfileId !== candidate.executionProfileId
      || attempt.profileRevisionId !== candidate.profileRevisionId
      || attempt.inputSubmissionId !== candidate.inputSubmissionId
      || attempt.orchestrationSessionTurnId !== candidate.orchestrationSessionTurnId) {
      throw new Error("acp_v3_provider_effect_attempt_scope_mismatch");
    }
    const candidateBinding = binding.getBinding(candidate.bindingId);
    if (!candidateBinding
      || candidateBinding.revision !== candidate.bindingRevision
      || candidateBinding.bindingHandle !== candidate.effect.bindingHandle) {
      throw new Error("acp_v3_provider_effect_binding_scope_mismatch");
    }
    const currentBinding = binding.getCurrentBinding(candidate.logicalSessionId);
    if (!currentBinding
      || currentBinding.bindingId !== candidate.bindingId
      || currentBinding.revision !== candidate.bindingRevision) {
      throw new Error("acp_v3_provider_effect_binding_not_current");
    }
  }

  const directDrain: DirectBindingDrainRepository = {
    inventory() {
      const bindings = Object.freeze(store.many<Row>(
        `SELECT binding_id, session_id, provider, status
         FROM session_id_provider_bindings ORDER BY rowid`,
      ).map((row): DirectBindingDrainItem => {
        const status = directStatus(row.status);
        return Object.freeze({
          bindingId: safeInventoryId(row.binding_id, "binding"),
          logicalSessionId: safeInventoryId(row.session_id, "logical_session"),
          providerFamily: directProviderFamily(row.provider),
          status,
          disposition: status === "released" || status === "unrecoverable" ? "safe" : "blocking",
        });
      }));
      const safe = bindings.filter((entry) => entry.disposition === "safe").length;
      return Object.freeze({
        total: bindings.length,
        safe,
        blocking: bindings.length - safe,
        bindings,
        historicalUninspectedProtocolTables: historicalUninspectedProtocolTables(store),
      });
    },
    assertDrained() {
      const result = directDrain.inventory();
      if (result.blocking > 0) {
        throw new Error(`acp_v3_direct_bindings_not_drained:${result.blocking}`);
      }
      return result;
    },
    sealDrainedForCutover() {
      return store.transaction(() => {
        const result = directDrain.assertDrained();
        store.run(
          "INSERT OR REPLACE INTO runtime_meta(key, value) VALUES (?, ?)",
          "acp_direct_binding_cutover_sealed",
          "1",
        );
        return result;
      });
    },
  };

  const owners: AcpSessionRuntimeOwnerRepositories = Object.freeze({
    binding,
    sessionRuntime,
    reliability,
    directDrain,
  });
  return Object.freeze({
    ...owners,
    transaction: <T>(work: (repositories: AcpSessionRuntimeOwnerRepositories) => T): T => (
      store.transaction(() => work(owners))
    ),
  });
}

function assertFrozenProfileTuple(
  resolve: AcpV3FrozenProfileTupleResolver,
  candidate: AcpSafeSessionBindingRecordV3,
): void {
  const frozen = resolve({
    taskId: candidate.taskId,
    runId: candidate.runId,
    logicalSessionId: candidate.logicalSessionId,
    executionProfileId: candidate.executionProfileId,
  });
  if (!frozen
    || frozen.schemaVersion !== 3
    || frozen.executionProfileId !== candidate.executionProfileId
    || frozen.profileRevisionId !== candidate.profileRevisionId
    || frozen.providerFamily !== candidate.providerFamily) {
    throw new Error("acp_v3_binding_frozen_profile_mismatch");
  }
}

function historicalUninspectedProtocolTables(store: SqliteRuntimeStore): readonly string[] {
  const row = store.one<Row>(
    "SELECT value FROM runtime_meta WHERE key = ?",
    "superseded_protocol_tables",
  );
  if (!row) return Object.freeze([]);
  const parsed = decodeJson<unknown>(row.value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("acp_v3_superseded_protocol_metadata_corrupt");
  }
  return Object.freeze(parsed.filter((entry) => entry === "provider_session_bindings"));
}

function bindingFromRow(row: Row): AcpSafeSessionBindingRecordV3 {
  if (positiveInteger(row.schema_version) !== 3) throw new Error("acp_v3_binding_schema_corrupt");
  return cloneAcpSafeSessionBindingRecordV3({
    schemaVersion: 3,
    bindingId: text(row.binding_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    logicalSessionId: text(row.logical_session_id),
    agentCardId: text(row.agent_card_id),
    executionProfileId: text(row.execution_profile_id),
    profileRevisionId: text(row.profile_revision_id),
    providerFamily: text(row.provider_family) as ProviderFamily,
    bindingHandle: text(row.binding_handle),
    status: text(row.status) as AcpSafeSessionBindingRecordV3["status"],
    recoverable: booleanInteger(row.recoverable),
    revision: positiveInteger(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function runtimeFromRow(row: Row): SessionExecutionRuntimeRecord {
  return cloneSessionExecutionRuntimeRecord({
    sessionExecutionRuntimeId: text(row.session_execution_runtime_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    logicalSessionId: text(row.logical_session_id),
    state: text(row.state) as SessionExecutionRuntimeRecord["state"],
    ...(optionalText(row.active_attempt_id) === undefined
      ? {}
      : { activeAttemptId: optionalText(row.active_attempt_id)! }),
    revision: positiveInteger(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function attemptFromRow(row: Row): SessionExecutionAttemptRecord {
  const record = cloneSessionExecutionAttemptRecord(
    decodeJson<SessionExecutionAttemptRecord>(row.record_json),
  );
  const expected = {
    sessionExecutionAttemptId: text(row.session_execution_attempt_id),
    sessionExecutionRuntimeId: text(row.session_execution_runtime_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    logicalSessionId: text(row.logical_session_id),
    bindingId: text(row.binding_id),
    bindingRevision: positiveInteger(row.binding_revision),
    executionProfileId: text(row.execution_profile_id),
    profileRevisionId: text(row.profile_revision_id),
    inputSubmissionId: text(row.input_submission_id),
    orchestrationSessionTurnId: text(row.orchestration_session_turn_id),
    state: text(row.state),
    revision: positiveInteger(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (record[key as keyof SessionExecutionAttemptRecord] !== value) {
      throw new Error("acp_v3_attempt_row_corrupt");
    }
  }
  return record;
}

function providerEffectFromRow(row: Row): SessionRuntimeProviderEffectIntentRecord {
  const record = cloneSessionRuntimeProviderEffectIntent(
    decodeJson<SessionRuntimeProviderEffectIntentRecord>(row.record_json),
  );
  const expected = {
    providerEffectIntentId: text(row.provider_effect_intent_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    commandType: text(row.command_type),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    logicalSessionId: text(row.logical_session_id),
    sessionExecutionRuntimeId: text(row.session_execution_runtime_id),
    sessionExecutionAttemptId: text(row.session_execution_attempt_id),
    bindingId: text(row.binding_id),
    bindingRevision: positiveInteger(row.binding_revision),
    state: text(row.state),
    createdAt: text(row.created_at),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (record[key as keyof SessionRuntimeProviderEffectIntentRecord] !== value) {
      throw new Error("acp_v3_provider_effect_row_corrupt");
    }
  }
  return record;
}

function bindingRetirementFromRow(row: Row): AcpV3BindingRetirementIntentRecord {
  const record = cloneAcpV3BindingRetirementIntentRecord(
    decodeJson<AcpV3BindingRetirementIntentRecord>(row.record_json),
  );
  const expected = {
    bindingRetirementIntentId: text(row.binding_retirement_intent_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    logicalSessionId: text(row.logical_session_id),
    bindingId: text(row.binding_id),
    bindingRevision: positiveInteger(row.binding_revision),
    state: text(row.state),
    attempts: nonNegativeInteger(row.attempts),
    revision: positiveInteger(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (record[key as keyof AcpV3BindingRetirementIntentRecord] !== value) {
      throw new Error("acp_v3_binding_retirement_row_corrupt");
    }
  }
  return record;
}

function requiredBindingRetirementIntent(
  reliability: AcpV3ReliabilityRepository,
  bindingRetirementIntentId: string,
): AcpV3BindingRetirementIntentRecord {
  const current = reliability.getBindingRetirementIntent(bindingRetirementIntentId);
  if (!current) throw new Error("acp_v3_binding_retirement_not_found");
  return current;
}

function updateBindingRetirementIntent(
  store: SqliteRuntimeStore,
  next: AcpV3BindingRetirementIntentRecord,
  expectedRevision: number,
): void {
  store.run(
    `UPDATE session_id_acp_v3_binding_retirement_intents
     SET state = ?, attempts = ?, revision = ?, record_json = ?, updated_at = ?
     WHERE binding_retirement_intent_id = ? AND revision = ?`,
    next.state,
    next.attempts,
    next.revision,
    encodeJson(next),
    next.updatedAt,
    next.bindingRetirementIntentId,
    expectedRevision,
  );
  const persisted = store.one<Row>(
    `SELECT revision FROM session_id_acp_v3_binding_retirement_intents
     WHERE binding_retirement_intent_id = ?`,
    next.bindingRetirementIntentId,
  );
  if (!persisted || positiveInteger(persisted.revision) !== next.revision) {
    throw new Error("acp_v3_binding_retirement_revision_conflict");
  }
}

function assertLogicalSessionScope(
  store: SqliteRuntimeStore,
  value: Readonly<{
    taskId: string;
    runId: string;
    logicalSessionId: string;
    agentCardId?: string;
    executionProfileId?: string;
    profileRevisionId?: string;
  }>,
): void {
  const session = store.one<Row>(
    `SELECT task_id, run_id, session_kind, architecture_schema_version,
            agent_card_id, execution_profile_id, profile_revision_id
     FROM session_id_logical_sessions WHERE session_id = ?`,
    value.logicalSessionId,
  );
  if (!session
    || text(session.task_id) !== value.taskId
    || text(session.run_id) !== value.runId
    || positiveInteger(session.architecture_schema_version) !== 3
    || (value.agentCardId !== undefined && text(session.agent_card_id) !== value.agentCardId)
    || (value.executionProfileId !== undefined
      && optionalText(session.execution_profile_id) !== value.executionProfileId)
    || (value.profileRevisionId !== undefined
      && optionalText(session.profile_revision_id) !== value.profileRevisionId)) {
    throw new Error("acp_v3_logical_session_scope_mismatch");
  }
}

function assertCurrentPointer(store: SqliteRuntimeStore, candidate: AcpSafeSessionBindingRecordV3): void {
  const pointer = store.one<Row>(
    `SELECT binding_id, binding_revision
     FROM session_id_acp_v3_current_bindings WHERE logical_session_id = ?`,
    candidate.logicalSessionId,
  );
  if (!pointer
    || text(pointer.binding_id) !== candidate.bindingId
    || positiveInteger(pointer.binding_revision) !== candidate.revision) {
    throw new Error("acp_v3_current_binding_replay_mismatch");
  }
}

function assertNoOtherCurrentBinding(
  store: SqliteRuntimeStore,
  logicalSessionId: string,
  bindingId: string,
): void {
  const pointer = store.one<Row>(
    "SELECT binding_id FROM session_id_acp_v3_current_bindings WHERE logical_session_id = ?",
    logicalSessionId,
  );
  if (pointer && text(pointer.binding_id) !== bindingId) {
    throw new Error("acp_v3_current_binding_conflict");
  }
}

function assertBindingImmutableScope(
  current: AcpSafeSessionBindingRecordV3,
  candidate: AcpSafeSessionBindingRecordV3,
): void {
  for (const key of [
    "schemaVersion",
    "bindingId",
    "taskId",
    "runId",
    "logicalSessionId",
    "agentCardId",
    "executionProfileId",
    "profileRevisionId",
    "providerFamily",
    "bindingHandle",
    "createdAt",
  ] as const) {
    if (current[key] !== candidate[key]) throw new Error("acp_v3_binding_scope_immutable");
  }
}

function assertRuntimeImmutableScope(
  current: SessionExecutionRuntimeRecord,
  candidate: SessionExecutionRuntimeRecord,
): void {
  for (const key of [
    "sessionExecutionRuntimeId",
    "taskId",
    "runId",
    "logicalSessionId",
    "createdAt",
  ] as const) {
    if (current[key] !== candidate[key]) throw new Error("acp_v3_runtime_scope_immutable");
  }
}

function assertAttemptImmutableScope(
  current: SessionExecutionAttemptRecord,
  candidate: SessionExecutionAttemptRecord,
): void {
  for (const key of [
    "sessionExecutionAttemptId",
    "sessionExecutionRuntimeId",
    "taskId",
    "runId",
    "logicalSessionId",
    "bindingId",
    "bindingRevision",
    "executionProfileId",
    "profileRevisionId",
    "inputSubmissionId",
    "orchestrationSessionTurnId",
    "createdAt",
  ] as const) {
    if (current[key] !== candidate[key]) throw new Error("acp_v3_attempt_scope_immutable");
  }
}

function isTerminalBinding(binding: AcpSafeSessionBindingRecordV3): boolean {
  return binding.status === "released" || binding.status === "unrecoverable";
}

function directStatus(value: unknown): DirectBindingDrainStatus {
  if (typeof value !== "string") return "unknown";
  if ([
    "unbound",
    "binding_effect_accepted",
    "active",
    "recovering",
    "released",
    "unrecoverable",
    "ambiguous",
  ].includes(value)) return value as DirectBindingDrainStatus;
  return "unknown";
}

function directProviderFamily(value: unknown): ProviderFamily | "unknown" {
  return value === "opencode" || value === "codex" || value === "claude-code" ? value : "unknown";
}

function safeInventoryId(value: unknown, prefix: "binding" | "logical_session"): string {
  if (typeof value !== "string"
    || value.length > 256
    || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value)) {
    throw new Error("acp_v3_direct_binding_inventory_identity_invalid");
  }
  return value;
}

function sameRecord(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

function sameBindingRetirementCreation(
  existing: AcpV3BindingRetirementIntentRecord,
  candidate: AcpV3BindingRetirementIntentRecord,
): boolean {
  const immutableKeys = [
    "bindingRetirementIntentId",
    "commandId",
    "idempotencyKey",
    "taskId",
    "runId",
    "logicalSessionId",
    "bindingId",
    "bindingRevision",
    "bindingHandle",
    "executionProfileId",
    "profileRevisionId",
    "providerFamily",
    "sessionControlAuditId",
    "createdAt",
  ] as const;
  return immutableKeys.every((key) => existing[key] === candidate[key]);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("acp_v3_store_text_corrupt");
  return value;
}

function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value);
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("acp_v3_store_integer_corrupt");
  }
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("acp_v3_store_integer_corrupt");
  }
  return value as number;
}

function booleanInteger(value: unknown): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error("acp_v3_store_boolean_corrupt");
}
