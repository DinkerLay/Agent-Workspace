import type {
  AgentCardDefinition,
  LogicalSessionRecord,
  ProviderSessionBootstrap,
  TaskArchitectureSnapshot,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors.js";

/**
 * Compiles one Provider-neutral bootstrap from the immutable Task Architecture
 * snapshot. This is intentionally pure: it cannot open a Provider Session,
 * persist state, or inspect a Provider-native identity.
 */
export function compileProviderSessionBootstrap(input: {
  readonly architecture: Pick<TaskArchitectureSnapshot, "definition">;
  readonly session: LogicalSessionRecord;
}): ProviderSessionBootstrap {
  const { definition } = input.architecture;
  const card = cardForSession(definition.conductor, definition.agentCards, input.session);
  invariant(card.executionProfileId === input.session.executionProfileId, "session_execution_profile_mismatch");

  if (input.session.kind === "conductor") {
    return {
      purpose: "task_conductor",
      agentCardId: card.agentCardId,
      systemPrompt: card.systemPrompt,
      capabilityRefs: card.capabilityRefs,
      dispatchRegistry: definition.agentCards.map((worker) => {
        if (worker.kind === "conductor") throw new Error("worker_card_kind_invalid");
        const profile = worker.dispatchProfile;
        invariant(profile !== undefined, "worker_dispatch_profile_missing");
        return {
          agentCardId: worker.agentCardId,
          kind: worker.kind,
          title: profile.title,
          description: profile.description,
        };
      }),
    };
  }

  invariant(card.kind !== "conductor", "worker_session_resolved_conductor");
  return {
    purpose: "task_worker",
    agentCardId: card.agentCardId,
    systemPrompt: card.systemPrompt,
    capabilityRefs: card.capabilityRefs,
  };
}

function cardForSession(
  conductor: AgentCardDefinition,
  workers: readonly AgentCardDefinition[],
  session: LogicalSessionRecord,
): AgentCardDefinition {
  if (session.kind === "conductor") {
    invariant(session.agentCardId === conductor.agentCardId, "conductor_session_card_mismatch");
    return conductor;
  }
  const worker = workers.find((candidate) => candidate.agentCardId === session.agentCardId);
  invariant(worker !== undefined, "worker_session_card_missing");
  return worker;
}
