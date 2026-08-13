import {
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionRuntimeProviderEffectIntent,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import type {
  SessionExecutionRecordRepository,
  SessionExecutionRepository,
  SessionRuntimeCommandTransaction,
  SessionRuntimeProviderEffectIntentWriter,
} from "@agent-workspace/runtime-application";

/** In-memory owner repository for Phase 1 contracts; it is not a SQLite facade. */
export class InMemorySessionExecutionRepository implements
SessionExecutionRepository,
SessionExecutionRecordRepository,
SessionRuntimeCommandTransaction,
SessionRuntimeProviderEffectIntentWriter {
  #runtimes = new Map<string, SessionExecutionRuntimeRecord>();
  #attempts = new Map<string, SessionExecutionAttemptRecord>();
  #providerEffects = new Map<string, SessionRuntimeProviderEffectIntentRecord>();
  #inTransaction = false;

  transaction<T>(work: (records: SessionExecutionRecordRepository) => T): T {
    return this.#atomic(() => work(this));
  }

  run<T>(work: (owners: Readonly<{
    sessionExecution: SessionExecutionRecordRepository;
    providerEffects: SessionRuntimeProviderEffectIntentWriter;
  }>) => T): T {
    return this.#atomic(() => work(Object.freeze({
      sessionExecution: this,
      providerEffects: this,
    })));
  }

  #atomic<T>(work: () => T): T {
    if (this.#inTransaction) throw new Error("session_execution_nested_transaction_forbidden");
    const runtimeSnapshot = new Map(this.#runtimes);
    const attemptSnapshot = new Map(this.#attempts);
    const effectSnapshot = new Map(this.#providerEffects);
    this.#inTransaction = true;
    try {
      return work();
    } catch (error) {
      this.#runtimes = runtimeSnapshot;
      this.#attempts = attemptSnapshot;
      this.#providerEffects = effectSnapshot;
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  findRuntimeByLogicalSessionId(logicalSessionId: string): SessionExecutionRuntimeRecord | undefined {
    const runtime = [...this.#runtimes.values()].find((candidate) => candidate.logicalSessionId === logicalSessionId);
    return runtime ? cloneSessionExecutionRuntimeRecord(runtime) : undefined;
  }

  getRuntime(sessionExecutionRuntimeId: string): SessionExecutionRuntimeRecord | undefined {
    const runtime = this.#runtimes.get(sessionExecutionRuntimeId);
    return runtime ? cloneSessionExecutionRuntimeRecord(runtime) : undefined;
  }

  insertRuntime(runtime: SessionExecutionRuntimeRecord): void {
    if (this.#runtimes.has(runtime.sessionExecutionRuntimeId)) throw new Error("session_execution_runtime_duplicate");
    if ([...this.#runtimes.values()].some((candidate) => candidate.logicalSessionId === runtime.logicalSessionId)) {
      throw new Error("session_execution_logical_session_duplicate");
    }
    this.#runtimes.set(runtime.sessionExecutionRuntimeId, cloneSessionExecutionRuntimeRecord(runtime));
  }

  updateRuntime(runtime: SessionExecutionRuntimeRecord, expectedRevision: number): void {
    const current = this.#runtimes.get(runtime.sessionExecutionRuntimeId);
    if (!current) throw new Error("session_execution_runtime_not_found");
    if (current.revision !== expectedRevision || runtime.revision !== expectedRevision + 1) {
      throw new Error("session_execution_runtime_revision_stale");
    }
    this.#runtimes.set(runtime.sessionExecutionRuntimeId, cloneSessionExecutionRuntimeRecord(runtime));
  }

  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined {
    const attempt = this.#attempts.get(sessionExecutionAttemptId);
    return attempt ? cloneSessionExecutionAttemptRecord(attempt) : undefined;
  }

  insertAttempt(attempt: SessionExecutionAttemptRecord): void {
    if (this.#attempts.has(attempt.sessionExecutionAttemptId)) throw new Error("session_execution_attempt_duplicate");
    this.#attempts.set(attempt.sessionExecutionAttemptId, cloneSessionExecutionAttemptRecord(attempt));
  }

  updateAttempt(attempt: SessionExecutionAttemptRecord, expectedRevision: number): void {
    const current = this.#attempts.get(attempt.sessionExecutionAttemptId);
    if (!current) throw new Error("session_execution_attempt_not_found");
    if (current.revision !== expectedRevision || attempt.revision <= expectedRevision) {
      throw new Error("session_execution_attempt_revision_stale");
    }
    this.#attempts.set(attempt.sessionExecutionAttemptId, cloneSessionExecutionAttemptRecord(attempt));
  }

  findByCommandId(commandId: string): SessionRuntimeProviderEffectIntentRecord | undefined {
    const intent = [...this.#providerEffects.values()].find((candidate) => candidate.commandId === commandId);
    return intent ? cloneSessionRuntimeProviderEffectIntent(intent) : undefined;
  }

  findByIdempotencyKey(idempotencyKey: string): SessionRuntimeProviderEffectIntentRecord | undefined {
    const intent = [...this.#providerEffects.values()].find((candidate) => candidate.idempotencyKey === idempotencyKey);
    return intent ? cloneSessionRuntimeProviderEffectIntent(intent) : undefined;
  }

  insert(intent: SessionRuntimeProviderEffectIntentRecord): void {
    if (this.#providerEffects.has(intent.providerEffectIntentId)
      || [...this.#providerEffects.values()].some((candidate) => candidate.commandId === intent.commandId
        || candidate.idempotencyKey === intent.idempotencyKey)) {
      throw new Error("session_runtime_provider_effect_duplicate");
    }
    this.#providerEffects.set(intent.providerEffectIntentId, cloneSessionRuntimeProviderEffectIntent(intent));
  }

  snapshot(): Readonly<{
    runtimes: readonly SessionExecutionRuntimeRecord[];
    attempts: readonly SessionExecutionAttemptRecord[];
    providerEffects: readonly SessionRuntimeProviderEffectIntentRecord[];
  }> {
    return Object.freeze({
      runtimes: Object.freeze([...this.#runtimes.values()]
        .sort((left, right) => left.sessionExecutionRuntimeId.localeCompare(right.sessionExecutionRuntimeId))
        .map(cloneSessionExecutionRuntimeRecord)),
      attempts: Object.freeze([...this.#attempts.values()]
        .sort((left, right) => left.sessionExecutionAttemptId.localeCompare(right.sessionExecutionAttemptId))
        .map(cloneSessionExecutionAttemptRecord)),
      providerEffects: Object.freeze([...this.#providerEffects.values()]
        .sort((left, right) => left.providerEffectIntentId.localeCompare(right.providerEffectIntentId))
        .map(cloneSessionRuntimeProviderEffectIntent)),
    });
  }
}
