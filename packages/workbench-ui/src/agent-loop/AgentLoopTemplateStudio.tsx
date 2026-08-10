import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentLoopMetaPanel, type AgentLoopMetaPanelController } from "./AgentLoopMetaPanel";
import {
  createAgentLoopTemplateDraftEditor,
  downloadAgentLoopTemplateExport,
  type AgentLoopTemplateDraftEditor,
  type AgentLoopTemplateImportPreview,
  type AgentLoopTemplateStudioController,
  type AgentLoopTemplateStudioDraft,
  type AgentLoopTemplateStudioTemplate,
  type AgentLoopTemplateStudioViewModel,
  type AgentLoopTemplateVersion,
} from "./agent-loop-template-studio-controller";

export type AgentLoopTemplateStudioProps = Readonly<{
  controller: AgentLoopTemplateStudioController;
  /** Optional for isolated embedding; production composition always supplies it. */
  metaController?: AgentLoopMetaPanelController;
}>;

/**
 * The Template Studio for the preserved AgentLoop product interaction.
 *
 * This is intentionally a focused Template Library, not a generic Workbench
 * page. It is renderer-owned UI state over Runtime-owned template facts: a
 * selected Version can be exported or copied into a revision-fenced Draft;
 * imports require a separately visible preview and user-selected outcome.
 */
