import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcpProfileReadinessObservation } from "@agent-workspace/runtime-contracts";
import { AgentLoopAcpProfileSummary } from "./AgentLoopAcpProfileSummary";
import { AgentLoopMetaPanel, type AgentLoopMetaPanelController } from "./AgentLoopMetaPanel";

export type AgentLoopTaskSetupSchemaField = Readonly<{
  fieldId: string;
  label: string;
  kind: "short_text" | "long_text" | "choice";
  required: boolean;
  value: string;
  options?: readonly Readonly<{ optionId: string; label: string }>[];
  help?: string;
}>;

export type AgentLoopTaskSetupProfileOptionV2 = Readonly<{
  /** Missing schemaVersion is historical schema-v2 input, never ACP authority. */
  schemaVersion?: 2;
  executionProfileId: string;
  provider: string;
  providerLabel: string;
  model: string;
  providerVersion?: string;
  permissionMode: string;
  requiredCapabilities: readonly string[];
  readiness: "checking" | "available" | "unavailable" | "version_mismatch" | "capability_missing";
  unavailableReasons: readonly string[];
}>;

export type AgentLoopTaskSetupProfileOptionV3 = Readonly<{
  schemaVersion: 3;
  executionProfileId: string;
  permissionMode: "ask" | "preapproved" | "deny";
  allowedTools: readonly string[];
  requiredCapabilities: readonly string[];
  requiredExtensions: readonly string[];
  readiness: AcpProfileReadinessObservation;
}>;

export type AgentLoopTaskSetupProfileOption = AgentLoopTaskSetupProfileOptionV2 | AgentLoopTaskSetupProfileOptionV3;

export type AgentLoopTaskSetupViewModel = Readonly<{
  draft: Readonly<{
    taskSetupDraftId: string;
    revision: number;
    state: "draft" | "consumed" | "abandoned";
    templateVersion: Readonly<{
      templateId: string;
      templateVersionId: string;
      templateTitle: string;
      version: number;
    }>;
    workspaceId?: string;
    title: string;
    goal: string;
    schemaFields: readonly AgentLoopTaskSetupSchemaField[];
    validationIssues: readonly string[];
    valid: boolean;
  }>;
  workspaces: readonly Readonly<{ workspaceId: string; displayName: string }>[];
  profileOptions: readonly AgentLoopTaskSetupProfileOption[];
}>;

export type AgentLoopTaskSetupDraftInput = Readonly<{
  taskSetupDraftId: string;
  expectedRevision: number;
  workspaceId: string;
  title: string;
  goal: string;
  schemaValues: Readonly<Record<string, string>>;
}>;

export type AgentLoopTaskSetupController = Readonly<{
  load(): Promise<AgentLoopTaskSetupViewModel>;
  subscribe?(onChanged: () => void): Promise<() => Promise<void> | void>;
  saveDraft(input: AgentLoopTaskSetupDraftInput): Promise<AgentLoopTaskSetupViewModel>;
  createTask(input: Readonly<{ taskSetupDraftId: string; expectedRevision: number }>): Promise<string>;
  abandonDraft(input: Readonly<{ taskSetupDraftId: string; expectedRevision: number }>): Promise<void>;
}>;

export type AgentLoopTaskSetupSurfaceProps = Readonly<{
  controller: AgentLoopTaskSetupController;
  metaController?: AgentLoopMetaPanelController;
  onBack: () => void;
  onCreated: (taskId: string) => Promise<void> | void;
}>;

type SetupEditor = Readonly<{
  workspaceId: string;
  title: string;
  goal: string;
  schemaValues: Readonly<Record<string, string>>;
}>;

