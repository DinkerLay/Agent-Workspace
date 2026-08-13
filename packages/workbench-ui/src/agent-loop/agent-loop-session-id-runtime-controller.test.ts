import { describe, expect, it, vi } from "vitest";
import type { createId } from "@agent-workspace/runtime-contracts";
import {
  createAgentLoopSessionIdRuntimeController,
  type AgentLoopSessionIdCommandResult,
  type AgentLoopSessionIdRuntimePort,
  type AgentLoopSessionIdTaskReadModel,
  type AgentLoopSessionIdUiCommand,
} from "./agent-loop-session-id-runtime-controller";

const NOW = "2026-08-11T08:00:00.000Z";

describe("createAgentLoopSessionIdRuntimeController", () => {
  it("always targets the Run Conductor for Task input", async () => {
    const { client, commands } = fakePort();
    const controller = createController(client);

    await controller.submitTaskMessage("  请重新核对 A  ", "ui_intent_task");

    expect(commands).toEqual([expect.objectContaining({
      type: "task.submit_input",
      taskId: "task_one",
      runId: "run_one",
      targetLogicalSessionId: "session_conductor",
      content: "请重新核对 A",
      uiIntentId: "ui_intent_task",
    })]);
  });

  it("submits one human-direct intent and trusts Runtime's held receipt", async () => {
    const { client, commands } = fakePort((command) => command.type === "session.send_human_message"
      ? {
          humanIntervention: {
            humanInterventionId: command.humanInterventionId,
            state: "held",
            targetLogicalSessionId: command.targetLogicalSessionId!,
          },
        }
      : {});
    const controller = createController(client);

    await expect(controller.sendHumanMessage(
      { targetLogicalSessionId: "session_worker_g2" },
      "  新的人类指令  ",
      "ui_intent_human",
    )).resolves.toEqual({
      humanInterventionId: "human_intervention_2",
      state: "held",
      targetLogicalSessionId: "session_worker_g2",
    });
    expect(commands[0]).toMatchObject({
      type: "session.send_human_message",
      commandId: "command_1",
      idempotencyKey: "command_1",
      humanInterventionId: "human_intervention_2",
      targetLogicalSessionId: "session_worker_g2",
      content: "新的人类指令",
      uiIntentId: "ui_intent_human",
    });
  });

  it("targets a no-session Card without inventing a logical Session and accepts Runtime's materialized address", async () => {
    const { client, commands } = fakePort((command) => command.type === "session.send_human_message"
      ? {
          humanIntervention: {
            humanInterventionId: command.humanInterventionId,
            state: "sent",
            targetLogicalSessionId: "logical_session_materialized",
            materializedGeneration: 1,
          },
        }
      : {});
    const controller = createController(client);

    await expect(controller.sendHumanMessage(
      { targetAgentCardId: "agent_card_researcher" },
      "First direct message",
      "ui_intent_materialize",
    )).resolves.toEqual({
      humanInterventionId: "human_intervention_2",
      state: "sent",
      targetLogicalSessionId: "logical_session_materialized",
      materializedGeneration: 1,
    });
    expect(commands[0]).toMatchObject({
      type: "session.send_human_message",
      targetAgentCardId: "agent_card_researcher",
      uiIntentId: "ui_intent_materialize",
    });
    expect(commands[0]).not.toHaveProperty("targetLogicalSessionId");
  });

  it("keeps request_interrupt content-free and distinct from the Conductor tool action", async () => {
    const { client, commands } = fakePort((command) => command.type === "session.request_interrupt"
      ? { control: { sessionControlAuditId: "control_human", state: "accepted" } }
      : {});
    const controller = createController(client);

    await expect(controller.requestHumanInterrupt("session_worker_g2", "ui_intent_interrupt")).resolves.toEqual({
      sessionControlAuditId: "control_human",
      state: "accepted",
    });

    expect(commands[0]).toMatchObject({
      type: "session.request_interrupt",
      targetLogicalSessionId: "session_worker_g2",
      uiIntentId: "ui_intent_interrupt",
    });
    expect(commands[0]).not.toHaveProperty("content");
    expect(commands[0]?.type).not.toBe("orchestration.interrupt_session");
  });

  it("retries abandon with the same command/idempotency/ui intent and only for an unhanded delivery", async () => {
    const commands: AgentLoopSessionIdUiCommand[] = [];
    let attempt = 0;
    const task = taskModel();
    const modelWithPendingHuman: AgentLoopSessionIdTaskReadModel = {
      ...task,
      sessions: task.sessions.map((candidate) => candidate.logicalSessionId === "session_worker_g2"
        ? {
            ...candidate,
            humanDeliveries: [{
              humanInterventionId: "human_pending",
              mode: "direct_message",
              content: "May be abandoned",
              conductorMirrorMessageId: "message_mirror",
              conductorMirrorSequence: 1,
              cardMessageId: "message_card",
              cardSequence: 1,
              cardState: "pending" as const,
              createdAt: NOW,
            }],
          }
        : candidate),
    };
    const controller = createController(port(modelWithPendingHuman, async (command) => {
      commands.push(command);
      attempt += 1;
      if (attempt === 1) throw new Error("transport_ambiguous");
      if (command.type !== "session.abandon_human_message") return {};
      return {
        humanIntervention: {
          humanInterventionId: command.humanInterventionId,
          state: "abandoned",
          targetLogicalSessionId: "session_worker_g2",
        },
      };
    }));

    await expect(controller.abandonHumanMessage("human_pending", "ui_intent_abandon"))
      .rejects.toThrow("transport_ambiguous");
    await expect(controller.abandonHumanMessage("human_pending", "ui_intent_abandon"))
      .resolves.toEqual({
        humanInterventionId: "human_pending",
        state: "abandoned",
        targetLogicalSessionId: "session_worker_g2",
      });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      type: "session.abandon_human_message",
      commandId: "command_1",
      idempotencyKey: "command_1",
      uiIntentId: "ui_intent_abandon",
    });
  });

  it("submits one persisted interaction choice as its own revision-fenced human-priority command", async () => {
    const commands: AgentLoopSessionIdUiCommand[] = [];
    const task = taskModel();
    const modelWithInteraction: AgentLoopSessionIdTaskReadModel = {
      ...task,
      sessions: task.sessions.map((session) => session.logicalSessionId === "session_worker_g2"
        ? { ...session, interactions: [{
            interactionId: "interaction_permission",
            interactionRevision: 3,
            choices: [{ choiceId: "choice_allow_once", label: "Allow once" }],
          }] }
        : session),
    };
    const controller = createController(port(modelWithInteraction, async (command) => {
      commands.push(command);
      return {
        interactionResponse: {
          humanInterventionId: "human_intervention_response",
          state: "accepted",
          targetLogicalSessionId: "session_worker_g2",
          interactionId: "interaction_permission",
          choiceId: "choice_allow_once",
          label: "Allow once",
        },
      };
    }));

    await controller.respondInteraction(
      "session_worker_g2",
      "interaction_permission",
      "choice_allow_once",
      "ui_intent_attention",
    );

    expect(commands).toEqual([expect.objectContaining({
      type: "session.respond_interaction",
      taskId: "task_one",
      runId: "run_one",
      expectedRevision: 5,
      targetLogicalSessionId: "session_worker_g2",
      interactionId: "interaction_permission",
      expectedInteractionRevision: 3,
      choiceId: "choice_allow_once",
    })]);
  });

  it("replays the byte-identical command envelope after an ambiguous interrupt transport failure", async () => {
    const commands: AgentLoopSessionIdUiCommand[] = [];
    let attempt = 0;
    let reads = 0;
    let clock = 0;
    let id = 0;
    const client: AgentLoopSessionIdRuntimePort = {
      read: vi.fn(async () => {
        reads += 1;
        return { ...taskModel(), revision: reads === 1 ? 5 : 6 };
      }),
      command: async (command) => {
        commands.push(command);
        attempt += 1;
        if (attempt === 1) throw new Error("transport_ambiguous");
        return { control: { sessionControlAuditId: "control_replayed", state: "accepted" } };
      },
      subscribe: vi.fn(async () => () => undefined),
    };
    const controller = createAgentLoopSessionIdRuntimeController({
      client,
      taskId: "task_one",
      now: () => `2026-08-11T08:00:0${++clock}.000Z`,
      createRuntimeId: ((prefix: string) => `${prefix}_${++id}`) as typeof createId,
    });

    await expect(controller.requestHumanInterrupt("session_worker_g2", "ui_intent_retry")).rejects.toThrow("transport_ambiguous");
    await expect(controller.requestHumanInterrupt("session_worker_g2", "ui_intent_retry")).resolves.toMatchObject({ state: "accepted" });

    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(reads).toBe(1);
    expect(clock).toBe(1);
  });

  it("rejects historical Card mutation and revalidates every file Preview", async () => {
    const { client, commands } = fakePort((command) => command.type === "workspace.preview_file"
      ? {
          filePreview: {
            observation: { ...taskModel().files[0], observedAt: `preview-${commands.length}` },
            content: `version-${commands.length}`,
          },
        }
      : {});
    const controller = createController(client);

    await expect(controller.sendHumanMessage(
      { targetLogicalSessionId: "session_worker_g1" },
      "不能投历史",
      "ui_intent_historical",
    )).rejects.toThrow("agent_loop_session_id_current_card_required");
    await expect(controller.previewFile("file_report", "ui_intent_preview_1")).resolves.toMatchObject({ content: "version-1" });
    await expect(controller.previewFile("file_report", "ui_intent_preview_2")).resolves.toMatchObject({ content: "version-2" });
    expect(commands.map((command) => command.type)).toEqual(["workspace.preview_file", "workspace.preview_file"]);
  });
});

