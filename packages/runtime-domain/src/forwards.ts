import {
  hashDefinition,
  type MessageForwardMode,
  type MessageForwardRecord,
  type MessageForwardSelectionRecord,
  type SessionTurnRecord,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";
import { assertRelaySelectionsAllowed, type ResolvedMessageSelection } from "./messages";

export type CreateMessageForwardInput = Readonly<{
  forwardId: string;
  forwardSelectionIds: readonly string[];
  taskId: string;
  runId: string;
  commandId: string;
  idempotencyKey: string;
  expectedTaskRevision: number;
  publishBatchId?: string;
  targetIdempotencyKey: string;
  decidedByLogicalSessionId: string;
  decidedBySessionTurn: SessionTurnRecord;
  targetLogicalSessionId: string;
  mode: MessageForwardMode;
  selections: readonly ResolvedMessageSelection[];
  renderedMessageId: string;
  now: string;
}>;

/** Builds the immutable ordered disclosure audit before any Provider effect. */
export function createMessageForward(input: CreateMessageForwardInput): MessageForwardRecord {
  invariant(input.forwardId.startsWith("message_forward_"), "message_forward_id_invalid");
  invariant(input.taskId.startsWith("task_"), "message_forward_task_id_invalid");
  invariant(input.runId.startsWith("run_"), "message_forward_run_id_invalid");
  invariant(Boolean(input.commandId.trim()), "message_forward_command_id_required");
  invariant(Boolean(input.idempotencyKey.trim()), "message_forward_idempotency_key_required");
  invariant(Boolean(input.targetIdempotencyKey.trim()), "message_forward_target_idempotency_key_required");
  invariant(Number.isSafeInteger(input.expectedTaskRevision) && input.expectedTaskRevision > 0, "message_forward_revision_invalid");
  invariant(input.decidedBySessionTurn.taskId === input.taskId && input.decidedBySessionTurn.runId === input.runId, "message_forward_decision_scope_mismatch");
  invariant(input.decidedBySessionTurn.kind === "conductor", "message_forward_decision_not_conductor");
  invariant(input.decidedBySessionTurn.targetLogicalSessionId === input.decidedByLogicalSessionId, "message_forward_decision_session_mismatch");
  invariant(input.targetLogicalSessionId.startsWith("logical_session_"), "message_forward_target_invalid");
  invariant(input.renderedMessageId.startsWith("message_"), "message_forward_rendered_message_invalid");
  invariant(input.forwardSelectionIds.length === input.selections.length, "message_forward_selection_ids_mismatch");
  if (input.mode === "invoke" && input.selections.length === 0) {
    // The assignment instruction itself is sufficient for a new Invocation.
  } else {
    assertRelaySelectionsAllowed({ selections: input.selections });
  }

  const selections: MessageForwardSelectionRecord[] = input.selections.map((selection, ordinal) => {
    const forwardSelectionId = input.forwardSelectionIds[ordinal]!;
    invariant(forwardSelectionId.startsWith("forward_selection_"), "forward_selection_id_invalid");
    if (selection.kind === "full_message") {
      invariant(selection.message.taskId === input.taskId && selection.message.runId === input.runId, "message_forward_source_scope_mismatch");
      return {
        forwardSelectionId,
        forwardId: input.forwardId,
        ordinal,
        kind: "full_message",
        sourceMessageId: selection.message.messageId,
        contentDigest: selection.message.contentDigest,
      };
    }
    invariant(selection.relayBlock.sourceMessageId.startsWith("message_"), "message_forward_relay_source_invalid");
    return {
      forwardSelectionId,
      forwardId: input.forwardId,
      ordinal,
      kind: "relay_block",
      sourceMessageId: selection.relayBlock.sourceMessageId,
      relayBlockId: selection.relayBlock.relayBlockId,
      contentDigest: selection.relayBlock.contentDigest,
    };
  });

  return {
    forwardId: input.forwardId,
    taskId: input.taskId,
    runId: input.runId,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    expectedTaskRevision: input.expectedTaskRevision,
    ...(input.publishBatchId ? { publishBatchId: input.publishBatchId } : {}),
    targetIdempotencyKey: input.targetIdempotencyKey,
    decidedByLogicalSessionId: input.decidedByLogicalSessionId,
    decidedBySessionTurnId: input.decidedBySessionTurn.sessionTurnId,
    targetLogicalSessionId: input.targetLogicalSessionId,
    mode: input.mode,
    selections,
    renderedMessageId: input.renderedMessageId,
    createdAt: input.now,
  };
}

export function messageForwardSelectionDigest(selections: readonly MessageForwardSelectionRecord[]): string {
  return hashDefinition(selections.map(({ ordinal, kind, sourceMessageId, relayBlockId, contentDigest }) => ({
    ordinal,
    kind,
    sourceMessageId,
    ...(relayBlockId ? { relayBlockId } : {}),
    contentDigest,
  })));
}
