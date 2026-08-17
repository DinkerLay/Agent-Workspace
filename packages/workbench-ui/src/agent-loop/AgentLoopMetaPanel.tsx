import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpProfileReadinessObservation, ProviderActivityReadModel } from "@agent-workspace/runtime-contracts";
import { ChevronDown, PanelLeftClose, Plus, SlidersHorizontal } from "lucide-react";
import {
  AgentLoopChatComposer,
  AgentLoopChatMessage,
  AgentLoopProviderActivityList,
  AgentLoopChatTranscript,
} from "./AgentLoopChatUI";

export type AgentLoopMetaScope = Readonly<{
  kind: "template_design" | "task_setup";
  draftId: string;
  draftRevision: number;
}>;

export type AgentLoopMetaProfileOptionV3 = Readonly<{
  schemaVersion: 3;
  metaProfileOptionId: string;
  label: string;
  providerFamily: AcpProfileReadinessObservation["providerFamily"];
  model: string;
  modelCatalog?: readonly Readonly<{ modelId: string; label: string }>[];
  configIntent: Readonly<Record<string, unknown>>;
  readiness: AcpProfileReadinessObservation;
}>;

/** The production Meta surface is ACP-only; historical direct-provider options are not renderable. */
export type AgentLoopMetaProfileOption = AgentLoopMetaProfileOptionV3;

export type AgentLoopMetaMessage = Readonly<{
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  activities?: readonly ProviderActivityReadModel[];
  turnStatus?: "creating" | "active" | "idle" | "ambiguous" | "failed";
}>;

export type AgentLoopMetaPatchFieldDiff = Readonly<{
  path: string;
  operation: "add" | "remove" | "replace";
  before?: string;
  after?: string;
}>;

export type AgentLoopMetaPatchProposal = Readonly<{
  proposalId: string;
  assistantMessageId: string;
  baseDraftRevision: number;
  status: "pending" | "applied" | "rejected" | "stale";
  summary: string;
  rationale?: string;
  fieldDiffs: readonly AgentLoopMetaPatchFieldDiff[];
  validationIssues: readonly string[];
  unresolvedItems: readonly string[];
}>;

export type AgentLoopMetaTarget =
  | Readonly<{ kind: "template"; label: string }>
  | Readonly<{ kind: "conductor"; agentCardId: string; label: string }>
  | Readonly<{ kind: "agent_card"; agentCardId: string; label: string }>;

export type AgentLoopMetaPanelViewModel = Readonly<{
  profileOptions: readonly AgentLoopMetaProfileOption[];
  session?: Readonly<{
    metaSessionId: string;
    metaProfileOptionId?: string;
    revision: number;
    status: "creating" | "active" | "idle" | "ambiguous" | "failed";
    messages: readonly AgentLoopMetaMessage[];
    activities: readonly ProviderActivityReadModel[];
  }>;
  proposals: readonly AgentLoopMetaPatchProposal[];
}>;

type MetaPatchAction = Readonly<{
  scope: AgentLoopMetaScope;
  proposalId: string;
  expectedDraftRevision: number;
}>;

export type AgentLoopMetaPanelController = Readonly<{
  load(scope: AgentLoopMetaScope): Promise<AgentLoopMetaPanelViewModel>;
  subscribe?(onChanged: () => void): Promise<() => Promise<void> | void>;
  createSession(input: Readonly<{ scope: AgentLoopMetaScope; metaProfileOptionId: string }>): Promise<void>;
  sendMessage(input: Readonly<{
    scope: AgentLoopMetaScope;
    metaSessionId: string;
    expectedSessionRevision: number;
    content: string;
  }>): Promise<void>;
  applyPatch(input: MetaPatchAction): Promise<void>;
  rejectPatch(input: MetaPatchAction): Promise<void>;
  abandonSession(input: Readonly<{
    scope: AgentLoopMetaScope;
    metaSessionId: string;
    expectedSessionRevision: number;
  }>): Promise<void>;
}>;

export type AgentLoopMetaPanelProps = Readonly<{
  controller: AgentLoopMetaPanelController;
  scope: AgentLoopMetaScope;
  placement: "floating" | "docked";
  draftDirty?: boolean;
  onClose: () => void;
  onDockChange: (placement: "floating" | "docked") => void;
  onPatchApplied?: () => Promise<void> | void;
  onCollapse?: () => void;
  targets?: readonly AgentLoopMetaTarget[];
  showViewControls?: boolean;
}>;

