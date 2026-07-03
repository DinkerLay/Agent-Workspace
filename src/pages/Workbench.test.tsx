/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { initialPrototypeState } from "../mock/prototypeData";
import type { NativePtySession, NativeRuntimeStatus } from "../runtime/nativeBridge";
import { Workbench } from "./Workbench";

afterEach(() => {
  cleanup();
});

type WorkbenchProps = ComponentProps<typeof Workbench>;

const selectedProject = initialPrototypeState.projects.find(
  (project) => project.id === initialPrototypeState.selectedProjectId,
)!;
const selectedCluster = initialPrototypeState.agentClusters.find(
  (cluster) => cluster.id === initialPrototypeState.selectedAgentClusterId,
)!;
const selectedAgent = initialPrototypeState.agents.find(
  (agent) => agent.id === initialPrototypeState.selectedAgentId,
)!;
const selectedTask = initialPrototypeState.tasks.find(
  (task) => task.id === initialPrototypeState.selectedTaskId,
)!;
const selectedRun = initialPrototypeState.runs.find((run) => run.taskId === selectedTask.id);

const nativeRuntimeStatus: NativeRuntimeStatus = {
  available: true,
  mode: "desktop",
  opencodePath: "/opt/homebrew/bin/opencode",
  opencodeVersion: "1.17.9",
  ptyAvailable: true,
  ptyBackend: "node-pty+process-fallback",
  message: "opencode ready",
};

function renderWorkbenchDefaults(): WorkbenchProps {
  return {
    agents: initialPrototypeState.agents,
    agentClusters: initialPrototypeState.agentClusters,
    prompt: initialPrototypeState.prompt,
    runtimeEvents: initialPrototypeState.runtimeEvents,
    scratchpadAttachmentIds: initialPrototypeState.scratchpadAttachmentIds,
    scratchpadDraftPath: initialPrototypeState.scratchpadDraftPath,
    scratchpadItems: initialPrototypeState.scratchpadItems,
    scratchpadSavedAt: initialPrototypeState.scratchpadSavedAt,
    selectedProject,
    selectedAgent,
    selectedAgentCluster: selectedCluster,
    selectedAgentClusterId: selectedCluster.id,
    selectedAgentId: selectedAgent.id,
    selectedRun,
    selectedTask,
    tasks: initialPrototypeState.tasks,
    terminalEvents: initialPrototypeState.terminalEvents,
    terminalLines: initialPrototypeState.terminalLines,
    nativeRuntimeStatus,
    agentLaunchCommand: `opencode --model ${selectedAgent.model}`,
    defaultAgentLaunchCommand: `opencode --model ${selectedAgent.model}`,
    onAgentClaimsDone: () => undefined,
    onApplyTerminalSignal: () => undefined,
    onAttachScratchpadArtifact: () => undefined,
    onInsertScratchpadItem: () => undefined,
    onPromptChange: () => undefined,
    onResetAgentLaunchCommand: () => undefined,
    onSaveScratchpadDraft: () => undefined,
    onSelectAgent: () => undefined,
    onSelectAgentCluster: () => undefined,
    onSelectTask: () => undefined,
    onSendPrompt: () => undefined,
  };
}

function renderWorkbench(overrides: Partial<WorkbenchProps> = {}) {
  const props: WorkbenchProps = {
    ...renderWorkbenchDefaults(),
    ...overrides,
  };

  return render(<Workbench {...props} />);
}

