import {
  isTaskArchitectureSnapshotV3,
  validateTaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpV3FrozenProfileTupleResolver,
  SessionIdTaskRunStore,
  TemplateTaskStore,
} from "@agent-workspace/runtime-store";

/**
 * Resolves only an exact tuple frozen in one immutable schema-v3 Task
 * Architecture. A logical Session may not select or default its own Profile.
 */
export function createAcpV3FrozenProfileTupleResolver(input: Readonly<{
  templates: Pick<TemplateTaskStore, "getArchitectureSnapshot" | "getRun">;
  taskRun: Pick<SessionIdTaskRunStore, "getGeneration">;
}>): AcpV3FrozenProfileTupleResolver {
  return (scope) => {
    const architectureRead = input.templates.getArchitectureSnapshot(scope.taskId);
    if (!architectureRead || !isTaskArchitectureSnapshotV3(architectureRead)) return undefined;
    const architecture = validateTaskArchitectureSnapshotV3(architectureRead);
    if (architecture.taskId !== scope.taskId) return undefined;

    const run = input.templates.getRun(scope.runId);
    if (!run || run.taskId !== scope.taskId) return undefined;

    let expectedExecutionProfileId: string | undefined;
    if (run.conductorLogicalSessionId === scope.logicalSessionId) {
      expectedExecutionProfileId = architecture.definition.conductor.executionProfileId;
    } else {
      const generation = input.taskRun.getGeneration(scope.logicalSessionId);
      if (!generation
        || generation.taskId !== scope.taskId
        || generation.runId !== scope.runId
        || generation.sessionId !== scope.logicalSessionId
        || generation.executionProfileId !== scope.executionProfileId) return undefined;
      const card = architecture.definition.agentCards.find((candidate) =>
        candidate.agentCardId === generation.agentCardId);
      if (!card) return undefined;
      expectedExecutionProfileId = card.executionProfileId;
    }
    if (expectedExecutionProfileId !== scope.executionProfileId) return undefined;

    const profile = architecture.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === expectedExecutionProfileId);
    if (!profile) return undefined;
    return Object.freeze({
      schemaVersion: 3,
      executionProfileId: profile.executionProfileId,
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
    });
  };
}