export function AgentLoopTemplateStudio({ controller, metaController }: AgentLoopTemplateStudioProps) {
  const [view, setView] = useState<AgentLoopTemplateStudioViewModel>();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [selectedTemplateVersionId, setSelectedTemplateVersionId] = useState<string>();
  const [editor, setEditor] = useState<AgentLoopTemplateDraftEditor>();
  const [importPreview, setImportPreview] = useState<AgentLoopTemplateImportPreview>();
  const [actionKey, setActionKey] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [metaPlacement, setMetaPlacement] = useState<"floating" | "docked">("floating");
  const [metaVisible, setMetaVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const refreshEpoch = useRef(0);
  const selectedTemplateIdRef = useRef<string | undefined>(undefined);
  selectedTemplateIdRef.current = selectedTemplateId;

  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    const requestedTemplateId = selectedTemplateIdRef.current;
    let next = await controller.load(requestedTemplateId);
    if (epoch !== refreshEpoch.current) return;
    const current = selectedTemplateIdRef.current;
    const nextSelectedTemplateId = next.templates.some((template) => template.templateId === current)
      ? current
      : next.templates[0]?.templateId;
    if (nextSelectedTemplateId && next.selectedTemplate?.templateId !== nextSelectedTemplateId) {
      next = await controller.load(nextSelectedTemplateId);
      if (epoch !== refreshEpoch.current) return;
    }
    selectedTemplateIdRef.current = nextSelectedTemplateId;
    setSelectedTemplateId(nextSelectedTemplateId);
    setView(next);
    return next;
  }, [controller]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => Promise<void> | void) | undefined;
    void controller.subscribe(() => {
      if (active) void refresh().catch((reason: unknown) => setError(messageFor(reason)));
    }).then((stop) => {
      if (active) unsubscribe = stop;
      else void stop();
    }).catch((reason: unknown) => {
      if (active) setError(messageFor(reason));
    });
    return () => {
      active = false;
      void unsubscribe?.();
    };
  }, [controller, refresh]);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, [refresh]);

  const selected = useMemo(
    () => view?.templates.find((template) => template.templateId === selectedTemplateId) ?? view?.templates[0],
    [selectedTemplateId, view?.templates],
  );
  const selectedTemplateDetail = view?.selectedTemplate;
  const selectedDetail = selectedTemplateDetail?.templateId === selected?.templateId
    ? selectedTemplateDetail
    : undefined;
  const selectedVersions = selectedDetail?.versions ?? [];
  const effectiveSelectedVersionId = selectedVersions.some((version) => version.templateVersionId === selectedTemplateVersionId)
    ? selectedTemplateVersionId
    : selectedDetail?.activeTemplateVersionId ?? selectedVersions.at(-1)?.templateVersionId;
  const selectedVersion = selectedVersions.find((version) => version.templateVersionId === effectiveSelectedVersionId);
  const persistedEditor = editor?.templateDraftId
    ? view?.drafts.find((draft) => draft.templateDraftId === editor.templateDraftId)
    : undefined;
  const editorDirty = Boolean(editor && persistedEditor && (
    editor.title !== persistedEditor.title
    || editor.slug !== persistedEditor.slug
    || editor.description !== (persistedEditor.description ?? "")
    || editor.definitionText !== persistedEditor.definitionText
  ));
  const metaScope = editor?.templateDraftId && editor.revision !== undefined
    ? { kind: "template_design" as const, draftId: editor.templateDraftId, draftRevision: editor.revision }
    : undefined;

  const runAction = useCallback(async (key: string, action: () => Promise<void>, success?: string) => {
    setActionKey(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      await refresh();
      if (success) setNotice(success);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setActionKey(undefined);
    }
  }, [refresh]);

  const openNewDraft = useCallback(() => {
    setEditor(createAgentLoopTemplateDraftEditor());
    setError(undefined);
    setNotice(undefined);
  }, []);

  const editSelectedVersion = useCallback((template: AgentLoopTemplateStudioTemplate, version: AgentLoopTemplateVersion) => {
    setEditor(createAgentLoopTemplateDraftEditor({
      templateId: template.templateId,
      baseTemplateVersionId: version.templateVersionId,
      title: template.title,
      slug: template.slug,
      description: template.description,
      definitionText: version.definitionText,
    }));
    setError(undefined);
    setNotice(`已从不可变 Version v${version.version} 建立新的本地 Draft；保存后才会写入 Runtime。`);
  }, []);

  const saveEditor = useCallback(() => {
    if (!editor) return;
    void runAction("template.save", async () => {
      const saved = editor.templateDraftId
        ? await controller.saveDraft(editor)
        : await controller.createDraft(editor);
      setEditor(saved);
    }, "Draft 已保存；发布会创建新的不可变 Version。");
  }, [controller, editor, runAction]);

  const publishEditor = useCallback(() => {
    if (!editor) return;
    void runAction("template.publish", async () => {
      await controller.publishDraft(editor);
      setEditor(undefined);
    }, "已发布新的 Template Version；已有 Task 不会被改变。");
  }, [controller, editor, runAction]);

  const exportSelectedVersion = useCallback((version: AgentLoopTemplateVersion) => {
    void runAction(`template.export:${version.templateVersionId}`, async () => {
      downloadAgentLoopTemplateExport(await controller.exportVersion(version.templateVersionId));
    }, "已导出所选不可变 Version。");
  }, [controller, runAction]);

  const selectTemplate = useCallback((templateId: string) => {
    selectedTemplateIdRef.current = templateId;
    setSelectedTemplateId(templateId);
    setSelectedTemplateVersionId(undefined);
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, [refresh]);

  const previewFile = useCallback(async (file: File) => {
    setActionKey("template.preview_import");
    setError(undefined);
    setNotice(undefined);
    try {
      const preview = await controller.previewImport({
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (importPreview) controller.discardImportPreview(importPreview.importId);
      setImportPreview(preview);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setActionKey(undefined);
    }
  }, [controller, importPreview]);

  const onImportFile = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void previewFile(file);
  }, [previewFile]);

  const confirmImport = useCallback((preview: AgentLoopTemplateImportPreview, mode: "create" | "new_version") => {
    void runAction(`template.import:${preview.importId}:${mode}`, async () => {
      await controller.importPreview(preview.importId, mode);
      setImportPreview(undefined);
    }, mode === "create" ? "已从校验后的 package 创建 Template。" : "已导入新的不可变 Template Version。");
  }, [controller, runAction]);

  const cancelImport = useCallback(() => {
    if (importPreview) controller.discardImportPreview(importPreview.importId);
    setImportPreview(undefined);
  }, [controller, importPreview]);

  return (
    <section aria-label="AgentLoop Template Studio" className="awb-agent-loop-template-layout">
      {metaController && metaVisible && metaPlacement === "docked" && metaScope ? <AgentLoopMetaPanel
        controller={metaController}
        draftDirty={editorDirty}
        onClose={() => setMetaVisible(false)}
        onDockChange={setMetaPlacement}
        onPatchApplied={async () => {
          const next = await refresh();
          const updated = next?.drafts.find((draft) => draft.templateDraftId === metaScope.draftId);
          if (updated) setEditor(editorFromStudioDraft(updated));
        }}
        placement="docked"
        scope={metaScope}
      /> : <aside className="awb-agent-loop-template-list">
        <header className="awb-agent-loop-panel-heading">
          <div>
            <p className="awb-eyebrow">Agent Loop</p>
            <h1>模板库</h1>
            <p>Version 不可变；编辑总是从 Draft 开始。</p>
          </div>
          <button className="awb-button awb-button-primary awb-button-compact" onClick={openNewDraft} type="button">新建模板</button>
        </header>
        <div aria-label="Template 列表" className="awb-agent-loop-template-rows">
          {view?.templates.length ? view.templates.map((template) => <button
            aria-pressed={template.templateId === selected?.templateId}
            className={`awb-agent-loop-template-row ${template.templateId === selected?.templateId ? "is-active" : ""}`}
            key={template.templateId}
            onClick={() => selectTemplate(template.templateId)}
            type="button"
          >
            <strong>{template.title}</strong>
            <span>{template.currentVersion ? `v${template.currentVersion.version}` : "未发布"}{template.archivedAt ? " · 已归档" : ""}</span>
          </button>) : <Empty title="还没有 Template" detail="新建一个 v2 Draft，或导入一个已经校验的 package。" />}
        </div>
        <section aria-label="我的 Draft" className="awb-agent-loop-template-drafts">
          <div className="awb-section-heading"><h2>我的 Draft</h2><span>{view?.drafts.length ?? 0}</span></div>
          {view?.drafts.length ? view.drafts.map((draft) => <DraftRow key={draft.templateDraftId} draft={draft} onOpen={() => setEditor(editorFromStudioDraft(draft))} />) : <p className="awb-agent-loop-muted">尚无可继续编辑的 Draft。</p>}
        </section>
      </aside>}

      <section className="awb-agent-loop-template-canvas">
        <header className="awb-agent-loop-template-head">
          <div>
            <p className="awb-eyebrow">Template / Version</p>
            <h1>{selected?.title ?? "Template Studio"}</h1>
            <p>{selected?.description ?? "选择一个 Version 导出或复制为 Draft；不会在这里直接写 Provider。"}</p>
          </div>
          {selectedVersion ? <span className="awb-status">v{selectedVersion.version}</span> : null}
        </header>

        {error ? <Notice tone="error">{error}</Notice> : null}
        {notice ? <Notice tone="success">{notice}</Notice> : null}

        <section className="awb-agent-loop-template-toolbar" aria-label="模板操作">
          <input
            accept=".yaml,.yml,.zip,application/yaml,text/yaml,application/zip"
            className="awb-visually-hidden"
            onChange={onImportFile}
            ref={inputRef}
            type="file"
          />
          <button className="awb-button awb-button-secondary" disabled={Boolean(actionKey)} onClick={() => inputRef.current?.click()} type="button">
            {actionKey === "template.preview_import" ? "校验 package…" : "导入模板 package"}
          </button>
          {selectedVersions.length ? <label className="awb-agent-loop-version-select">Version<select aria-label="选择 Template Version" disabled={Boolean(actionKey)} onChange={(event) => setSelectedTemplateVersionId(event.target.value)} value={effectiveSelectedVersionId ?? ""}>
            {selectedVersions.map((version) => <option key={version.templateVersionId} value={version.templateVersionId}>v{version.version}{version.templateVersionId === selectedDetail?.activeTemplateVersionId ? "（当前）" : ""}</option>)}
          </select></label> : null}
          <button className="awb-button awb-button-secondary" disabled={!selected || !selectedVersion || Boolean(actionKey)} onClick={() => selected && selectedVersion && editSelectedVersion(selected, selectedVersion)} type="button">从此版本编辑</button>
          <button className="awb-button awb-button-secondary" disabled={!selectedVersion || Boolean(actionKey)} onClick={() => selectedVersion && exportSelectedVersion(selectedVersion)} type="button">导出此版本</button>
        </section>

        {importPreview ? <ImportPreview
          busy={Boolean(actionKey?.startsWith("template.import"))}
          onCancel={cancelImport}
          onImport={confirmImport}
          preview={importPreview}
        /> : null}

        {editor ? <EditorPanel
          busy={actionKey === "template.save" || actionKey === "template.publish"}
          editor={editor}
          onCancel={() => setEditor(undefined)}
          onChange={(patch) => setEditor((current) => current ? Object.freeze({ ...current, ...patch }) : current)}
          onOpenMeta={metaController && metaScope ? () => setMetaVisible(true) : undefined}
          onPublish={publishEditor}
          onSave={saveEditor}
        /> : <TemplateVersionFacts template={selected} version={selectedVersion} />}
        {metaController && metaVisible && metaPlacement === "floating" && metaScope ? <AgentLoopMetaPanel
          controller={metaController}
          draftDirty={editorDirty}
          onClose={() => setMetaVisible(false)}
          onDockChange={setMetaPlacement}
          onPatchApplied={async () => {
            const next = await refresh();
            const updated = next?.drafts.find((draft) => draft.templateDraftId === metaScope.draftId);
            if (updated) setEditor(editorFromStudioDraft(updated));
          }}
          placement="floating"
          scope={metaScope}
        /> : null}
      </section>
    </section>
  );
}

