import { describe, expect, it, vi } from "vitest";
import {
  hashDefinition,
  renderTaskGoalContentV1,
  type JsonValue,
  type TaskArchitectureSnapshotV3,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceAuthorizationRecord,
  type WorkspaceEffectIntentRecord,
  type WorkspaceFileObservationRecord,
} from "@agent-workspace/runtime-contracts";
import type { SessionIdUiCommandReceiptRecord } from "@agent-workspace/runtime-store";
import {
  createSessionIdAcpWorkspacePreviewOwner,
  type SessionIdAcpWorkspacePreviewCapabilities,
  type SessionIdAcpWorkspacePreviewCommand,
  type SessionIdAcpWorkspacePreviewFileState,
  type SessionIdAcpWorkspacePreviewRevalidateInput,
} from "./session-id-acp-workspace-preview-owner.js";

const NOW = "2026-08-12T21:00:00.000Z";
const TASK_ID = "task_workspace_preview";
const RUN_ID = "run_workspace_preview";
const OBSERVATION_ID = "workspace_file_observation_source";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const CHANGED_DIGEST = `sha256:${"b".repeat(64)}`;

describe("Session-ID ACP Workspace Preview owner", () => {
  it("replays the exact safe result without reopening the file or duplicating an unchanged observation", async () => {
    const fixture = createFixture();
    const state: SessionIdAcpWorkspacePreviewFileState = {
      state: "available",
      contentDigest: SOURCE_DIGEST,
      byteLength: 5,
      content: "first",
    };
    fixture.revalidate.mockResolvedValue(state);

    const first = await fixture.owner.command(command());
    expect(first).toEqual({
      filePreview: {
        observation: {
          observationId: OBSERVATION_ID,
          workspaceRelativePath: "reports/result.md",
          observedAt: NOW,
          contentDigest: SOURCE_DIGEST,
          currentState: "available",
          source: "verified_tool",
        },
        content: "first",
      },
    });
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.receipts).toHaveLength(1);

    fixture.revalidate.mockResolvedValue({
      state: "available",
      contentDigest: CHANGED_DIGEST,
      byteLength: 6,
      content: "second",
    });
    await expect(fixture.owner.command(command())).resolves.toEqual(first);
    expect(fixture.revalidate).toHaveBeenCalledTimes(1);
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.receipts).toHaveLength(1);
  });

  it("persists a new Workspace-owned observation only when current state changed", async () => {
    const fixture = createFixture();
    fixture.revalidate.mockResolvedValue({
      state: "available",
      contentDigest: CHANGED_DIGEST,
      byteLength: 6,
      content: "second",
    });

    const result = await fixture.owner.command(command({ commandId: "command_preview_changed" }));

    expect(result).toEqual({
      filePreview: {
        observation: {
          observationId: "workspace_file_observation_1",
          workspaceRelativePath: "reports/result.md",
          observedAt: "2026-08-12T21:00:01.000Z",
          contentDigest: CHANGED_DIGEST,
          currentState: "changed",
          source: "verified_tool",
        },
        content: "second",
      },
    });
    expect(fixture.observations).toHaveLength(2);
    expect(fixture.createdObservationLinks).toEqual([{
      observationId: "workspace_file_observation_1",
      workspaceEffectIntentId: "workspace_effect_source",
    }]);
    expect(JSON.stringify(result)).not.toContain("/private/workspace");
    expect(JSON.stringify(result)).not.toContain("provider_call_private");

    await expect(fixture.owner.command(command({
      commandId: "command_preview_changed_again",
      observationId: "workspace_file_observation_1",
    }))).resolves.toEqual({
      filePreview: {
        observation: expect.objectContaining({
          observationId: "workspace_file_observation_1",
          contentDigest: CHANGED_DIGEST,
          currentState: "changed",
        }),
        content: "second",
      },
    });
    expect(fixture.observations).toHaveLength(2);
  });

  it("records missing state once and does not invent a preview effect", async () => {
    const fixture = createFixture({ source: unverifiedSource() });
    fixture.revalidate.mockResolvedValue({ state: "missing" });

    await expect(fixture.owner.command(command({ commandId: "command_preview_missing" }))).resolves.toEqual({
      filePreview: {
        observation: {
          observationId: "workspace_file_observation_1",
          workspaceRelativePath: "reports/result.md",
          observedAt: "2026-08-12T21:00:01.000Z",
          currentState: "missing",
          source: "unverified",
        },
      },
    });
    expect(fixture.createdObservationLinks).toEqual([{
      observationId: "workspace_file_observation_1",
      workspaceEffectIntentId: undefined,
    }]);
  });

  it("fails before filesystem access for stale scope, stale observation, and broken verified provenance", async () => {
    const staleRevision = createFixture();
    await expect(staleRevision.owner.command(command({ expectedRevision: 6 })))
      .rejects.toThrow("acp_workspace_preview_task_revision_stale");
    expect(staleRevision.revalidate).not.toHaveBeenCalled();

    const staleObservation = createFixture({
      additionalObservations: [{
        ...sourceObservation(),
        workspaceFileObservationId: "workspace_file_observation_newer",
        observedAt: "2026-08-12T21:00:00.500Z",
      }],
    });
    await expect(staleObservation.owner.command(command()))
      .rejects.toThrow("acp_workspace_preview_observation_not_current");
    expect(staleObservation.revalidate).not.toHaveBeenCalled();

    const noEffect = createFixture({ sourceEffect: undefined });
    await expect(noEffect.owner.command(command()))
      .rejects.toThrow("acp_workspace_preview_verified_effect_missing");
    expect(noEffect.revalidate).not.toHaveBeenCalled();
  });

  it("rechecks Task, architecture, authorization and source inside the commit transaction", async () => {
    const fixture = createFixture();
    fixture.revalidate.mockImplementation(async () => {
      fixture.task = { ...fixture.task, revision: 8, updatedAt: "2026-08-12T21:00:00.500Z" };
      return {
        state: "available",
        contentDigest: CHANGED_DIGEST,
        byteLength: 6,
        content: "second",
      };
    });

    await expect(fixture.owner.command(command({ commandId: "command_preview_race" })))
      .rejects.toThrow("acp_workspace_preview_task_revision_stale");
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.receipts).toHaveLength(0);
  });

  it("rejects non-exact commands and conflicting command replay", async () => {
    const fixture = createFixture();
    await expect(fixture.owner.command({ ...command(), label: "leak" } as SessionIdAcpWorkspacePreviewCommand))
      .rejects.toThrow("acp_workspace_preview_command_shape_invalid");

    fixture.receipts.push({
      commandId: "command_preview",
      taskId: TASK_ID,
      runId: RUN_ID,
      commandKind: "workspace.preview_file",
      idempotencyKey: "command_preview",
      payloadFingerprint: "fnv1a64:conflict",
      result: {} as JsonValue,
      createdAt: NOW,
    });
    await expect(fixture.owner.command(command())).rejects.toThrow("acp_workspace_preview_command_replay_conflict");
    expect(fixture.revalidate).not.toHaveBeenCalled();
  });
});

