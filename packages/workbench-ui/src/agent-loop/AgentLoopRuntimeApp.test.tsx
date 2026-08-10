// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RuntimeInvalidation } from "@agent-workspace/runtime-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoopRuntimeApp } from "./AgentLoopRuntimeApp";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";
import type { AgentLoopTaskSetupViewModel } from "./AgentLoopTaskSetupSurface";
import type { AgentLoopRuntimeController } from "./agent-loop-runtime-controller";
import type { AgentLoopRuntimeViewModel } from "./agent-loop-model";
import type { AgentLoopTemplateStudioController } from "./agent-loop-template-studio-controller";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AgentLoopRuntimeApp", () => {
  it("keeps the three-pane AgentLoop interaction while replacing the provider Web UI with a typed session surface", async () => {
    const controller = fakeController();
    const { container } = render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController(), workspaceName: "Review workspace" }));

    await screen.findByRole("heading", { name: "Review runtime migration" });
    expect(screen.getByRole("navigation", { name: "AgentLoop 页面" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Task Sessions" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Task Session Tabs" })).toBeTruthy();
    expect(screen.getByLabelText("Task → Conductor")).toBeTruthy();
    expect(screen.getAllByText("Check the unified Runtime route.").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("仅属于 Worker 的未转递消息")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.change(screen.getByLabelText("Task → Conductor"), { target: { value: "  继续核实 provider receipt  " } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Conductor" }));

    await waitFor(() => expect(controller.createInputSubmissionIntent).toHaveBeenCalledWith(
      "task_1",
      3,
      "logical_session_conductor",
      "继续核实 provider receipt",
    ));
    await waitFor(() => expect(controller.submitTaskInput).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task_1",
      targetLogicalSessionId: "logical_session_conductor",
    })));
  });

  it("keeps a busy Card draft visible while scoped interrupt confirmation is pending", async () => {
    const controller = fakeController();
    vi.mocked(controller.submitTaskInput).mockResolvedValueOnce({
      state: "interrupting",
      humanInterventionId: "human_intervention_busy",
    });
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));

    fireEvent.click(await screen.findByRole("tab", { name: /Researcher/ }));
    expect(controller.submitTaskInput).not.toHaveBeenCalled();
    expect(controller.startTask).not.toHaveBeenCalled();
    expect(controller.stopTask).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Task → Conductor")).toBeTruthy();
    const composer = await screen.findByLabelText("human → Card Researcher / 全文同步 Conductor");
    fireEvent.change(composer, { target: { value: "  使用修正后的前提  " } });
    fireEvent.click(within(composer.closest("form")!).getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/已记录 scoped interrupt/)).toBeTruthy();
    expect((screen.getByLabelText("human → Card Researcher / 全文同步 Conductor") as HTMLTextAreaElement).value).toBe("  使用修正后的前提  ");
    expect(controller.submitTaskInput).toHaveBeenCalledWith(expect.objectContaining({
      targetLogicalSessionId: "logical_session_worker",
      content: "使用修正后的前提",
    }));
  });

  it("keeps Task→Conductor and human→Card composers separately bound while a Worker tab is selected", async () => {
    const controller = fakeController();
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));

    fireEvent.click(await screen.findByRole("tab", { name: /Researcher/ }));
    const taskComposer = screen.getByLabelText("Task → Conductor");
    const cardComposer = screen.getByLabelText("human → Card Researcher / 全文同步 Conductor");

    fireEvent.change(taskComposer, { target: { value: "Conductor follow-up" } });
    fireEvent.click(within(taskComposer.closest("form")!).getByRole("button", { name: "发送给 Conductor" }));
    await waitFor(() => expect(controller.createInputSubmissionIntent).toHaveBeenCalledWith(
      "task_1", 3, "logical_session_conductor", "Conductor follow-up",
    ));

    fireEvent.change(cardComposer, { target: { value: "Card correction" } });
    fireEvent.click(within(cardComposer.closest("form")!).getByRole("button", { name: "发送" }));
    await waitFor(() => expect(controller.createInputSubmissionIntent).toHaveBeenCalledWith(
      "task_1", 3, "logical_session_worker", "Card correction",
    ));
    expect(controller.startTask).not.toHaveBeenCalled();
    expect(controller.stopTask).not.toHaveBeenCalled();
  });

  it("renders HTML artifact content only in the strict sandbox preview", async () => {
    const controller = fakeController();
    const current = view();
    vi.mocked(controller.load).mockResolvedValue({
      ...current,
      selectedTask: current.selectedTask ? {
        ...current.selectedTask,
        artifacts: [{ artifactId: "artifact_html", displayName: "report.html", contentDigest: "html-digest", verifiedAt: "2026-08-06T00:02:00.000Z" }],
      } : undefined,
    });
    vi.mocked(controller.previewArtifact).mockResolvedValue({
      artifactId: "artifact_html",
      taskId: "task_1",
      displayName: "report.html",
      state: "available",
      contentType: "text/html",
      content: '<h1>Report</h1><script>globalThis.__agentWorkspaceHtmlExecuted = true</script>',
    });
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));

    fireEvent.click(await screen.findByRole("button", { name: "预览 report.html" }));
    const frame = await screen.findByTitle("report.html HTML preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("script-src 'none'");
    expect(screen.queryByLabelText("产物文本内容")).toBeNull();
    expect((globalThis as Record<string, unknown>).__agentWorkspaceHtmlExecuted).toBeUndefined();
  });

  it("offers Achieve as a direct user action even when the Run remains active", async () => {
    const controller = fakeController();
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));

    await screen.findByRole("button", { name: "Achieve" });
    fireEvent.click(screen.getByRole("button", { name: "Achieve" }));

    await waitFor(() => expect(controller.achieveTask).toHaveBeenCalledWith("task_1", 3));
    expect(screen.queryByText(/delivery_ready/i)).toBeNull();
  });

  it("opens the Runtime-backed Task drawer instead of a legacy OpenCode creation page", async () => {
    const controller = fakeController();
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));

    await screen.findByRole("button", { name: "新建 Task" });
    fireEvent.click(screen.getByRole("button", { name: "新建 Task" }));

    expect(await screen.findByRole("dialog", { name: "新建 Task" })).toBeTruthy();
    expect(screen.getByLabelText("选择 Template Version")).toBeTruthy();
    expect(screen.getByLabelText("授权项目目录")).toBeTruthy();
  });

  it("moves from exact Version selection through durable Task Setup, then returns to Tasks without auto-starting", async () => {
    const controller = fakeController();
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      workspaces: [{ workspaceId: "workspace_1", displayName: "Review workspace", authorizedAt: "2026-08-06T00:00:00.000Z" }],
    });
    const configurationController = fakeConfigurationController();
    const setupController = configurationController.taskSetup("task_setup_draft_1");
    render(createElement(AgentLoopRuntimeApp, {
      configurationController,
      controller,
      templateStudioController: fakeTemplateStudioController(),
    }));

    fireEvent.click(await screen.findByRole("button", { name: "新建 Task" }));
    await screen.findByRole("option", { name: "v1（当前）" });
    fireEvent.change(screen.getByLabelText("Task 名称"), { target: { value: "DeepSearch review" } });
    fireEvent.change(screen.getByLabelText("Task 目标"), { target: { value: "Research the stock and return HTML." } });
    fireEvent.change(screen.getByLabelText("选择已授权项目"), { target: { value: "workspace_1" } });
    fireEvent.click(screen.getByRole("button", { name: "继续 Task Setup" }));

    expect(await screen.findByRole("heading", { name: "Task Setup" })).toBeTruthy();
    expect(configurationController.createTaskSetupDraft).toHaveBeenCalledWith({
      templateVersionId: "template_version_1",
      workspaceId: "workspace_1",
      title: "DeepSearch review",
      goal: "Research the stock and return HTML.",
    });
    expect(controller.startTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "创建 Task" }));
    await waitFor(() => expect(setupController.createTask).toHaveBeenCalledWith({
      taskSetupDraftId: "task_setup_draft_1",
      expectedRevision: 1,
    }));
    expect(await screen.findByRole("heading", { name: "Review runtime migration" })).toBeTruthy();
    expect(controller.startTask).not.toHaveBeenCalled();
  });

  it("coalesces a 1k activity invalidation burst into bounded single-flight loads", async () => {
    const controller = fakeController();
    let listener: ((invalidation: RuntimeInvalidation) => void) | undefined;
    vi.mocked(controller.subscribe).mockImplementation(async (onChanged) => {
      listener = onChanged;
      return () => undefined;
    });
    let blockLoads = false;
    let activeLoads = 0;
    let peakConcurrentLoads = 0;
    const releases: Array<() => void> = [];
    vi.mocked(controller.load).mockImplementation(async () => {
      if (blockLoads) {
        activeLoads += 1;
        peakConcurrentLoads = Math.max(peakConcurrentLoads, activeLoads);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeLoads -= 1;
      }
      return view();
    });
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));
    await screen.findByRole("heading", { name: "Review runtime migration" });
    const baselineLoads = vi.mocked(controller.load).mock.calls.length;
    blockLoads = true;
    vi.useFakeTimers();

    act(() => {
      for (let sequence = 1; sequence <= 1_000; sequence += 1) {
        listener?.(runtimeInvalidation(sequence, ["provider_fact_reconciled"]));
      }
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(vi.mocked(controller.load).mock.calls.length - baselineLoads).toBe(1);
    expect(activeLoads).toBe(1);
    expect(peakConcurrentLoads).toBe(1);

    act(() => listener?.(runtimeInvalidation(1_001, ["provider_fact_reconciled", "message_changed"])));
    await act(async () => { await Promise.resolve(); });
    expect(vi.mocked(controller.load).mock.calls.length - baselineLoads).toBe(1);
    expect(peakConcurrentLoads).toBe(1);

    await act(async () => {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(controller.load).mock.calls.length - baselineLoads).toBe(2);
    expect(peakConcurrentLoads).toBe(1);

    await act(async () => {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(activeLoads).toBe(0);
  });

  it("refreshes immediately for semantic invalidation and cancels a redundant activity timer", async () => {
    const controller = fakeController();
    let listener: ((invalidation: RuntimeInvalidation) => void) | undefined;
    vi.mocked(controller.subscribe).mockImplementation(async (onChanged) => {
      listener = onChanged;
      return () => undefined;
    });
    render(createElement(AgentLoopRuntimeApp, { configurationController: fakeConfigurationController(), controller, templateStudioController: fakeTemplateStudioController() }));
    await screen.findByRole("heading", { name: "Review runtime migration" });
    const baselineLoads = vi.mocked(controller.load).mock.calls.length;
    vi.useFakeTimers();

    act(() => {
      listener?.(runtimeInvalidation(1, ["provider_fact_reconciled"]));
      listener?.(runtimeInvalidation(2, ["message_changed"]));
    });
    await act(async () => { await Promise.resolve(); });

    expect(vi.mocked(controller.load).mock.calls.length - baselineLoads).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(vi.mocked(controller.load).mock.calls.length - baselineLoads).toBe(1);
  });
});

function fakeController(): AgentLoopRuntimeController & Record<string, ReturnType<typeof vi.fn>> {
  const createInputSubmissionIntent = vi.fn((taskId: string, expectedRevision: number, targetLogicalSessionId: string, content: string) => ({
    commandId: "command_input_1",
    humanInterventionId: "human_intervention_1",
    taskId,
    expectedRevision,
    targetLogicalSessionId,
    content,
  }));
  return {
    load: vi.fn(async () => view()),
    subscribe: vi.fn(async () => () => undefined),
    authorizeWorkspace: vi.fn(async () => ({ workspaceId: "workspace_1", displayName: "Review workspace", authorizedAt: "2026-08-06T00:00:00.000Z" })),
    startTask: vi.fn(async () => undefined),
    restartTask: vi.fn(async () => undefined),
    resumeTask: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    achieveTask: vi.fn(async () => undefined),
    archiveTask: vi.fn(async () => undefined),
    restoreTask: vi.fn(async () => undefined),
    previewPermanentDelete: vi.fn(async () => ({ taskId: "task_1", expectedRevision: 3, artifacts: [] })),
    permanentlyDeleteTask: vi.fn(async () => ({ taskId: "task_1", deletedArtifactIds: [], skippedArtifacts: [], deletedAt: "2026-08-06T00:00:00.000Z" })),
    previewArtifact: vi.fn(async () => ({ artifactId: "artifact_1", taskId: "task_1", displayName: "result.md", state: "available" as const, content: "verified" })),
    createInputSubmissionIntent,
    submitTaskInput: vi.fn(async () => ({ state: "sent" as const })),
    respondAttention: vi.fn(async () => undefined),
  };
}

function fakeConfigurationController(): AgentLoopConfigurationController & Record<string, unknown> {
  const setupView = taskSetupView();
  const setup = {
    load: vi.fn(async () => setupView),
    saveDraft: vi.fn(async () => setupView),
    createTask: vi.fn(async () => "task_created"),
    abandonDraft: vi.fn(async () => undefined),
  };
  return {
    meta: {
      load: vi.fn(async () => ({ profileOptions: [], proposals: [] })),
      createSession: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      applyPatch: vi.fn(async () => undefined),
      rejectPatch: vi.fn(async () => undefined),
      abandonSession: vi.fn(async () => undefined),
    },
    createTaskSetupDraft: vi.fn(async () => "task_setup_draft_1"),
    taskSetup: vi.fn(() => setup),
  };
}

function taskSetupView(): AgentLoopTaskSetupViewModel {
  return {
    draft: {
      taskSetupDraftId: "task_setup_draft_1",
      revision: 1,
      state: "draft",
      templateVersion: { templateId: "template_1", templateVersionId: "template_version_1", templateTitle: "Review template", version: 1 },
      workspaceId: "workspace_1",
      title: "Review task",
      goal: "Review the runtime.",
      schemaFields: [],
      validationIssues: [],
      valid: true,
    },
    workspaces: [{ workspaceId: "workspace_1", displayName: "Review workspace" }],
    profileOptions: [],
  };
}

function fakeTemplateStudioController(): AgentLoopTemplateStudioController {
  return {
    load: vi.fn(async (templateId?: string) => ({
      generatedAt: "2026-08-06T00:00:00.000Z",
      templates: [{ templateId: "template_1", title: "Review template", slug: "review", revision: 1, currentVersion: { templateVersionId: "template_version_1", version: 1, definitionHash: "hash", createdAt: "2026-08-06T00:00:00.000Z", publishedAt: "2026-08-06T00:00:00.000Z", definitionText: "{}" } }],
      ...(templateId ? { selectedTemplate: { templateId, title: "Review template", slug: "review", revision: 1, activeTemplateVersionId: "template_version_1", versions: [{ templateVersionId: "template_version_1", version: 1, definitionHash: "hash", createdAt: "2026-08-06T00:00:00.000Z", publishedAt: "2026-08-06T00:00:00.000Z", definitionText: "{}" }] } } : {}),
      drafts: [],
    })),
    subscribe: vi.fn(async () => () => undefined),
    createDraft: vi.fn(async (editor) => editor),
    saveDraft: vi.fn(async (editor) => editor),
    publishDraft: vi.fn(async () => undefined),
    previewImport: vi.fn(async () => { throw new Error("not_used_in_task_test"); }),
    importPreview: vi.fn(async () => undefined),
    discardImportPreview: vi.fn(() => undefined),
    exportVersion: vi.fn(async () => { throw new Error("not_used_in_task_test"); }),
  };
}

function view(): AgentLoopRuntimeViewModel {
  return {
    generatedAt: "2026-08-06T00:00:00.000Z",
    workspaces: [],
    templates: [{
      templateId: "template_1",
      title: "Review template",
      slug: "review",
      revision: 1,
      activeVersion: { templateVersionId: "template_version_1", version: 1, createdAt: "2026-08-06T00:00:00.000Z" },
    }],
    tasks: [{
      taskId: "task_1",
      title: "Review runtime migration",
      goal: "Check the unified Runtime route.",
      status: "running",
      revision: 3,
      activeRunId: "run_1",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    }],
    selectedTask: {
      task: {
        taskId: "task_1",
        title: "Review runtime migration",
        goal: "Check the unified Runtime route.",
        status: "running",
        revision: 3,
        activeRunId: "run_1",
        createdAt: "2026-08-06T00:00:00.000Z",
        updatedAt: "2026-08-06T00:00:00.000Z",
      },
      activeRun: { runId: "run_1", status: "running", conductorLogicalSessionId: "logical_session_conductor", runNumber: 1 },
      sessions: [{
        logicalSessionId: "logical_session_conductor",
        agentCardId: "agent_card_conductor",
        title: "Conductor",
        kind: "conductor",
        status: "active",
        executionProfileId: "profile_conductor",
        binding: { bindingId: "binding_1", provider: "codex", status: "active", recoverable: true },
      }, {
        logicalSessionId: "logical_session_worker",
        agentCardId: "agent_card_worker",
        title: "Researcher",
        kind: "card",
        status: "active",
        executionProfileId: "profile_worker",
        binding: { bindingId: "binding_worker", provider: "codex", status: "active", recoverable: true },
      }],
      messages: [{
        messageId: "message_goal",
        kind: "task_goal",
        content: "Check the unified Runtime route.",
        contentDigest: "goal-digest",
        createdAt: "2026-08-06T00:00:00.000Z",
        relayBlocks: [],
        inboxDeliveries: [{
          inboxItemId: "inbox_goal",
          targetLogicalSessionId: "logical_session_conductor",
          route: "message",
          state: "delivered",
          createdAt: "2026-08-06T00:00:00.000Z",
          updatedAt: "2026-08-06T00:00:00.000Z",
        }],
      }, {
        messageId: "message_worker_private",
        kind: "agent_final",
        sourceLogicalSessionId: "logical_session_worker",
        content: "仅属于 Worker 的未转递消息",
        contentDigest: "private-digest",
        createdAt: "2026-08-06T00:01:00.000Z",
        relayBlocks: [],
        inboxDeliveries: [],
      }],
      executionGroups: [],
      timeline: [{
        timelineItemId: "timeline_1",
        kind: "provider_turn_completed",
        occurredAt: "2026-08-06T00:01:00.000Z",
        taskId: "task_1",
        logicalSessionId: "logical_session_conductor",
        title: "Conductor 已完成分析",
        detail: "请确认下一次输入。",
        status: "completed",
      }],
      attentions: [],
      artifacts: [],
    },
  };
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