function createController(client: AgentLoopSessionIdRuntimePort) {
  let id = 0;
  return createAgentLoopSessionIdRuntimeController({
    client,
    taskId: "task_one",
    now: () => NOW,
    createRuntimeId: ((prefix: string) => `${prefix}_${++id}`) as typeof createId,
  });
}

function fakePort(
  result: (command: AgentLoopSessionIdUiCommand) => AgentLoopSessionIdCommandResult = () => ({}),
) {
  const commands: AgentLoopSessionIdUiCommand[] = [];
  return {
    commands,
    client: port(taskModel(), async (command) => {
      commands.push(command);
      return result(command);
    }),
  };
}

function port(
  model: AgentLoopSessionIdTaskReadModel,
  command: AgentLoopSessionIdRuntimePort["command"],
): AgentLoopSessionIdRuntimePort {
  return {
    read: vi.fn(async () => model),
    command,
    subscribe: vi.fn(async () => () => undefined),
  };
}

function taskModel(): AgentLoopSessionIdTaskReadModel {
  return {
    taskId: "task_one",
    title: "Research",
    goal: "Verify evidence",
    revision: 5,
    runId: "run_one",
    runStatus: "running",
    conductorLogicalSessionId: "session_conductor",
    timeline: [],
    directory: [
      { agentCardId: "worker", title: "Worker", state: "busy", currentLogicalSessionId: "session_worker_g2", currentGeneration: 2 },
      { agentCardId: "agent_card_researcher", title: "Researcher", state: "no_session" },
    ],
    sessions: [
      session("session_conductor", "conductor", "conductor", 1, "current"),
      session("session_worker_g1", "worker", "card", 1, "closed"),
      session("session_worker_g2", "worker", "card", 2, "current"),
    ],
    files: [{
      observationId: "file_report",
      workspaceRelativePath: "reports/final.md",
      observedAt: NOW,
      contentDigest: "sha256:abc",
      currentState: "available",
      source: "verified_tool",
    }],
  };
}

