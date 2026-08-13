// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentLoopSessionIdTaskSurface,
  type AgentLoopSessionIdTaskSurfaceProps,
} from "./AgentLoopSessionIdTaskSurface";
import type {
  AgentLoopSessionIdDirectoryState,
  AgentLoopSessionIdHumanAbandonOutcome,
  AgentLoopSessionIdHumanMessageTarget,
  AgentLoopSessionIdHumanSendOutcome,
  AgentLoopSessionIdSession,
  AgentLoopSessionIdTaskReadModel,
} from "./agent-loop-session-id-runtime-controller";

afterEach(cleanup);

describe("AgentLoopSessionIdTaskSurface", () => {
  it("shows every Directory state and keeps no-session preview at zero commands until explicit send", async () => {
    const onPreviewDirectoryCard = vi.fn();
    const onSendHumanMessage = vi.fn(async () => ({
      humanInterventionId: "human_first",
      state: "sent" as const,
      targetLogicalSessionId: "session_materialized",
      materializedGeneration: 1,
    }));
    const { container } = render(<Harness
      model={model()}
      onPreviewDirectoryCard={onPreviewDirectoryCard}
      onSendHumanMessage={onSendHumanMessage}
    />);

    const directory = screen.getByRole("complementary", { name: "Card Directory" });
    for (const label of ["未建立 Session", "可用", "运行中", "等待用户介入收束", "等待选择", "核对中", "已关闭", "故障"]) {
      expect(within(directory).getByText(label)).toBeTruthy();
    }

    fireEvent.click(within(directory).getByRole("button", { name: /No session/u }));
    expect(onPreviewDirectoryCard).toHaveBeenCalledWith("no_session");
    expect(onSendHumanMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("card-preview-composer")).toBeTruthy();
    fireEvent.change(screen.getByTestId("card-preview-composer"), { target: { value: "First direct" } });
    fireEvent.click(screen.getByTestId("card-preview-send"));
    await waitFor(() => expect(onSendHumanMessage).toHaveBeenCalledWith(
      { targetAgentCardId: "no_session" },
      "First direct",
    ));
  });

  it("renders invoke-only G1 immediately without inventing Provider activity", () => {
    const target = model({
      sessions: [conductor(), cardSession({ logicalSessionId: "session_invoked", generation: 1, hasReceivedFirstInstruction: false, state: "available" })],
    });
    render(<Harness model={target} selectedSessionId="session_invoked" />);

    expect(screen.getAllByText("G1 · 等待首条指令").length).toBeGreaterThan(0);
    expect(screen.getByText("Runtime · 尚未建立")).toBeTruthy();
    expect(screen.getByText(/首条 send 前允许没有 Binding/u)).toBeTruthy();
    expect(screen.queryByText("运行命令")).toBeNull();
    expect(screen.getByTestId("card-send-idle-direct")).toBeTruthy();
  });

  it("distinguishes idle direct completion from interrupt-then-send entering its own Turn", () => {
    const direct = delivery({
      humanInterventionId: "human_idle",
      mode: "direct_message",
      deliverySessionTurnId: "turn_idle",
    });
    const target = model({
      sessions: [conductor(), cardSession({
        logicalSessionId: "session_worker",
        state: "available",
        humanDeliveries: [direct],
      })],
    });
    const rendered = render(<Harness model={target} selectedSessionId="session_worker" />);

    expect(screen.getByTestId("human-message-idle-direct-delivered")).toBeTruthy();
    expect(screen.queryByTestId("human-message-delivered-turn")).toBeNull();

    rendered.rerender(<Harness model={{
      ...target,
      sessions: [conductor(), cardSession({
        logicalSessionId: "session_worker",
        state: "available",
        humanDeliveries: [direct, delivery({
          humanInterventionId: "human_busy",
          mode: "interrupt_then_send",
          deliverySessionTurnId: "turn_busy",
        })],
      })],
    }} selectedSessionId="session_worker" />);
    expect(screen.getByTestId("human-message-delivered-turn")).toBeTruthy();
  });

  it("separates the pre-hold busy checkpoint from busy after Conductor consumes the confirmed Notice", () => {
    const researcher = cardSession({
      logicalSessionId: "session_researcher",
      agentCardId: "agent_card_researcher",
      title: "Researcher",
      state: "busy",
    });
    const target = model({ sessions: [conductor(), researcher] });
    const rendered = render(<Harness model={target} selectedSessionId="session_researcher" />);

    expect(screen.getByTestId("session-researcher-busy-for-human-hold")).toBeTruthy();
    expect(screen.queryByTestId("session-researcher-busy-after-notice")).toBeNull();

    const notice = runtimeMessage({
      messageId: "message_interrupt_notice",
      kind: "runtime_notice",
      runtimeNoticeKind: "human_interrupt_confirmed",
    });
    const followup = runtimeMessage({
      messageId: "message_notice_followup",
      kind: "conductor_forward",
      referencedMessageIds: [notice.messageId],
    });
    rendered.rerender(<Harness model={{
      ...target,
      sessions: [{ ...conductor(), messages: [notice, followup] }, researcher],
    }} selectedSessionId="session_researcher" />);
    expect(screen.queryByTestId("session-researcher-busy-for-human-hold")).toBeNull();
    expect(screen.getByTestId("session-researcher-busy-after-notice")).toBeTruthy();
  });

  it("keeps the accepted Conductor interrupt fact visible after Provider confirmation", () => {
    const researcher = cardSession({
      logicalSessionId: "session_researcher",
      agentCardId: "agent_card_researcher",
      title: "Researcher",
      controls: [{
        sessionControlAuditId: "control_conductor_confirmed",
        kind: "conductor_interrupt",
        state: "confirmed",
        requestedAt: "2026-08-11T08:03:00.000Z",
        settledAt: "2026-08-11T08:04:00.000Z",
      }],
    });

    render(<Harness model={model({ sessions: [conductor(), researcher] })} selectedSessionId="session_researcher" />);

    expect(screen.getByTestId("conductor-session-interrupt-accepted")).toBeTruthy();
  });

  it("keeps closed G1 readonly and isolates its messages from current G2", () => {
    render(<Harness model={model()} selectedSessionId="session_worker_g1" />);

    expect(screen.getAllByText("G1 · 已关闭 · 只读").length).toBeGreaterThan(0);
    expect(screen.getByText("只属于 G1 的晚到 Final")).toBeTruthy();
    expect(screen.queryByText("只属于 G2 的新消息")).toBeNull();
    expect(screen.queryByLabelText(/human → Card/u)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /WorkerG2/u }));
    expect(screen.getByText("只属于 G2 的新消息")).toBeTruthy();
    expect(screen.queryByText("只属于 G1 的晚到 Final")).toBeNull();
    expect(screen.getByLabelText("human → Card Worker / 全文同步 Conductor")).toBeTruthy();
  });

  it("shows the frozen Session Profile and opens historical generations only from the derived Timeline", () => {
    const target = model();
    render(<Harness model={{
      ...target,
      sessions: target.sessions.map((session) => session.logicalSessionId === "session_worker_g2" ? {
        ...session,
        profile: {
          schemaVersion: 3,
          executionProfileId: "profile_worker_frozen",
          profileRevisionId: "profile_revision_worker-frozen-v1",
          providerFamily: "codex",
          acpAgentKind: "codex_acp",
          model: "gpt-5.6-sol",
          role: "general",
          permissionMode: "ask",
          allowedTools: ["read", "edit"],
          requiredCapabilities: ["interrupt"],
          requiredExtensions: ["session/load"],
          readiness: {
            profileRevisionId: "profile_revision_worker-frozen-v1",
            providerFamily: "codex",
            acpAgentKind: "codex_acp",
            role: "general",
            status: "available",
            reasons: [],
            missingCapabilities: [],
            missingExtensions: [],
            model: "gpt-5.6-sol",
            observedProtocolMajor: 1,
            observedAgent: { name: "codex-acp", version: "0.9.4" },
            observedArtifactVersion: "0.9.4",
            observedUpstreamVersion: "0.147.0",
            observedCapabilities: ["interrupt"],
            observedExtensions: ["session/load"],
          },
          mutableDuringRun: false,
        },
      } : session),
      timeline: [{
        timelineItemId: "timeline_g1_closed",
        kind: "session_generation_closed",
        occurredAt: "2026-08-11T08:06:00.000Z",
        title: "Worker generation closed",
        status: "closed",
        detail: "G1 remains available as a read-only generation.",
        logicalSessionId: "session_worker_g1",
        generation: 1,
      }],
    }} selectedSessionId="session_worker_g2" />);

    const profile = screen.getByRole("region", { name: "Frozen execution profile" });
    expect(within(profile).getByText("profile_revision_worker-frozen-v1")).toBeTruthy();
    expect(within(profile).getByText("Codex")).toBeTruthy();
    expect(within(profile).getByText("Codex ACP")).toBeTruthy();
    expect(within(profile).getByText("gpt-5.6-sol")).toBeTruthy();
    expect(within(profile).getByText("0.147.0")).toBeTruthy();
    expect(within(profile).getByText("ask · read, edit")).toBeTruthy();
    expect(screen.getByText("运行中冻结 · 不可切换")).toBeTruthy();
    expect(within(profile).queryByText(/sha256|fingerprint|\/Users\//iu)).toBeNull();
    expect(within(profile).queryByRole("combobox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    const timeline = screen.getByRole("region", { name: "Task Timeline" });
    expect(within(timeline).getByText("Worker generation closed")).toBeTruthy();
    expect(within(timeline).getByText("G1 remains available as a read-only generation.")).toBeTruthy();
    fireEvent.click(within(timeline).getByRole("button", { name: "查看 G1" }));
    expect(screen.getByText("只属于 G1 的晚到 Final")).toBeTruthy();
    expect(screen.queryByText("只属于 G2 的新消息")).toBeNull();
    expect(screen.queryByLabelText(/human → Card/u)).toBeNull();
  });

  it("keeps Task Composer fixed on Conductor while Card human-direct reports mirror/held and interrupt separately", async () => {
    const onSubmitTaskMessage = vi.fn(async () => undefined);
    const onSendHumanMessage = vi.fn(async () => ({
      humanInterventionId: "human_new",
      state: "held" as const,
      targetLogicalSessionId: "session_worker_g2",
    }));
    const onAbandonHumanMessage = vi.fn(async () => ({
      humanInterventionId: "human_held",
      mode: "interrupt_then_send",
      state: "abandoned" as const,
      targetLogicalSessionId: "session_worker_g2",
    }));
    const onRequestHumanInterrupt = vi.fn(async () => ({ sessionControlAuditId: "control_new", state: "accepted" as const }));
    const { container } = render(<Harness
      model={model()}
      onRequestHumanInterrupt={onRequestHumanInterrupt}
      onAbandonHumanMessage={onAbandonHumanMessage}
      onSendHumanMessage={onSendHumanMessage}
      onSubmitTaskMessage={onSubmitTaskMessage}
      selectedSessionId="session_worker_g2"
    />);

    expect(container.querySelector(".awb-session-id-task-composer.awb-agent-chat-composer")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("发送给 Conductor（固定目标）"), { target: { value: "  Task follow-up  " } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Conductor" }));
    await waitFor(() => expect(onSubmitTaskMessage).toHaveBeenCalledWith("Task follow-up"));

    fireEvent.change(screen.getByLabelText("human → Card Worker / 全文同步 Conductor"), { target: { value: "直接纠正" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(onSendHumanMessage).toHaveBeenCalledWith(
      { targetLogicalSessionId: "session_worker_g2" },
      "直接纠正",
    ));
    expect(screen.getByRole("status").textContent).toContain("已接受，等待中断后投递");
    expect(screen.getByText("#1 Conductor mirror")).toBeTruthy();
    expect(screen.getByText("#2 Card copy · 已接受，等待中断后投递")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "仅中断" }));
    await waitFor(() => expect(onRequestHumanInterrupt).toHaveBeenCalledWith("session_worker_g2"));
    expect(screen.getByRole("status").textContent).toContain("等待 Provider 与 Runtime 的最终确认");
    expect(screen.getByText("意图已接受")).toBeTruthy();
    expect(screen.getByText("已确认中断")).toBeTruthy();

    fireEvent.click(screen.getByTestId("human-message-abandon"));
    await waitFor(() => expect(onAbandonHumanMessage).toHaveBeenCalledWith("human_held"));
    expect(screen.getByRole("status").textContent).toContain("投递前放弃");
  });

  it("shows Stop suppression, revalidates each file Preview, and exposes no Meta entry", async () => {
    const onPreviewFile = vi.fn(async () => ({
      observation: { ...model().files[0], observedAt: `preview-${onPreviewFile.mock.calls.length}` },
      content: `fresh-${onPreviewFile.mock.calls.length}`,
    }));
    render(<Harness model={model()} onPreviewFile={onPreviewFile} selectedSessionId="session_worker_g2" />);

    expect(screen.getByText("#4 Card copy · 已抑制")).toBeTruthy();
    expect(screen.getByText(/来源已验证/u)).toBeTruthy();
    expect(screen.getByText("sha256:report")).toBeTruthy();
    expect(screen.queryByText(/AI 修订|AI 协助填写|Meta Agent/u)).toBeNull();

    const preview = screen.getByRole("button", { name: "Preview（重新校验）" });
    fireEvent.click(preview);
    await screen.findByText("fresh-1");
    fireEvent.click(screen.getByRole("button", { name: "Preview（重新校验）" }));
    await screen.findByText("fresh-2");
    expect(onPreviewFile).toHaveBeenCalledTimes(2);
  });

  it("keeps unanchored Achieve explicit and independent from Preview, anchored Achieve, and Stop", async () => {
    const onAchieveTask = vi.fn(async () => undefined);
    const onStopTask = vi.fn(async () => undefined);
    const onPreviewFile = vi.fn(async () => ({
      observation: model().files[0]!,
      content: "fresh publisher output",
    }));
    render(<Harness
      model={model()}
      onAchieveTask={onAchieveTask}
      onPreviewFile={onPreviewFile}
      onStopTask={onStopTask}
    />);

    expect(screen.getByTestId("task-achieve-without-anchor")).toBeTruthy();
    expect(screen.queryByTestId("task-achieve-with-anchor")).toBeNull();
    fireEvent.click(screen.getByTestId("task-achieve-without-anchor"));
    await waitFor(() => expect(onAchieveTask).toHaveBeenNthCalledWith(1, undefined));
    expect(onPreviewFile).not.toHaveBeenCalled();
    expect(onStopTask).not.toHaveBeenCalled();
    expect(screen.getByTestId("task-stop")).toBeTruthy();

    fireEvent.click(screen.getByTestId("publisher-file-preview"));
    fireEvent.click(await screen.findByTestId("task-achieve-with-anchor"));
    await waitFor(() => expect(onAchieveTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ observationId: "file_report" }),
    ));
    expect(onStopTask).not.toHaveBeenCalled();
  });
});

type HarnessProps = Readonly<{
  model: AgentLoopSessionIdTaskReadModel;
  selectedSessionId?: string;
  onPreviewDirectoryCard?: (agentCardId: string) => void;
  onSubmitTaskMessage?: (content: string) => Promise<void>;
  onSendHumanMessage?: (
    target: AgentLoopSessionIdHumanMessageTarget,
    content: string,
  ) => Promise<AgentLoopSessionIdHumanSendOutcome>;
  onAbandonHumanMessage?: (humanInterventionId: string) => Promise<AgentLoopSessionIdHumanAbandonOutcome>;
  onRequestHumanInterrupt?: (sessionId: string) => Promise<{ sessionControlAuditId: string; state: "requested" | "accepted" }>;
  onPreviewFile?: (observationId: string) => Promise<{ observation: AgentLoopSessionIdTaskReadModel["files"][number]; content?: string }>;
  onAchieveTask?: AgentLoopSessionIdTaskSurfaceProps["onAchieveTask"];
  onStopTask?: AgentLoopSessionIdTaskSurfaceProps["onStopTask"];
}>;

function Harness({
  model,
  selectedSessionId: initialSelectedSessionId,
  onPreviewDirectoryCard = vi.fn(),
  onSubmitTaskMessage = vi.fn(async () => undefined),
  onSendHumanMessage = vi.fn(async () => ({
    humanInterventionId: "human",
    state: "sent" as const,
    targetLogicalSessionId: "session_worker",
  })),
  onAbandonHumanMessage = vi.fn(async (humanInterventionId: string) => ({
    humanInterventionId,
    state: "abandoned" as const,
    targetLogicalSessionId: "session_worker",
  })),
  onRequestHumanInterrupt = vi.fn(async () => ({ sessionControlAuditId: "control", state: "accepted" as const })),
  onPreviewFile = vi.fn(async () => ({ observation: model.files[0] })),
  onAchieveTask = vi.fn(async () => undefined),
  onStopTask = vi.fn(async () => undefined),
}: HarnessProps) {
  const [selectedSessionId, setSelectedSessionId] = useState(initialSelectedSessionId ?? model.conductorLogicalSessionId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return <AgentLoopSessionIdTaskSurface
    composerDrafts={drafts}
    model={model}
    onAbandonHumanMessage={onAbandonHumanMessage}
    onChooseSession={setSelectedSessionId}
    onAchieveTask={onAchieveTask}
    onComposerChange={(sessionId, content) => setDrafts((current) => ({ ...current, [sessionId]: content }))}
    onPreviewDirectoryCard={onPreviewDirectoryCard}
    onPreviewFile={onPreviewFile}
    onRequestHumanInterrupt={onRequestHumanInterrupt}
    onRespondInteraction={vi.fn(async () => undefined)}
    onSendHumanMessage={onSendHumanMessage}
    onStopTask={onStopTask}
    onSubmitTaskMessage={onSubmitTaskMessage}
    selectedSessionId={selectedSessionId}
  />;
}

function model(overrides: Partial<AgentLoopSessionIdTaskReadModel> = {}): AgentLoopSessionIdTaskReadModel {
  const sessions = [conductor(), cardSession({
    logicalSessionId: "session_worker_g1",
    generation: 1,
    lifecycle: "closed",
    state: "closed",
    messages: [message("message_g1", "只属于 G1 的晚到 Final", "session_worker_g1")],
  }), cardSession({
    logicalSessionId: "session_worker_g2",
    generation: 2,
    state: "busy",
    messages: [message("message_g2", "只属于 G2 的新消息", "session_worker_g2")],
    humanDeliveries: [{
      humanInterventionId: "human_held",
      mode: "interrupt_then_send",
      content: "正在等待的用户文字",
      conductorMirrorMessageId: "message_mirror",
      conductorMirrorSequence: 1,
      cardMessageId: "message_card",
      cardSequence: 2,
      cardState: "held",
      createdAt: "2026-08-11T08:01:00.000Z",
    }, {
      humanInterventionId: "human_suppressed",
      mode: "direct_message",
      content: "Stop 后不会投递",
      conductorMirrorMessageId: "message_mirror_stopped",
      conductorMirrorSequence: 3,
      cardMessageId: "message_card_stopped",
      cardSequence: 4,
      cardState: "suppressed",
      createdAt: "2026-08-11T08:02:00.000Z",
    }],
    controls: [{
      sessionControlAuditId: "control_pending",
      kind: "human_interrupt",
      state: "accepted",
      requestedAt: "2026-08-11T08:03:00.000Z",
    }, {
      sessionControlAuditId: "control_confirmed",
      kind: "human_interrupt",
      state: "confirmed",
      requestedAt: "2026-08-11T08:04:00.000Z",
      settledAt: "2026-08-11T08:05:00.000Z",
    }],
  })];
  return {
    taskId: "task_phase5",
    title: "Phase 5",
    goal: "Exercise Session-ID managed chat",
    revision: 9,
    runId: "run_phase5",
    runStatus: "running",
    conductorLogicalSessionId: "session_conductor",
    timeline: [],
    directory: directory(),
    sessions,
    files: [{
      observationId: "file_report",
      workspaceRelativePath: "reports/final.md",
      observedAt: "2026-08-11T08:05:00.000Z",
      contentDigest: "sha256:report",
      currentState: "available",
      source: "verified_tool",
    }],
    ...overrides,
  };
}

function conductor(): AgentLoopSessionIdSession {
  return {
    logicalSessionId: "session_conductor",
    agentCardId: "conductor",
    title: "Conductor",
    kind: "conductor",
    generation: 1,
    lifecycle: "current",
    state: "available",
    hasReceivedFirstInstruction: true,
    profile: taskProfile("conductor"),
    binding: { label: "Codex", status: "active", recoverable: true },
    messages: [],
    executionGroups: [],
    interactions: [],
    controls: [],
    humanDeliveries: [],
  };
}

function cardSession(overrides: Partial<AgentLoopSessionIdSession>): AgentLoopSessionIdSession {
  return {
    logicalSessionId: "session_worker",
    agentCardId: "worker",
    title: "Worker",
    kind: "card",
    generation: 1,
    lifecycle: "current",
    state: "available",
    hasReceivedFirstInstruction: true,
    profile: taskProfile("general"),
    messages: [],
    executionGroups: [],
    interactions: [],
    controls: [],
    humanDeliveries: [],
    ...overrides,
  };
}

function message(messageId: string, content: string, sourceLogicalSessionId: string) {
  return {
    messageId,
    kind: "agent_final" as const,
    content,
    contentDigest: `digest:${messageId}`,
    sourceLogicalSessionId,
    createdAt: "2026-08-11T08:00:00.000Z",
    relayBlocks: [],
    inboxDeliveries: [],
  };
}

function delivery(overrides: Partial<AgentLoopSessionIdSession["humanDeliveries"][number]> = {}) {
  return {
    humanInterventionId: "human_delivery",
    mode: "direct_message" as const,
    content: "Human content",
    conductorMirrorMessageId: "message_mirror_delivery",
    conductorMirrorSequence: 1,
    cardMessageId: "message_card_delivery",
    cardSequence: 1,
    cardState: "delivered" as const,
    createdAt: "2026-08-11T08:00:00.000Z",
    ...overrides,
  };
}

function runtimeMessage(overrides: Partial<AgentLoopSessionIdSession["messages"][number]> = {}) {
  return {
    messageId: "message_runtime",
    kind: "runtime_notice" as const,
    content: "Runtime fact",
    contentDigest: "sha256:runtime",
    createdAt: "2026-08-11T08:00:00.000Z",
    relayBlocks: [],
    inboxDeliveries: [],
    ...overrides,
  };
}

function directory() {
  const states: readonly AgentLoopSessionIdDirectoryState[] = ["no_session", "available", "busy", "human_blocked", "interaction_required", "reconciling", "closed", "faulted"];
  return states.map((state, index) => ({
    agentCardId: state,
    title: state === "no_session" ? "No session" : `Card ${index + 1}`,
    state,
    ...(state !== "no_session" ? { currentLogicalSessionId: `session_${state}`, currentGeneration: index + 1 } : {}),
  }));
}

function taskProfile(role: "conductor" | "general") {
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
