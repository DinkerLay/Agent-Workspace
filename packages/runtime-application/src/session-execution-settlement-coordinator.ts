import type { SessionExecutionSettlement } from "@agent-workspace/runtime-contracts";
import { cloneSessionExecutionSettlement } from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";

export type SessionExecutionSettlementResult = Readonly<{
  status: "recorded" | "replayed";
  messageId: string;
  inboxItemId: string;
}>;

/**
 * Owner-scoped atomic seam implemented by production composition in Phase 6.
 *
 * An implementation must, in the same owner transaction, load the persisted
 * settled SR attempt and current ACP-safe Binding, exact-fence every correlation
 * field, and then delegate to the canonical `recordAgentFinal` use case. It may
 * not expose Message/Orchestration writers or materialize a parallel OR model.
 */
export interface SessionExecutionCanonicalSettlementCommitter {
  commitCanonicalAgentFinal(
    settlement: SessionExecutionSettlement,
  ): SessionExecutionSettlementResult;
}

export type SessionExecutionSettlementCoordinatorOptions = Readonly<{
  committer: SessionExecutionCanonicalSettlementCommitter;
}>;

export function createSessionExecutionSettlementCoordinator(
  options: SessionExecutionSettlementCoordinatorOptions,
) {
  return Object.freeze({ acceptSettlement });

  function acceptSettlement(value: SessionExecutionSettlement): SessionExecutionSettlementResult {
    const settlement = cloneSessionExecutionSettlement(value);
    invariant(settlement.outcome === "completed", "session_execution_settlement_not_completed");
    return options.committer.commitCanonicalAgentFinal(settlement);
  }
}
