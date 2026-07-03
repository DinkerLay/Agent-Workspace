/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  getNativePtySession,
  getNativeRuntimeStatus,
  inspectNativeOpencodeProcesses,
  callNativeSession,
  readNativeSession,
  readNativeTaskState,
  readNativePtySession,
  resizeNativePtySession,
  runNativeVerification,
  runNativeOpencode,
  generateNativeTaskDraft,
  listNativeOpencodeAgents,
  startNativePtySession,
  subscribeNativePtyEvents,
  stopNativePtySession,
  writeNativePtySession,
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
          targetSessionState: "running",
          resultState: "pending",
          turnPolicy: "stop_after_dispatch",
          nextAllowedAction: "wait_for_runtime_wakeup",
          message:
            "Assignment delivered to target session. End this Conductor turn now and wait for a runtime wakeup before reading the result.",
        }),
        readTaskState: async () => ({
          taskId: "task-1",
          cursor: 1,
          sessions: [{ sessionId: "task-1-researcher", state: "idle", cursor: 1 }],
          dispatches: [],
          results: [],
          messages: [],
          pendingDecisions: [],
        }),
        readSession: async () => ({
          sessionId: "task-1-researcher",
          state: "idle",
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
      state: "idle",
      cleanTranscriptTail: "research done",
    });
    await expect(readNativeTaskState({ taskId: "task-1" })).resolves.toMatchObject({
      taskId: "task-1",
      pendingDecisions: [],
    });
  });

  it("delegates native PTY session lifecycle requests to the desktop preload bridge", async () => {
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
        startPty: async (input) => {
          calls.push(`start:${input.command}:${input.cwd}:${input.args?.join(" ")}:${input.requirePty}`);
          return {
            id: input.id ?? "native-session-1",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            backend: "process",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: ["started\n"],
          };
        },
        getPty: async (input) => {
          calls.push(`get:${input.id}`);
          return {
            id: input.id,
            command: "opencode",
            args: ["--model", "opencode-go/deepseek-v4-flash"],
            cwd: "/tmp/project",
            backend: "process",
            status: "stopped",
            cols: 100,
            rows: 30,
            transcript: ["started\n", "done\n"],
            exitCode: 0,
          };
        },
        readPty: async (input) => {
          calls.push(`read:${input.id}:${input.cursor}`);
          return {
            id: input.id,
            command: "opencode",
            args: ["--model", "opencode-go/deepseek-v4-flash"],
            cwd: "/tmp/project",
            backend: "process",
            status: "running",
            cols: 100,
            rows: 30,
            transcript: ["delta\n"],
            cursor: 3,
          };
        },
        writePty: async (input) => {
          calls.push(`write:${input.id}:${input.text}`);
          return undefined;
        },
        resizePty: async (input) => {
          calls.push(`resize:${input.id}:${input.cols}x${input.rows}`);
          return undefined;
        },
        stopPty: async (input) => {
          calls.push(`stop:${input.id}`);
          return undefined;
        },
      },
    };

    await expect(
      startNativePtySession({
        id: "native-session-1",
        command: "opencode",
        args: ["--model", "opencode-go/deepseek-v4-flash"],
        cwd: "/tmp/project",
        cols: 100,
        rows: 30,
        requirePty: true,
      }),
    ).resolves.toMatchObject({
      id: "native-session-1",
      backend: "process",
      transcript: ["started\n"],
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
    await writeNativePtySession("native-session-1", "continue\n");
    await resizeNativePtySession("native-session-1", { cols: 120, rows: 40 });
    await stopNativePtySession("native-session-1");
    await expect(listNativeOpencodeAgents()).resolves.toEqual({
      ok: true,
      agents: [
        { name: "plan", kind: "primary" },
        { name: "build", kind: "primary" },
      ],
    });

    expect(calls).toEqual([
      "start:opencode:/tmp/project:--model opencode-go/deepseek-v4-flash:true",
      "get:native-session-1",
      "read:native-session-1:2",
      "write:native-session-1:continue\n",
      "resize:native-session-1:120x40",
      "stop:native-session-1",
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
});