function createFixture(options: Readonly<{
  source?: WorkspaceFileObservationRecord;
  sourceEffect?: WorkspaceEffectIntentRecord | undefined;
  additionalObservations?: readonly WorkspaceFileObservationRecord[];
}> = {}) {
  const observations = [options.source ?? sourceObservation(), ...(options.additionalObservations ?? [])];
  const receipts: SessionIdUiCommandReceiptRecord[] = [];
  const createdObservationLinks: Array<Readonly<{
    observationId: string;
    workspaceEffectIntentId?: string;
  }>> = [];
  const sourceEffect = Object.prototype.hasOwnProperty.call(options, "sourceEffect")
    ? options.sourceEffect
    : effectRecord();
  const authorization: WorkspaceAuthorizationRecord = {
    workspaceId: "workspace_preview",
    canonicalDirectory: "/private/workspace",
    displayName: "Workspace",
    authorizedAt: "2026-08-12T20:00:00.000Z",
  };
  const fixture = {
    task: taskRecord(),
    run: runRecord(),
    architecture: architectureRecord(),
    authorization,
    observations,
    receipts,
    createdObservationLinks,
    revalidate: vi.fn<(
      input: SessionIdAcpWorkspacePreviewRevalidateInput,
    ) => Promise<SessionIdAcpWorkspacePreviewFileState>>(),
  };
  let sequence = 0;

  const capabilities = (): SessionIdAcpWorkspacePreviewCapabilities => ({
    templateTask: {
      getTask: (taskId) => taskId === TASK_ID ? fixture.task : undefined,
      getRun: (runId) => runId === RUN_ID ? fixture.run : undefined,
      getArchitectureSnapshot: (taskId) => taskId === TASK_ID ? fixture.architecture : undefined,
    },
    authorizations: {
      getAuthorization: (workspaceId) => workspaceId === authorization.workspaceId ? fixture.authorization : undefined,
    },
    workspace: {
      getObservation: (observationId) => observations.find((entry) => entry.workspaceFileObservationId === observationId),
      listObservations: (taskId) => observations.filter((entry) => entry.taskId === taskId),
      findEffectIntentByObservationId: (taskId, observationId) => taskId === TASK_ID
        && (observationId === OBSERVATION_ID || createdObservationLinks.some((entry) =>
          entry.observationId === observationId && entry.workspaceEffectIntentId === sourceEffect?.workspaceEffectIntentId))
        ? sourceEffect
        : undefined,
      createObservation: (observation, workspaceEffectIntentId) => {
        observations.push(observation);
        createdObservationLinks.push({
          observationId: observation.workspaceFileObservationId,
          workspaceEffectIntentId,
        });
      },
    },
    commandReceipts: {
      getUiCommandReceipt: (taskId, commandId) => receipts.find((receipt) =>
        receipt.taskId === taskId && receipt.commandId === commandId),
      createUiCommandReceipt: (receipt) => receipts.push(receipt),
    },
  });
  const owner = createSessionIdAcpWorkspacePreviewOwner({
    now: () => `2026-08-12T21:00:0${++sequence}.000Z`,
    createId: () => `workspace_file_observation_${sequence}`,
    transaction: {
      read: (work) => work(capabilities()),
      run: (work) => work(capabilities()),
    },
    revalidator: {
      revalidate: (input) => fixture.revalidate(input),
    },
  });
  return Object.assign(fixture, { owner });
}

