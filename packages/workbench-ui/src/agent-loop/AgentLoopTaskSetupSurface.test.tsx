// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLoopMetaPanelController } from "./AgentLoopMetaPanel";
import {
  AgentLoopTaskSetupSurface,
  type AgentLoopTaskSetupController,
  type AgentLoopTaskSetupViewModel,
} from "./AgentLoopTaskSetupSurface";

afterEach(cleanup);

describe("AgentLoopTaskSetupSurface", () => {
  it("keeps Setup as a two-column Draft surface and separates Save from Create", async () => {
    const controller = fakeController();
    const onCreated = vi.fn();
    const { container } = render(createElement(AgentLoopTaskSetupSurface, {
      controller,
      metaController: fakeMetaController(),
      onBack: vi.fn(),
      onCreated,
    }));

    expect(await screen.findByRole("region", { name: "Task Setup" })).toBeTruthy();
    expect(container.querySelector(".awb-agent-loop-task-setup-grid")?.children).toHaveLength(2);
    expect(screen.getByText("Research team · v3")).toBeTruthy();
    expect(screen.getByText("Codex · gpt-5.4")).toBeTruthy();
    expect(screen.getByText("OpenCode · opencode/deepseek-v4")).toBeTruthy();
    expect(screen.getByText("interrupt capability 未验证")).toBeTruthy();
    expect(screen.getByText("版本不匹配")).toBeTruthy();
    expect((screen.getByRole("button", { name: "创建 Task" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Task 名称"), { target: { value: "核实 Provider 旅程" } });
    fireEvent.change(screen.getByLabelText("Task 目标"), { target: { value: "输出可审计的端到端证据。" } });
    fireEvent.change(screen.getByLabelText("证据格式"), { target: { value: "format_jsonl" } });
    expect(controller.createTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存 Setup Draft" }));
    await waitFor(() => expect(controller.saveDraft).toHaveBeenCalledWith({
      expectedRevision: 2,
      goal: "输出可审计的端到端证据。",
      schemaValues: { evidence_format: "format_jsonl" },
      taskSetupDraftId: "task_setup_draft_1",
      title: "核实 Provider 旅程",
      workspaceId: "workspace_1",
    }));
    expect(controller.createTask).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole("button", { name: "创建 Task" }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "创建 Task" }));
    await waitFor(() => expect(controller.createTask).toHaveBeenCalledWith({
      expectedRevision: 3,
      taskSetupDraftId: "task_setup_draft_1",
    }));
    expect(onCreated).toHaveBeenCalledWith("task_created");
  });

  it("does not abandon a durable Setup Draft when navigating back", async () => {
    const controller = fakeController();
    const onBack = vi.fn();
    render(createElement(AgentLoopTaskSetupSurface, { controller, onBack, onCreated: vi.fn() }));

    await screen.findByRole("heading", { name: "Task Setup" });
    fireEvent.click(screen.getByRole("button", { name: "返回任务" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(controller.abandonDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "放弃 Setup Draft" }));
    await waitFor(() => expect(controller.abandonDraft).toHaveBeenCalledWith({
      expectedRevision: 2,
      taskSetupDraftId: "task_setup_draft_1",
    }));
  });

  it("refreshes Provider readiness from Runtime invalidation without overwriting unsaved Setup input", async () => {
    let changed: (() => void) | undefined;
    const base = fakeController();
    const controller: AgentLoopTaskSetupController = {
      ...base,
      subscribe: vi.fn(async (onChanged) => {
        changed = onChanged;
        return () => undefined;
      }),
    };
    render(createElement(AgentLoopTaskSetupSurface, { controller, onBack: vi.fn(), onCreated: vi.fn() }));

    await screen.findByDisplayValue("Provider journey");
    fireEvent.change(screen.getByLabelText("Task 名称"), { target: { value: "尚未保存的名称" } });
    vi.mocked(base.load).mockResolvedValue(view({
      title: "Runtime 中的旧名称",
      valid: false,
    }));
    const refreshed = await base.load();
    vi.mocked(base.load).mockResolvedValue({
      ...refreshed,
      profileOptions: refreshed.profileOptions.map((profile) => profile.executionProfileId === "profile_opencode"
        ? { ...profile, unavailableReasons: ["provider_version_mismatch"] }
        : profile),
    });

    changed?.();

    await screen.findByText("provider_version_mismatch");
    expect((screen.getByLabelText("Task 名称") as HTMLInputElement).value).toBe("尚未保存的名称");
  });

  it("adopts a newer durable Draft when the local editor is clean", async () => {
    let changed: (() => void) | undefined;
    const base = fakeController();
    const controller: AgentLoopTaskSetupController = {
      ...base,
      subscribe: vi.fn(async (onChanged) => {
        changed = onChanged;
        return () => undefined;
      }),
    };
    render(createElement(AgentLoopTaskSetupSurface, { controller, onBack: vi.fn(), onCreated: vi.fn() }));

    await screen.findByDisplayValue("Provider journey");
    vi.mocked(base.load).mockResolvedValue(view({
      revision: 3,
      title: "Meta 已保存的新名称",
      goal: "Meta durable goal.",
    }));
    changed?.();

    expect(await screen.findByDisplayValue("Meta 已保存的新名称")).toBeTruthy();
    expect(screen.getByText("已保存 Draft r3")).toBeTruthy();
  });

  it("ignores an older invalidation load that resolves after the latest refresh", async () => {
    let changed: (() => void) | undefined;
    const first = deferred<AgentLoopTaskSetupViewModel>();
    const second = deferred<AgentLoopTaskSetupViewModel>();
    const base = fakeController();
    vi.mocked(base.load)
      .mockResolvedValueOnce(view())
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller: AgentLoopTaskSetupController = {
      ...base,
      subscribe: vi.fn(async (onChanged) => {
        changed = onChanged;
        return () => undefined;
      }),
    };
    render(createElement(AgentLoopTaskSetupSurface, { controller, onBack: vi.fn(), onCreated: vi.fn() }));

    await screen.findByDisplayValue("Provider journey");
    changed?.();
    changed?.();
    second.resolve(view({ revision: 4, title: "最新 durable 名称" }));
    expect(await screen.findByDisplayValue("最新 durable 名称")).toBeTruthy();
    first.resolve(view({ revision: 3, title: "过期 durable 名称" }));

    await waitFor(() => expect(screen.queryByDisplayValue("过期 durable 名称")).toBeNull());
    expect((screen.getByLabelText("Task 名称") as HTMLInputElement).value).toBe("最新 durable 名称");
  });

  it("keeps the old revision fence when a remote Draft advances over local edits", async () => {
    let changed: (() => void) | undefined;
    const base = fakeController();
    const controller: AgentLoopTaskSetupController = {
      ...base,
      subscribe: vi.fn(async (onChanged) => {
        changed = onChanged;
        return () => undefined;
      }),
    };
    vi.mocked(base.saveDraft).mockRejectedValue(new Error("expected_revision_stale"));
    render(createElement(AgentLoopTaskSetupSurface, { controller, onBack: vi.fn(), onCreated: vi.fn() }));

    await screen.findByDisplayValue("Provider journey");
    fireEvent.change(screen.getByLabelText("Task 名称"), { target: { value: "我的未保存名称" } });
    vi.mocked(base.load).mockResolvedValue(view({ revision: 3, title: "另一窗口已保存的名称" }));
    changed?.();

    expect((await screen.findByRole("alert")).textContent).toContain("task_setup_draft_changed_remotely");
    expect((screen.getByLabelText("Task 名称") as HTMLInputElement).value).toBe("我的未保存名称");
    fireEvent.click(screen.getByRole("button", { name: "保存 Setup Draft" }));
    await waitFor(() => expect(base.saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 2,
      title: "我的未保存名称",
    })));
    expect((await screen.findByRole("alert")).textContent).toContain("expected_revision_stale");
  });

  it("resets local edits after an explicit Abandon", async () => {
    const base = fakeController();
    vi.mocked(base.load)
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ state: "abandoned", revision: 3, title: "Durable abandoned name" }));
    render(createElement(AgentLoopTaskSetupSurface, { controller: base, onBack: vi.fn(), onCreated: vi.fn() }));

    await screen.findByDisplayValue("Provider journey");
    fireEvent.change(screen.getByLabelText("Task 名称"), { target: { value: "即将丢弃的本地名称" } });
    fireEvent.click(screen.getByRole("button", { name: "放弃 Setup Draft" }));

    expect(await screen.findByDisplayValue("Durable abandoned name")).toBeTruthy();
    expect(screen.queryByDisplayValue("即将丢弃的本地名称")).toBeNull();
  });
});

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fakeController(): AgentLoopTaskSetupController & Record<string, ReturnType<typeof vi.fn>> {
  const saved = view({
    revision: 3,
    valid: true,
    title: "核实 Provider 旅程",
    goal: "输出可审计的端到端证据。",
    schemaFields: [{
      fieldId: "evidence_format",
      label: "证据格式",
      kind: "choice",
      required: true,
      value: "format_jsonl",
      options: [{ optionId: "format_markdown", label: "Markdown" }, { optionId: "format_jsonl", label: "JSONL ledger" }],
    }],
  });
  return {
    load: vi.fn(async () => view()),
    saveDraft: vi.fn(async () => saved),
    createTask: vi.fn(async () => "task_created"),
    abandonDraft: vi.fn(async () => undefined),
  };
}