function TemplateVersionFacts({ template, version }: Readonly<{ template?: AgentLoopTemplateStudioTemplate; version?: AgentLoopTemplateVersion }>) {
  if (!template) return <Empty title="选择一个 Template" detail="这里保留原有 Template Studio 的 Version、Draft、导入和导出交互。" />;
  if (!version) return <Empty title="尚无已发布 Version" detail="先保存 Draft，再由你明确点击发布；已有 Task 永远不读取可变 Draft。" />;
  return <section className="awb-agent-loop-template-contract" aria-label="已选 Version 事实">
    <strong>已选 Version</strong>
    <dl>
      <div><dt>Version</dt><dd>v{version.version}</dd></div>
      <div><dt>发布时间</dt><dd>{version.publishedAt}</dd></div>
      <div><dt>定义摘要</dt><dd>{version.definitionHash}</dd></div>
      {version.assetManifestHash ? <div><dt>资产摘要</dt><dd>{version.assetManifestHash}</dd></div> : null}
    </dl>
    <p>创建 Task 时，Runtime 只会冻结这个 Version 的 Architecture Snapshot；后续 Draft 或导入不会改写它。</p>
  </section>;
}

function EditorPanel({
  busy,
  editor,
  onCancel,
  onChange,
  onOpenMeta,
  onPublish,
  onSave,
}: Readonly<{
  busy: boolean;
  editor: AgentLoopTemplateDraftEditor;
  onCancel: () => void;
  onChange: (patch: Partial<AgentLoopTemplateDraftEditor>) => void;
  onOpenMeta?: () => void;
  onPublish: () => void;
  onSave: () => void;
}>) {
  return <section aria-label="Template Draft 编辑器" className="awb-agent-loop-template-editor">
    <header><div><p className="awb-eyebrow">{editor.templateDraftId ? `Draft r${editor.revision}` : "新 Draft"}</p><h2>{editor.templateDraftId ? "继续编辑 Draft" : "创建 Template Draft"}</h2></div><span className="awb-status">schema v2</span></header>
    <div className="awb-agent-loop-template-form-grid">
      <label>模板名称<input aria-label="模板名称" disabled={busy} onChange={(event) => onChange({ title: event.target.value })} value={editor.title} /></label>
      <label>模板 slug<input aria-label="模板 slug" disabled={busy} onChange={(event) => onChange({ slug: event.target.value })} value={editor.slug} /></label>
    </div>
    <label>说明<textarea aria-label="模板说明" disabled={busy} onChange={(event) => onChange({ description: event.target.value })} rows={3} value={editor.description} /></label>
    <ExecutionProfileEditor disabled={busy} definitionText={editor.definitionText} onDefinitionChange={(definitionText) => onChange({ definitionText })} />
    <label>Template 定义（v2 JSON）<textarea aria-label="Template 定义（v2 JSON）" className="awb-agent-loop-template-definition" disabled={busy} onChange={(event) => onChange({ definitionText: event.target.value })} rows={18} spellCheck={false} value={editor.definitionText} /></label>
    <p className="awb-agent-loop-muted">保存会写入 revision-fenced Draft；发布会先保存当前内容，再创建一个新的不可变 Version。未配置完整 Provider Profile 的 Draft 可以保存，但不能发布。</p>
    <div className="awb-actions">
      <button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消</button>
      {onOpenMeta ? <button className="awb-button awb-button-secondary" disabled={busy} onClick={onOpenMeta} type="button">Meta Agent</button> : null}
      <button className="awb-button awb-button-secondary" disabled={busy} onClick={onSave} type="button">保存草稿</button>
      <button className="awb-button awb-button-primary" disabled={busy} onClick={onPublish} type="button">发布 Version</button>
    </div>
  </section>;
}

