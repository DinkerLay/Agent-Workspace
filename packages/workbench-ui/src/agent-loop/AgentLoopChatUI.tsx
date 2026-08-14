import { Brain, Check, ChevronDown, CircleAlert, LoaderCircle, MessageSquareText, Pencil, Send, Square, Wrench, X } from "lucide-react";
import { memo, useDeferredValue, useEffect, useRef, useState, type ReactNode } from "react";
import type { ProviderActivityReadModel } from "@agent-workspace/runtime-contracts";

export type AgentLoopChatTranscriptProps = Readonly<{
  ariaLabel: string;
  title: string;
  status: string;
  children?: ReactNode;
  className?: string;
  context?: ReactNode;
  empty?: ReactNode;
  testId?: string;
}>;

/**
 * Shared conversation frame for configuration-time and runtime Agents.
 *
 * The owning surface still supplies typed, owner-scoped messages. This layer
 * only standardizes the visible transcript hierarchy; it never translates
 * Meta messages into Task messages or exposes Provider traffic.
 */
export function AgentLoopChatTranscript({
  ariaLabel,
  children,
  className,
  context,
  empty,
  status,
  testId,
  title,
}: AgentLoopChatTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
  }, [children, status]);
  return <section
    aria-label={ariaLabel}
    className={`awb-agent-chat-transcript${className ? ` ${className}` : ""}`}
    data-testid={testId}
  >
    <header className="awb-agent-chat-transcript-head">
      <strong>{title}</strong>
      <span>{status}</span>
    </header>
    {context ? <div className="awb-agent-chat-context">{context}</div> : null}
    <div
      className="awb-agent-chat-scroll awb-session-message-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        following.current = atBottom;
        setShowJump(!atBottom);
      }}
      ref={scrollRef}
    >
      {children ? <ol className="awb-agent-chat-message-list awb-session-message-list">{children}</ol> : empty}
    </div>
    {showJump ? <button
      className="awb-agent-chat-jump-latest"
      onClick={() => {
        following.current = true;
        setShowJump(false);
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      }}
      type="button"
    >回到底部</button> : null}
  </section>;
}

export function AgentLoopProviderActivityList({
  activities,
  showProgressContent = true,
  streaming = false,
  turnState,
}: Readonly<{
  activities: readonly ProviderActivityReadModel[];
  showProgressContent?: boolean;
  streaming?: boolean;
  turnState?: "running" | "settled" | "unsettled";
}>) {
  const resolvedTurnState = turnState ?? (streaming ? "running" : "settled");
  if (activities.length === 0) return <p className="awb-provider-activity-empty">{resolvedTurnState === "running"
    ? "正在思考并准备下一步…"
    : "没有可展示的 Provider 活动。"}</p>;
  return <ol className="awb-provider-activity-list">
    {activities.map((activity, index) => activity.kind === "assistant_progress"
      ? <ProgressActivity
          activity={activity}
          key={activity.activityId}
          showContent={showProgressContent}
          streaming={resolvedTurnState === "running" && index === activities.length - 1}
          turnState={resolvedTurnState}
        />
      : <ToolActivity activity={activity} key={activity.activityId} />)}
  </ol>;
}

const ProgressActivity = memo(function ProgressActivity({
  activity,
  showContent,
  streaming,
  turnState,
}: Readonly<{
  activity: Extract<ProviderActivityReadModel, { kind: "assistant_progress" }>;
  showContent: boolean;
  streaming: boolean;
  turnState: "running" | "settled" | "unsettled";
}>) {
  const isReasoning = activity.contentKind === "reasoning";
  const [open, setOpen] = useState(turnState !== "settled");
  const content = useDeferredValue(activity.content);
  useEffect(() => {
    if (isReasoning) setOpen(turnState !== "settled");
  }, [isReasoning, turnState]);

  if (!isReasoning) return <li className="awb-provider-activity is-assistant_progress is-response">
    <header>
      <span className="awb-provider-activity-icon" aria-hidden="true"><MessageSquareText size={14} /></span>
      <strong>{streaming ? "正在生成回复" : "回复过程"}</strong>
    </header>
    {showContent ? <ActivityContent content={content} streaming={streaming} /> : null}
  </li>;

  return <li className="awb-provider-activity is-assistant_progress is-reasoning">
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="awb-provider-activity-icon" aria-hidden="true"><Brain size={14} /></span>
        <strong>Thinking</strong>
        <span className="awb-provider-activity-detail">{turnState === "settled" ? "已完成" : "思考中"}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </summary>
      {showContent ? <ActivityContent content={content} streaming={streaming} /> : null}
    </details>
  </li>;
});

