/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  activateNativeWorkspaceSession,
  getNativePtySession,
  getNativeRuntimeStatus,
  inspectNativeOpencodeProcesses,
  appendNativeTaskEvent,
  callNativeSession,
  createNativeManualOrchestrationTemplateDraft,
  readNativeSession,
  readNativeTaskState,
  readNativePtySession,
  readNativeWorkspaceTerminalLog,
  resizeNativePtySession,
  runNativeVerification,
  runNativeOpencode,
  generateNativeTaskDraft,
  listNativeOpencodeAgents,
  listNativeOrchestrationTemplateBlueprints,
  enqueueNativeTerminalInput,
  registerNativeWorkspaceSessionProfile,
  subscribeNativePtyEvents,
  subscribeNativeAgentLoopRuntimeEvents,
  stopNativePtySession,
  stopNativeAgentLoopTask,
  chooseNativeAgentLoopProjectDirectory,
  type NativePtyEvent,
} from "./nativeBridge";

describe("native runtime bridge", () => {
  it("reports browser mode when the Electron preload bridge is unavailable", async () => {
    delete window.agentWorkspace;

    const status = await getNativeRuntimeStatus();

    expect(status).toEqual({
      available: false,
      mode: "browser",
      message: "浏览器模式无法直接启动本地 opencode。请使用桌面壳运行。",
    });
  });

  it("delegates Task project-folder selection to the desktop preload bridge", async () => {
    const paths: Array<string | undefined> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({ available: true, mode: "desktop", message: "ready" }),
        runOpencode: async () => ({ ok: true, command: "opencode", cwd: "/tmp", stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
        chooseAgentLoopProjectDirectory: async (input) => {
          paths.push(input?.defaultPath);
          return { path: "/tmp/selected-project", name: "selected-project" };
        },
      },
    };

    await expect(chooseNativeAgentLoopProjectDirectory("/tmp/current-project")).resolves.toEqual({ path: "/tmp/selected-project", name: "selected-project" });
    expect(paths).toEqual(["/tmp/current-project"]);
  });

  it("reads raw terminal diagnostics only through the desktop bridge", async () => {
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({ available: true, mode: "desktop", message: "ready" }),
        runOpencode: async () => ({ ok: true, command: "opencode", cwd: "/tmp", model: "test", stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
        readWorkspaceTerminalLog: async (input) => ({
          sessionId: input.workspaceSessionId,
          content: "OpenCode TUI ready\n",
          bytes: 19,
          truncated: false,
        }),
      },
    };

    await expect(readNativeWorkspaceTerminalLog({ taskId: "task-1", workspaceSessionId: "task-1-conductor" })).resolves.toEqual({
      sessionId: "task-1-conductor",
      content: "OpenCode TUI ready\n",
      bytes: 19,
      truncated: false,
    });
  });

  it("delegates status and opencode run requests to the desktop preload bridge", async () => {
    const requests: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          opencodePath: "/opt/homebrew/bin/opencode",
          opencodeVersion: "1.17.9",
          message: "opencode ready",
        }),
        runOpencode: async (input) => {
          requests.push(`${input.cwd}:${input.model}:${input.message}`);
          return {
            ok: true,
            command: "opencode run --format json --model opencode-go/deepseek-v4-flash",
            cwd: input.cwd,
            model: input.model,
            stdout: "{\"type\":\"message\"}",
            stderr: "",
            exitCode: 0,
            durationMs: 42,
          };
        },
      },
    };

    await expect(getNativeRuntimeStatus()).resolves.toMatchObject({
      available: true,
      mode: "desktop",
      opencodePath: "/opt/homebrew/bin/opencode",
      opencodeVersion: "1.17.9",
    });
    await expect(runNativeOpencode({ cwd: "/tmp/project", message: "Summarize current task" })).resolves.toMatchObject({
      ok: true,
      command: "opencode run --format json --model opencode-go/deepseek-v4-flash",
      model: "opencode-go/deepseek-v4-flash",
      stdout: "{\"type\":\"message\"}",
    });
    expect(requests).toEqual(["/tmp/project:opencode-go/deepseek-v4-flash:Summarize current task"]);
  });

  it("delegates task draft generation requests to the desktop preload bridge", async () => {
    const requests: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        generateTaskDraft: async (input) => {
          requests.push(`${input.projectPath}:${input.model}:${input.message}`);
          return {
            ok: true,
            assistantMessage: "已生成调研任务配置。",
            draft: {
              projectPath: "/tmp/project",
              projectName: "project",
              title: "调研 dynamic workflow",
              summary: "调研机制。",
              templateId: "research",
              model: "opencode-go/deepseek-v4-flash",
              labels: ["research"],
              artifactPath: "docs/research/workflow.md",
            },
            missingFields: [],
            assumptions: [],
          };
        },
      },
    };

    await expect(
      generateNativeTaskDraft({
        message: "调研 dynamic workflow",
        projectPath: "/tmp/project",
      }),
    ).resolves.toMatchObject({
      ok: true,
      draft: {
        title: "调研 dynamic workflow",
        templateId: "research",
      },
    });
    expect(requests).toEqual([
      "/tmp/project:opencode-go/deepseek-v4-flash:调研 dynamic workflow",
    ]);
  });

  it("delegates Template Blueprint listing and a hand-built Draft to the desktop preload bridge", async () => {
    const calls: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({ available: true, mode: "desktop", message: "ready" }),
        runOpencode: async (input) => ({ ok: true, command: "opencode run --format json", cwd: input.cwd, stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
        listOrchestrationTemplateBlueprints: async () => [
          {
            id: "release-evidence",
            version: 1,
            name: "Release evidence",
            description: "Inspect then verify.",
            source: "manual" as const,
            agentLoopTemplate: { id: "release-loop", version: 1, family: "agent_loop" as const },
            workflowTemplate: { id: "release-workflow", version: 1, family: "workflow" as const },
            createdAt: "2026-07-24T00:00:00.000Z",
            updatedAt: "2026-07-24T00:00:00.000Z",
          },
        ],
        createManualOrchestrationTemplateDraft: async (input) => {
          calls.push(`${input.title}:${input.workflow.nodes.map((node) => node.id).join(",")}`);
          return {
            draftId: "draft-manual",
            cwd: input.cwd,
            title: input.title,
            goal: input.goal ?? "",
            model: "opencode-go/deepseek-v4-flash",
            status: "manual" as const,
            candidate: {
              blueprint: { id: "release-evidence", name: input.title, description: input.description ?? "" },
              agentLoop: { id: "release-loop", name: "Release loop", definition: { conductor: { provider: "opencode" as const, role: "Conductor" } } },
              workflow: { id: "release-workflow", name: "Release workflow", definition: { nodes: input.workflow.nodes, wakeOn: ["workflow.completed"] } },
              rationale: "hand-built",
              assumptions: [],
            },
            createdAt: "2026-07-24T00:00:00.000Z",
            updatedAt: "2026-07-24T00:00:00.000Z",
          };
        },
      },
    };

    await expect(listNativeOrchestrationTemplateBlueprints()).resolves.toMatchObject([
      { id: "release-evidence", source: "manual" },
    ]);
    await expect(
      createNativeManualOrchestrationTemplateDraft({
        cwd: "/tmp/project",
        title: "Release evidence",
        description: "Inspect then verify.",
        agentLoop: { conductorRole: "Conductor" },
        workflow: {
          nodes: [
            { id: "inspect", role: "Inspector", kind: "delegate", dependsOn: [] },
            { id: "verify", role: "Verifier", kind: "verify", dependsOn: ["inspect"] },
          ],
        },
      }),
    ).resolves.toMatchObject({ status: "manual", candidate: { blueprint: { name: "Release evidence" } } });
    expect(calls).toEqual(["Release evidence:inspect,verify"]);
  });

  it("delegates Conductor session tool bridge methods to the desktop preload bridge", async () => {
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        callSession: async () => ({
          ok: true,
          dispatchId: "A1B2C3",
          taskId: "task-1",
          toSessionId: "task-1-researcher",
          status: "delivered",
          deliveryState: "delivered",
          targetSessionState: "delivered_pending",
          resultState: "pending",
          turnPolicy: "continue_dispatching_or_wait",
          nextAllowedAction: "wait_for_runtime_wakeup",
          message:
            "Assignment delivered to a native Session Agent. You may dispatch other independent work, or wait for a semantic Runtime wakeup before using its result.",
        }),
        readTaskState: async () => ({
          taskId: "task-1",
          cursor: 1,
          sessions: [{ sessionId: "task-1-researcher", state: "ready", cursor: 1 }],
          dispatches: [],
          results: [],
          messages: [],
          pendingDecisions: [],
        }),
        readSession: async () => ({
          sessionId: "task-1-researcher",
          state: "ready",
          cursor: 1,
          cleanTranscriptTail: "research done",
          events: [],
          dispatches: [],
          results: [],
          messages: [],
          permissions: [],
          artifacts: [],
        }),
      },
    };

    await expect(
      callNativeSession({
        taskId: "task-1",
        toSessionId: "task-1-researcher",
        assignment: "research",
      }),
    ).resolves.toMatchObject({ ok: true, status: "delivered", deliveryState: "delivered" });
    await expect(readNativeSession({ taskId: "task-1", sessionId: "task-1-researcher" })).resolves.toMatchObject({
      state: "ready",
      cleanTranscriptTail: "research done",
    });
    await expect(readNativeTaskState({ taskId: "task-1" })).resolves.toMatchObject({
      taskId: "task-1",
      pendingDecisions: [],
    });
  });

  it("delegates task execution event appends to the desktop preload bridge", async () => {
    const calls: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        appendTaskEvent: async (input) => {
          calls.push(`${input.taskId}:${input.sessionId}:${input.type}:${input.data?.message}`);
          return {
            ok: true,
            event: {
              id: "event-1",
              taskId: input.taskId,
              sessionId: input.sessionId ?? "",
              type: input.type,
              createdAt: "2026-07-06T00:00:00.000Z",
              cursor: 1,
              summary: input.summary,
              data: input.data,
            },
            taskState: {
              taskId: input.taskId,
              cursor: 1,
              events: [
                {
                  id: "event-1",
                  taskId: input.taskId,
                  sessionId: input.sessionId ?? "",
                  type: input.type,
                  createdAt: "2026-07-06T00:00:00.000Z",
                  cursor: 1,
                  summary: input.summary,
                  data: input.data,
                },
              ],
              sessions: [],
              dispatches: [],
              results: [],
              messages: [],
              pendingDecisions: [],
            },
          };
        },
      },
    };

    await expect(
      appendNativeTaskEvent({
        taskId: "task-1",
        sessionId: "task-1-conductor",
        cwd: "/tmp/project",
        type: "user.intervention",
        summary: "User intervention sent to Conductor",
        data: { message: "后端纠偏消息", source: "task-composer" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      taskState: {
        taskId: "task-1",
        events: [
          {
            type: "user.intervention",
            data: { message: "后端纠偏消息" },
          },
        ],
      },
    });
    expect(calls).toEqual(["task-1:task-1-conductor:user.intervention:后端纠偏消息"]);
  });

  it("delegates managed Workspace Session lifecycle requests to the desktop preload bridge", async () => {
    const calls: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({
          ok: true,
          agents: [
            { name: "plan", kind: "primary" },
            { name: "build", kind: "primary" },
          ],
        }),
        registerWorkspaceSessionProfile: async (input) => {
          calls.push(`register:${input.workspaceSessionId}:${input.provider}:${input.cwd}:${input.model}`);
          return { workspaceSessionId: input.workspaceSessionId, fingerprint: "profile-fingerprint", taskId: input.taskId };
        },
        activateWorkspaceSession: async (input) => {
          calls.push(`activate:${input.workspaceSessionId}:${input.operationId}`);
          return {
            disposition: "created",
            workspaceSessionId: input.workspaceSessionId,
            owner: {
              workspaceSessionId: input.workspaceSessionId,
              taskId: "task-1",
              ptyId: input.workspaceSessionId,
              incarnationId: "inc-1",
              generation: "gen-1",
              state: "active",
            },
            session: {
            id: input.workspaceSessionId,
            command: "opencode",
            args: ["--model", "opencode-go/deepseek-v4-flash"],
            cwd: "/tmp/project",
            backend: "process",
            status: "running",
            cols: 100,
            rows: 30,
            transcript: ["started\n"],
            incarnationId: "inc-1",
            generation: "gen-1",
            },
          };
        },
        readWorkspaceSession: async (input) => {
          calls.push(`read:${input.workspaceSessionId}:${input.cursor}`);
          if (input.cursor > 0) {
            return {
              id: input.workspaceSessionId,
              command: "opencode",
              args: ["--model", "opencode-go/deepseek-v4-flash"],
              cwd: "/tmp/project",
              backend: "process",
              status: "running",
              cols: 100,
              rows: 30,
              transcript: ["delta\n"],
              cursor: 3,
              incarnationId: "inc-1",
              generation: "gen-1",
            };
          }
          return {
            id: input.workspaceSessionId,
            command: "opencode",
            args: ["--model", "opencode-go/deepseek-v4-flash"],
            cwd: "/tmp/project",
            backend: "process",
            status: "stopped",
            cols: 100,
            rows: 30,
            transcript: ["started\n", "done\n"],
            exitCode: 0,
            incarnationId: "inc-1",
            generation: "gen-1",
          };
        },
        enqueueTerminalInput: async (input) => {
          calls.push(`input:${input.workspaceSessionId}:${input.expectedIncarnationId}:${input.source}:${input.payload}`);
          return {
            disposition: "written",
            workspaceSessionId: input.workspaceSessionId,
            incarnationId: input.expectedIncarnationId,
            source: input.source,
          };
        },
        resizeWorkspaceSession: async (input) => {
          calls.push(`resize:${input.workspaceSessionId}:${input.expectedIncarnationId}:${input.cols}x${input.rows}`);
          return undefined;
        },
        stopWorkspaceSession: async (input) => {
          calls.push(`stop:${input.workspaceSessionId}:${input.expectedIncarnationId}`);
          return undefined;
        },
      },
    };

    await expect(
      registerNativeWorkspaceSessionProfile({
        workspaceSessionId: "native-session-1",
        taskId: "task-1",
        provider: "opencode",
        cwd: "/tmp/project",
        model: "opencode-go/deepseek-v4-flash",
        cols: 100,
        rows: 30,
      }),
    ).resolves.toMatchObject({
      workspaceSessionId: "native-session-1",
      fingerprint: "profile-fingerprint",
    });
    await expect(
      activateNativeWorkspaceSession({ workspaceSessionId: "native-session-1", operationId: "activate-1" }),
    ).resolves.toMatchObject({
      disposition: "created",
      session: { id: "native-session-1", backend: "process", transcript: ["started\n"] },
    });
    await expect(getNativePtySession("native-session-1")).resolves.toMatchObject({
      status: "stopped",
      transcript: ["started\n", "done\n"],
      exitCode: 0,
    });
    await expect(readNativePtySession("native-session-1", 2)).resolves.toMatchObject({
      status: "running",
      transcript: ["delta\n"],
      cursor: 3,
    });
    await enqueueNativeTerminalInput({
      workspaceSessionId: "native-session-1",
      expectedIncarnationId: "inc-1",
      source: "user",
      payload: "continue\n",
    });
    await resizeNativePtySession("native-session-1", { cols: 120, rows: 40 }, "inc-1");
    await stopNativePtySession("native-session-1", "inc-1");
    await expect(listNativeOpencodeAgents()).resolves.toEqual({
      ok: true,
      agents: [
        { name: "plan", kind: "primary" },
        { name: "build", kind: "primary" },
      ],
    });

    expect(calls).toEqual([
      "register:native-session-1:opencode:/tmp/project:opencode-go/deepseek-v4-flash",
      "activate:native-session-1:activate-1",
      "read:native-session-1:0",
      "read:native-session-1:2",
      "input:native-session-1:inc-1:user:continue\n",
      "resize:native-session-1:inc-1:120x40",
      "stop:native-session-1:inc-1",
    ]);
  });

  it("subscribes to native PTY streaming events through the preload bridge", () => {
    const events: NativePtyEvent[] = [];
    const callbacks: Array<(event: NativePtyEvent) => void> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        onPtyEvent: (callback) => {
          callbacks.push(callback);
          return () => {
            callbacks.splice(callbacks.indexOf(callback), 1);
          };
        },
      },
    };

    const unsubscribe = subscribeNativePtyEvents((event) => events.push(event));
    callbacks[0]?.({
      type: "data",
      id: "native-session-1",
      chunk: "hello\n",
      cursor: 1,
    });
    unsubscribe();
    callbacks[0]?.({
      type: "data",
      id: "native-session-1",
      chunk: "ignored\n",
      cursor: 2,
    });

    expect(events).toEqual([
      {
        type: "data",
        id: "native-session-1",
        chunk: "hello\n",
        cursor: 1,
      },
    ]);
    expect(callbacks).toHaveLength(0);
  });

  it("subscribes to Agent Loop semantic invalidations without using the PTY stream", () => {
    const events: Array<{ taskId: string; runId: string; type: string }> = [];
    const callbacks: Array<(event: { taskId: string; runId: string; type: string }) => void> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({ available: true, mode: "desktop", message: "ready" }),
        runOpencode: async (input) => ({ ok: true, command: "opencode", cwd: input.cwd, stdout: "", stderr: "", exitCode: 0, durationMs: 1 }),
        onAgentLoopRuntimeEvent: (callback) => {
          callbacks.push(callback);
          return () => callbacks.splice(callbacks.indexOf(callback), 1);
        },
      },
    };

    const unsubscribe = subscribeNativeAgentLoopRuntimeEvents((event) => events.push(event));
    callbacks[0]?.({ taskId: "task-1", runId: "run-1", type: "dispatch.result_available" });
    unsubscribe();
    callbacks[0]?.({ taskId: "task-1", runId: "run-1", type: "ignored" });

    expect(events).toEqual([{ taskId: "task-1", runId: "run-1", type: "dispatch.result_available" }]);
  });

  it("delegates native verification command requests to the desktop preload bridge", async () => {
    const calls: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        runVerification: async (input) => {
          calls.push(`${input.runId}:${input.cwd}:${input.command}`);
          return {
            ok: true,
            command: input.command,
            cwd: input.cwd,
            runId: input.runId,
            status: "passed",
            stdout: "tests passed\n",
            stderr: "",
            exitCode: 0,
            durationMs: 37,
            artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
            logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
          };
        },
      },
    };

    await expect(
      runNativeVerification({
        cwd: "/tmp/project",
        runId: "run-plan-watc-active",
        command: "npm test && npm run build",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: "passed",
      artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
      logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
    });
    expect(calls).toEqual(["run-plan-watc-active:/tmp/project:npm test && npm run build"]);
  });

  it("delegates opencode process inspection to the desktop preload bridge", async () => {
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({
          available: true,
          mode: "desktop",
          message: "ready",
        }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        inspectOpencodeProcesses: async () => ({
          ok: true,
          processes: [
            {
              pid: 81076,
              ppid: 80891,
              rssKb: 150256,
              rssMb: 146.73,
              percentMemory: 0.9,
              elapsed: "02:46",
              command: "opencode",
              args: "opencode --session task",
            },
          ],
        }),
      },
    };

    await expect(inspectNativeOpencodeProcesses()).resolves.toEqual({
      ok: true,
      processes: [
        {
          pid: 81076,
          ppid: 80891,
          rssKb: 150256,
          rssMb: 146.73,
          percentMemory: 0.9,
          elapsed: "02:46",
          command: "opencode",
          args: "opencode --session task",
        },
      ],
    });
  });

  it("returns a browser fallback when opencode process inspection is unavailable", async () => {
    delete window.agentWorkspace;

    await expect(inspectNativeOpencodeProcesses()).resolves.toEqual({
      ok: false,
      processes: [],
      error: "浏览器模式无法直接启动本地 opencode。请使用桌面壳运行。",
    });
  });

  it("delegates Task stop requests to the desktop preload bridge", async () => {
    const taskIds: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => ({ available: true, mode: "desktop", message: "ready" }),
        runOpencode: async () => ({ ok: true, command: "opencode", cwd: "/tmp", stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
        stopAgentLoopTask: async ({ taskId }) => {
          taskIds.push(taskId);
          return undefined;
        },
      },
    };

    await expect(stopNativeAgentLoopTask("task-stop-1")).resolves.toBeUndefined();
    expect(taskIds).toEqual(["task-stop-1"]);
  });
});