/** A durable configuration surface. Saving Setup, creating Task, and starting Run stay separate user actions. */
export function AgentLoopTaskSetupSurface({ controller, metaController, onBack, onCreated }: AgentLoopTaskSetupSurfaceProps) {
  const [view, setView] = useState<AgentLoopTaskSetupViewModel>();
  const [editor, setEditor] = useState<SetupEditor>();
  const [metaVisible, setMetaVisible] = useState(false);
  const [metaPlacement, setMetaPlacement] = useState<"floating" | "docked">("floating");
  const [busy, setBusy] = useState<"save" | "create" | "abandon">();
  const [error, setError] = useState<string>();
  const viewRef = useRef<AgentLoopTaskSetupViewModel | undefined>(undefined);
  const editorRef = useRef<SetupEditor | undefined>(undefined);
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
    };
  }, []);

  const commitView = useCallback((next: AgentLoopTaskSetupViewModel, preserveDirty: boolean) => {
    const previousView = viewRef.current;
    const previousEditor = editorRef.current;
    const previousBaseline = previousView ? editorFrom(previousView) : undefined;
    const sameDraft = previousView?.draft.taskSetupDraftId === next.draft.taskSetupDraftId;
    const hasLocalChanges = Boolean(
      preserveDirty
      && sameDraft
      && previousEditor
      && previousBaseline
      && editorSignature(previousEditor) !== editorSignature(previousBaseline),
    );
    const durableDraftChanged = Boolean(
      previousView
      && sameDraft
      && (
        previousView.draft.revision !== next.draft.revision
        || previousView.draft.state !== next.draft.state
        || editorSignature(editorFrom(previousView)) !== editorSignature(editorFrom(next))
      ),
    );
    const nextEditor = hasLocalChanges && previousEditor ? previousEditor : editorFrom(next);
    const nextView = hasLocalChanges && durableDraftChanged && previousView
      ? Object.freeze({ ...next, draft: previousView.draft })
      : next;
    if (hasLocalChanges && durableDraftChanged) {
      setError("task_setup_draft_changed_remotely");
    }
    viewRef.current = nextView;
    editorRef.current = nextEditor;
    setView(nextView);
    setEditor(nextEditor);
  }, []);

  const load = useCallback(async (preserveDirty = true) => {
    const generation = ++loadGenerationRef.current;
    const next = await controller.load();
    if (!mountedRef.current || generation !== loadGenerationRef.current) return next;
    commitView(next, preserveDirty);
    return next;
  }, [commitView, controller]);

  useEffect(() => {
    void load().catch((reason: unknown) => setError(messageFor(reason)));
  }, [load]);

  useEffect(() => {
    if (!controller.subscribe) return undefined;
    let disposed = false;
    let unsubscribe: (() => Promise<void> | void) | undefined;
    void controller.subscribe(() => {
      void load().catch((reason: unknown) => {
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
  }, [controller, load]);

  const baseline = useMemo(() => view ? editorFrom(view) : undefined, [view]);
  const dirty = Boolean(editor && baseline && editorSignature(editor) !== editorSignature(baseline));
  const locallyValid = Boolean(editor?.workspaceId.trim() && editor.title.trim() && editor.goal.trim()
    && view?.draft.schemaFields.every((field) => !field.required || fieldValuePresent(editor.schemaValues[field.fieldId])));
  const canCreate = Boolean(view?.draft.state === "draft" && view.draft.valid && locallyValid && !dirty && !busy);

  const updateEditor = useCallback((patch: Partial<SetupEditor>) => {
    setEditor((current) => {
      const next = current ? Object.freeze({ ...current, ...patch }) : current;
      editorRef.current = next;
      return next;
    });
  }, []);

  const updateSchemaValue = useCallback((fieldId: string, value: string) => {
    setEditor((current) => {
      const next = current ? Object.freeze({
        ...current,
        schemaValues: Object.freeze({ ...current.schemaValues, [fieldId]: value }),
      }) : current;
      editorRef.current = next;
      return next;
    });
  }, []);

  const save = useCallback(async () => {
    const currentView = view;
    const currentEditor = editor;
    if (!currentView || !currentEditor || !locallyValid) return;
    setBusy("save");
    setError(undefined);
    try {
      const next = await controller.saveDraft({
        taskSetupDraftId: currentView.draft.taskSetupDraftId,
        expectedRevision: currentView.draft.revision,
        workspaceId: currentEditor.workspaceId,
        title: currentEditor.title.trim(),
        goal: currentEditor.goal.trim(),
        schemaValues: currentEditor.schemaValues,
      });
      loadGenerationRef.current += 1;
      commitView(next, false);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(undefined);
    }
  }, [commitView, controller, editor, locallyValid, view]);

  const createTask = useCallback(async () => {
    const current = view?.draft;
    if (!current || !canCreate) return;
    setBusy("create");
    setError(undefined);
    try {
      const taskId = await controller.createTask({ taskSetupDraftId: current.taskSetupDraftId, expectedRevision: current.revision });
      await onCreated(taskId);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(undefined);
    }
  }, [canCreate, controller, onCreated, view?.draft]);

  const abandon = useCallback(async () => {
    const current = view?.draft;
    if (!current || current.state !== "draft") return;
    setBusy("abandon");
    setError(undefined);
    try {
      await controller.abandonDraft({ taskSetupDraftId: current.taskSetupDraftId, expectedRevision: current.revision });
      await load(false);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(undefined);
    }
  }, [controller, load, view?.draft]);

  if (!view || !editor) return <section aria-label="Task Setup" className="awb-agent-loop-task-setup-loading">正在读取 Task Setup Draft…</section>;
  const { draft } = view;
  const metaAvailable = Boolean(metaController && draft.state === "draft");
  const metaDocked = metaAvailable && metaVisible && metaPlacement === "docked";
  const metaScope = { kind: "task_setup" as const, draftId: draft.taskSetupDraftId, draftRevision: draft.revision };

  return (
    <section aria-label="Task Setup" className="awb-agent-loop-task-setup-surface">
      <header className="awb-agent-loop-task-setup-head">
        <div><p className="awb-eyebrow">Configuration Draft</p><h1>Task Setup</h1><p>这里保存配置草稿；Create 和 Start 都是之后独立的用户动作。</p></div>
        <div className="awb-actions">
          {metaAvailable && !metaVisible ? <button className="awb-button awb-button-secondary" data-testid="task-setup-meta-opener" disabled={Boolean(busy)} onClick={() => setMetaVisible(true)} type="button">AI 协助填写</button> : null}
          <button className="awb-button awb-button-secondary" disabled={Boolean(busy)} onClick={onBack} type="button">返回任务</button>
          <button className="awb-button awb-button-danger" disabled={Boolean(busy) || draft.state !== "draft"} onClick={() => void abandon()} type="button">放弃 Setup Draft</button>
        </div>
      </header>
      {error ? <p className="awb-agent-loop-form-error" role="alert">{error}</p> : null}

      <div className={`awb-agent-loop-task-setup-grid ${metaDocked ? "has-meta-dock" : ""}`}>
        <section className="awb-agent-loop-task-setup-editor">
          <section aria-label="Immutable Template Version" className="awb-agent-loop-task-setup-version">
            <div><p className="awb-eyebrow">Exact immutable Version</p><h2>{draft.templateVersion.templateTitle} · v{draft.templateVersion.version}</h2></div>
            <code>{draft.templateVersion.templateVersionId}</code>
          </section>

          <section aria-label="Execution Profile options" className="awb-agent-loop-task-setup-profiles">
            <header><div><h2>Execution Profile options</h2><p>只显示 Host 投影的安全 ACP observation；不可用项保持可见，不会 fallback。</p></div><span>{view.profileOptions.length}</span></header>
            <div>{view.profileOptions.map((profile) => isAcpTaskSetupProfile(profile)
              ? <AgentLoopAcpProfileSummary
                  allowedTools={profile.allowedTools}
                  className="awb-agent-loop-task-setup-profile"
                  key={profile.executionProfileId}
                  permissionMode={profile.permissionMode}
                  readiness={profile.readiness}
                  requiredCapabilities={profile.requiredCapabilities}
                  requiredExtensions={profile.requiredExtensions}
                  title={`Execution Profile ${profile.executionProfileId}`}
                />
              : <article className="is-unavailable awb-agent-loop-task-setup-profile is-legacy" key={profile.executionProfileId}>
                  <header><strong>{profile.providerLabel} · {profile.model}</strong><span>v2 历史只读</span></header>
                  <p>该 direct-provider Profile 不能为新 Run 授权。需要在 Template Draft 中显式迁移到 Host-issued ACP Profile revision。</p>
                </article>)}</div>
          </section>

          <section aria-label="Task Setup fields" className="awb-agent-loop-task-setup-form">
            <label>Task 名称<input aria-label="Task 名称" disabled={Boolean(busy)} onChange={(event) => updateEditor({ title: event.target.value })} value={editor.title} /></label>
            <label>Workspace<select aria-label="Workspace" disabled={Boolean(busy)} onChange={(event) => updateEditor({ workspaceId: event.target.value })} value={editor.workspaceId}>
              <option value="">选择已授权 Workspace</option>
              {view.workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}
            </select></label>
            <label className="is-span">Task 目标<textarea aria-label="Task 目标" disabled={Boolean(busy)} onChange={(event) => updateEditor({ goal: event.target.value })} rows={5} value={editor.goal} /></label>
            {draft.schemaFields.map((field) => <SchemaField disabled={Boolean(busy)} field={field} key={field.fieldId} onChange={(value) => updateSchemaValue(field.fieldId, value)} value={editor.schemaValues[field.fieldId] ?? ""} />)}
          </section>

          {draft.validationIssues.length ? <section aria-label="Task Setup validation" className="awb-agent-loop-task-setup-validation"><strong>需要修正</strong><ul>{draft.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul></section> : null}
          <footer className="awb-agent-loop-task-setup-actions">
            <span>{dirty ? "有尚未保存的修改" : `已保存 Draft r${draft.revision}`}</span>
            <div>
              <button className="awb-button awb-button-secondary" disabled={Boolean(busy) || !dirty || !locallyValid} onClick={() => void save()} type="button">{busy === "save" ? "保存中…" : "保存 Setup Draft"}</button>
              <button className="awb-button awb-button-primary" data-testid="task-create" disabled={!canCreate} onClick={() => void createTask()} type="button">{busy === "create" ? "创建中…" : "创建 Task"}</button>
            </div>
          </footer>
        </section>

        {metaController && metaDocked ? <section className="awb-agent-loop-task-setup-meta-column">
          <AgentLoopMetaPanel
            controller={metaController}
            draftDirty={dirty}
            onClose={() => setMetaVisible(false)}
            onDockChange={setMetaPlacement}
            onPatchApplied={async () => { await load(); }}
            placement="docked"
            scope={metaScope}
          />
        </section> : null}
      </div>
      {metaController && metaAvailable && metaVisible && metaPlacement === "floating" ? <AgentLoopMetaPanel
        controller={metaController}
        draftDirty={dirty}
        onClose={() => setMetaVisible(false)}
        onDockChange={setMetaPlacement}
        onPatchApplied={async () => { await load(); }}
        placement="floating"
        scope={metaScope}
      /> : null}
    </section>
  );
}

function SchemaField({ disabled, field, onChange, value }: Readonly<{
  disabled: boolean;
  field: AgentLoopTaskSetupSchemaField;
  onChange: (value: string) => void;
  value: string;
}>) {
  const suffix = field.required ? "（必填）" : "";
  if (field.kind === "choice") return <label>{field.label}{suffix}<select aria-label={field.label} disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value}><option value="">请选择</option>{field.options?.map((option) => <option key={option.optionId} value={option.optionId}>{option.label}</option>)}</select>{field.help ? <small>{field.help}</small> : null}</label>;
  if (field.kind === "long_text") return <label className="is-span">{field.label}{suffix}<textarea aria-label={field.label} disabled={disabled} onChange={(event) => onChange(event.target.value)} rows={4} value={value} />{field.help ? <small>{field.help}</small> : null}</label>;
  return <label>{field.label}{suffix}<input aria-label={field.label} disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value} />{field.help ? <small>{field.help}</small> : null}</label>;
}

function editorFrom(view: AgentLoopTaskSetupViewModel): SetupEditor {
  return Object.freeze({
    workspaceId: view.draft.workspaceId ?? "",
    title: view.draft.title,
    goal: view.draft.goal,
    schemaValues: Object.freeze(Object.fromEntries(view.draft.schemaFields.map((field) => [field.fieldId, field.value]))),
  });
}

function editorSignature(editor: SetupEditor): string {
  return JSON.stringify([editor.workspaceId, editor.title, editor.goal, Object.entries(editor.schemaValues).sort(([left], [right]) => left.localeCompare(right))]);
}

function fieldValuePresent(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isAcpTaskSetupProfile(
  profile: AgentLoopTaskSetupProfileOption,
): profile is AgentLoopTaskSetupProfileOptionV3 {
  return profile.schemaVersion === 3;
}
