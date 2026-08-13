import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";
import type { AgentLoopSessionIdTaskSetupOptions } from "./agent-loop-session-id-root-controller";

export type AgentLoopSessionIdTaskSetupLauncherProps = Readonly<{
  configurationController: AgentLoopConfigurationController;
  options: AgentLoopSessionIdTaskSetupOptions;
  onClose: () => void;
  onSetupCreated: (taskSetupDraftId: string) => Promise<void> | void;
}>;

/**
 * Selects one immutable Version and one already-authorized Workspace, then
 * creates only a persisted Setup Draft. Task Create and Start stay on their
 * later explicit surfaces.
 */
export function AgentLoopSessionIdTaskSetupLauncher({
  configurationController,
  onClose,
  onSetupCreated,
  options,
}: AgentLoopSessionIdTaskSetupLauncherProps) {
  const [templateId, setTemplateId] = useState(options.templates[0]?.templateId ?? "");
  const [versionChoice, setVersionChoice] = useState("latest");
  const [workspaceChoice, setWorkspaceChoice] = useState("");
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selectedTemplate = options.templates.find((template) => template.templateId === templateId)
    ?? options.templates[0];
  const orderedVersions = useMemo(
    () => [...(selectedTemplate?.versions ?? [])].sort((left, right) => right.version - left.version),
    [selectedTemplate?.versions],
  );

  const createSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const workspace = resolveWorkspace(options, workspaceChoice);
    const templateVersionId = versionChoice === "latest"
      ? orderedVersions[0]?.templateVersionId
      : orderedVersions.find((version) => version.templateVersionId === versionChoice)?.templateVersionId;
    if (!workspace) {
      setError("请选择 Host 已授权的 Workspace；Renderer 不接受任意文件路径。");
      return;
    }
    if (!templateVersionId) {
      setError("请选择一个不可变 Template Version。");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const taskSetupDraftId = await configurationController.createTaskSetupDraft({
        templateVersionId,
        workspaceId: workspace.workspaceId,
        title: requiredText(title, "task title"),
        goal: requiredText(goal, "task goal"),
      });
      await onSetupCreated(taskSetupDraftId);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(false);
    }
  };

  return <div aria-label="新建 Task Setup" aria-modal="true" className="awb-agent-loop-modal-backdrop" role="dialog">
    <button aria-label="关闭新建 Task Setup" className="awb-agent-loop-modal-scrim" disabled={busy} onClick={onClose} type="button" />
    <section className="awb-agent-loop-modal awb-agent-loop-task-create-modal">
      <header><div><p>CONFIGURATION DRAFT</p><h2>新建 Task Setup</h2></div><button aria-label="关闭" className="awb-agent-loop-icon-button" disabled={busy} onClick={onClose} type="button">×</button></header>
      <form onSubmit={(event) => void createSetup(event)}>
        <p>这里只创建持久化 Setup Draft；之后的 Create Task 和 Start Run 都需要各自点击。</p>
        {error ? <p className="awb-agent-loop-form-error" role="alert">{error}</p> : null}
        <div className="awb-agent-loop-form-grid">
          <label>Template<select disabled={busy || options.templates.length === 0} onChange={(event) => {
            setTemplateId(event.target.value);
            setVersionChoice("latest");
          }} value={selectedTemplate?.templateId ?? ""}>
            {options.templates.length ? options.templates.map((template) => <option key={template.templateId} value={template.templateId}>{template.title}</option>) : <option value="">没有已发布 Template</option>}
          </select></label>
          <label>Template Version<select data-testid="task-setup-version" disabled={busy || orderedVersions.length === 0} onChange={(event) => setVersionChoice(event.target.value)} value={versionChoice}>
            {orderedVersions.length ? <option value="latest">latest · v{orderedVersions[0]?.version}</option> : <option value="latest">没有可用 Version</option>}
            {orderedVersions.slice(1).map((version) => <option key={version.templateVersionId} value={version.templateVersionId}>v{version.version}</option>)}
          </select></label>
          <label>Workspace<input data-testid="task-setup-workspace" disabled={busy} list="agent-loop-session-id-workspaces" onChange={(event) => setWorkspaceChoice(event.target.value)} placeholder="Workspace ID 或显示名称" value={workspaceChoice} /></label>
          <datalist id="agent-loop-session-id-workspaces">{options.workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}</datalist>
          <label>Task 名称<input data-testid="task-setup-title" disabled={busy} onChange={(event) => setTitle(event.target.value)} value={title} /></label>
          <label className="awb-agent-loop-form-span">Task 目标<textarea data-testid="task-setup-goal" disabled={busy} onChange={(event) => setGoal(event.target.value)} rows={5} value={goal} /></label>
        </div>
        <footer><button className="awb-button awb-button-secondary" disabled={busy} onClick={onClose} type="button">取消</button><button className="awb-button awb-button-primary" data-testid="task-setup-save" disabled={busy || !title.trim() || !goal.trim() || !workspaceChoice.trim() || orderedVersions.length === 0} type="submit">{busy ? "正在保存…" : "保存 Setup Draft"}</button></footer>
      </form>
    </section>
  </div>;
}

function resolveWorkspace(options: AgentLoopSessionIdTaskSetupOptions, value: string) {
  const normalized = value.trim();
  return options.workspaces.find((workspace) => workspace.workspaceId === normalized || workspace.displayName === normalized);
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
