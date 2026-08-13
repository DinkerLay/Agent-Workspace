import {
  cloneAcpSafeSessionBindingRecordV3,
  cloneSessionExecutionAttemptRecord,
  cloneSessionExecutionRuntimeRecord,
  cloneSessionExecutionSettlement,
  cloneSessionRuntimeProviderEffectIntent,
  hashDefinition,
  type AcpSafeSessionBindingRecordV3,
  type CardSessionGenerationRecord,
  type CardSessionSlotRecord,
  type JsonValue,
  type SessionControlAuditRecord,
  type SessionExecutionAttemptRecord,
  type SessionExecutionRuntimeRecord,
  type SessionExecutionSettlement,
  type SessionLaneItemRecord,
  type SessionRuntimeProviderEffectIntentRecord,
} from "@agent-workspace/runtime-contracts";
import {
  canonicalizeFinal,
  extractCanonicalRelayBlocks,
  invariant,
} from "@agent-workspace/runtime-domain";
import type {
  SessionIdHumanInterventionRecord,
  SessionIdInputSubmissionRecord,
  SessionIdRelayBlockRecord,
  SessionIdSessionMessageRecord,
  SessionIdSessionTurnRecord,
} from "@agent-workspace/runtime-store";
import type {
  SessionExecutionCanonicalSettlementCommitter,
  SessionExecutionSettlementResult,
} from "./session-execution-settlement-coordinator.js";

export interface SessionIdAcpCanonicalSettlementTaskRunCapability {
  getGeneration(logicalSessionId: string): CardSessionGenerationRecord | undefined;
  getSlot(cardSessionSlotId: string): CardSessionSlotRecord | undefined;
  getConductorSessionId(taskId: string, runId: string): string;
  readTaskRunState(taskId: string, runId: string): Readonly<{
    taskId: string;
    runId: string;
    runStatus: string;
  }>;
}

export interface SessionIdAcpCanonicalSettlementMessageCapability {
  createMessage(message: SessionIdSessionMessageRecord): void;
  getMessage(messageId: string): SessionIdSessionMessageRecord | undefined;
  findFinalByTurn(sessionTurnId: string): SessionIdSessionMessageRecord | undefined;
  createRelayBlock(block: SessionIdRelayBlockRecord): void;
}

export interface SessionIdAcpCanonicalSettlementOrchestrationCapability {
  getInboxItem(inboxItemId: string): SessionLaneItemRecord | undefined;
  listInboxItems(logicalSessionId: string): readonly SessionLaneItemRecord[];
  createInboxItem(item: SessionLaneItemRecord): void;
  updateInboxItem(item: SessionLaneItemRecord, expectedState: SessionLaneItemRecord["state"]): void;
  getInputSubmission(inputSubmissionId: string): SessionIdInputSubmissionRecord | undefined;
  updateInputSubmission(
    input: SessionIdInputSubmissionRecord,
    expectedState: SessionIdInputSubmissionRecord["state"],
  ): void;
  getTurn(sessionTurnId: string): SessionIdSessionTurnRecord | undefined;
  updateTurn(turn: SessionIdSessionTurnRecord, expectedState: SessionIdSessionTurnRecord["state"]): void;
  listControlAudits(runId: string, logicalSessionId?: string): readonly SessionControlAuditRecord[];
}

export interface SessionIdAcpCanonicalSettlementHumanCapability {
  get(humanInterventionId: string): SessionIdHumanInterventionRecord | undefined;
  update(intervention: SessionIdHumanInterventionRecord): void;
}

export interface SessionIdAcpCanonicalSettlementBindingReadCapability {
  getCurrentBinding(logicalSessionId: string): AcpSafeSessionBindingRecordV3 | undefined;
}

export interface SessionIdAcpCanonicalSettlementExecutionReadCapability {
  getRuntime(sessionExecutionRuntimeId: string): SessionExecutionRuntimeRecord | undefined;
  getAttempt(sessionExecutionAttemptId: string): SessionExecutionAttemptRecord | undefined;
}

export interface SessionIdAcpCanonicalSettlementProviderEffectReadCapability {
  listProviderEffectIntents(
    sessionExecutionAttemptId?: string,
  ): readonly SessionRuntimeProviderEffectIntentRecord[];
}

