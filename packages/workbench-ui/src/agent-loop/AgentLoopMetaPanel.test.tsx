// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentLoopMetaPanel,
  type AgentLoopMetaPanelController,
  type AgentLoopMetaPanelViewModel,
  type AgentLoopMetaProfileOptionV3,
} from "./AgentLoopMetaPanel";

afterEach(cleanup);

describe("AgentLoopMetaPanel", () => {
  it("shows the scoped Meta profile, chat, ordered proposal diff, and separate Apply/Reject actions", async () => {
    const controller = fakeController();
    const initialView = view();
    vi.mocked(controller.load).mockResolvedValue({
      ...initialView,
      session: initialView.session ? {
        ...initialView.session,
        messages: [{
          messageId: "meta_message_user",
          role: "user",
          content: "请收窄 Worker 的职责。",
          createdAt: "2026-08-08T23:59:00.000Z",
        }, ...initialView.session.messages],
      } : undefined,
    });
    const onPatchApplied = vi.fn(async () => undefined);
    const { container } = render(createElement(AgentLoopMetaPanel, {
      controller,
      draftDirty: false,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      onPatchApplied,
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    expect(await screen.findByRole("heading", { name: "Template Meta Agent" })).toBeTruthy();
    expect(container.querySelector(".awb-agent-chat-transcript")).toBeTruthy();
    expect(container.querySelector(".awb-agent-chat-composer")).toBeTruthy();
    expect(screen.getByText("Codex · gpt-5.6-luna · high")).toBeTruthy();
    expect(screen.getByText("本 Session 已锁定")).toBeTruthy();
    expect(screen.queryByLabelText("Meta Provider")).toBeNull();
    expect(screen.queryByText("codex-acp 0.9.4")).toBeNull();
    expect(screen.queryByText("0.147.0")).toBeNull();
    expect(screen.queryByText(/sha256|fingerprint/iu)).toBeNull();
    expect(screen.getByText("请收窄 Worker 的职责。")).toBeTruthy();
    expect(screen.getByText("把 Worker 的职责收窄，并补充验收条件。")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Meta conversation" })).queryByText("你")).toBeNull();
    const conversation = screen.getByRole("region", { name: "Meta conversation" });
    const proposal = within(conversation).getByRole("region", { name: "Meta patch proposal" });
    expect(within(conversation).getByText("读取 Template Draft")).toBeTruthy();
    expect(within(conversation).getByLabelText("已完成")).toBeTruthy();
    expect(proposal.closest("li")?.textContent).toContain("把 Worker 的职责收窄，并补充验收条件。");
    expect(within(conversation).queryByText("候选 Patch · 收窄 Worker 责任边界")).toBeNull();
    expect(screen.queryByRole("region", { name: "Meta proposals" })).toBeNull();
    expect(within(proposal).getAllByTestId("meta-diff-path").map((node) => node.textContent)).toEqual([
      "conductor.systemPrompt",
      "agentCards[0].role",
      "definition.agentCards[Search Agent 1]",
    ]);
    expect(within(proposal).getAllByText(/Search Agent 1/)).toHaveLength(2);
    expect(within(proposal).getByText("确认是否保留原 deliverable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /发布|创建 Task|启动/i })).toBeNull();

    fireEvent.click(within(proposal).getByRole("button", { name: "应用 patch" }));
    await waitFor(() => expect(controller.applyPatch).toHaveBeenCalledWith({
      expectedDraftRevision: 3,
      proposalId: "meta_patch_1",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));
    expect(onPatchApplied).toHaveBeenCalledTimes(1);

    fireEvent.click(within(proposal).getByRole("button", { name: "拒绝 patch" }));
    await waitFor(() => expect(controller.rejectPatch).toHaveBeenCalledWith({
      expectedDraftRevision: 3,
      proposalId: "meta_patch_1",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));
  });

  it("keeps close/dock as view-only state and protects a dirty local editor from patch application", async () => {
    const controller = fakeController();
    const onClose = vi.fn();
    const onDockChange = vi.fn();
    render(createElement(AgentLoopMetaPanel, {
      controller,
      draftDirty: true,
      onClose,
      onDockChange,
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    const proposal = await screen.findByRole("region", { name: "Meta patch proposal" });
    expect((within(proposal).getByRole("button", { name: "应用 patch" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/先保存或撤销本地手工修改/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "停靠 Meta panel" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭 Meta panel" }));
    expect(onDockChange).toHaveBeenCalledWith("docked");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(controller.abandonSession).not.toHaveBeenCalled();
    expect(controller.applyPatch).not.toHaveBeenCalled();
    expect(controller.rejectPatch).not.toHaveBeenCalled();
  });

  it("abandons the frozen Meta Session only through an explicit New action", async () => {
    const controller = fakeController();
    const withoutSession: AgentLoopMetaPanelViewModel = {
      ...view(),
      session: undefined,
      proposals: [],
    };
    vi.mocked(controller.load)
      .mockResolvedValueOnce(view())
      .mockResolvedValue(withoutSession);
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    fireEvent.click(await screen.findByRole("button", { name: "新建 Meta Session" }));
    await waitFor(() => expect(controller.abandonSession).toHaveBeenCalledWith({
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
      metaSessionId: "meta_session_1",
      expectedSessionRevision: 2,
    }));
    expect(await screen.findByLabelText("Meta Provider")).toBeTruthy();
    expect(controller.createSession).not.toHaveBeenCalled();
  });

  it("keeps a proposal with unresolved validation issues visible but not applicable", async () => {
    const controller = fakeController();
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      proposals: view().proposals.map((proposal) => ({
        ...proposal,
        validationIssues: ["Publisher path remains outside the authorized Workspace."],
      })),
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    const proposal = await screen.findByRole("region", { name: "Meta patch proposal" });
    expect(within(proposal).getByText("Publisher path remains outside the authorized Workspace.")).toBeTruthy();
    const apply = within(proposal).getByRole("button", { name: "应用 patch" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(controller.applyPatch).not.toHaveBeenCalled();
  });

  it("projects real ACP options as Provider, Model, and Effort controls and creates the session on first send", async () => {
    const controller = fakeController();
    const scope = { kind: "task_setup" as const, draftId: "task_setup_draft_1", draftRevision: 2 };
    const options = [
      metaProfileOption("meta_option_unavailable", "Unavailable option", "unavailable"),
      metaProfileOption("meta_option_ready", "Ready option", "available"),
      {
        ...metaProfileOption("meta_option_claude", "Claude option", "available"),
        providerFamily: "claude-code" as const,
        model: "claude-opus-5[1M]",
        configIntent: { reasoningEffort: "max" },
        readiness: {
          ...metaProfileOption("meta_option_claude", "Claude option", "available").readiness,
          providerFamily: "claude-code" as const,
          acpAgentKind: "claude_agent_acp" as const,
          model: "claude-opus-5[1M]",
        },
      },
    ];
    const emptyView: AgentLoopMetaPanelViewModel = {
      ...view(),
      profileOptions: options,
      session: undefined,
    };
    const activeView: AgentLoopMetaPanelViewModel = {
      ...emptyView,
      session: {
        metaSessionId: "meta_session_created",
        metaProfileOptionId: "meta_option_claude",
        revision: 1,
        status: "idle",
        messages: [],
        activities: [],
      },
    };
    vi.mocked(controller.load).mockResolvedValueOnce(emptyView).mockResolvedValue(activeView);
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope,
    }));

    const provider = await screen.findByLabelText("Meta Provider");
    expect(screen.getByLabelText("Meta Model")).toBeTruthy();
    expect(screen.getByLabelText("Meta Effort")).toBeTruthy();
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Meta conversation" })).toBeTruthy();
    expect(screen.getByText("开始一次真实的 Draft 修订对话")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("发送给 Meta Agent") as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: /打开 Meta Session/ })).toBeNull();
    fireEvent.change(provider, { target: { value: "claude-code" } });
    await waitFor(() => expect((screen.getByLabelText("Meta Model") as HTMLSelectElement).value).toBe("claude-opus-5[1M]"));
    expect((screen.getByLabelText("Meta Effort") as HTMLSelectElement).value).toBe("max");
    fireEvent.change(screen.getByLabelText("发送给 Meta Agent"), { target: { value: "给出一个可审阅 Patch。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(controller.createSession).toHaveBeenCalledWith({
      metaProfileOptionId: "meta_option_claude",
      scope,
    }));
    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalledWith({
      scope,
      metaSessionId: "meta_session_created",
      expectedSessionRevision: 1,
      content: "给出一个可审阅 Patch。",
    }));
  });

  it("lets first send run the Host readiness probe for a checking option", async () => {
    const controller = fakeController();
    let releaseCreateSession!: () => void;
    vi.mocked(controller.createSession).mockImplementation(() => new Promise<void>((resolve) => {
      releaseCreateSession = resolve;
    }));
    const emptyView: AgentLoopMetaPanelViewModel = {
      ...view(),
      profileOptions: [metaProfileOption("meta_option_checking", "Checking option", "checking")],
      session: undefined,
    };
    vi.mocked(controller.load).mockResolvedValueOnce(emptyView).mockResolvedValue({
      ...emptyView,
      session: {
        metaSessionId: "meta_session_checking",
        metaProfileOptionId: "meta_option_checking",
        revision: 1,
        status: "idle",
        messages: [],
        activities: [],
      },
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 1 },
    }));

    const composer = await screen.findByLabelText("发送给 Meta Agent") as HTMLTextAreaElement;
    expect(screen.getAllByText("检查中").length).toBeGreaterThan(0);
    expect(screen.queryByText("不可用")).toBeNull();
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "检查并修订。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(controller.createSession).toHaveBeenCalledWith({
      metaProfileOptionId: "meta_option_checking",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 1 },
    }));
    expect((screen.getByLabelText("发送给 Meta Agent") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("检查并修订。")).toBeTruthy();
    expect(screen.getByText("正在验证 ACP 环境…")).toBeTruthy();

    releaseCreateSession();
    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalled());
  });

  it("restores the original message when first-send session creation fails", async () => {
    const controller = fakeController();
    vi.mocked(controller.createSession).mockRejectedValue(new Error("meta_agent_profile_unavailable"));
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      profileOptions: [metaProfileOption("meta_option_checking", "Checking option", "checking")],
      session: undefined,
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 1 },
    }));

    const composer = await screen.findByLabelText("发送给 Meta Agent") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "不要丢失这条指令。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByRole("alert");
    expect(composer.value).toBe("不要丢失这条指令。");
    expect(screen.queryByText("正在验证 ACP 环境…")).toBeNull();
    expect(controller.sendMessage).not.toHaveBeenCalled();
  });

  it("shows an active session directly and creates a Meta turn only after explicit send", async () => {
    const controller = fakeController();
    const scope = { kind: "task_setup" as const, draftId: "task_setup_draft_1", draftRevision: 3 };
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope,
    }));

    expect(await screen.findByText("把 Worker 的职责收窄，并补充验收条件。")).toBeTruthy();
    expect(controller.load).toHaveBeenCalledWith(scope);
    expect(controller.createSession).not.toHaveBeenCalled();
    expect(controller.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "打开 Meta Session" })).toBeNull();

    fireEvent.change(screen.getByLabelText("发送给 Meta Agent"), { target: { value: "给出一个可审阅的配置 patch。" } });
    expect(controller.sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalledWith({
      scope,
      metaSessionId: "meta_session_1",
      expectedSessionRevision: 2,
      content: "给出一个可审阅的配置 patch。",
    }));
    expect(controller.createSession).not.toHaveBeenCalled();
  });

  it("lets an existing failed Meta session reconnect even while its readiness cache is unavailable", async () => {
    const controller = fakeController();
    const scope = { kind: "template_design" as const, draftId: "template_draft_1", draftRevision: 3 };
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      profileOptions: [metaProfileOption("meta_option_codex", "Codex · gpt-5.6-luna", "unavailable")],
      session: {
        ...view().session!,
        status: "failed",
      },
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope,
    }));

    const composer = await screen.findByLabelText("发送给 Meta Agent") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    expect(composer.placeholder).toBe("上次连接失败；发送新消息会重新连接当前 Meta Session。");
    expect(screen.getByText("可重试")).toBeTruthy();
    expect(screen.queryByText("不可用")).toBeNull();
    fireEvent.change(composer, { target: { value: "重新连接并调用 Template MCP。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalledWith({
      scope,
      metaSessionId: "meta_session_1",
      expectedSessionRevision: 2,
      content: "重新连接并调用 Template MCP。",
    }));
    expect(controller.createSession).not.toHaveBeenCalled();
  });

  it("explains why a new Meta session cannot use the selected ACP profile", async () => {
    const controller = fakeController();
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      profileOptions: [metaProfileOption("meta_option_unavailable", "Codex · gpt-5.6-luna", "unavailable")],
      session: undefined,
      proposals: [],
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    const composer = await screen.findByLabelText("发送给 Meta Agent") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(composer.placeholder).toBe("当前配置未通过 ACP 验证；请选择其他配置或到设置中重新检测。");
    expect(screen.getByText("最近一次 ACP 资格探测失败。请选择其他 Provider / Model / Effort，或到设置刷新模型目录。")).toBeTruthy();
  });

  it("shows an incomplete turn as retryable instead of pretending recovery is still generating", async () => {
    const controller = fakeController();
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      profileOptions: [metaProfileOption("meta_option_codex", "Codex · gpt-5.6-luna", "unavailable")],
      session: {
        ...view().session!,
        status: "ambiguous",
      },
      proposals: [],
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    const composer = await screen.findByLabelText("发送给 Meta Agent") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    expect(composer.placeholder).toBe("本轮未完整结束；点击 New 开始新的 Meta Session。");
    expect(screen.getByText("需要重试")).toBeTruthy();
    expect(screen.getByText("本轮未完成")).toBeTruthy();
    expect(screen.queryByText("不可用")).toBeNull();
    expect(screen.getByRole("button", { name: "新建 Meta Session" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认中…" })).toBeNull();
  });

  it("submits the visible chat composer with Enter and keeps Shift+Enter as a newline", async () => {
    const controller = fakeController();
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    await screen.findByText("把 Worker 的职责收窄，并补充验收条件。");
    const composer = screen.getByLabelText("发送给 Meta Agent");
    fireEvent.change(composer, { target: { value: "重新审查来源与结论。" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(controller.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: "重新审查来源与结论。",
    })));
  });

  it("sends the explicit Template target with the user message instead of inferring it from the selected Card", async () => {
    const controller = fakeController();
    const scope = { kind: "template_design" as const, draftId: "template_draft_1", draftRevision: 3 };
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope,
      targets: [{ kind: "agent_card", agentCardId: "agent_card_worker", label: "Worker" }],
    }));

    await screen.findByText("把 Worker 的职责收窄，并补充验收条件。");
    expect(screen.getByRole("region", { name: "当前 AI 修订目标" }).textContent).toContain("@Worker");
    fireEvent.change(screen.getByLabelText("发送给 Meta Agent"), {
      target: { value: "把职责收窄，并明确验收标准。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalledWith({
      scope,
      metaSessionId: "meta_session_1",
      expectedSessionRevision: 2,
      content: "修改目标：@agent_card_worker（Worker）\n\n把职责收窄，并明确验收标准。",
    }));
  });

  it("explains that Meta is unavailable when the Runtime Host has no configured profile and never creates a session", async () => {
    const controller = fakeController();
    vi.mocked(controller.load).mockResolvedValue({
      profileOptions: [],
      session: undefined,
      proposals: [],
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    expect(await screen.findByText("此 Runtime Host 尚未配置 Meta Agent。Meta 仅在 Template Draft 和 Task Setup 中可用；请由 Host 管理员配置受验证的 Meta Profile。")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Meta conversation" })).toBeTruthy();
    expect((screen.getByLabelText("发送给 Meta Agent") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Meta Provider") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Meta Model") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Meta Effort") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("button", { name: /打开 Meta Session/ })).toBeNull();
    expect(controller.createSession).not.toHaveBeenCalled();
  });

  it("refreshes the active Meta conversation when Runtime reports configuration completion", async () => {
    let notify: (() => void) | undefined;
    const controller = {
      ...fakeController(),
      subscribe: vi.fn(async (listener: () => void) => {
        notify = listener;
        return () => undefined;
      }),
    };
    vi.mocked(controller.load)
      .mockResolvedValueOnce({
        ...view(),
        session: {
          metaSessionId: "meta_session_1",
          revision: 2,
          status: "creating",
          messages: [{
            messageId: "meta_message_user",
            role: "user",
            content: "请生成一个 HTML 配置 patch。",
            createdAt: "2026-08-09T00:00:00.000Z",
          }],
          activities: [{
            activityId: "provider_activity_meta_progress",
            kind: "assistant_progress",
            contentKind: "reasoning",
            content: "正在分析 Draft 约束…",
            observedAt: "2026-08-09T00:00:01.000Z",
          }],
        },
        proposals: [],
      })
      .mockResolvedValue(view());
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "floating",
      scope: { kind: "task_setup", draftId: "task_setup_draft_1", draftRevision: 3 },
    }));

    expect(await screen.findByText("正在生成完整响应")).toBeTruthy();
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("正在分析 Draft 约束…")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("发送给 Meta Agent") as HTMLTextAreaElement).disabled).toBe(false));
    await waitFor(() => expect(controller.subscribe).toHaveBeenCalledTimes(1));
    act(() => notify?.());

    expect(await screen.findByText("把 Worker 的职责收窄，并补充验收条件。")).toBeTruthy();
    expect((screen.getByLabelText("发送给 Meta Agent") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByRole("region", { name: "Meta patch proposal" })).toBeTruthy();
  });

  it("does not mislabel streamed response text as a candidate Patch while Provider terminal is ambiguous", async () => {
    const controller = fakeController();
    const wholeFinal = JSON.stringify({
      assistantMessage: "已生成中文 Prompt Patch。",
      proposal: {
        operations: [],
        summary: "中文化 Prompt",
        rationale: "保持职责不变。",
        validationIssues: [],
      },
    });
    vi.mocked(controller.load).mockResolvedValue({
      ...view(),
      session: {
        ...view().session!,
        status: "ambiguous",
        messages: view().session!.messages.filter((message) => message.role === "user"),
        activities: [{
          activityId: "provider_activity_meta_candidate",
          kind: "assistant_progress",
          contentKind: "response",
          content: wholeFinal,
          observedAt: "2026-08-14T08:03:51.000Z",
        }],
      },
      proposals: [],
    });
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    expect(await screen.findByText("这次生成未完整结束，因此没有创建可应用 Patch。点击 New 后重试；Draft 未被修改。")).toBeTruthy();
    expect(screen.queryByText(wholeFinal)).toBeNull();
    expect(screen.queryByText("回复过程")).toBeNull();
    expect(screen.queryByRole("region", { name: "Meta patch proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "确认中…" })).toBeNull();
  });

  it("keeps the composer editable while a Meta turn runs and sends one queued draft after settlement", async () => {
    let notify: (() => void) | undefined;
    const controller = {
      ...fakeController(),
      subscribe: vi.fn(async (listener: () => void) => {
        notify = listener;
        return () => undefined;
      }),
    };
    const runningView: AgentLoopMetaPanelViewModel = {
      ...view(),
      session: {
        ...view().session!,
        status: "creating",
        activities: [],
      },
      proposals: [],
    };
    vi.mocked(controller.load).mockResolvedValueOnce(runningView).mockResolvedValue(view());
    render(createElement(AgentLoopMetaPanel, {
      controller,
      onClose: vi.fn(),
      onDockChange: vi.fn(),
      placement: "docked",
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
    }));

    const composer = await screen.findByLabelText("发送给 Meta Agent") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "当前回复结束后再核对 Reviewer。" } });
    fireEvent.click(screen.getByRole("button", { name: "加入队列" }));

    expect(screen.getByRole("region", { name: "排队消息" })).toBeTruthy();
    expect(screen.getByText("当前回复结束后再核对 Reviewer。")).toBeTruthy();
    expect(controller.sendMessage).not.toHaveBeenCalled();

    act(() => notify?.());
    await waitFor(() => expect(controller.sendMessage).toHaveBeenCalledWith({
      scope: { kind: "template_design", draftId: "template_draft_1", draftRevision: 3 },
      metaSessionId: "meta_session_1",
      expectedSessionRevision: 2,
      content: "当前回复结束后再核对 Reviewer。",
    }));
    expect(screen.queryByRole("region", { name: "排队消息" })).toBeNull();
  });
});

