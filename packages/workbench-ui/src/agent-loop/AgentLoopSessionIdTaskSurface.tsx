import { useState } from "react";
import type { FormEvent } from "react";
import { AgentLoopAcpProfileSummary } from "./AgentLoopAcpProfileSummary";
import { AgentLoopChatComposer } from "./AgentLoopChatUI";
import {
  AgentLoopSessionPresentation,
  type AgentLoopInteractionResponse,
} from "./AgentLoopSessionPresentation";
import type {
  AgentLoopSessionIdDirectoryItem,
  AgentLoopSessionIdDirectoryState,
  AgentLoopSessionIdHumanAbandonOutcome,
  AgentLoopSessionIdHumanMessageTarget,
  AgentLoopSessionIdHumanSendOutcome,
  AgentLoopSessionIdInterruptOutcome,
  AgentLoopSessionIdSession,
  AgentLoopSessionIdTaskReadModel,
  AgentLoopWorkspaceFileObservation,
  AgentLoopWorkspaceFilePreview,
} from "./agent-loop-session-id-runtime-controller";

export type AgentLoopSessionIdTaskSurfaceProps = Readonly<{
  model: AgentLoopSessionIdTaskReadModel;
  selectedSessionId?: string;
  composerDrafts: Readonly<Record<string, string>>;
  onChooseSession: (sessionId: string) => void;
  onPreviewDirectoryCard: (agentCardId: string) => void;
  onComposerChange: (targetSessionId: string, content: string) => void;
  onSubmitTaskMessage: (content: string) => Promise<void> | void;
  onSendHumanMessage: (
    target: AgentLoopSessionIdHumanMessageTarget,
    content: string,
  ) => Promise<AgentLoopSessionIdHumanSendOutcome>;
  onAbandonHumanMessage: (humanInterventionId: string) => Promise<AgentLoopSessionIdHumanAbandonOutcome>;
  onRequestHumanInterrupt: (sessionId: string) => Promise<AgentLoopSessionIdInterruptOutcome>;
  onRespondInteraction: (input: AgentLoopInteractionResponse) => Promise<void> | void;
  onPreviewFile: (observationId: string) => Promise<AgentLoopWorkspaceFilePreview>;
  onAchieveTask: (fileObservation?: AgentLoopWorkspaceFileObservation) => Promise<void> | void;
  onStopTask: () => Promise<void> | void;
  achievement?: Readonly<{
    achievedAt: string;
    fileStateAnchor?: Readonly<{ workspaceRelativePath: string }>;
  }>;
}>;

/**
 * Uncomposed Phase-5 target. All lifecycle/content facts arrive in `model`;
 * only tab selection, drafts, expansion and preview display are Renderer state.
 */