/**
 * A visible, provider-neutral edit surface for the part users adjust most.
 * It writes back into the same v2 Draft JSON as the advanced editor, so this
 * is an interaction aid rather than a second Template writer or a hidden
 * OpenCode-specific configuration path.
 */
function ExecutionProfileEditor({
  definitionText,
  disabled,
  onDefinitionChange,
}: Readonly<{
  definitionText: string;
  disabled: boolean;
  onDefinitionChange: (definitionText: string) => void;
}>) {
  const profiles = executionProfilesFrom(definitionText);
  if (!profiles) return <section aria-label="执行配置" className="awb-agent-loop-profile-editor is-invalid"><strong>执行配置</strong><p>请先把 Template 定义恢复为有效 JSON，才能在这里编辑 Provider Profile。</p></section>;
  return <section aria-label="执行配置" className="awb-agent-loop-profile-editor">
    <header><div><p className="awb-eyebrow">UNIFIED PROVIDER PROFILE</p><h3>执行配置</h3></div><span>{profiles.length} 个 Profile</span></header>
    <p>这些字段在所有 Provider 间使用同一 v2 schema；Runtime 会在发布和启动时再校验版本、指纹和能力。</p>
    <div className="awb-agent-loop-profile-grid">
      {profiles.map((profile) => <article key={profile.executionProfileId}>
        <header><strong>{profile.executionProfileId}</strong><span>{profile.provider}</span></header>
        <div className="awb-agent-loop-template-form-grid">
          <label>Provider<select aria-label={`${profile.executionProfileId} Provider`} disabled={disabled} onChange={(event) => onDefinitionChange(updateProfile(definitionText, profile.executionProfileId, { provider: event.target.value }))} value={profile.provider}>
            <option value="codex">Codex</option><option value="opencode">OpenCode</option><option value="claude-code">Claude Code</option>
          </select></label>
          <label>模型<input aria-label={`${profile.executionProfileId} 模型`} disabled={disabled} onChange={(event) => onDefinitionChange(updateProfile(definitionText, profile.executionProfileId, { model: event.target.value }))} value={profile.model} /></label>
          <label>Provider 版本<input aria-label={`${profile.executionProfileId} Provider 版本`} disabled={disabled} onChange={(event) => onDefinitionChange(updateProfile(definitionText, profile.executionProfileId, { providerVersion: event.target.value }))} value={profile.providerVersion} /></label>
          <label>权限模式<select aria-label={`${profile.executionProfileId} 权限模式`} disabled={disabled} onChange={(event) => onDefinitionChange(updateProfile(definitionText, profile.executionProfileId, { permissionMode: event.target.value }))} value={profile.permissionMode}>
            <option value="ask">ask</option><option value="preapproved">preapproved</option><option value="deny">deny</option>
          </select></label>
          <label className="awb-agent-loop-template-form-span">协议指纹<input aria-label={`${profile.executionProfileId} 协议指纹`} disabled={disabled} onChange={(event) => onDefinitionChange(updateProfile(definitionText, profile.executionProfileId, { protocolFingerprint: event.target.value }))} value={profile.protocolFingerprint} /></label>
        </div>
      </article>)}
    </div>
  </section>;
}

