import type { RuntimeCommand, RuntimeInvalidation, RuntimeReadModel } from "@agent-workspace/runtime-contracts";
import type { RuntimeClient } from "@agent-workspace/runtime-client";
import { describe, expect, it, vi } from "vitest";
import { createAgentLoopRuntimeController } from "./agent-loop-runtime-controller";

describe("AgentLoopRuntimeController", () => {
  it("forwards the typed Runtime invalidation without erasing its semantic reasons", async () => {
    const invalidation = runtimeInvalidation(7, ["provider_fact_reconciled", "message_changed"]);
    const controller = createAgentLoopRuntimeController({
      client: client({
        subscribe: async (_request, listener) => {
          listener(invalidation);
          return () => undefined;
        },
      }),
    });
    const onChanged = vi.fn();

    await controller.subscribe(onChanged);

    expect(onChanged).toHaveBeenCalledExactlyOnceWith(invalidation);
  });

  it("keeps one lifecycle command identity across an ambiguous retry", async () => {
    const calls: RuntimeCommand[] = [];
    let attempts = 0;
    const controller = createAgentLoopRuntimeController({
      client: client({
        command: async (command) => {
          calls.push(command);
          attempts += 1;
          if (attempts === 1) throw new Error("transport_ambiguous");
          return receipt(command);
        },
      }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    await expect(controller.startTask("task_1", 3)).rejects.toThrow("transport_ambiguous");
    await controller.startTask("task_1", 3);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ type: "task.start", taskId: "task_1", expectedRevision: 3 });
    expect(calls[1]).toMatchObject({ commandId: calls[0]?.commandId });
  });

  it("authorizes a candidate directory once and returns only an opaque Workspace identity", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({ command: async (command) => { calls.push(command); return receipt(command); } }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    const workspace = await controller.authorizeWorkspace(" /Users/example/research ", "研究项目");
    expect(workspace).toEqual({ workspaceId: "workspace_1", displayName: "研究项目", authorizedAt: "2026-08-06T00:00:00.000Z" });
    expect(calls[0]).toMatchObject({
      type: "workspace.authorize",
      workspaceId: "workspace_1",
      directory: "/Users/example/research",
      displayName: "研究项目",
    });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(workspace)).not.toContain("/Users/example/research");
    expect(workspace).not.toHaveProperty("directory");
    expect(workspace).not.toHaveProperty("cwd");
  });

  it("keeps the same Workspace identity across ambiguous authorization retries", async () => {
    const calls: RuntimeCommand[] = [];
    let attempts = 0;
    const controller = createAgentLoopRuntimeController({
      client: client({
        command: async (command) => {
          calls.push(command);
          attempts += 1;
          if (attempts === 1) throw new Error("transport_ambiguous");
          return receipt(command);
        },
      }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    await expect(controller.authorizeWorkspace("/Users/example/research")).rejects.toThrow("transport_ambiguous");
    const workspace = await controller.authorizeWorkspace("/Users/example/research");

    expect(calls[0]).toMatchObject({ workspaceId: "workspace_1", commandId: "command_2" });
    expect(calls[1]).toMatchObject({ workspaceId: "workspace_1", commandId: "command_2" });
    expect(workspace.workspaceId).toBe("workspace_1");
  });

  it("submits selected logical-session input as one typed Message command and leaves delivery ids to Runtime", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({ command: async (command) => { calls.push(command); return receipt(command); } }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });
    const intent = controller.createInputSubmissionIntent("task_1", 3, "logical_session_conductor", "  Continue with evidence.  ");

    await controller.submitTaskInput(intent);
    await controller.submitTaskInput(intent);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      type: "task.submit_input",
      taskId: "task_1",
      expectedRevision: 3,
      runId: "run_1",
      targetLogicalSessionId: "logical_session_conductor",
      content: "Continue with evidence.",
    });
    expect(calls[1]).toMatchObject({
      commandId: (calls[0] as RuntimeCommand).commandId,
    });
    expect(calls[0]).not.toHaveProperty("inputSubmissionId");
    expect(calls[0]).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(calls[0])).not.toContain("native-session-secret");
  });

  it("routes direct user input to a Card through a durable HumanIntervention command", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({ command: async (command) => {
        calls.push(command);
        if (command.type !== "session.send_human_message") return receipt(command);
        const model = readModel();
        return {
          ...receipt(command),
          readModel: {
            ...model,
            task: {
              ...model.task!,
              humanInterventions: [{
                humanInterventionId: command.humanInterventionId,
                taskId: command.taskId,
                runId: command.runId,
                commandId: command.commandId,
                idempotencyKey: command.idempotencyKey,
                expectedTaskRevision: command.expectedRevision,
                targetLogicalSessionId: command.targetLogicalSessionId,
                content: command.content,
                contentDigest: "digest_human",
                mode: "direct",
                state: "sent",
                createdAt: command.issuedAt,
                updatedAt: command.issuedAt,
              }],
            },
          },
        };
      } }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });
    const intent = controller.createInputSubmissionIntent("task_1", 3, "logical_session_worker", " Check the failing harness. ");

    await controller.submitTaskInput(intent);

    expect(calls).toEqual([expect.objectContaining({
      type: "session.send_human_message",
      commandId: intent.commandId,
      humanInterventionId: intent.humanInterventionId,
      idempotencyKey: intent.commandId,
      taskId: "task_1",
      expectedRevision: 3,
      runId: "run_1",
      targetLogicalSessionId: "logical_session_worker",
      content: "Check the failing harness.",
    })]);
  });

  it("makes user achievement directly without consulting agent output or artifacts", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({
        read: async () => { throw new Error("achievement must not read task evidence"); },
        command: async (command) => { calls.push(command); return receipt(command); },
      }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    await controller.achieveTask("task_1", 3);

    expect(calls).toEqual([expect.objectContaining({
      type: "task.achieve",
      taskId: "task_1",
      expectedRevision: 3,
      acceptedArtifactIds: [],
    })]);
  });

  it("resumes only the user-selected historical Run through the typed Runtime command", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({ command: async (command) => { calls.push(command); return receipt(command); } }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    await controller.resumeTask("task_1", 3, "run_1");

    expect(calls).toEqual([expect.objectContaining({
      type: "task.resume",
      taskId: "task_1",
      expectedRevision: 3,
      runId: "run_1",
    })]);
  });

  it("uses only opaque artifact identities for preview and permanent deletion", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({
        command: async (command) => {
          calls.push(command);
          if (command.type === "artifact.preview") {
            return { ...receipt(command), artifactPreview: { artifactId: "artifact_1", taskId: "task_1", displayName: "result.md", state: "available", content: "verified" } };
          }
          if (command.type === "task.preview_permanent_delete") {
            return { ...receipt(command), permanentDeletePreview: { taskId: "task_1", expectedRevision: 3, artifacts: [{ artifactId: "artifact_1", displayName: "result.md", state: "deletable" }] } };
          }
          if (command.type === "task.permanently_delete") {
            return { ...receipt(command), permanentDelete: { taskId: "task_1", deletedArtifactIds: ["artifact_1"], skippedArtifacts: [], deletedAt: "2026-08-06T00:00:00.000Z" } };
          }
          return receipt(command);
        },
      }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    await controller.previewArtifact("task_1", 3, "artifact_1");
    await controller.previewPermanentDelete("task_1", 3);
    await controller.permanentlyDeleteTask("task_1", 3, ["artifact_1"]);

    expect(calls.map((call) => call.type)).toEqual(["artifact.preview", "task.preview_permanent_delete", "task.permanently_delete"]);
    expect(JSON.stringify(calls)).not.toContain("workspaceRelativePath");
    expect(JSON.stringify(calls)).not.toContain("/Users/");
  });

  it("returns only current attention fences to Runtime when the user replies", async () => {
    const calls: RuntimeCommand[] = [];
    const controller = createAgentLoopRuntimeController({
      client: client({ command: async (command) => { calls.push(command); return receipt(command); } }),
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: deterministicIds(),
    });

    await controller.respondAttention({
      taskId: "task_1",
      expectedRevision: 3,
      attentionId: "attention_1",
      response: "Allow once",
    });

    expect(calls).toEqual([expect.objectContaining({
      type: "attention.respond",
      taskId: "task_1",
      expectedRevision: 3,
      attentionId: "attention_1",
      bindingId: "binding_1",
      bindingRevision: 7,
      nativeRequestId: "request_1",
      response: { text: "Allow once" },
    })]);
  });
});