export function AgentLoopSessionIdTaskSurface({
  model,
  selectedSessionId,
  composerDrafts,
  onChooseSession,
  onPreviewDirectoryCard,
  onComposerChange,
  onSubmitTaskMessage,
  onSendHumanMessage,
  onAbandonHumanMessage,
  onRequestHumanInterrupt,
  onRespondInteraction,
  onPreviewFile,
  onAchieveTask,
  onStopTask,
  achievement,
}: AgentLoopSessionIdTaskSurfaceProps) {
  const [actionNotice, setActionNotice] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [filePreview, setFilePreview] = useState<AgentLoopWorkspaceFilePreview>();
  const [previewingId, setPreviewingId] = useState<string>();
  const [achieving, setAchieving] = useState(false);
  const [previewedAgentCardId, setPreviewedAgentCardId] = useState<string>();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const conductor = model.sessions.find((session) => session.logicalSessionId === model.conductorLogicalSessionId);
  const selected = model.sessions.find((session) => session.logicalSessionId === selectedSessionId) ?? conductor ?? model.sessions[0];
  const previewedCard = model.directory.find((card) => card.agentCardId === previewedAgentCardId
    && card.state === "no_session" && !card.currentLogicalSessionId);
  const taskDraft = composerDrafts[model.conductorLogicalSessionId] ?? "";
  const runStopping = model.runStatus === "stopping" || model.runStatus === "stopped";
  const achieved = Boolean(achievement);

  const submitTaskMessage = async () => {
    const content = taskDraft.trim();
    if (!content || runStopping) return;
    setActionError(undefined);
    try {
      await onSubmitTaskMessage(content);
      setActionNotice("Task 输入已提交给 Conductor；当前 Tab 没有改变目标。");
    } catch (error) {
      setActionError(messageFor(error));
    }
  };

  const sendHumanMessage = async (target: AgentLoopSessionIdHumanMessageTarget, content: string) => {
    setActionError(undefined);
    try {
      const outcome = await onSendHumanMessage(target, content);
      setActionNotice(outcome.state === "held"
        ? "已接受，等待中断后投递；全文已镜像给 Conductor。"
        : outcome.state === "suppressed"
          ? "该输入已被 Runtime 抑制，不会投递给 Card。"
          : "已发送给 Card，并将全文镜像给 Conductor。");
      return outcome;
    } catch (error) {
      setActionError(messageFor(error));
      throw error;
    }
  };

  const abandonHumanMessage = async (humanInterventionId: string) => {
    setActionError(undefined);
    try {
      await onAbandonHumanMessage(humanInterventionId);
      setActionNotice("该用户消息已在 Card 投递前放弃；审计与 Conductor mirror 保留。");
    } catch (error) {
      setActionError(messageFor(error));
    }
  };

  const previewDirectoryCard = (agentCardId: string) => {
    setPreviewedAgentCardId(agentCardId);
    onPreviewDirectoryCard(agentCardId);
  };

  const requestInterrupt = async (sessionId: string) => {
    setActionError(undefined);
    try {
      const outcome = await onRequestHumanInterrupt(sessionId);
      setActionNotice(outcome.state === "accepted"
        ? "中断意图已接受；等待 Provider 与 Runtime 的最终确认。"
        : "中断意图已记录；等待 Runtime 接受。"
      );
    } catch (error) {
      setActionError(messageFor(error));
    }
  };

  const previewFile = async (file: AgentLoopWorkspaceFileObservation) => {
    setActionError(undefined);
    setPreviewingId(file.observationId);
    try {
      setFilePreview(await onPreviewFile(file.observationId));
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setPreviewingId(undefined);
    }
  };

  const stopTask = async () => {
    if (runStopping) return;
    setActionError(undefined);
    try {
      await onStopTask();
      setActionNotice("Stop 意图已提交；等待 Runtime 抑制待投递输入并核对 Provider 事实。");
    } catch (error) {
      setActionError(messageFor(error));
    }
  };

  const achieveTask = async (fileObservation?: AgentLoopWorkspaceFileObservation) => {
    if (achieved || achieving) return;
    setActionError(undefined);
    setAchieving(true);
    try {
      await onAchieveTask(fileObservation);
      setActionNotice("Achieve 已作为独立用户决定提交；它不会替代 Stop 或 Provider lifecycle。");
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setAchieving(false);
    }
  };

  return (
    <main className="awb-session-id-task-surface" aria-label={`${model.title} Task Run`}>
      <header className="awb-session-id-task-header">
        <div><p>Task Run · Session-ID Runtime</p><h1>{model.title}</h1><span>{model.goal}</span><small data-testid="task-run-meta-absent">配置助手仅用于 Draft；当前是 Task Run</small></div>
        <div>
          <RunStateChip status={model.runStatus} />
          <button
            aria-expanded={timelineOpen}
            className="awb-button awb-button-secondary"
            data-testid="task-timeline-toggle"
            onClick={() => setTimelineOpen((current) => !current)}
            type="button"
          >Timeline</button>
          <button className="awb-button awb-button-secondary" data-testid="task-achieve-without-anchor" disabled={achieved || achieving} onClick={() => void achieveTask()} type="button">{achieved ? "已 Achieve" : achieving ? "提交中…" : "Achieve（不附文件状态）"}</button>
          {filePreview?.observation && isPublisherObservation(filePreview.observation) ? <button className="awb-button awb-button-secondary" data-testid="task-achieve-with-anchor" disabled={achieved || achieving} onClick={() => void achieveTask(filePreview.observation)} type="button">{achieved ? "已 Achieve" : achieving ? "提交中…" : "Achieve（附文件状态）"}</button> : null}
          <button className="awb-button awb-button-secondary" data-testid="task-stop" disabled={runStopping} onClick={() => void stopTask()} type="button">停止 Task</button>
          {achievement ? <AchievementStatus achievement={achievement} /> : null}
        </div>
      </header>

      <RuntimeContinuityMarkers model={model} />
      <SessionFactMarkers model={model} />
      {timelineOpen ? <TaskTimeline
        model={model}
        onChooseSession={(sessionId) => {
          setPreviewedAgentCardId(undefined);
          onChooseSession(sessionId);
        }}
      /> : null}

      <div className="awb-session-id-task-grid">
        <aside className="awb-session-id-directory" aria-label="Card Directory">
          <header><h2>Card Directory</h2><p>点击只预览，不会建立 Session。</p></header>
          <ol>{model.directory.map((card) => <DirectoryCard card={card} key={card.agentCardId} onPreview={previewDirectoryCard} />)}</ol>
        </aside>

        <section className="awb-session-id-managed-chat" aria-label="Managed Chat">
          <nav aria-label="Task Session Tabs" className="awb-session-id-tabs">
            {orderedSessions(model).map((session) => (
              <SessionTabButton
                currentResearcher={session.kind === "card"
                  && session.lifecycle === "current"
                  && journeyRole(session) === "researcher"}
                key={session.logicalSessionId}
                onChoose={() => {
                  setPreviewedAgentCardId(undefined);
                  onChooseSession(session.logicalSessionId);
                }}
                selected={session.logicalSessionId === selected?.logicalSessionId}
                session={session}
              />
            ))}
          </nav>

          {previewedCard ? <NoSessionCardPreview
            card={previewedCard}
            content={composerDrafts[previewComposerKey(previewedCard.agentCardId)] ?? ""}
            disabled={runStopping}
            onChange={(content) => onComposerChange(previewComposerKey(previewedCard.agentCardId), content)}
            onSend={(content) => sendHumanMessage({ targetAgentCardId: previewedCard.agentCardId }, content)}
          /> : selected ? <>
            <header className="awb-session-id-session-header">
              <div><h2>{selected.title}</h2><p>{sessionHeaderStatus(selected)}</p></div>
            </header>
            <FrozenSessionProfile session={selected} />
            <AgentLoopSessionPresentation
              interactions={selected.interactions}
              binding={selected.binding ?? { label: "Runtime", status: "尚未建立", detail: "invoke 只建立 Session；首条 send 前允许没有 Binding、Input 或 Turn。" }}
              composer={{
                message: composerDrafts[selected.logicalSessionId] ?? "",
                disabled: selected.kind !== "card" || selected.lifecycle !== "current" || runStopping,
                running: canInterrupt(selected, runStopping),
                continuity: continuityFor(selected),
                ...(selected.kind === "card" ? {
                  testId: `card-composer-${journeyRole(selected)}`,
                  ...(selected.state === "busy"
                    ? { sendTestId: "card-send-interrupt-first" }
                    : selected.state === "available"
                      ? { sendTestId: "card-send-idle-direct" }
                      : {}),
                } : {}),
              }}
              executionGroups={selected.executionGroups}
              messages={selected.messages}
              onComposerChange={(content) => onComposerChange(selected.logicalSessionId, content)}
              onRespondInteraction={onRespondInteraction}
              onRequestInterrupt={({ logicalSessionId }) => requestInterrupt(logicalSessionId)}
              onSubmitInput={async (input) => {
                await sendHumanMessage({ targetLogicalSessionId: input.targetLogicalSessionId }, input.content);
              }}
              session={{
                logicalSessionId: selected.logicalSessionId,
                agentCardId: selected.agentCardId,
                title: selected.title,
                kind: selected.kind,
                status: sessionHeaderStatus(selected),
              }}
              showComposer={selected.kind === "card" && selected.lifecycle === "current"}
              taskId={model.taskId}
            />
            {selected.kind === "card" ? <SessionAudit onAbandon={abandonHumanMessage} session={selected} /> : null}
          </> : <p className="awb-empty">该 Run 尚无可展示 Session。</p>}

          {actionNotice ? <p className="awb-session-id-action-notice" role="status">{actionNotice}</p> : null}
          {actionError ? <p className="awb-composer-warning" role="alert">{actionError}</p> : null}

          <AgentLoopChatComposer
            className="awb-session-id-task-composer"
            disabled={runStopping || !conductor}
            hint="固定目标：Conductor · 选择其他 Session Tab 不会改变发送对象。"
            label="发送给 Conductor（固定目标）"
            onChange={(content) => onComposerChange(model.conductorLogicalSessionId, content)}
            onSubmit={submitTaskMessage}
            placeholder="补充 Task 目标；选择 Worker Tab 不会改变此目标。"
            sendLabel="发送给 Conductor"
            sendTestId="task-conductor-send"
            testId="task-conductor-composer"
            value={taskDraft}
          />
        </section>

        <aside className="awb-session-id-files" aria-label="Files & Changes">
          <header><h2>Files & Changes</h2><p>Task-scoped 人类观察；Preview 每次重校验。</p></header>
          {model.files.length ? <ol>{model.files.map((file) => (
            <WorkspaceFileObservationRow
              file={file}
              key={file.observationId}
              onPreview={previewFile}
              previewing={previewingId === file.observationId}
            />
          ))}</ol> : <p className="awb-empty">尚无 Workspace 文件观察。</p>}
          {filePreview ? <section className="awb-session-id-file-preview" aria-label="文件预览">
            <header><strong>{filePreview.observation.workspaceRelativePath}</strong><span>{fileStateLabel(filePreview.observation.currentState)}</span></header>
            <pre>{filePreview.content ?? "当前状态没有可预览正文。"}</pre>
          </section> : null}
        </aside>
      </div>
    </main>
  );
}