/**
 * Configuration-only Meta surface. It can ask for and review a scoped patch,
 * but it intentionally owns no Publish, Task Create/Start, Runtime transcript,
 * Workspace, or Provider credential action.
 */
export function AgentLoopMetaPanel({
  controller,
  draftDirty = false,
  onClose,
  onDockChange,
  onPatchApplied,
  onCollapse,
  placement,
  showViewControls = true,
  scope,
  targets = [],
}: AgentLoopMetaPanelProps) {
  const [view, setView] = useState<AgentLoopMetaPanelViewModel>();
  const [selectedMetaProfileOptionId, setSelectedMetaProfileOptionId] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingSubmission, setPendingSubmission] = useState<Readonly<{
    content: string;
    stage: "validating" | "submitting";
  }>>();
  const [queuedDraft, setQueuedDraft] = useState<Readonly<{
    content: string;
    draftId: string;
    draftRevision: number;
    metaProfileOptionId: string;
    metaSessionId?: string;
  }>>();
  const loadEpoch = useRef(0);
  const previousTurnActive = useRef(false);

  const refresh = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    const next = await controller.load(scope);
    if (epoch === loadEpoch.current) setView(next);
    return next;
  }, [controller, scope.draftId, scope.draftRevision, scope.kind]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, [refresh]);

  useEffect(() => {
    if (!view) return;
    const sessionOptionId = view.session?.metaProfileOptionId;
    if (sessionOptionId) {
      setSelectedMetaProfileOptionId(sessionOptionId);
      return;
    }
    setSelectedMetaProfileOptionId((currentOptionId) => {
      const current = view.profileOptions.find((option) =>
        option.metaProfileOptionId === currentOptionId);
      if (current) return currentOptionId;
      const preferred = view.profileOptions.find((option) => option.readiness.status === "available")
        ?? view.profileOptions[0];
      return preferred?.metaProfileOptionId ?? "";
    });
  }, [view]);

  useEffect(() => {
    if (!controller.subscribe) return undefined;
    let disposed = false;
    let unsubscribe: (() => Promise<void> | void) | undefined;
    void controller.subscribe(() => {
      void refresh().catch((reason: unknown) => {
        if (!disposed) setError(messageFor(reason));
      });
    }).then((release) => {
      if (disposed) void release();
      else unsubscribe = release;
    }).catch((reason: unknown) => {
      if (!disposed) setError(messageFor(reason));
    });
    return () => {
      disposed = true;
      void unsubscribe?.();
    };
  }, [controller, refresh]);

  const runAction = useCallback(async (key: string, operation: () => Promise<void>): Promise<boolean> => {
    setAction(key);
    setError(undefined);
    try {
      await operation();
      await refresh();
      return true;
    } catch (reason) {
      setError(messageFor(reason));
      return false;
    } finally {
      setAction(undefined);
    }
  }, [refresh]);

  const dispatchMessage = useCallback((rawContent: string) => {
    const content = rawContent.trim();
    const selectedProfile = view?.profileOptions.find((option) =>
      option.metaProfileOptionId === selectedMetaProfileOptionId);
    const existingSession = view?.session;
    if (!content
      || existingSession?.status === "creating"
      || existingSession?.status === "ambiguous"
      || !selectedProfile
      || (!existingSession && !canOpenMetaProfile(selectedProfile))) return;
    setMessage("");
    setPendingSubmission({
      content,
      stage: existingSession ? "submitting" : "validating",
    });
    void (async () => {
      const succeeded = await runAction("send-message", async () => {
        let session = existingSession;
        if (!session) {
          await controller.createSession({
            scope,
            metaProfileOptionId: selectedProfile.metaProfileOptionId,
          });
          setPendingSubmission({ content, stage: "submitting" });
          const created = await controller.load(scope);
          session = created.session;
          if (!session || session.metaProfileOptionId !== selectedProfile.metaProfileOptionId) {
            throw new Error("agent_loop_meta_session_create_result_missing");
          }
          setView(created);
        }
        await controller.sendMessage({
          scope,
          metaSessionId: session.metaSessionId,
          expectedSessionRevision: session.revision,
          content: metaInstruction(content, targets),
        });
      });
      setPendingSubmission(undefined);
      if (!succeeded) {
        setMessage(content);
      }
    })();
  }, [controller, runAction, scope, selectedMetaProfileOptionId, targets, view]);

  const submitMessage = useCallback(() => dispatchMessage(message), [dispatchMessage, message]);

  const applyPatch = useCallback((proposal: AgentLoopMetaPatchProposal) => {
    if (draftDirty
      || proposal.validationIssues.length > 0
      || proposal.status !== "pending"
      || proposal.baseDraftRevision !== scope.draftRevision) return;
    void runAction(`apply:${proposal.proposalId}`, async () => {
      await controller.applyPatch({
        scope,
        proposalId: proposal.proposalId,
        expectedDraftRevision: scope.draftRevision,
      });
      await onPatchApplied?.();
    });
  }, [controller, draftDirty, onPatchApplied, runAction, scope]);

  const rejectPatch = useCallback((proposal: AgentLoopMetaPatchProposal) => {
    if (proposal.status !== "pending") return;
    void runAction(`reject:${proposal.proposalId}`, () => controller.rejectPatch({
      scope,
      proposalId: proposal.proposalId,
      expectedDraftRevision: scope.draftRevision,
    }));
  }, [controller, runAction, scope]);

  const session = view?.session;
  const profile = view?.profileOptions.find((option) => option.metaProfileOptionId
    === (session?.metaProfileOptionId ?? selectedMetaProfileOptionId))
    ?? (session ? undefined : view?.profileOptions.find((option) =>
      option.readiness.status === "available" || option.readiness.status === "checking")
      ?? view?.profileOptions[0]);
  const pendingProposals = view?.proposals.filter((proposal) => proposal.status === "pending" || proposal.status === "stale") ?? [];
  const proposalByAssistantMessageId = new Map(pendingProposals.map((proposal) => [proposal.assistantMessageId, proposal] as const));
  const linkedProposalIds = new Set(session?.messages.map((message) => message.messageId) ?? []);
  const orphanProposals = pendingProposals.filter((proposal) => !linkedProposalIds.has(proposal.assistantMessageId));
  const acpProfileOptions = view?.profileOptions ?? [];
  const providerFamilies = uniqueStrings(acpProfileOptions.map((option) => option.providerFamily));
  const selectedProviderFamily = profile?.providerFamily ?? providerFamilies[0] ?? "";
  const providerProfileOptions = acpProfileOptions.filter((option) => option.providerFamily === selectedProviderFamily);
  const models = metaModelChoices(providerProfileOptions);
  const hasObservedMetaModels = models.length > 0;
  const selectedModel = profile?.model ?? models[0]?.modelId ?? "";
  const modelProfileOptions = providerProfileOptions.filter((option) => option.model === selectedModel);
  const effortOptions = uniqueStrings(modelProfileOptions.map(metaProfileEffort));
  const selectedEffort = profile ? metaProfileEffort(profile) : effortOptions[0] ?? "";
  const isBusy = Boolean(action);
  const turnInFlight = session?.status === "creating";
  const turnUnsettled = session?.status === "ambiguous";
  const turnGenerating = turnInFlight || Boolean(pendingSubmission) || action === "send-message";
  const turnBlocksNextMessage = turnGenerating || turnUnsettled;
  const hasConfiguredMetaProfile = Boolean(view?.profileOptions.length);
  const profileOpenable = Boolean(profile && canOpenMetaProfile(profile));
  const canSubmitToSession = Boolean(profile && (session || profileOpenable));
  const runtimeStatusTone = session
    ? metaSessionRuntimeStatusTone(session.status)
    : profile
      ? metaProfileStatus(profile)
      : "unavailable";
  const runtimeStatusLabel = session
    ? metaSessionRuntimeStatusLabel(session.status)
    : profile
      ? metaProfileStatusLabel(metaProfileStatus(profile))
      : "未配置";
  const profileBlockingMessage = !session && profile && !profileOpenable
    ? metaProfileBlockingMessage(profile)
    : undefined;
  const metaAgentTitle = scope.kind === "template_design" ? "Template Meta Agent" : "Task Setup Meta Agent";
  const hasConversationEntries = Boolean(
    session?.messages.length || pendingProposals.length || turnInFlight || turnUnsettled || pendingSubmission,
  );
  const sessionStarterDescription = hasConfiguredMetaProfile
    ? "选择下方运行配置并直接发送；首次发送会自动建立这个 Draft 专属的 Meta Session。"
    : "当前 Host 没有配置可用的 Meta ACP Profile；配置后即可直接发送。";
  const liveTraceActivities = session?.activities.filter((activity) => activity.kind === "tool"
    || activity.contentKind === "reasoning") ?? [];
  const candidateStatus = turnUnsettled
    ? metaCandidateStatus(session?.status)
    : undefined;

  const startNewSession = useCallback(() => {
    if (!session || action) return;
    void (async () => {
      const succeeded = await runAction("new-session", () => controller.abandonSession({
        scope,
        metaSessionId: session.metaSessionId,
        expectedSessionRevision: session.revision,
      }));
      if (!succeeded) return;
      setMessage("");
      setPendingSubmission(undefined);
      setQueuedDraft(undefined);
    })();
  }, [action, controller, runAction, scope, session]);

  useEffect(() => {
    const wasActive = previousTurnActive.current;
    previousTurnActive.current = turnBlocksNextMessage;
    if (!wasActive || turnBlocksNextMessage || !queuedDraft) return;
    const targetIsCurrent = queuedDraft.draftId === scope.draftId
      && queuedDraft.draftRevision === scope.draftRevision
      && queuedDraft.metaProfileOptionId === (session?.metaProfileOptionId ?? selectedMetaProfileOptionId)
      && (!queuedDraft.metaSessionId || queuedDraft.metaSessionId === session?.metaSessionId);
    setQueuedDraft(undefined);
    if (!targetIsCurrent) {
      setMessage(queuedDraft.content);
      setError("排队消息的 Draft 或 Meta Session 已变化；内容已退回输入框，没有改投。");
      return;
    }
    dispatchMessage(queuedDraft.content);
  }, [dispatchMessage, queuedDraft, scope.draftId, scope.draftRevision, selectedMetaProfileOptionId, session?.metaProfileOptionId, session?.metaSessionId, turnBlocksNextMessage]);

  return (
    <aside aria-label="Meta Agent panel" className={`awb-agent-loop-meta-panel is-${placement}`}>
      <header className="awb-agent-loop-meta-head">
        <div><p className="awb-eyebrow">Configuration assistant</p><h2>{metaAgentTitle}</h2></div>
        {showViewControls || onCollapse ? <div className="awb-agent-loop-meta-view-actions">
          {onCollapse ? <button
            aria-label="收起 Meta Agent 侧栏"
            className="awb-agent-loop-icon-button"
            data-testid="meta-panel-collapse"
            onClick={onCollapse}
            title="收起 Meta Agent 侧栏"
            type="button"
          ><PanelLeftClose aria-hidden="true" size={16} /></button> : null}
          {showViewControls ? <>
          <button
            aria-label={placement === "floating" ? "停靠 Meta panel" : "浮动 Meta panel"}
            className="awb-agent-loop-icon-button"
            data-testid="meta-dock-toggle"
            onClick={() => onDockChange(placement === "floating" ? "docked" : "floating")}
            type="button"
          >{placement === "floating" ? "⇤" : "↗"}</button>
          <button aria-label="关闭 Meta panel" className="awb-agent-loop-icon-button" data-testid="meta-close" onClick={onClose} type="button">×</button>
          </> : null}
        </div> : null}
      </header>

      {targets.length ? <section aria-label="当前 AI 修订目标" className="awb-agent-loop-meta-targets">
        <header><strong>本轮修订目标</strong><span>显式选择</span></header>
        <div>{targets.map((target) => <span key={metaTargetKey(target)}>{metaTargetToken(target)}</span>)}</div>
        <p>画布中的选中对象只控制 Inspector，不会偷偷改变这里。</p>
      </section> : null}

      {error ? <p className="awb-agent-loop-form-error" role="alert">{error}</p> : null}
      <AgentLoopChatTranscript
        ariaLabel="Meta conversation"
        className="awb-agent-loop-meta-chat"
        empty={session ? <p className="awb-empty">Meta Session 已建立。输入修订目标开始本轮对话。</p> : <div className="awb-agent-loop-meta-chat-empty" data-testid="meta-no-active-session">
          <strong>开始一次真实的 Draft 修订对话</strong>
          <p>{sessionStarterDescription}</p>
        </div>}
        status={`${pendingSubmission ? pendingSubmissionStatus(pendingSubmission.stage) : metaConversationStatus(session?.status)}${pendingProposals.length ? ` · ${pendingProposals.length} 个候选 Patch` : ""}`}
        testId={session ? "meta-active-session" : "meta-conversation"}
        title="对话"
      >
        {hasConversationEntries ? <>
          {!session && !pendingSubmission ? <AgentLoopChatMessage
            content="开始一次真实的 Draft 修订对话"
            speaker={metaAgentTitle}
            tone="notice"
          >
            <div className="awb-agent-loop-meta-chat-empty is-inline" data-testid="meta-no-active-session">
              <p>{sessionStarterDescription}</p>
            </div>
          </AgentLoopChatMessage> : null}
          {session?.messages.map((item) => {
            const proposal = proposalByAssistantMessageId.get(item.messageId);
            const traceActivities = item.activities?.filter((activity) => activity.kind === "tool"
              || activity.contentKind === "reasoning") ?? [];
            return <AgentLoopChatMessage
              content={item.content}
              detail={<time dateTime={item.createdAt}>{shortTimestamp(item.createdAt)}</time>}
              direction={item.role === "assistant" ? "最终回复" : "发送"}
              key={item.messageId}
              leading={item.role === "assistant" && traceActivities.length ? <div className="awb-agent-loop-meta-tool-trace">
                <AgentLoopProviderActivityList
                  activities={traceActivities}
                  turnState={metaActivityTurnState(item.turnStatus)}
                />
              </div> : undefined}
              speaker={item.role === "assistant" ? metaAgentTitle : "你"}
              tone={item.role}
            >{proposal ? <MetaPatchProposalCard
              action={action}
              draftDirty={draftDirty}
              onApply={() => applyPatch(proposal)}
              onReject={() => rejectPatch(proposal)}
              proposal={proposal}
              targetRevision={scope.draftRevision}
            /> : null}</AgentLoopChatMessage>;
          })}
          {pendingSubmission ? <AgentLoopChatMessage
            className="awb-agent-loop-meta-pending-message"
            content={pendingSubmission.content}
            direction="发送中"
            speaker="你"
            tone="user"
          >
            <p aria-live="polite" className="awb-agent-loop-meta-pending-stage">
              {pendingSubmissionStatus(pendingSubmission.stage)}
            </p>
          </AgentLoopChatMessage> : null}
          {turnInFlight || turnUnsettled ? <AgentLoopChatMessage
            className="awb-agent-loop-meta-stream-message"
            content=""
            speaker={metaAgentTitle}
            tone="assistant"
          >
            <div aria-live="polite" className="awb-execution-activity-list">
              {liveTraceActivities.length || !candidateStatus ? <AgentLoopProviderActivityList
                activities={liveTraceActivities}
                turnState={session?.status === "ambiguous" ? "unsettled" : "running"}
              /> : null}
              {candidateStatus ? <p className="awb-agent-loop-meta-candidate-status">{candidateStatus}</p> : null}
            </div>
          </AgentLoopChatMessage> : null}
          {orphanProposals.map((proposal) => <AgentLoopChatMessage
            className={`awb-agent-loop-meta-proposal-message is-${proposal.status}`}
            content={proposal.summary}
            key={`proposal:${proposal.proposalId}`}
            speaker={metaAgentTitle}
            tone="assistant"
          >
            <MetaPatchProposalCard
              action={action}
              draftDirty={draftDirty}
              onApply={() => applyPatch(proposal)}
              onReject={() => rejectPatch(proposal)}
              proposal={proposal}
              targetRevision={scope.draftRevision}
            />
          </AgentLoopChatMessage>)}
        </> : undefined}
      </AgentLoopChatTranscript>
      <AgentLoopChatComposer
        className="awb-agent-loop-meta-composer"
        controls={<>
        <div className="awb-agent-loop-meta-runtime-bar">
          {session ? <div className="awb-agent-loop-meta-runtime-summary is-locked">
            <SlidersHorizontal aria-hidden="true" size={13} />
            <strong>{providerFamilyLabel(selectedProviderFamily)} · {selectedModel} · {effortLabel(selectedEffort)}</strong>
            <span>本 Session 已锁定</span>
          </div> : <details className="awb-agent-loop-meta-runtime-picker">
            <summary>
              <SlidersHorizontal aria-hidden="true" size={13} />
              <strong>{profile
                ? `${providerFamilyLabel(selectedProviderFamily)} · ${selectedModel} · ${effortLabel(selectedEffort)}`
                : "选择运行配置"}</strong>
              <ChevronDown aria-hidden="true" size={13} />
            </summary>
            <div className="awb-agent-loop-meta-runtime-controls">
          <label>Provider<select
            aria-label="Meta Provider"
            disabled={isBusy || providerFamilies.length === 0}
            onChange={(event) => {
              const next = preferredMetaProfile(acpProfileOptions.filter((option) => option.providerFamily === event.target.value));
              setSelectedMetaProfileOptionId(next?.metaProfileOptionId ?? "");
            }}
            value={selectedProviderFamily}
          >{providerFamilies.length ? providerFamilies.map((providerFamily) => <option key={providerFamily} value={providerFamily}>{providerFamilyLabel(providerFamily)}</option>) : <option value="">未配置</option>}</select></label>
          <label>Model<select
            aria-label="Meta Model"
            disabled={isBusy || !hasObservedMetaModels}
            onChange={(event) => {
              const next = preferredMetaProfile(providerProfileOptions.filter((option) => option.model === event.target.value));
              setSelectedMetaProfileOptionId(next?.metaProfileOptionId ?? "");
            }}
            value={selectedModel}
          >{models.length ? models.map((model) => <option
            key={model.modelId}
            value={model.modelId}
          >{model.label}</option>) : <option value="">设置页尚未启用模型</option>}</select></label>
          <label>Effort<select
            aria-label="Meta Effort"
            disabled={isBusy || effortOptions.length === 0}
            onChange={(event) => {
              const next = preferredMetaProfile(modelProfileOptions.filter((option) => metaProfileEffort(option) === event.target.value));
              setSelectedMetaProfileOptionId(next?.metaProfileOptionId ?? "");
            }}
            value={selectedEffort}
          >{effortOptions.length ? effortOptions.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>) : <option value="">Default</option>}</select></label>
            </div>
          </details>}
          <span className={`awb-agent-loop-meta-runtime-status is-${runtimeStatusTone}`}>{runtimeStatusLabel}</span>
        </div>
        {profileBlockingMessage ? <p className="awb-agent-loop-meta-runtime-diagnostic" role="status">{profileBlockingMessage}</p> : null}
        </>}
        disabled={!canSubmitToSession || turnUnsettled}
        label="发送给 Meta Agent"
        onChange={setMessage}
        onCancelQueued={() => setQueuedDraft(undefined)}
        onEditQueued={() => {
          if (!queuedDraft) return;
          setMessage(queuedDraft.content);
          setQueuedDraft(undefined);
        }}
        onQueue={() => {
          const content = message.trim();
          if (!content || !profile) return;
          setQueuedDraft(Object.freeze({
            content,
            draftId: scope.draftId,
            draftRevision: scope.draftRevision,
            metaProfileOptionId: profile.metaProfileOptionId,
            ...(session ? { metaSessionId: session.metaSessionId } : {}),
          }));
          setMessage("");
        }}
        onSubmit={submitMessage}
        placeholder={canSubmitToSession
          ? turnUnsettled
            ? "本轮未完整结束；点击 New 开始新的 Meta Session。"
            : session?.status === "failed"
            ? "上次连接失败；发送新消息会重新连接当前 Meta Session。"
            : "例如：@Researcher 强化来源交叉验证，并给出可审阅 Patch。"
          : profile
            ? "当前配置未通过 ACP 验证；请选择其他 Provider、Model 或 Effort。"
            : "先配置可用的 Meta ACP Profile。"}
        rows={4}
        running={turnGenerating}
        runningLabel="生成中…"
        queuedDraft={queuedDraft ? { content: queuedDraft.content, targetLabel: metaAgentTitle } : undefined}
        secondaryActions={session ? <button
          aria-label="新建 Meta Session"
          className="awb-button awb-button-secondary awb-agent-loop-meta-new-session"
          data-testid="meta-new-session"
          disabled={isBusy}
          onClick={startNewSession}
          title="结束当前 Meta Session，并返回运行配置选择"
          type="button"
        ><Plus aria-hidden="true" size={13} />New</button> : undefined}
        sendTestId="meta-send"
        testId="meta-composer"
        value={message}
      />

      {!profile ? <p className="awb-agent-loop-muted">{view
        ? hasConfiguredMetaProfile
          ? "没有可用的 Meta profile option。"
          : "此 Runtime Host 尚未配置 Meta Agent。Meta 仅在 Template Draft 和 Task Setup 中可用；请由 Host 管理员配置受验证的 Meta Profile。"
        : "正在读取 Meta profile…"}</p> : null}
    </aside>
  );
}