function session(
  logicalSessionId: string,
  agentCardId: string,
  kind: "conductor" | "card",
  generation: number,
  lifecycle: "current" | "closed",
) {
  return {
    logicalSessionId,
    agentCardId,
    title: kind === "conductor" ? "Conductor" : "Worker",
    kind,
    generation,
    lifecycle,
    state: lifecycle === "closed" ? "closed" as const : kind === "card" ? "busy" as const : "available" as const,
    hasReceivedFirstInstruction: true,
    profile: profile(kind),
    messages: [],
    executionGroups: [],
    interactions: [],
    controls: [],
    humanDeliveries: [],
  };
}

function profile(kind: "conductor" | "card") {
  const role = kind === "conductor" ? "conductor" as const : "general" as const;
  return {
    schemaVersion: 3 as const,
    executionProfileId: kind === "conductor" ? "profile_conductor" : "profile_worker",
    profileRevisionId: kind === "conductor" ? "profile_revision_conductor" : "profile_revision_worker",
    providerFamily: "opencode" as const,
    acpAgentKind: "native_acp" as const,
    model: "opencode-go/test-model",
    role,
    permissionMode: "deny" as const,
    allowedTools: [],
    requiredCapabilities: [],
    requiredExtensions: [],
    readiness: {
      profileRevisionId: kind === "conductor" ? "profile_revision_conductor" : "profile_revision_worker",
      providerFamily: "opencode" as const,
      acpAgentKind: "native_acp" as const,
      role,
      status: "available" as const,
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
      model: "opencode-go/test-model",
    },
    mutableDuringRun: false as const,
  };
}