function AchievementStatus({ achievement }: Readonly<{
  achievement: NonNullable<AgentLoopSessionIdTaskSurfaceProps["achievement"]>;
}>) {
  return achievement.fileStateAnchor
    ? <span data-testid="task-achieved-with-anchor">已接受 · 文件状态已锚定</span>
    : <span data-testid="task-achieved-without-anchor">已接受 · 无文件状态锚点</span>;
}

function FrozenSessionProfile({ session }: Readonly<{ session: AgentLoopSessionIdSession }>) {
  const profile = session.profile;
  if (!profile) {
    return <section aria-label="Frozen execution profile" className="awb-session-id-session-profile is-unavailable">
      <header><strong>Execution Profile</strong><span>Projection unavailable</span></header>
      <p>运行中不允许选择或 fallback；该历史 generation 没有可用的冻结 Profile 投影。</p>
    </section>;
  }
  return <div className="awb-session-id-session-profile-shell">
    <p>运行中冻结 · 不可切换</p>
    <AgentLoopAcpProfileSummary
      allowedTools={profile.allowedTools}
      className="awb-session-id-session-profile"
      permissionMode={profile.permissionMode}
      readiness={profile.readiness}
      requiredCapabilities={profile.requiredCapabilities}
      requiredExtensions={profile.requiredExtensions}
      title="Frozen execution profile"
    />
  </div>;
}

