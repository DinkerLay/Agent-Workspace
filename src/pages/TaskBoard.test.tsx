/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Bot, Search, ShieldCheck, Workflow } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialPrototypeState } from "../mock/prototypeData";
import type { ReadTaskStateResult } from "../orchestration/conductor-tools";
import type { NativePtySession } from "../runtime/nativeBridge";
import { createOpencodeSessionKey, getProjectRuntimeId, getTaskRuntimeId } from "../runtime/opencode";
import { TaskBoard } from "./TaskBoard";

afterEach(cleanup);

function baseProps() {
  const state = initialPrototypeState;
  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId) ?? state.tasks[0];
  const selectedProject =
    state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];
  const selectedAgentCluster =
    state.agentClusters.find((cluster) => cluster.id === state.selectedAgentClusterId) ?? state.agentClusters[0];
  const selectedAgent = state.agents.find((agent) => agent.id === state.selectedAgentId) ?? state.agents[0];

  return {
    agents: state.agents,
    agentClusters: state.agentClusters,
    tasks: state.tasks,
    runs: state.runs,
    selectedProject,
    selectedAgentCluster,
    selectedAgent,
    selectedTask,
    selectedTaskId: selectedTask.id,
    taskIntakeEvents: state.taskIntakeEvents,
    taskTransitionEvents: state.taskTransitionEvents,
    loopStages: [
      { label: "Research / Spec", state: "watching", detail: "durable product intent", icon: Search },
      { label: "Planner", state: "running", detail: "plan steps", icon: Workflow },
      { label: "Executor", state: "queued", detail: "agent run", icon: Bot },
      { label: "Review Gate", state: "blocked until verified", detail: "review", icon: ShieldCheck },
    ],
    nativeRuntimeStatus: {
      available: true,
      mode: "desktop" as const,
      message: "desktop runtime ready",
      ptyAvailable: true,
      ptyBackend: "pty",
    },
    agentLaunchCommand: "opencode --model opencode-go/deepseek-v4-flash",
    onGenerateTaskDraft: async () => ({
      ok: false,
      assistantMessage: "draft assistant unavailable",
      missingFields: [],
      assumptions: [],
      error: "not configured",
    }),
    onCreateTaskFromIntake: () => undefined,
    onOpenRuntimeProject: () => undefined,
    onSelectTask: () => undefined,
    onAdvance: () => undefined,
    onStartAgent: () => undefined,
    onOpenLoops: () => undefined,
    onStartConductorPty: () => undefined,
    onRefreshConductorPty: () => undefined,
    onWriteConductorPtyData: () => undefined,
    onStopConductorPty: () => undefined,
    onOpenAgentTerminal: () => undefined,
  };
}

function creationProps() {
  return { ...baseProps(), tasks: [], selectedTask: undefined, selectedTaskId: "" };
}