describe("Workbench", () => {
  it("defaults to a conversation-first IDE layout without showing old mock transcript content", () => {
    const { container } = renderWorkbench();

    expect(container.querySelector(".conversation-workbench.details-collapsed.agents-open")).toBeTruthy();
    expect(container.querySelector(".conversation-agent-panel.session-nav-panel")).toBeTruthy();
    expect(container.querySelector(".session-project-switcher")).toBeTruthy();
    expect(container.querySelector(".cluster-switcher.task-switcher")).toBeTruthy();
    expect(screen.getByLabelText("任务列表")).toBeTruthy();
    expect(screen.queryByText("Project Runtime")).toBeNull();
    expect(screen.queryByText("FirstTask")).toBeNull();
    expect(container.querySelector(".agent-session-list")).toBeTruthy();
    expect(container.querySelector(".current-task-row")).toBeTruthy();
    expect(container.querySelector(".task-progress-panel")).toBeTruthy();
    expect(container.querySelector(".task-progress-counts")).toBeTruthy();
    expect(container.querySelector(".task-progress-track")).toBeNull();
    expect(container.querySelector(".compact-project-card")).toBeNull();
    expect(container.querySelector(".task-stack")).toBeNull();
    expect(container.querySelector(".runtime-details-rail")).toBeNull();
    expect(screen.getByRole("button", { name: "收起左侧 Agent 导航" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Agent 列表仅当前/ })).toHaveProperty("ariaExpanded", "false");
    expect(screen.getByRole("button", { name: /当前任务.*展开/ })).toHaveProperty("ariaExpanded", "false");
    expect(screen.getByText("当前任务进度")).toBeTruthy();
    expect(screen.getByRole("heading", { name: `${selectedAgent.name} 对话 Terminal` })).toBeTruthy();
    expect(screen.getByText("尚未启动当前 Agent terminal。")).toBeTruthy();
    expect(screen.getByText(/打开交互式 opencode TUI/)).toBeTruthy();
    expect(screen.getAllByText(`opencode --model ${selectedAgent.model}`).length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".terminal-context-line")).toBeTruthy();
    expect(screen.getByLabelText("Agent 启动命令预览").textContent).toBe(`opencode --model ${selectedAgent.model}`);
    expect(screen.queryByText(/opencode run --format json.*--agent/)).toBeNull();
    expect(screen.queryByText("Command")).toBeNull();
    expect(screen.queryByText("CWD")).toBeNull();
    expect(screen.queryByText("Permission")).toBeNull();
    expect(screen.getByRole("button", { name: "启动 opencode PTY" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "GOAL 完成" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "等待 PTY" })).toBeNull();
    expect(screen.queryByLabelText("Agent terminal input")).toBeNull();
    expect(screen.queryByText(/shell mock/i)).toBeNull();
    expect(screen.queryByText(/waiting for user input/i)).toBeNull();
    expect(screen.queryByText("Native Runtime")).toBeNull();
    expect(screen.queryByText("Scratchpad / Composer")).toBeNull();
    expect(screen.queryByText("Runtime adapter events")).toBeNull();
  });

  it("labels Conductor as orchestration center and workers as provider-native terminals", () => {
    const conductor = {
      ...selectedAgent,
      id: "task-1-conductor",
      name: "Conductor",
      role: "Research coordinator",
      status: "working" as const,
      taskId: selectedTask.id,
    };
    const researcher = {
      ...selectedAgent,
      id: "task-1-researcher",
      name: "Researcher",
      role: "Evidence collector",
      status: "idle" as const,
      taskId: selectedTask.id,
    };
    const cluster = {
      ...selectedCluster,
      agentIds: [conductor.id, researcher.id],
    };

    const { rerender } = renderWorkbench({
      agents: [conductor, researcher],
      selectedAgent: conductor,
      selectedAgentId: conductor.id,
      selectedAgentCluster: cluster,
    });

    expect(screen.getAllByText("Conductor 工具").length).toBeGreaterThan(0);
    expect(screen.getByText("call_session")).toBeTruthy();
    expect(screen.getByText("read_task_state")).toBeTruthy();
    expect(screen.getByText("read_session")).toBeTruthy();
    expect(screen.queryByText("finish_task_claim")).toBeNull();
    expect(screen.getByText("任务负责人，通过 MCP tools 调度和读取其他 session")).toBeTruthy();

    rerender(
      <Workbench
        {...renderWorkbenchDefaults()}
        agents={[conductor, researcher]}
        selectedAgent={researcher}
        selectedAgentId={researcher.id}
        selectedAgentCluster={cluster}
      />,
    );

    expect(screen.getAllByText("Worker sessions 保持原生").length).toBeGreaterThan(0);
    expect(screen.getByText("PTY 只提供生命周期；语义状态来自 provider adapter")).toBeTruthy();
  });

  it("lets the left rail, agent list, and task context collapse and expand independently", () => {
    const selectedAgents: string[] = [];
    const selectedTasks: string[] = [];
    const { container } = renderWorkbench({
      onSelectAgent: (agentId) => selectedAgents.push(agentId),
      onSelectTask: (taskId) => selectedTasks.push(taskId),
    });

    expect(screen.queryByRole("button", { name: /Executor.*Implementation.*idle/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起左侧 Agent 导航" }));
    expect(container.querySelector(".conversation-workbench.agents-collapsed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开左侧 Agent 导航" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "展开左侧 Agent 导航" }));
    fireEvent.click(screen.getByRole("button", { name: /Agent 列表仅当前/ }));
    expect(screen.getByRole("button", { name: /Executor.*Implementation.*idle/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Executor.*Implementation.*idle/ }));

    fireEvent.click(screen.getByRole("button", { name: /当前任务.*展开/ }));
    expect(screen.getAllByText("按 Agent 归因 changed files 并保存 commit context").length).toBeGreaterThan(0);
    const taskButtons = screen.getAllByRole("button", {
      name: /按 Agent 归因 changed files 并保存 commit context/,
    });
    fireEvent.click(taskButtons[taskButtons.length - 1]);

    expect(selectedAgents).toEqual(["executor"]);
    expect(selectedTasks).toEqual(["task-review"]);
  });

  it("lets compact task progress agent indicators select the target agent", () => {
    const selectedAgents: string[] = [];
    renderWorkbench({
      onSelectAgent: (agentId) => selectedAgents.push(agentId),
    });

    fireEvent.click(screen.getByRole("button", { name: "选择 Executor agent" }));

    expect(selectedAgents).toEqual(["executor"]);
  });

  it("uses the center terminal as the selected agent conversation and leaves typing to the PTY", () => {
    const nativeSessionActions: string[] = [];
    const nativePtySession: NativePtySession = {
      id: "native-task-pty",
      command: "/opt/homebrew/bin/opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      model: "opencode-go/deepseek-v4-flash",
      backend: "process",
      status: "running",
      cols: 100,
      rows: 30,
      stdin: "pipe",
      transcript: [
        "opencode tui started\n",
        "等待你的下一句输入。\n",
      ],
    };

    renderWorkbench({
      nativePtySession,
      onStartNativePty: () => nativeSessionActions.push("start"),
      onRefreshNativePty: () => nativeSessionActions.push("refresh"),
      onStopNativePty: () => nativeSessionActions.push("stop"),
    });

    expect(screen.getByText("opencode tui started")).toBeTruthy();
    expect(screen.getByText("等待你的下一句输入。")).toBeTruthy();
    expect(screen.queryByLabelText("Agent terminal input")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送到 terminal" })).toBeNull();

    const runningStartButton = screen.getByRole("button", { name: "PTY 运行中" });
    expect(runningStartButton).toHaveProperty("disabled", true);
    fireEvent.click(runningStartButton);
    fireEvent.click(screen.getByRole("button", { name: "refresh terminal session" }));
    fireEvent.click(screen.getByRole("button", { name: "stop terminal session" }));

    expect(nativeSessionActions).toEqual(["refresh", "stop"]);
  });

  it("does not derive Agent card state from terminal transcript text", () => {
    const choicePromptSession: NativePtySession = {
      id: "native-choice-pty",
      command: "/opt/homebrew/bin/opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      model: "opencode-go/deepseek-v4-flash",
      backend: "pty",
      status: "running",
      cols: 100,
      rows: 30,
      stdin: "pipe",
      transcript: [
        "\u001b[?1049h",
        "Permission required\n",
        "Allow this command?  Yes / No  Press Enter to confirm, Esc to cancel\n",
      ],
    };

    const { container } = renderWorkbench({ nativePtySession: choicePromptSession });

    expect(container.querySelector(".terminal-choice-attention")).toBeNull();
    expect(container.querySelector(".agent-choice-attention")).toBeNull();
    expect(screen.queryAllByText("需要选择")).toHaveLength(0);
  });

  it("shows a read-only launch command preview without exposing right-rail runtime binding controls", () => {
    const resets: number[] = [];

    renderWorkbench({
      onResetAgentLaunchCommand: () => resets.push(1),
    });

    expect(screen.queryByLabelText("Agent 启动命令")).toBeNull();
    expect(screen.getByLabelText("Agent 启动命令预览").textContent).toBe(
      "opencode --model opencode-go/deepseek-v4-flash",
    );

    expect(screen.queryByRole("button", { name: /运行详情/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /plan primary/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新本机 Agent 列表" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "默认" }));

    expect(resets).toEqual([1]);
  });

  it("keeps runtime diagnostics out of the primary Workbench surface", () => {
    renderWorkbench();

    expect(screen.queryByRole("button", { name: /运行详情/ })).toBeNull();
    expect(screen.queryByText("运行摘要")).toBeNull();
    expect(screen.queryByText("当前 Agent")).toBeNull();
    expect(screen.queryByText("权限提示")).toBeNull();
    expect(screen.queryByText("审计线索")).toBeNull();
    expect(screen.queryByText("最近一次试跑")).toBeNull();
    expect(screen.queryByText("Exit 0 · 42ms")).toBeNull();
    expect(screen.queryByRole("button", { name: "检测 opencode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "一次性试跑" })).toBeNull();
    expect(screen.queryByText("Native Runtime")).toBeNull();
    expect(screen.queryByText("Scratchpad / Composer")).toBeNull();
    expect(screen.queryByText("Git / Review")).toBeNull();
    expect(screen.queryByText("Terminal Event Parser")).toBeNull();
    expect(screen.queryByText("Parser signals")).toBeNull();
    expect(screen.queryByText("Runtime events")).toBeNull();
  });
});