type ExecutionProfileEditorRow = Readonly<{
  executionProfileId: string;
  provider: "opencode" | "codex" | "claude-code";
  model: string;
  providerVersion: string;
  protocolFingerprint: string;
  permissionMode: "ask" | "preapproved" | "deny";
}>;

function executionProfilesFrom(source: string): readonly ExecutionProfileEditorRow[] | undefined {
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const candidates = (parsed as { executionProfiles?: unknown }).executionProfiles;
    if (!Array.isArray(candidates)) return undefined;
    const rows = candidates.flatMap((candidate): ExecutionProfileEditorRow[] => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const profile = candidate as Record<string, unknown>;
      const provider = profile.provider;
      const permissionMode = (profile.capabilityPolicy as Record<string, unknown> | undefined)?.permissionMode;
      if (
        typeof profile.executionProfileId !== "string"
        || (provider !== "opencode" && provider !== "codex" && provider !== "claude-code")
        || typeof profile.model !== "string"
        || typeof profile.providerVersion !== "string"
        || typeof profile.protocolFingerprint !== "string"
        || (permissionMode !== "ask" && permissionMode !== "preapproved" && permissionMode !== "deny")
      ) return [];
      return [{
        executionProfileId: profile.executionProfileId,
        provider,
        model: profile.model,
        providerVersion: profile.providerVersion,
        protocolFingerprint: profile.protocolFingerprint,
        permissionMode,
      }];
    });
    return rows.length === candidates.length ? rows : undefined;
  } catch {
    return undefined;
  }
}