export type SessionIdAcpCanonicalSettlementCapabilities = Readonly<{
  taskRun: SessionIdAcpCanonicalSettlementTaskRunCapability;
  message: SessionIdAcpCanonicalSettlementMessageCapability;
  orchestration: SessionIdAcpCanonicalSettlementOrchestrationCapability;
  humanIntervention: SessionIdAcpCanonicalSettlementHumanCapability;
  currentBinding: SessionIdAcpCanonicalSettlementBindingReadCapability;
  sessionExecution: SessionIdAcpCanonicalSettlementExecutionReadCapability;
  providerEffects: SessionIdAcpCanonicalSettlementProviderEffectReadCapability;
}>;

/** Production binds every capability to the same SQLite outer transaction. */
export interface SessionIdAcpCanonicalSettlementTransaction {
  run<T>(work: (owners: SessionIdAcpCanonicalSettlementCapabilities) => T): T;
}

export type SessionIdAcpCanonicalSettlementCommitterOptions = Readonly<{
  now: () => string;
  createId: (kind: "message" | "inbox_item") => string;
  task: Readonly<{
    taskId: string;
    runId: string;
    conductorSessionId: string;
  }>;
  transaction: SessionIdAcpCanonicalSettlementTransaction;
}>;

/**
 * Production canonical Final writer for ACP Session Runtime settlement.
 *
 * It owns no rows. It exact-fences the persisted SR/Binding proof and then
 * coordinates only the existing Message, Orchestration and Human owner
 * capabilities inside one transaction.
 */
