import {
  Check,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  Globe2,
  LoaderCircle,
  MessageSquareText,
  Send,
  Wrench,
  X,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import type {
  AgentLoopInboxDeliveryItem,
  AgentLoopExecutionGroup,
  AgentLoopProviderActivityItem,
  AgentLoopRelayBlockItem,
  AgentLoopSessionMessageItem,
} from "./agent-loop-model";

/**
 * Renderer-only session surface for the preserved AgentLoop conversation.
 *
 * Its inputs are already-normalized Runtime read-model data. This component
 * deliberately has no transport, Provider, terminal, native-page, or event
 * stream dependency: callers turn the typed user intents below into Runtime
 * commands in their owning controller.
 */
export type AgentLoopSessionPresentationProps = Readonly<{
  taskId: string;
  session: AgentLoopSessionDisplay;
  binding: AgentLoopBindingDisplay;
  /** Already scoped by the Renderer projection; never derived from Provider facts here. */
  messages?: readonly AgentLoopSessionMessageItem[];
  /** Human-only execution trace, already normalized and scoped by Runtime. */
  executionGroups?: readonly AgentLoopExecutionGroup[];
  attentions?: readonly AgentLoopAttentionDisplay[];
  composer: AgentLoopComposerDisplay;
  onComposerChange: (message: string) => void;
  onSubmitInput: (input: AgentLoopComposerSubmission) => Promise<void> | void;
  onStopTask?: (input: AgentLoopStopTaskRequest) => Promise<void> | void;
  onRespondAttention: (input: AgentLoopAttentionResponse) => Promise<void> | void;
  /** TaskSurface supplies a separate fixed Conductor composer. */
  showComposer?: boolean;
}>;

/** Logical session identity and status only; no native or Provider session id. */
export type AgentLoopSessionDisplay = Readonly<{
  logicalSessionId: string;
  agentCardId: string;
  title?: string;
  kind: "conductor" | "card";
  status: string;
}>;

/** A user-readable binding projection, intentionally not a Provider transport object. */
export type AgentLoopBindingDisplay = Readonly<{
  label: string;
  status: string;
  detail?: string;
}>;

/** Ported from the prior composer interaction, while remaining renderer-owned state. */
export type AgentLoopComposerContinuity = Readonly<{
  state: "connected" | "recovery_required" | "stopping" | "closed";
  message: string;
}>;

export type AgentLoopComposerDisplay = Readonly<{
  message: string;
  disabled?: boolean;
  stopDisabled?: boolean;
  continuity?: AgentLoopComposerContinuity;
}>;

export type AgentLoopComposerSubmission = Readonly<{
  taskId: string;
  targetLogicalSessionId: string;
  content: string;
}>;

export type AgentLoopStopTaskRequest = Readonly<{
  taskId: string;
  logicalSessionId: string;
}>;

export type AgentLoopAttentionDisplay = Readonly<{
  attentionId: string;
  title: string;
  status: string;
  prompt?: string;
  options?: readonly string[];
  disabled?: boolean;
}>;

export type AgentLoopAttentionResponse = Readonly<{
  taskId: string;
  logicalSessionId: string;
  attentionId: string;
  response: string;
}>;

/**
 * A native-page replacement which renders immutable Runtime Messages. Provider
 * facts stay in the Timeline drawer; they are never presented as another
 * Agent's chat content.
 */
export function AgentLoopSessionPresentation({
  taskId,
  session,
  binding,
  messages = [],
  executionGroups = [],
  attentions = [],
  composer,
  onComposerChange,
  onSubmitInput,
  onStopTask,
  onRespondAttention,
  showComposer = true,
}: AgentLoopSessionPresentationProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [composerError, setComposerError] = useState<string>();
  const sessionTitle = session.title?.trim() || session.agentCardId;
  const composerDisabled = Boolean(composer.disabled || isSubmitting);
  const stopDisabled = Boolean(composer.disabled || composer.stopDisabled || isStopping);
  const composerLabel = session.kind === "card"
    ? `human → Card ${sessionTitle} / 全文同步 Conductor`
    : "发送给 Conductor";
  const entries = transcriptEntries(messages, executionGroups);

  const submitComposer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = composer.message.trim();
    if (composerDisabled || !content) return;
    setComposerError(undefined);
    setIsSubmitting(true);
    try {
      await onSubmitInput({ taskId, targetLogicalSessionId: session.logicalSessionId, content });
    } catch (error) {
      setComposerError(messageFor(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const stopTask = async () => {
    if (!onStopTask || stopDisabled) return;
    setComposerError(undefined);
    setIsStopping(true);
    try {
      await onStopTask({ taskId, logicalSessionId: session.logicalSessionId });
    } catch (error) {
      setComposerError(messageFor(error));
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <section className="awb-session-presentation" aria-label={`${sessionTitle} 会话`}>
      <section className="awb-session-transcript" aria-label="会话消息">
        <div className="awb-section-heading">
          <div><h4>会话消息</h4><span>{messages.length} 条消息{executionGroups.length ? ` · ${executionGroups.length} 个执行过程` : ""}</span></div>
          <dl className="awb-session-status-grid" aria-label="会话与绑定状态">
            <div><dt>Session</dt><dd>{session.kind} · {session.status}</dd></div>
            <div><dt>Binding</dt><dd>{binding.label} · {binding.status}</dd></div>
            {binding.detail ? <div><dt>状态说明</dt><dd>{binding.detail}</dd></div> : null}
          </dl>
        </div>
        <div className="awb-session-message-scroll">
          {entries.length === 0 ? <p className="awb-empty">还没有可展示的统一 Message。Task 目标、用户输入、派发与 Agent 回信都会在这里出现。</p> : (
            <ol className="awb-session-message-list">
              {entries.map((entry) => entry.kind === "message"
                ? <SessionMessageCard message={entry.message} session={session} key={`message:${entry.message.messageId}`} />
                : <SessionExecutionGroup group={entry.group} key={`execution:${entry.group.executionGroupId}`} />)}
            </ol>
          )}
        </div>
      </section>

      {attentions.length > 0 ? (
        <section className="awb-session-attentions" aria-label="需要你的确认">
          <div className="awb-section-heading"><h4>需要你的确认</h4><span>{attentions.length}</span></div>
          {attentions.map((attention) => (
            <AttentionResponseCard
              attention={attention}
              key={attention.attentionId}
              logicalSessionId={session.logicalSessionId}
              taskId={taskId}
              onRespondAttention={onRespondAttention}
            />
          ))}
        </section>
      ) : null}

      {showComposer ? <form className="awb-composer awb-session-composer" onSubmit={(event) => void submitComposer(event)}>
        <label>
          {composerLabel}
          <textarea
            disabled={composerDisabled}
            onChange={(event) => {
              setComposerError(undefined);
              onComposerChange(event.target.value);
            }}
            placeholder={session.kind === "card"
              ? "直接介入此 Card；若它正在运行，将先请求中断，确认安全结束后才发送。"
              : "补充目标、纠正结论，或要求再次核实；由 Conductor 决定是否重新派发。"}
            rows={2}
            value={composer.message}
          />
        </label>
        {composerError ? <p className="awb-composer-warning" role="alert">{composerError}</p> : null}
        <footer>
          <div className="awb-composer-meta">
            {composer.continuity ? <p className={`awb-composer-warning ${composer.continuity.state}`}>{composer.continuity.message}</p> : <span>Enter 发送 · Shift+Enter 换行</span>}
          </div>
          <div className="awb-composer-actions">
            {onStopTask ? <button className="awb-button awb-button-secondary" disabled={stopDisabled} type="button" onClick={() => void stopTask()}>{isStopping ? "正在停止…" : "停止任务"}</button> : null}
            <button className="awb-button awb-button-primary" disabled={composerDisabled || !composer.message.trim()} type="submit"><Send size={15} />{isSubmitting ? "正在发送…" : "发送"}</button>
          </div>
        </footer>
      </form> : null}
    </section>
  );
}

type TranscriptEntry =
  | Readonly<{ kind: "message"; occurredAt: string; message: AgentLoopSessionMessageItem }>
  | Readonly<{ kind: "execution"; occurredAt: string; group: AgentLoopExecutionGroup }>;

function transcriptEntries(
  messages: readonly AgentLoopSessionMessageItem[],
  executionGroups: readonly AgentLoopExecutionGroup[],
): readonly TranscriptEntry[] {
  return [
    ...messages.map((message): TranscriptEntry => ({ kind: "message", occurredAt: message.createdAt, message })),
    ...executionGroups.map((group): TranscriptEntry => ({ kind: "execution", occurredAt: group.startedAt, group })),
  ].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
    || (left.kind === right.kind ? 0 : left.kind === "execution" ? -1 : 1));
}

function SessionExecutionGroup({ group }: Readonly<{ group: AgentLoopExecutionGroup }>) {
  const [manualExpanded, setManualExpanded] = useState(false);
  const displayStatus = group.status === "completed" && !group.finalMessageId ? "awaiting_final" : group.status;
  const isRunning = displayStatus === "running";
  const mustStayVisible = displayStatus !== "completed" || !group.finalMessageId;
  const isOpen = mustStayVisible || manualExpanded;
  const statusLabel = executionGroupStatusLabel(displayStatus);
  const countLabel = `${group.activities.length} 步`;

  return (
    <li className={`awb-execution-group is-${displayStatus}`} data-execution-status={displayStatus}>
      <details
        open={isOpen}
        onToggle={(event) => {
          if (mustStayVisible) {
            if (!event.currentTarget.open) event.currentTarget.open = true;
            return;
          }
          setManualExpanded(event.currentTarget.open);
        }}
      >
        <summary aria-label={`${statusLabel}，${countLabel}，${isOpen ? "点击收起" : "点击展开"}`}>
          <ChevronRight aria-hidden="true" className="awb-execution-chevron" size={14} />
          <span className="awb-execution-label">{statusLabel}</span>
          <span className="awb-execution-count">{countLabel}</span>
          <span className="awb-execution-provider">{group.provider}</span>
          <ExecutionStatusIcon status={displayStatus} />
        </summary>
        <div aria-live={isRunning ? "polite" : "off"} className="awb-execution-activity-list">
          {group.activities.map((activity) => <ProviderActivityRow activity={activity} key={activity.activityId} />)}
        </div>
      </details>
    </li>
  );
}

function ProviderActivityRow({ activity }: Readonly<{ activity: AgentLoopProviderActivityItem }>) {
  return (
    <article className={`awb-provider-activity is-${activity.category} is-${activity.status}`} data-activity-category={activity.category}>
      <header>
        <span aria-hidden="true" className="awb-provider-activity-icon">{activityIcon(activity.category)}</span>
        <strong>{activity.title}</strong>
        {activity.detail ? <span className="awb-provider-activity-detail" title={activity.detail}>{activity.detail}</span> : null}
        <ExecutionStatusIcon status={activity.status} />
      </header>
      {activity.content !== undefined ? (
        <pre className="awb-provider-activity-content">{activity.content}{activity.category === "assistant_progress" && activity.status === "running" ? <span aria-hidden="true" className="awb-stream-caret" /> : null}</pre>
      ) : null}
    </article>
  );
}

function activityIcon(category: AgentLoopProviderActivityItem["category"]) {
  if (category === "assistant_progress") return <MessageSquareText size={15} />;
  if (category === "change") return <FilePenLine size={15} />;
  if (category === "web") return <Globe2 size={15} />;
  return <Wrench size={15} />;
}

function ExecutionStatusIcon({ status }: Readonly<{ status: AgentLoopExecutionGroup["status"] | AgentLoopProviderActivityItem["status"] }>) {
  const label = executionStatusLabel(status);
  return <span aria-label={label} className={`awb-execution-status is-${status}`} title={label}>
    {status === "running"
      ? <LoaderCircle size={14} />
      : status === "completed"
        ? <Check size={14} />
        : status === "failed"
          ? <X size={14} />
          : <CircleAlert size={14} />}
  </span>;
}

function executionStatusLabel(status: AgentLoopExecutionGroup["status"] | AgentLoopProviderActivityItem["status"]): string {
  if (status === "running") return "运行中";
  if (status === "awaiting_final") return "等待最终回复";
  if (status === "ambiguous") return "状态待确认";
  if (status === "completed") return "已完成";
  return "失败";
}

function executionGroupStatusLabel(status: AgentLoopExecutionGroup["status"]): string {
  if (status === "running") return "执行中";
  if (status === "failed") return "执行失败";
  return executionStatusLabel(status);
}

function SessionMessageCard({
  message,
  session,
}: Readonly<{
  message: AgentLoopSessionMessageItem;
  session: AgentLoopSessionDisplay;
}>) {
  const isFromSelectedSession = message.sourceLogicalSessionId === session.logicalSessionId;
  const isUserMessage = message.kind === "user_input";
  const isAssistantMessage = message.kind === "agent_final";
  const sourceLabel = message.sourceLabel ?? (message.kind === "user_input" ? "用户" : "Runtime");
  const deliveries = message.inboxDeliveries.filter((delivery) =>
    isFromSelectedSession || delivery.targetLogicalSessionId === session.logicalSessionId,
  );
  return (
    <li className={`awb-session-message is-${message.kind} ${isFromSelectedSession ? "is-outgoing" : "is-incoming"} ${isUserMessage ? "is-user-message" : ""} ${isAssistantMessage ? "is-assistant-message" : ""}`} data-message-kind={message.kind}>
      <article>
        <header>
          <div>
            <strong>{sourceLabel}</strong>
            <span><span className="awb-session-message-kind">{messageKindLabel(message.kind)}</span><time dateTime={message.createdAt} title={message.createdAt}> · {shortTimestamp(message.createdAt)}</time></span>
          </div>
          <span className="awb-session-message-direction">{isFromSelectedSession ? "发送" : "收到"}</span>
        </header>
        <pre className="awb-session-message-content">{message.content}</pre>
        {message.relayBlocks.length > 0 ? <section className="awb-message-relay-blocks" aria-label="转递内容">
          <p>转递内容 · {message.relayBlocks.length}</p>
          <ol>{message.relayBlocks.map((relayBlock) => <RelayBlockCard relayBlock={relayBlock} key={relayBlock.relayBlockId} />)}</ol>
        </section> : null}
        {deliveries.length > 0 ? <InboxDeliveryStates deliveries={deliveries} session={session} /> : null}
      </article>
    </li>
  );
}

function RelayBlockCard({ relayBlock }: Readonly<{ relayBlock: AgentLoopRelayBlockItem }>) {
  const target = relayBlock.suggestedTargetAgentCardIds.length ? ` → 建议 ${relayBlock.suggestedTargetAgentCardIds.join(", ")}` : "";
  return <li className="awb-relay-block">
    <details>
      <summary>候选转递块 {relayBlock.ordinal + 1}{target}</summary>
      <dl>
        {relayBlock.suggestedAudience ? <div><dt>建议受众</dt><dd>{relayBlock.suggestedAudience === "publish" ? "多个目标" : "单一目标"}</dd></div> : null}
        {relayBlock.topic ? <div><dt>主题</dt><dd>{relayBlock.topic}</dd></div> : null}
        <div><dt>格式</dt><dd>{relayBlock.format}</dd></div>
      </dl>
      <pre>{relayBlock.content}</pre>
    </details>
  </li>;
}

function InboxDeliveryStates({
  deliveries,
  session,
}: Readonly<{
  deliveries: readonly AgentLoopInboxDeliveryItem[];
  session: AgentLoopSessionDisplay;
}>) {
  return <ul aria-label="收件箱投递状态" className="awb-message-inbox-states">
    {deliveries.map((delivery) => <li className={`is-${delivery.state}`} key={delivery.inboxItemId}>
      <span>{delivery.targetLogicalSessionId === session.logicalSessionId ? "本会话" : "目标 Session"} · {deliveryRouteLabel(delivery.route)}</span>
      <strong>{inboxStateLabel(delivery.state)}</strong>
    </li>)}
  </ul>;
}

function AttentionResponseCard({
  attention,
  taskId,
  logicalSessionId,
  onRespondAttention,
}: Readonly<{
  attention: AgentLoopAttentionDisplay;
  taskId: string;
  logicalSessionId: string;
  onRespondAttention: (input: AgentLoopAttentionResponse) => Promise<void> | void;
}>) {
  const [response, setResponse] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = Boolean(attention.disabled || isSubmitting);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = response.trim();
    if (disabled || !text) return;
    setError(undefined);
    setIsSubmitting(true);
    try {
      await onRespondAttention({ taskId, logicalSessionId, attentionId: attention.attentionId, response: text });
      setResponse("");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <article className="awb-detail-item awb-session-attention">
      <div><strong>{attention.title}</strong><span>{attention.status}</span></div>
      {attention.prompt ? <p>{attention.prompt}</p> : null}
      <form onSubmit={(event) => void submit(event)}>
        {attention.options?.length ? <div className="awb-option-row">{attention.options.map((option) => <button className="awb-option" disabled={disabled} key={option} type="button" onClick={() => { setError(undefined); setResponse(option); }}>{option}</button>)}</div> : null}
        <label>
          回复 {attention.title}
          <input disabled={disabled} onChange={(event) => { setError(undefined); setResponse(event.target.value); }} value={response} />
        </label>
        {error ? <p className="awb-composer-warning" role="alert">{error}</p> : null}
        <button className="awb-text-button" disabled={disabled || !response.trim()} type="submit">{isSubmitting ? "正在回复…" : `回复 ${attention.title}`}</button>
      </form>
    </article>
  );
}

function messageKindLabel(kind: AgentLoopSessionMessageItem["kind"]): string {
  return ({
    task_goal: "Task 目标",
    user_input: "用户输入",
    agent_assignment: "Agent 派发",
    agent_final: "Agent 最终回信",
    relay_forward: "Agent 转递",
    publish_forward: "Agent 发布",
    runtime_notice: "Runtime 通知",
  } satisfies Record<AgentLoopSessionMessageItem["kind"], string>)[kind];
}

function deliveryRouteLabel(route: AgentLoopInboxDeliveryItem["route"]): string {
  return ({
    message: "消息",
    forward: "显式转递",
    human: "用户直接介入",
  } satisfies Record<AgentLoopInboxDeliveryItem["route"], string>)[route];
}

function inboxStateLabel(state: AgentLoopInboxDeliveryItem["state"]): string {
  return ({
    pending: "等待投递",
    leased: "正在准备",
    delivery_staged: "已排队投递",
    delivered: "Provider 已收到",
    ambiguous: "回执待确认",
    suppressed: "已抑制",
  } satisfies Record<AgentLoopInboxDeliveryItem["state"], string>)[state];
}

function shortTimestamp(timestamp: string): string {
  const isoTime = timestamp.match(/T(\d{2}:\d{2})/u)?.[1];
  return isoTime ?? timestamp;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