function TaskTimeline({
  model,
  onChooseSession,
}: Readonly<{
  model: AgentLoopSessionIdTaskReadModel;
  onChooseSession: (sessionId: string) => void;
}>) {
  const logicalSessionIds = new Set(model.sessions.map((session) => session.logicalSessionId));
  return <section aria-label="Task Timeline" className="awb-agent-loop-timeline-surface awb-session-id-timeline-surface">
    <header><div><p>Persisted facts · read-only projection</p><h2>Task Timeline</h2></div><span>{model.timeline.length} facts</span></header>
    {model.timeline.length ? <ol className="awb-agent-loop-timeline">{model.timeline.map((item) => (
      <li className="awb-agent-loop-timeline-entry is-runtime" key={item.timelineItemId}>
        <span aria-hidden="true">{timelineKindMark(item.kind)}</span>
        <div>
          <strong>{item.title}</strong>
          <time dateTime={item.occurredAt}>{item.occurredAt}</time>
          {item.status ? <span> · {item.status}</span> : null}
          {item.detail ? <p>{item.detail}</p> : null}
          {item.logicalSessionId && logicalSessionIds.has(item.logicalSessionId) ? <button
            className="awb-text-button"
            onClick={() => onChooseSession(item.logicalSessionId!)}
            type="button"
          >查看 {item.generation ? `G${item.generation}` : "Session"}</button> : null}
        </div>
      </li>
    ))}</ol> : <p className="awb-empty">暂无可投影的持久事实。</p>}
  </section>;
}