function ActivityContent({ content, streaming }: Readonly<{ content: string; streaming: boolean }>) {
  return <pre className="awb-provider-activity-content">
    {content}{streaming ? <span className="awb-stream-caret" /> : null}
  </pre>;
}

const ToolActivity = memo(function ToolActivity({
  activity,
}: Readonly<{ activity: Extract<ProviderActivityReadModel, { kind: "tool" }> }>) {
  const automaticOpen = activity.status === "pending"
    || activity.status === "in_progress"
    || activity.status === "failed";
  const [open, setOpen] = useState(automaticOpen);
  useEffect(() => setOpen(automaticOpen), [automaticOpen]);
  return <li className={`awb-provider-activity is-tool is-${activity.status}`}>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="awb-provider-activity-icon" aria-hidden="true"><Wrench size={14} /></span>
        <strong>{activity.title}</strong>
        <ActivityStatus status={activity.status} />
        <ChevronDown aria-hidden="true" size={13} />
      </summary>
      <dl className="awb-provider-activity-metadata">
        <div><dt>状态</dt><dd>{activityStatusLabel(activity.status)}</dd></div>
        <div><dt>更新时间</dt><dd>{displayTimestamp(activity.observedAt)}</dd></div>
      </dl>
      {activity.inputSummary ? <ToolActivityDetail label="输入" value={activity.inputSummary} /> : null}
      {activity.outputSummary ? <ToolActivityDetail
        label={activity.status === "failed" ? "错误" : "输出"}
        tone={activity.status === "failed" ? "failed" : "output"}
        value={activity.outputSummary}
      /> : null}
    </details>
  </li>;
});

function ToolActivityDetail({
  label,
  tone = "input",
  value,
}: Readonly<{ label: string; tone?: "input" | "output" | "failed"; value: string }>) {
  return <section className={`awb-provider-activity-summary is-${tone}`}>
    <strong>{label}</strong>
    <pre>{value}</pre>
  </section>;
}

function ActivityStatus({ status }: Readonly<{
  status: "pending" | "in_progress" | "completed" | "failed";
}>) {
  const label = activityStatusLabel(status);
  return <span aria-label={label} className={`awb-execution-status is-${status}`} title={label}>
    {status === "in_progress" ? <LoaderCircle size={13} />
      : status === "completed" ? <Check size={13} />
        : status === "failed" ? <X size={13} /> : <CircleAlert size={13} />}
  </span>;
}

function activityStatusLabel(status: "pending" | "in_progress" | "completed" | "failed"): string {
  return status === "pending" ? "等待中"
    : status === "in_progress" ? "执行中"
      : status === "completed" ? "已完成" : "失败";
}

function displayTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, "");
}

export type AgentLoopChatMessageProps = Readonly<{
  speaker: string;
  content: string;
  detail?: ReactNode;
  leading?: ReactNode;
  direction?: string;
  tone: "assistant" | "user" | "notice";
  children?: ReactNode;
  className?: string;
  dataMessageKind?: string;
}>;

/** Shared message card; domain-specific delivery/provenance details stay slots. */
export function AgentLoopChatMessage({
  children,
  className,
  content,
  dataMessageKind,
  detail,
  direction,
  speaker,
  tone,
  leading,
}: AgentLoopChatMessageProps) {
  const visibleSpeaker = tone === "user" ? undefined : speaker;
  const hasHeader = Boolean(visibleSpeaker || detail || direction);
  return <li
    className={`awb-agent-chat-message awb-session-message is-${tone}${tone === "user" ? " is-user-message" : tone === "assistant" ? " is-assistant-message" : ""}${className ? ` ${className}` : ""}`}
    data-message-kind={dataMessageKind}
  >
    <article>
      {hasHeader ? <header>
        <div>{visibleSpeaker ? <strong>{visibleSpeaker}</strong> : null}{detail ? <span>{detail}</span> : null}</div>
        {direction ? <span className="awb-session-message-direction">{direction}</span> : null}
      </header> : null}
      {leading}
      {content ? <pre className="awb-session-message-content">{content}</pre> : null}
      {children}
    </article>
  </li>;
}

