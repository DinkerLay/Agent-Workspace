import {
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  X,
} from "lucide-react";
import { useState } from "react";
import type {
  AgentLoopInboxDeliveryItem,
  AgentLoopExecutionGroup,
  AgentLoopRelayBlockItem,
  AgentLoopSessionMessageItem,
} from "./agent-loop-session-id-presentation-model";
import {
  AgentLoopChatComposer,
  AgentLoopChatMessage,
  AgentLoopProviderActivityList,
  AgentLoopChatTranscript,
} from "./AgentLoopChatUI";

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
  interactions?: readonly AgentLoopInteractionDisplay[];
  composer: AgentLoopComposerDisplay;
  onComposerChange: (message: string) => void;
  onSubmitInput: (input: AgentLoopComposerSubmission) => Promise<void> | void;
  onRequestInterrupt?: (input: AgentLoopSessionInterruptRequest) => Promise<void> | void;
  onStopTask?: (input: AgentLoopStopTaskRequest) => Promise<void> | void;
  onRespondInteraction: (input: AgentLoopInteractionResponse) => Promise<void> | void;
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
  running?: boolean;
  stopDisabled?: boolean;
  continuity?: AgentLoopComposerContinuity;
  /** Stable locator names are supplied by the owning formal Surface. */
  testId?: string;
  sendTestId?: string;
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

export type AgentLoopSessionInterruptRequest = Readonly<{
  taskId: string;
  logicalSessionId: string;
}>;

export type AgentLoopInteractionDisplay = Readonly<{
  interactionId: string;
  interactionRevision: number;
  choices: readonly Readonly<{
    choiceId: string;
    label: string;
  }>[];
}>;

export type AgentLoopInteractionResponse = Readonly<{
  taskId: string;
  logicalSessionId: string;
  interactionId: string;
  choiceId: string;
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
  interactions = [],
  composer,
  onComposerChange,
  onSubmitInput,
  onRequestInterrupt,
  onStopTask,
  onRespondInteraction,
  showComposer = true,
}: AgentLoopSessionPresentationProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [composerError, setComposerError] = useState<string>();
  const sessionTitle = session.title?.trim() || session.agentCardId;
  const composerDisabled = Boolean(composer.disabled);
  const stopDisabled = Boolean(composer.disabled || composer.stopDisabled || isStopping);
  const composerLabel = session.kind === "card"
    ? `human → Card ${sessionTitle} / 全文同步 Conductor`
    : "发送给 Conductor";
  const entries = transcriptEntries(messages, executionGroups);

  const submitComposer = async () => {
    const content = composer.message.trim();
    if (composerDisabled || isSubmitting || !content) return;
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

  const interruptSession = async () => {
    if (!onRequestInterrupt || isInterrupting) return;
    setComposerError(undefined);
    setIsInterrupting(true);
    try {
      await onRequestInterrupt({ taskId, logicalSessionId: session.logicalSessionId });
    } catch (error) {
      setComposerError(messageFor(error));
    } finally {
      setIsInterrupting(false);
    }
  };

  return (
    <section className="awb-session-presentation" aria-label={`${sessionTitle} 会话`}>
      <AgentLoopChatTranscript
        ariaLabel="会话消息"
        className="awb-session-transcript"
        context={<dl className="awb-session-status-grid" aria-label="会话与绑定状态">
            <div><dt>Session</dt><dd>{session.kind} · {session.status}</dd></div>
            <div><dt>Binding</dt><dd>{binding.label} · {binding.status}</dd></div>
            {binding.detail ? <div><dt>状态说明</dt><dd>{binding.detail}</dd></div> : null}
          </dl>}
        empty={<p className="awb-empty">还没有可展示的统一 Message。Task 目标、用户输入、派发与 Agent 回信都会在这里出现。</p>}
        status={`${messages.length} 条消息${executionGroups.length ? ` · ${executionGroups.length} 个执行过程` : ""}`}
        title="对话"
      >
        {entries.length ? entries.map((entry) => entry.kind === "message"
          ? <SessionMessageCard message={entry.message} session={session} key={`message:${entry.message.messageId}`} />
          : <SessionExecutionGroup group={entry.group} key={`execution:${entry.group.executionGroupId}`} />) : undefined}
      </AgentLoopChatTranscript>

      {interactions.length > 0 ? (
        <section className="awb-session-interactions" aria-label="需要你的确认">
          <div className="awb-section-heading"><h4>需要你的确认</h4><span>{interactions.length}</span></div>
          {interactions.map((interaction) => (
            <InteractionResponseCard
              interaction={interaction}
              key={interaction.interactionId}
              logicalSessionId={session.logicalSessionId}
              taskId={taskId}
              onRespondInteraction={onRespondInteraction}
            />
          ))}
        </section>
      ) : null}

      {showComposer ? <AgentLoopChatComposer
        busy={isSubmitting}
        className="awb-session-composer"
        disabled={composerDisabled}
        error={composerError}
        hint={composer.continuity ? <p className={`awb-composer-warning ${composer.continuity.state}`}>{composer.continuity.message}</p> : undefined}
        label={composerLabel}
        onChange={(content) => {
          setComposerError(undefined);
          onComposerChange(content);
        }}
        onSubmit={submitComposer}
        onStop={composer.running && onRequestInterrupt ? interruptSession : undefined}
        placeholder={session.kind === "card"
          ? "直接介入此 Card；若它正在运行，将先请求中断，确认安全结束后才发送。"
          : "补充目标、纠正结论，或要求再次核实；由 Conductor 决定是否重新派发。"}
        secondaryActions={onStopTask ? <button className="awb-button awb-button-secondary" disabled={stopDisabled} type="button" onClick={() => void stopTask()}>{isStopping ? "正在停止…" : "停止任务"}</button> : undefined}
        running={Boolean(composer.running)}
        stopping={isInterrupting}
        sendTestId={composer.sendTestId}
        testId={composer.testId}
        value={composer.message}
      /> : null}
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
          <span className="awb-execution-provider">{group.providerFamily}</span>
          <ExecutionStatusIcon status={displayStatus} />
        </summary>
        <div aria-live={isRunning ? "polite" : "off"} className="awb-execution-activity-list">
          <AgentLoopProviderActivityList
            activities={group.activities}
            turnState={isRunning
              ? "running"
              : displayStatus === "completed" || displayStatus === "failed" || displayStatus === "cancelled"
                ? "settled"
                : "unsettled"}
          />
        </div>
      </details>
    </li>
  );
}