function fakeController(): AgentLoopMetaPanelController & Record<string, ReturnType<typeof vi.fn>> {
  return {
    load: vi.fn(async () => view()),
    createSession: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    applyPatch: vi.fn(async () => undefined),
    rejectPatch: vi.fn(async () => undefined),
    abandonSession: vi.fn(async () => undefined),
  };
}

function view(): AgentLoopMetaPanelViewModel {
  return {
    profileOptions: [{
      ...metaProfileOption("meta_option_codex", "Codex · gpt-5.6-luna", "available"),
    }],
    session: {
      metaSessionId: "meta_session_1",
      metaProfileOptionId: "meta_option_codex",
      revision: 2,
      status: "idle",
      messages: [{
        messageId: "meta_message_1",
        role: "assistant",
        content: "把 Worker 的职责收窄，并补充验收条件。",
        createdAt: "2026-08-09T00:00:00.000Z",
        activities: [{
          activityId: "provider_activity_meta_tool_1",
          kind: "tool",
          title: "读取 Template Draft",
          status: "completed",
          observedAt: "2026-08-09T00:00:00.000Z",
        }],
      }],
      activities: [],
    },
    proposals: [{
      proposalId: "meta_patch_1",
      assistantMessageId: "meta_message_1",
      baseDraftRevision: 3,
      status: "pending",
      summary: "收窄 Worker 责任边界",
      rationale: "减少配置期权限扩张。",
      fieldDiffs: [
        { path: "conductor.systemPrompt", operation: "replace", before: "Coordinate.", after: "Coordinate bounded work." },
        { path: "agentCards[0].role", operation: "replace", before: "Research", after: "Research one scoped claim" },
        {
          path: "definition.agentCards[Search Agent 1]",
          operation: "add",
          after: JSON.stringify({
            agentCardId: "agent_card_search-1",
            kind: "researcher",
            title: "Search Agent 1",
            executionProfileId: "profile_researcher",
          }, null, 2),
        },
      ],
      validationIssues: [],
      unresolvedItems: ["确认是否保留原 deliverable"],
    }],
  };
}

function metaProfileOption(
  metaProfileOptionId: string,
  label: string,
  status: "available" | "unavailable" | "checking",
): AgentLoopMetaProfileOptionV3 {
  return {
    schemaVersion: 3,
    metaProfileOptionId,
    label,
    providerFamily: "codex",
    model: "gpt-5.6-luna",
    configIntent: { reasoningEffort: "high" },
    readiness: {
      profileRevisionId: `profile_revision_${metaProfileOptionId}`,
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      role: "meta",
      status,
      reasons: status === "available" ? [] : status === "checking" ? ["probe_pending"] : ["acp_profile_probe_failed"],
      missingCapabilities: [],
      missingExtensions: [],
      model: "gpt-5.6-luna",
      observedProtocolMajor: 1,
      observedAgent: { name: "codex-acp", title: "codex-acp", version: "0.9.4" },
      observedArtifactVersion: "0.9.4",
      observedUpstreamVersion: "0.147.0",
      observedCapabilities: [],
      observedExtensions: [],
    },
  };
}
