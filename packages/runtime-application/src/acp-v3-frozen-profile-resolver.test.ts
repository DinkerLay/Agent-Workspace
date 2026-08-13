import {
  hashDefinition,
  renderTaskGoalContentV1,
  type CardSessionGenerationRecord,
  type JsonValue,
  type TaskRunRecord,
  type TemplateVersionRecord,
} from "@agent-workspace/runtime-contracts";
import { createTaskArchitectureSnapshotV3 } from "@agent-workspace/runtime-domain";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ACP_STARTER_PACKAGES } from "./built-in-templates.js";
import { createAcpV3FrozenProfileTupleResolver } from "./acp-v3-frozen-profile-resolver.js";

const NOW = "2026-08-12T00:00:00.000Z";

describe("ACP v3 frozen Profile tuple resolver", () => {
  it("resolves exact Conductor/Card tuples and rejects logical-Session profile retargeting", () => {
    const source = BUILT_IN_ACP_STARTER_PACKAGES.find(
      ({ package: candidate }) => candidate.template.slug === "opencode-acp-starter",
    )!;
    const definition = source.package.definition;
    const version: TemplateVersionRecord = {
      templateVersionId: source.templateVersionId,
      templateId: source.package.template.templateId,
      version: source.package.template.version,
      definition,
      definitionHash: hashDefinition(definition as unknown as JsonValue),
      createdAt: NOW,
      publishedAt: NOW,
    };
    const taskTitle = "Frozen tuple proof";
    const taskGoal = "Keep every logical Session on its immutable Profile revision.";
    const taskGoalContent = renderTaskGoalContentV1({ title: taskTitle, goal: taskGoal, taskInputValues: [] });
    const architecture = createTaskArchitectureSnapshotV3({
      architectureSnapshotId: "architecture_frozen-profile-proof",
      taskId: "task_frozen-profile-proof",
      templateVersion: version,
      taskInputValues: [],
      taskTitle,
      taskGoal,
      taskGoalContent,
      taskGoalContentDigest: hashDefinition(taskGoalContent),
      taskGoalCompilerVersion: "task-goal/v1",
      workspace: {
        workspaceId: "workspace_frozen-profile-proof",
        grantDigest: `sha256:${"a".repeat(64)}`,
      },
      now: NOW,
    });
    const run: TaskRunRecord = {
      runId: "run_frozen-profile-proof",
      taskId: architecture.taskId,
      conductorLogicalSessionId: "logical_session_frozen-conductor",
      status: "running",
      runNumber: 1,
      startedAt: NOW,
      revision: 2,
    };
    const worker = definition.agentCards[0]!;
    const generation: CardSessionGenerationRecord = {
      sessionId: "logical_session_frozen-worker",
      cardSessionSlotId: "card_session_slot_frozen-worker",
      taskId: architecture.taskId,
      runId: run.runId,
      agentCardId: worker.agentCardId,
      executionProfileId: worker.executionProfileId,
      generation: 1,
      lifecycle: "current",
      createdAt: NOW,
    };
    const resolve = createAcpV3FrozenProfileTupleResolver({
      templates: {
        getArchitectureSnapshot: (taskId) => taskId === architecture.taskId ? architecture : undefined,
        getRun: (runId) => runId === run.runId ? run : undefined,
      },
      taskRun: {
        getGeneration: (logicalSessionId) => logicalSessionId === generation.sessionId ? generation : undefined,
      },
    });

    const conductorProfile = definition.executionProfiles.find((profile) =>
      profile.executionProfileId === definition.conductor.executionProfileId)!;
    expect(resolve({
      taskId: architecture.taskId,
      runId: run.runId,
      logicalSessionId: run.conductorLogicalSessionId,
      executionProfileId: conductorProfile.executionProfileId,
    })).toEqual({
      schemaVersion: 3,
      executionProfileId: conductorProfile.executionProfileId,
      profileRevisionId: conductorProfile.profileRevisionId,
      providerFamily: conductorProfile.providerFamily,
    });

    const workerProfile = definition.executionProfiles.find((profile) =>
      profile.executionProfileId === worker.executionProfileId)!;
    expect(resolve({
      taskId: architecture.taskId,
      runId: run.runId,
      logicalSessionId: generation.sessionId,
      executionProfileId: workerProfile.executionProfileId,
    })).toEqual({
      schemaVersion: 3,
      executionProfileId: workerProfile.executionProfileId,
      profileRevisionId: workerProfile.profileRevisionId,
      providerFamily: workerProfile.providerFamily,
    });

    expect(resolve({
      taskId: architecture.taskId,
      runId: run.runId,
      logicalSessionId: generation.sessionId,
      executionProfileId: conductorProfile.executionProfileId,
    })).toBeUndefined();
    expect(resolve({
      taskId: architecture.taskId,
      runId: "run_wrong",
      logicalSessionId: generation.sessionId,
      executionProfileId: workerProfile.executionProfileId,
    })).toBeUndefined();
  });
});
