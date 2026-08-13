import type { ConductorPlanningFenceRecord } from "../../runtime-contracts/src";
import { invariant } from "./errors";

export function advanceConductorPlanningFence(input: Readonly<{
  previous?: ConductorPlanningFenceRecord;
  planningFenceId: string;
  taskId: string;
  runId: string;
  sourceCommandId: string;
  conductorSessionTurnId: string;
  now: string;
}>): ConductorPlanningFenceRecord {
  if (input.previous) {
    invariant(input.previous.taskId === input.taskId && input.previous.runId === input.runId, "planning_fence_scope_mismatch");
  }
  return Object.freeze({
    planningFenceId: input.planningFenceId,
    taskId: input.taskId,
    runId: input.runId,
    sourceCommandId: input.sourceCommandId,
    ...(input.previous?.currentConductorSessionTurnId
      ? { previousConductorSessionTurnId: input.previous.currentConductorSessionTurnId }
      : {}),
    currentConductorSessionTurnId: input.conductorSessionTurnId,
    createdAt: input.now,
  });
}
export function assertCurrentConductorPlanningTurn(
  fence: ConductorPlanningFenceRecord | undefined,
  conductorSessionTurnId: string,
): void {
  invariant(Boolean(fence), "planning_fence_missing");
  invariant(fence?.currentConductorSessionTurnId === conductorSessionTurnId, "conductor_planning_fence_stale");
}