function timelineKindMark(kind: AgentLoopSessionIdTaskReadModel["timeline"][number]["kind"]): string {
  if (kind === "message_created") return "M";
  if (kind === "input_state") return "I";
  if (kind === "turn_state") return "T";
  if (kind === "interaction_state") return "!";
  if (kind === "workspace_observed") return "W";
  if (kind === "achievement_recorded") return "A";
  if (kind === "stop_requested" || kind === "run_stopped") return "S";
  return "·";
}

function RunStateChip({ status }: Readonly<{ status: AgentLoopSessionIdTaskReadModel["runStatus"] }>) {
  if (status === "running" || status === "starting") {
    return <span className={`awb-session-id-run-state is-${status}`} data-testid="task-running">{status}</span>;
  }
  if (status === "stopped") {
    return <span className="awb-session-id-run-state is-stopped" data-testid="task-stopped">{status}</span>;
  }
  return <span className={`awb-session-id-run-state is-${status}`}>{status}</span>;
}

function WorkspaceFileObservationRow({
  file,
  onPreview,
  previewing,
}: Readonly<{
  file: AgentLoopWorkspaceFileObservation;
  onPreview: (file: AgentLoopWorkspaceFileObservation) => Promise<void> | void;
  previewing: boolean;
}>) {
  const content = <>
    <strong>{file.workspaceRelativePath}</strong>
    <span>{fileStateLabel(file.currentState)} · {file.source === "verified_tool" ? "来源已验证" : "来源未验证"}</span>
    <code>{file.contentDigest ?? "无 digest"}</code>
    <time dateTime={file.observedAt}>{file.observedAt}</time>
  </>;

  if (isPublisherObservation(file)) {
    return <li data-testid="publisher-file-observed">
      {content}
      <button className="awb-text-button" data-testid="publisher-file-preview" disabled={previewing} onClick={() => void onPreview(file)} type="button">{previewing ? "正在重校验…" : "Preview（重新校验）"}</button>
    </li>;
  }

  return <li>
    {content}
    <button className="awb-text-button" disabled={previewing} onClick={() => void onPreview(file)} type="button">{previewing ? "正在重校验…" : "Preview（重新校验）"}</button>
  </li>;
}

function DirectoryCard({ card, onPreview }: Readonly<{
  card: AgentLoopSessionIdDirectoryItem;
  onPreview: (agentCardId: string) => void;
}>) {
  const role = journeyCardRole(card.agentCardId, card.title);
  return <li><button
    className={`is-${card.state}`}
    data-testid={role === "researcher" && card.state === "no_session" ? "directory-card-researcher-no-session" : undefined}
    onClick={() => onPreview(card.agentCardId)}
    type="button"
  >
    <span><strong>{card.title}</strong><small>{card.agentCardId}</small></span>
    <span><b>{directoryStateLabel(card.state)}</b>{card.currentGeneration ? <small>G{card.currentGeneration}</small> : null}</span>
    {card.detail ? <em>{card.detail}</em> : null}
  </button></li>;
}

function SessionTabButton({
  currentResearcher,
  onChoose,
  selected,
  session,
}: Readonly<{
  currentResearcher: boolean;
  onChoose: () => void;
  selected: boolean;
  session: AgentLoopSessionIdSession;
}>) {
  const content = <><strong>{session.kind === "conductor" ? "Conductor" : session.title}</strong><span>{sessionTabStatus(session)}</span></>;
  const props = {
    "aria-pressed": selected,
    className: `${selected ? "is-selected" : ""} is-${session.state}`,
    onClick: onChoose,
    type: "button" as const,
  };
  return currentResearcher
    ? <button {...props} data-testid="session-tab-researcher-current">{content}</button>
    : <button {...props}>{content}</button>;
}

