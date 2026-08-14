// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopSessionIdRuntimeApp } from "./AgentLoopSessionIdRuntimeApp";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";
import type {
  AgentLoopSessionIdRootController,
  AgentLoopSessionIdWorkspaceReadModel,
} from "./agent-loop-session-id-root-controller";
import type {
  AgentLoopSessionIdRuntimeController,
  AgentLoopSessionIdTaskReadModel,
} from "./agent-loop-session-id-runtime-controller";
import type { AgentLoopTemplateStudioController } from "./agent-loop-template-studio-controller";
import type { AgentLoopProviderSettingsController } from "./AgentLoopProviderSettings";

const NOW = "2026-08-11T10:00:00.000Z";

afterEach(cleanup);

describe("AgentLoopSessionIdRuntimeApp", () => {
  it("collapses the main navigation to icons while keeping both product destinations accessible", async () => {
    render(<AgentLoopSessionIdRuntimeApp controller={rootController({
      runtime: taskRuntime(),
      workspace: () => workspace(false),
    })} />);

    await screen.findByTestId("task-start");
    const surface = screen.getByTestId("agent-loop-surface");
    expect(surface.className).not.toContain("awb-agent-loop-rail-collapsed");
    fireEvent.click(screen.getByTestId("navigation-rail-toggle"));
    expect(surface.className).toContain("awb-agent-loop-rail-collapsed");
    expect(screen.getByRole("button", { name: "任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "模板" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    expect(screen.getByTestId("navigation-rail-toggle").getAttribute("aria-label")).toBe("展开主导航");

    fireEvent.click(screen.getByTestId("navigation-rail-toggle"));
    expect(surface.className).not.toContain("awb-agent-loop-rail-collapsed");
  });

  it("opens ACP Provider settings and refreshes one real Host-owned model catalog explicitly", async () => {
    const loadProviderSettings = vi.fn(async () => ({
      generatedAt: NOW,
      providers: [
        providerSettingsEntry("opencode", true),
        { ...providerSettingsEntry("codex", true), configurationSource: "local" as const },
        providerSettingsEntry("claude-code", false),
      ],
    }));
    const refreshProviderModels = vi.fn(async (_providerFamily: "opencode" | "codex" | "claude-code") => ({
      generatedAt: NOW,
      providers: [
        providerSettingsEntry("opencode", true),
        { ...providerSettingsEntry("codex", true), configurationSource: "local" as const, status: "not_checked" as const, models: [
          { modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
          { modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        ] },
        providerSettingsEntry("claude-code", false),
      ],
    }));
    const discoverInstallation = vi.fn(loadProviderSettings);
    const configureInstallation = vi.fn(loadProviderSettings);
    const configureChatModels = vi.fn(async () => await refreshProviderModels("codex"));
    const controller = rootController({
      runtime: taskRuntime(),
      workspace: () => workspace(false),
      providerSettings: {
        load: loadProviderSettings,
        discoverInstallation,
        configureInstallation,
        refreshModels: refreshProviderModels,
        configureChatModels,
      },
    });

    render(<AgentLoopSessionIdRuntimeApp controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByRole("heading", { name: "ACP Provider 设置" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Codex" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "刷新模型目录" }));
    await waitFor(() => expect(refreshProviderModels).toHaveBeenCalledWith("codex"));
    expect(await screen.findByRole("heading", { name: "可用模型 (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Codex已获取 2 个模型" })).toBeTruthy();
    expect(screen.getByText("模型已获取")).toBeTruthy();
    const luna = within(screen.getByTestId("provider-model-gpt-5.6-luna"));
    const sol = within(screen.getByTestId("provider-model-gpt-5.6-sol"));
    fireEvent.click(luna.getByRole("checkbox"));
    fireEvent.click(sol.getByRole("checkbox"));
    fireEvent.click(sol.getByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "保存到 Chat (2)" }));
    await waitFor(() => expect(configureChatModels).toHaveBeenCalledWith(
      "codex",
      ["gpt-5.6-luna", "gpt-5.6-sol"],
      "gpt-5.6-sol",
    ));
    expect(screen.getByText(/路径和登录文件只由本机 Runtime Host 保存/u)).toBeTruthy();
  });

  it("selects a valid default when the first enabled OpenCode or Claude model is not the catalog's first item", async () => {
    const settings = {
      generatedAt: NOW,
      providers: [
        {
          ...providerSettingsEntry("opencode", true),
          configurationSource: "local" as const,
          models: [
            { modelId: "deepseek/chat", label: "DeepSeek Chat" },
            { modelId: "opencode-go/gpt-5.6-luna", label: "GPT-5.6 Luna" },
          ],
        },
        { ...providerSettingsEntry("codex", true), configurationSource: "local" as const },
        {
          ...providerSettingsEntry("claude-code", true),
          configurationSource: "local" as const,
          models: [
            { modelId: "default", label: "Default" },
            { modelId: "opus", label: "Claude Opus" },
          ],
        },
      ],
    };
    const configureChatModels = vi.fn(async () => settings);
    const load = vi.fn(async () => settings);
    const controller = rootController({
      runtime: taskRuntime(),
      workspace: () => workspace(false),
      providerSettings: {
        load,
        discoverInstallation: load,
        configureInstallation: load,
        refreshModels: load,
        configureChatModels,
      },
    });

    render(<AgentLoopSessionIdRuntimeApp controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await screen.findByRole("heading", { name: "ACP Provider 设置" });

    fireEvent.click(screen.getByRole("button", { name: /OpenCode/u }));
    fireEvent.click(within(screen.getByTestId("provider-model-opencode-go/gpt-5.6-luna")).getByRole("checkbox"));
    const saveOpenCode = screen.getByRole("button", { name: "保存到 Chat (1)" }) as HTMLButtonElement;
    expect(saveOpenCode.disabled).toBe(false);
    fireEvent.click(saveOpenCode);
    await waitFor(() => expect(configureChatModels).toHaveBeenCalledWith(
      "opencode",
      ["opencode-go/gpt-5.6-luna"],
      "opencode-go/gpt-5.6-luna",
    ));

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/u }));
    fireEvent.click(within(screen.getByTestId("provider-model-opus")).getByRole("checkbox"));
    const saveClaude = screen.getByRole("button", { name: "保存到 Chat (1)" }) as HTMLButtonElement;
    expect(saveClaude.disabled).toBe(false);
    fireEvent.click(saveClaude);
    await waitFor(() => expect(configureChatModels).toHaveBeenCalledWith(
      "claude-code",
      ["opus"],
      "opus",
    ));
  });

  it("keeps the managed ACP runtime internal and does not ask the user to restart the Host", async () => {
    const codex = {
      ...providerSettingsEntry("codex", true),
      installation: {
        status: "ready" as const,
        components: [
          { kind: "provider_cli" as const, label: "Codex CLI", status: "found" as const, displayPath: "/opt/bin/codex" },
          { kind: "node" as const, label: "Node.js", status: "found" as const, displayPath: "/opt/bin/node" },
          { kind: "credential_source" as const, label: "Codex 登录", status: "found" as const, displayPath: "~/.codex/auth.json" },
        ],
      },
    };
    const load = vi.fn(async () => ({
      generatedAt: NOW,
      providers: [providerSettingsEntry("opencode", false), codex, providerSettingsEntry("claude-code", false)],
    }));
    const controller = rootController({
      runtime: taskRuntime(),
      workspace: () => workspace(false),
      providerSettings: {
        load,
        discoverInstallation: load,
        configureInstallation: load,
        refreshModels: load,
        configureChatModels: load,
      },
    });

    render(<AgentLoopSessionIdRuntimeApp controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    expect(await screen.findByText("Codex CLI")).toBeTruthy();
    expect(screen.queryByText(/ACP 适配器/u)).toBeNull();
    expect(screen.queryByText(/待重启|重启 Runtime Host/u)).toBeNull();
    expect(screen.getByText(/Agent Workspace 管理 ACP runtime/u)).toBeTruthy();
  });

  it("keeps Create and Start separate, then renders the fresh Session-ID Run", async () => {
    let started = false;
    const runtime = taskRuntime();
    const startTask = vi.fn(async () => {
      started = true;
      return { run: { runId: "run_started", status: "starting" } };
    });
    const controller = rootController({
      runtime,
      startTask,
      workspace: () => workspace(started),
    });

    render(<AgentLoopSessionIdRuntimeApp
      controller={controller}
      createUiIntentId={() => "ui_intent_start"}
    />);

    const start = await screen.findByTestId("task-start");
    expect(screen.queryByTestId("task-running")).toBeNull();
    expect(runtime.load).not.toHaveBeenCalled();
    fireEvent.click(start);

    await waitFor(() => expect(startTask).toHaveBeenCalledWith("task_queued", 1, "ui_intent_start"));
    expect(await screen.findByTestId("task-running")).toBeTruthy();
    expect(screen.getByTestId("task-run-meta-absent")).toBeTruthy();
  });

  it("reads Workspace before Task detail and never probes a queued Task as an active Run", async () => {
    const runtime = taskRuntime();
    const controller = rootController({ runtime, workspace: () => workspace(false) });
    render(<AgentLoopSessionIdRuntimeApp controller={controller} />);

    await screen.findByTestId("task-start");
    expect(runtime.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(controller.loadWorkspace).toHaveBeenCalledTimes(2));
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it("keeps the latest Workspace, Task and Session when an older refresh resolves last", async () => {
    const workspaceA = deferred<AgentLoopSessionIdWorkspaceReadModel>();
    const workspaceB = deferred<AgentLoopSessionIdWorkspaceReadModel>();
    const taskA = deferred<AgentLoopSessionIdTaskReadModel>();
    const taskB = deferred<AgentLoopSessionIdTaskReadModel>();
    const runtimeA = { ...taskRuntime(), load: vi.fn(() => taskA.promise) };
    const runtimeB = { ...taskRuntime(), load: vi.fn(() => taskB.promise) };
    const loadWorkspace = vi.fn()
      .mockImplementationOnce(() => workspaceA.promise)
      .mockImplementationOnce(() => workspaceB.promise);
    let invalidate: ((invalidation: Readonly<{ reason: string }>) => void) | undefined;
    const controller: AgentLoopSessionIdRootController = {
      ...rootController({ runtime: runtimeA, workspace: () => runningWorkspace("task_a", "Workspace A", "run_a") }),
      loadWorkspace,
      subscribe: vi.fn(async (listener) => {
        invalidate = listener;
        return () => undefined;
      }),
      task: vi.fn((taskId) => taskId === "task_b" ? runtimeB : runtimeA),
    };

    render(<AgentLoopSessionIdRuntimeApp controller={controller} />);

    await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(1));
    await act(async () => {
      workspaceA.resolve(runningWorkspace("task_a", "Workspace A", "run_a"));
      await workspaceA.promise;
    });
    await waitFor(() => expect(runtimeA.load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidate).toBeDefined());
    act(() => invalidate?.({ reason: "provider_fact" }));
    await waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(2));

    await act(async () => {
      workspaceB.resolve(runningWorkspace("task_b", "Workspace B", "run_b"));
      await workspaceB.promise;
    });
    await waitFor(() => expect(runtimeB.load).toHaveBeenCalledTimes(1));
    await act(async () => {
      taskB.resolve(runningTask("task_b", "Task B", "run_b", "B"));
      await taskB.promise;
    });
    expect(await screen.findByRole("button", { name: /Workspace B/u })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Task B" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conductor B" })).toBeTruthy();

    await act(async () => {
      taskA.resolve(runningTask("task_a", "Task A", "run_a", "A"));
      await taskA.promise;
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: /Workspace A/u })).toBeNull();
    expect(screen.getByRole("button", { name: /Workspace B/u })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Task A" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Task B" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Conductor A" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Conductor B" })).toBeTruthy();
  });

  it("routes visible Task/Card/interrupt/Preview/Achieve/Stop actions only through the Session-ID controller", async () => {
    const runtime = taskRuntime();
    const achieveTask = vi.fn(async () => ({}));
    render(<AgentLoopSessionIdRuntimeApp
      controller={rootController({ runtime, achieveTask, workspace: () => workspace(true) })}
      createUiIntentId={intentSequence()}
    />);

    await screen.findByTestId("task-running");
    fireEvent.change(screen.getByTestId("task-conductor-composer"), { target: { value: "Replan" } });
    fireEvent.click(screen.getByTestId("task-conductor-send"));
    await waitFor(() => expect(runtime.submitTaskMessage).toHaveBeenCalledWith("Replan", "ui_intent_1"));

    fireEvent.click(within(screen.getByRole("navigation", { name: "Task Session Tabs" })).getByRole("button", { name: /Researcher/u }));
    fireEvent.change(screen.getByTestId("card-composer-researcher"), { target: { value: "Human correction" } });
    fireEvent.click(screen.getByTestId("card-send-interrupt-first"));
    await waitFor(() => expect(runtime.sendHumanMessage).toHaveBeenCalledWith(
      { targetLogicalSessionId: "session_researcher" },
      "Human correction",
      "ui_intent_2",
    ));

    fireEvent.change(screen.getByTestId("card-composer-researcher"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(runtime.requestHumanInterrupt).toHaveBeenCalledWith("session_researcher", "ui_intent_3"));

    fireEvent.click(screen.getByTestId("publisher-file-preview"));
    await screen.findByTestId("task-achieve-with-anchor");
    fireEvent.click(screen.getByTestId("task-achieve-with-anchor"));
    await waitFor(() => expect(achieveTask).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task_queued",
      uiIntentId: "ui_intent_5",
      fileObservation: expect.objectContaining({ observationId: "observation_publisher" }),
    })));

    fireEvent.click(screen.getByTestId("task-stop"));
    await waitFor(() => expect(runtime.stopTask).toHaveBeenCalledWith("ui_intent_6"));
  });

  it("moves an achieved Task to Completed while keeping its active Run and Stop surface available", async () => {
    let achieved = false;
    const runtime = taskRuntime();
    const achieveTask = vi.fn(async () => {
      achieved = true;
      return {
        task: {
          taskId: "task_queued",
          title: "Deep Search",
          goal: "Produce a reviewed report",
          revision: 3,
          status: "running",
          activeRun: { runId: "run_started", status: "running" },
          availableLifecycleActions: [],
          achievement: {
            achievedAt: NOW,
            fileStateAnchor: { workspaceRelativePath: "reports/final.md" },
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
    });
    const controller = rootController({
      runtime,
      achieveTask,
      workspace: () => {
        const current = workspace(true);
        return {
          ...current,
          tasks: current.tasks.map((task) => achieved ? {
            ...task,
            revision: task.revision + 1,
            achievement: {
              achievedAt: NOW,
              fileStateAnchor: { workspaceRelativePath: "reports/final.md" },
            },
          } : task),
        };
      },
    });
    render(<AgentLoopSessionIdRuntimeApp controller={controller} createUiIntentId={intentSequence()} />);

    await screen.findByTestId("task-running");
    fireEvent.click(screen.getByTestId("publisher-file-preview"));
    fireEvent.click(await screen.findByTestId("task-achieve-with-anchor"));

    await waitFor(() => expect(screen.getByTestId("task-list-completed").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("task-achieved-with-anchor")).toBeTruthy();
    expect(screen.getByTestId("task-running")).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-stop"));
    await waitFor(() => expect(runtime.stopTask).toHaveBeenCalledWith("ui_intent_3"));
  });

  it("accepts an active Run without a Publisher preview and keeps Stop as a separate action", async () => {
    let achieved = false;
    const runtime = taskRuntime();
    const achieveTask = vi.fn(async () => {
      achieved = true;
      return {
        task: {
          ...workspace(true).tasks[0]!,
          revision: 3,
          achievement: { achievedAt: NOW },
        },
      };
    });
    render(<AgentLoopSessionIdRuntimeApp
      controller={rootController({
        runtime,
        achieveTask,
        workspace: () => ({
          ...workspace(true),
          tasks: workspace(true).tasks.map((summary) => achieved ? {
            ...summary,
            revision: 3,
            achievement: { achievedAt: NOW },
          } : summary),
        }),
      })}
      createUiIntentId={intentSequence()}
    />);

    await screen.findByTestId("task-running");
    expect(screen.queryByTestId("task-achieve-with-anchor")).toBeNull();
    fireEvent.click(screen.getByTestId("task-achieve-without-anchor"));
    await waitFor(() => expect(achieveTask).toHaveBeenCalledWith({
      taskId: "task_queued",
      expectedRevision: 2,
      uiIntentId: "ui_intent_1",
    }));

    await waitFor(() => expect(screen.getByTestId("task-list-completed").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("task-achieved-without-anchor")).toBeTruthy();
    expect(screen.getByTestId("task-running")).toBeTruthy();
    expect(runtime.stopTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("task-stop"));
    await waitFor(() => expect(runtime.stopTask).toHaveBeenCalledWith("ui_intent_2"));
  });

  it("reuses the active-Run unanchored Achieve uiIntent after an ambiguous command failure", async () => {
    const achieveTask = vi.fn()
      .mockRejectedValueOnce(new Error("transport_result_unknown"))
      .mockResolvedValueOnce({});
    const nextIntent = vi.fn(intentSequence());
    render(<AgentLoopSessionIdRuntimeApp
      controller={rootController({ runtime: taskRuntime(), achieveTask, workspace: () => workspace(true) })}
      createUiIntentId={nextIntent}
    />);

    fireEvent.click(await screen.findByTestId("task-achieve-without-anchor"));
    await waitFor(() => expect(achieveTask).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("transport_result_unknown"))).toBe(true);

    fireEvent.click(screen.getByTestId("task-achieve-without-anchor"));
    await waitFor(() => expect(achieveTask).toHaveBeenCalledTimes(2));
    expect(achieveTask.mock.calls.map(([input]) => input.uiIntentId)).toEqual([
      "ui_intent_1",
      "ui_intent_1",
    ]);
    expect(nextIntent).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "queued", availableLifecycleActions: ["start"] as const, forbiddenAction: "task-start" },
    { status: "stopped", availableLifecycleActions: ["restart"] as const, forbiddenAction: "task-restart" },
  ])("accepts a $status Task with no active Run and exposes no post-Achieve fresh-Run action", async ({
    status,
    availableLifecycleActions,
    forbiddenAction,
  }) => {
    let achieved = false;
    const achieveTask = vi.fn(async () => {
      achieved = true;
      return {
        task: {
          taskId: "task_no_run",
          title: "No Run",
          goal: "Accept without starting",
          revision: 5,
          status,
          availableLifecycleActions,
          achievement: { achievedAt: NOW },
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
    });
    const currentWorkspace = (): AgentLoopSessionIdWorkspaceReadModel => ({
      generatedAt: NOW,
      tasks: [{
        taskId: "task_no_run",
        title: "No Run",
        goal: "Accept without starting",
        revision: achieved ? 5 : 4,
        status,
        availableLifecycleActions,
        ...(achieved ? { achievement: { achievedAt: NOW } } : {}),
        createdAt: NOW,
        updatedAt: NOW,
      }],
      taskSetupOptions: { templates: [], workspaces: [] },
    });
    render(<AgentLoopSessionIdRuntimeApp
      controller={rootController({ runtime: taskRuntime(), achieveTask, workspace: currentWorkspace })}
      createUiIntentId={intentSequence()}
    />);

    expect(await screen.findByTestId("task-achieve-without-anchor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-achieve-without-anchor"));
    await waitFor(() => expect(achieveTask).toHaveBeenCalledWith({
      taskId: "task_no_run",
      expectedRevision: 4,
      uiIntentId: "ui_intent_1",
    }));
    await waitFor(() => expect(screen.getByTestId("task-list-completed").getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("task-achieved-without-anchor")).toBeTruthy();
    expect(screen.queryByTestId(forbiddenAction)).toBeNull();
    expect(screen.queryByTestId("task-achieve-without-anchor")).toBeNull();
  });

  it("renders Resume and Restart as distinct lifecycle actions and suppresses Restart after Achieve", async () => {
    const resumeTask = vi.fn(async () => ({}));
    const restartTask = vi.fn(async () => ({}));
    const tasks: AgentLoopSessionIdWorkspaceReadModel["tasks"] = [{
      taskId: "task_blocked",
      title: "Blocked",
      goal: "Resume the original run",
      revision: 4,
      status: "blocked",
      activeRun: { runId: "run_original", status: "blocked" },
      availableLifecycleActions: ["resume"],
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      taskId: "task_terminal",
      title: "Terminal",
      goal: "Start a fresh run",
      revision: 7,
      status: "stopped",
      availableLifecycleActions: ["restart"],
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      taskId: "task_achieved",
      title: "Achieved",
      goal: "Must not restart",
      revision: 9,
      status: "stopped",
      availableLifecycleActions: ["restart"],
      achievement: { achievedAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    }];
    const controller = rootController({
      runtime: taskRuntime(),
      resumeTask,
      restartTask,
      workspace: () => ({ generatedAt: NOW, tasks, taskSetupOptions: { templates: [], workspaces: [] } }),
    });
    render(<AgentLoopSessionIdRuntimeApp
      controller={controller}
      createUiIntentId={intentSequence()}
    />);

    fireEvent.click(await screen.findByTestId("task-resume"));
    await waitFor(() => expect(resumeTask).toHaveBeenCalledWith("task_blocked", "run_original", 4, "ui_intent_1"));

    fireEvent.click(screen.getByRole("button", { name: /Terminalrunning|Terminalstopped|Terminal/u }));
    expect(await screen.findByTestId("task-stopped")).toBeTruthy();
    fireEvent.click(await screen.findByTestId("task-restart"));
    await waitFor(() => expect(restartTask).toHaveBeenCalledWith("task_terminal", 7, "ui_intent_2"));

    fireEvent.click(screen.getByTestId("task-list-completed"));
    fireEvent.click(await screen.findByRole("button", { name: /Achieved/u }));
    await waitFor(() => expect(screen.queryByTestId("task-restart")).toBeNull());
  });

  it("separates active, completed and recycle views and requires a path-free delete preview", async () => {
    const archiveTask = vi.fn(async () => ({}));
    const restoreTask = vi.fn(async () => ({}));
    const previewPermanentDelete = vi.fn(async () => ({
      permanentDeletePreview: {
        taskId: "task_recycled",
        expectedRevision: 12,
        productRecordCounts: { taskRuns: 2, messages: 7 },
        workspaceFilesWillRemain: true as const,
      },
    }));
    const permanentlyDeleteTask = vi.fn(async () => ({
      permanentDelete: { taskId: "task_recycled", deletedAt: NOW, workspaceFilesWillRemain: true as const },
    }));
    const tasks: AgentLoopSessionIdWorkspaceReadModel["tasks"] = [{
      taskId: "task_active",
      title: "Active",
      goal: "Still active",
      revision: 2,
      status: "queued",
      availableLifecycleActions: ["start"],
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      taskId: "task_completed",
      title: "Completed",
      goal: "Accepted",
      revision: 9,
      status: "stopped",
      availableLifecycleActions: [],
      achievement: { achievedAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      taskId: "task_recycled",
      title: "Recycled",
      goal: "Retained until explicit delete",
      revision: 12,
      status: "stopped",
      trashedAt: NOW,
      availableLifecycleActions: [],
      achievement: { achievedAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    }];
    render(<AgentLoopSessionIdRuntimeApp
      controller={rootController({
        runtime: taskRuntime(),
        archiveTask,
        restoreTask,
        previewPermanentDelete,
        permanentlyDeleteTask,
        workspace: () => ({ generatedAt: NOW, tasks, taskSetupOptions: { templates: [], workspaces: [] } }),
      })}
      createUiIntentId={intentSequence()}
    />);

    expect(await screen.findByRole("button", { name: /Active/u })).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-list-completed"));
    expect(await screen.findByRole("button", { name: /Completed/u })).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-archive"));
    await waitFor(() => expect(archiveTask).toHaveBeenCalledWith("task_completed", 9, "ui_intent_1"));

    fireEvent.click(screen.getByTestId("task-list-recycle-bin"));
    expect(await screen.findByRole("button", { name: /Recycled/u })).toBeTruthy();
    fireEvent.click(screen.getByTestId("task-restore"));
    await waitFor(() => expect(restoreTask).toHaveBeenCalledWith("task_recycled", 12, "ui_intent_2"));

    fireEvent.click(screen.getByTestId("task-preview-permanent-delete"));
    const dialog = await screen.findByRole("dialog", { name: "永久删除 Task" });
    expect(dialog.textContent).toContain("Workspace 文件不会被删除");
    expect(dialog.textContent).not.toContain("/Users/");
    fireEvent.click(screen.getByTestId("task-permanently-delete-confirm"));
    await waitFor(() => expect(permanentlyDeleteTask).toHaveBeenCalledWith("task_recycled", 12, "ui_intent_4"));
  });
});

function rootController(input: Readonly<{
  workspace: () => AgentLoopSessionIdWorkspaceReadModel;
  runtime: AgentLoopSessionIdRuntimeController;
  startTask?: AgentLoopSessionIdRootController["startTask"];
  resumeTask?: AgentLoopSessionIdRootController["resumeTask"];
  restartTask?: AgentLoopSessionIdRootController["restartTask"];
  achieveTask?: AgentLoopSessionIdRootController["achieveTask"];
  archiveTask?: AgentLoopSessionIdRootController["archiveTask"];
  restoreTask?: AgentLoopSessionIdRootController["restoreTask"];
  previewPermanentDelete?: AgentLoopSessionIdRootController["previewPermanentDelete"];
  permanentlyDeleteTask?: AgentLoopSessionIdRootController["permanentlyDeleteTask"];
  providerSettings?: AgentLoopProviderSettingsController;
}>): AgentLoopSessionIdRootController {
  return {
    configuration: {
      configuration: configurationController(),
      templates: templateStudioController(),
      providerSettings: input.providerSettings ?? providerSettingsController(),
    },
    loadWorkspace: vi.fn(async () => input.workspace()),
    subscribe: vi.fn(async () => () => undefined),
    task: vi.fn(() => input.runtime),
    startTask: input.startTask ?? vi.fn(async () => ({})),
    resumeTask: input.resumeTask ?? vi.fn(async () => ({})),
    restartTask: input.restartTask ?? vi.fn(async () => ({})),
    achieveTask: input.achieveTask ?? vi.fn(async () => ({})),
    archiveTask: input.archiveTask ?? vi.fn(async () => ({})),
    restoreTask: input.restoreTask ?? vi.fn(async () => ({})),
    previewPermanentDelete: input.previewPermanentDelete ?? vi.fn(async () => ({})),
    permanentlyDeleteTask: input.permanentlyDeleteTask ?? vi.fn(async () => ({})),
  };
}

function taskRuntime(): AgentLoopSessionIdRuntimeController {
  return {
    load: vi.fn(async () => taskRead()),
    subscribe: vi.fn(async () => () => undefined),
    submitTaskMessage: vi.fn(async () => undefined),
    sendHumanMessage: vi.fn(async () => ({
      humanInterventionId: "human",
      state: "held" as const,
      targetLogicalSessionId: "session_researcher",
    })),
    abandonHumanMessage: vi.fn(async (humanInterventionId) => ({
      humanInterventionId,
      state: "abandoned" as const,
      targetLogicalSessionId: "session_researcher",
    })),
    requestHumanInterrupt: vi.fn(async () => ({ sessionControlAuditId: "control", state: "accepted" as const })),
    respondInteraction: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    previewFile: vi.fn(async () => ({
      observation: taskRead().files[0]!,
      content: "publisher output",
    })),
  };
}

function workspace(started: boolean): AgentLoopSessionIdWorkspaceReadModel {
  return {
    generatedAt: NOW,
    tasks: [{
      taskId: "task_queued",
      title: "Deep Search",
      goal: "Produce a reviewed report",
      revision: started ? 2 : 1,
      status: started ? "running" : "queued",
      availableLifecycleActions: started ? [] : ["start"],
      ...(started ? { activeRun: { runId: "run_started", status: "running" } } : {}),
      createdAt: NOW,
      updatedAt: NOW,
    }],
    taskSetupOptions: { templates: [], workspaces: [] },
  };
}

function taskRead(): AgentLoopSessionIdTaskReadModel {
  const empty = { messages: [], executionGroups: [], interactions: [], controls: [], humanDeliveries: [] } as const;
  return {
    taskId: "task_queued",
    title: "Deep Search",
    goal: "Produce a reviewed report",
    revision: 2,
    runId: "run_started",
    runStatus: "running",
    conductorLogicalSessionId: "session_conductor",
    timeline: [],
    directory: [{ agentCardId: "agent_card_researcher", title: "Researcher", state: "busy", currentLogicalSessionId: "session_researcher", currentGeneration: 1 }],
    sessions: [{
      ...empty,
      logicalSessionId: "session_conductor",
      agentCardId: "agent_card_conductor",
      title: "Conductor",
      kind: "conductor",
      generation: 1,
      lifecycle: "current",
      state: "available",
      hasReceivedFirstInstruction: true,
      profile: taskProfile("conductor"),
    }, {
      ...empty,
      logicalSessionId: "session_researcher",
      agentCardId: "agent_card_researcher",
      title: "Researcher",
      kind: "card",
      generation: 1,
      lifecycle: "current",
      state: "busy",
      hasReceivedFirstInstruction: true,
      profile: taskProfile("researcher"),
    }],
    files: [{
      observationId: "observation_publisher",
      workspaceRelativePath: "reports/final.md",
      observedAt: NOW,
      contentDigest: "sha256:publisher",
      currentState: "available",
      source: "verified_tool",
    }],
  };
}

function runningWorkspace(
  taskId: string,
  title: string,
  runId: string,
): AgentLoopSessionIdWorkspaceReadModel {
  return {
    generatedAt: NOW,
    tasks: [{
      taskId,
      title,
      goal: `${title} goal`,
      revision: 1,
      status: "running",
      activeRun: { runId, status: "running" },
      availableLifecycleActions: [],
      createdAt: NOW,
      updatedAt: NOW,
    }],
    taskSetupOptions: { templates: [], workspaces: [] },
  };
}

function runningTask(
  taskId: string,
  title: string,
  runId: string,
  sessionLabel: string,
): AgentLoopSessionIdTaskReadModel {
  const empty = { messages: [], executionGroups: [], interactions: [], controls: [], humanDeliveries: [] } as const;
  const conductorLogicalSessionId = `session_conductor_${sessionLabel.toLowerCase()}`;
  return {
    taskId,
    title,
    goal: `${title} goal`,
    revision: 1,
    runId,
    runStatus: "running",
    conductorLogicalSessionId,
    timeline: [],
    directory: [],
    sessions: [{
      ...empty,
      logicalSessionId: conductorLogicalSessionId,
      agentCardId: "agent_card_conductor",
      title: `Conductor ${sessionLabel}`,
      kind: "conductor",
      generation: 1,
      lifecycle: "current",
      state: "available",
      hasReceivedFirstInstruction: true,
      profile: taskProfile("conductor"),
    }],
    files: [],
  };
}

function taskProfile(role: "conductor" | "researcher") {
  const suffix = role;
  return {
    schemaVersion: 3 as const,
    executionProfileId: `profile_${suffix}`,
    profileRevisionId: `profile_revision_${suffix}`,
    providerFamily: "opencode" as const,
    acpAgentKind: "native_acp" as const,
    model: "opencode-go/test-model",
    role,
    permissionMode: "deny" as const,
    allowedTools: [],
    requiredCapabilities: [],
    requiredExtensions: [],
    readiness: {
      profileRevisionId: `profile_revision_${suffix}`,
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

function configurationController(): AgentLoopConfigurationController {
  return { meta: {}, taskSetup: vi.fn(), createTaskSetupDraft: vi.fn() } as unknown as AgentLoopConfigurationController;
}

function templateStudioController(): AgentLoopTemplateStudioController {
  return {} as AgentLoopTemplateStudioController;
}

function providerSettingsController(): AgentLoopProviderSettingsController {
  return {
    load: vi.fn(async () => ({ generatedAt: NOW, providers: [] })),
    discoverInstallation: vi.fn(async () => ({ generatedAt: NOW, providers: [] })),
    configureInstallation: vi.fn(async () => ({ generatedAt: NOW, providers: [] })),
    refreshModels: vi.fn(async () => ({ generatedAt: NOW, providers: [] })),
    configureChatModels: vi.fn(async () => ({ generatedAt: NOW, providers: [] })),
  };
}

function providerSettingsEntry(
  providerFamily: "opencode" | "codex" | "claude-code",
  configured: boolean,
) {
  const displayName = providerFamily === "opencode" ? "OpenCode" : providerFamily === "codex" ? "Codex" : "Claude Code";
  return {
    providerFamily,
    displayName,
    configured,
    status: configured ? "not_checked" as const : "not_configured" as const,
    reasons: configured ? [] : ["provider_not_configured"],
    models: [],
    configurationSource: "environment" as const,
    installation: { status: "not_scanned" as const, components: [] },
  };
}

function intentSequence() {
  let next = 0;
  return () => `ui_intent_${++next}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve } as const;
}