export type AgentLoopChatComposerProps = Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  onQueue?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  onCancelQueued?: () => void;
  onEditQueued?: () => void;
  busy?: boolean;
  running?: boolean;
  stopping?: boolean;
  queuedDraft?: Readonly<{ content: string; targetLabel: string }>;
  className?: string;
  controls?: ReactNode;
  disabled?: boolean;
  error?: string;
  hint?: ReactNode;
  placeholder?: string;
  rows?: number;
  secondaryActions?: ReactNode;
  sendLabel?: string;
  sendingLabel?: string;
  runningLabel?: string;
  queueLabel?: string;
  sendTestId?: string;
  testId?: string;
}>;

/** One composer interaction for Meta, Conductor and Session Agents. */
export function AgentLoopChatComposer({
  busy = false,
  className,
  controls,
  disabled = false,
  error,
  hint = "Enter 发送 · Shift+Enter 换行",
  label,
  onChange,
  onCancelQueued,
  onEditQueued,
  onQueue,
  onStop,
  onSubmit,
  placeholder,
  rows = 2,
  running = false,
  secondaryActions,
  sendLabel = "发送",
  sendingLabel = "发送中…",
  runningLabel = "生成中…",
  queueLabel = "加入队列",
  queuedDraft,
  sendTestId,
  testId,
  value,
  stopping = false,
}: AgentLoopChatComposerProps) {
  const blocked = disabled || stopping;
  const active = busy || running;
  const hasDraft = Boolean(value.trim());
  const submit = () => {
    if (blocked) return;
    if (busy) return;
    if (running) {
      if (hasDraft && onQueue) void onQueue();
      else if (hasDraft) void onSubmit();
      else if (!hasDraft && onStop) void onStop();
      return;
    }
    if (hasDraft) void onSubmit();
  };
  const primaryAction = stopping
    ? { label: "正在停止…", icon: <LoaderCircle className="awb-spinner" size={15} />, disabled: true }
    : busy
      ? { label: sendingLabel, icon: <LoaderCircle className="awb-spinner" size={15} />, disabled: true }
      : running && hasDraft && onQueue
      ? { label: queueLabel, icon: <Send size={15} />, disabled: false }
      : running && hasDraft
        ? { label: sendLabel, icon: <Send size={15} />, disabled: false }
      : running && !hasDraft && onStop
        ? { label: "停止", icon: <Square size={14} />, disabled: false }
        : active
          ? { label: runningLabel, icon: <LoaderCircle className="awb-spinner" size={15} />, disabled: true }
          : { label: sendLabel, icon: <Send size={15} />, disabled: !hasDraft };
  return <form
    className={`awb-composer awb-agent-chat-composer${className ? ` ${className}` : ""}`}
    onSubmit={(event) => {
      event.preventDefault();
      submit();
    }}
  >
    <label>{label}<textarea
      data-testid={testId}
      disabled={blocked}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
        }
      }}
      placeholder={placeholder}
      rows={rows}
      value={value}
    /></label>
    {queuedDraft ? <section aria-label="排队消息" className="awb-agent-chat-queued-draft">
      <div><strong>下一条 · {queuedDraft.targetLabel}</strong><span>当前回复结束后发送</span></div>
      <pre>{queuedDraft.content}</pre>
      <footer>
        {onEditQueued ? <button className="awb-button awb-button-secondary" onClick={onEditQueued} type="button"><Pencil size={13} />编辑</button> : null}
        {onCancelQueued ? <button className="awb-button awb-button-secondary" onClick={onCancelQueued} type="button"><X size={13} />取消排队</button> : null}
      </footer>
    </section> : null}
    {controls ? <div className="awb-agent-chat-composer-controls">{controls}</div> : null}
    {error ? <p className="awb-composer-warning" role="alert">{error}</p> : null}
    <footer>
      <div className="awb-composer-meta">{hint}</div>
      <div className="awb-composer-actions">
        {secondaryActions}
        <button className="awb-button awb-button-primary" data-testid={sendTestId} disabled={blocked || primaryAction.disabled} type="submit">
          {primaryAction.icon}{primaryAction.label}
        </button>
      </div>
    </footer>
  </form>;
}