function NoSessionCardPreview({
  card,
  content,
  disabled,
  onChange,
  onSend,
}: Readonly<{
  card: AgentLoopSessionIdDirectoryItem;
  content: string;
  disabled: boolean;
  onChange: (content: string) => void;
  onSend: (content: string) => Promise<AgentLoopSessionIdHumanSendOutcome>;
}>) {
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = content.trim();
    if (!normalized || disabled) return;
    await onSend(normalized);
  };
  return <section className="awb-session-id-card-preview" aria-label={`${card.title} Card preview`}>
    <header><div><p>Card preview · 尚未建立 Session</p><h2>{card.title}</h2></div><span>{directoryStateLabel(card.state)}</span></header>
    <p>{card.detail ?? "首次发送才会在同一 Runtime 事务中建立 current generation。"}</p>
    <form className="awb-composer" onSubmit={(event) => void submit(event)}>
      <label>直接发送给该 Card
        <textarea
          data-testid="card-preview-composer"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="预览不会建立 Session；发送后全文会先镜像给 Conductor。"
          rows={4}
          value={content}
        />
      </label>
      <footer><span>发送才会 materialize；点击预览本身是 0 command。</span><button className="awb-button awb-button-primary" data-testid="card-preview-send" disabled={disabled || !content.trim()} type="submit">建立 Session 并发送</button></footer>
    </form>
  </section>;
}

function SessionAudit({ onAbandon, session }: Readonly<{
  onAbandon: (humanInterventionId: string) => Promise<void> | void;
  session: AgentLoopSessionIdSession;
}>) {
  const deliveries = [...session.humanDeliveries].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const controls = [...session.controls].sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  if (!deliveries.length && !controls.length) return null;
  return <section className="awb-session-id-audit" aria-label="介入与控制状态">
    {deliveries.length ? <div><h3>Human direct / mirror</h3><ol>{deliveries.map((delivery) => <li key={delivery.humanInterventionId}>
      <p>{delivery.content}</p>
      <span>#{delivery.conductorMirrorSequence} Conductor mirror</span>
      <span>#{delivery.cardSequence} Card copy · {humanDeliveryStateLabel(delivery.cardState)}</span>
      {delivery.cardState === "pending" || delivery.cardState === "held"
        ? <button className="awb-text-button" data-testid="human-message-abandon" onClick={() => void onAbandon(delivery.humanInterventionId)} type="button">投递前放弃</button>
        : null}
    </li>)}</ol></div> : null}
    {controls.length ? <div><h3>Control</h3><ol>{controls.map((control) => <li key={control.sessionControlAuditId}>
      <span>{controlKindLabel(control.kind)}</span><strong>{controlStateLabel(control.state)}</strong>{control.reason ? <p>{control.reason}</p> : null}
    </li>)}</ol></div> : null}
  </section>;
}

function previewComposerKey(agentCardId: string): string {
  return `card-preview:${agentCardId}`;
}

