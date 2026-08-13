// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLoopMetaPanelController } from "./AgentLoopMetaPanel";
import {
  AgentLoopTaskSetupSurface,
  type AgentLoopTaskSetupController,
  type AgentLoopTaskSetupProfileOptionV3,
  type AgentLoopTaskSetupViewModel,
} from "./AgentLoopTaskSetupSurface";

afterEach(cleanup);

describe("AgentLoopTaskSetupSurface", () => {
  it("keeps the Setup Draft form visible and separates Save from Create", async () => {
    const controller = fakeController();
    const onCreated = vi.fn();
    const { container } = render(createElement(AgentLoopTaskSetupSurface, {
      controller,
      metaController: fakeMetaController(),
      onBack: vi.fn(),
      onCreated,
    }));

    expect(await screen.findByRole("region", { name: "Task Setup" })).toBeTruthy();
    expect(container.querySelector(".awb-agent-loop-task-setup-editor")).toBeTruthy();
    expect(screen.getByText("Research team · v3")).toBeTruthy();
    expect(screen.getByText("Codex ACP")).toBeTruthy();
    expect(screen.getByText("Native ACP")).toBeTruthy();
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.getByText("opencode-go/gpt-5.6-luna")).toBeTruthy();
    expect(screen.getByText("acp_capability_missing")).toBeTruthy();
    expect(screen.getByText("能力缺失")).toBeTruthy();
    expect(screen.getByText("0.147.0")).toBeTruthy();
    expect(screen.getAllByText("1.18.13")).toHaveLength(2);
    expect(screen.queryByText(/sha256|fingerprint|template-codex-version/iu)).toBeNull();
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

  it("opens Meta explicitly as floating, loads without creating a session, and can dock beside the form", async () => {
    const metaController = fakeMetaController();
    const { container } = render(createElement(AgentLoopTaskSetupSurface, {
      controller: fakeController(),
      metaController,
      onBack: vi.fn(),
      onCreated: vi.fn(),
    }));

    await screen.findByDisplayValue("Provider journey");
    expect(screen.queryByRole("complementary", { name: "Meta Agent panel" })).toBeNull();
    expect(screen.getByRole("region", { name: "Task Setup fields" })).toBeTruthy();
    expect(metaController.load).not.toHaveBeenCalled();
    expect(metaController.createSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "AI 协助填写" }));

    const floating = await screen.findByRole("complementary", { name: "Meta Agent panel" });
    expect(floating.className).toContain("is-floating");
    expect(metaController.load).toHaveBeenCalledWith({
      kind: "task_setup",
      draftId: "task_setup_draft_1",
      draftRevision: 2,
    });
    expect(metaController.createSession).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Task Setup fields" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "停靠 Meta panel" }));
    expect(screen.getByRole("complementary", { name: "Meta Agent panel" }).className).toContain("is-docked");
    expect(container.querySelector(".awb-agent-loop-task-setup-grid")?.children).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Task Setup fields" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭 Meta panel" }));
    expect(screen.queryByRole("complementary", { name: "Meta Agent panel" })).toBeNull();
    expect(screen.getByRole("region", { name: "Task Setup fields" })).toBeTruthy();
    expect(metaController.abandonSession).not.toHaveBeenCalled();
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

  it("keeps a consumed Setup form visible without exposing a Meta opener", async () => {
    const controller = fakeController();
    const metaController = fakeMetaController();
    vi.mocked(controller.load).mockResolvedValue(view({ state: "consumed", revision: 3 }));
    render(createElement(AgentLoopTaskSetupSurface, {
      controller,
      metaController,
      onBack: vi.fn(),
      onCreated: vi.fn(),
    }));

    expect(await screen.findByRole("region", { name: "Task Setup fields" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AI 协助填写" })).toBeNull();
    expect(metaController.load).not.toHaveBeenCalled();
    expect(metaController.createSession).not.toHaveBeenCalled();
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
        && profile.schemaVersion === 3
        ? unavailableProfile(profile)
        : profile),
    });

    changed?.();

    await screen.findByText("acp_transport_observation_drift");
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

function fakeMetaController(): AgentLoopMetaPanelController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    load: vi.fn(async () => ({
      profileOptions: [{
        schemaVersion: 3 as const,
        metaProfileOptionId: "meta_option_codex",
        label: "Codex · gpt-5.6-luna",
        providerFamily: "codex" as const,
        model: "gpt-5.6-luna",
        configIntent: { reasoningEffort: "high" },
        readiness: {
          profileRevisionId: "profile_revision_meta-codex-luna-v1",
          providerFamily: "codex" as const,
          acpAgentKind: "codex_acp" as const,
          role: "meta" as const,
          status: "available" as const,
          reasons: [],
          missingCapabilities: [],
          missingExtensions: [],
          model: "gpt-5.6-luna",
          observedProtocolMajor: 1 as const,
          observedAgent: { name: "codex-acp", version: "current" },
        },
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
    profileOptions: [taskProfileOption("codex", "available"), taskProfileOption("opencode", "capability_missing")],
  };
}

function taskProfileOption(
  family: "codex" | "opencode",
  status: "available" | "capability_missing",
): AgentLoopTaskSetupProfileOptionV3 {
  const codex = family === "codex";
  return {
    schemaVersion: 3,
    executionProfileId: `profile_${family}`,
    permissionMode: codex ? "deny" : "ask",
    allowedTools: [],
    requiredCapabilities: ["interrupt"],
    requiredExtensions: [],
    readiness: {
      profileRevisionId: `profile_revision_${family}-task-v1`,
      providerFamily: family,
      acpAgentKind: codex ? "codex_acp" : "native_acp",
      role: "conductor",
      status,
      reasons: status === "available" ? [] : ["acp_capability_missing"],
      missingCapabilities: status === "available" ? [] : ["interrupt"],
      missingExtensions: [],
      model: codex ? "gpt-5.6-sol" : "opencode-go/gpt-5.6-luna",
      observedProtocolMajor: 1,
      observedAgent: codex
        ? { name: "codex-acp", version: "0.9.4" }
        : { name: "opencode", version: "1.18.13" },
      observedArtifactVersion: codex ? "0.9.4" : "1.18.13",
      observedUpstreamVersion: codex ? "0.147.0" : "1.18.13",
      observedCapabilities: status === "available" ? ["interrupt"] : [],
      observedExtensions: [],
    },
  };
}

function unavailableProfile(profile: AgentLoopTaskSetupProfileOptionV3): AgentLoopTaskSetupProfileOptionV3 {
  return {
    ...profile,
    readiness: {
      ...profile.readiness,
      status: "unavailable",
      reasons: ["acp_transport_observation_drift"],
      missingCapabilities: [],
      missingExtensions: [],
    },
  };
}
