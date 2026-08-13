import { describe, expect, it } from "vitest";
import {
  cloneTaskArchitectureSnapshotV3,
  hashDefinition,
  renderTaskGoalContentV1,
  validateTaskArchitectureSnapshotV3,
  type JsonValue,
  type TaskArchitectureSnapshotV3,
  type TemplateDefinitionV3,
} from "../src";
import { InMemoryTaskArchitectureV3Repository } from "../../test-kit/src";

describe("TaskArchitectureSnapshotV3", () => {
  it("round-trips only workspaceId and grantDigest through a fake repository", () => {
    const repository = new InMemoryTaskArchitectureV3Repository();
    const snapshot = architectureSnapshot();
    repository.insert(snapshot);

    expect(repository.get(snapshot.architectureSnapshotId)).toEqual(cloneTaskArchitectureSnapshotV3(snapshot));
    expect(JSON.stringify(repository.snapshot())).not.toMatch(/cwd|canonicalDirectory|credential|acpSessionId|nativeBindingRef|\/private\//u);
    expect(repository.get(snapshot.architectureSnapshotId)?.workspace).toEqual({
      workspaceId: "workspace_1",
      grantDigest: DIGEST,
    });
  });

  it("rejects paths, credentials and raw Provider identities", () => {
    const snapshot = architectureSnapshot();
    expect(() => validateTaskArchitectureSnapshotV3({
      ...snapshot,
      workspace: { ...snapshot.workspace, cwd: "/private/workspace" },
    })).toThrow(/workspace_reference_v3_shape_invalid|not portable|Host-private/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, credential: "secret" }))
      .toThrow(/task_architecture_v3_snapshot_shape_invalid|not portable/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, acpSessionId: "raw-session" }))
      .toThrow(/task_architecture_v3_snapshot_shape_invalid|not portable/);
  });

  it("preserves Task input, goal compiler and timestamp invariants", () => {
    const snapshot = architectureSnapshot();
    expect(validateTaskArchitectureSnapshotV3(snapshot).taskInputValues).toEqual([
      { fieldId: "goal", value: "Build the requested result." },
    ]);
    expect(() => validateTaskArchitectureSnapshotV3({
      ...snapshot,
      taskInputValues: [...snapshot.taskInputValues, snapshot.taskInputValues[0]],
    })).toThrow(/task_architecture_input_duplicate/);
    expect(() => validateTaskArchitectureSnapshotV3({
      ...snapshot,
      taskInputValues: [{ fieldId: "unknown", value: "no" }],
    })).toThrow(/task_architecture_input_unknown/);
    expect(() => validateTaskArchitectureSnapshotV3({
      ...snapshot,
      taskInputValues: [{ fieldId: "goal", value: "  not normalized  " }],
    })).toThrow(/task_architecture_input_not_normalized/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, taskInputValues: [] }))
      .toThrow(/task_architecture_required_input_missing/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, taskGoalContent: "missing newline" }))
      .toThrow(/task_architecture_goal_invalid/);
    const forgedGoalContent = "Task title: Forged\nTask goal:\nForged\nTask inputs:\n(none)\n";
    expect(() => validateTaskArchitectureSnapshotV3({
      ...snapshot,
      taskGoalContent: forgedGoalContent,
      taskGoalContentDigest: hashDefinition(forgedGoalContent),
    })).toThrow(/task_architecture_goal_compiled_content_mismatch/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, createdAt: "not-an-iso-timestamp" }))
      .toThrow(/task_architecture_created_at_invalid/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, taskTitle: "Unsafe\u0000title" }))
      .toThrow(/task_architecture_task_title_invalid/);
    expect(() => validateTaskArchitectureSnapshotV3({ ...snapshot, taskGoal: "Unsafe\u0000goal" }))
      .toThrow(/task_architecture_task_goal_invalid/);
  });
});

const DIGEST = `sha256:${"a".repeat(64)}`;

function architectureSnapshot(): TaskArchitectureSnapshotV3 {
  const definition = definitionV3();
  const taskTitle = "Build result";
  const taskGoal = "Build the requested result.";
  const taskInputValues = [{ fieldId: "goal", value: "Build the requested result." }] as const;
  const taskGoalContent = renderTaskGoalContentV1({ title: taskTitle, goal: taskGoal, taskInputValues }, definition.taskInputSchema);
  return {
    schemaVersion: 3,
    architectureSnapshotId: "architecture_1",
    taskId: "task_1",
    templateId: "template_1",
    templateVersionId: "template_version_1",
    templateDefinitionHash: hashDefinition(definition as unknown as JsonValue),
    definition,
    taskInputValues,
    taskTitle,
    taskGoal,
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: { workspaceId: "workspace_1", grantDigest: DIGEST },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function definitionV3(): TemplateDefinitionV3 {
  const capabilityPolicy = {
    requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"] as const,
    allowedTools: [] as const,
    permissionMode: "ask" as const,
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  };
  return {
    schemaVersion: 3,
    taskInputSchema: {
      fields: [
        { fieldId: "goal", label: "Goal", kind: "long_text", required: true },
        { fieldId: "context", label: "Context", kind: "long_text", required: false },
      ],
    },
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: "profile_conductor",
      systemPrompt: "Coordinate bounded work.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "implementer",
      title: "Worker",
      executionProfileId: "profile_worker",
      systemPrompt: "Implement bounded work.",
      capabilityRefs: [],
      dispatchProfile: { title: "Worker", description: "Use for bounded work." },
    }],
    executionProfiles: ["conductor", "worker"].map((name) => ({
      executionProfileId: `profile_${name}`,
      profileRevisionId: `profile_revision_${name}-1`,
      providerFamily: "opencode" as const,
      acpAgentKind: "native_acp" as const,
      protocolMajor: 1 as const,
      model: "current-model",
      configIntent: {},
      requiredExtensions: [],
      capabilityPolicy,
    })),
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{ artifactPath: "result.md", ownerAgentCardId: "agent_card_worker" }],
  };
}
