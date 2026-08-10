import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AgentLoopRuntimeController } from "./agent-loop-runtime-controller";
import type { AgentLoopRuntimeViewModel } from "./agent-loop-model";
import type { AgentLoopConfigurationController } from "./agent-loop-configuration-controller";
import type {
  AgentLoopTemplateStudioController,
  AgentLoopTemplateStudioSelectedTemplate,
} from "./agent-loop-template-studio-controller";

export type AgentLoopTaskCreateDialogProps = Readonly<{
  controller: AgentLoopRuntimeController;
  configurationController: AgentLoopConfigurationController;
  templateStudioController: AgentLoopTemplateStudioController;
  view: AgentLoopRuntimeViewModel;
  onClose: () => void;
  onSetupCreated: (taskSetupDraftId: string) => Promise<void> | void;
  onRequestRefresh: () => Promise<void> | void;
}>;

/**
 * The preserved AgentLoop "new Task" drawer, now backed by explicit Runtime
 * contracts. A directory can cross the Renderer boundary only to become a
 * Host-authorized Workspace. This step creates a durable Setup Draft from an
 * exact immutable Version; the later Task command consumes that Draft and
 * carries only opaque identities — never a raw path.
 */
export function AgentLoopTaskCreateDialog({
  configurationController,
  controller,
  templateStudioController,
  view,
  onClose,
  onSetupCreated,
  onRequestRefresh,
}: AgentLoopTaskCreateDialogProps) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [directory, setDirectory] = useState("");
  const [workspaceDisplayName, setWorkspaceDisplayName] = useState("");
  const [authorizedHere, setAuthorizedHere] = useState<AgentLoopRuntimeViewModel["workspaces"]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [templateId, setTemplateId] = useState<string>();
  const [templateDetail, setTemplateDetail] = useState<AgentLoopTemplateStudioSelectedTemplate>();
  const [templateVersionId, setTemplateVersionId] = useState<string>();
  const [busy, setBusy] = useState<"authorize" | "create-setup">();
  const [error, setError] = useState<string>();
  const sequence = useRef(0);

  const templates = useMemo(
    () => view.templates.filter((template) => Boolean(template.activeVersion)),
    [view.templates],
  );
  const workspaces = useMemo(() => {
    const known = new Map(view.workspaces.map((workspace) => [workspace.workspaceId, workspace] as const));
    for (const workspace of authorizedHere) {
      if (!known.has(workspace.workspaceId)) known.set(workspace.workspaceId, workspace);
    }
    return [...known.values()];
  }, [authorizedHere, view.workspaces]);

  useEffect(() => {
    setTemplateId((current) => templates.some((template) => template.templateId === current) ? current : templates[0]?.templateId);
  }, [templates]);

  useEffect(() => {
    if (!templateId) {
      setTemplateDetail(undefined);
      setTemplateVersionId(undefined);
      return;
    }
    const current = ++sequence.current;
    setTemplateDetail(undefined);
    setTemplateVersionId(undefined);
    void templateStudioController.load(templateId).then((next) => {
      if (current !== sequence.current || next.selectedTemplate?.templateId !== templateId) return;
      setTemplateDetail(next.selectedTemplate);
      setTemplateVersionId(next.selectedTemplate.activeTemplateVersionId ?? next.selectedTemplate.versions.at(-1)?.templateVersionId);
    }).catch((reason: unknown) => {
      if (current === sequence.current) setError(messageFor(reason));
    });
  }, [templateId, templateStudioController]);

  const authorize = useCallback(async () => {
    setError(undefined);
    setBusy("authorize");
    try {
      const workspace = await controller.authorizeWorkspace(directory, workspaceDisplayName);
      setAuthorizedHere((current) => current.some((item) => item.workspaceId === workspace.workspaceId)
        ? current
        : [...current, workspace]);
      setWorkspaceId(workspace.workspaceId);
      await onRequestRefresh();
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(undefined);
    }
  }, [controller, directory, onRequestRefresh, workspaceDisplayName]);

  const createSetup = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceId || !templateVersionId) {
      setError(!workspaceId ? "请先选择或授权一个项目目录。" : "请选择一个不可变 Template Version。");
      return;
    }
    setError(undefined);
    setBusy("create-setup");
    try {
      const taskSetupDraftId = await configurationController.createTaskSetupDraft({ workspaceId, templateVersionId, title, goal });
      await onSetupCreated(taskSetupDraftId);
      onClose();
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(undefined);
    }
  }, [configurationController, goal, onClose, onSetupCreated, templateVersionId, title, workspaceId]);

  const hasWorkspace = workspaces.length > 0;
  const selectedTemplate = templates.find((template) => template.templateId === templateId);

  return <div aria-label="新建 Task" aria-modal="true" className="awb-agent-loop-modal-backdrop" role="dialog">
    <button aria-label="关闭新建 Task" className="awb-agent-loop-modal-scrim" disabled={Boolean(busy)} onClick={onClose} type="button" />
    <section className="awb-agent-loop-modal awb-agent-loop-task-create-modal">
      <header>
        <div><p>CREATE TASK</p><h2>新建 Task</h2></div>
        <button aria-label="关闭" className="awb-agent-loop-icon-button" disabled={Boolean(busy)} onClick={onClose} type="button">×</button>
      </header>
      <form onSubmit={(event) => void createSetup(event)}>
        <div className="awb-agent-loop-modal-copy">
          <p>先选择不可变 <strong>Template Version</strong> 与 Workspace，Runtime 会创建持久化 Task Setup Draft。填写 Version schema 后再独立创建 Task；Start 仍是后续动作。</p>
        </div>
        {error ? <p className="awb-agent-loop-form-error" role="alert">{error}</p> : null}

        <div className="awb-agent-loop-form-grid">
          <label>Task 名称<input aria-label="Task 名称" disabled={Boolean(busy)} onChange={(event) => setTitle(event.target.value)} placeholder="例如：分析储能产业链" value={title} /></label>
          <label>Template<select aria-label="选择 Template" disabled={Boolean(busy) || templates.length === 0} onChange={(event) => setTemplateId(event.target.value || undefined)} value={templateId ?? ""}>
            {templates.length === 0 ? <option value="">没有已发布 Template</option> : templates.map((template) => <option key={template.templateId} value={template.templateId}>{template.title}</option>)}
          </select></label>
          <label>Template Version<select aria-label="选择 Template Version" disabled={Boolean(busy) || !templateDetail} onChange={(event) => setTemplateVersionId(event.target.value || undefined)} value={templateVersionId ?? ""}>
            {!templateDetail ? <option value="">正在读取 Version…</option> : templateDetail.versions.map((version) => <option key={version.templateVersionId} value={version.templateVersionId}>v{version.version}{version.templateVersionId === templateDetail.activeTemplateVersionId ? "（当前）" : ""}</option>)}
          </select></label>
          <label>已授权项目<select aria-label="选择已授权项目" disabled={Boolean(busy) || !hasWorkspace} onChange={(event) => setWorkspaceId(event.target.value || undefined)} value={workspaceId ?? ""}>
            <option value="">{hasWorkspace ? "请选择项目" : "先授权一个项目目录"}</option>
            {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}
          </select></label>
          <label className="awb-agent-loop-form-span">目标<textarea aria-label="Task 目标" disabled={Boolean(busy)} onChange={(event) => setGoal(event.target.value)} placeholder="说明需要交付什么、范围和验收关注点。" rows={4} value={goal} /></label>
        </div>

        <section aria-label="授权项目目录" className="awb-agent-loop-workspace-authorize">
          <div><strong>授权新的项目目录</strong><p>Host 会校验并保存它的规范化目录；之后页面只显示项目名称和 Workspace ID。</p></div>
          <div className="awb-agent-loop-form-grid">
            <label className="awb-agent-loop-form-span">项目目录<input aria-label="项目目录" disabled={Boolean(busy)} onChange={(event) => setDirectory(event.target.value)} placeholder="/path/to/project" value={directory} /></label>
            <label>显示名称（可选）<input aria-label="项目显示名称" disabled={Boolean(busy)} onChange={(event) => setWorkspaceDisplayName(event.target.value)} placeholder="研究项目" value={workspaceDisplayName} /></label>
            <div className="awb-agent-loop-authorize-action"><button className="awb-button awb-button-secondary" disabled={Boolean(busy) || !directory.trim()} onClick={() => void authorize()} type="button">{busy === "authorize" ? "授权中…" : "授权此目录"}</button></div>
          </div>
        </section>

        <footer><button className="awb-button awb-button-secondary" disabled={Boolean(busy)} onClick={onClose} type="button">取消</button><button className="awb-button awb-button-primary" disabled={Boolean(busy) || !selectedTemplate || !workspaceId || !templateVersionId || !title.trim() || !goal.trim()} type="submit">{busy === "create-setup" ? "正在创建 Setup…" : "继续 Task Setup"}</button></footer>
      </form>
    </section>
  </div>;
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