function ExecutionStatusIcon({ status }: Readonly<{ status: AgentLoopExecutionGroup["status"] }>) {
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

function executionStatusLabel(status: AgentLoopExecutionGroup["status"]): string {
  if (status === "pending") return "等待投递";
  if (status === "running") return "运行中";
  if (status === "waiting_for_interaction") return "等待用户选择";
  if (status === "awaiting_final") return "等待最终回复";
  if (status === "ambiguous") return "状态待确认";
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
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
  return <AgentLoopChatMessage
    className={`is-${message.kind} ${isFromSelectedSession ? "is-outgoing" : "is-incoming"} ${isUserMessage ? "is-user-message" : ""} ${isAssistantMessage ? "is-assistant-message" : ""}`}
    content={message.content}
    dataMessageKind={message.kind}
    detail={<><span className="awb-session-message-kind">{messageKindLabel(message.kind)}</span><time dateTime={message.createdAt} title={message.createdAt}> · {shortTimestamp(message.createdAt)}</time></>}
    direction={isFromSelectedSession ? "发送" : "收到"}
    speaker={sourceLabel}
    tone={isUserMessage ? "user" : isAssistantMessage ? "assistant" : "notice"}
  >
    {message.relayBlocks.length > 0 ? <section className="awb-message-relay-blocks" aria-label="转递内容">
          <p>转递内容 · {message.relayBlocks.length}</p>
          <ol>{message.relayBlocks.map((relayBlock) => <RelayBlockCard relayBlock={relayBlock} key={relayBlock.relayBlockId} />)}</ol>
        </section> : null}
    {deliveries.length > 0 ? <InboxDeliveryStates deliveries={deliveries} session={session} /> : null}
  </AgentLoopChatMessage>;
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

function InteractionResponseCard({
  interaction,
  taskId,
  logicalSessionId,
  onRespondInteraction,
}: Readonly<{
  interaction: AgentLoopInteractionDisplay;
  taskId: string;
  logicalSessionId: string;
  onRespondInteraction: (input: AgentLoopInteractionResponse) => Promise<void> | void;
}>) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>();

  const submit = async (choiceId: string) => {
    if (isSubmitting) return;
    setError(undefined);
    setSelectedChoiceId(choiceId);
    setIsSubmitting(true);
    try {
      await onRespondInteraction({
        taskId,
        logicalSessionId,
        interactionId: interaction.interactionId,
        choiceId,
      });
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setIsSubmitting(false);
      setSelectedChoiceId(undefined);
    }
  };

  return (
    <article className="awb-detail-item awb-session-interaction">
      <div><strong>请选择一项</strong><span>等待你的确认</span></div>
      <div className="awb-option-row" role="group" aria-label="可选回复">
        {interaction.choices.map((choice) => <button
          className="awb-option"
          disabled={isSubmitting}
          key={choice.choiceId}
          type="button"
          onClick={() => void submit(choice.choiceId)}
        >
          {isSubmitting && selectedChoiceId === choice.choiceId ? "正在提交…" : choice.label}
        </button>)}
      </div>
      {error ? <p className="awb-composer-warning" role="alert">{error}</p> : null}
    </article>
  );
}

function messageKindLabel(kind: AgentLoopSessionMessageItem["kind"]): string {
  return ({
    task_goal: "Task 目标",
    user_input: "用户输入",
    conductor_forward: "Conductor 派发",
    agent_final: "Agent 最终回信",
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