function updateProfile(
  source: string,
  executionProfileId: string,
  patch: Readonly<Record<string, string>>,
): string {
  const parsed = JSON.parse(source) as { executionProfiles: Array<Record<string, unknown>> };
  return JSON.stringify({
    ...parsed,
    executionProfiles: parsed.executionProfiles.map((profile) => {
      if (profile.executionProfileId !== executionProfileId) return profile;
      const capabilityPolicy = profile.capabilityPolicy as Record<string, unknown>;
      return {
        ...profile,
        ...(patch.provider ? { provider: patch.provider } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.providerVersion !== undefined ? { providerVersion: patch.providerVersion } : {}),
        ...(patch.protocolFingerprint !== undefined ? { protocolFingerprint: patch.protocolFingerprint } : {}),
        ...(patch.permissionMode ? { capabilityPolicy: { ...capabilityPolicy, permissionMode: patch.permissionMode } } : {}),
      };
    }),
  }, null, 2);
}

function ImportPreview({
  busy,
  onCancel,
  onImport,
  preview,
}: Readonly<{
  busy: boolean;
  onCancel: () => void;
  onImport: (preview: AgentLoopTemplateImportPreview, mode: "create" | "new_version") => void;
  preview: AgentLoopTemplateImportPreview;
}>) {
  return <section aria-label="Template 导入预览" className="awb-agent-loop-template-import">
    <div><p className="awb-eyebrow">先预览，再导入</p><h2>{preview.title} · v{preview.version}</h2><p>{preview.fileName} · {preview.assetCount} 个资产 · schema v2</p></div>
    <p>Runtime 尚未写入任何 Template。请选择明确的导入结果：</p>
    <div className="awb-actions">
      {preview.availableModes.includes("create") ? <button className="awb-button awb-button-primary" disabled={busy} onClick={() => onImport(preview, "create")} type="button">创建新的 Template</button> : null}
      {preview.availableModes.includes("new_version") ? <button className="awb-button awb-button-primary" disabled={busy} onClick={() => onImport(preview, "new_version")} type="button">导入为新的 Version</button> : null}
      <button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消导入</button>
    </div>
  </section>;
}

function DraftRow({ draft, onOpen }: Readonly<{ draft: AgentLoopTemplateStudioDraft; onOpen: () => void }>) {
  return <button className="awb-agent-loop-template-draft-row" onClick={onOpen} type="button">
    <strong>{draft.title}</strong>
    <span>Draft r{draft.revision}</span>
  </button>;
}

function Empty({ title, detail }: Readonly<{ title: string; detail: string }>) {
  return <section className="awb-agent-loop-empty"><strong>{title}</strong><p>{detail}</p></section>;
}

function Notice({ children, tone }: Readonly<{ children: string; tone: "error" | "success" }>) {
  return <div className={`awb-notice is-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

function editorFromStudioDraft(draft: AgentLoopTemplateStudioDraft): AgentLoopTemplateDraftEditor {
  return Object.freeze({
    mode: "edit",
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(draft.baseTemplateVersionId ? { baseTemplateVersionId: draft.baseTemplateVersionId } : {}),
    templateDraftId: draft.templateDraftId,
    revision: draft.revision,
    title: draft.title,
    slug: draft.slug,
    description: draft.description ?? "",
    definitionText: draft.definitionText,
  });
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
