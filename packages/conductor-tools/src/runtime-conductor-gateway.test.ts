import type { RuntimeReadModel } from "@agent-workspace/runtime-contracts";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeConductorGateway, type RuntimeConductorClient } from "./runtime-conductor-gateway";

const scope = {
  taskId: "task_1",
  runId: "run_1",
  conductorLogicalSessionId: "logical_session_conductor",
  conductorSessionTurnId: "session_turn_conductor",
} as const;

const activityLeakNeedle = "ACTIVITY_CONTENT_MUST_NOT_ROUTE";
const activityIdLeakNeedle = "activity_renderer-only";

describe("RuntimeConductorGateway", () => {
  it("dispatches only typed, scoped invoke_agent commands with selected messages", async () => {
    const harness = createHarness();
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: nextIds("command_1", "invocation_1"),
    });

    const dispatch = await gateway.invoke_agent({
      agentCardId: "agent_card_worker",
      instruction: "Inspect the implementation.",
      messageSelections: [
        { kind: "full_message", sourceMessageId: "message_worker_final" },
        { kind: "relay_block", sourceMessageId: "message_worker_final", relayBlockId: "relay_block_game" },
      ],
      acceptanceCriteria: ["Return your full final Message."],
      requestedArtifacts: ["review.md"],
      priority: "high",
    });

    expect(dispatch).toEqual({ commandId: "command_1", invocationId: "invocation_1" });
    expect(harness.client.read).toHaveBeenCalledWith({ taskId: "task_1" });
    expect(harness.client.invokeAgent).toHaveBeenCalledWith(expect.objectContaining({
      type: "invocation.invoke_agent",
      commandId: "command_1",
      invocationId: "invocation_1",
      taskId: "task_1",
      runId: "run_1",
      sourceLogicalSessionId: "logical_session_conductor",
      decidedBySessionTurnId: "session_turn_conductor",
      idempotencyKey: "command_1",
      expectedRevision: 7,
      agentCardId: "agent_card_worker",
      instruction: "Inspect the implementation.",
      messageSelections: [
        { kind: "full_message", sourceMessageId: "message_worker_final" },
        { kind: "relay_block", sourceMessageId: "message_worker_final", relayBlockId: "relay_block_game" },
      ],
    }));
    const command = harness.client.invokeAgent.mock.calls[0]?.[0];
    expect(command).not.toHaveProperty("contextRefs");
    expect(JSON.stringify(command)).not.toContain("native-");
    expect(JSON.stringify(command)).not.toContain(activityIdLeakNeedle);
    expect(JSON.stringify(command)).not.toContain(activityLeakNeedle);
  });

  it("issues separate Runtime commands for invoke_agents", async () => {
    const harness = createHarness();
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      createRuntimeId: nextIds("command_1", "invocation_1", "command_2", "invocation_2"),
    });

    const dispatches = await gateway.invoke_agents([
      invokeInput("agent_card_worker"),
      invokeInput("agent_card_reviewer"),
    ]);

    expect(dispatches).toEqual([
      { commandId: "command_1", invocationId: "invocation_1" },
      { commandId: "command_2", invocationId: "invocation_2" },
    ]);
    expect(harness.client.invokeAgent).toHaveBeenCalledTimes(2);
    expect(harness.client.invokeAgent.mock.calls.map(([command]) => command.invocationId)).toEqual(["invocation_1", "invocation_2"]);
  });

  it("relays a complete Message or selected RelayBlocks through the scoped Runtime command", async () => {
    const harness = createHarness();
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: nextIds("command_relay"),
    });

    const dispatch = await gateway.relay_message({
      targetAgentCardId: "agent_card_reviewer",
      messageSelections: [
        { kind: "full_message", sourceMessageId: "message_worker_final" },
        { kind: "relay_block", sourceMessageId: "message_worker_final", relayBlockId: "relay_block_game" },
      ],
    });

    expect(dispatch).toEqual({ commandId: "command_relay" });
    expect(harness.client.relayMessage).toHaveBeenCalledWith({
      type: "session.relay_message",
      commandId: "command_relay",
      issuedAt: "2026-08-06T00:00:00.000Z",
      taskId: "task_1",
      expectedRevision: 7,
      runId: "run_1",
      sourceLogicalSessionId: "logical_session_conductor",
      decidedBySessionTurnId: "session_turn_conductor",
      idempotencyKey: "command_relay",
      targetAgentCardId: "agent_card_reviewer",
      messageSelections: [
        { kind: "full_message", sourceMessageId: "message_worker_final" },
        { kind: "relay_block", sourceMessageId: "message_worker_final", relayBlockId: "relay_block_game" },
      ],
    });
    expect(harness.client.invokeAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.client.relayMessage.mock.calls[0]?.[0])).not.toContain(activityIdLeakNeedle);
    expect(JSON.stringify(harness.client.relayMessage.mock.calls[0]?.[0])).not.toContain(activityLeakNeedle);
  });

  it("rejects an empty relay instead of inventing arbitrary content", async () => {
    const harness = createHarness();
    const gateway = createRuntimeConductorGateway({ client: harness.client, scope });

    await expect(gateway.relay_message({
      targetAgentCardId: "agent_card_reviewer",
      messageSelections: [],
    })).rejects.toThrow("relay_message_selection_required");
    expect(harness.client.relayMessage).not.toHaveBeenCalled();
  });

  it("publishes an explicit immutable fanout without exposing a shared relay surface", async () => {
    const harness = createHarness();
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      now: () => "2026-08-06T00:00:00.000Z",
      createRuntimeId: nextIds("command_publish"),
    });

    await expect(gateway.publish_message({
      targetAgentCardIds: ["agent_card_worker", "agent_card_reviewer"],
      messageSelections: [{
        kind: "relay_block",
        sourceMessageId: "message_worker_final",
        relayBlockId: "relay_block_game",
      }],
      fanoutKey: "publish:board:4",
    })).resolves.toEqual({ commandId: "command_publish" });

    expect(harness.client.publishMessage).toHaveBeenCalledWith({
      type: "session.publish_message",
      commandId: "command_publish",
      issuedAt: "2026-08-06T00:00:00.000Z",
      taskId: "task_1",
      expectedRevision: 7,
      runId: "run_1",
      sourceLogicalSessionId: "logical_session_conductor",
      decidedBySessionTurnId: "session_turn_conductor",
      idempotencyKey: "command_publish",
      fanoutKey: "publish:board:4",
      targetAgentCardIds: ["agent_card_worker", "agent_card_reviewer"],
      messageSelections: [{
        kind: "relay_block",
        sourceMessageId: "message_worker_final",
        relayBlockId: "relay_block_game",
      }],
    });
    expect("read_shared_relays" in gateway).toBe(false);
    expect("read_result" in gateway).toBe(false);
    expect("read_results" in gateway).toBe(false);
    expect(JSON.stringify(harness.client.publishMessage.mock.calls[0]?.[0])).not.toContain(activityIdLeakNeedle);
    expect(JSON.stringify(harness.client.publishMessage.mock.calls[0]?.[0])).not.toContain(activityLeakNeedle);
  });

  it("registers only a Runtime-verified requested Artifact claim and returns Runtime-owned identity", async () => {
    const harness = createHarness();
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      now: () => "2026-08-06T00:00:20.000Z",
      createRuntimeId: nextIds("command_register_artifact"),
    });

    const registration = await gateway.register_artifact({
      sourceInvocationId: "invocation_worker",
      workspaceRelativePath: "reports/deepsearch.html",
      // Untrusted JavaScript may still include undeclared keys. The gateway
      // reconstructs the command and never forwards claimed provenance.
      artifactId: "artifact_spoofed",
      sourceMessageId: "message_spoofed",
      digest: "digest_spoofed",
      contentType: "text/html",
      taskId: "task_other",
      runId: "run_other",
      sourceLogicalSessionId: "logical_session_other",
    } as never);

    expect(registration).toEqual({ artifactId: "artifact_runtime_derived", commandId: "command_register_artifact" });
    expect(harness.client.verifyRequestedArtifact).toHaveBeenCalledWith({
      type: "artifact.verify_requested",
      commandId: "command_register_artifact",
      issuedAt: "2026-08-06T00:00:20.000Z",
      taskId: "task_1",
      expectedRevision: 7,
      runId: "run_1",
      sourceLogicalSessionId: "logical_session_conductor",
      decidedBySessionTurnId: "session_turn_conductor",
      idempotencyKey: "command_register_artifact",
      sourceInvocationId: "invocation_worker",
      workspaceRelativePath: "reports/deepsearch.html",
    });
    const command = harness.client.verifyRequestedArtifact.mock.calls[0]?.[0];
    expect(command).not.toHaveProperty("artifactId");
    expect(command).not.toHaveProperty("sourceMessageId");
    expect(command).not.toHaveProperty("digest");
    expect(command).not.toHaveProperty("contentType");
    expect("command" in gateway).toBe(false);
  });

  it("does not fabricate an Artifact when Runtime rejects a path outside requested final provenance", async () => {
    const harness = createHarness();
    harness.client.verifyRequestedArtifact.mockRejectedValueOnce(new Error("artifact_claim_not_requested"));
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      createRuntimeId: nextIds("command_register_denied"),
    });

    await expect(gateway.register_artifact({
      sourceInvocationId: "invocation_worker",
      workspaceRelativePath: "unrequested.html",
    })).rejects.toThrow("artifact_claim_not_requested");
    expect(harness.client.verifyRequestedArtifact).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Runtime does not return its derived Artifact identity", async () => {
    const harness = createHarness();
    harness.client.verifyRequestedArtifact.mockResolvedValueOnce({
      receipt: { commandId: "command_register_missing", acceptedAt: "2026-08-06T00:00:20.000Z" },
    });
    const gateway = createRuntimeConductorGateway({
      client: harness.client,
      scope,
      createRuntimeId: nextIds("command_register_missing"),
    });

    await expect(gateway.register_artifact({
      sourceInvocationId: "invocation_worker",
      workspaceRelativePath: "reports/deepsearch.html",
    })).rejects.toThrow("artifact_registration_identity_missing");
  });

  it("rejects a stale gateway scope before it can dispatch", async () => {
    const harness = createHarness(readModel({ activeRunId: "run_2" }));
    const gateway = createRuntimeConductorGateway({ client: harness.client, scope });

    await expect(gateway.invoke_agent(invokeInput("agent_card_worker"))).rejects.toThrow("conductor_scope_run_unavailable");
    expect(harness.client.invokeAgent).not.toHaveBeenCalled();
  });
});

