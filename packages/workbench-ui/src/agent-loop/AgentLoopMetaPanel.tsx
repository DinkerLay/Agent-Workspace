import { useCallback, useEffect, useRef, useState } from "react";

export type AgentLoopMetaScope = Readonly<{
  kind: "template_design" | "task_setup";
  draftId: string;
  draftRevision: number;
}>;

export type AgentLoopMetaProfileOption = Readonly<{
  metaProfileOptionId: string;
  label: string;
  detail?: string;
  readiness: "available" | "unavailable";
  unavailableReasons: readonly string[];
}>;

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

export type AgentLoopMetaPanelViewModel = Readonly<{
  profileOptions: readonly AgentLoopMetaProfileOption[];
  session?: Readonly<{
    metaSessionId: string;
    revision: number;
    status: "creating" | "active" | "idle" | "failed" | "abandoned";
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
  placementLocked?: boolean;
  draftDirty?: boolean;
  onClose: () => void;
  onDockChange: (placement: "floating" | "docked") => void;
  onPatchApplied?: () => Promise<void> | void;
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
  placement,
  placementLocked = false,
  scope,
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

  const createSession = useCallback(() => {
    const profile = view?.profileOptions.find((option) => option.metaProfileOptionId === selectedMetaProfileOptionId)
      ?? view?.profileOptions[0];
    if (!profile || profile.readiness !== "available") return;
    void runAction("create-session", () => controller.createSession({
      scope,
      metaProfileOptionId: profile.metaProfileOptionId,
    }));
  }, [controller, runAction, scope, selectedMetaProfileOptionId, view?.profileOptions]);

  const submitMessage = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const session = view?.session;
    const content = message.trim();
    if (!session || !content) return;
    void runAction("send-message", async () => {
      await controller.sendMessage({
        scope,
        metaSessionId: session.metaSessionId,
        expectedSessionRevision: session.revision,
        content,
      });
      setMessage("");
    });
  }, [controller, message, runAction, scope, view?.session]);

  const applyPatch = useCallback((proposal: AgentLoopMetaPatchProposal) => {
    if (draftDirty || proposal.status !== "pending" || proposal.baseDraftRevision !== scope.draftRevision) return;
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

  const profile = view?.profileOptions.find((option) => option.metaProfileOptionId === selectedMetaProfileOptionId)
    ?? view?.profileOptions[0];
  const session = view?.session;
  const pendingProposals = view?.proposals.filter((proposal) => proposal.status === "pending" || proposal.status === "stale") ?? [];
  const isBusy = Boolean(action);

  return (
    <aside aria-label="Meta Agent panel" className={`awb-agent-loop-meta-panel is-${placement}`}>
      <header className="awb-agent-loop-meta-head">
        <div><p className="awb-eyebrow">Configuration assistant</p><h2>Meta Agent</h2></div>
        <div className="awb-agent-loop-meta-view-actions">
          {!placementLocked ? <button
            aria-label={placement === "floating" ? "停靠 Meta panel" : "浮动 Meta panel"}
            className="awb-agent-loop-icon-button"
            onClick={() => onDockChange(placement === "floating" ? "docked" : "floating")}
            type="button"
          >{placement === "floating" ? "⇤" : "↗"}</button> : null}
          <button aria-label="关闭 Meta panel" className="awb-agent-loop-icon-button" onClick={onClose} type="button">×</button>
        </div>
      </header>

      {error ? <p className="awb-agent-loop-form-error" role="alert">{error}</p> : null}
      {profile ? <section aria-label="Meta profile" className={`awb-agent-loop-meta-profile is-${profile.readiness}`}>
        <div><strong>Meta profile</strong><span>{profile.readiness === "available" ? "可用" : "不可用"}</span></div>
        <label>Host readiness option<select
          aria-label="Meta profile option"
          disabled={Boolean(session) || isBusy}
          onChange={(event) => setSelectedMetaProfileOptionId(event.target.value)}
          value={profile.metaProfileOptionId}
        >{view?.profileOptions.map((option) => <option key={option.metaProfileOptionId} value={option.metaProfileOptionId}>{option.label}</option>)}</select></label>
        {profile.detail ? <small>{profile.detail}</small> : null}
        {profile.unavailableReasons.length ? <ul>{profile.unavailableReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
      </section> : <p className="awb-agent-loop-muted">{view ? "没有可用的 Meta profile option。" : "正在读取 Meta profile…"}</p>}

      {!session ? <section className="awb-agent-loop-meta-empty">
        <p>只有你明确打开后，Runtime 才会创建或恢复这个 Draft 专属的 Meta Session。</p>
        <button className="awb-button awb-button-secondary" disabled={isBusy || profile?.readiness !== "available"} onClick={createSession} type="button">
          {action === "create-session" ? "正在打开…" : "打开 Meta Session"}
        </button>
      </section> : <>
        <section aria-label="Meta conversation" className="awb-agent-loop-meta-chat">
          <header><strong>Draft 对话</strong><span>{session.status}</span></header>
          <ol>{session.messages.map((item) => <li className={`is-${item.role}`} key={item.messageId}><span>{item.role === "assistant" ? "Meta" : "你"}</span><p>{item.content}</p></li>)}</ol>
        </section>
        <form className="awb-agent-loop-meta-composer" onSubmit={submitMessage}>
          <label>发送给 Meta Agent<textarea disabled={isBusy} onChange={(event) => setMessage(event.target.value)} rows={3} value={message} /></label>
          <button className="awb-button awb-button-primary" disabled={isBusy || !message.trim()} type="submit">{action === "send-message" ? "发送中…" : "发送"}</button>
        </form>
      </>}

      <section aria-label="Meta proposals" className="awb-agent-loop-meta-proposals">
        <header><strong>Patch proposals</strong><span>{pendingProposals.length}</span></header>
        {pendingProposals.length ? pendingProposals.map((proposal) => (
          <section aria-label="Meta patch proposal" className={`awb-agent-loop-meta-proposal is-${proposal.status}`} key={proposal.proposalId}>
            <header><div><strong>{proposal.summary}</strong>{proposal.rationale ? <p>{proposal.rationale}</p> : null}</div><span>Draft r{proposal.baseDraftRevision}</span></header>
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
              <button className="awb-button awb-button-primary" disabled={isBusy || draftDirty || proposal.status !== "pending" || proposal.baseDraftRevision !== scope.draftRevision} onClick={() => applyPatch(proposal)} type="button">应用 patch</button>
            </footer>
          </section>
        )) : <p className="awb-agent-loop-muted">Meta 还没有提出 patch。对话正文不会自动修改 Draft。</p>}
      </section>
    </aside>
  );
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