function MetaPatchProposalCard({
  action,
  draftDirty,
  onApply,
  onReject,
  proposal,
  targetRevision,
}: Readonly<{
  action: string | undefined;
  draftDirty: boolean;
  onApply: () => void;
  onReject: () => void;
  proposal: AgentLoopMetaPatchProposal;
  targetRevision: number;
}>) {
  const blocked = Boolean(action);
  return <section aria-label="Meta patch proposal" className={`awb-agent-loop-meta-proposal is-${proposal.status}`}>
    <header>
      <div><strong>Template Patch</strong>{proposal.rationale ? <p>{proposal.rationale}</p> : null}</div>
      <span>Draft r{proposal.baseDraftRevision}</span>
    </header>
    <p className="awb-agent-loop-meta-proposal-summary">{proposal.summary}</p>
    <ol className="awb-agent-loop-meta-diff">
      {proposal.fieldDiffs.map((diff, index) => <li key={`${diff.path}:${index}`}>
        <div><code data-testid="meta-diff-path">{diff.path}</code><span>{diff.operation}</span></div>
        {diff.before !== undefined ? <MetaPatchDiffValue path={diff.path} tone="before" value={diff.before} /> : null}
        {diff.after !== undefined ? <MetaPatchDiffValue path={diff.path} tone="after" value={diff.after} /> : null}
      </li>)}
    </ol>
    {proposal.validationIssues.length ? <div className="awb-agent-loop-meta-issues"><strong>校验</strong><ul>{proposal.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : null}
    {proposal.unresolvedItems.length ? <div className="awb-agent-loop-meta-unresolved"><strong>未解决</strong><ul>{proposal.unresolvedItems.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
    {draftDirty ? <p className="awb-agent-loop-meta-dirty">先保存或撤销本地手工修改，再应用 Meta patch。</p> : null}
    {proposal.baseDraftRevision !== targetRevision ? <p className="awb-agent-loop-meta-dirty">Draft revision 已变化；此 patch 已 stale，不能覆盖当前 Draft。</p> : null}
    <footer>
      <button className="awb-button awb-button-secondary" disabled={blocked || proposal.status !== "pending"} onClick={onReject} type="button">拒绝 patch</button>
      <button
        className="awb-button awb-button-primary"
        data-testid="meta-apply-proposal"
        disabled={blocked
          || draftDirty
          || proposal.validationIssues.length > 0
          || proposal.status !== "pending"
          || proposal.baseDraftRevision !== targetRevision}
        onClick={onApply}
        type="button"
      >应用 patch</button>
    </footer>
  </section>;
}

function MetaPatchDiffValue({
  path,
  tone,
  value,
}: Readonly<{ path: string; tone: "before" | "after"; value: string }>) {
  const card = path.startsWith("definition.agentCards[") ? parseCardDiffValue(value) : undefined;
  const content = card ? <span className="awb-agent-loop-meta-card-diff">
    <strong>{card.title}</strong>
    <span>{card.kind} · {card.executionProfileId}</span>
    {card.description ? <small>{card.description}</small> : null}
  </span> : value;
  return <pre className={card ? "is-card-summary" : undefined}>
    {tone === "before" ? <del>{content}</del> : <ins>{content}</ins>}
  </pre>;
}

function parseCardDiffValue(value: string): Readonly<{
  title: string;
  kind: string;
  executionProfileId: string;
  description?: string;
}> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const card = parsed as Record<string, unknown>;
    if (typeof card.title !== "string" || typeof card.kind !== "string" || typeof card.executionProfileId !== "string") return undefined;
    const dispatch = card.dispatchProfile;
    const description = dispatch && typeof dispatch === "object" && !Array.isArray(dispatch)
      && typeof (dispatch as Record<string, unknown>).description === "string"
      ? (dispatch as Record<string, unknown>).description as string
      : undefined;
    return { title: card.title, kind: card.kind, executionProfileId: card.executionProfileId, ...(description ? { description } : {}) };
  } catch {
    return undefined;
  }
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function metaProfileStatus(option: AgentLoopMetaProfileOption): "available" | "unavailable" | "checking" | "capability_missing" {
  return option.readiness.status;
}

function metaProfileStatusLabel(status: ReturnType<typeof metaProfileStatus>): string {
  if (status === "available") return "可用";
  if (status === "checking") return "检查中";
  if (status === "capability_missing") return "能力缺失";
  return "不可用";
}

function metaSessionRuntimeStatusTone(
  status: "creating" | "active" | "idle" | "ambiguous" | "failed",
): "available" | "checking" {
  return status === "active" || status === "idle" ? "available" : "checking";
}

function metaSessionRuntimeStatusLabel(
  status: "creating" | "active" | "idle" | "ambiguous" | "failed",
): string {
  if (status === "active" || status === "idle") return "已连接";
  if (status === "ambiguous") return "需要重试";
  if (status === "failed") return "可重试";
  return "生成中";
}

function metaProfileBlockingMessage(option: AgentLoopMetaProfileOptionV3): string {
  if (option.readiness.status === "capability_missing" || option.readiness.missingCapabilities.length) {
    return "当前 ACP Agent 缺少此 Profile 所需能力。请选择其他 Provider、Model 或 Effort。";
  }
  const reason = option.readiness.reasons[0];
  if (reason === "acp_profile_probe_failed") {
    return "最近一次 ACP 资格探测失败。模型目录仅表示已发现；请检查此 Provider、Model 与 Effort 后重试。";
  }
  if (reason === "provider_not_configured" || reason === "acp_task_provider_not_configured") {
    return "此 Provider 尚未完成设备配置。请先到设置确认 CLI 与登录源。";
  }
  if (reason === "model_not_available" || reason === "profile_model_not_observed") {
    return "当前 ACP 模型目录中没有这个模型。请在设置中刷新目录并重新选择。";
  }
  return reason
    ? `当前配置未通过 ACP readiness（${reason}）。设置中的模型目录仅表示已发现；请选择其他配置后重试。`
    : "当前配置未通过 ACP readiness。设置中的模型目录仅表示已发现；请选择其他配置后重试。";
}

function metaConversationStatus(status: "creating" | "active" | "idle" | "ambiguous" | "failed" | undefined): string {
  if (status === "active" || status === "idle") return "已连接";
  if (status === "creating") return "正在生成完整响应";
  if (status === "ambiguous") return "本轮未完成";
  if (status === "failed") return "连接失败";
  return "尚未连接";
}

function metaActivityTurnState(
  status: AgentLoopMetaMessage["turnStatus"],
): "running" | "settled" | "unsettled" {
  if (status === "creating" || status === "active") return "running";
  if (status === "ambiguous") return "unsettled";
  return "settled";
}

function pendingSubmissionStatus(stage: "validating" | "submitting"): string {
  return stage === "validating" ? "正在验证 ACP 环境…" : "正在提交消息…";
}

function metaCandidateStatus(
  status: "creating" | "active" | "idle" | "ambiguous" | "failed" | undefined,
): string | undefined {
  if (status === "ambiguous") {
    return "这次生成未完整结束，因此没有创建可应用 Patch。点击 New 后重试；Draft 未被修改。";
  }
  return undefined;
}

function shortTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function canOpenMetaProfile(option: AgentLoopMetaProfileOptionV3): boolean {
  return option.readiness.status === "available" || option.readiness.status === "checking";
}

function preferredMetaProfile(
  options: readonly AgentLoopMetaProfileOptionV3[],
): AgentLoopMetaProfileOptionV3 | undefined {
  return options.find((option) => option.readiness.status === "available")
    ?? options.find((option) => option.readiness.status === "checking")
    ?? options[0];
}

function metaProfileEffort(option: AgentLoopMetaProfileOptionV3): string {
  const value = option.configIntent.reasoningEffort;
  return typeof value === "string" && value.trim() ? value : "default";
}

function effortLabel(value: string): string {
  return value === "default" ? "Default" : value;
}

function providerFamilyLabel(providerFamily: string): string {
  if (providerFamily === "codex") return "Codex";
  if (providerFamily === "claude-code") return "Claude Code";
  if (providerFamily === "opencode") return "OpenCode";
  return providerFamily;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function metaModelChoices(
  options: readonly AgentLoopMetaProfileOptionV3[],
): readonly Readonly<{ modelId: string; label: string; configured: boolean; observed: boolean }>[] {
  const choices = new Map<string, { modelId: string; label: string; configured: boolean; observed: boolean }>();
  for (const option of options) {
    const catalogEntry = option.modelCatalog?.find((entry) => entry.modelId === option.model);
    choices.set(option.model, {
      modelId: option.model,
      label: catalogEntry?.label ?? option.model,
      configured: true,
      observed: Boolean(catalogEntry),
    });
  }
  return Object.freeze([...choices.values()].map((entry) => Object.freeze(entry)));
}

function metaInstruction(content: string, targets: readonly AgentLoopMetaTarget[]): string {
  if (targets.length === 0) return content;
  return `修改目标：${targets.map((target) => `${metaTargetCommandToken(target)}${target.kind === "template" ? "" : `（${target.label}）`}`).join("、")}\n\n${content}`;
}

function metaTargetToken(target: AgentLoopMetaTarget): string {
  if (target.kind === "template") return "@Template";
  if (target.kind === "conductor") return "@Conductor";
  return `@${target.label}`;
}

function metaTargetCommandToken(target: AgentLoopMetaTarget): string {
  if (target.kind === "template") return "@Template";
  if (target.kind === "conductor") return "@Conductor";
  return `@${target.agentCardId}`;
}

function metaTargetKey(target: AgentLoopMetaTarget): string {
  return target.kind === "template" ? "template" : `${target.kind}:${target.agentCardId}`;
}
