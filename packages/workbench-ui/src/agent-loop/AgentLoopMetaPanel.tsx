import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpProfileReadinessObservation } from "@agent-workspace/runtime-contracts";
import { PanelLeftClose } from "lucide-react";
import {
  AgentLoopChatComposer,
  AgentLoopChatMessage,
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
}>;

export type AgentLoopMetaPatchFieldDiff = Readonly<{
  path: string;
  operation: "add" | "remove" | "replace";
  before?: string;
  after?: string;
}>;

export type AgentLoopMetaPatchProposal = Readonly<{
  proposalId: string;
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
  const loadEpoch = useRef(0);

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

  const runAction = useCallback(async (key: string, operation: () => Promise<void>) => {
    setAction(key);
    setError(undefined);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setAction(undefined);
    }
  }, [refresh]);

  const submitMessage = useCallback(() => {
    const content = message.trim();
    const selectedProfile = view?.profileOptions.find((option) =>
      option.metaProfileOptionId === selectedMetaProfileOptionId);
    const existingSession = view?.session;
    if (!content
      || existingSession?.status === "creating"
      || existingSession?.status === "ambiguous"
      || !selectedProfile
      || !canOpenMetaProfile(selectedProfile)) return;
    void runAction("send-message", async () => {
      let session = existingSession;
      if (!session) {
        await controller.createSession({
          scope,
          metaProfileOptionId: selectedProfile.metaProfileOptionId,
        });
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
      setMessage("");
    });
  }, [controller, message, runAction, scope, selectedMetaProfileOptionId, targets, view]);

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
  const acpProfileOptions = view?.profileOptions ?? [];
  const providerFamilies = uniqueStrings(acpProfileOptions.map((option) => option.providerFamily));
  const selectedProviderFamily = profile?.providerFamily ?? providerFamilies[0] ?? "";
  const providerProfileOptions = acpProfileOptions.filter((option) => option.providerFamily === selectedProviderFamily);
  const models = metaModelChoices(providerProfileOptions);
  const hasObservedMetaModels = models.some((model) => model.observed);
  const selectedModel = profile?.model ?? models[0]?.modelId ?? "";
  const modelProfileOptions = providerProfileOptions.filter((option) => option.model === selectedModel);
  const effortOptions = uniqueStrings(modelProfileOptions.map(metaProfileEffort));
  const selectedEffort = profile ? metaProfileEffort(profile) : effortOptions[0] ?? "";
  const isBusy = Boolean(action);
  const turnInFlight = session?.status === "creating" || session?.status === "ambiguous";
  const hasConfiguredMetaProfile = Boolean(view?.profileOptions.length);
  const profileOpenable = Boolean(profile && canOpenMetaProfile(profile));
  const metaAgentTitle = scope.kind === "template_design" ? "Template Meta Agent" : "Task Setup Meta Agent";
  const hasConversationEntries = Boolean(session?.messages.length || pendingProposals.length);
  const sessionStarterDescription = hasConfiguredMetaProfile
    ? "选择下方运行配置并直接发送；首次发送会自动建立这个 Draft 专属的 Meta Session。"
    : "当前 Host 没有配置可用的 Meta ACP Profile；配置后即可直接发送。";

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
        status={`${metaConversationStatus(session?.status)}${pendingProposals.length ? ` · ${pendingProposals.length} 个候选 Patch` : ""}`}
        testId={session ? "meta-active-session" : "meta-conversation"}
        title="对话"
      >
        {hasConversationEntries ? <>
          {!session ? <AgentLoopChatMessage
            content="开始一次真实的 Draft 修订对话"
            speaker={metaAgentTitle}
            tone="notice"
          >
            <div className="awb-agent-loop-meta-chat-empty is-inline" data-testid="meta-no-active-session">
              <p>{sessionStarterDescription}</p>
            </div>
          </AgentLoopChatMessage> : null}
          {session?.messages.map((item) => <AgentLoopChatMessage
            content={item.content}
            detail={<time dateTime={item.createdAt}>{shortTimestamp(item.createdAt)}</time>}
            direction={item.role === "assistant" ? "收到" : "发送"}
            key={item.messageId}
            speaker={item.role === "assistant" ? metaAgentTitle : "你"}
            tone={item.role}
          />)}
          {pendingProposals.map((proposal) => <AgentLoopChatMessage
            className={`awb-agent-loop-meta-proposal-message is-${proposal.status}`}
            content={`候选 Patch · ${proposal.summary}`}
            key={`proposal:${proposal.proposalId}`}
            speaker={metaAgentTitle}
            tone="assistant"
          >
            <section aria-label="Meta patch proposal" className={`awb-agent-loop-meta-proposal is-${proposal.status}`}>
              <header><div>{proposal.rationale ? <p>{proposal.rationale}</p> : null}</div><span>Draft r{proposal.baseDraftRevision}</span></header>
              <ol className="awb-agent-loop-meta-diff">
                {proposal.fieldDiffs.map((diff, index) => <li key={`${diff.path}:${index}`}>
                  <div><code data-testid="meta-diff-path">{diff.path}</code><span>{diff.operation}</span></div>
                  {diff.before !== undefined ? <pre><del>{diff.before}</del></pre> : null}
                  {diff.after !== undefined ? <pre><ins>{diff.after}</ins></pre> : null}
                </li>)}
              </ol>
              {proposal.validationIssues.length ? <div className="awb-agent-loop-meta-issues"><strong>校验</strong><ul>{proposal.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div> : null}
              {proposal.unresolvedItems.length ? <div className="awb-agent-loop-meta-unresolved"><strong>未解决</strong><ul>{proposal.unresolvedItems.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
              {draftDirty ? <p className="awb-agent-loop-meta-dirty">先保存或撤销本地手工修改，再应用 Meta patch。</p> : null}
              {proposal.baseDraftRevision !== scope.draftRevision ? <p className="awb-agent-loop-meta-dirty">Draft revision 已变化；此 patch 已 stale，不能覆盖当前 Draft。</p> : null}
              <footer>
                <button className="awb-button awb-button-secondary" disabled={isBusy || proposal.status !== "pending"} onClick={() => rejectPatch(proposal)} type="button">拒绝 patch</button>
                <button
                  className="awb-button awb-button-primary"
                  data-testid="meta-apply-proposal"
                  disabled={isBusy
                    || draftDirty
                    || proposal.validationIssues.length > 0
                    || proposal.status !== "pending"
                    || proposal.baseDraftRevision !== scope.draftRevision}
                  onClick={() => applyPatch(proposal)}
                  type="button"
                >应用 patch</button>
              </footer>
            </section>
          </AgentLoopChatMessage>)}
        </> : undefined}
      </AgentLoopChatTranscript>
      <AgentLoopChatComposer
        busy={action === "send-message"}
        className="awb-agent-loop-meta-composer"
        controls={<div className="awb-agent-loop-meta-runtime-controls">
          <label>Provider<select
            aria-label="Meta Provider"
            disabled={Boolean(session) || isBusy || providerFamilies.length === 0}
            onChange={(event) => {
              const next = preferredMetaProfile(acpProfileOptions.filter((option) => option.providerFamily === event.target.value));
              setSelectedMetaProfileOptionId(next?.metaProfileOptionId ?? "");
            }}
            value={selectedProviderFamily}
          >{providerFamilies.length ? providerFamilies.map((providerFamily) => <option key={providerFamily} value={providerFamily}>{providerFamilyLabel(providerFamily)}</option>) : <option value="">未配置</option>}</select></label>
          <label>Model<select
            aria-label="Meta Model"
            disabled={Boolean(session) || isBusy || !hasObservedMetaModels}
            onChange={(event) => {
              const next = preferredMetaProfile(providerProfileOptions.filter((option) => option.model === event.target.value));
              setSelectedMetaProfileOptionId(next?.metaProfileOptionId ?? "");
            }}
            value={selectedModel}
          >{models.length ? models.map((model) => <option
            disabled={!model.configured || !model.observed}
            key={model.modelId}
            value={model.modelId}
          >{model.label}{!model.observed
              ? " · 当前配置，ACP 未确认"
              : model.configured
                ? ""
                : " · ACP 可选，需建立 Meta Profile"}</option>) : <option value="">ACP 尚未返回模型目录</option>}</select></label>
          <label>Effort<select
            aria-label="Meta Effort"
            disabled={Boolean(session) || isBusy || effortOptions.length === 0}
            onChange={(event) => {
              const next = preferredMetaProfile(modelProfileOptions.filter((option) => metaProfileEffort(option) === event.target.value));
              setSelectedMetaProfileOptionId(next?.metaProfileOptionId ?? "");
            }}
            value={selectedEffort}
          >{effortOptions.length ? effortOptions.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>) : <option value="">未配置</option>}</select></label>
          <span className={`is-${profile ? metaProfileStatus(profile) : "unavailable"}`}>{profile ? metaProfileStatusLabel(metaProfileStatus(profile)) : "未配置"}</span>
        </div>}
        disabled={isBusy || turnInFlight || !profileOpenable}
        label="发送给 Meta Agent"
        onChange={setMessage}
        onSubmit={submitMessage}
        placeholder={profileOpenable ? "例如：@Researcher 强化来源交叉验证，并给出可审阅 Patch。" : "先配置可用的 Meta ACP Profile。"}
        rows={4}
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

function metaConversationStatus(status: "creating" | "active" | "idle" | "ambiguous" | "failed" | undefined): string {
  if (status === "active" || status === "idle") return "已连接";
  if (status === "creating") return "正在生成完整响应";
  if (status === "ambiguous") return "正在确认状态";
  if (status === "failed") return "连接失败";
  return "尚未连接";
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
    for (const entry of option.modelCatalog ?? []) {
      const configured = options.some((candidate) => candidate.model === entry.modelId);
      choices.set(entry.modelId, { modelId: entry.modelId, label: entry.label, configured, observed: true });
    }
  }
  for (const option of options) {
    if (!choices.has(option.model)) {
      choices.set(option.model, {
        modelId: option.model,
        label: option.model,
        configured: true,
        observed: false,
      });
    }
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
