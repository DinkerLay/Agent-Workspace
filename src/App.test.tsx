/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";
import type { NativePtyEvent, NativePtySession, NativeRuntimeStatus } from "./runtime/nativeBridge";

afterEach(() => {
  cleanup();
  delete window.agentWorkspace;
  window.history.replaceState(null, "", "/");
});

function createRuntimeTask({
  title = "实现真实 runtime boot",
  summary = "Remove runtime mock imports and create task-scoped opencode agents.",
  templateId = "implementation",
  labels = "runtime, opencode",
}: {
  title?: string;
  summary?: string;
  templateId?: string;
  labels?: string;
} = {}) {
  fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: title } });
  fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: summary } });
  fireEvent.change(screen.getByLabelText("起始方案"), { target: { value: templateId } });
  fireEvent.change(screen.getByLabelText("任务标签"), { target: { value: labels } });
  fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));

  expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  return title;
}

function desktopReadyStatus(overrides: Partial<NativeRuntimeStatus> = {}): NativeRuntimeStatus {
  return {
    available: true,
    mode: "desktop",
    opencodePath: "opencode",
    ptyAvailable: true,
    ptyBackend: "node-pty+process-fallback",
    conductorToolBridgeUrl: "http://127.0.0.1:17777",
    conductorToolBridgeToken: "test-token",
    conductorMcpServerPath: "/tmp/agent-workspace-conductor-mcp.cjs",
    message: "ready",
    ...overrides,
  };
}

function expectConductorRuntimeSessionId(id: string | undefined) {
  expect(id).toMatch(/^opencode:project-[a-z0-9]{6}:task-[a-z0-9]{6}:task-intake-\d{3}-conductor$/);
}

function expectWorkerRuntimeSessionId(id: string | undefined, agentSuffix: string) {
  expect(id).toMatch(
    new RegExp(`^opencode:project-[a-z0-9]{6}:task-[a-z0-9]{6}:task-intake-\\d{3}-${agentSuffix}$`),
  );
}