describe("TaskBoard Task Home", () => {
  it("renders the built Task page as a compact execution conversation instead of a Terminal page", () => {
    const ptySession: NativePtySession = {
      id: "native-project-agent-workspace-cluster-agent-workspace-firsttask-planner-task-plan-watch",
      command: "opencode",
      args: ["--model", "opencode-go/deepseek-v4-flash"],
      cwd: "/Users/dinker/CODES/Agent-Workspace",
      model: "opencode-go/deepseek-v4-flash",
      backend: "pty",
      status: "running",
      cols: 100,
      rows: 30,
      stdin: "pipe",
      transcript: [
        "$ opencode --model opencode-go/deepseek-v4-flash",
        "Conductor: 正在读取 Reviewer 挑战并调度 Planner。",
      ],
    };

    const props = baseProps();
    render(<TaskBoard {...props} nativePtySession={ptySession} />);

    expect(screen.getByText("任务描述")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "执行过程" })).toBeTruthy();
    expect(screen.getByText("任务发起")).toBeTruthy();
    expect(screen.getByText("message to Conductor")).toBeTruthy();
    expect(screen.getByText("分析输出")).toBeTruthy();
    expect(screen.getByText("output message")).toBeTruthy();
    expect(screen.getAllByText("agent_session_call").length).toBeGreaterThan(0);
    expect(screen.getByText(/Conductor -> Executor/)).toBeTruthy();
    expect(screen.getByText("实现结果")).toBeTruthy();
    expect(screen.getByText("result message")).toBeTruthy();
    expect(screen.getByText("Selected Agent")).toBeTruthy();
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Goal" })).toBeTruthy();
    expect(screen.queryByText("Conductor Terminal")).toBeNull();
    expect(screen.queryByText(ptySession.id)).toBeNull();
    expect(screen.queryByText("Conductor: 正在读取 Reviewer 挑战并调度 Planner。")).toBeNull();
    expect(screen.queryByText("Worker Agents")).toBeNull();
    expect(screen.queryByText("当前任务摘要")).toBeNull();
    expect(screen.queryByText("看板优先 · Loop 可见 · IDE 下钻")).toBeNull();
  });

  it("sends bottom composer messages to the Conductor PTY and keeps stop/goal actions available", () => {
    const props = baseProps();
    const writes: string[] = [];
    const stopConductor = vi.fn();
    const advance = vi.fn();

    render(
      <TaskBoard
        {...props}
        nativePtySession={{
          id: "native-conductor-session",
          command: "opencode",
          args: ["--model", "opencode-go/deepseek-v4-flash"],
          cwd: props.selectedProject.path,
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: ["ready"],
        }}
        onAdvance={advance}
        onWriteConductorPtyData={(data) => writes.push(data)}
        onStopConductorPty={stopConductor}
      />,
    );

    fireEvent.change(screen.getByLabelText("发送给 Conductor"), {
      target: { value: "重新派发给 Executor，但保留 output 和 agent_session_call 的区分。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    fireEvent.click(screen.getByRole("button", { name: "Goal" }));

    expect(writes).toEqual(["重新派发给 Executor，但保留 output 和 agent_session_call 的区分。\n"]);
    expect(stopConductor).toHaveBeenCalledTimes(1);
    expect(advance).toHaveBeenCalledWith(props.selectedTask.id);
    expect((screen.getByLabelText("发送给 Conductor") as HTMLTextAreaElement).value).toBe("");
  });

  it("switches the right details panel when a session agent is selected", () => {
    const props = baseProps();

    render(<TaskBoard {...props} />);

    expect(screen.getByText("Selected Agent")).toBeTruthy();
    expect(screen.getAllByText("Plan keeper").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Executor Implementation/ }));

    expect(screen.getAllByText("Implementation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider").length).toBeGreaterThan(0);
    expect(screen.getAllByText("opencode").length).toBeGreaterThan(0);
    expect(screen.getAllByText("agent_session_call").length).toBeGreaterThan(0);
  });

  it("renders Markdown content inside execution cards", () => {
    const props = baseProps();
    const { container } = render(<TaskBoard {...props} />);

    expect(container.querySelector(".execution-md ul")).toBeTruthy();
    expect(container.querySelector(".execution-md pre code")).toBeTruthy();
    expect(screen.getByText("关键变化")).toBeTruthy();
  });

  it("renders backend task runtime state instead of local projected execution cards", () => {
    const props = baseProps();
    const taskId = getTaskRuntimeId(props.selectedTask);
    const executor = props.agents.find((agent) => agent.taskId === props.selectedTask.id && /executor/i.test(agent.id));
    const targetSessionId = createOpencodeSessionKey({
      projectId: getProjectRuntimeId(props.selectedProject),
      taskId,
      agentId: executor?.id ?? "task-intake-001-executor",
    });
    const taskRuntimeState: ReadTaskStateResult = {
      taskId,
      cursor: 5,
      events: [
        {
          id: "event-1",
          taskId,
          sessionId: "",
          type: "task.user_message",
          createdAt: "2026-07-06T00:00:00.000Z",
          cursor: 1,
          summary: "Task user message",
          data: {
            message: "后端记录的任务输入\n- 真实 Session Store",
          },
        },
        {
          id: "event-2",
          taskId,
          sessionId: targetSessionId,
          type: "dispatch.created",
          createdAt: "2026-07-06T00:00:01.000Z",
          cursor: 2,
          summary: "Dispatch A1B2C3 created",
          data: {
            dispatchId: "A1B2C3",
          },
        },
        {
          id: "event-3",
          taskId,
          sessionId: targetSessionId,
          type: "dispatch.result_available",
          createdAt: "2026-07-06T00:00:02.000Z",
          cursor: 3,
          summary: "Dispatch A1B2C3 result is available",
          data: {
            dispatchId: "A1B2C3",
            resultId: "result-A1B2C3",
          },
        },
      ],
      sessions: [],
      dispatches: [
        {
          dispatchId: "A1B2C3",
          taskId,
          toSessionId: targetSessionId,
          conductorSessionId: "conductor-session",
          assignment: "### 后端派发任务\n- 从 Session Store 渲染 agent_session_call",
          contextRefs: ["task/events.jsonl"],
          expectedOutput: "真实后端结果",
          priority: "normal",
          status: "result_available",
          createdAt: "2026-07-06T00:00:01.000Z",
          resultId: "result-A1B2C3",
        },
      ],
      results: [
        {
          resultId: "result-A1B2C3",
          dispatchId: "A1B2C3",
          sessionId: targetSessionId,
          answerPreview: "后端 worker 结果",
          createdAt: "2026-07-06T00:00:02.000Z",
        },
      ],
      messages: [
        {
          taskId,
          sessionId: targetSessionId,
          dispatchId: "A1B2C3",
          resultId: "result-A1B2C3",
          answerText: "### 后端 worker 结果\n```text\n.agent-workspace/runtime/task/events.jsonl\n```",
          answerPreview: "后端 worker 结果",
          source: "opencode-message-parts",
          createdAt: "2026-07-06T00:00:02.000Z",
        },
      ],
      pendingDecisions: [],
    };
    const { container } = render(<TaskBoard {...props} taskRuntimeState={taskRuntimeState} />);

    expect(screen.getByText("后端记录的任务输入")).toBeTruthy();
    expect(screen.getByText("后端派发任务")).toBeTruthy();
    expect(screen.getByText("后端 worker 结果")).toBeTruthy();
    expect(screen.getByText(/-> Executor/)).toBeTruthy();
    expect(container.querySelector(".execution-md pre code")?.textContent).toContain(".agent-workspace/runtime");
    expect(screen.queryByText("分析输出")).toBeNull();
    expect(screen.queryByText(/请让 .* 处理当前任务的实现部分/)).toBeNull();
  });

  it("does not render a second task sidebar inside Task Home", () => {
    const props = baseProps();
    const { container } = render(<TaskBoard {...props} />);

    expect(container.querySelector(".task-home-layout-empty")).toBeTruthy();
    expect(container.querySelector(".task-home-sidebar")).toBeNull();
    expect(screen.queryByLabelText("Task filters")).toBeNull();
    expect(screen.queryByLabelText("Tasks")).toBeNull();
    expect(screen.queryByRole("button", { name: "切换目录 Agent-Workspace" })).toBeNull();
  });

  it("does not reserve sidebar space when there are no tasks yet", () => {
    const props = baseProps();
    const { container } = render(<TaskBoard {...props} tasks={[]} selectedTask={undefined} selectedTaskId="" />);

    expect(container.querySelector(".task-home-layout-empty")).toBeTruthy();
    expect(container.querySelector(".task-home-sidebar")).toBeNull();
    expect(screen.getByText("任务描述")).toBeTruthy();
    expect(screen.getByText("AI 任务配置助手")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "新建任务" })).toBeNull();
    expect(screen.getByLabelText("任务标题")).toBeTruthy();
  });

  it("keeps task creation triggers out of the Task Home description panel", () => {
    const props = baseProps();
    const { container } = render(<TaskBoard {...props} tasks={[]} selectedTask={undefined} selectedTaskId="" />);
    const hero = container.querySelector(".task-home-hero");

    expect(hero).toBeTruthy();
    expect(within(hero as HTMLElement).queryByRole("button", { name: "新建任务" })).toBeNull();
    expect(screen.getByText("新建任务")).toBeTruthy();
  });

  it("uses the AI task draft assistant to fill the intake form and patch follow-up changes", async () => {
    const openedProjects: Array<{ projectPath: string; projectName: string }> = [];
    const draftRequests: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const props = creationProps();

    render(
      <TaskBoard
        {...props}
        onOpenRuntimeProject={(input) => {
          openedProjects.push(input);
        }}
        onGenerateTaskDraft={async (input) => {
          draftRequests.push(input as unknown as Record<string, unknown>);
          requestCount += 1;
          if (requestCount === 1) {
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
              assumptions: ["使用默认 opencode 模型。"],
            };
          }

          return {
            ok: true,
            assistantMessage: "已改成 HTML 可视化报告输出。",
            draftPatch: {
              summary: "调研 claude dynamic workflow 的运行机制，并输出 HTML 可视化报告和 spec/plan 线索。",
              labels: ["research", "claude", "workflow", "html"],
              artifactPath: "reports/claude-dynamic-workflow.html",
            },
            missingFields: [],
            assumptions: [],
          };
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("一句话描述任务"), {
      target: {
        value:
          "在 /Users/dinker/CODES/TEMP_project/Agent_Test 调研 claude dynamic workflow 机制，输出报告和 spec/plan 线索。",
      },
    });
    fireEvent.change(screen.getByLabelText("AI 助手模型"), {
      target: { value: "opencode-go/minimax-m3" },
    });
    expect((screen.getByLabelText("Conductor 模型") as HTMLInputElement).value).toBe("opencode-go/minimax-m3");
    fireEvent.click(screen.getByRole("button", { name: "生成配置" }));

    await waitFor(() =>
      expect((screen.getByLabelText("任务标题") as HTMLInputElement).value).toBe("调研 claude dynamic workflow 机制"),
    );
    expect((screen.getByLabelText("任务目标") as HTMLTextAreaElement).value).toContain("spec/plan 线索");
    expect((screen.getByLabelText("起始方案") as HTMLSelectElement).value).toBe("research");
    expect((screen.getByLabelText("任务标签") as HTMLInputElement).value).toBe("research, claude, workflow");
    expect((screen.getByLabelText("附件路径") as HTMLInputElement).value).toBe(
      "docs/research/claude-dynamic-workflow.md",
    );
    expect(openedProjects).toEqual([
      {
        projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
        projectName: "Agent_Test",
      },
    ]);

    fireEvent.change(screen.getByLabelText("继续修改任务配置"), {
      target: { value: "输出改成 html 可视化报告。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修改配置" }));

    await waitFor(() =>
      expect((screen.getByLabelText("附件路径") as HTMLInputElement).value).toBe(
        "reports/claude-dynamic-workflow.html",
      ),
    );
    expect((screen.getByLabelText("任务目标") as HTMLTextAreaElement).value).toContain("HTML 可视化报告");
    expect((screen.getByLabelText("任务标签") as HTMLInputElement).value).toBe(
      "research, claude, workflow, html",
    );
    expect(screen.getByText("已改成 HTML 可视化报告输出。")).toBeTruthy();
    expect(draftRequests).toHaveLength(2);
    expect(draftRequests[0].model).toBe("opencode-go/minimax-m3");
    expect(draftRequests[1].currentDraft).toMatchObject({
      title: "调研 claude dynamic workflow 机制",
      artifactPath: "docs/research/claude-dynamic-workflow.md",
    });
  });

  it("applies an AI follow-up that only changes the Session Agent Plan", async () => {
    const props = creationProps();
    let requestCount = 0;

    render(
      <TaskBoard
        {...props}
        onGenerateTaskDraft={async () => {
          requestCount += 1;
          if (requestCount === 1) {
            return {
              ok: true,
              assistantMessage: "已生成调研任务配置。",
              draft: {
                projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
                projectName: "Agent_Test",
                title: "调研 Claude Dynamic Workflow 机制",
                summary: "独立调研 Claude Dynamic Workflow 机制，输出调研报告。",
                templateId: "research",
                model: "opencode-go/deepseek-v4-flash",
                labels: ["research", "claude", "workflow"],
                artifactPath: "docs/research/claude-dynamic-workflow.md",
              },
              sessionPlan: {
                templateId: "research",
                defaultModel: "opencode-go/deepseek-v4-flash",
                conductor: {
                  idSeed: "conductor",
                  name: "Conductor",
                  role: "Research coordinator",
                  provider: "opencode",
                  model: "opencode-go/deepseek-v4-flash",
                  instructions: "任务负责人，只管主线、派发、读取结果和收口判断。",
                },
                workers: [
                  {
                    idSeed: "researcher",
                    name: "Researcher",
                    role: "Evidence collector",
                    provider: "opencode",
                    model: "opencode-go/deepseek-v4-flash",
                    instructions: "独立调研并写 research 产物。",
                  },
                  {
                    idSeed: "reviewer",
                    name: "Reviewer",
                    role: "Source challenge",
                    provider: "opencode",
                    model: "opencode-go/deepseek-v4-flash",
                    instructions: "复核来源质量。",
                  },
                ],
                routePolicy: {
                  allowedTargets: ["Researcher", "Reviewer"],
                },
              },
              missingFields: [],
              assumptions: [],
            };
          }

          return {
            ok: true,
            assistantMessage: "已增加一个独立 Researcher session。",
            sessionPlanPatch: {
              templateId: "research",
              defaultModel: "opencode-go/deepseek-v4-flash",
              conductor: {
                idSeed: "conductor",
                name: "Conductor",
                role: "Research coordinator",
                provider: "opencode",
                model: "opencode-go/deepseek-v4-flash",
                instructions: "任务负责人，只管主线、派发、读取结果和收口判断。",
              },
              workers: [
                {
                  idSeed: "researcher",
                  name: "Researcher",
                  role: "Evidence collector",
                  provider: "opencode",
                  model: "opencode-go/deepseek-v4-flash",
                  instructions: "独立调研并写 research 产物。",
                },
                {
                  idSeed: "researcher-b",
                  name: "Researcher B",
                  role: "Independent search",
                  provider: "opencode",
                  model: "opencode-go/deepseek-v4-flash",
                  instructions: "独立搜索补充证据。",
                },
                {
                  idSeed: "reviewer",
                  name: "Reviewer",
                  role: "Source challenge",
                  provider: "opencode",
                  model: "opencode-go/deepseek-v4-flash",
                  instructions: "复核来源质量。",
                },
              ],
              routePolicy: {
                allowedTargets: ["Researcher", "Researcher B", "Reviewer"],
              },
            },
            missingFields: [],
            assumptions: [],
          };
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("一句话描述任务"), {
      target: { value: "在 Agent_Test 中调研 Claude Dynamic Workflow 机制。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成配置" }));

    await waitFor(() => expect(screen.getByLabelText("Researcher session 卡片")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("继续修改任务配置"), {
      target: { value: "帮我增加一个 Researcher 独立搜索任务" },
    });
    fireEvent.click(screen.getByRole("button", { name: "修改配置" }));

    await waitFor(() => expect(screen.getByLabelText("Researcher B session 卡片")).toBeTruthy());
    expect(screen.getByText("已增加一个独立 Researcher session。")).toBeTruthy();
    expect(screen.queryByText("opencode 没有返回可用的任务配置 JSON。")).toBeNull();
  });

  it("does not expose a Conductor terminal restart action while the selected session is running", () => {
    let started = 0;
    const props = baseProps();

    render(
      <TaskBoard
        {...props}
        nativePtySession={{
          id: "native-conductor-running",
          command: "opencode",
          args: ["--model", "opencode-go/deepseek-v4-flash"],
          cwd: props.selectedProject.path,
          backend: "pty",
          status: "running",
          cols: 100,
          rows: 30,
          transcript: ["ready"],
        }}
        onStartConductorPty={() => {
          started += 1;
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Conductor 运行中" })).toBeNull();
    expect(screen.queryByRole("button", { name: "启动 Conductor PTY" })).toBeNull();
    expect(started).toBe(0);
  });

  it("submits task intake with template, model, Conductor owner, labels, artifact path, and template source", () => {
    const createdInputs: Array<Record<string, unknown>> = [];
    const props = creationProps();

    render(
      <TaskBoard
        {...props}
        onCreateTaskFromIntake={(input) => {
          createdInputs.push(input as unknown as Record<string, unknown>);
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("任务标题"), {
      target: { value: "Create task-scoped opencode agents" },
    });
    fireEvent.change(screen.getByLabelText("任务目标"), {
      target: { value: "Create a running task and template agent records." },
    });
    fireEvent.change(screen.getByLabelText("起始方案"), { target: { value: "spec-plan" } });
    fireEvent.change(screen.getByLabelText("Conductor 模型"), {
      target: { value: "opencode-go/deepseek-v4-flash" },
    });
    const sessionPlanDraft = JSON.parse((screen.getByLabelText("Session Agent Plan JSON") as HTMLTextAreaElement).value);
    expect(sessionPlanDraft.defaultModel).toBe("opencode-go/deepseek-v4-flash");
    expect(sessionPlanDraft.conductor.model).toBe("opencode-go/deepseek-v4-flash");
    expect(sessionPlanDraft.workers.map((worker: { model: string }) => worker.model)).toEqual([
      "opencode-go/deepseek-v4-flash",
      "opencode-go/deepseek-v4-flash",
    ]);
    fireEvent.change(screen.getByLabelText("任务标签"), { target: { value: "plan, pty" } });
    fireEvent.change(screen.getByLabelText("附件路径"), {
      target: { value: ".agent-workspace/tasks/task-real-spec/artifacts/context.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0]).toMatchObject({
      title: "Create task-scoped opencode agents",
      summary: "Create a running task and template agent records.",
      labels: ["plan", "pty"],
      intakeSource: "watcher",
      owner: "Conductor",
      templateId: "spec-plan",
      model: "opencode-go/deepseek-v4-flash",
      artifactPath: ".agent-workspace/tasks/task-real-spec/artifacts/context.json",
      sessionPlan: {
        templateId: "spec-plan",
        conductor: {
          name: "Conductor",
          role: "Spec coordinator",
          model: "opencode-go/deepseek-v4-flash",
        },
        workers: [
          { name: "Planner", role: "Plan author", model: "opencode-go/deepseek-v4-flash" },
          { name: "Reviewer", role: "Technical challenge", model: "opencode-go/deepseek-v4-flash" },
        ],
      },
    });
  });

  it("shows Session Agent Plan as editable cards, not a primary JSON editor", () => {
    const props = creationProps();

    render(<TaskBoard {...props} />);

    expect(screen.getByText("Session Agent 编排")).toBeTruthy();
    expect(screen.getByLabelText("Conductor session 卡片")).toBeTruthy();
    expect(screen.getByLabelText("Researcher session 卡片")).toBeTruthy();
    expect(screen.getByLabelText("Reviewer session 卡片")).toBeTruthy();
    expect(screen.queryByLabelText("Session Agent Plan")).toBeNull();
    expect(screen.getByLabelText("Session Agent Plan JSON")).toBeTruthy();
  });

  it("adds a worker session from the card editor and submits it in the task plan", () => {
    const createdInputs: Array<Record<string, unknown>> = [];
    const props = creationProps();

    render(
      <TaskBoard
        {...props}
        onCreateTaskFromIntake={(input) => {
          createdInputs.push(input as unknown as Record<string, unknown>);
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: "Run parallel research" } });
    fireEvent.change(screen.getByLabelText("任务目标"), { target: { value: "Use multiple independent researchers." } });
    fireEvent.click(screen.getByRole("button", { name: "添加 worker session" }));
    fireEvent.change(screen.getByLabelText("Worker 3 名称"), { target: { value: "Researcher B" } });
    fireEvent.change(screen.getByLabelText("Worker 3 职责"), { target: { value: "Independent evidence collector" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并启动" }));

    expect(createdInputs).toHaveLength(1);
    expect(createdInputs[0]).toMatchObject({
      sessionPlan: {
        workers: expect.arrayContaining([
          expect.objectContaining({
            name: "Researcher B",
            role: "Independent evidence collector",
          }),
        ]),
        routePolicy: {
          allowedTargets: expect.arrayContaining(["Researcher B"]),
        },
      },
    });
  });

  it("duplicates a worker session from the card editor", () => {
    const props = baseProps();

    render(<TaskBoard {...props} tasks={[]} selectedTask={undefined} selectedTaskId="" />);

    fireEvent.click(within(screen.getByLabelText("Researcher session 卡片")).getByRole("button", { name: "复制" }));

    expect(screen.getByLabelText("Researcher Copy session 卡片")).toBeTruthy();
    expect(screen.getByLabelText("Worker 3 名称")).toHaveProperty("value", "Researcher Copy");
    expect(screen.getByLabelText("Worker 3 职责")).toHaveProperty("value", "Evidence collector");
  });

  it("does not render Conductor runtime prompt preview in the task creation page", () => {
    const props = baseProps();

    render(<TaskBoard {...props} tasks={[]} selectedTask={undefined} selectedTaskId="" />);

    expect(screen.queryByText("Conductor Runtime 预览")).toBeNull();
    expect(screen.queryByText("MCP tools")).toBeNull();
    expect(screen.queryByText("call_session")).toBeNull();
    expect(screen.queryByText("read_task_state")).toBeNull();
    expect(screen.queryByText("read_session")).toBeNull();
    expect(screen.queryByText("finish_task_claim")).toBeNull();
    expect(screen.queryByText("原生 session，不注入 Agent Workspace 协议")).toBeNull();
    expect(screen.queryByText("Workspace Session Message")).toBeNull();
  });
});