function createHarness(model = readModel()) {
  const client = {
    read: vi.fn(async () => model),
    invokeAgent: vi.fn(async (command) => ({
      receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" },
    })),
    relayMessage: vi.fn(async (command) => ({
      receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" },
    })),
    publishMessage: vi.fn(async (command) => ({
      receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" },
    })),
    verifyRequestedArtifact: vi.fn(async (command) => ({
      receipt: { commandId: command.commandId, acceptedAt: "2026-08-06T00:00:00.000Z" },
      artifactId: "artifact_runtime_derived",
    })),
  } as unknown as RuntimeConductorClient & {
    read: ReturnType<typeof vi.fn>;
    invokeAgent: ReturnType<typeof vi.fn>;
    relayMessage: ReturnType<typeof vi.fn>;
    publishMessage: ReturnType<typeof vi.fn>;
    verifyRequestedArtifact: ReturnType<typeof vi.fn>;
  };
  return { client, model };
}

function readModel({ activeRunId = "run_1" }: { activeRunId?: string } = {}): RuntimeReadModel {
  const active = activeRunId === "run_1";
  const game = relayBlock({ relayBlockId: "relay_block_game", topic: "game.board", content: "{\"turn\":4}" });
  const notes = relayBlock({ relayBlockId: "relay_block_notes", topic: "notes", content: "Notes." });
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    configuration: { metaProfileOptions: [], executionProfileReadiness: [], taskSetupDrafts: [], metaSessions: [], metaMessages: [], metaPatchProposals: [], metaTurns: [] },
    workspaceLibrary: { authorizations: [] },
    templateLibrary: { templates: [], drafts: [] },
    taskLibrary: { tasks: [] },
    task: {
      task: {
        taskId: "task_1",
        architectureSnapshotId: "architecture_1",
        title: "Task",
        goal: "Goal",
        status: "running",
        activeRunId,
        revision: 7,
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      activeRun: {
        runId: activeRunId,
        taskId: "task_1",
        conductorLogicalSessionId: active ? "logical_session_conductor" : "logical_session_other",
        status: "running",
        runNumber: active ? 1 : 2,
        revision: 1,
        startedAt: "2026-08-06T00:00:00.000Z",
      },
      logicalSessions: [],
      bindings: [],
      inputs: [],
      invocations: [],
      sessionTurns: [{
        sessionTurnId: "session_turn_conductor",
        taskId: "task_1",
        runId: "run_1",
        inputSubmissionId: "input_conductor",
        targetLogicalSessionId: "logical_session_conductor",
        kind: "conductor",
        initiator: "runtime",
        trigger: "task_goal",
        status: "running",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      }],
      messages: [{
        messageId: "message_worker_final",
        taskId: "task_1",
        runId: "run_1",
        sourceLogicalSessionId: "logical_session_worker",
        sourceSessionTurnId: "session_turn_worker",
        kind: "agent_final",
        content: "Full worker final Message.",
        contentDigest: "digest_message",
        createdAt: "2026-08-06T00:00:10.000Z",
      }],
      relayBlocks: [game, notes],
      messageForwards: [],
      messageForwardBatches: [],
      humanInterventions: [],
      inboxItems: [],
      attentions: [],
      providerActivities: [{
        activityId: activityIdLeakNeedle,
        provider: "codex",
        bindingId: "binding_renderer_only",
        logicalSessionId: "logical_session_worker",
        inputSubmissionId: "input_renderer_only",
        invocationId: "invocation_renderer_only",
        sessionTurnId: "session_turn_renderer_only",
        category: "tool",
        status: "completed",
        title: "Shell command",
        content: activityLeakNeedle,
        startedAt: "2026-08-06T00:00:05.000Z",
        updatedAt: "2026-08-06T00:00:06.000Z",
      }],
      artifacts: [],
      presentations: [],
      timeline: [],
    },
  };
}

function relayBlock({
  relayBlockId,
  topic,
  content,
}: {
  relayBlockId: string;
  topic: string;
  content: string;
}) {
  return {
    relayBlockId,
    sourceMessageId: "message_worker_final",
    ordinal: 0,
    suggestedTargetAgentCardIds: [],
    topic,
    format: "text/markdown",
    content,
    contentDigest: `digest_${relayBlockId}`,
    parserVersion: 1,
    sourceRange: { start: 0, end: content.length },
    createdAt: "2026-08-06T00:00:10.000Z",
  } as const;
}

function invokeInput(agentCardId: string) {
  return {
    agentCardId,
    instruction: `Complete ${agentCardId}.`,
    messageSelections: [],
    acceptanceCriteria: ["Return a complete final Message."],
  } as const;
}

function nextIds(...ids: string[]) {
  let index = 0;
  return () => {
    const value = ids[index];
    index += 1;
    if (!value) throw new Error("test_id_exhausted");
    return value;
  };
}
