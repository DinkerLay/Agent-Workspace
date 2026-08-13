import { Send } from "lucide-react";
import type { ReactNode } from "react";

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
    <div className="awb-agent-chat-scroll awb-session-message-scroll">
      {children ? <ol className="awb-agent-chat-message-list awb-session-message-list">{children}</ol> : empty}
    </div>
  </section>;
}

export type AgentLoopChatMessageProps = Readonly<{
  speaker: string;
  content: string;
  detail?: ReactNode;
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
      <pre className="awb-session-message-content">{content}</pre>
      {children}
    </article>
  </li>;
}

export type AgentLoopChatComposerProps = Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void> | void;
  busy?: boolean;
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
  onSubmit,
  placeholder,
  rows = 2,
  secondaryActions,
  sendLabel = "发送",
  sendingLabel = "发送中…",
  sendTestId,
  testId,
  value,
}: AgentLoopChatComposerProps) {
  const blocked = disabled || busy;
  const submit = () => {
    if (blocked || !value.trim()) return;
    void onSubmit();
  };
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
    {controls ? <div className="awb-agent-chat-composer-controls">{controls}</div> : null}
    {error ? <p className="awb-composer-warning" role="alert">{error}</p> : null}
    <footer>
      <div className="awb-composer-meta">{hint}</div>
      <div className="awb-composer-actions">
        {secondaryActions}
        <button className="awb-button awb-button-primary" data-testid={sendTestId} disabled={blocked || !value.trim()} type="submit">
          <Send size={15} />{busy ? sendingLabel : sendLabel}
        </button>
      </div>
    </footer>
  </form>;
}
