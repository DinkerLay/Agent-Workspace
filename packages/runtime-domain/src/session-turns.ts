import {
  hashDefinition,
  type HumanInterventionRecord,
  type InvocationRecord,
  type ProviderFact,
  type SessionMessageRecord,
  type SessionTurnInitiator,
  type SessionTurnRecord,
  type SessionTurnTrigger,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";

export type CreateSessionTurnInput = Readonly<{
  sessionTurnId: string;
  taskId: string;
  runId: string;
  inputSubmissionId: string;
  targetLogicalSessionId: string;
  kind: "conductor" | "session_agent";
  initiator: SessionTurnInitiator;
  trigger: SessionTurnTrigger;
  conductorLogicalSessionId: string;
  replyToLogicalSessionId?: string;
  invocationId?: string;
  humanInterventionId?: string;
  affectedSessionTurnId?: string;
  now: string;
}>;

export function createSessionTurn(input: CreateSessionTurnInput): SessionTurnRecord {
  invariant(input.sessionTurnId.startsWith("session_turn_"), "session_turn_id_invalid");
  invariant(input.taskId.startsWith("task_"), "session_turn_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "session_turn_run_id_invalid");
  invariant(input.inputSubmissionId.startsWith("input_"), "session_turn_input_id_invalid");
  invariant(input.targetLogicalSessionId.startsWith("logical_session_"), "session_turn_target_invalid");
  invariant(input.conductorLogicalSessionId.startsWith("logical_session_"), "session_turn_conductor_invalid");
  if (input.kind === "conductor") {
    invariant(input.targetLogicalSessionId === input.conductorLogicalSessionId, "conductor_turn_target_mismatch");
    invariant(input.replyToLogicalSessionId === undefined, "conductor_turn_must_not_self_reply");
  } else {
    invariant(input.targetLogicalSessionId !== input.conductorLogicalSessionId, "session_agent_turn_target_invalid");
    invariant(input.replyToLogicalSessionId === input.conductorLogicalSessionId, "session_agent_turn_reply_target_invalid");
  }
  invariant((input.trigger === "conductor_invocation") === Boolean(input.invocationId), "session_turn_invocation_trigger_mismatch");
  invariant(
    input.kind !== "session_agent" || !["human_direct", "human_interrupt_then_send"].includes(input.trigger) || Boolean(input.humanInterventionId),
    "session_turn_human_intervention_required",
  );
  invariant(
    input.initiator !== "human" || ["human_direct", "human_interrupt_then_send", "attention_continuation"].includes(input.trigger),
    "session_turn_human_trigger_invalid",
  );
  return {
    sessionTurnId: input.sessionTurnId,
    taskId: input.taskId,
    runId: input.runId,
    inputSubmissionId: input.inputSubmissionId,
    targetLogicalSessionId: input.targetLogicalSessionId,
    kind: input.kind,
    initiator: input.initiator,
    trigger: input.trigger,
    ...(input.replyToLogicalSessionId ? { replyToLogicalSessionId: input.replyToLogicalSessionId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    ...(input.humanInterventionId ? { humanInterventionId: input.humanInterventionId } : {}),
    ...(input.affectedSessionTurnId ? { affectedSessionTurnId: input.affectedSessionTurnId } : {}),
    status: "staged",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export type SessionTurnCorrelationIndex = Readonly<{
  readonly bySessionTurnId: ReadonlyMap<string, readonly SessionTurnRecord[]>;
  readonly byInputSubmissionId: ReadonlyMap<string, readonly SessionTurnRecord[]>;
  readonly byInvocationId: ReadonlyMap<string, readonly SessionTurnRecord[]>;
}>;

/** Builds the single Runtime-owned join used to validate Provider correlations. */
export function indexSessionTurns(turns: readonly SessionTurnRecord[]): SessionTurnCorrelationIndex {
  return {
    bySessionTurnId: indexTurnsBy(turns, (turn) => turn.sessionTurnId),
    byInputSubmissionId: indexTurnsBy(turns, (turn) => turn.inputSubmissionId),
    byInvocationId: indexTurnsBy(turns, (turn) => turn.invocationId),
  };
}

/**
 * Resolves only when every supplied Runtime correlation key names the same,
 * unique Turn. Native Provider identifiers are deliberately not joins.
 */
export function resolveProviderFactSessionTurn(
  fact: Pick<ProviderFact, "correlation">,
  index: SessionTurnCorrelationIndex,
): SessionTurnRecord | undefined {
  const correlation = fact.correlation;
  const candidates: SessionTurnRecord[] = [];
  if (correlation.sessionTurnId) {
    const candidate = uniqueIndexedTurn(index.bySessionTurnId, correlation.sessionTurnId);
    if (!candidate) return undefined;
    candidates.push(candidate);
  }
  if (correlation.inputSubmissionId) {
    const candidate = uniqueIndexedTurn(index.byInputSubmissionId, correlation.inputSubmissionId);
    if (!candidate) return undefined;
    candidates.push(candidate);
  }
  if (correlation.invocationId) {
    const candidate = uniqueIndexedTurn(index.byInvocationId, correlation.invocationId);
    if (!candidate) return undefined;
    candidates.push(candidate);
  }
  const resolved = candidates[0];
  return resolved && candidates.every((candidate) => candidate.sessionTurnId === resolved.sessionTurnId)
    ? resolved
    : undefined;
}

export function hasProviderFactTurnCorrelation(fact: Pick<ProviderFact, "correlation">): boolean {
  return Boolean(
    fact.correlation.sessionTurnId
    || fact.correlation.inputSubmissionId
    || fact.correlation.invocationId,
  );
}

export function applyProviderFactToSessionTurn(
  turn: SessionTurnRecord,
  fact: ProviderFact,
  now: string,
  turnIndex: SessionTurnCorrelationIndex,
): SessionTurnRecord {
  if (resolveProviderFactSessionTurn(fact, turnIndex)?.sessionTurnId !== turn.sessionTurnId) return turn;
  if (turn.finalMessageId) return turn.status === "returned" ? turn : { ...turn, status: "returned", updatedAt: now };
  if (fact.kind === "turn_started") return { ...turn, status: "running", updatedAt: now };
  if (fact.kind === "assistant_final" || fact.kind === "turn_completed") {
    if (["interrupted", "cancelled"].includes(turn.status)) return turn;
    return turn.finalMessageId
      ? { ...turn, status: "returned", updatedAt: now }
      : { ...turn, status: "awaiting_final", updatedAt: now };
  }
  if (fact.kind === "turn_failed") return { ...turn, status: "failed", updatedAt: now };
  if (fact.kind === "interrupt_confirmed") return { ...turn, status: "interrupted", updatedAt: now };
  if (fact.kind === "transport_unknown") return { ...turn, status: "ambiguous", updatedAt: now };
  return turn;
}

export function requestSessionTurnInterrupt(turn: SessionTurnRecord, now: string): SessionTurnRecord {
  invariant(["staged", "running", "awaiting_final"].includes(turn.status), "session_turn_not_interruptible");
  return { ...turn, status: "interrupt_requested", updatedAt: now };
}

export function recordSessionTurnFinalMessage(turn: SessionTurnRecord, message: SessionMessageRecord, now: string): SessionTurnRecord {
  invariant(message.kind === "agent_final", "session_turn_final_kind_invalid");
  invariant(message.sourceSessionTurnId === turn.sessionTurnId, "session_turn_final_source_mismatch");
  invariant(message.sourceLogicalSessionId === turn.targetLogicalSessionId, "session_turn_final_session_mismatch");
  invariant(message.taskId === turn.taskId && message.runId === turn.runId, "session_turn_final_scope_mismatch");
  invariant(!turn.finalMessageId || turn.finalMessageId === message.messageId, "session_turn_final_already_recorded");
  return { ...turn, finalMessageId: message.messageId, status: "returned", updatedAt: now };
}

export function isSessionTurnActive(turn: SessionTurnRecord): boolean {
  return ["staged", "running", "awaiting_final", "interrupt_requested", "ambiguous"].includes(turn.status);
}

export function resolveSessionTurnFinalContent(
  turn: SessionTurnRecord,
  facts: readonly ProviderFact[],
  turnIndex: SessionTurnCorrelationIndex,
): string | undefined {
  const correlated = facts.filter((fact) => resolveProviderFactSessionTurn(fact, turnIndex)?.sessionTurnId === turn.sessionTurnId);
  if (!correlated.some((fact) => fact.kind === "turn_completed")) return undefined;
  const contents = correlated
    .filter((fact) => fact.kind === "assistant_final")
    .map((fact) => typeof fact.payload.content === "string" ? fact.payload.content : undefined)
    .filter((content): content is string => Boolean(content?.trim()));
  return contents.length === 1 ? contents[0] : undefined;
}

export function hasSessionTurnTerminalFailure(
  turn: SessionTurnRecord,
  facts: readonly ProviderFact[],
  turnIndex: SessionTurnCorrelationIndex,
): boolean {
  return facts.some((fact) => resolveProviderFactSessionTurn(fact, turnIndex)?.sessionTurnId === turn.sessionTurnId
    && (fact.kind === "turn_failed" || fact.kind === "interrupt_confirmed"));
}

function indexTurnsBy(
  turns: readonly SessionTurnRecord[],
  keyFor: (turn: SessionTurnRecord) => string | undefined,
): ReadonlyMap<string, readonly SessionTurnRecord[]> {
  const index = new Map<string, SessionTurnRecord[]>();
  for (const turn of turns) {
    const key = keyFor(turn);
    if (!key) continue;
    const matches = index.get(key) ?? [];
    matches.push(turn);
    index.set(key, matches);
  }
  return index;
}

function uniqueIndexedTurn(
  index: ReadonlyMap<string, readonly SessionTurnRecord[]>,
  key: string,
): SessionTurnRecord | undefined {
  const matches = index.get(key);
  return matches?.length === 1 ? matches[0] : undefined;
}

export type CreateHumanInterventionInput = Readonly<{
  humanInterventionId: string;
  taskId: string;
  runId: string;
  commandId: string;
  idempotencyKey: string;
  expectedTaskRevision: number;
  targetLogicalSessionId: string;
  content: string;
  activeTurn?: SessionTurnRecord;
  affectedInvocation?: InvocationRecord;
  now: string;
}>;

/** Authenticated human provenance is established here, never inferred from Provider role. */
export function createHumanIntervention(input: CreateHumanInterventionInput): HumanInterventionRecord {
  invariant(input.humanInterventionId.startsWith("human_intervention_"), "human_intervention_id_invalid");
  invariant(input.taskId.startsWith("task_"), "human_intervention_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "human_intervention_run_id_invalid");
  invariant(Boolean(input.commandId.trim()), "human_intervention_command_id_required");
  invariant(Boolean(input.idempotencyKey.trim()), "human_intervention_idempotency_key_required");
  invariant(Boolean(input.content.trim()), "human_intervention_content_required");
  invariant(input.targetLogicalSessionId.startsWith("logical_session_"), "human_intervention_target_invalid");
  if (input.activeTurn) {
    invariant(input.activeTurn.taskId === input.taskId && input.activeTurn.runId === input.runId, "human_intervention_turn_scope_mismatch");
    invariant(input.activeTurn.targetLogicalSessionId === input.targetLogicalSessionId, "human_intervention_turn_target_mismatch");
  }
  if (input.affectedInvocation) {
    invariant(input.activeTurn?.invocationId === input.affectedInvocation.invocationId, "human_intervention_invocation_mismatch");
  }
  const interrupting = Boolean(input.activeTurn && isSessionTurnActive(input.activeTurn));
  return {
    humanInterventionId: input.humanInterventionId,
    taskId: input.taskId,
    runId: input.runId,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    expectedTaskRevision: input.expectedTaskRevision,
    targetLogicalSessionId: input.targetLogicalSessionId,
    content: input.content,
    contentDigest: hashDefinition(input.content),
    ...(input.activeTurn ? { affectedSessionTurnId: input.activeTurn.sessionTurnId } : {}),
    ...(input.affectedInvocation ? { affectedInvocationId: input.affectedInvocation.invocationId } : {}),
    mode: interrupting ? "interrupt_then_send" : "direct",
    state: interrupting ? "interrupting" : "ready_to_send",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function markHumanInterventionReady(intervention: HumanInterventionRecord, now: string): HumanInterventionRecord {
  invariant(["interrupting", "awaiting_turn_close"].includes(intervention.state), "human_intervention_not_waiting");
  return { ...intervention, state: "ready_to_send", updatedAt: now };
}

export function markHumanInterventionSent(intervention: HumanInterventionRecord, input: Readonly<{
  cardMessageId: string;
  conductorMirrorMessageId: string;
  now: string;
}>): HumanInterventionRecord {
  invariant(intervention.state === "ready_to_send", "human_intervention_not_ready");
  invariant(input.cardMessageId.startsWith("message_"), "human_intervention_card_message_invalid");
  invariant(input.conductorMirrorMessageId.startsWith("message_"), "human_intervention_mirror_message_invalid");
  return {
    ...intervention,
    cardMessageId: input.cardMessageId,
    conductorMirrorMessageId: input.conductorMirrorMessageId,
    state: "sent",
    updatedAt: input.now,
  };
}