export function createSessionIdAcpCanonicalSettlementCommitter(
  options: SessionIdAcpCanonicalSettlementCommitterOptions,
): SessionExecutionCanonicalSettlementCommitter {
  validateOptions(options);
  return Object.freeze({ commitCanonicalAgentFinal });

  function commitCanonicalAgentFinal(value: SessionExecutionSettlement): SessionExecutionSettlementResult {
    const settlement = cloneSessionExecutionSettlement(value);
    invariant(settlement.outcome === "completed", "session_execution_settlement_not_completed");
    invariant(typeof settlement.finalContent === "string" && Boolean(settlement.finalContent.trim()),
      "session_id_acp_canonical_final_content_required");
    invariant(settlement.finalContentDigest === hashDefinition(settlement.finalContent),
      "session_id_acp_canonical_final_digest_mismatch");
    const finalContent = settlement.finalContent!;
    const finalContentDigest = settlement.finalContentDigest!;
    return options.transaction.run((owners) => {
      const proof = requireSettlementProof(owners, settlement);
      const state = requireCanonicalState(owners, settlement);
      const lateInterrupt = requireLateInterruptProof(owners, proof.attempt);
      const existing = owners.message.findFinalByTurn(settlement.orchestrationSessionTurnId);
      if (existing) return replayExistingFinal(owners, settlement, state, existing, lateInterrupt);

      invariant(state.input.state === "accepted" || state.input.state === "ambiguous",
        "session_id_acp_canonical_final_input_state_invalid");
      invariant(state.turn.state === "active" || state.turn.state === "ambiguous",
        "session_id_acp_canonical_final_turn_state_invalid");
      invariant(state.inbox.state === "handed" || state.inbox.state === "ambiguous",
        "session_id_acp_canonical_final_inbox_state_invalid");
      invariant(proof.run.runStatus === "running", "session_id_acp_canonical_run_not_accepting_final");

      const committedAt = options.now();
      const messageId = allocatedId("message", "message");
      const conductorInboxId = allocatedId("inbox_item", "inbox");
      const conductorSequence = nextLaneSequence(owners, options.task.conductorSessionId);
      const lateNotice = lateInterrupt
        ? createLateFinalNotice(settlement, lateInterrupt, committedAt, conductorSequence)
        : undefined;
      const canonicalContent = canonicalizeFinal({
        messageId,
        content: finalContent,
      });
      const message: SessionIdSessionMessageRecord = Object.freeze({
        messageId,
        taskId: settlement.taskId,
        runId: settlement.runId,
        sourceSessionId: settlement.logicalSessionId,
        sourceSessionTurnId: settlement.orchestrationSessionTurnId,
        kind: "agent_final",
        content: finalContent,
        canonicalContent,
        contentDigest: finalContentDigest,
        createdAt: committedAt,
      });
      const relayBlocks = extractCanonicalRelayBlocks({
        messageId,
        content: finalContent,
        createdAt: committedAt,
      }).map<SessionIdRelayBlockRecord>((block) => Object.freeze({
        relayBlockId: block.relayBlockId,
        sourceMessageId: block.sourceMessageId,
        ordinal: block.ordinal,
        suggestedTargetAgentCardIds: block.suggestedTargetAgentCardIds,
        ...(block.suggestedAudience ? { suggestedAudience: block.suggestedAudience } : {}),
        ...(block.topic ? { topic: block.topic } : {}),
        format: block.format,
        content: block.content,
        contentDigest: block.contentDigest,
        sourceStart: block.sourceRange.start,
        sourceEnd: block.sourceRange.end,
        createdAt: block.createdAt,
      }));
      const conductorInbox: SessionLaneItemRecord = Object.freeze({
        inboxItemId: conductorInboxId,
        taskId: settlement.taskId,
        runId: settlement.runId,
        sessionId: options.task.conductorSessionId,
        renderedMessageId: messageId,
        sequence: conductorSequence + (lateNotice ? 1 : 0),
        priority: "ordinary",
        state: "pending",
        ...(lateNotice ? { causalPredecessorInboxItemId: lateNotice.inbox.inboxItemId } : {}),
        createdAt: committedAt,
        updatedAt: committedAt,
      });
      const intervention = state.inbox.humanInterventionId
        ? owners.humanIntervention.get(state.inbox.humanInterventionId)
        : undefined;

      if (lateNotice) {
        invariant(!owners.message.getMessage(lateNotice.message.messageId),
          "session_id_acp_canonical_late_notice_identity_conflict");
        invariant(!owners.orchestration.listInboxItems(options.task.conductorSessionId)
          .some((item) => item.inboxItemId === lateNotice.inbox.inboxItemId
            || item.renderedMessageId === lateNotice.message.messageId),
        "session_id_acp_canonical_late_notice_identity_conflict");
        owners.message.createMessage(lateNotice.message);
        owners.orchestration.createInboxItem(lateNotice.inbox);
      }
      owners.message.createMessage(message);
      for (const block of relayBlocks) owners.message.createRelayBlock(block);
      owners.orchestration.updateTurn(Object.freeze({
        ...state.turn,
        state: "returned",
        finalMessageId: messageId,
        updatedAt: committedAt,
        settledAt: settlement.settledAt,
      }), state.turn.state);
      owners.orchestration.updateInputSubmission(Object.freeze({
        ...state.input,
        state: "returned",
        updatedAt: committedAt,
      }), state.input.state);
      owners.orchestration.updateInboxItem(Object.freeze({
        ...state.inbox,
        state: "handled",
        updatedAt: committedAt,
      }), state.inbox.state);
      if (intervention
        && (intervention.state === "accepted" || intervention.state === "delivered")) {
        owners.humanIntervention.update(Object.freeze({
          ...intervention,
          state: "resolved",
          updatedAt: committedAt,
        }));
      }
      owners.orchestration.createInboxItem(conductorInbox);
      return Object.freeze({
        status: "recorded" as const,
        messageId,
        inboxItemId: conductorInboxId,
      });
    });
  }

  function requireSettlementProof(
    owners: SessionIdAcpCanonicalSettlementCapabilities,
    settlement: SessionExecutionSettlement,
  ) {
    invariant(settlement.taskId === options.task.taskId && settlement.runId === options.task.runId,
      "session_id_acp_canonical_settlement_task_scope_mismatch");
    invariant(settlement.logicalSessionId !== options.task.conductorSessionId,
      "session_id_acp_canonical_worker_final_required");
    const persistedAttempt = owners.sessionExecution.getAttempt(settlement.sessionExecutionAttemptId);
    invariant(Boolean(persistedAttempt), "session_id_acp_canonical_attempt_not_found");
    const attempt = cloneSessionExecutionAttemptRecord(persistedAttempt!);
    invariant(attempt.state === "settled" && Boolean(attempt.settlement),
      "session_id_acp_canonical_attempt_not_settled");
    invariant(hashDefinition(attempt.settlement as unknown as JsonValue)
      === hashDefinition(settlement as unknown as JsonValue),
    "session_id_acp_canonical_attempt_settlement_mismatch");
    invariant(attempt.sessionExecutionRuntimeId === settlement.sessionExecutionRuntimeId
      && attempt.taskId === settlement.taskId
      && attempt.runId === settlement.runId
      && attempt.logicalSessionId === settlement.logicalSessionId
      && attempt.bindingId === settlement.bindingId
      && attempt.bindingRevision === settlement.bindingRevision
      && attempt.executionProfileId === settlement.executionProfileId
      && attempt.profileRevisionId === settlement.profileRevisionId
      && attempt.inputSubmissionId === settlement.inputSubmissionId
      && attempt.orchestrationSessionTurnId === settlement.orchestrationSessionTurnId,
    "session_id_acp_canonical_attempt_scope_mismatch");
    const persistedRuntime = owners.sessionExecution.getRuntime(settlement.sessionExecutionRuntimeId);
    invariant(Boolean(persistedRuntime), "session_id_acp_canonical_runtime_not_found");
    const runtime = cloneSessionExecutionRuntimeRecord(persistedRuntime!);
    invariant(runtime.taskId === settlement.taskId
      && runtime.runId === settlement.runId
      && runtime.logicalSessionId === settlement.logicalSessionId
      && (!runtime.activeAttemptId || runtime.activeAttemptId === attempt.sessionExecutionAttemptId),
    "session_id_acp_canonical_runtime_scope_mismatch");
    const persistedBinding = owners.currentBinding.getCurrentBinding(settlement.logicalSessionId);
    invariant(Boolean(persistedBinding), "session_id_acp_canonical_current_binding_not_found");
    const binding = cloneAcpSafeSessionBindingRecordV3(persistedBinding!);
    invariant((binding.status === "active" || binding.status === "recovering")
      && binding.taskId === settlement.taskId
      && binding.runId === settlement.runId
      && binding.logicalSessionId === settlement.logicalSessionId
      && binding.bindingId === settlement.bindingId
      && binding.revision === settlement.bindingRevision
      && binding.executionProfileId === settlement.executionProfileId
      && binding.profileRevisionId === settlement.profileRevisionId,
    "session_id_acp_canonical_current_binding_mismatch");
    const generation = owners.taskRun.getGeneration(settlement.logicalSessionId);
    invariant(Boolean(generation)
      && generation!.taskId === settlement.taskId
      && generation!.runId === settlement.runId
      && generation!.sessionId === settlement.logicalSessionId
      && generation!.executionProfileId === settlement.executionProfileId
      && generation!.lifecycle === "current"
      && generation!.closedAt === undefined,
    "session_id_acp_canonical_session_not_current");
    const slot = owners.taskRun.getSlot(generation!.cardSessionSlotId);
    invariant(Boolean(slot)
      && slot!.taskId === settlement.taskId
      && slot!.runId === settlement.runId
      && slot!.agentCardId === generation!.agentCardId
      && slot!.currentSessionId === settlement.logicalSessionId
      && slot!.latestGeneration === generation!.generation,
    "session_id_acp_canonical_session_not_current");
    invariant(owners.taskRun.getConductorSessionId(settlement.taskId, settlement.runId)
      === options.task.conductorSessionId,
    "session_id_acp_canonical_conductor_scope_mismatch");
    const run = owners.taskRun.readTaskRunState(settlement.taskId, settlement.runId);
    invariant(run.taskId === settlement.taskId && run.runId === settlement.runId,
      "session_id_acp_canonical_run_scope_mismatch");
    return Object.freeze({ attempt, runtime, binding, generation: generation!, slot: slot!, run });
  }

  function requireCanonicalState(
    owners: SessionIdAcpCanonicalSettlementCapabilities,
    settlement: SessionExecutionSettlement,
  ) {
    const input = owners.orchestration.getInputSubmission(settlement.inputSubmissionId);
    const turn = owners.orchestration.getTurn(settlement.orchestrationSessionTurnId);
    invariant(Boolean(input) && Boolean(turn), "session_id_acp_canonical_or_state_missing");
    const inbox = owners.orchestration.getInboxItem(input!.sourceInboxItemId);
    invariant(Boolean(inbox), "session_id_acp_canonical_source_inbox_missing");
    invariant(input!.taskId === settlement.taskId
      && input!.runId === settlement.runId
      && input!.sessionId === settlement.logicalSessionId
      && turn!.taskId === settlement.taskId
      && turn!.runId === settlement.runId
      && turn!.sessionId === settlement.logicalSessionId
      && turn!.inputSubmissionId === input!.inputSubmissionId
      && inbox!.taskId === settlement.taskId
      && inbox!.runId === settlement.runId
      && inbox!.sessionId === settlement.logicalSessionId
      && inbox!.inboxItemId === input!.sourceInboxItemId
      && inbox!.renderedMessageId === input!.contentMessageId,
    "session_id_acp_canonical_or_scope_mismatch");
    return Object.freeze({ input: input!, turn: turn!, inbox: inbox! });
  }

  function requireLateInterruptProof(
    owners: SessionIdAcpCanonicalSettlementCapabilities,
    attempt: SessionExecutionAttemptRecord,
  ): SessionControlAuditRecord | undefined {
    const effects = owners.providerEffects.listProviderEffectIntents(attempt.sessionExecutionAttemptId)
      .map(cloneSessionRuntimeProviderEffectIntent)
      .filter((intent) => intent.commandType === "session_runtime.request_interrupt"
        && intent.effect.kind === "request_interrupt");
    if (effects.length === 0) return undefined;
    invariant(effects.length === 1, "session_id_acp_canonical_late_interrupt_ambiguous");
    const effect = effects[0]!;
    invariant(effect.taskId === attempt.taskId
      && effect.runId === attempt.runId
      && effect.logicalSessionId === attempt.logicalSessionId
      && effect.sessionExecutionRuntimeId === attempt.sessionExecutionRuntimeId
      && effect.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
      && effect.inputSubmissionId === attempt.inputSubmissionId
      && effect.orchestrationSessionTurnId === attempt.orchestrationSessionTurnId
      && effect.bindingId === attempt.bindingId
      && effect.bindingRevision === attempt.bindingRevision
      && effect.effect.kind === "request_interrupt"
      && effect.effect.sessionExecutionAttemptId === attempt.sessionExecutionAttemptId
      && Boolean(effect.sessionControlAuditId)
      && effect.effect.sessionControlAuditId === effect.sessionControlAuditId,
    "session_id_acp_canonical_late_interrupt_scope_mismatch");
    const controls = owners.orchestration.listControlAudits(attempt.runId, attempt.logicalSessionId)
      .filter((control) => control.sessionControlAuditId === effect.sessionControlAuditId);
    invariant(controls.length === 1, "session_id_acp_canonical_late_interrupt_control_missing");
    const control = controls[0]!;
    invariant(control.taskId === attempt.taskId
      && control.runId === attempt.runId
      && control.sessionId === attempt.logicalSessionId
      && (control.kind === "human_interrupt" || control.kind === "conductor_interrupt")
      && control.state === "unknown"
      && control.reason === "provider_terminal_won",
    "session_id_acp_canonical_late_interrupt_control_mismatch");
    return control;
  }

  function createLateFinalNotice(
    settlement: SessionExecutionSettlement,
    control: SessionControlAuditRecord,
    createdAt: string,
    sequence: number,
  ): Readonly<{ message: SessionIdSessionMessageRecord; inbox: SessionLaneItemRecord }> {
    const identity = hashDefinition({
      schemaVersion: 1,
      reason: "late_final_after_interrupt",
      sessionExecutionAttemptId: settlement.sessionExecutionAttemptId,
      sessionControlAuditId: control.sessionControlAuditId,
    }).replace(/^sha256:/u, "");
    const messageId = `message_acp_late_final_${identity}`;
    const inboxItemId = `inbox_acp_late_final_${identity}`;
    const actor = control.kind === "human_interrupt" ? "authenticated human" : "Conductor-requested";
    const content = `A Final arrived after the ${actor} scoped interrupt for Session ${settlement.logicalSessionId}; preserve its original provenance.`;
    return Object.freeze({
      message: Object.freeze({
        messageId,
        taskId: settlement.taskId,
        runId: settlement.runId,
        sourceSessionId: settlement.logicalSessionId,
        sourceSessionTurnId: settlement.orchestrationSessionTurnId,
        kind: "runtime_notice" as const,
        content,
        canonicalContent: Object.freeze([{ kind: "text" as const, text: content }]),
        contentDigest: hashDefinition(content),
        createdAt,
      }),
      inbox: Object.freeze({
        inboxItemId,
        taskId: settlement.taskId,
        runId: settlement.runId,
        sessionId: options.task.conductorSessionId,
        renderedMessageId: messageId,
        sequence,
        priority: "notice" as const,
        state: "pending" as const,
        createdAt,
        updatedAt: createdAt,
      }),
    });
  }

  function replayExistingFinal(
    owners: SessionIdAcpCanonicalSettlementCapabilities,
    settlement: SessionExecutionSettlement,
    state: ReturnType<typeof requireCanonicalState>,
    existing: SessionIdSessionMessageRecord,
    lateInterrupt: SessionControlAuditRecord | undefined,
  ): SessionExecutionSettlementResult {
    invariant(existing.taskId === settlement.taskId
      && existing.runId === settlement.runId
      && existing.kind === "agent_final"
      && existing.sourceSessionId === settlement.logicalSessionId
      && existing.sourceSessionTurnId === settlement.orchestrationSessionTurnId
      && existing.contentDigest === settlement.finalContentDigest
      && existing.content === settlement.finalContent,
    "session_id_acp_canonical_final_replay_conflict");
    invariant(state.input.state === "returned"
      && state.turn.state === "returned"
      && state.turn.finalMessageId === existing.messageId
      && state.inbox.state === "handled",
    "session_id_acp_canonical_final_replay_state_conflict");
    const conductorInboxes = owners.orchestration.listInboxItems(options.task.conductorSessionId)
      .filter((item) => item.renderedMessageId === existing.messageId);
    invariant(conductorInboxes.length === 1, "session_id_acp_canonical_final_inbox_missing");
    if (lateInterrupt) {
      const expected = createLateFinalNotice(
        settlement,
        lateInterrupt,
        existing.createdAt,
        conductorInboxes[0]!.sequence - 1,
      );
      const notice = owners.message.getMessage(expected.message.messageId);
      const noticeInboxes = owners.orchestration.listInboxItems(options.task.conductorSessionId)
        .filter((item) => item.renderedMessageId === expected.message.messageId);
      invariant(Boolean(notice)
        && notice!.contentDigest === expected.message.contentDigest
        && notice!.content === expected.message.content
        && noticeInboxes.length === 1
        && noticeInboxes[0]!.inboxItemId === expected.inbox.inboxItemId
        && noticeInboxes[0]!.sequence < conductorInboxes[0]!.sequence
        && conductorInboxes[0]!.causalPredecessorInboxItemId === expected.inbox.inboxItemId,
      "session_id_acp_canonical_late_notice_replay_conflict");
    } else {
      invariant(!conductorInboxes[0]!.causalPredecessorInboxItemId,
        "session_id_acp_canonical_final_causal_predecessor_conflict");
    }
    return Object.freeze({
      status: "replayed" as const,
      messageId: existing.messageId,
      inboxItemId: conductorInboxes[0]!.inboxItemId,
    });
  }

  function nextLaneSequence(
    owners: SessionIdAcpCanonicalSettlementCapabilities,
    logicalSessionId: string,
  ): number {
    return owners.orchestration.listInboxItems(logicalSessionId)
      .reduce((maximum, item) => Math.max(maximum, item.sequence), 0) + 1;
  }

  function allocatedId(kind: "message" | "inbox_item", prefix: string): string {
    return prefixedId(options.createId(kind), prefix, `session_id_acp_canonical_${kind}_id_invalid`);
  }
}

function validateOptions(options: SessionIdAcpCanonicalSettlementCommitterOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.transaction?.run === "function",
  "session_id_acp_canonical_options_invalid");
  prefixedId(options.task.taskId, "task", "session_id_acp_canonical_task_scope_invalid");
  prefixedId(options.task.runId, "run", "session_id_acp_canonical_task_scope_invalid");
  prefixedId(options.task.conductorSessionId, "logical_session", "session_id_acp_canonical_task_scope_invalid");
}

function prefixedId(value: unknown, prefix: string, code: string): string {
  invariant(typeof value === "string"
    && value.length <= 256
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(value),
  code);
  return value;
}