function SessionFactMarkers({ model }: Readonly<{ model: AgentLoopSessionIdTaskReadModel }>) {
  const allMessages = model.sessions.flatMap((session) => session.messages);
  const humanConfirmedNoticeIds = new Set(allMessages
    .filter((message) => message.kind === "runtime_notice" && message.runtimeNoticeKind === "human_interrupt_confirmed")
    .map((message) => message.messageId));
  const noticeFollowupSent = allMessages.some((message) => message.kind === "conductor_forward"
    && message.referencedMessageIds?.some((messageId) => humanConfirmedNoticeIds.has(messageId)));
  const conductorInterruptNotice = allMessages.some((message) => message.kind === "runtime_notice"
    && message.runtimeNoticeKind === "conductor_interrupt_confirmed");
  const interruptUnknownNotice = allMessages.some((message) => message.kind === "runtime_notice"
    && message.runtimeNoticeKind === "interrupt_unknown");
  const lateFinalNotice = allMessages.some((message) => message.kind === "runtime_notice"
    && message.runtimeNoticeKind === "late_final");

  return <section aria-label="Session Runtime facts" className="awb-session-id-fact-markers">
    {model.sessions.filter((session) => session.kind === "card").map((session) => (
      <SessionJourneyFactMarkers key={`${session.logicalSessionId}:journey-facts`} session={session} />
    ))}
    {model.sessions.flatMap((session) => {
      if (session.kind !== "card") return [];
      const markers: React.ReactNode[] = [];
      if (session.humanDeliveries.some((delivery) => delivery.cardState === "held")) {
        markers.push(<span data-testid="human-message-held" key={`${session.logicalSessionId}:human-held`}>用户输入已持久化并 held</span>);
      }
      if (session.humanDeliveries.some((delivery) => delivery.mode === "interrupt_then_send"
        && delivery.cardState === "delivered" && delivery.deliverySessionTurnId)) {
        markers.push(<span data-testid="human-message-delivered-turn" key={`${session.logicalSessionId}:human-turn`}>用户输入已进入独立 human Turn</span>);
      }
      if (session.humanDeliveries.some((delivery) => delivery.mode === "direct_message"
        && delivery.cardState === "delivered")) {
        markers.push(<span data-testid="human-message-idle-direct-delivered" key={`${session.logicalSessionId}:human-idle-direct`}>idle Card direct 已投递</span>);
      }
      if (session.controls.some((control) => control.kind === "conductor_interrupt"
        && (control.state === "accepted" || control.state === "confirmed"))) {
        markers.push(<span data-testid="conductor-session-interrupt-accepted" key={`${session.logicalSessionId}:conductor-interrupt`}>Conductor scoped interrupt 意图已接受</span>);
      }
      if (journeyRole(session) === "researcher" && session.state === "busy" && humanConfirmedNoticeIds.size === 0) {
        markers.push(<span data-testid="session-researcher-busy-for-human-hold" key={`${session.logicalSessionId}:busy-for-human-hold`}>Researcher busy · 下一条 human direct 将先中断后发送</span>);
      }
      if (journeyRole(session) === "researcher" && session.state === "busy" && noticeFollowupSent) {
        markers.push(<span data-testid="session-researcher-busy-after-notice" key={`${session.logicalSessionId}:busy-after-notice`}>Researcher busy · Conductor 已消费确认 Notice</span>);
      }
      return markers;
    })}
    {humanConfirmedNoticeIds.size ? <span data-testid="interrupt-confirmed-notice">用户 scoped interrupt 已由 Runtime Notice 确认</span> : null}
    {noticeFollowupSent ? <span data-testid="conductor-notice-followup-sent">Conductor 已基于该 Notice 提交后续单目标 send</span> : null}
    {conductorInterruptNotice ? <span data-testid="conductor-interrupt-confirmed-notice">Conductor interrupt 已由 Runtime Notice 确认</span> : null}
    {interruptUnknownNotice ? <span data-testid="interrupt-unknown-notice">scoped interrupt 结果未知，Runtime 保留 ambiguous 状态</span> : null}
    {lateFinalNotice ? <span data-testid="late-final-notice">interrupt 确认后的 late Final 已按因果顺序保留</span> : null}
  </section>;
}

function SessionJourneyFactMarkers({ session }: Readonly<{ session: AgentLoopSessionIdSession }>) {
  const role = journeyRole(session);
  const hasFinal = session.messages.some((message) => message.kind === "agent_final");

  if (role === "researcher") {
    return <>
      {!session.hasReceivedFirstInstruction && session.lifecycle === "current" && session.generation === 1
        ? <span data-testid="session-researcher-g1-waiting">{session.title} G1 · 等待首条指令</span>
        : null}
      {hasFinal ? <span data-testid="session-researcher-final">{session.title} · Final 已持久化</span> : null}
      {session.lifecycle === "closed" && session.generation === 1
        ? <span data-testid="session-researcher-g1-readonly">{session.title} G1 · 只读</span>
        : null}
      {session.lifecycle === "current" && session.generation === 2
        ? <span data-testid="session-researcher-g2-current">{session.title} G2 · current</span>
        : null}
    </>;
  }

  if (role === "reviewer") {
    return hasFinal ? <span data-testid="session-reviewer-final">{session.title} · Final 已持久化</span> : null;
  }

  return null;
}

function RuntimeContinuityMarkers({ model }: Readonly<{ model: AgentLoopSessionIdTaskReadModel }>) {
  const continuity = model.continuity;
  return <section aria-label="Runtime continuity" className="awb-session-id-continuity">
    {continuity?.recoveryState === "live" ? <span data-testid="task-before-host-restart">Runtime {continuity.runtimeInstanceId} · durable lineage ready</span> : null}
    {continuity?.recoveryState === "recovered" ? <span data-testid="task-recovered">Host restart 后已恢复同一 Task/Run lineage</span> : null}
    {continuity?.continuedFromSurface ? <>
      <span data-testid="task-cross-surface-restored">已从 {continuity.continuedFromSurface} Surface 恢复</span>
      <span data-testid="task-cross-surface-lineage">lineage {continuity.lineageId}</span>
    </> : null}
    {model.planningFence && model.planningFence.revision > 0 ? <span data-testid="conductor-planning-fence-advanced">Planning Fence r{model.planningFence.revision}</span> : null}
  </section>;
}

