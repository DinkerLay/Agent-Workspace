import { describe, expect, it, vi } from "vitest";
import type { createId } from "@agent-workspace/runtime-contracts";
import {
  createAgentLoopSessionIdRootController,
  type AgentLoopSessionIdRootRuntimePort,
} from "./agent-loop-session-id-root-controller";
import type {
  AgentLoopSessionIdCommandTrace,
  AgentLoopSessionIdTaskReadModel,
  AgentLoopSessionIdUiCommand,
} from "./agent-loop-session-id-runtime-controller";

const NOW = "2026-08-11T09:00:00.000Z";

describe("createAgentLoopSessionIdRootController", () => {
  it("keeps Create outside lifecycle, then sends explicit Start with a visible-intent trace", async () => {
    const { client, commands } = port();
    const traces: unknown[] = [];
    const controller = root(client, (trace) => traces.push(trace));

    expect(Object.keys(controller).sort()).toEqual([
      "achieveTask",
      "archiveTask",
      "configuration",
      "loadWorkspace",
      "permanentlyDeleteTask",
      "previewPermanentDelete",
      "restartTask",
      "restoreTask",
      "resumeTask",
      "startTask",
      "subscribe",
      "task",
    ]);
    await controller.startTask("task_queued", 3, "ui_intent_start");

    expect(commands).toEqual([expect.objectContaining({
      type: "task.start",
      taskId: "task_queued",
      expectedRevision: 3,
    })]);
    expect(traces).toEqual([expect.objectContaining({
      uiIntentId: "ui_intent_start",
      commandId: commands[0]?.commandId,
      intentKind: "task.start",
    })]);
    expect(commands.map((command) => command.type)).not.toContain("task.create");
  });

  it("keeps Resume and Restart distinct from Start and preserves the original Run identity on Resume", async () => {
    const { client, commands } = port();
    const controller = root(client);

    await controller.resumeTask("task_blocked", "run_original", 7, "ui_intent_resume");
    await controller.restartTask("task_terminal", 11, "ui_intent_restart");

    expect(commands).toEqual([
      expect.objectContaining({ type: "task.resume", taskId: "task_blocked", runId: "run_original", expectedRevision: 7 }),
      expect.objectContaining({ type: "task.restart", taskId: "task_terminal", expectedRevision: 11 }),
    ]);
    expect(commands.map((command) => command.type)).not.toContain("task.start");
  });

  it("passes only a trusted observation id as the optional Achieve anchor", async () => {
    const { client, commands } = port();
    const controller = root(client);

    await controller.achieveTask({
      taskId: "task_running",
      expectedRevision: 8,
      uiIntentId: "ui_intent_achieve",
      acceptanceNote: "  accepted by the user  ",
      fileObservation: {
        observationId: "observation_report",
        workspaceRelativePath: "reports/final.md",
        observedAt: NOW,
        contentDigest: "sha256:renderer-cannot-authorize-this",
        currentState: "available",
        source: "verified_tool",
      },
    });

    expect(commands[0]).toEqual(expect.objectContaining({
      type: "task.achieve",
      fileStateAnchor: {
        observationId: "observation_report",
        label: "reports/final.md",
      },
      acceptanceNote: "accepted by the user",
    }));
    expect(commands[0]).not.toHaveProperty("acceptedArtifactIds");
    expect(JSON.stringify(commands[0])).not.toContain("sha256:renderer-cannot-authorize-this");
  });

  it("keeps one unanchored Achieve command and uiIntent across an ambiguous retry", async () => {
    const { client, commands } = port();
    vi.mocked(client.command).mockImplementationOnce(async (command) => {
      commands.push(command);
      throw new Error("transport_result_unknown");
    });
    const traces: AgentLoopSessionIdCommandTrace[] = [];
    const controller = root(client, (trace) => traces.push(trace));
    const input = {
      taskId: "task_queued",
      expectedRevision: 3,
      uiIntentId: "ui_intent_unanchored_achieve",
    } as const;

    await expect(controller.achieveTask(input)).rejects.toThrow("transport_result_unknown");
    await controller.achieveTask(input);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe(commands[1]);
    expect(commands[0]).toEqual(expect.objectContaining({
      type: "task.achieve",
      uiIntentId: "ui_intent_unanchored_achieve",
    }));
    expect(commands[0]).not.toHaveProperty("fileStateAnchor");
    expect(traces).toHaveLength(2);
    expect(traces[0]).toEqual(expect.objectContaining({
      commandId: (commands[0] as { commandId: string }).commandId,
      uiIntentId: "ui_intent_unanchored_achieve",
    }));
    expect(traces[1]).toEqual(traces[0]);
  });

  it("keeps archive, restore, preview and permanent delete as four explicit user commands", async () => {
    const { client, commands } = port();
    const traces: AgentLoopSessionIdCommandTrace[] = [];
    const controller = root(client, (trace) => traces.push(trace));

    await controller.archiveTask("task_achieved", 9, "ui_intent_archive");
    await controller.restoreTask("task_achieved", 10, "ui_intent_restore");
    const preview = await controller.previewPermanentDelete("task_achieved", 10, "ui_intent_preview_delete");
    const deleted = await controller.permanentlyDeleteTask("task_achieved", 10, "ui_intent_delete");

    expect(commands).toEqual([
      expect.objectContaining({ type: "task.archive", taskId: "task_achieved", expectedRevision: 9 }),
      expect.objectContaining({ type: "task.restore", taskId: "task_achieved", expectedRevision: 10 }),
      expect.objectContaining({ type: "task.preview_permanent_delete", taskId: "task_achieved", expectedRevision: 10 }),
      expect.objectContaining({ type: "task.permanently_delete", taskId: "task_achieved", expectedRevision: 10 }),
    ]);
    expect(traces.map((trace) => trace.intentKind)).toEqual([
      "task.archive",
      "task.restore",
      "task.preview_permanent_delete",
      "task.permanently_delete",
    ]);
    expect(preview.permanentDeletePreview).toEqual(expect.objectContaining({
      taskId: "task_achieved",
      workspaceFilesWillRemain: true,
    }));
    expect(deleted.permanentDelete).toEqual(expect.objectContaining({
      taskId: "task_achieved",
      workspaceFilesWillRemain: true,
    }));
  });

  it("delegates active-Run actions to one cached Session-ID Task controller", async () => {
    const { client, commands } = port();
    const controller = root(client);
    const first = controller.task("task_running");
    const second = controller.task("task_running");

    expect(first).toBe(second);
    await first.submitTaskMessage("Replan", "ui_intent_replan");
    await first.stopTask("ui_intent_stop");
    expect(commands.map((command) => command.type)).toEqual(["task.submit_input", "task.stop"]);
  });
});