function sessionIdFromTranscriptLine(text: string) {
  return text.replace(/^session\s+/, "").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("App information architecture", () => {
  it("does not import mock data or mock adapters in runtime entry files", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const runtimeFiles = ["App.tsx", "lib/taskMachine.ts", "runtime/taskOrchestrator.ts"];

    for (const file of runtimeFiles) {
      const source = readFileSync(resolve(here, file), "utf8");
      expect(source).not.toMatch(/from ["']\.{1,2}\/mock\//);
      expect(source).not.toContain("createMockRuntimeAdapters");
      expect(source).not.toContain("initialPrototypeState");
      expect(source).not.toContain("mock-run-");
    }
  });

  it("keeps the primary navigation focused on four board-first workbench entries", () => {
    const { container } = render(<App />);

    expect(container.querySelector(".app-shell.primary-rail-collapsed")).toBeTruthy();
    expect(container.querySelector(".rail.rail-collapsed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开主导航" })).toBeTruthy();

    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.queryByText("Mock prototype")).toBeNull();

    const nav = screen.getByRole("navigation", { name: "Prototype pages" });
    const labels = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());

    expect(labels).toEqual(["任务主页", "IDE 工作台", "交付门禁", "更多"]);
    expect(within(nav).queryByRole("button", { name: "能力地图" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Loop 控制台" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "MCP Gateway" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Browser" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Projects" })).toBeNull();
  });

  it("groups review, runs, and audit under the delivery gate entry", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "交付门禁" }));

    expect(screen.getByRole("heading", { level: 1, name: "交付门禁" })).toBeTruthy();
    expect(screen.getByText("Review、Runs、Audit 聚合在同一个交付入口。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Runs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Audit Trail" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开 Review" }));

    expect(screen.getByRole("heading", { level: 1, name: "Review / 交付门禁" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Prototype pages" })).getByRole("button", { name: "交付门禁" }).className,
    ).toContain("active");
  });

  it("keeps advanced and design surfaces available behind the more entry", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "更多" }));

    expect(screen.getByRole("heading", { level: 1, name: "更多能力" })).toBeTruthy();
    expect(screen.getByText("项目、资源、自动化和产品地图都保留在二级入口。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开项目驾驶舱" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开资源库" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Loop 控制台" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 MCP Gateway" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 Browser Automation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开产品地图" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开产品地图" }));

    expect(screen.getByRole("heading", { level: 1, name: "产品地图" })).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Prototype pages" })).getByRole("button", { name: "更多" }).className,
    ).toContain("active");
  });

  it("boots Task Home from an empty runtime workspace without a project sidebar", () => {
    const { container } = render(<App />);

    expect(screen.getByRole("heading", { level: 1, name: "任务主页" })).toBeTruthy();
    expect(container.querySelector(".task-home-layout-empty")).toBeTruthy();
    expect(container.querySelector(".task-home-sidebar")).toBeNull();
    expect(screen.getByRole("separator", { name: "目录分割线" })).toBeTruthy();
    const directoryTree = screen.getByLabelText("项目任务列表");
    expect(within(directoryTree).getByText("项目")).toBeTruthy();
    expect(within(directoryTree).getByRole("button", { name: "新建项目" })).toBeTruthy();
    expect(within(directoryTree).getByLabelText("当前项目 Agent-Workspace")).toBeTruthy();
    expect(within(directoryTree).getByRole("button", { name: "新建任务 Agent-Workspace" })).toBeTruthy();
    expect(within(directoryTree).queryByRole("button", { name: "新任务" })).toBeNull();
    expect(screen.queryByLabelText("目录路径")).toBeNull();
    expect(screen.queryByLabelText("目录名称")).toBeNull();
    expect(container.querySelector(".rail-project-status")).toBeNull();
    expect(container.querySelector(".decision-box")).toBeNull();
    expect(screen.queryByText("0 active loops")).toBeNull();
    expect(screen.queryByText("任务主页 · Conductor · IDE 操作台")).toBeNull();
    expect(screen.getAllByText("还没有任务").length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText("Task Home")).queryByRole("button", { name: "新建任务" })).toBeNull();
    expect(screen.getByText("任务描述")).toBeTruthy();
    expect(screen.queryByText("Conductor Runtime 预览")).toBeNull();
    expect(screen.queryByText("MCP tools")).toBeNull();
    expect(screen.queryByText("call_session")).toBeNull();
    expect(screen.queryByText("read_task_state")).toBeNull();
    expect(screen.queryByText("read_session")).toBeNull();
    expect(screen.queryByText("finish_task_claim")).toBeNull();
    expect(screen.queryByText("Workspace Session Message")).toBeNull();
    expect(screen.queryByText("Conductor Terminal")).toBeNull();
    expect(screen.queryByText("Task Conductor")).toBeNull();
    expect(screen.queryByText("Worker Agents")).toBeNull();
    expect(screen.queryByText("Planner")).toBeNull();
    expect(screen.queryByText("Executor")).toBeNull();
    expect(screen.queryByText("当前任务摘要")).toBeNull();
    expect(screen.queryByText("看板优先 · Loop 可见 · IDE 下钻")).toBeNull();
    expect(screen.queryByText("Board-first · Loop visible · IDE drill-down")).toBeNull();
    expect(screen.queryByText("Task owns state")).toBeNull();
    expect(screen.queryByText("Loop owns scheduling")).toBeNull();
    expect(screen.queryByText("IDE owns run surface")).toBeNull();
    expect(screen.queryByText("Review gates Done")).toBeNull();
  });

  it("uses URL project context for a newly opened runtime workspace", () => {
    window.history.replaceState(
      null,
      "",
      "/?projectPath=%2FUsers%2Fdinker%2FCODES%2FTEMP_project%2FAgent_Test&projectName=Agent_Test",
    );

    render(<App />);

    expect(screen.getByText("Agent_Test")).toBeTruthy();
    expect(screen.getByLabelText("当前项目 Agent_Test")).toBeTruthy();
    expect(screen.getByTitle("项目目录: /Users/dinker/CODES/TEMP_project/Agent_Test")).toBeTruthy();
  });

  it("returns to Task Home from the project task-create button", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    expect(screen.getByRole("heading", { level: 1, name: "IDE 工作台" })).toBeTruthy();

    fireEvent.click(within(screen.getByLabelText("项目任务列表")).getByRole("button", { name: "新建任务 Agent-Workspace" }));

    expect(screen.getByRole("heading", { level: 1, name: "任务主页" })).toBeTruthy();
  });

  it("keeps the project row as a sidebar list item instead of an inline directory editor", () => {
    render(<App />);

    expect(screen.getByLabelText("当前项目 Agent-Workspace")).toBeTruthy();

    expect(screen.queryByLabelText("目录路径")).toBeNull();
    expect(screen.queryByLabelText("目录名称")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开目录" })).toBeNull();
  });

  it("creates a project from the sidebar project add button with a directory address", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    fireEvent.change(screen.getByLabelText("项目目录地址"), {
      target: { value: "/Users/dinker/CODES/TEMP_project/Agent_Test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    expect(screen.getByLabelText("当前项目 Agent_Test")).toBeTruthy();
    expect(screen.queryByLabelText("项目目录地址")).toBeNull();
  });

  it("uses the current project context and auto-starts Conductor in that cwd", async () => {
    window.history.replaceState(
      null,
      "",
      "/?projectPath=%2FUsers%2Fdinker%2FCODES%2FTEMP_project%2FAgent_Test&projectName=Agent_Test",
    );
    const startPtyInputs: Array<{ id?: string; cwd: string; args?: string[] }> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
            cursor: 1,
          };
        },
        writePty: async (input) => ({
          id: input.id,
          command: "opencode",
          args: [],
          cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: [],
          cursor: 1,
        }),
      },
    };

    render(<App />);

    expect(screen.getByText("Agent_Test")).toBeTruthy();
    createRuntimeTask({
      title: "调研claude dynamic workflow 的机制",
      summary: "调研 claude dynamic workflow 的机制。",
      templateId: "research",
    });

    await waitFor(() => expect(startPtyInputs).toHaveLength(1));
    expect(
      within(screen.getByLabelText("项目任务列表")).getByRole("button", {
        name: "打开任务 调研claude dynamic workflow 的机制",
      }),
    ).toBeTruthy();
    expectConductorRuntimeSessionId(startPtyInputs[0].id);
    expect(startPtyInputs[0]).toMatchObject({
      taskId: expect.stringMatching(/^task-[a-z0-9]{6}$/),
      cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      args: [
        "--model",
        "opencode-go/deepseek-v4-flash",
      ],
    });
  });

  it("creates a fresh task-scoped Conductor PTY session for every new task even when labels match", async () => {
    window.history.replaceState(
      null,
      "",
      "/?projectPath=%2FUsers%2Fdinker%2FCODES%2FTEMP_project%2FAgent_Test&projectName=Agent_Test",
    );
    const startPtyInputs: Array<{ id?: string; taskId?: string; cwd: string; args?: string[] }> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
            cursor: 1,
          };
        },
        writePty: async (input) => ({
          id: input.id,
          command: "opencode",
          args: [],
          cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: [],
          cursor: 1,
        }),
      },
    };

    render(<App />);

    const sharedTitle = "同名调研任务";
    createRuntimeTask({
      title: sharedTitle,
      summary: "第一次调研任务。",
      templateId: "research",
      labels: "research, repeated",
    });
    await waitFor(() => expect(startPtyInputs).toHaveLength(1));

    createRuntimeTask({
      title: sharedTitle,
      summary: "第二次调研任务。",
      templateId: "research",
      labels: "research, repeated",
    });
    await waitFor(() => expect(startPtyInputs).toHaveLength(2));

    expectConductorRuntimeSessionId(startPtyInputs[0].id);
    expectConductorRuntimeSessionId(startPtyInputs[1].id);
    expect(startPtyInputs[0].id).not.toBe(startPtyInputs[1].id);
    expect(startPtyInputs[0].taskId).not.toBe(startPtyInputs[1].taskId);
    expect(startPtyInputs[0].id).not.toContain(startPtyInputs[1].taskId ?? "");
    expect(startPtyInputs[1]).toMatchObject({
      taskId: expect.stringMatching(/^task-[a-z0-9]{6}$/),
      cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      args: [
        "--model",
        "opencode-go/deepseek-v4-flash",
      ],
    });
  });

  it("generates a task draft through the native opencode assistant before creating and starting Conductor", async () => {
    const draftRequests: Array<{ message: string; projectPath: string; currentDraft?: unknown }> = [];
    const startPtyInputs: Array<{ id?: string; cwd: string; args?: string[] }> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        generateTaskDraft: async (input) => {
          draftRequests.push(input);
          return {
            ok: true,
            assistantMessage: "已生成调研任务配置。",
            draft: {
              projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
              projectName: "Agent_Test",
              title: "调研 claude dynamic workflow 机制",
              summary: "调研 claude dynamic workflow 的运行机制，并输出机制报告和后续 spec/plan 线索。",
              templateId: "research",
              model: "opencode-go/deepseek-v4-flash",
              labels: ["research", "claude", "workflow"],
              artifactPath: "docs/research/claude-dynamic-workflow.md",
            },
            missingFields: [],
            assumptions: [],
          };
        },
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
            cursor: 1,
          };
        },
        writePty: async (input) => ({
          id: input.id,
          command: "opencode",
          args: [],
          cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: [],
          cursor: 1,
        }),
      },
    };

    render(<App />);

    fireEvent.change(screen.getByLabelText("一句话描述任务"), {
      target: {
        value:
          "在 /Users/dinker/CODES/TEMP_project/Agent_Test 调研 claude dynamic workflow 机制，输出报告和 spec/plan 线索。",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成配置" }));

    await waitFor(() =>
      expect((screen.getByLabelText("任务标题") as HTMLInputElement).value).toBe("调研 claude dynamic workflow 机制"),
    );
    fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));

    await waitFor(() => expect(startPtyInputs).toHaveLength(1));
    expectConductorRuntimeSessionId(startPtyInputs[0].id);
    expect(draftRequests[0]).toMatchObject({
      projectPath: "/Users/dinker/CODES/Agent-Workspace",
      message:
        "在 /Users/dinker/CODES/TEMP_project/Agent_Test 调研 claude dynamic workflow 机制，输出报告和 spec/plan 线索。",
    });
    expect(startPtyInputs[0]).toMatchObject({
      cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      taskId: expect.stringMatching(/^task-[a-z0-9]{6}$/),
      args: [
        "--model",
        "opencode-go/deepseek-v4-flash",
      ],
    });
  });

  it("creates task-scoped agents from intake and opens Executor in Workbench", () => {
    render(<App />);

    createRuntimeTask({ title: "实现 Task 6 runtime boot" });

    expect(screen.getByText("Conductor Terminal")).toBeTruthy();
    expect(screen.getByText("Worker Agents")).toBeTruthy();
    expect(screen.getByText("Executor")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    expect(screen.getByRole("heading", { level: 2, name: "Conductor 对话 Terminal" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    fireEvent.click(screen.getByRole("button", { name: /Executor.*Code implementation.*idle/ }));

    expect(screen.getByRole("heading", { level: 2, name: "Executor 对话 Terminal" })).toBeTruthy();
    expect(screen.getByLabelText("Agent 启动命令预览").textContent).toBe(
      "opencode --model opencode-go/deepseek-v4-flash",
    );
  });

  it("starts task agents through the opencode adapter command", async () => {
    const startPtyInputs: Array<{
      id?: string;
      command: string;
      args?: string[];
      cwd: string;
      model?: string;
      requirePty?: boolean;
    }> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            stdin: input.stdin,
            transcript: [`session ${input.id}\n`],
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({ title: "Route agent start through opencode adapter" });

    expect(screen.getByText("Conductor Terminal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    expect(screen.getByRole("heading", { level: 2, name: "Conductor 对话 Terminal" })).toBeTruthy();

    const startButton = await screen.findByRole("button", { name: "启动 opencode PTY" });
    await waitFor(() => expect(startButton).toHaveProperty("disabled", false));
    fireEvent.click(startButton);

    await waitFor(() => expect(startPtyInputs).toHaveLength(1));
    const input = startPtyInputs[0];
    expectConductorRuntimeSessionId(input.id);
    expect(input).toMatchObject({
      taskId: expect.stringMatching(/^task-[a-z0-9]{6}$/),
      command: expect.stringMatching(/opencode$/),
      args: [
        "--model",
        "opencode-go/deepseek-v4-flash",
      ],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      model: "opencode-go/deepseek-v4-flash",
      requirePty: true,
    });
  });

  it("auto-starts only Conductor with MCP injection and leaves workers provider-native", async () => {
    window.history.replaceState(
      null,
      "",
      "/?projectPath=%2FUsers%2Fdinker%2FCODES%2FTEMP_project%2FAgent_Test&projectName=Agent_Test",
    );
    const startPtyInputs: Array<{
      id?: string;
      command: string;
      args?: string[];
      cwd: string;
      model?: string;
      requirePty?: boolean;
      env?: Record<string, string>;
      runtimeFiles?: Array<{ relativePath: string; contents: string }>;
    }> = [];
    const writePtyInputs: Array<{ id: string; text: string }> = [];
    const ptyEventCallbacks: Array<(event: NativePtyEvent) => void> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus({ opencodePath: "/opt/homebrew/bin/opencode" }),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          queueMicrotask(() => {
            ptyEventCallbacks.forEach((callback) =>
              callback({
                type: "data",
                id: input.id ?? "native-session",
                chunk: 'Ask anything... "Fix a TODO in the codebase"\ntab agents  ctrl+p commands\n',
                cursor: 2,
              }),
            );
          });
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            stdin: input.stdin,
            transcript: [`booting ${input.id}\n`],
            cursor: 1,
          };
        },
        writePty: async (input) => {
          writePtyInputs.push(input);
          return {
            id: input.id,
            command: "/opt/homebrew/bin/opencode",
            args: [],
            cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
            backend: "pty",
            status: "running",
            cols: 100,
            rows: 30,
            transcript: [],
            cursor: 1,
          };
        },
        onPtyEvent: (callback) => {
          ptyEventCallbacks.push(callback);
          return () => {
            ptyEventCallbacks.splice(ptyEventCallbacks.indexOf(callback), 1);
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({
      title: "调研claude dynamic workflow 的机制",
      summary: "调研 claude dynamic workflow 的机制并形成可读报告。",
      templateId: "research",
      labels: "research, claude",
    });

    await waitFor(() => expect(startPtyInputs).toHaveLength(1));
    const conductorSessionId = startPtyInputs[0].id ?? "";
    expectConductorRuntimeSessionId(conductorSessionId);
    expect(startPtyInputs.map((input) => input.id)).toEqual([conductorSessionId]);
    expect(startPtyInputs[0]).toMatchObject({
      taskId: expect.stringMatching(/^task-[a-z0-9]{6}$/),
      command: "/opt/homebrew/bin/opencode",
      args: [
        "--model",
        "opencode-go/deepseek-v4-flash",
      ],
      cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      model: "opencode-go/deepseek-v4-flash",
      requirePty: true,
    });
    expect(JSON.stringify(startPtyInputs[0].env ?? {})).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_URL");
    expect(JSON.stringify(startPtyInputs[0].env ?? {})).toContain("AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN");
    expect(JSON.stringify(startPtyInputs[0].runtimeFiles ?? [])).toContain("Use call_session to assign session-level work");
    expect(JSON.stringify(startPtyInputs[0].runtimeFiles ?? [])).toContain("Use read_task_state");
    expect(JSON.stringify(startPtyInputs[0].runtimeFiles ?? [])).toContain("task-intake-001-researcher");
    expect(JSON.stringify(startPtyInputs[0].runtimeFiles ?? [])).not.toContain("Workspace Session Message");
    await waitFor(() => expect(writePtyInputs).toHaveLength(1));
    expect(writePtyInputs[0].id).toBe(conductorSessionId);
    expect(writePtyInputs[0].text).toContain("Start this Agent Workspace task now.");
    expect(writePtyInputs[0].text).toContain("调研claude dynamic workflow 的机制");
    expect(writePtyInputs[0].text).toContain("task-intake-001-researcher");
    expect(writePtyInputs[0].text).toContain("Use call_session when a worker should do work");
    expect(writePtyInputs[0].text).toContain("After call_session returns ok true, end this Conductor turn");
    expect(writePtyInputs[0].text).toContain("wait for a runtime wakeup");
    expect(writePtyInputs[0].text).not.toContain("delivered or queued");
    expect(writePtyInputs[0].text).not.toContain("call_session does not force this turn to end");
    expect(writePtyInputs[0].text).not.toContain("Workspace Session Message");
  });

  it("attaches worker PTY sessions started by the Conductor bridge to the matching agent card", async () => {
    const sessionsById = new Map<string, NativePtySession>();
    const ptyEventCallbacks: Array<(event: NativePtyEvent) => void> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          const session: NativePtySession = {
            id: input.id ?? "native-session",
            taskId: input.taskId,
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            stdin: input.stdin,
            transcript: [`booting ${input.id}\n`],
            cursor: 1,
          };
          sessionsById.set(session.id, session);
          return session;
        },
        getPty: async (input) => sessionsById.get(input.id),
        writePty: async (input) => sessionsById.get(input.id),
        onPtyEvent: (callback) => {
          ptyEventCallbacks.push(callback);
          return () => {
            ptyEventCallbacks.splice(ptyEventCallbacks.indexOf(callback), 1);
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({
      title: "Claude Dynamic Workflow 机制调研",
      summary: "调研 Claude Dynamic Workflow 并输出 research/spec/plan 线索。",
      templateId: "research",
      labels: "research, claude",
    });

    await waitFor(() => expect(sessionsById.size).toBeGreaterThan(0));
    const conductorSessionId = [...sessionsById.keys()].find((id) => id.endsWith("task-intake-001-conductor")) ?? "";
    expectConductorRuntimeSessionId(conductorSessionId);
    const runtimeTaskId = sessionsById.get(conductorSessionId)?.taskId;
    const researcherSessionId = conductorSessionId.replace(/task-intake-001-conductor$/, "task-intake-001-researcher");
    expectWorkerRuntimeSessionId(researcherSessionId, "researcher");
    sessionsById.set(researcherSessionId, {
      id: researcherSessionId,
      taskId: runtimeTaskId,
      command: "opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      model: "opencode-go/deepseek-v4-flash",
      backend: "pty",
      status: "running",
      cols: 100,
      rows: 30,
      transcript: ["Researcher session started by bridge\n"],
      cursor: 1,
    });
    ptyEventCallbacks.forEach((callback) =>
      callback({
        type: "data",
        id: researcherSessionId,
        chunk: "Researcher session started by bridge\n",
        cursor: 1,
      }),
    );

    const workersPanel = await screen.findByRole("heading", { level: 2, name: "Worker Agents" });
    await waitFor(() =>
      expect(workersPanel.closest("section")?.textContent).toMatch(/Researcher[\s\S]*Evidence collector[\s\S]*working/),
    );
  });

  it("does not route worker terminal protocol text through the App anymore", async () => {
    const writePtyInputs: Array<{ id: string; text: string }> = [];
    const ptyEventCallbacks: Array<(event: NativePtyEvent) => void> = [];

    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          queueMicrotask(() => {
            ptyEventCallbacks.forEach((callback) =>
              callback({
                type: "data",
                id: input.id ?? "native-session",
                chunk: 'Ask anything... "Fix a TODO in the codebase"\ntab agents  ctrl+p commands\n',
                cursor: 2,
              }),
            );
          });
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
            cursor: 1,
          };
        },
        writePty: async (input) => {
          writePtyInputs.push(input);
          return {
            id: input.id,
            command: "opencode",
            args: [],
            cwd: "/Users/dinker/CODES/TEMP_project/Agent_Test",
            backend: "pty",
            status: "running",
            cols: 100,
            rows: 30,
            transcript: [],
            cursor: 1,
          };
        },
        onPtyEvent: (callback) => {
          ptyEventCallbacks.push(callback);
          return () => {
            ptyEventCallbacks.splice(ptyEventCallbacks.indexOf(callback), 1);
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({
      title: "Claude Dynamic Workflow 机制调研",
      summary: "调研 Claude Dynamic Workflow 并输出 research/spec/plan 线索。",
      templateId: "research",
      labels: "research, claude",
    });
    await waitFor(() => expect(writePtyInputs).toHaveLength(1));
    writePtyInputs.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    fireEvent.click(screen.getByRole("button", { name: /Researcher.*Evidence collector.*idle/ }));
    fireEvent.click(await screen.findByRole("button", { name: "启动 opencode PTY" }));
    const researcherSessionLine = await screen.findByText(/^session .*researcher/);
    const researcherSessionId = sessionIdFromTranscriptLine(researcherSessionLine.textContent ?? "");
    expectWorkerRuntimeSessionId(researcherSessionId, "researcher");
    ptyEventCallbacks.forEach((callback) =>
      callback({
        type: "data",
        id: researcherSessionId,
        chunk:
          '<agent-workspace-message>{"toSessionId":"task-intake-001-reviewer","body":"legacy route"}</agent-workspace-message>',
        cursor: 8,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writePtyInputs).toHaveLength(0);
  });

  it("does not call native PTY start twice for the same selected task agent while start is pending or running", async () => {
    const startPtyInputs: Array<{ id?: string; command: string; args?: string[]; cwd: string; model?: string }> = [];
    let resolveStart: (session: NativePtySession) => void = () => undefined;

    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          return new Promise<NativePtySession>((resolve) => {
            resolveStart = resolve;
          });
        },
        getPty: async () => undefined,
      },
    };

    render(<App />);

    createRuntimeTask({ title: "Guard duplicate same-key PTY starts" });
    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));

    const startButton = await screen.findByRole("button", { name: "启动 opencode PTY" });
    await waitFor(() => expect(startButton).toHaveProperty("disabled", false));
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    expect(startPtyInputs).toHaveLength(1);

    resolveStart({
      id: startPtyInputs[0].id ?? "native-session",
      command: startPtyInputs[0].command,
      args: startPtyInputs[0].args ?? [],
      cwd: startPtyInputs[0].cwd,
      model: startPtyInputs[0].model,
      backend: "pty",
      status: "running",
      cols: 100,
      rows: 30,
      stdin: "pipe",
      transcript: ["native session running\n"],
      cursor: 1,
    });

    expect(await screen.findByText("native session running")).toBeTruthy();
    const runningButton = screen.getByRole("button", { name: "PTY 运行中" });
    expect(runningButton).toHaveProperty("disabled", true);
    fireEvent.click(runningButton);

    expect(startPtyInputs).toHaveLength(1);
  });

  it("starts the current task Conductor from Task Home even after Executor is selected", async () => {
    const startPtyInputs: Array<{ id?: string; args?: string[] }> = [];
    const writePtyInputs: Array<{ id: string; text: string }> = [];
    const ptyEventCallbacks: Array<(event: NativePtyEvent) => void> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          if (input.id?.endsWith("task-intake-001-conductor")) {
            queueMicrotask(() => {
              ptyEventCallbacks.forEach((callback) =>
                callback({
                  type: "data",
                  id: input.id ?? "native-session",
                  chunk: 'Ask anything... "Fix a TODO in the codebase"\ntab agents  ctrl+p commands\n',
                  cursor: 2,
                }),
              );
            });
          }
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
          };
        },
        writePty: async (input) => {
          writePtyInputs.push(input);
          return {
            id: input.id,
            command: "opencode",
            args: [],
            cwd: "/Users/dinker/CODES/Agent-Workspace",
            backend: "pty",
            status: "running",
            cols: 100,
            rows: 30,
            transcript: [],
            cursor: 1,
          };
        },
        onPtyEvent: (callback) => {
          ptyEventCallbacks.push(callback);
          return () => {
            ptyEventCallbacks.splice(ptyEventCallbacks.indexOf(callback), 1);
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({ title: "Keep Task Home Conductor explicit" });
    await waitFor(() => expect(startPtyInputs).toHaveLength(1));
    const conductorSessionId = startPtyInputs[0].id ?? "";
    expectConductorRuntimeSessionId(conductorSessionId);
    expect(startPtyInputs.map((input) => input.id)).toEqual([conductorSessionId]);
    await waitFor(() => expect(writePtyInputs).toHaveLength(1));
    expect(writePtyInputs[0].id).toBe(conductorSessionId);
    expect(writePtyInputs[0].text).toContain("Start this Agent Workspace task now.");
    writePtyInputs.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    fireEvent.click(screen.getByRole("button", { name: /Executor.*Code implementation.*idle/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Executor 对话 Terminal" })).toBeTruthy();
    const executorStartButton = await screen.findByRole("button", { name: "启动 opencode PTY" });
    fireEvent.click(executorStartButton);
    await waitFor(() => expect(startPtyInputs).toHaveLength(2));
    const executorRunningButton = await screen.findByRole("button", { name: "PTY 运行中" });
    expect(executorRunningButton).toHaveProperty("disabled", true);
    fireEvent.click(executorRunningButton);
    expect(startPtyInputs).toHaveLength(2);
    const executorSessionId = startPtyInputs[1].id ?? "";
    expectWorkerRuntimeSessionId(executorSessionId, "executor");

    fireEvent.click(screen.getByRole("button", { name: "任务主页" }));
    expect(screen.queryByText(new RegExp(`^session ${escapeRegExp(executorSessionId)}`))).toBeNull();
    expect(screen.getByRole("button", { name: "Conductor 运行中" })).toBeTruthy();
    expect(startPtyInputs[0].id).not.toContain("executor");
    expect(startPtyInputs[0].args).toEqual([
      "--model",
      "opencode-go/deepseek-v4-flash",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "任务主页" }));
    expect(writePtyInputs).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    fireEvent.click(screen.getByRole("button", { name: "选择 Executor agent" }));
    fireEvent.click(screen.getByRole("button", { name: "任务主页" }));
    expect(startPtyInputs[0].id).toBe(conductorSessionId);

    expect(screen.queryByLabelText("发送给 Conductor")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  });

  it("keeps native opencode binding controls out of the primary Workbench while preserving task-scoped launches", async () => {
    const startPtyInputs: Array<{ id?: string; args?: string[] }> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [{ name: "build-agent", kind: "primary" }] }),
        startPty: async (input) => {
          startPtyInputs.push(input);
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({ title: "Bind native opencode agent for Executor" });
    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    fireEvent.click(screen.getByRole("button", { name: /Executor.*Code implementation.*idle/ }));
    expect(await screen.findByRole("heading", { level: 2, name: "Executor 对话 Terminal" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /运行详情/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "build-agent primary" })).toBeNull();
    expect(screen.getByLabelText("Agent 启动命令预览").textContent).toBe(
      "opencode --model opencode-go/deepseek-v4-flash",
    );
    const startButton = await screen.findByRole("button", { name: "启动 opencode PTY" });
    await waitFor(() => expect(startButton).toHaveProperty("disabled", false));
    fireEvent.click(startButton);

    await waitFor(() => expect(startPtyInputs).toHaveLength(2));
    expectWorkerRuntimeSessionId(startPtyInputs[1].id, "executor");
    expect(startPtyInputs[1].args).toEqual([
      "--model",
      "opencode-go/deepseek-v4-flash",
    ]);
  });

  it("keeps Workbench scoped to the selected task agent cluster", () => {
    render(<App />);

    createRuntimeTask({ title: "实现 task cluster selection" });

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    fireEvent.click(screen.getByRole("button", { name: /Executor.*Code implementation.*idle/ }));

    expect(screen.getByRole("heading", { level: 2, name: "Executor 对话 Terminal" })).toBeTruthy();
    expect(screen.getByLabelText("Agent 启动命令预览").textContent).toBe(
      "opencode --model opencode-go/deepseek-v4-flash",
    );
  });

  it("keeps native PTY sessions task-scoped when switching tasks for the same agent", async () => {
    const startedSessionIds: string[] = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          startedSessionIds.push(input.id ?? "");
          return {
            id: input.id ?? "native-session",
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: [`session ${input.id}\n`],
          };
        },
        getPty: async () => undefined,
      },
    };

    render(<App />);

    createRuntimeTask({ title: "监听 docs 产品意图变化并创建 planner task" });
    await waitFor(() => expect(startedSessionIds).toHaveLength(1));
    createRuntimeTask({ title: "Prompt Library 和 Skills Library 的注入路径" });
    await waitFor(() => expect(startedSessionIds).toHaveLength(2));

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /当前任务.*展开/ }));
    const firstTaskChoices = screen.getAllByRole("button", {
      name: /监听 docs 产品意图变化并创建 planner task/,
    });
    fireEvent.click(firstTaskChoices[firstTaskChoices.length - 1]);

    expect(await screen.findByText(/^session .*task-intake-001/)).toBeTruthy();

    const secondTaskChoices = screen.getAllByRole("button", { name: /Prompt Library 和 Skills Library 的注入路径/ });
    fireEvent.click(secondTaskChoices[secondTaskChoices.length - 1]);
    expect(await screen.findByText(/^session .*task-intake-002/)).toBeTruthy();

    const reopenedFirstTaskChoices = screen.getAllByRole("button", {
      name: /监听 docs 产品意图变化并创建 planner task/,
    });
    fireEvent.click(reopenedFirstTaskChoices[reopenedFirstTaskChoices.length - 1]);

    expect(screen.getByText(/^session .*task-intake-001/)).toBeTruthy();
    expect(screen.queryByText(/^session .*task-intake-002/)).toBeNull();

    expect(startedSessionIds[0]).toContain("task-intake-001");
    expect(startedSessionIds[1]).toContain("task-intake-002");
    expect(startedSessionIds[0]).not.toBe(startedSessionIds[1]);
  });

  it("attaches stopped native PTY deltas with merged transcript evidence", async () => {
    const ptyEventCallbacks: Array<(event: NativePtyEvent) => void> = [];
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          const id = input.id ?? "native-session";
          queueMicrotask(() => {
            ptyEventCallbacks.forEach((callback) => {
              callback({
                type: "data",
                id,
                chunk: "done\n",
                cursor: 2,
              });
              callback({
                type: "exit",
                id,
                status: "stopped",
                exitCode: 0,
                signal: 0,
                cursor: 2,
              });
            });
          });
          return {
            id,
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            model: input.model,
            backend: "pty",
            status: "running",
            cols: 100,
            rows: 30,
            transcript: ["start\n"],
            cursor: 1,
          };
        },
        getPty: async (input) => ({
          id: input.id,
          command: "opencode",
          args: [],
          cwd: "/Users/dinker/CODES/Agent-Workspace",
          backend: "pty",
          status: "stopped",
          cols: 100,
          rows: 30,
          transcript: ["start\n", "done\n"],
          cursor: 2,
          exitCode: 0,
        }),
        onPtyEvent: (callback) => {
          ptyEventCallbacks.push(callback);
          return () => {
            ptyEventCallbacks.splice(ptyEventCallbacks.indexOf(callback), 1);
          };
        },
      },
    };

    render(<App />);

    createRuntimeTask({ title: "Merge stopped native PTY evidence" });
    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    const startButton = await screen.findByRole("button", { name: "启动 opencode PTY" });
    await waitFor(() => expect(startButton).toHaveProperty("disabled", false));
    fireEvent.click(startButton);

    expect(await screen.findByText("done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "交付门禁" }));
    fireEvent.click(screen.getByRole("button", { name: "打开 Runs" }));

    expect(await screen.findByText((_content, element) => element?.tagName === "PRE" && element.textContent === "start\ndone")).toBeTruthy();
  });

  it("keeps the rendered terminal transcript when write returns metadata-only PTY state", async () => {
    let activeSessionId = "";
    window.agentWorkspace = {
      native: {
        getRuntimeStatus: async () => desktopReadyStatus(),
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode",
          cwd: input.cwd,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
        listOpencodeAgents: async () => ({ ok: true, agents: [] }),
        startPty: async (input) => {
          activeSessionId = input.id ?? "";
          return {
            id: activeSessionId,
            command: input.command,
            args: input.args ?? [],
            cwd: input.cwd,
            backend: "pty",
            status: "running",
            cols: input.cols ?? 100,
            rows: input.rows ?? 30,
            transcript: ["opencode ready\n"],
            cursor: 1,
          };
        },
        readPty: async () => undefined,
        writePty: async (input) => ({
          id: input.id,
          command: "opencode",
          args: [],
          cwd: "/tmp/project",
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: [],
          cursor: 1,
        }),
      },
    };

    render(<App />);

    createRuntimeTask({ title: "保持 PTY transcript" });

    fireEvent.click(screen.getByRole("button", { name: "IDE 工作台" }));
    const runningButton = await screen.findByRole("button", { name: "PTY 运行中" });
    expect(runningButton).toHaveProperty("disabled", true);

    expect(await screen.findByText("opencode ready")).toBeTruthy();

    expect(screen.queryByLabelText("Agent terminal input")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送到 terminal" })).toBeNull();
    expect(activeSessionId).toContain("task-intake-001");
    expect(screen.getByText("opencode ready")).toBeTruthy();
  });
});