function orderedSessions(model: AgentLoopSessionIdTaskReadModel): readonly AgentLoopSessionIdSession[] {
  return [...model.sessions].sort((left, right) => {
    if (left.logicalSessionId === model.conductorLogicalSessionId) return -1;
    if (right.logicalSessionId === model.conductorLogicalSessionId) return 1;
    return left.agentCardId.localeCompare(right.agentCardId) || right.generation - left.generation;
  });
}

function sessionTabStatus(session: AgentLoopSessionIdSession): string {
  if (session.kind === "conductor") return directoryStateLabel(session.state);
  if (session.lifecycle === "closed") return `G${session.generation} · 已关闭 · 只读`;
  if (session.lifecycle === "faulted") return `G${session.generation} · 故障 · 只读`;
  if (!session.hasReceivedFirstInstruction) return `G${session.generation} · 等待首条指令`;
  return `G${session.generation} · ${directoryStateLabel(session.state)}`;
}

function sessionHeaderStatus(session: AgentLoopSessionIdSession): string {
  return session.kind === "card" ? sessionTabStatus(session) : directoryStateLabel(session.state);
}

function canInterrupt(session: AgentLoopSessionIdSession, runStopping: boolean): boolean {
  return session.kind === "card"
    && session.lifecycle === "current"
    && !runStopping
    && ["busy", "human_blocked", "interaction_required", "reconciling"].includes(session.state);
}

function continuityFor(session: AgentLoopSessionIdSession) {
  if (session.lifecycle !== "current") return { state: "closed" as const, message: "该 generation 已关闭；历史只读。" };
  if (session.state === "human_blocked") return { state: "recovery_required" as const, message: "用户输入已持久化并 held；等待旧 Turn 收束后投递。" };
  if (session.state === "reconciling") return { state: "recovery_required" as const, message: "Runtime 正在核对 Provider 结果；不会盲目重发。" };
  return { state: "connected" as const, message: "直接发送给此 Card；全文同时镜像给 Conductor。" };
}

function directoryStateLabel(state: AgentLoopSessionIdDirectoryState): string {
  return ({
    no_session: "未建立 Session",
    available: "可用",
    busy: "运行中",
    human_blocked: "等待用户介入收束",
    interaction_required: "等待选择",
    reconciling: "核对中",
    closed: "已关闭",
    faulted: "故障",
  } satisfies Record<AgentLoopSessionIdDirectoryState, string>)[state];
}

function humanDeliveryStateLabel(state: AgentLoopSessionIdSession["humanDeliveries"][number]["cardState"]): string {
  return ({ pending: "等待投递", held: "已接受，等待中断后投递", delivered: "已投递", suppressed: "已抑制" } as const)[state];
}

function controlKindLabel(kind: AgentLoopSessionIdSession["controls"][number]["kind"]): string {
  return kind === "human_interrupt"
    ? "用户仅中断"
    : kind === "conductor_interrupt"
      ? "Conductor 中断"
      : kind === "task_stop"
        ? "Task Stop"
        : "安全关闭";
}

function controlStateLabel(state: AgentLoopSessionIdSession["controls"][number]["state"]): string {
  return ({ requested: "已请求", accepted: "意图已接受", confirmed: "已确认中断", unknown: "结果未知", rejected: "已拒绝", closed: "已关闭" } as const)[state];
}

function fileStateLabel(state: AgentLoopWorkspaceFileObservation["currentState"]): string {
  return ({ available: "当前可用", missing: "当前缺失", changed: "内容已变化", too_large: "文件过大", unsupported: "不支持预览" } as const)[state];
}

function journeyRole(session: AgentLoopSessionIdSession): string {
  return journeyCardRole(session.agentCardId, session.title);
}

function journeyCardRole(agentCardId: string, title: string): string {
  const source = `${agentCardId} ${title}`.toLowerCase();
  for (const role of ["researcher", "reviewer", "publisher"]) {
    if (source.includes(role)) return role;
  }
  return agentCardId.toLowerCase().replace(/^agent[_-]card[_-]/u, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "card";
}

function isPublisherObservation(file: AgentLoopWorkspaceFileObservation): boolean {
  return file.source === "verified_tool";
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