function fakeMetaController(): AgentLoopMetaPanelController {
  return {
    load: vi.fn(async () => ({
      profileOptions: [{
        metaProfileOptionId: "meta_option_codex",
        label: "Codex · gpt-5.4",
        detail: "0.146.0",
        readiness: "available" as const,
        unavailableReasons: [],
      }],
      proposals: [],
    })),
    createSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    applyPatch: vi.fn(async () => undefined),
    rejectPatch: vi.fn(async () => undefined),
    abandonSession: vi.fn(async () => undefined),
  };
}

function view(overrides: Partial<AgentLoopTaskSetupViewModel["draft"]> = {}): AgentLoopTaskSetupViewModel {
  return {
    draft: {
      taskSetupDraftId: "task_setup_draft_1",
      revision: 2,
      state: "draft",
      templateVersion: {
        templateId: "template_research",
        templateVersionId: "template_version_research_v3",
        templateTitle: "Research team",
        version: 3,
      },
      workspaceId: "workspace_1",
      title: "Provider journey",
      goal: "Capture evidence.",
      schemaFields: [{
        fieldId: "evidence_format",
        label: "证据格式",
        kind: "choice",
        required: true,
        value: "format_markdown",
        options: [{ optionId: "format_markdown", label: "Markdown" }, { optionId: "format_jsonl", label: "JSONL ledger" }],
      }],
      validationIssues: [],
      valid: false,
      ...overrides,
    },
    workspaces: [{ workspaceId: "workspace_1", displayName: "Agent Workspace" }],
    profileOptions: [
      {
        executionProfileId: "profile_codex",
        provider: "codex",
        providerLabel: "Codex",
        model: "gpt-5.4",
        providerVersion: "0.146.0",
        permissionMode: "deny",
        requiredCapabilities: ["interrupt"],
        readiness: "available",
        unavailableReasons: [],
      },
      {
        executionProfileId: "profile_opencode",
        provider: "opencode",
        providerLabel: "OpenCode",
        model: "opencode/deepseek-v4",
        providerVersion: "1.18.13",
        permissionMode: "ask",
        requiredCapabilities: ["interrupt"],
        readiness: "version_mismatch",
        unavailableReasons: ["interrupt capability 未验证"],
      },
    ],
  };
}