function client(overrides: Partial<RuntimeClient> = {}): RuntimeClient {
  return {
    read: async () => readModel(),
    command: async (command) => receipt(command),
    subscribe: async () => () => undefined,
    ...overrides,
  };
}

function receipt(command: RuntimeCommand) {
  return { receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" } };
}

function runtimeInvalidation(
  sequence: number,
  reasons: RuntimeInvalidation["reasons"],
): RuntimeInvalidation {
  return {
    type: "runtime.invalidated",
    sequence,
    occurredAt: "2026-08-09T00:00:00.000Z",
    reasons,
    taskId: "task_1",
    runId: "run_1",
  };
}

function deterministicIds() {
  let sequence = 0;
  return (prefix: Parameters<NonNullable<Parameters<typeof createAgentLoopRuntimeController>[0]["createRuntimeId"]>>[0]) => `${prefix}_${++sequence}`;
}

function readModel(): RuntimeReadModel {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    configuration: { metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [], metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [] },
    workspaceLibrary: { authorizations: [] },
    templateLibrary: { templates: [], drafts: [] },
    taskLibrary: {
      tasks: [{
        taskId: "task_1",
        architectureSnapshotId: "architecture_1",
        title: "Review",
        goal: "Review the change",
        status: "running",
        activeRunId: "run_1",
        revision: 3,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
    },
    task: {
      task: {
        taskId: "task_1",
        architectureSnapshotId: "architecture_1",
        title: "Review",
        goal: "Review the change",
        status: "running",
        activeRunId: "run_1",
        revision: 3,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      activeRun: {
        runId: "run_1",
        taskId: "task_1",
        conductorLogicalSessionId: "logical_session_conductor",
        status: "running",
        runNumber: 1,
        revision: 1,
        startedAt: "2026-08-06T00:00:00.000Z",
      },
      logicalSessions: [{
        logicalSessionId: "logical_session_conductor",
        taskId: "task_1",
        runId: "run_1",
        kind: "conductor",
        agentCardId: "agent_card_conductor",
        executionProfileId: "profile_default",
        status: "active",
        ordinal: 1,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }, {
        logicalSessionId: "logical_session_worker",
        taskId: "task_1",
        runId: "run_1",
        kind: "card",
        agentCardId: "agent_card_worker",
        executionProfileId: "profile_default",
        status: "active",
        ordinal: 2,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
      bindings: [{
        bindingId: "binding_1",
        taskId: "task_1",
        runId: "run_1",
        logicalSessionId: "logical_session_conductor",
        executionProfileId: "profile_default",
        provider: "codex",
        nativeBindingRef: "native-session-secret",
        bindingRevision: 7,
        status: "active",
        recoverable: true,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
      inputs: [],
      invocations: [],
      sessionTurns: [],
      messages: [],
      relayBlocks: [],
      messageForwards: [],
      messageForwardBatches: [],
      humanInterventions: [],
      inboxItems: [],
      attentions: [{
        attentionId: "attention_1",
        taskId: "task_1",
        runId: "run_1",
        bindingId: "binding_1",
        bindingRevision: 7,
        nativeRequestId: "request_1",
        request: { title: "Permission" },
        status: "requested",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
      providerActivities: [],
      artifacts: [],
      presentations: [],
      timeline: [],
    },
  };
}