function root(
  client: AgentLoopSessionIdRootRuntimePort,
  onCommandTrace: (trace: AgentLoopSessionIdCommandTrace) => void = vi.fn(),
) {
  let id = 0;
  return createAgentLoopSessionIdRootController({
    client,
    ownerId: "local-user",
    now: () => NOW,
    createRuntimeId: ((prefix: string) => `${prefix}_${++id}`) as typeof createId,
    onCommandTrace,
  });
}

function port() {
  const commands: Array<AgentLoopSessionIdUiCommand | { type: string; commandId: string }> = [];
  const client: AgentLoopSessionIdRootRuntimePort = {
    readWorkspace: vi.fn(async () => ({
      generatedAt: NOW,
      tasks: [{
        taskId: "task_queued",
        title: "Queued",
        goal: "Start explicitly",
        revision: 3,
        status: "queued",
        availableLifecycleActions: ["start"] as const,
        createdAt: NOW,
        updatedAt: NOW,
      }],
      taskSetupOptions: { workspaces: [], templates: [] },
    })),
    readTask: vi.fn(async () => taskRead()),
    readConfiguration: vi.fn(async () => ({
      kind: "template_studio" as const,
      model: { generatedAt: NOW, templates: [], drafts: [] },
    })),
    command: vi.fn(async (command) => {
      commands.push(command);
      if (command.type === "task.start") {
        return { task: { taskId: "task_queued", status: "running" }, run: { runId: "run_started", status: "starting" } } as never;
      }
      if (command.type === "task.preview_permanent_delete") {
        return {
          permanentDeletePreview: {
            taskId: command.taskId,
            expectedRevision: command.expectedRevision,
            productRecordCounts: { tasks: 1 },
            workspaceFilesWillRemain: true,
          },
        } as never;
      }
      if (command.type === "task.permanently_delete") {
        return {
          permanentDelete: {
            taskId: command.taskId,
            deletedAt: NOW,
            workspaceFilesWillRemain: true,
          },
        } as never;
      }
      return {};
    }),
    subscribe: vi.fn(async () => () => undefined),
  };
  return { client, commands };
}

function taskRead(): AgentLoopSessionIdTaskReadModel {
  return {
    taskId: "task_running",
    title: "Running",
    goal: "Use the Session-ID lane",
    revision: 8,
    runId: "run_running",
    runStatus: "running",
    conductorLogicalSessionId: "session_conductor",
    timeline: [],
    directory: [],
    sessions: [{
      logicalSessionId: "session_conductor",
      agentCardId: "conductor",
      title: "Conductor",
      kind: "conductor",
      generation: 1,
      lifecycle: "current",
      state: "available",
      hasReceivedFirstInstruction: true,
      profile: {
        schemaVersion: 3,
        executionProfileId: "profile_conductor",
        profileRevisionId: "profile_revision_conductor",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        model: "opencode-go/test-model",
        role: "conductor",
        permissionMode: "deny",
        allowedTools: [],
        requiredCapabilities: [],
        requiredExtensions: [],
        readiness: {
          profileRevisionId: "profile_revision_conductor",
          providerFamily: "opencode",
          acpAgentKind: "native_acp",
          role: "conductor",
          status: "available",
          reasons: [],
          missingCapabilities: [],
          missingExtensions: [],
          model: "opencode-go/test-model",
        },
        mutableDuringRun: false,
      },
      messages: [],
      executionGroups: [],
      interactions: [],
      controls: [],
      humanDeliveries: [],
    }],
    files: [],
  };
}