function command(overrides: Partial<SessionIdAcpWorkspacePreviewCommand> = {}): SessionIdAcpWorkspacePreviewCommand {
  return {
    type: "workspace.preview_file",
    commandId: "command_preview",
    taskId: TASK_ID,
    runId: RUN_ID,
    expectedRevision: 7,
    observationId: OBSERVATION_ID,
    issuedAt: "2026-08-12T21:00:00.000Z",
    ...overrides,
  };
}

function taskRecord(): TaskRecord {
  return {
    taskId: TASK_ID,
    architectureSnapshotId: "architecture_workspace-preview",
    title: "Workspace preview",
    goal: "Preview safely",
    status: "running",
    activeRunId: RUN_ID,
    revision: 7,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runRecord(): TaskRunRecord {
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    conductorLogicalSessionId: "logical_session_workspace-preview",
    status: "running",
    runNumber: 1,
    startedAt: NOW,
    revision: 2,
  };
}

function architectureRecord(): TaskArchitectureSnapshotV3 {
  const profile = {
    executionProfileId: "profile_workspace-preview",
    profileRevisionId: "profile_revision_workspace-preview",
    providerFamily: "opencode" as const,
    acpAgentKind: "native_acp" as const,
    protocolMajor: 1 as const,
    model: "openai/gpt-5",
    configIntent: {},
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt",
      ] as const,
      allowedTools: [],
      permissionMode: "ask" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
  const workerProfile = {
    ...profile,
    executionProfileId: "profile_workspace-worker",
    profileRevisionId: "profile_revision_workspace-worker",
  };
  const definition = {
    schemaVersion: 3 as const,
    conductor: {
      agentCardId: "agent_card_workspace-preview",
      kind: "conductor" as const,
      title: "Conductor",
      executionProfileId: profile.executionProfileId,
      systemPrompt: "Coordinate.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_workspace-worker",
      kind: "researcher" as const,
      title: "Researcher",
      executionProfileId: workerProfile.executionProfileId,
      systemPrompt: "Research safely.",
      capabilityRefs: [],
      dispatchProfile: { title: "Research", description: "Use for research." },
    }],
    executionProfiles: [profile, workerProfile],
    routingPolicy: { mode: "agent_loop" as const, maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [],
  };
  const taskGoalContent = renderTaskGoalContentV1({ title: "Workspace preview", goal: "Preview safely", taskInputValues: [] });
  return {
    schemaVersion: 3,
    architectureSnapshotId: "architecture_workspace-preview",
    taskId: TASK_ID,
    templateId: "template_workspace-preview",
    templateVersionId: "template_version_workspace-preview",
    templateDefinitionHash: hashDefinition(definition as unknown as JsonValue),
    definition,
    taskInputValues: [],
    taskTitle: "Workspace preview",
    taskGoal: "Preview safely",
    taskGoalContent,
    taskGoalContentDigest: hashDefinition(taskGoalContent),
    taskGoalCompilerVersion: "task-goal/v1",
    workspace: { workspaceId: "workspace_preview", grantDigest: `sha256:${"c".repeat(64)}` },
    createdAt: NOW,
  };
}

function sourceObservation(): WorkspaceFileObservationRecord {
  return {
    workspaceFileObservationId: OBSERVATION_ID,
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceRelativePath: "reports/result.md",
    contentDigest: SOURCE_DIGEST,
    byteLength: 5,
    state: "available",
    source: "verified_tool",
    observedAt: NOW,
  };
}

function unverifiedSource(): WorkspaceFileObservationRecord {
  return { ...sourceObservation(), source: "unverified" };
}

function effectRecord(): WorkspaceEffectIntentRecord {
  return {
    workspaceEffectIntentId: "workspace_effect_source",
    taskId: TASK_ID,
    runId: RUN_ID,
    publisherSessionId: "logical_session_publisher",
    publisherSessionTurnId: "session_turn_publisher",
    providerCallId: "provider_call_private",
    idempotencyKey: "workspace-effect-source",
    workspaceRelativePath: "reports/result.md",
    contentDigest: SOURCE_DIGEST,
    byteLength: 5,
    state: "applied",
    observationId: OBSERVATION_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
