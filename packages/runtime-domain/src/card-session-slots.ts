import type {
  AgentCardId,
  CardSessionGenerationRecord,
  CardSessionSlotId,
  CardSessionSlotRecord,
  ExecutionProfileId,
  LogicalSessionId,
  TaskId,
  TaskRunId,
} from "../../runtime-contracts/src";
import { invariant } from "./errors";

export type MaterializeCardSessionInput = Readonly<{
  slot?: CardSessionSlotRecord;
  taskId: TaskId;
  runId: TaskRunId;
  agentCardId: AgentCardId;
  executionProfileId: ExecutionProfileId;
  cardSessionSlotId: CardSessionSlotId;
  sessionId: LogicalSessionId;
  now: string;
}>;

/**
 * Materialization creates only the Runtime address and its generation. Content,
 * Inbox, Binding and Turn records deliberately belong to later owners.
 */
export function materializeCardSessionGeneration(input: MaterializeCardSessionInput): Readonly<{
  slot: CardSessionSlotRecord;
  generation: CardSessionGenerationRecord;
}> {
  invariant(input.runId.startsWith("run_"), "card_session_slot_run_id_invalid");
  invariant(input.agentCardId.startsWith("agent_card_"), "card_session_slot_agent_card_id_invalid");
  invariant(typeof input.executionProfileId === "string" && input.executionProfileId.startsWith("profile_"),
    "card_session_generation_execution_profile_id_invalid");
  invariant(input.sessionId.startsWith("logical_session_"), "card_session_generation_session_id_invalid");
  const previous = input.slot;
  if (previous) {
    invariant(previous.taskId === input.taskId && previous.runId === input.runId, "card_session_slot_scope_mismatch");
    invariant(previous.agentCardId === input.agentCardId, "card_session_slot_agent_card_mismatch");
    invariant(!previous.currentSessionId, "card_session_slot_current_exists");
  }
  const generation = (previous?.latestGeneration ?? 0) + 1;
  const slot: CardSessionSlotRecord = {
    cardSessionSlotId: previous?.cardSessionSlotId ?? input.cardSessionSlotId,
    taskId: input.taskId,
    runId: input.runId,
    agentCardId: input.agentCardId,
    currentSessionId: input.sessionId,
    latestGeneration: generation,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  return Object.freeze({
    slot: Object.freeze(slot),
    generation: Object.freeze({
      sessionId: input.sessionId,
      cardSessionSlotId: slot.cardSessionSlotId,
      taskId: input.taskId,
      runId: input.runId,
      agentCardId: input.agentCardId,
      executionProfileId: input.executionProfileId,
      generation,
      lifecycle: "current",
      createdAt: input.now,
    }),
  });
}

export function retireCardSessionGeneration(input: Readonly<{
  slot: CardSessionSlotRecord;
  generation: CardSessionGenerationRecord;
  now: string;
}>): Readonly<{ slot: CardSessionSlotRecord; generation: CardSessionGenerationRecord }> {
  invariant(input.slot.currentSessionId === input.generation.sessionId, "orchestration_session_not_current");
  invariant(input.generation.lifecycle === "current", "orchestration_session_not_current");
  return Object.freeze({
    slot: Object.freeze({
      ...input.slot,
      currentSessionId: undefined,
      revision: input.slot.revision + 1,
      updatedAt: input.now,
    }),
    generation: Object.freeze({
      ...input.generation,
      lifecycle: "closed",
      closedAt: input.now,
    }),
  });
}
